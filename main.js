'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, webUtils, Menu, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { execFile } = require('child_process');
const crypto = require('crypto');
const os = require('os');
let AdmZip = null;
try { AdmZip = require('adm-zip'); } catch (e) { console.error('adm-zip load failed', e.message); }
let pdfjs = null;
try { pdfjs = require('pdfjs-dist/legacy/build/pdf.js'); } catch (e) { console.error('pdfjs load failed', e.message); }

const IS_SHOT = process.argv.includes('--shot');
const OPEN_ARGS = process.argv.filter(x => x.startsWith('--open=')).map(x => x.slice(7));
const VIEW_ARG = (function () {
  const a = process.argv.find(x => x.startsWith('--view='));
  return a ? a.slice(7) : null;
})();

/* 关掉 GPU 合成层：记事本用不到，且关掉后 Chromium 内置 PDF 阅读器
   在无独显 / 远程桌面 / 虚拟机的环境下也能正常出图。 */
app.commandLine.appendSwitch('disable-gpu-compositing');
if (process.argv.includes('--safe-gpu')) app.disableHardwareAcceleration();

let win = null;
let dirty = false;
let forceClose = false;

/* ═════════════ 文件类型表 ═════════════ */

const TEXT_EXT = new Set(('txt md markdown mdx log json jsonc json5 xml yaml yml toml ini cfg conf env ' +
  'properties csv tsv srt ass vtt lrc html htm xhtml css scss sass less styl ' +
  'js mjs cjs jsx ts tsx vue svelte astro py pyw pyi rb rake php java kt kts groovy ' +
  'go rs c h cc cpp cxx hpp hh hxx cs m mm swift dart lua pl pm r jl scala clj cljs ex exs erl hrl ' +
  'hs lhs fs fsx vb vbs asm s nasm sql sh bash zsh fish ksh bat cmd ps1 psm1 vim el lisp scm ' +
  'tex sty cls bib org rst adoc text diff patch gitignore gitattributes gitmodules ' +
  'dockerignore editorconfig npmrc nvmrc yarnrc babelrc eslintrc prettierrc stylelintrc ' +
  'lock pem key crt cer csr pub asc gpg htaccess nginx service desktop plist ' +
  'cmake mk makefile dockerfile license readme changelog authors todo').split(/\s+/));

const IMAGE_EXT = new Set('png jpg jpeg jpe jfif gif webp avif bmp ico svg tif tiff heic heif apng'.split(/\s+/));
const AUDIO_EXT = new Set('mp3 wav ogg oga flac m4a aac opus wma mid midi weba'.split(/\s+/));
const VIDEO_EXT = new Set('mp4 webm mkv mov m4v ogv avi wmv flv mpg mpeg 3gp'.split(/\s+/));
const PDF_EXT   = new Set(['pdf']);

const FRIENDLY = {
  text: '文本', image: '图片', audio: '音频', video: '视频', pdf: 'PDF',
  table: '表格', docx: 'Word', pptx: 'PPT', doc: 'Word(旧)', xls: 'Excel(旧)', ppt: 'PPT(旧)', archive: '压缩包', binary: '二进制', office: '文档',
  exec: '可执行文件', unknown: '未知'
};

/* 魔数嗅探：后缀可以骗人，文件头不会 */
function sniff(b) {
  if (b.length < 4) return null;
  const h4 = b.toString('hex', 0, 4);
  const h2 = b.toString('hex', 0, 2);
  if (h4 === '89504e47') return 'image';
  if (h2 === 'ffd8') return 'image';
  if (h4.startsWith('47494638')) return 'image';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF') {
    const t = b.toString('ascii', 8, 12);
    if (t === 'WEBP') return 'image';
    if (t === 'WAVE') return 'audio';
    if (t === 'AVI ') return 'video';
  }
  if (b.toString('ascii', 0, 5) === '%PDF-') return 'pdf';
  if (b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp') return 'video';
  if (h4 === '1a45dfa3') return 'video';
  if (b.toString('ascii', 0, 4) === 'OggS') return 'audio';
  if (b.toString('ascii', 0, 4) === 'fLaC') return 'audio';
  if (b.toString('ascii', 0, 3) === 'ID3') return 'audio';
  if (h4 === '504b0304') return 'archive';
  if (h4 === '1f8b0800' || h4 === '1f8b0808') return 'archive';
  if (b.toString('ascii', 0, 6) === '7z\xBC\xAF\x27\x1C') return 'archive';
  if (b.toString('ascii', 0, 4) === 'Rar!') return 'archive';
  if (h4 === '7f454c46') return 'exec';
  if (h2 === '4d5a') return 'exec';
  if (h4 === '0061736d') return 'binary';
  if (b.toString('ascii', 0, 15) === 'SQLite format 3') return 'binary';
  return null;
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  if (!n) return false;
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const c = buf[i];
    if (c === 0) return true;
    if (c < 7 || (c > 13 && c < 32)) bad++;
  }
  return bad / n > 0.08;
}

