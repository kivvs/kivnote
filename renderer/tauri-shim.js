/*
 * KivNote Tauri 适配层
 * ------------------------------------------------------------
 * 把 renderer/index.html 里使用的 window.native（原 Electron preload 接口）
 * 映射到 Tauri v2 的全局对象 window.__TAURI__（config 里开了 withGlobalTauri）。
 *
 * 设计要点：
 *  - 仅在 Tauri 环境启用；Electron 下 preload 已提供 native，本 shim 直接 return，不覆盖。
 *  - 不依赖打包器 / npm：直接用 window.__TAURI__ 全局 API。
 *  - 契约与 Electron main.js 的 IPC 返回完全一致：
 *      open/openPath -> readAny doc {path,name,ext,size,kind,kindLabel,url,text?,enc?,hex?...}
 *      readAll       -> {data: base64, size} 或 {error}
 *      chunk         -> {data: Uint8Array, offset, size, eof} 或 {error}
 *  - 文件拖拽走 tauri 原生拖拽事件桥（WebView2 的 HTML5 drop 拿不到真实路径）。
 *  - 尚未实现的 Electron 接口保持 stub，返回安全默认值，保证 UI 不崩。
 */
(function () {
  if (!('__TAURI_INTERNALS__' in window) && !window.__TAURI__) return;

  function api() {
    const T = window.__TAURI__;
    if (!T) throw new Error('Tauri API 尚未就绪');
    return T;
  }

  // ------------------------------------------------------------------
  // invoke 适配（关键）
  // Tauri v2 的 window.__TAURI__ 顶层键为：
  //   app / core / dpi / event / image / menu / mocks / path / tray /
  //   webview / webviewWindow / window
  // 【没有 tauri 这个键】。invoke 在 core 下：
  //   v2: window.__TAURI__.core.invoke(cmd, args)
  //   v1: window.__TAURI__.tauri.invoke(cmd, args)
  // 这里做多级兜底，避免版本差异把整条调用链打断。
  // ------------------------------------------------------------------
  function invoke(cmd, args) {
    var T = api();
    var core = T.core;
    if (core && typeof core.invoke === 'function') return core.invoke(cmd, args);
    if (T.tauri && typeof T.tauri.invoke === 'function') return T.tauri.invoke(cmd, args);
    var internals = window.__TAURI_INTERNALS__;
    if (internals && typeof internals.invoke === 'function') return internals.invoke(cmd, args);
    return Promise.reject(new Error('Tauri invoke API 不可用（core/tauri 均未找到）'));
  }

  // ------------------------------------------------------------------
  // 轻量浮层提示：不依赖 index.html 的 DOM 结构，用于暴露错误与状态
  // ------------------------------------------------------------------
  var _toastEl = null;
  function showToast(msg, ms) {
    try {
      msg = String(msg);
      document.title = msg;
      if (!_toastEl && document.body) {
        _toastEl = document.createElement('div');
        _toastEl.style.cssText =
          'position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:99999;' +
          'background:#0a0a0a;color:#22d3ee;font:13px Consolas,monospace;padding:6px 12px;' +
          'border:1px solid #22d3ee;border-radius:6px;pointer-events:none;opacity:0;transition:opacity .2s';
        document.body.appendChild(_toastEl);
      }
      if (_toastEl) {
        _toastEl.textContent = msg;
        _toastEl.style.opacity = '1';
        clearTimeout(_toastEl._t);
        _toastEl._t = setTimeout(function () { _toastEl.style.opacity = '0'; }, ms || 2500);
      }
      clearTimeout(showToast._t);
      showToast._t = setTimeout(function () {
        try { document.title = 'KivNote'; } catch (e) {}
      }, ms || 2500);
    } catch (e) {}
  }
  window.__kivToast = showToast;

  // 未捕获异常 / 未处理 Promise 拒绝 → 直接显示出来，杜绝静默失败
  window.addEventListener('error', function (e) {
    showToast('错误: ' + (e && e.message ? e.message : e));
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    showToast('异步错误: ' + (r && r.message ? r.message : r));
  });

  // ------------------------------------------------------------------
  // dialog 插件调用
  // 插件官方 guest-js 的实现是：
  //   invoke("plugin:dialog|open", { options: {...} })   ← 必须包一层 options
  //   invoke("plugin:dialog|save", { options: {...} })
  // Rust 端签名为 `options: OpenDialogOptions`（具名参数），平铺传参会反序列化失败。
  // 优先用插件注入的 window.__TAURI__.dialog（它自己会包 options），否则走显式 invoke。
  // ------------------------------------------------------------------
  function dialogOpen(opts) {
    var d = api().dialog;
    if (d && typeof d.open === 'function') {
      try { return Promise.resolve(d.open(opts)); } catch (e) { /* 落到 invoke */ }
    }
    return invoke('plugin:dialog|open', { options: opts });
  }
  function dialogSave(opts) {
    var d = api().dialog;
    if (d && typeof d.save === 'function') {
      try { return Promise.resolve(d.save(opts)); } catch (e) { /* 落到 invoke */ }
    }
    return invoke('plugin:dialog|save', { options: opts });
  }

  // base64 -> Uint8Array
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  function basename(p) {
    return (p || '').split(/[\\/]/).pop();
  }

  // Electron 的 doc.url 是 file://；Tauri 用 asset 协议（config 已开 assetProtocol scope **）
  function fixUrl(doc) {
    if (doc && !doc.error && doc.path) {
      try {
        doc.url = api().core.convertFileSrc(doc.path);
      } catch (e) {
        doc.url = '';
      }
    }
    return doc;
  }

  const cmds = {
    // ---- 打开文件（返回完整 doc：分类/大小/编码/文本内容）----
    open: () =>
      dialogOpen({ multiple: false, title: '打开文件' }).then((f) => {
        const p = Array.isArray(f) ? f[0] : f;
        return p ? invoke('open_path', { path: p }).then(fixUrl) : null;
      }),

    openPath: (p) => invoke('open_path', { path: p }).then(fixUrl),

    // ---- 整读 / 分块读（base64 透传，渲染端自行解码）----
    readAll: (path) => invoke('read_file', { path }),

    chunk: (path, offset, length) =>
      invoke('chunk', { path, offset, length }).then((r) => {
        if (r.error || !r.data) return r;
        return {
          data: b64ToBytes(r.data), // 渲染端 new Uint8Array(r.data) 兼容 Uint8Array
          offset: r.offset,
          size: r.size,
          eof: r.eof,
        };
      }),

    // ---- 保存 ----
    save: (path, content /*, enc*/) =>
      invoke('write_file', { path, content })
        .then(() => ({ ok: true, path }))
        .catch((e) => ({ error: String(e) })),

    saveAs: (content, name) =>
      dialogSave({ defaultPath: name || '未命名.txt' }).then((p) =>
        p
          ? invoke('write_file', { path: p, content })
              .then(() => ({ ok: true, path: p, name: basename(p) }))
              .catch((e) => ({ error: String(e) }))
          : { ok: false }
      ),

    // 另存二进制（PDF 导出页 / 旋转另存都走这里）。
    // Electron 版是 file:saveAsBinary；Tauri 没有这个命令，
    // 用「先选路径 → 再写 base64」两步等效实现。
    // 调用方（index.html 的 bytesToB64）传进来的已经是纯 base64 字符串，
    // Rust 端 write_base64 期望的也正是字符串，直接透传即可。
    saveAsBinary: (data, name) =>
      dialogSave({
        defaultPath: name || 'output.pdf',
        filters: [{ name: 'PDF', extensions: ['pdf'] }, { name: '所有文件', extensions: ['*'] }]
      }).then((p) => {
        if (!p) return { ok: false };
        return invoke('write_base64', { path: p, data: String(data) })
          .then((r) => ({ ok: !!(r && r.ok), path: p, size: r && r.size, error: r && r.error }))
          .catch((e) => ({ error: String(e) }));
      }),

    // ---- 二进制 / 十六进制 / 表格 ----
    writeBase64: (path, data) =>
      invoke('write_base64', { path, data })
        .then((r) => ({ ok: r.ok, size: r.size, error: r.error }))
        .catch((e) => ({ error: String(e) })),
    writeBytes: (path, patches) =>
      invoke('write_bytes', { path, patches })
        .then((r) => ({ ok: r.ok, count: r.count, error: r.error }))
        .catch((e) => ({ error: String(e) })),
    // xlsx 单元格就地改值暂走 SheetJS 全量重写的 legacySaveXlsx（见 index.html），patchXlsx 留待 Phase 1
    patchXlsx: () => Promise.resolve({ ok: false, error: '暂不支持，已回退到全量保存' }),
    backup: (path) =>
      invoke('backup', { path })
        .then(() => ({ ok: true }))
        .catch((e) => ({ error: String(e) })),

    // ---- Office / PDF ----
    pdfText: () => Promise.resolve(null),
    // Word：后端解 zip 取 word/document.xml
    docParts: (p) => invoke('doc_parts', { path: p }),
    // PPT：后端解 zip 取每页 XML + 关系表 + 内嵌图片（内置近似解析器，版式不保真）
    pptParts: (p) => invoke('ppt_parts', { path: p }),
    // PPT 高保真：LibreOffice 转 PDF → 前端 PDF.js 栅格化成位图
    // 返回 { ok, pdf, size, cached, error }
    pptRender: (p) => invoke('ppt_render', { path: p }),
    help: () => Promise.resolve(''),
    // 通用转换（doc/xls/ppt → pdf 或 xlsx），返回 { ok, path, size, cached, error }
    loConvert: (p, to) => invoke('lo_convert', { src: p, to: to }),
    // LibreOffice 是否可用（用于前端提示「版式可能不准」）
    loAvailable: () => invoke('lo_available', {}).catch(function () { return { ok: false }; }),
    // 读文件为 base64（把转出来的 PDF 字节喂给 PDF.js）
    readB64: (p) => invoke('read_b64', { path: p }),
    convert: () => Promise.resolve({ error: 'Tauri 版本没有 COM 自动化，请用内置 LibreOffice 引擎' }),
    cancelConvert: () => Promise.resolve(),

    // ---- 窗口 / 杂项 ----
    cliArg: () => Promise.resolve(null),
    pathForFile: () => '', // 同步接口：Tauri 下拖拽走 __kivOpenPaths 桥，不经过这里
    newWindow: () => {},
    systemOpen: () => {},
    reveal: () => {},
    writeClipboard: (txt) => {
      try {
        navigator.clipboard.writeText(txt);
      } catch (e) {}
    },
    win: {
      min: () => api().window.getCurrentWindow().minimize(),
      toggleMax: () => api().window.getCurrentWindow().toggleMaximize(),
      close: () => api().window.getCurrentWindow().close(),
      forceClose: () => api().window.getCurrentWindow().destroy(),
    },
    setDirty: () => {},
    onCmd: () => {},
    onMax: () => {},
  };

  window.native = cmds;

  // 文件拖拽桥接：Tauri 原生拖拽会拦截 HTML5 drop（WebView2 拿不到真实文件路径），
  // 通过原生拖拽事件拿真实路径，交给 index.html 暴露的 __kivOpenPaths 逐个打开。
  // Tauri v2 不同小版本 API 位置/触发行为不一致：这里把三种方案【全部注册】，
  // 任一触发即可打开，并用时间戳+路径去重，避免同时触发导致重复打开。
  try {
    var T = window.__TAURI__;

    // 去重：onDragDropEvent 与 event.listen 可能同时触发，避免重复打开
    // 注意：key 只能由路径构成，时间戳单独记在 _lastAt —— 若把 Date.now() 拼进 key，
    // 两次 drop 的 key 必然不同，去重会彻底失效。
    var _lastKey = '';
    var _lastAt = 0;
    function handleDrop(e) {
      // e 可能是 {type:'tauri://drag-drop', payload:{type,paths}}（listen）
      // 或 {type:'dragDrop', payload:{type,paths}}（onDragDropEvent）
      var p = e && e.payload ? e.payload : e;
      if (!p) return;
      // 'enter'/'over'/'leave' 不是 drop，忽略
      if (p.type && p.type !== 'drop') return;
      var paths = p.paths || (p.payload && p.payload.paths) || [];
      if (!paths.length) return;
      var key = paths.join('|');
      var now = Date.now();
      if (key === _lastKey && (now - _lastAt) < 800) return; // 同一批去重
      _lastKey = key;
      _lastAt = now;
      showToast('已接收 ' + paths.length + ' 个文件，正在打开…');
      if (typeof window.__kivOpenPaths === 'function') window.__kivOpenPaths(paths);
    }

    // 三种方案全注册（逐个 try 互不阻塞；任一可用即可）
    var reg = 0;
    try { T.webview.getCurrentWebview().onDragDropEvent(handleDrop); reg++; } catch (e) {}
    try { T.webviewWindow.getCurrentWebviewWindow().onDragDropEvent(handleDrop); reg++; } catch (e) {}
    try { T.event.listen('tauri://drag-drop', handleDrop).then(function () { reg++; }); } catch (e) {}
    console.log('[kivnote] drag-drop handlers registered:', reg);

    // 启动后显示一次“就绪”提示，便于确认监听是否注册成功
    var announce = function () { showToast('拖拽已就绪（' + reg + ' 种监听）'); };
    if (document.body) announce();
    else document.addEventListener('DOMContentLoaded', announce);
  } catch (err) {
    console.log('[kivnote] drag-drop init failed:', err);
  }
})();
