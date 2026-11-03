#!/usr/bin/env node
/**
 * ai-evidence.mjs — E1–E6：AI 证据全自动生成，零人工。
 *
 * 输入：~/.dsh/sessions/<workspace>/session-<uuid>/session.v4.jsonl.zstd（多帧 zstd）
 * 输出：ai/sessions/<id>.jsonl       原生 JSONL（prompt/回复全文/tool call/result/毫秒时间戳/model）
 *       ai/session-index.csv         §5 索引（purpose 取会话标题，related_commits 按时间窗匹配 git log）
 *       ai/decision-log.md           ← ai/decisions.jsonl 渲染
 *       ai/completeness-declaration.md
 *
 * 用法：
 *   node scripts/ai-evidence.mjs            # 生成，不 git add
 *   node scripts/ai-evidence.mjs --stage    # 生成并 git add ai/（pre-commit hook 用）
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AI_DIR = path.join(ROOT, 'ai');
const SESS_OUT = path.join(AI_DIR, 'sessions');
const CWD = ROOT;
const STAGE = process.argv.includes('--stage');
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const SESS_ROOT = path.join(process.env.HOME ?? '.', '.dsh', 'sessions');

const toCst = (ms) => {
  const t = new Date(new Date(ms).getTime() + 8 * 3_600_000);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}T${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}+08:00`;
};
const toIso = (ms) => new Date(ms).toISOString();

/** 多帧 zstd：zstdDecompressSync 只解第一帧，流式解到第二帧会报 prefix_unknown，故按 magic 逐帧切片。 */
function decompressMultiFrame(buf) {
  const offs = [];
  let i = -1;
  while ((i = buf.indexOf(ZSTD_MAGIC, i + 1)) !== -1) offs.push(i);
  if (!offs.length) throw new Error('no zstd frame');
  offs.push(buf.length);
  const parts = [];
  let failures = 0;
  for (let k = 0; k < offs.length - 1; k += 1) {
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(offs[k], offs[k + 1]))); }
    catch { failures += 1; } // 末尾可能是写到一半的帧，跳过
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames: offs.length - 1, failures };
}

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

function commitsBetween(startMs, endMs) {
  const out = git(['log', '--all', '--format=%h', `--since=${toIso(startMs)}`, `--until=${toIso(endMs + 1000)}`]);
  return out ? out.split('\n').filter(Boolean).join(', ') : '-';
}