function classify(ext, head) {
  const magic = sniff(head);
  if (magic) {
    if (magic === 'archive' && /^(docx|xlsx|xlsm|pptx|odt|ods|odp|jar|apk|epub|whl)$/.test(ext)) {
      if (/^(xlsx|xlsm|ods|odt)$/.test(ext)) return 'table';
      if (/^(docx|docm|dotx)$/.test(ext)) return 'docx';
      if (/^(pptx|pptm|potx|ppsx)$/.test(ext)) return 'pptx';
      if (ext === 'jar' || ext === 'apk') return 'exec';
      return 'archive';
    }
    return magic;
  }
  if (PDF_EXT.has(ext)) return 'pdf';
  if (/^(csv|tsv|tab)$/.test(ext)) return 'table';
  if (/^(xlsx|xlsm|xlsb|xls|ods|numbers)$/.test(ext)) return 'table';

  /* 图片 / 音视频后缀，但内容其实是普通文本 —— 当文本打开，别白屏 */
  const binaryish = looksBinary(head);
  if (IMAGE_EXT.has(ext)) return binaryish ? 'image' : 'text';
  if (AUDIO_EXT.has(ext)) return binaryish ? 'audio' : 'text';
  if (VIDEO_EXT.has(ext)) return binaryish ? 'video' : 'text';

  if (TEXT_EXT.has(ext)) return 'text';
  if (/^(docx|docm|dotx)$/.test(ext)) return 'docx';
  if (/^(pptx|pptm|potx|ppsx)$/.test(ext)) return 'pptx';
  if (/^(doc|dot)$/.test(ext)) return 'doc';
  if (/^(xls|xlt|xlsm)$/.test(ext)) return 'xls';
  if (/^(ppt|pps|pot)$/.test(ext)) return 'ppt';
  if (/^(xlsx|odt|ods|odp|rtf|epub|mobi|azw3)$/.test(ext)) return 'office';
  if (/^(zip|rar|7z|tar|gz|bz2|xz|zst|iso|tgz|cab|dmg|pkg|deb|rpm|whl|nupkg)$/.test(ext)) return 'archive';
  if (/^(exe|dll|sys|msi|apk|jar|class|pyc|pyo|o|obj|lib|a|so|dylib|bin|dat|wasm)$/.test(ext)) return 'exec';

  if (!head.length) return 'text';
  return binaryish ? 'binary' : 'text';
}

/* ═════════════ 读取与解码 ═════════════ */

const MAX_TEXT  = 32 * 1024 * 1024;
const MAX_HEX   = 256 * 1024;
const HEX_LINES = 16 * 1024;

function decodeText(buf) {
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) buf = buf.subarray(3);
  const utf8 = buf.toString('utf8');
  const bad = (utf8.match(/\uFFFD/g) || []).length;
  if (bad > 0 && bad / Math.max(1, utf8.length) > 0.002) {
    try {
      const gbk = new TextDecoder('gbk').decode(buf);
      const gbad = (gbk.match(/\uFFFD/g) || []).length;
      if (gbad <= bad) return { text: gbk, enc: 'GBK' };
    } catch (e) { /* 忽略 */ }
  }
  return { text: utf8, enc: 'UTF-8' };
}

function hexDump(buf, maxBytes, maxLines) {
  const n = Math.min(buf.length, maxBytes);
  const lines = [];
  for (let i = 0; i < n; i += 16) {
    if (lines.length >= maxLines) break;
    const end = Math.min(i + 16, n);
    const chunk = buf.subarray(i, end);
    const hexParts = [];
    let ascii = '';
    for (let j = 0; j < 16; j++) {
      if (j < chunk.length) {
        const v = chunk[j];
        hexParts.push(v.toString(16).padStart(2, '0'));
        ascii += (v >= 32 && v < 127) ? String.fromCharCode(v) : '.';
      } else {
        hexParts.push('  ');
        ascii += ' ';
      }
    }
    lines.push({ off: i.toString(16).padStart(8, '0'), hex: hexParts.join(' '), ascii });
  }
  return lines;
}

async function readAny(p) {
  const st = await fs.promises.stat(p);
  if (st.isDirectory()) return { error: '这是一个文件夹，暂不支持打开目录' };

  const name = path.basename(p);
  const ext = (path.extname(p).replace('.', '') || '').toLowerCase();
  const size = st.size;

  const fh = await fs.promises.open(p, 'r');
  let head;
  try {
    head = Buffer.alloc(Math.min(4096, size));
    if (head.length) await fh.read(head, 0, head.length, 0);
  } finally {
    await fh.close();
  }

  const kind = classify(ext, head);
  const base = {
    path: p, name, ext, size, kind,
    kindLabel: FRIENDLY[kind] || '文件',
    url: pathToFileURL(p).href
  };

  if (kind === 'text') {
    const lim = Math.min(size, MAX_TEXT);
    const buf = Buffer.alloc(lim);
    const fh2 = await fs.promises.open(p, 'r');
    try { await fh2.read(buf, 0, lim, 0); } finally { await fh2.close(); }
    const d = decodeText(buf);
    return Object.assign(base, { text: d.text, enc: d.enc, truncated: size > MAX_TEXT, editable: true });
  }

  if (kind === 'binary' || kind === 'exec' || kind === 'archive' || kind === 'office' || kind === 'unknown') {
    const lim = Math.min(size, MAX_HEX);
    const buf = Buffer.alloc(lim);
    const fh3 = await fs.promises.open(p, 'r');
    try { await fh3.read(buf, 0, lim, 0); } finally { await fh3.close(); }
    return Object.assign(base, {
      hex: hexDump(buf, MAX_HEX, HEX_LINES),
      truncated: size > MAX_HEX
    });
  }

  return base;
}

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(2) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

