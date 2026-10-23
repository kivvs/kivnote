#!/usr/bin/env node
/**
 * 前端逻辑回归测试：针对本轮修复的四个问题
 *
 * 背景：这四个问题里有三个是「肉眼看得出、但说不清根因」的类型，
 * 光靠人眼在 GUI 里试很容易改了一处漏另一处。所以这里从真实的
 * renderer/index.html 提取函数源码来测，保证测的就是线上跑的代码。
 *
 * 覆盖：
 *   1. 表格列宽：按内容自适应 + 滚动时不增宽（colDefaultWidth / ensureWidths）
 *   2. PDF 连页：saveAsBinary 契约 + 连排模式的入口存在
 *   3. 右上角按钮：不再用系统窗口按钮，走自绘三色按钮
 *   4. 刷新还原：会话记录要含顺序、空白标签、激活下标
 *
 * 用法：node tests/frontend-regressions.test.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');
const SHIM = fs.readFileSync(path.join(ROOT, 'renderer/tauri-shim.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'renderer/style.css'), 'utf8');
const CONF = JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri/tauri.conf.json'), 'utf8'));
const CAPS = JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri/capabilities/default.json'), 'utf8'));

let pass = 0, fail = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail++;
    failures.push(name + '：' + e.message);
    console.log('  ✗ ' + name + '  ← ' + e.message);
  }
}

/* 用大括号配对提取单个函数体（与 run-tests.js 同一套机制） */
function extractFn(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('找不到函数 ' + name);
  const j = src.indexOf('{', i);
  let depth = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') {
      depth--;
      if (depth === 0) return src.slice(i, k + 1);
    }
  }
  throw new Error('函数未闭合 ' + name);
}

function loadFns(file, names) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const code = names.map(function (n) { return extractFn(src, n); }).join('\n');
  const factory = new Function(code + '\nreturn {' + names.join(',') + '};');
  return factory();
}

/* ══════════════ 1. 表格列宽 ══════════════ */
console.log('== 表格列宽：按内容自适应 + 滚动不增宽 ==');

const widthFns = loadFns('renderer/index.html', ['textWidthUnits', 'colDefaultWidth', 'ensureWidths']);

test('textWidthUnits 中文按 2 个单位算（汉字比西文宽一倍）', function () {
  assert.strictEqual(widthFns.textWidthUnits('abc'), 3);
  assert.strictEqual(widthFns.textWidthUnits('中文'), 4);
  assert.strictEqual(widthFns.textWidthUnits('中a文'), 5);
});

test('colDefaultWidth 扫全列，不是只看前 60 行', function () {
  /* 造 200 行，第 150 行有一个很长的值。
     如果实现只看前 60 行，宽度会明显偏小。 */
  const rows = [];
  for (let i = 0; i < 200; i++) rows.push(['短']);
  rows[150][0] = 'x'.repeat(60);
  const w = widthFns.colDefaultWidth(rows, 0);
  /* 60 个西文单位 → 22 + 60*7.6 = 478 → 被 420 上限截断 */
  assert.ok(w >= 400, '应扫到第 150 行的长文本，实际宽度 ' + w);
});

test('colDefaultWidth 表头也参与宽度计算', function () {
  const rows = [['a'], ['b']];
  const wNoHead = widthFns.colDefaultWidth(rows, 0);
  const wWithHead = widthFns.colDefaultWidth(rows, 0, '一个非常非常长的表头标题');
  assert.ok(wWithHead > wNoHead, '表头更长时列宽应更大');
});

test('colDefaultWidth 有上限，不会被超长内容撑爆', function () {
  const rows = [['y'.repeat(5000)]];
  const w = widthFns.colDefaultWidth(rows, 0);
  assert.ok(w <= 420, '宽度应被上限截断，实际 ' + w);
  assert.ok(w >= 70, '宽度应不低于下限，实际 ' + w);
});

test('colDefaultWidth 列宽与行数无关（不因表变长而变宽）', function () {
  const rows = [];
  for (let i = 0; i < 1000; i++) rows.push(['中等长度的内容文本']);
  const w1 = widthFns.colDefaultWidth(rows, 0);
  const rows2 = rows.concat([['中等长度的内容文本']]);
  const w2 = widthFns.colDefaultWidth(rows2, 0);
  assert.strictEqual(w1, w2, '行数变化不应改变列宽');
});

test('ensureWidths 列数不变时保留已算好的宽度（不在滚动中重算）', function () {
  const t = { colW: [] };
  const rows = [['abc'], ['def']];
  widthFns.ensureWidths(t, rows, 2);
  const first = t.colW.slice();
  assert.strictEqual(t.colW.length, 2);
  /* 再调一次（模拟滚动/重绘触发），宽度不应变 */
  widthFns.ensureWidths(t, rows, 2);
  assert.deepStrictEqual(t.colW, first, '重复调用不应改变列宽');
});

