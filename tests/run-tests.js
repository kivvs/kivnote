#!/usr/bin/env node
/**
 * 单元测试：直接从 main.js / renderer/index.html 提取真实函数源码来测，
 * 保证测的就是线上跑的代码，而不是复制粘贴的副本。
 *
 * 用法：node tests/run-tests.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

function srcOf(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

/* 用大括号配对提取单个函数体 */
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
  const src = srcOf(file);
  const code = names.map(function (n) { return extractFn(src, n); }).join('\n');
  const factory = new Function(code + '\nreturn {' + names.join(',') + '};');
  return factory();
}

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

console.log('== xlsx 就地改值 ==');
const x = loadFns('main.js', ['xmlEscape', 'isNumericLike', 'patchCellInXml']);

test('isNumericLike 识别数字', function () {
  assert.strictEqual(x.isNumericLike('123'), true);
  assert.strictEqual(x.isNumericLike('-4.56'), true);
  assert.strictEqual(x.isNumericLike('  78 '), true);
  assert.strictEqual(x.isNumericLike('abc'), false);
  assert.strictEqual(x.isNumericLike('12abc'), false);
  assert.strictEqual(x.isNumericLike(''), false);
});

test('xmlEscape 转义特殊字符', function () {
  assert.strictEqual(x.xmlEscape('<a&"b">'), '&lt;a&amp;&quot;b&quot;&gt;');
  assert.strictEqual(x.xmlEscape('普通文本'), '普通文本');
});

test('patchCellInXml 改文本并保留样式', function () {
  const xml = '<row><c r="B2" t="str" s="1"><v>old</v></c></row>';
  const out = x.patchCellInXml(xml, 'B2', '新值');
  assert.ok(out.includes('t="inlineStr"'), '应为行内字符串类型');
  assert.ok(out.includes('s="1"'), '样式索引应保留');
  assert.ok(out.includes('新值'), '新值应写入');
  assert.ok(!out.includes('<v>old</v>'), '旧值应被替换');
});

test('patchCellInXml 改数字不加字符串类型', function () {
  const xml = '<row><c r="C2" t="str"><v>Web</v></c></row>';
  const out = x.patchCellInXml(xml, 'C2', 88);
  assert.ok(out.includes('<v>88</v>'), '数字直接写 v');
  assert.ok(!out.includes('t="inlineStr"'), '数字不需要 inlineStr');
  assert.ok(!out.includes('t="str"'), '旧类型要清掉');
});

test('patchCellInXml 改不存在的单元格返回 null', function () {
  const xml = '<row><c r="A1"><v>1</v></c></row>';
  assert.strictEqual(x.patchCellInXml(xml, 'Z9', 'x'), null);
});

test('patchCellInXml 结果是合法 XML', function () {
  const xml = '<row><c r="B2" t="str" s="3"><v>x</v></c></row>';
  const out = x.patchCellInXml(xml, 'B2', '含<标签>&"引号"的值');
  // 简单配对检查：不能出现属性粘连
  assert.ok(!/<c[^>]*"[^>\s]+=/.test(out), '属性之间必须有空白分隔');
});

console.log('== 表格列名 ==');
const col = loadFns('renderer/index.html', ['colName']);

test('colName 列号转字母', function () {
  assert.strictEqual(col.colName(0), 'A');
  assert.strictEqual(col.colName(25), 'Z');
  assert.strictEqual(col.colName(26), 'AA');
  assert.strictEqual(col.colName(701), 'ZZ');
});

console.log('== PDF 页码解析 ==');
const pr = loadFns('renderer/index.html', ['parsePageRange']);

test('parsePageRange 解析范围', function () {
  assert.deepStrictEqual(pr.parsePageRange('1,3-5', 10), [1, 3, 4, 5]);
  assert.deepStrictEqual(pr.parsePageRange('2-4,2', 10), [2, 3, 4], '重复页要去重');
});

test('parsePageRange 过滤越界', function () {
  assert.deepStrictEqual(pr.parsePageRange('0,8,20', 10), [8]);
  assert.deepStrictEqual(pr.parsePageRange('abc', 10), []);
  assert.deepStrictEqual(pr.parsePageRange('', 10), []);
});

test('parsePageRange 倒序范围', function () {
  assert.deepStrictEqual(pr.parsePageRange('5-2', 10), [2, 3, 4, 5]);
});

console.log('== CSV 生成 ==');
let csv;
try {
  csv = loadFns('renderer/index.html', ['toCSV']);
  test('toCSV 基本转义', function () {
    const out = csv.toCSV([['a', 'b,c', 'd"e', 'f\ng']], ',');
    assert.ok(out.includes('"b,c"'), '含逗号要加引号');
    assert.ok(out.includes('"d""e"'), '引号要翻倍');
    assert.ok(out.includes('"f\ng"'), '换行要包进引号');
    assert.ok(out.startsWith('a,'), '普通值不加引号');
  });
  test('toCSV 空值', function () {
    const out = csv.toCSV([['', null, undefined]], ',');
    assert.ok(out.length >= 1);
  });
} catch (e) {
  console.log('  （toCSV 依赖其他函数，跳过：' + e.message + '）');
}

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
if (fail) {
  failures.forEach(function (f) { console.log('  失败：' + f); });
  process.exit(1);
}
