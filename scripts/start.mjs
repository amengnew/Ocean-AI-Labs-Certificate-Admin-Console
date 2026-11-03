#!/usr/bin/env node
/**
 * start.mjs — B1 一条命令启动：
 *   ① 装依赖（如缺） ② 构建前端（如缺 dist） ③ 初始化 demo 数据（幂等） ④ 起服务
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

const DB_PATH = process.env.DB_PATH ?? path.join('data', 'app.db');
const DIST = path.join('web', 'dist', 'index.html');

function run(cmd, args, label) {
  console.log(`\n▸ ${label}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT });
  if (r.error) { console.error(`✗ ${label}: ${r.error.message}`); process.exit(1); }
  if (r.status !== 0) { console.error(`✗ ${label} failed (exit ${r.status})`); process.exit(r.status ?? 1); }
}

if (!fs.existsSync('node_modules')) {
  // 有 lockfile 时用 npm ci：可复现，且不会像 npm install 那样因 postinstall 补 hasInstallScript 而弄脏工作树
  const args = fs.existsSync('package-lock.json')
    ? ['ci', '--no-audit', '--no-fund']
    : ['install', '--no-audit', '--no-fund'];
  run('npm', args, '① 安装依赖');
}
run('node', ['scripts/setup-hooks.mjs'], '① 安装 git hooks（证据自动同步）');
if (!fs.existsSync(DIST)) run('npm', ['run', 'build:web'], '② 构建前端');
// seedDatabase 本身幂等（已有 tenant 就直接返回），所以每次都跑：
// 只在库文件不存在时 seed 会漏掉『库在但为空』的情况，导致全站 401。
run('node', ['server/seed.mjs'], '③ 初始化 demo 数据');

console.log('\n▸ ④ 启动服务\n');
run(process.execPath, ['server/index.mjs'], '④ 启动服务');