/* ═════════════ 窗口 ═════════════ */

function createWindow(openPath) {
  win = new BrowserWindow({
    width: 1180, height: 800,
    minWidth: 820, minHeight: 520,
    frame: false,
    backgroundColor: '#0c0e10',
    title: '记事本',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      plugins: true
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    console.log('[BOOT] ready-to-show at ' + Math.round(process.uptime() * 1000) + 'ms');
    win.show();

    if (openPath) {
      setTimeout(() => win.webContents.send('app:cmd', 'open-path:' + openPath), 400);
    }
    OPEN_ARGS.forEach((p, i) => {
      setTimeout(() => win.webContents.send('app:cmd', 'open-path:' + p), 300 + i * 500);
    });
    if (VIEW_ARG) {
      setTimeout(() => win.webContents.send('app:cmd', 'view:' + VIEW_ARG), 1400);
    }

    if (IS_SHOT) {
      setTimeout(async () => {
        try {
          if (process.argv.includes('--edit-test')) {
            const r = await win.webContents.executeJavaScript(`(function(){
              var by = document.querySelector('#vHex .by');
              if (!by) return 'NO_BYTE';
              by.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
              var box = document.getElementById('vHex');
              ['4','1'].forEach(function(c){
                box.dispatchEvent(new KeyboardEvent('keydown', { key: c, bubbles: true }));
              });
              var ed = document.querySelectorAll('#vHex .by.edited');
              return JSON.stringify({ edited: ed.length, first: ed[0] ? ed[0].textContent : null });
            })()`);
            console.log('[EDIT-TEST]', r);
          }
          if (process.argv.includes('--table-test')) {
            const r = await win.webContents.executeJavaScript(`(function(){
              var td = document.querySelector('#tbl tbody td[data-r]');
              if (!td) return 'NO_CELL';
              td.dispatchEvent(new MouseEvent('mousedown', {bubbles:true}));
              td.dispatchEvent(new MouseEvent('dblclick', {bubbles:true}));
              var inp = document.querySelector('.cell-edit');
              if (!inp) return JSON.stringify({
                hasScroll: !!document.querySelector('.tbl-scroll'),
                sel: document.querySelectorAll('#tbl td.sel').length,
                tdOk: !!td && td.hasAttribute('data-r'),
                inTbl: !!document.querySelector('#tbl tbody td[data-r]')
              });
              inp.value = '改过了';
              inp.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
              var after = document.querySelector('#tbl tbody td[data-r]');
              var dot = document.querySelector('.tab.on .t-dot');
              var before = { rows: document.querySelectorAll('#tbl tbody tr').length,
                             cols: document.querySelectorAll('#tbl thead th').length };
              document.querySelector('[data-tbl="insRowBelow"]').dispatchEvent(new MouseEvent('click', {bubbles:true}));
              document.querySelector('[data-tbl="insColRight"]').dispatchEvent(new MouseEvent('click', {bubbles:true}));
              var mid = { rows: document.querySelectorAll('#tbl tbody tr').length,
                          cols: document.querySelectorAll('#tbl thead th').length };
              document.querySelector('[data-tbl="delRow"]').dispatchEvent(new MouseEvent('click', {bubbles:true}));
              document.querySelector('[data-tbl="delCol"]').dispatchEvent(new MouseEvent('click', {bubbles:true}));
              var end = { rows: document.querySelectorAll('#tbl tbody tr').length,
                          cols: document.querySelectorAll('#tbl thead th').length };
              return JSON.stringify({ cell: after.textContent, dirty: !!dot, before: before, afterIns: mid, afterDel: end });
            })()`);
            console.log('[TABLE-TEST]', r);
          }
          if (process.argv.includes('--pdf-test')) {
            const r = await win.webContents.executeJavaScript(`window.native.pdfText('testfiles/doc.pdf')`);
            console.log('[PDF-TEST]', JSON.stringify(r));
          }
          if (process.argv.includes('--lo-test')) {
            const t0 = Date.now();
            const r = await win.webContents.executeJavaScript(
              "window.native.loConvert('C:/Users/Lenovo/Desktop/信安物联网国助国励/信安1班/国助：计算机科学与工程学院2026-2027学年国家助学金拟推荐名单表.doc','pdf')"
            );
            console.log('[LO-TEST] %.1fs' , (Date.now() - t0) / 1000, JSON.stringify(r));
          }
          if (process.argv.includes('--ppt-all')) {
            await win.webContents.executeJavaScript("document.querySelector('[data-ppt=\"all\"]').dispatchEvent(new MouseEvent('click', {bubbles:true}))");
            await new Promise(r => setTimeout(r, 600));
          }
          if (process.argv.includes('--help-test')) {
            await win.webContents.executeJavaScript("document.dispatchEvent(new KeyboardEvent('keydown', {key:'F1', bubbles:true}))");
            await new Promise(r => setTimeout(r, 800));
          }
          if (process.argv.includes('--about-test')) {
            await win.webContents.executeJavaScript("document.getElementById('aboutMask').classList.add('on')");
            await new Promise(r => setTimeout(r, 500));
          }
          const img = await win.capturePage();
          fs.writeFileSync(path.join(app.getPath('temp'), 'notepad-shot.png'), img.toPNG());
        } catch (e) { console.error(e); }
        app.quit();
      }, 5000);
    }
  });

  win.on('maximize',   () => win.webContents.send('win:max', true));
  win.on('unmaximize', () => win.webContents.send('win:max', false));

  win.on('close', (e) => {
    if (forceClose || !dirty) return;
    e.preventDefault();
    dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['保存并退出', '不保存', '取消'],
      defaultId: 0, cancelId: 2,
      title: '记事本',
      message: '当前文档尚未保存',
      detail: '要保存更改再退出吗？'
    }).then(({ response }) => {
      if (response === 0) win.webContents.send('app:cmd', 'save-and-quit');
      else if (response === 1) { forceClose = true; win.close(); }
    });
  });

  win.on('closed', () => { win = null; });
}

