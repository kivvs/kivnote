#!/usr/bin/env node
/**
 * 提取 renderer/index.html 里的内联脚本并做语法检查。
 * 用法：node scripts/check-syntax.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const target = path.join(__dirname, '..', 'renderer', 'index.html');
if (!fs.existsSync(target)) {
  console.error('找不到 renderer/index.html');
  process.exit(1);
}

const html = fs.readFileSync(target, 'utf8');
const re = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g;

const tmp = path.join(os.tmpdir(), 'kivnote-syntax');
fs.mkdirSync(tmp, { recursive: true });

let idx = 0;
let failed = 0;
let m;

while ((m = re.exec(html)) !== null) {
  const code = m[1];
  if (!code || !code.trim()) continue;
  const file = path.join(tmp, 'block' + idx + '.js');
  fs.writeFileSync(file, code, 'utf8');
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status === 0) {
    console.log('OK   inline script #' + idx);
  } else {
    console.error('FAIL inline script #' + idx);
    console.error((r.stderr || '').slice(0, 600));
    failed++;
  }
  idx++;
}

if (idx === 0) {
  console.error('没有找到内联脚本，检查失败');
  process.exit(1);
}

console.log(failed ? '\n' + failed + ' 个脚本有语法错误' : '\n全部通过（' + idx + ' 个）');
process.exit(failed ? 1 : 0);
