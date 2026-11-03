#!/usr/bin/env node
/** setup-hooks.mjs — 把 .githooks 设为 git hooks 目录（postinstall 自动调用）。 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hook = path.join(ROOT, '.githooks', 'pre-commit');

if (!fs.existsSync(hook)) { console.log('no .githooks/pre-commit, skipped'); process.exit(0); }
try { fs.chmodSync(hook, 0o755); } catch { /* ignore */ }

const r = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: ROOT });
if (r.status === 0) console.log('✓ git hooks installed → .githooks (AI evidence auto-sync on commit)');
else console.log('(not a git repository yet — run `npm run setup:hooks` after git init)');
