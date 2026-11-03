#!/usr/bin/env node
/**
 * check-submission.mjs — M8：把考核 §8 的提交清单变成可执行检查。
 *   npm run check:submission
 *
 * 只做机械校验，**不读取** written-answers.md 的内容（§6 为候选人独立作答）。
 * 退出码 1 表示存在阻塞项。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const warnings = [];
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg) => { problems.push(msg); console.log(`  ✗ ${msg}`); };
const warn = (msg) => { warnings.push(msg); console.log(`  ! ${msg}`); };

const git = (args) => {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
};
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const sizeOf = (rel) => (exists(rel) ? fs.statSync(path.join(ROOT, rel)).size : 0);
const read = (rel) => (exists(rel) ? fs.readFileSync(path.join(ROOT, rel), 'utf8') : '');
const isTracked = (rel) => git(['ls-files', '--error-unmatch', rel]) !== '';

console.log('\n§8 提交清单校验');

// ---------------------------------------------------------------- 仓库
console.log('\n[仓库]');
const sha = git(['rev-parse', 'HEAD']);
if (sha) ok(`final commit SHA ${sha.slice(0, 7)} (${sha})`); else bad('不是一个 git 仓库');
const commits = git(['rev-list', '--count', 'HEAD']);
if (Number(commits) > 0) ok(`git 历史 ${commits} 个 commit`); else bad('没有 commit');
const porcelain = git(['status', '--porcelain']).split('\n').filter(Boolean);
const untracked = porcelain.filter((l) => l.startsWith('??'));
const modified = porcelain.filter((l) => !l.startsWith('??'));
if (modified.length === 0) ok('已跟踪文件无未提交改动');
else bad(`存在未提交改动：${modified.map((l) => l.slice(2).trim()).join(', ')}`);
if (untracked.length === 0) ok('无未跟踪文件');
else warn(`未跟踪文件（提交前需处理）：${untracked.map((l) => l.slice(2).trim()).join(', ')}`);
const remote = git(['remote', '-v']);
if (remote) ok('已配置 remote'); else warn('未配置 remote — §8 要求提交 Repository URL');
const hooksPath = git(['config', 'core.hooksPath']);
if (hooksPath === '.githooks') ok('证据同步 hook 已安装 (.githooks)'); else warn('git hooks 未安装，证据不会自动同步');

// ---------------------------------------------------------------- 必需文件
console.log('\n[必需文件]');
const required = {
  'README.md': 500,
  'AGENTS.md': 200,
  'written-answers.md': 200,
  'ai/session-index.csv': 50,
  'ai/decision-log.md': 200,
  'ai/completeness-declaration.md': 200,
};
for (const [file, minBytes] of Object.entries(required)) {
  const size = sizeOf(file);
  if (!exists(file)) bad(`${file} 缺失`);
  else if (size < minBytes) bad(`${file} 只有 ${size} 字节，疑似未完成`);
  else ok(`${file} (${size} bytes)`);
}
// §6：只看元数据，绝不读取内容
if (exists('written-answers.md')) {
  if (isTracked('written-answers.md')) ok('written-answers.md 已纳入 git（内容未由 AI 读取或修改）');
  else warn('written-answers.md 尚未 git add（§6 由候选人自行提交更合适）');
}

// ---------------------------------------------------------------- AI 证据
console.log('\n[AI 证据]');
const sessDir = path.join(ROOT, 'ai', 'sessions');
const sessFiles = fs.existsSync(sessDir) ? fs.readdirSync(sessDir).filter((f) => f.endsWith('.jsonl')) : [];
if (sessFiles.length === 0) bad('ai/sessions/ 为空');
else ok(`ai/sessions/ ${sessFiles.length} 个原生导出`);
let badSessions = 0;
for (const f of sessFiles) {
  const lines = read(path.join('ai', 'sessions', f)).split('\n').filter(Boolean);
  let valid = lines.length > 0;
  for (const l of lines) { try { JSON.parse(l); } catch { valid = false; break; } }
  if (!valid) { badSessions += 1; bad(`ai/sessions/${f} 不是合法 JSONL`); }
}
if (sessFiles.length && badSessions === 0) ok('全部会话文件为合法 JSONL');
// 抽查是否真的记录了工具调用与时间戳
const sample = sessFiles.length ? read(path.join('ai', 'sessions', sessFiles[0])) : '';
if (sample.includes('"tool/call"') && sample.includes('"time"')) ok('导出包含 tool/call 与时间戳');
else warn('导出中未检测到 tool/call 或时间戳');

const idx = read('ai/session-index.csv').split('\n').filter(Boolean);
const header = ['session_id', 'tool', 'model', 'started_at', 'ended_at', 'export_file', 'purpose', 'related_commits'];
if (idx.length === 0) bad('session-index.csv 为空');
else if (idx[0] !== header.join(',')) bad(`session-index.csv 表头不符：${idx[0]}`);
else ok('session-index.csv 表头正确');
const idxRows = idx.slice(1);
if (idxRows.length === sessFiles.length) ok(`session-index.csv ${idxRows.length} 行，与会话文件数一致`);
else bad(`session-index.csv ${idxRows.length} 行，但有 ${sessFiles.length} 个会话文件`);
const noCommitRows = [];
for (const row of idxRows) {
  const cols = row.match(/("([^"]|"")*"|[^,]*)/g).filter((_, i) => i % 2 === 0).map((c) => c.replace(/^"|"$/g, '').replace(/""/g, '"'));
  const exportFile = cols[5];
  if (exportFile && !exists(exportFile)) bad(`session-index.csv 指向不存在的文件：${exportFile}`);
  if (cols[7] === '-' || cols[7] === '') noCommitRows.push(cols[0]);
}

if (noCommitRows.length === idxRows.length && idxRows.length > 0) warn('所有会话都未关联 commit — 检查 git 历史与会话时间是否对得上');
else if (noCommitRows.length) console.log(`  · ${noCommitRows.length} 个纯规划会话无对应 commit（正常）`);

const decisionLog = read('ai/decision-log.md');
const groups = [
  ['采纳', /采纳的 AI 建议/],
  ['驳回', /驳回或纠正的 AI 输出/],
  ['权衡', /范围 \/ 设计权衡/],
];
for (const [label, re] of groups) {
  if (re.test(decisionLog)) ok(`decision-log 含「${label}」类`);
  else bad(`decision-log 缺少「${label}」类`);
}
const entries = (decisionLog.match(/^### D\d+/gm) ?? []).length;
if (entries >= 3) ok(`decision-log ${entries} 条决策（要求 ≥3）`); else bad(`decision-log 仅 ${entries} 条（要求 ≥3）`);
if (/session-(id|`)|session-f?[0-9a-f]{8}/.test(decisionLog)) ok('决策条目已关联 session id');
else warn('决策条目未关联 session id');

const completeness = read('ai/completeness-declaration.md');
if (/written-answers\.md/.test(completeness) && /未使用任何 AI|without AI/.test(completeness)) ok('completeness 已声明 §6 无 AI 协助');
else bad('completeness 未声明 §6 无 AI 协助');
if (/限制|limitation/i.test(completeness)) ok('completeness 已说明导出限制');
else warn('completeness 未说明导出限制');

// ---------------------------------------------------------------- README 内容
console.log('\n[README 覆盖 §8 要求]');
const readme = read('README.md');
const readmeChecks = [
  ['一条命令启动', /npm start/],
  ['actor header', /X-Actor-Email/],
  ['A1–A7 复现步骤', /A1[_\s—]|A1 —/],
  ['10 万行生成', /seed:100k/],
  ['已知缺陷', /Known defects/i],
  ['未完成项', /unfinished/i],
];
for (const [label, re] of readmeChecks) {
  if (re.test(readme)) ok(`README 覆盖「${label}」`);
  else bad(`README 缺少「${label}」`);
}
if (/A7/.test(readme)) ok('README 覆盖 A7'); else bad('README 缺少 A7');

// ---------------------------------------------------------------- 汇总
console.log(`\n${'─'.repeat(58)}`);
console.log(`阻塞项 ${problems.length} 个，提醒 ${warnings.length} 个`);
if (problems.length) {
  console.log('\n阻塞项：');
  for (const p of problems) console.log(`  ✗ ${p}`);
}
if (warnings.length) {
  console.log('\n提醒：');
  for (const w of warnings) console.log(`  ! ${w}`);
}
if (!problems.length) console.log(`\n✓ 可提交。final commit SHA: ${sha}`);
console.log('');
process.exitCode = problems.length ? 1 : 0;