/* ═════════════ IPC ═════════════ */

ipcMain.handle('file:open', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '打开文件',
    properties: ['openFile'],
    filters: [{ name: '所有文件', extensions: ['*'] }]
  });
  if (r.canceled || !r.filePaths.length) return null;
  try { return await readAny(r.filePaths[0]); }
  catch (err) { return { error: '打开失败：' + err.message }; }
});

ipcMain.handle('file:openPath', async (e, p) => {
  try { return await readAny(p); }
  catch (err) { return { error: '打开失败：' + err.message }; }
});

/* 按块读取原始字节，供十六进制 / 二进制视图使用 */
ipcMain.handle('file:chunk', async (e, { path: p, offset, length }) => {
  try {
    const stat = await fs.promises.stat(p);
    const start = Math.max(0, Math.min(offset, stat.size));
    const len = Math.max(0, Math.min(length, stat.size - start));
    const buf = Buffer.alloc(len);
    const fh = await fs.promises.open(p, 'r');
    let read = 0;
    try { ({ bytesRead: read } = await fh.read(buf, 0, len, start)); } finally { await fh.close(); }
    return {
      data: buf.subarray(0, read),
      offset: start,
      size: stat.size,
      eof: start + read >= stat.size
    };
  } catch (err) {
    return { error: err.message };
  }
});

/* 十六进制编辑：按偏移写回单个字节（r+ 随机写，不用整文件读入内存） */
ipcMain.handle('file:writeBytes', async (e, { path: p, patches }) => {
  try {
    if (!Array.isArray(patches) || !patches.length) return { ok: true, count: 0 };
    const stat = await fs.promises.stat(p);
    const fh = await fs.promises.open(p, 'r+');
    let n = 0;
    try {
      for (const it of patches) {
        const off = it.offset | 0;
        if (off < 0 || off >= stat.size) continue;
        await fh.write(Buffer.from([it.byte & 0xff]), 0, 1, off);
        n++;
      }
    } finally {
      await fh.close();
    }
    return { ok: true, count: n };
  } catch (err) { return { error: '写入失败：' + err.message }; }
});

/* 一次性读全文件（表格解析用），返回 base64，限制 48MB */
ipcMain.handle('file:readAll', async (e, p) => {
  try {
    const st = await fs.promises.stat(p);
    if (st.size > 48 * 1024 * 1024) return { error: '文件太大（>48MB），不适合在这个视图打开' };
    const buf = await fs.promises.readFile(p);
    /* 如果是 zip 容器（xlsx/docx/pptx），检查解压后总量防炸弹 */
    if (AdmZip && buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b) {
      try {
        const zip = new AdmZip(buf);
        let total = 0;
        for (const en of zip.getEntries()) total += (en.header && en.header.size) || 0;
        if (total > 768 * 1024 * 1024) {
          return { error: '解压后约 ' + Math.round(total / 1048576) + ' MB，疑似压缩炸弹，已拒绝' };
        }
      } catch (e) { /* 不是 zip 就跳过 */ }
    }
    return { data: buf.toString('base64'), size: st.size };
  } catch (err) { return { error: err.message }; }
});