test('ensureWidths 用户手动拖过的列宽不会被内容重算覆盖', function () {
  const t = { colW: [] };
  const rows = [['abc'], ['def']];
  widthFns.ensureWidths(t, rows, 2);
  /* 模拟用户把第 0 列拖到 300px */
  t.colW[0] = 300;
  t.__colWUserSet = true;
  /* 列数变化触发重算 —— 用户设的 300 应该被保留 */
  widthFns.ensureWidths(t, rows, 3);
  assert.strictEqual(t.colW[0], 300, '用户设的列宽应被保留，实际 ' + t.colW[0]);
});

test('CSS：td 上不能有 min-width（会把列顶宽，导致越滚越宽）', function () {
  const tdRule = CSS.match(/#tbl td\{[^}]*\}/);
  assert.ok(tdRule, '应存在 #tbl td 规则');
  assert.ok(!/min-width/.test(tdRule[0]),
    '#tbl td 不应有 min-width（fixed 布局下会顶开列）：' + tdRule[0]);
});

test('CSS：表格用 table-layout:fixed + border-box 锁死列宽', function () {
  const tblRule = CSS.match(/#tbl\{[^}]*\}/);
  assert.ok(tblRule && /table-layout:fixed/.test(tblRule[0]), '表格应使用 table-layout:fixed');
  const cellRule = CSS.match(/#tbl th,#tbl td\{[^}]*\}/);
  assert.ok(cellRule && /box-sizing:border-box/.test(cellRule[0]),
    '单元格应设 border-box（否则 col 的 width 只是内容盒宽，会被 padding 撑开）');
});

test('表格列宽用 <col> 同时声明 width 和 max-width', function () {
  assert.ok(/max-width:'\s*\+\s*wpx\s*\+\s*'px"/.test(INDEX),
    'col 元素应同时设置 width 与 max-width');
});

/* ══════════════ 2. PDF 连页 ══════════════ */
console.log('== PDF 连页：导出与连续分页 ==');

test('shim 实现了 saveAsBinary（PDF 导出页/旋转另存依赖它）', function () {
  assert.ok(/saveAsBinary\s*:/.test(SHIM), 'shim 必须提供 saveAsBinary');
});

test('saveAsBinary 走 write_base64 命令并先弹保存对话框', function () {
  /* shim 里 saveAsBinary 是 cmds 对象的属性（不是 function 声明），
     所以不能走 extractFn，按属性块截取。 */
  const i = SHIM.indexOf('saveAsBinary:');
  assert.ok(i >= 0, '应存在 saveAsBinary 属性');
  const body = SHIM.slice(i, i + 700);
  assert.ok(/dialogSave/.test(body), '应先弹保存对话框');
  assert.ok(/write_base64/.test(body), '应调 write_base64 命令');
  assert.ok(/path:\s*p/.test(body), '应把选中的路径传给后端');
  assert.ok(/defaultPath/.test(body), '应给对话框设置默认文件名');
});

test('PDF 工具栏有「连排」按钮（连续分页浏览长文档）', function () {
  assert.ok(/data-pdf="continuous"/.test(INDEX), '应有连排按钮');
  assert.ok(/id="btnPdfCont"/.test(INDEX), '连排按钮应有 id 以便切换状态');
});

test('连排模式有实现函数，且用懒渲染避免长文档卡死', function () {
  const body = extractFn(INDEX, 'paintPdfContinuous');
  assert.ok(/IntersectionObserver/.test(body), '连排应懒渲染（否则上百页会卡死）');
});

test('连排与单页互斥：退出连排会清掉 cont 样式与观察者', function () {
  assert.ok(/classList\.remove\('cont'\)/.test(INDEX), '退出连排应移除 cont 样式');
  assert.ok(/__pdfContObserver/.test(INDEX), '应保存并释放观察者');
});

test('PDF 连排样式：页块纵向排列而非横排', function () {
  assert.ok(/\.pdf-scroll\.cont\{[^}]*display:block/.test(CSS),
    '连排时滚动容器应为块级流（否则多页会横着挤）');
});

test('导出页支持完整页范围（parsePageRange 处理 1-N 跨页）', function () {
  const pr = loadFns('renderer/index.html', ['parsePageRange']);
  assert.deepStrictEqual(pr.parsePageRange('1-5', 10), [1, 2, 3, 4, 5]);
  assert.deepStrictEqual(pr.parsePageRange('1,3-5', 10), [1, 3, 4, 5]);
  assert.deepStrictEqual(pr.parsePageRange('1-100', 10), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    '超出总页数的范围应被截断到有效页');
});

/* ══════════════ 3. 右上角按钮 ══════════════ */
console.log('== 右上角按钮：去掉系统窗口按钮 ==');

test('窗口关闭系统装饰（decorations:false）', function () {
  const w = CONF.app.windows[0];
  assert.strictEqual(w.decorations, false,
    '应关闭系统窗口按钮，改用应用内自绘的三个小按钮');
});

test('权限里补上了窗口控制所需的能力', function () {
  const p = CAPS.permissions;
  ['core:window:allow-minimize', 'core:window:allow-close',
   'core:window:allow-toggle-maximize', 'core:window:allow-start-dragging']
    .forEach(function (x) {
      assert.ok(p.indexOf(x) >= 0, '缺少权限 ' + x);
    });
});

test('core:window:default 不含 minimize/close —— 必须显式补', function () {
  /* 这是本问题的隐蔽之处：core:default → core:window:default 里
     并没有 allow-minimize / allow-close / allow-toggle-maximize，
     所以自绘按钮在 Tauri 下会静默失败。 */
  const manifest = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'src-tauri/gen/schemas/acl-manifests.json'), 'utf8'));
  const def = manifest['core:window'].default_permission.permissions;
  assert.ok(def.indexOf('allow-minimize') < 0, '前提变了：core:window:default 已含 allow-minimize');
  assert.ok(def.indexOf('allow-close') < 0, '前提变了：core:window:default 已含 allow-close');
  assert.ok(def.indexOf('allow-toggle-maximize') < 0,
    '前提变了：core:window:default 已含 allow-toggle-maximize');
});

