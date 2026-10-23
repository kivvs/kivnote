#!/usr/bin/env node
/**
 * Tauri 适配层（renderer/tauri-shim.js）契约测试
 *
 * 背景：Phase 0 迁移时踩过一个很隐蔽的坑——Tauri v1 的 invoke 在
 * `window.__TAURI__.tauri.invoke`，而 v2 改成了 `window.__TAURI__.core.invoke`，
 * 顶层根本没有 `tauri` 这个键（v2 顶层键只有 app/core/dpi/event/image/menu/
 * mocks/path/tray/webview/webviewWindow/window）。结果 open/openPath 一调用就
 * 同步抛 TypeError，表现是「拖拽收到了文件但没打开」「打开按钮点了没反应」，
 * 完全静默。
 *
 * 另外 dialog 插件的 open/save 命令参数必须包一层 `{ options: {...} }`
 * （见 tauri-plugin-dialog 的 guest-js 与 Rust 端 `options: OpenDialogOptions`）。
 *
 * 这些都不该靠人眼在 GUI 里试，所以这里用 vm 沙箱 + 假 Tauri 全局对象做契约断言。
 *
 * 用法：node tests/tauri-shim.test.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SHIM = fs.readFileSync(path.join(ROOT, 'renderer/tauri-shim.js'), 'utf8');

let pass = 0, fail = 0;
const failures = [];

/* vm 沙箱里创建的对象原型来自沙箱，deepStrictEqual 的原型校验会误报。
   先 JSON 归一化再比较。 */
function assertArgs(actual, expected, msg) {
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(actual === undefined ? null : actual)),
    expected === undefined ? null : expected,
    msg
  );
}

async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail++;
    failures.push(name + '：' + e.message);
    console.log('  ✗ ' + name + '  ← ' + e.message);
  }
}

/* ───────── 沙箱：构造一个尽量像浏览器的环境 ───────── */

function makeEnv(opts) {
  opts = opts || {};
  const calls = [];
  const listeners = {};       // 事件名 -> [cb]
  const dragHandlers = [];    // onDragDropEvent 回调

  function record(cmd, args) {
    calls.push({ cmd: cmd, args: args });
    const table = opts.responses || {};
    if (Object.prototype.hasOwnProperty.call(table, cmd)) {
      const h = table[cmd];
      if (typeof h === 'function') return Promise.resolve(h(args));
      /* 约定：响应值是 Error 实例时视为「命令执行失败」，必须 reject。
         否则被测代码的 .catch 分支永远测不到。 */
      if (h instanceof Error) return Promise.reject(h);
      return Promise.resolve(h);
    }
    return Promise.resolve(null);
  }

  const T = {
    // 注意：这里【故意不提供】tauri 命名空间——Tauri v2 真实结构就没有它。
    // 这条约束正是本次回归测试要锁死的东西。
    core: {
      invoke: function (cmd, args) { return record(cmd, args); },
      convertFileSrc: function (p) { return 'asset://localhost/' + p; }
    },
    event: {
      listen: function (name, cb) {
        (listeners[name] = listeners[name] || []).push(cb);
        return Promise.resolve(function () {});
      }
    },
    webview: {
      getCurrentWebview: function () {
        return {
          onDragDropEvent: function (cb) { dragHandlers.push(cb); }
        };
      }
    },
    window: {
      getCurrentWindow: function () {
        return { minimize: function () {}, toggleMaximize: function () {}, close: function () {}, destroy: function () {} };
      }
    }
  };

  if (opts.withDialog) {
    T.dialog = {
      open: function (o) { calls.push({ cmd: '@dialog.open', args: o }); return Promise.resolve(opts.withDialog.openResult || null); },
      save: function (o) { calls.push({ cmd: '@dialog.save', args: o }); return Promise.resolve(opts.withDialog.saveResult || null); }
    };
  }

  const doc = {
    title: 'KivNote',
    body: { appendChild: function () {} },
    createElement: function () { return { style: {}, textContent: '' }; },
    addEventListener: function () {}
  };

  const quietConsole = { log: function () {}, warn: function () {}, error: function () {} };

  const fakeWindow = {
    __TAURI__: T,
    __TAURI_INTERNALS__: { invoke: function (c, a) { return record(c, a); } },
    document: doc,
    navigator: { clipboard: { writeText: function () {} } },
    console: quietConsole,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    atob: atob,
    Date: Date,
    addEventListener: function () {}
  };

  const sandbox = {
    window: fakeWindow,
    document: doc,
    navigator: fakeWindow.navigator,
    console: quietConsole,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    atob: atob,
    Date: Date,
    Promise: Promise
  };
  vm.createContext(sandbox);
  vm.runInContext(SHIM, sandbox, { filename: 'tauri-shim.js' });

  return {
    native: fakeWindow.native,
    win: fakeWindow,
    calls: calls,
    dragHandlers: dragHandlers,
    listeners: listeners,
    find: function (cmd) {
      return calls.filter(function (c) { return c.cmd === cmd; })[0];
    }
  };
}