/* 二进制写回（表格另存为 xlsx 用） */
ipcMain.handle('file:writeBase64', async (e, { path: p, data }) => {
  try {
    const buf = Buffer.from(data, 'base64');
    await fs.promises.writeFile(p, buf);
    return { ok: true, size: buf.length };
  } catch (err) { return { error: '保存失败：' + err.message }; }
});

ipcMain.handle('file:save', async (e, { path: p, content }) => {
  try {
    await fs.promises.writeFile(p, content, 'utf8');
    return { ok: true, size: Buffer.byteLength(content, 'utf8') };
  } catch (err) { return { error: '保存失败：' + err.message }; }
});

ipcMain.handle('file:saveAs', async (e, { content, name }) => {
  const r = await dialog.showSaveDialog(win, {
    title: '另存为',
    defaultPath: name || '未命名.txt',
    filters: [{ name: '文本文件', extensions: ['txt'] }, { name: '所有文件', extensions: ['*'] }]
  });
  if (r.canceled || !r.filePath) return null;
  try {
    await fs.promises.writeFile(r.filePath, content, 'utf8');
    return { ok: true, path: r.filePath, name: path.basename(r.filePath) };
  } catch (err) { return { error: '保存失败：' + err.message }; }
});

/* 写回前备份 */
ipcMain.handle('file:backup', async (e, p) => {
  try {
    await fs.promises.copyFile(p, p + '.bak');
    return { ok: true, path: p + '.bak' };
  } catch (err) { return { error: err.message }; }
});

/* 另存二进制（PDF 页面导出） */
ipcMain.handle('file:saveAsBinary', async (e, { data, name }) => {
  const r = await dialog.showSaveDialog(win, {
    title: '保存为',
    defaultPath: name || 'output.pdf',
    filters: [{ name: 'PDF', extensions: ['pdf'] }, { name: '所有文件', extensions: ['*'] }]
  });
  if (r.canceled || !r.filePath) return null;
  try {
    const buf = Buffer.from(data, 'base64');
    await fs.promises.writeFile(r.filePath, buf);
    return { ok: true, path: r.filePath, name: path.basename(r.filePath), size: buf.length };
  } catch (err) { return { error: err.message }; }
});

ipcMain.handle('file:systemOpen', async (e, p) => {
  const err = await shell.openPath(p);
  return err ? { error: err } : { ok: true };
});

ipcMain.handle('file:reveal', async (e, p) => {
  shell.showItemInFolder(p);
  return { ok: true };
});

ipcMain.handle('win:toggleMax', () => {
  if (!win) return false;
  if (win.isMaximized()) { win.unmaximize(); return false; }
  win.maximize(); return true;
});

ipcMain.handle('win:isMax', () => (win ? win.isMaximized() : false));

ipcMain.handle('win:new', (e, filePath) => {
  const w = createWindow(filePath || null);
  return { ok: true };
});

ipcMain.on('win:min', () => { if (win) win.minimize(); });
ipcMain.on('win:close', () => { if (win) win.close(); });
ipcMain.on('win:dirty', (e, v) => { dirty = !!v; });
ipcMain.on('win:forceClose', () => { forceClose = true; if (win) win.close(); });

/* PDF 文本层提取：按行还原成纯文本，塞进可编辑标签 */
ipcMain.handle('pdf:text', async (e, p) => {
  if (!pdfjs) return { error: 'PDF 解析库未加载' };
  try {
    const data = new Uint8Array(await fs.promises.readFile(p));
    const doc = await pdfjs.getDocument({
      data, useWorkerFetch: false, isEvalSupported: false, verbosity: 0
    }).promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      const lines = [];
      let cur = '', lastY = null;
      for (const it of tc.items) {
        const y = it.transform ? it.transform[5] : 0;
        if (lastY !== null && Math.abs(y - lastY) > 2.5) { lines.push(cur); cur = ''; }
        cur += it.str;
        lastY = y;
      }
      if (cur) lines.push(cur);
      pages.push(lines.join('\n'));
    }
    return { pages, numPages: doc.numPages };
  } catch (err) {
    return { error: err.message };
  }
});

/* docx = zip + xml，取出正文与样式交给渲染进程解析 */
ipcMain.handle('doc:parts', async (e, p) => {
  if (!AdmZip) return { error: '解压库未加载' };
  try {
    const raw = await fs.promises.readFile(p);
    const zip = new AdmZip(raw);
    /* 解压炸弹防护：先看目录里的未压缩总大小 */
    let total = 0;
    try {
      for (const en of zip.getEntries()) total += (en.header && en.header.size) || 0;
    } catch (e) { /* 忽略 */ }
    const ratio = raw.length > 0 ? total / raw.length : 1;
    if (total > 512 * 1024 * 1024 || (total > 64 * 1024 * 1024 && ratio > 400)) {
      return { error: '这个文档解压后约 ' + Math.round(total / 1048576) +
                      ' MB（压缩比 ' + Math.round(ratio) + ':1），疑似压缩炸弹，已拒绝打开' };
    }
    const readTxt = (n) => {
      const en = zip.getEntry(n);
      if (!en) return null;
      return zip.readAsText(en, 'utf8');
    };
    const doc = readTxt('word/document.xml');
    if (!doc) return { error: '这不是有效的 Word 文档（找不到 word/document.xml）' };
    return {
      doc,
      styles: readTxt('word/styles.xml'),
      numbering: readTxt('word/numbering.xml')
    };
  } catch (err) {
    return { error: '解压失败：' + err.message };
  }
});