test('标题栏保留自绘的三个小按钮且各自绑定了行为', function () {
  assert.ok(/id="wMin"/.test(INDEX) && /id="wMax"/.test(INDEX) && /id="wClose"/.test(INDEX),
    '应保留自绘的最小化/最大化/关闭三按钮');
  assert.ok(/wMin'\)\.addEventListener/.test(INDEX), 'wMin 应绑定点击事件');
  assert.ok(/wMax'\)\.addEventListener/.test(INDEX), 'wMax 应绑定点击事件');
  assert.ok(/wClose'\)\.addEventListener/.test(INDEX), 'wClose 应绑定点击事件');
});

test('标题栏有拖拽区（关掉系统装饰后要能自己拖窗口）', function () {
  assert.ok(/data-tauri-drag-region/.test(INDEX), '标题栏应有 data-tauri-drag-region');
});

/* ══════════════ 4. 刷新还原标签页 ══════════════ */
console.log('== 刷新还原标签页 ==');

test('会话记录的是标签描述数组（含顺序），不是纯 path 数组', function () {
  const body = extractFn(INDEX, 'rememberSession');
  assert.ok(/items/.test(body), '应记录 items 数组');
  assert.ok(/activeIdx/.test(body), '应记录激活标签的下标');
  assert.ok(!/tabs\.filter\(function\(t\)\{ return t\.path; \}\)/.test(body),
    '不应再只记录有 path 的标签（无 path 的新建标签会丢）');
});

test('会话记录保留无 path 的新建标签及其内容', function () {
  const body = extractFn(INDEX, 'rememberSession');
  assert.ok(/content/.test(body), '应记录空白标签的内容');
  assert.ok(/path:\s*t\.path\s*\|\|\s*null/.test(body), '应允许 path 为 null');
});

test('恢复时按原下标重建标签，顺序不会乱', function () {
  const body = extractFn(INDEX, 'restoreSession');
  assert.ok(/built\[/.test(body), '应按下标建标签');
  assert.ok(/activeIdx/.test(body), '应按下标恢复激活项');
});

test('恢复流程有守卫，不把中间态写进 localStorage', function () {
  assert.ok(/var restoring = false/.test(INDEX), '应有 restoring 守卫变量');
  const addTab = extractFn(INDEX, 'addTab');
  assert.ok(/if \(!restoring\)/.test(addTab), 'addTab 在恢复期间不应写会话');
});

test('恢复后仍记得住（新会话覆盖旧会话）', function () {
  const body = extractFn(INDEX, 'restoreSession');
  assert.ok(/rememberSession\(\)/.test(body), '恢复完成后应重新记录会话');
});

test('兼容旧格式的 localStorage（纯 path 数组）', function () {
  const body = extractFn(INDEX, 'restoreSession');
  assert.ok(/Array\.isArray\(raw\)/.test(body), '应兼容旧的数组格式');
});

console.log('');
if (fail) {
  console.log('结果：' + pass + ' 通过，' + fail + ' 失败');
  failures.forEach(function (f) { console.log('  失败：' + f); });
  process.exit(1);
} else {
  console.log('结果：' + pass + ' 通过，0 失败');
}