function collectSessions() {
  if (!fs.existsSync(SESS_ROOT)) return [];
  const found = [];
  for (const ws of fs.readdirSync(SESS_ROOT, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue;
    const wsPath = path.join(SESS_ROOT, ws.name);
    for (const s of fs.readdirSync(wsPath, { withFileTypes: true })) {
      const file = path.join(wsPath, s.name, 'session.v4.jsonl.zstd');
      if (s.isDirectory() && fs.existsSync(file)) found.push({ file, dir: s.name });
    }
  }
  return found;
}

// ---------------------------------------------------------------- E1 / E2
function exportSessions() {
  fs.mkdirSync(SESS_OUT, { recursive: true });
  const rows = [];
  for (const s of collectSessions()) {
    const { text, frames, failures } = decompressMultiFrame(fs.readFileSync(s.file));
    const lines = text.split('\n').filter((l) => l.trim());
    if (!lines.length) continue;
    let recs;
    try { recs = lines.map((l) => JSON.parse(l)); } catch { continue; }

    const head = recs.find((r) => r.type === 'session');
    if (head?.cwd !== CWD) continue; // 只导本工作区

    const cfg = recs.find((r) => r.type === 'request/header')?.data?.header?.config ?? {};
    const times = recs.map((r) => r.time).filter(Number.isFinite);
    const startMs = times.length ? Math.min(...times) : (head?.createdAt ?? Date.now());
    const endMs = times.length ? Math.max(...times) : startMs;
    const title = recs.filter((r) => r.type === 'session/title').map((r) => r.data?.title).filter(Boolean).at(-1);

    const id = head?.id ?? s.dir;
    fs.writeFileSync(path.join(SESS_OUT, `${id}.jsonl`), text.endsWith('\n') ? text : `${text}\n`);

    rows.push({
      session_id: id,
      tool: 'DeepSeek Harness (DSH)',
      model: cfg.model ?? 'unknown',
      started_at: toCst(startMs),
      ended_at: toCst(endMs),
      export_file: path.relative(ROOT, path.join(SESS_OUT, `${id}.jsonl`)),
      purpose: title ?? '(untitled)',
      related_commits: commitsBetween(startMs, endMs),
      _frames: frames,
      _failures: failures,
      _records: recs.length,
      _prompts: recs.filter((r) => r.type === 'user/message').length,
      _toolCalls: recs.filter((r) => r.type === 'tool/call').length,
      _startMs: startMs,
      _endMs: endMs,
    });
  }
  rows.sort((a, b) => a._startMs - b._startMs);

  if (rows.length === 0) {
    // 例如在 git worktree 中执行：本目录没有会话记录，直接保留既有证据，不清空
    console.warn('⚠ 本工作目录未匹配到 AI 会话；保留既有 ai/ 证据不覆盖');
    return null;
  }

  const cols = ['session_id', 'tool', 'model', 'started_at', 'ended_at', 'export_file', 'purpose', 'related_commits'];
  const esc = (v) => { const x = String(v ?? ''); return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
  fs.writeFileSync(path.join(AI_DIR, 'session-index.csv'), csv);
  return rows;
}

// ---------------------------------------------------------------- E3
function renderDecisionLog() {
  const p = path.join(AI_DIR, 'decisions.jsonl');
  const entries = fs.existsSync(p)
    ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const label = { accepted: '采纳的 AI 建议', rejected: '驳回或纠正的 AI 输出', tradeoff: '范围 / 设计权衡' };
  const lines = [
    '# AI Decision Log',
    '',
    '> 本文件由 `scripts/ai-evidence.mjs` 从 `ai/decisions.jsonl` 自动渲染，请勿手工编辑。',
    '',
    `共 ${entries.length} 条：` + Object.keys(label).map((k) => `${label[k]} ${entries.filter((e) => e.type === k).length}`).join(' / '),
    '',
  ];
  for (const type of ['accepted', 'rejected', 'tradeoff']) {
    const group = entries.filter((e) => e.type === type);
    lines.push(`## ${label[type]}`, '');
    if (!group.length) { lines.push('_（无）_', ''); continue; }
    for (const e of group) {
      lines.push(`### ${e.id} — ${e.title}`, '');
      lines.push(`- **决策**：${e.decision}`);
      if (e.context) lines.push(`- **背景**：${e.context}`);
      lines.push(`- **Session**：\`${e.session_id ?? 'see session-index.csv'}\``);
      if (e.evidence) lines.push(`- **验证证据**：${e.evidence}`);
      if (e.commit) lines.push(`- **Commit**：\`${e.commit}\``);
      lines.push('');
    }
  }
  fs.writeFileSync(path.join(AI_DIR, 'decision-log.md'), lines.join('\n'));
  const missing = ['accepted', 'rejected', 'tradeoff'].filter((t) => !entries.some((e) => e.type === t));
  if (missing.length) console.warn(`⚠ decision-log 缺少类型: ${missing.join(', ')}`);
}

// ---------------------------------------------------------------- E4
function renderCompleteness(rows) {
  const models = [...new Set(rows.map((r) => r.model))];
  const body = [
    '# Completeness Declaration — AI interaction evidence',
    '',
    '> 由 `scripts/ai-evidence.mjs` 自动生成。',
    '',
    '## 使用的 AI 工具',
    '',
    '| 工具 | 模型 | 导出方式 | 会话数 |',
    '|---|---|---|---|',
    `| DeepSeek Harness (DSH) | ${models.join(', ') || 'n/a'} | 原生 JSONL（\`ai/sessions/\`） | ${rows.length} |`,
    '',
    '## 导出限制',
    '',
    '- DSH 会话文件为多帧 zstd；脚本按帧重组，末尾写到一半的帧会被跳过，因此最后一次导出的最后几秒可能缺失。',
    '- 若使用了编辑器内联补全（inline autocomplete），该工具不产生可导出会话，属于已知不可导出项，此处如实披露。',
    '- `ai/session-index.csv` 的 `purpose` 取自会话标题，`related_commits` 按会话时间窗自动匹配 `git log`。',
    '',
    '## 声明',
    '',
    '- 以上会话覆盖规划、实现、验证、文档全过程的 AI 交互，包含被驳回的 AI 建议与失败运行。',
    '- 考核 §6 `written-answers.md` 为候选人独立完成，**未使用任何 AI 协助**（无起草、翻译、润色、校对）。',
    '',
    `_generated_at: ${toCst(Date.now())}_`,
    '',
  ];
  fs.writeFileSync(path.join(AI_DIR, 'completeness-declaration.md'), body.join('\n'));
}

// ---------------------------------------------------------------- E6
const HIGH_RISK = [
  { re: /sk-[A-Za-z0-9]{20,}/g, what: 'OpenAI-style secret key' },
  { re: /AKIA[0-9A-Z]{16}/g, what: 'AWS access key id' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, what: 'private key block' },
  { re: /ghp_[A-Za-z0-9]{30,}/g, what: 'GitHub token' },
];

function secretScan(rows) {
  const hits = [];
  for (const r of rows) {
    const file = path.join(ROOT, r.export_file);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const { re, what } of HIGH_RISK) {
      const m = text.match(re);
      if (m) hits.push(`${r.export_file}: ${what} × ${m.length}`);
    }
  }
  return hits;
}

// ---------------------------------------------------------------- main
function main() {
  fs.mkdirSync(AI_DIR, { recursive: true });
  const rows = exportSessions();
  if (rows === null) return;
  for (const r of rows) {
    console.log(`✓ E1 ${r.export_file}  frames=${r._frames} fail=${r._failures} records=${r._records} prompts=${r._prompts} tools=${r._toolCalls} model=${r.model}`);
  }
  console.log(`✓ E2 ai/session-index.csv (${rows.length} rows)`);
  renderDecisionLog();
  console.log('✓ E3 ai/decision-log.md');
  renderCompleteness(rows);
  console.log('✓ E4 ai/completeness-declaration.md');

  const hits = secretScan(rows);
  if (hits.length) {
    console.error('\n✗ E6 检测到疑似凭据，提交已中断：');
    for (const h of hits) console.error(`   ${h}`);
    console.error('  请用 [REDACTED: reason] 做最小替换后重试。');
    process.exit(1);
  }
  console.log('✓ E6 凭据扫描通过');

  if (STAGE) {
    const r = spawnSync('git', ['add', '-A', 'ai'], { cwd: ROOT });
    console.log(r.status === 0 ? '✓ E5 git add ai/' : '⚠ git add ai/ skipped');
  }
}

main();
