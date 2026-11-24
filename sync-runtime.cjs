#!/usr/bin/env node
'use strict';

/**
 * 共享运行时文件的同步与校验。
 *
 *   node sync-runtime.cjs --check            校验本仓库文件与 runtime-parity.json 一致
 *   node sync-runtime.cjs --write <srcDir>   从另一个 preset 目录复制共享文件并重写清单
 *
 * 两个 preset 各自带一份完全相同的运行时（不引入第三方包），靠哈希清单 +
 * 这个脚本保证不会单边走偏。--check 不写任何文件，可直接放进 CI 或发布前检查。
 */

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const SHARED = [
  'loop-guard.cjs',
  'memory.cjs',
  'state-bus.cjs',
  'ledger.cjs',
  'loop-guard.test.cjs',
  'memory.test.cjs',
  'parity.test.cjs',
];

const ROOT = __dirname;
const MANIFEST = path.join(ROOT, 'runtime-parity.json');

const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

function check() {
  if (!fs.existsSync(MANIFEST)) {
    console.error('缺少 runtime-parity.json；先运行 --write <另一个 preset 目录>');
    return 1;
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  let bad = 0;
  for (const file of SHARED) {
    const target = path.join(ROOT, file);
    if (!fs.existsSync(target)) {
      console.error('  [缺失] ' + file);
      bad += 1;
      continue;
    }
    const actual = sha(target);
    const expected = manifest.files?.[file];
    if (actual !== expected) {
      console.error('  [不一致] ' + file + '：清单 ' + String(expected).slice(0, 12) + ' / 实际 ' + actual.slice(0, 12));
      bad += 1;
    } else {
      console.log('  [OK] ' + file);
    }
  }
  if (manifest.version !== readVersion()) {
    console.error('  清单版本 ' + manifest.version + ' 与 package.json ' + readVersion() + ' 不一致');
    bad += 1;
  }
  if (bad > 0) {
    console.error('共享文件校验失败 ' + bad + ' 项；用 --write 从另一仓库同步，或确认这是有意修改并同步更新两边。');
    return 1;
  }
  console.log('共享文件一致（' + SHARED.length + ' 个）。');
  return 0;
}

function write(sourceDir) {
  if (!sourceDir) {
    console.error('--write 需要一个源目录，例如：node sync-runtime.cjs --write ../dsh-deliberate-preset');
    return 2;
  }
  const from = path.resolve(sourceDir);
  if (!fs.existsSync(from)) {
    console.error('源目录不存在：' + from);
    return 2;
  }
  const files = {};
  for (const file of SHARED) {
    const source = path.join(from, file);
    if (!fs.existsSync(source)) {
      console.error('源目录缺少 ' + file);
      return 2;
    }
    fs.copyFileSync(source, path.join(ROOT, file));
    files[file] = sha(path.join(ROOT, file));
    console.log('  已同步 ' + file);
  }
  fs.writeFileSync(MANIFEST, JSON.stringify({ version: readVersion(), files }, null, 2) + '\n', 'utf8');
  console.log('已写入 runtime-parity.json（' + SHARED.length + ' 个文件）。');
  return 0;
}

const args = process.argv.slice(2);
if (args[0] === '--check') process.exitCode = check();
else if (args[0] === '--write') process.exitCode = write(args[1]);
else {
  console.log('用法：node sync-runtime.cjs --check | --write <srcDir>');
  process.exitCode = 2;
}