(async function main() {
  console.log('== Tauri 适配层：invoke 命名空间 ==');

  await test('openPath 走 core.invoke（不依赖已废弃的 tauri 命名空间）', async function () {
    const env = makeEnv({
      responses: { open_path: { path: '/tmp/a.txt', name: 'a.txt', ext: 'txt', size: 12, kind: 'text', kindLabel: '文本' } }
    });
    await env.native.openPath('/tmp/a.txt');
    const c = env.find('open_path');
    assert.ok(c, '应发出 open_path 命令');
    assertArgs(c.args, { path: '/tmp/a.txt' });
  });

  await test('readAll 走 read_file 且原样透传 {data,size}', async function () {
    const e2 = makeEnv({ responses: { read_file: { data: 'aGk=', size: 2 } } });
    const r = await e2.native.readAll('/tmp/a.bin');
    assertArgs(e2.find('read_file').args, { path: '/tmp/a.bin' });
    assert.strictEqual(r.data, 'aGk=');
    assert.strictEqual(r.size, 2);
  });

  await test('chunk 走 chunk 命令且 data 解成 Uint8Array', async function () {
    const e2 = makeEnv({ responses: { chunk: { data: 'aGk=', offset: 0, size: 2, eof: true } } });
    const r = await e2.native.chunk('/tmp/a.bin', 0, 2);
    assertArgs(e2.find('chunk').args, { path: '/tmp/a.bin', offset: 0, length: 2 });
    // 跨 realm：沙箱里创建的 Uint8Array 对宿主 instanceof 不成立，用 toString 判定
    assert.strictEqual(Object.prototype.toString.call(r.data), '[object Uint8Array]', 'data 必须是 Uint8Array');
    assert.strictEqual(r.data.length, 2);
    assert.strictEqual(r.data[0], 104); // 'h'
  });

  console.log('== Tauri 适配层：dialog 插件契约 ==');

  await test('open 的参数包在 options 里（Rust 端是具名参数 options）', async function () {
    const env = makeEnv({ responses: { 'plugin:dialog|open': '/tmp/picked.pdf' } });
    await env.native.open();
    const c = env.find('plugin:dialog|open');
    assert.ok(c, '应发出 dialog open 命令');
    assert.ok(c.args && c.args.options, '必须包一层 { options: {...} }');
    assert.strictEqual(c.args.options.multiple, false);
  });

  await test('open 选到文件后继续调 open_path', async function () {
    const env = makeEnv({
      responses: {
        'plugin:dialog|open': '/tmp/picked.pdf',
        open_path: { path: '/tmp/picked.pdf', name: 'picked.pdf', ext: 'pdf', size: 100, kind: 'pdf', kindLabel: 'PDF' }
      }
    });
    await env.native.open();
    const c = env.find('open_path');
    assert.ok(c, '应继续调 open_path');
    assertArgs(c.args, { path: '/tmp/picked.pdf' });
  });

  await test('openPath 返回的 doc 带上 asset 协议的 url', async function () {
    const env = makeEnv({
      responses: { open_path: { path: '/tmp/picked.pdf', name: 'picked.pdf', ext: 'pdf', size: 100, kind: 'pdf', kindLabel: 'PDF' } }
    });
    const doc = await env.native.openPath('/tmp/picked.pdf');
    assert.strictEqual(doc.url, 'asset://localhost//tmp/picked.pdf');
    assert.strictEqual(doc.kind, 'pdf');
  });

  await test('saveAs 的参数同样包在 options 里', async function () {
    const e2 = makeEnv({ responses: { 'plugin:dialog|save': '/tmp/out.txt' } });
    await e2.native.saveAs('hello', 'out.txt');
    const c = e2.find('plugin:dialog|save');
    assert.ok(c.args && c.args.options, '必须包一层 { options: {...} }');
    assert.strictEqual(c.args.options.defaultPath, 'out.txt');
  });

  await test('插件注入的 window.__TAURI__.dialog 优先于手写 invoke', async function () {
    const e2 = makeEnv({ withDialog: { openResult: '/tmp/from-plugin.pdf' } });
    await e2.native.open();
    assert.ok(e2.find('@dialog.open'), '应走插件官方 API');
    assert.strictEqual(e2.find('plugin:dialog|open'), undefined, '不应再手写 invoke');
  });

  console.log('== Tauri 适配层：读写命令名 ==');

  await test('save 走 write_file', async function () {
    const e2 = makeEnv();
    await e2.native.save('/tmp/a.txt', 'x');
    assertArgs(e2.find('write_file').args, { path: '/tmp/a.txt', content: 'x' });
  });

  await test('writeBase64 / writeBytes / backup 命令名正确', async function () {
    const e2 = makeEnv({ responses: { write_base64: { ok: true, size: 3 }, write_bytes: { ok: true, count: 1 } } });
    await e2.native.writeBase64('/tmp/a.bin', 'aGk=');
    await e2.native.writeBytes('/tmp/a.bin', [{ offset: 0, byte: 1 }]);
    await e2.native.backup('/tmp/a.bin');
    assertArgs(e2.find('write_base64').args, { path: '/tmp/a.bin', data: 'aGk=' });
    assertArgs(e2.find('write_bytes').args, { path: '/tmp/a.bin', patches: [{ offset: 0, byte: 1 }] });
    assertArgs(e2.find('backup').args, { path: '/tmp/a.bin' });
  });

  console.log('== Tauri 适配层：Office 拆包 ==');

  await test('docParts 走 doc_parts 命令并返回正文', async function () {
    const e2 = makeEnv({ responses: { doc_parts: { doc: '<w:document><w:body/></w:document>' } } });
    const r = await e2.native.docParts('/tmp/a.docx');
    assertArgs(e2.find('doc_parts').args, { path: '/tmp/a.docx' });
    assert.ok(r.doc.indexOf('w:body') >= 0, '应返回正文 XML');
  });

  await test('pptParts 走 ppt_parts 命令并返回 slides/cx/cy', async function () {
    const e2 = makeEnv({
      responses: {
        ppt_parts: {
          cx: 12192000, cy: 6858000,
          slides: [{ i: 1, xml: '<p:sld/>', rels: {}, media: {} }]
        }
      }
    });
    const r = await e2.native.pptParts('/tmp/a.pptx');
    assertArgs(e2.find('ppt_parts').args, { path: '/tmp/a.pptx' });
    assert.strictEqual(r.slides.length, 1);
    assert.strictEqual(r.cx, 12192000);
    assert.strictEqual(r.cy, 6858000);
  });

  await test('docParts / pptParts 出错时把 error 带出来', async function () {
    const e2 = makeEnv({ responses: { doc_parts: { error: '这不是有效的 Word 文档' } } });
    const r = await e2.native.docParts('/tmp/bad.docx');
    assert.strictEqual(r.error, '这不是有效的 Word 文档');
  });

  console.log('== Tauri 适配层：LibreOffice 转换链路 ==');

  await test('pptRender 走 ppt_render 命令（LibreOffice→PDF），参数只带 path', async function () {
    const e2 = makeEnv({
      responses: { ppt_render: { ok: true, pdf: 'C:/tmp/cache/a.pdf', size: 26961, cached: false, error: null } }
    });
    const r = await e2.native.pptRender('C:/docs/a.pptx');
    assertArgs(e2.find('ppt_render').args, { path: 'C:/docs/a.pptx' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.pdf, 'C:/tmp/cache/a.pdf');
  });

  await test('loConvert 走 lo_convert 命令，src/to 两个具名参数', async function () {
    const e2 = makeEnv({
      responses: { lo_convert: { ok: true, path: 'C:/tmp/a.pdf', size: 1234, cached: true, error: null } }
    });
    const r = await e2.native.loConvert('C:/docs/old.doc', 'pdf');
    assertArgs(e2.find('lo_convert').args, { src: 'C:/docs/old.doc', to: 'pdf' });
    assert.strictEqual(r.cached, true);
  });

  await test('loConvert 转 xlsx 也能传（解锁旧格式另存为）', async function () {
    const e2 = makeEnv({ responses: { lo_convert: { ok: true, path: 'C:/tmp/a.xlsx', size: 9, cached: false } } });
    await e2.native.loConvert('C:/docs/old.xls', 'xlsx');
    assertArgs(e2.find('lo_convert').args, { src: 'C:/docs/old.xls', to: 'xlsx' });
  });

  await test('readB64 走 read_b64 命令（把转出的 PDF 字节喂 pdf.js）', async function () {
    const e2 = makeEnv({ responses: { read_b64: { ok: true, b64: 'JVBERi0=', size: 5 } } });
    const r = await e2.native.readB64('C:/tmp/a.pdf');
    assertArgs(e2.find('read_b64').args, { path: 'C:/tmp/a.pdf' });
    assert.strictEqual(r.b64, 'JVBERi0=');
  });

  await test('loAvailable 命令名正确，异常时降级为 { ok:false } 而非抛错', async function () {
    const e1 = makeEnv({ responses: { lo_available: { ok: true, path: 'C:/lo/soffice.com' } } });
    const r1 = await e1.native.loAvailable();
    assertArgs(e1.find('lo_available').args, {});
    assert.strictEqual(r1.ok, true);

    const e2 = makeEnv({ responses: { lo_available: new Error('command not found') } });
    const r2 = await e2.native.loAvailable();
    assert.strictEqual(r2.ok, false);
  });

  await test('convert 在 Tauri 下必须明确报错，而不是静默 null（否则 UI 只显示"转换失败"）', async function () {
    const e2 = makeEnv();
    const r = await e2.native.convert('C:/docs/a.doc');
    assert.ok(r && r.error, '应返回带 error 的对象');
  });

  console.log('== Tauri 适配层：拖拽桥 ==');

  await test('drop 事件把 paths 交给 __kivOpenPaths', function () {
    const env = makeEnv();
    const got = [];
    env.win.__kivOpenPaths = function (paths) { got.push(paths); };
    assert.ok(env.dragHandlers.length > 0, '应注册了拖拽监听');
    env.dragHandlers[0]({ type: 'dragDrop', payload: { type: 'drop', paths: ['/tmp/a.pdf', '/tmp/b.xlsx'] } });
    assert.strictEqual(got.length, 1);
    assertArgs(got[0], ['/tmp/a.pdf', '/tmp/b.xlsx']);
  });

  await test('enter / over / leave 不触发打开', function () {
    const env = makeEnv();
    const got = [];
    env.win.__kivOpenPaths = function (paths) { got.push(paths); };
    env.dragHandlers[0]({ type: 'dragDrop', payload: { type: 'enter', paths: ['/tmp/a.pdf'] } });
    env.dragHandlers[0]({ type: 'dragDrop', payload: { type: 'over', paths: ['/tmp/a.pdf'] } });
    env.dragHandlers[0]({ type: 'dragDrop', payload: { type: 'leave' } });
    assert.strictEqual(got.length, 0, '非 drop 事件不应打开文件');
  });

  await test('同一批文件重复触发只打开一次（去重）', function () {
    const env = makeEnv();
    const got = [];
    env.win.__kivOpenPaths = function (paths) { got.push(paths); };
    const ev = { type: 'dragDrop', payload: { type: 'drop', paths: ['/tmp/a.pdf'] } };
    env.dragHandlers[0](ev);
    env.dragHandlers[0](ev);
    assert.strictEqual(got.length, 1, '重复 drop 应被去重');
  });

  await test('不同批文件各自打开一次', function () {
    const env = makeEnv();
    const got = [];
    env.win.__kivOpenPaths = function (paths) { got.push(paths); };
    env.dragHandlers[0]({ type: 'dragDrop', payload: { type: 'drop', paths: ['/tmp/a.pdf'] } });
    env.dragHandlers[0]({ type: 'dragDrop', payload: { type: 'drop', paths: ['/tmp/b.pdf'] } });
    assert.strictEqual(got.length, 2);
  });

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  if (fail) {
    failures.forEach(function (f) { console.log('  失败：' + f); });
    process.exit(1);
  }
})();
