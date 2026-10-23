#!/usr/bin/env node
/**
 * 表格列宽自检驱动
 *
 * 用 Tauri 版（真实 WebView2）打开一张「列内容长度差异极大」的测试表，
 * 滚到底部再量一次列宽，验证「表格不会越滚越宽」。
 *
 * 为什么必须用真实渲染引擎：这个 bug 是 CSS 布局引擎的行为
 * （table-layout:fixed 下单元格 min-width / 内容盒宽度 的交互），
 * 纯逻辑单测模拟不出来。
 *
 * 用法：node tests/run-table-selftest.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'src-tauri/target/debug/kivnote-tauri.exe');
const SCRIPT = path.join(ROOT, 'tests/selftest-table.js');
const XLSX = path.join(ROOT, 'testfiles/widthtest.xlsx');

/* 1. 生成测试表：列内容长度差异极大，第 60 行和第 150 行各有超长文本 */
function makeXlsx() {
  const XLSXLib = require('xlsx');
  const rows = [['列一', '列二', '列三']];
  for (let i = 0; i < 200; i++) {
    rows.push([
      i === 60 ? '这是一段非常非常长的中文内容用来测试列宽是否会被顶开' : '短',
      'x',
      i === 150 ? 'AnotherVeryLongEnglishContentThatShouldNotExpandTheColumn' : 'y'
    ]);
  }
  const ws = XLSXLib.utils.aoa_to_sheet(rows);
  const wb = XLSXLib.utils.book_new();
  XLSXLib.utils.book_append_sheet(wb, ws, '测试');
  XLSXLib.writeFile(wb, XLSX);
  console.log('生成测试表: ' + XLSX + ' (' + fs.statSync(XLSX).size + ' bytes)');
}

/* 2. 把测试文件路径填进脚本 */
function prepareScript() {
  const tmp = path.join(os.tmpdir(), 'kivnote-selftest-table.js');
  const src = fs.readFileSync(SCRIPT, 'utf8').replace('__TEST_FILE__', XLSX.replace(/\\/g, '/'));
  fs.writeFileSync(tmp, src, 'utf8');
  return tmp;
}

/* 3. 跑自检 */
function runSelftest() {
  if (!fs.existsSync(EXE)) {
    console.error('找不到可执行文件: ' + EXE + '\n请先 cargo build');
    process.exit(2);
  }
  const script = prepareScript();
  const outFile = path.join(os.tmpdir(), 'kivnote-selftest-out.json');
  try { fs.unlinkSync(outFile); } catch (e) {}

  const r = spawnSync(EXE, ['--selftest', script, outFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000
  });
  if (r.stderr && r.stderr.length) {
    const s = r.stderr.toString().trim();
    if (s) console.log('  (stderr) ' + s.split('\n').slice(0, 3).join(' | '));
  }
  if (!fs.existsSync(outFile)) {
    console.error('自检没有产出结果（退出码 ' + r.status + '）');
    process.exit(3);
  }
  return JSON.parse(fs.readFileSync(outFile, 'utf8'));
}

makeXlsx();
console.log('');
console.log('== 表格列宽：真实 WebView2 实测 ==');

const r = runSelftest();
console.log('  env: ' + JSON.stringify(r.env || {}));
  console.log('  checks: ' + JSON.stringify(r.checks || []));
  console.log('  声明列宽: ' + JSON.stringify(r.declared || []));
console.log('  宽度分布: ' + JSON.stringify(r.widthHistogram || {}));
console.log('  滚动前:   ' + JSON.stringify((r.beforeScroll || {}).widths || {}));
console.log('  滚动后:   ' + JSON.stringify((r.afterScroll || {}).widths || {}));
console.log('  表格总宽: ' + r.tableWidthBefore + ' → ' + r.tableWidthAfter);
console.log('');

let fail = 0;
(r.checks || []).forEach(function (c) {
  if (c.pass) console.log('  ✓ ' + c.name);
  else { fail++; console.log('  ✗ ' + c.name + '  ← ' + c.detail); }
});

console.log('');
console.log(fail ? ('结果：' + (r.checks.length - fail) + ' 通过，' + fail + ' 失败')
                  : ('结果：' + r.checks.length + ' 通过，0 失败'));
process.exit(fail ? 1 : 0);