/* ═════ 用本机 Office / WPS 渲染成图片（效果与原生一致） ═════ */

const PPT_PS1 = [
  'param([string]$Pptx, [string]$OutDir, [string]$Engine)',
  '$ErrorActionPreference = "Stop"',
  '$app = $null',
  'try {',
  '  if ($Engine -eq "wps") { $app = New-Object -ComObject KWPP.Application }',
  '  else { $app = New-Object -ComObject PowerPoint.Application }',
  '} catch { Write-Output ("COMFAIL:" + $_.Exception.Message); exit 2 }',
  'try {',
  '  $pres = $app.Presentations.Open($Pptx, $true, $false, $false)',
  '  $pres.Export($OutDir, "PNG", 1600, 900)',
  '  $pres.Close()',
  '} catch {',
  '  Write-Output ("EXPORTFAIL:" + $_.Exception.Message)',
  '  try { $app.Quit() } catch {}',
  '  exit 3',
  '}',
  'try { $app.Quit() } catch {}',
  'Write-Output "OK"',
  'exit 0'
].join('\r\n');

function runPptRender(pptxPath, outDir, engine) {
  return new Promise((resolve) => {
    const scriptPath = path.join(outDir, '_render.ps1');
    try {
      fs.writeFileSync(scriptPath, '\ufeff' + PPT_PS1, 'utf8');
    } catch (e) {
      resolve({ error: '写临时脚本失败：' + e.message });
      return;
    }
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
       '-Pptx', pptxPath, '-OutDir', outDir, '-Engine', engine],
      { windowsHide: true, timeout: 180000 },
      (err, stdout) => {
        const out = String(stdout || '').trim();
        if (err && !/^OK/m.test(out)) {
          resolve({ error: (out || err.message || 'x').slice(0, 300) });
          return;
        }
        let files = [];
        try {
          files = fs.readdirSync(outDir).filter(f => /\.(png|jpg|jpeg)$/i.test(f));
        } catch (e) { files = []; }
        files.sort((a, b) => {
          const na = parseInt((a.match(/\d+/) || ['0'])[0], 10);
          const nb = parseInt((b.match(/\d+/) || ['0'])[0], 10);
          return na - nb;
        });
        if (!files.length) { resolve({ error: '导出后没有找到图片' }); return; }
        resolve({ images: files.map(f => pathToFileURL(path.join(outDir, f)).href), dir: outDir });
      });
  });
}

ipcMain.handle('ppt:renderNative', async (e, p) => {
  try {
    const st = await fs.promises.stat(p);
    const key = crypto.createHash('md5').update(p + '|' + st.size + '|' + st.mtimeMs).digest('hex').slice(0, 16);
    const cacheRoot = path.join(app.getPath('userData'), 'ppt-cache');
    const outDir = path.join(cacheRoot, key);

    if (fs.existsSync(outDir)) {
      const cached = fs.readdirSync(outDir).filter(f => /\.(png|jpg|jpeg)$/i.test(f));
      if (cached.length) {
        cached.sort((a, b) => parseInt((a.match(/\d+/) || ['0'])[0], 10) - parseInt((b.match(/\d+/) || ['0'])[0], 10));
        return { images: cached.map(f => pathToFileURL(path.join(outDir, f)).href), cached: true };
      }
    }
    await fs.promises.mkdir(outDir, { recursive: true });

    let r = await runPptRender(p, outDir, 'ppt');
    if (r.error) {
      try {
        for (const f of fs.readdirSync(outDir)) {
          if (/\.(png|jpg|jpeg)$/i.test(f)) fs.unlinkSync(path.join(outDir, f));
        }
      } catch (e2) {}
      const r2 = await runPptRender(p, outDir, 'wps');
      if (!r2.error) r = r2;
      else r = { error: '没找到可用的 Office / WPS：' + (r.error || '') };
    }
    return r;
  } catch (err) {
    return { error: err.message };
  }
});

/* ═════ 老格式（doc/xls/ppt）转成新格式，交给现有解析链路 ═════ */

const CONV_PS1 = [
  'param([string]$Src, [string]$Out, [string]$Kind, [string]$Engine)',
  '$ErrorActionPreference = "Stop"',
  '$app = $null',
  'try {',
  '  if ($Kind -eq "writer") {',
  '    if ($Engine -eq "wps") { $app = New-Object -ComObject KWPS.Application }',
  '    else { $app = New-Object -ComObject Word.Application }',
  '  } elseif ($Kind -eq "sheet") {',
  '    if ($Engine -eq "wps") { $app = New-Object -ComObject KET.Application }',
  '    else { $app = New-Object -ComObject Excel.Application }',
  '  } else {',
  '    if ($Engine -eq "wps") { $app = New-Object -ComObject KWPP.Application }',
  '    else { $app = New-Object -ComObject PowerPoint.Application }',
  '  }',
  '} catch { Write-Output ("COMFAIL:" + $_.Exception.Message); exit 2 }',
  'try {',
  '  try { $app.Visible = $false } catch {}',
  '  try { $app.DisplayAlerts = 0 } catch {}',
  '  try { $app.AutomationSecurity = 3 } catch {}',
  '  if ($Kind -eq "writer") {',
  '    $obj = $app.Documents.Open($Src, $false, $true, $false)',
  '    $obj.SaveAs2($Out, 16)',
  '    $obj.Close($false)',
  '  } elseif ($Kind -eq "sheet") {',
  '    $obj = $app.Workbooks.Open($Src, 0, $true, $false)',
  '    $obj.SaveAs($Out, 51)',
  '    $obj.Close($false)',
  '  } else {',
  '    $obj = $app.Presentations.Open($Src, $true, $false, $false)',
  '    $obj.SaveAs($Out, 24)',
  '    $obj.Close()',
  '  }',
  '} catch {',
  '  Write-Output ("CONVFAIL:" + $_.Exception.Message)',
  '  try { $app.Quit() } catch {}',
  '  exit 3',
  '}',
  'try { $app.Quit() } catch {}',
  'Write-Output "OK"',
  'exit 0'
].join('\r\n');

function runConvert(src, dst, kind, engine) {
  return new Promise((resolve) => {
    const bufDir = path.dirname(dst);
    try { fs.mkdirSync(bufDir, { recursive: true }); } catch (e) {}
    const scriptPath = path.join(bufDir, '_conv.ps1');
    try { fs.writeFileSync(scriptPath, '\ufeff' + CONV_PS1, 'utf8'); }
    catch (e) { resolve({ error: '写临时脚本失败：' + e.message }); return; }
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
       '-Src', src, '-Out', dst, '-Kind', kind, '-Engine', engine],
      { windowsHide: true, timeout: 75000 },
      (err, stdout) => {
        const out = String(stdout || '').trim();
        if (fs.existsSync(dst) && fs.statSync(dst).size > 0) { resolve({ ok: true, path: dst }); return; }
        resolve({ error: (out || (err && err.message) || '转换失败').slice(0, 300) });
      });
  });
}

ipcMain.handle('doc:convert', async (e, p) => {
  try {
    const st = await fs.promises.stat(p);
    const ext = path.extname(p).toLowerCase();
    let kind = 'writer', outExt = '.docx';
    if (ext === '.xls' || ext === '.xlt') { kind = 'sheet'; outExt = '.xlsx'; }
    else if (ext === '.ppt' || ext === '.pps' || ext === '.pot') { kind = 'power'; outExt = '.pptx'; }

    const key = crypto.createHash('md5').update(p + '|' + st.size + '|' + st.mtimeMs + '|' + kind).digest('hex').slice(0, 16);
    const cacheDir = path.join(app.getPath('userData'), 'conv-cache');
    const dst = path.join(cacheDir, key + outExt);

    if (fs.existsSync(dst) && fs.statSync(dst).size > 0) {
      return { ok: true, path: dst, cached: true };
    }
    await fs.promises.mkdir(cacheDir, { recursive: true });

    /* 先 WPS：它的 COM 很少弹窗；失败再试 Office */
    let r = await runConvert(p, dst, kind, 'wps');
    if (!r.ok) {
      try { if (fs.existsSync(dst)) fs.unlinkSync(dst); } catch (e2) {}
      const r2 = await runConvert(p, dst, kind, 'office');
      if (r2.ok) r = r2;
      else return { error: '需要本机安装 Microsoft Office 或 WPS 才能打开这个老格式。' + (r.error || '') };
    }
    return r;
  } catch (err) {
    return { error: err.message };
  }
});

/* ═════ 内置 LibreOffice 转换引擎（不依赖用户装 Office） ═════ */

function sofficePath() {
  const candidates = [
    path.join(process.resourcesPath || '', 'loffice', 'program', 'soffice.exe'),
    path.join(__dirname, '_lo', 'extract', 'program', 'soffice.exe')
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

ipcMain.handle('lo:available', () => {
  const so = sofficePath();
  return { ok: !!so, path: so };
});

/* 把任意 Office 文档转成 pdf / xlsx 等 */
ipcMain.handle('lo:convert', async (e, { src, to }) => {
  const so = sofficePath();
  if (!so) return { error: '内置转换引擎缺失' };
  try {
    const st = await fs.promises.stat(src);
    const key = crypto.createHash('md5')
      .update(src + '|' + st.size + '|' + st.mtimeMs + '|' + to).digest('hex').slice(0, 16);
    const cacheRoot = path.join(os.tmpdir(), 'notepad-lo-cache');
    const outDir = path.join(cacheRoot, key);
    const base = path.basename(src).replace(/\.[^.]+$/, '') + '.' + to;
    const target = path.join(outDir, base);

    if (fs.existsSync(target) && fs.statSync(target).size > 0) {
      return { ok: true, path: target, cached: true };
    }
    await fs.promises.mkdir(outDir, { recursive: true });

    await new Promise((resolve) => {
      execFile(so, [
        '--headless', '--norestore', '--nolockcheck',
        '--convert-to', to, '--outdir', outDir, src
      ], { windowsHide: true, timeout: 120000 }, (err, stdout, stderr) => {
        if (err || stderr) console.log('[lo]', String(stdout || '').slice(0, 300), String(stderr || '').slice(0, 300));
        resolve();
      });
    });

    if (fs.existsSync(target) && fs.statSync(target).size > 0) {
      return { ok: true, path: target, size: fs.statSync(target).size };
    }
    /* 有时生成的文件名和预期不一致，兜底扫一遍 */
    try {
      const files = fs.readdirSync(outDir).filter(f => f.toLowerCase().endsWith('.' + to));
      if (files.length) return { ok: true, path: path.join(outDir, files[0]) };
    } catch (e3) {}
    return { error: '转换失败（可能文件加密或格式不受支持）' };
  } catch (err) {
    return { error: err.message };
  }
});

/* pptx = zip + 每页 slideN.xml + 图片等资源 */
function normZipPath(target) {
  let t = String(target || '').trim();
  if (t.startsWith('/')) return t.slice(1);
  const parts = ('ppt/slides/' + t).split('/');
  const out = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.' && p !== '') out.push(p);
  }
  return out.join('/');
}

ipcMain.handle('ppt:parts', async (e, p) => {
  if (!AdmZip) return { error: '解压库未加载' };
  try {
    const raw = await fs.promises.readFile(p);
    const zip = new AdmZip(raw);

    let total = 0;
    try { for (const en of zip.getEntries()) total += (en.header && en.header.size) || 0; } catch (e2) {}
    if (total > 512 * 1024 * 1024) return { error: '这个演示文稿解压后约 ' + Math.round(total / 1048576) + ' MB，疑似压缩炸弹，已拒绝打开' };

    const readTxt = (n) => { const en = zip.getEntry(n); return en ? zip.readAsText(en, 'utf8') : null; };
    const readB64 = (n) => {
      const en = zip.getEntry(n);
      if (!en) return null;
      const buf = zip.readFile(en);
      return buf ? buf.toString('base64') : null;
    };

    /* 幻灯片尺寸（EMU） */
    let cx = 12192000, cy = 6858000;
    const pres = readTxt('ppt/presentation.xml');
    if (pres) {
      const m = /<p:sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"/.exec(pres);
      if (m) { cx = parseInt(m[1], 10); cy = parseInt(m[2], 10); }
    }

    const slides = [];
    for (const en of zip.getEntries()) {
      const m = /^ppt\/slides\/slide(\d+)\.xml$/.exec(en.entryName);
      if (!m) continue;
      const idx = parseInt(m[1], 10);
      const xml = zip.readAsText(en, 'utf8');
      const relsXml = readTxt('ppt/slides/_rels/slide' + idx + '.xml.rels') || '';

      const rels = {};
      const re = /<Relationship[^>]*?Id="([^"]+)"[^>]*?Target="([^"]+)"/g;
      let mm;
      while ((mm = re.exec(relsXml))) rels[mm[1]] = normZipPath(mm[2]);

      const media = {};
      for (const rid of Object.keys(rels)) {
        const t = rels[rid];
        if (/\.(png|jpe?g|gif|bmp|svg|webp)$/i.test(t)) {
          const b = readB64(t);
          if (b) media[rid] = { b64: b, mime: 'image/' + (t.split('.').pop() || 'png').toLowerCase().replace('jpg', 'jpeg') };
        }
      }
      slides.push({ i: idx, xml, rels, media });
    }
    slides.sort((a, b) => a.i - b.i);
    if (!slides.length) return { error: '这不是有效的 PowerPoint 文件（找不到 ppt/slides）' };
    return { cx, cy, slides };
  } catch (err) {
    return { error: '解压失败：' + err.message };
  }
});

ipcMain.handle('app:help', async () => {
  try {
    return { text: await fs.promises.readFile(path.join(__dirname, 'renderer', 'help.md'), 'utf8') };
  } catch (err) { return { error: err.message }; }
});

ipcMain.handle('clip:write', (e, txt) => { clipboard.writeText(String(txt || '')); return true; });

ipcMain.handle('cli:arg', () => {
  const args = process.argv.slice(1);
  const f = args.find(a => !a.startsWith('-') && fs.existsSync(a) && fs.statSync(a).isFile());
  return f || null;
});

/* ═════════════ 生命周期 ═════════════ */

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

process.on('uncaughtException', (err) => { console.error('[main] uncaught', err); });
