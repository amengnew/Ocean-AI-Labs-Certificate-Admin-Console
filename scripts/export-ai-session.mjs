#!/usr/bin/env node
/**
 * export-ai-session.mjs — DSH (DeepSeek Harness) 原生会话导出器，零依赖。
 *
 * 背景：DSH 把会话存在
 *   ~/.dsh/sessions/--<escaped-cwd>--/session-<uuid>/session.v4.jsonl.zstd
 * 该文件是「多帧 zstd」拼接（每次 append 一帧），因此
 *   - zlib.zstdDecompressSync() 只能解出第一帧
 *   - zlib.createZstdDecompress() 流式解到第二帧会报 ZSTD_error_prefix_unknown
 * 本脚本按 zstd magic 逐帧切片解压，拼回完整 JSONL。
 *
 * 产出（对应考核 §5 Evidence）：
 *   ai/sessions/<session-id>.jsonl     原样 JSONL（prompt / assistant 全文 / tool call / 结果 / 毫秒时间戳 / model）
 *   ai/session-index.csv               一行一会话
 *
 * 用法：
 *   node scripts/export-ai-session.mjs                 # 导出当前工作目录的全部会话
 *   node scripts/export-ai-session.mjs --out /tmp/x    # 导出到别处（试跑用）
 *   node scripts/export-ai-session.mjs --all           # 导出与 cwd 无关的全部会话
 *
 * 可选：ai/session-annotations.json 手工补 purpose / related_commits，形如
 *   { "session-<uuid>": { "purpose": "规划与里程碑对齐", "related_commits": "a1b2c3d" } }
 * 未标注时 purpose 取会话标题，related_commits 填 "(unspecified)" —— 提交前人工补齐。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(n); return i === -1 ? d : (argv[i + 1] ?? true); };

const CWD = process.cwd();
const OUT_DIR = path.resolve(flag('--out', path.join(CWD, 'ai', 'sessions')));
const INDEX_PATH = path.resolve(flag('--index', path.join(CWD, 'ai', 'session-index.csv')));
const INDEX_ONLY_IF_OUT_INSIDE = !argv.includes('--out');
const ALL = argv.includes('--all');
const SESS_ROOT = path.join(process.env.HOME ?? process.env.USERPROFILE ?? '.', '.dsh', 'sessions');

/** 逐帧解压多帧 zstd 文件。 */
function decompressMultiFrame(buf) {
  const offsets = [];
  let i = -1;
  while ((i = buf.indexOf(ZSTD_MAGIC, i + 1)) !== -1) offsets.push(i);
  if (offsets.length === 0) throw new Error('no zstd frame found');
  offsets.push(buf.length);
  const parts = [];
  let failures = 0;
  for (let k = 0; k < offsets.length - 1; k++) {
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(offsets[k], offsets[k + 1]))); }
    catch { failures++; } // 极少数情况：magic 恰好出现在压缩数据体内，跳过即可
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames: offsets.length - 1, failures };
}

const toCst = (ms) => {
  // 固定用 Asia/Shanghai(+08:00) 保证 session-index.csv 时区一致
  const d = new Date(ms);
  const p = (n, l = 2) => String(n).padStart(l, '0');
  const t = new Date(d.getTime() + 8 * 3600_000);
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}T${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}+08:00`;
};

function collectSessions() {
  if (!fs.existsSync(SESS_ROOT)) throw new Error(`session root not found: ${SESS_ROOT}`);
  const found = [];
  for (const ws of fs.readdirSync(SESS_ROOT, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue;
    const wsPath = path.join(SESS_ROOT, ws.name);
    for (const s of fs.readdirSync(wsPath, { withFileTypes: true })) {
      if (!s.isDirectory()) continue;
      const file = path.join(wsPath, s.name, 'session.v4.jsonl.zstd');
      if (!fs.existsSync(file)) continue;
      found.push({ file, dir: s.name });
    }
  }
  return found;
}

function summarize(records, sessionDir) {
  const head = records.find((r) => r.type === 'session');
  const hdr = records.find((r) => r.type === 'request/header');
  const cfg = hdr?.data?.header?.config ?? {};
  const titles = records.filter((r) => r.type === 'session/title').map((r) => r.data?.title).filter(Boolean);
  const times = records.map((r) => r.time).filter((t) => Number.isFinite(t));
  return {
    session_id: head?.id ?? sessionDir,
    tool: 'DeepSeek Harness (DSH)',
    model: cfg.model ?? 'unknown',
    provider: cfg.provider ?? 'unknown',
    started_at: toCst(times.length ? Math.min(...times) : head?.createdAt ?? Date.now()),
    ended_at: toCst(times.length ? Math.max(...times) : head?.createdAt ?? Date.now()),
    cwd: head?.cwd ?? 'unknown',
    prompts: records.filter((r) => r.type === 'user/message').length,
    tool_calls: records.filter((r) => r.type === 'tool/call').length,
    title: titles.at(-1) ?? '(untitled)',
  };
}

function main() {
  const annotationsPath = path.join(CWD, 'ai', 'session-annotations.json');
  const annotations = fs.existsSync(annotationsPath)
    ? JSON.parse(fs.readFileSync(annotationsPath, 'utf8')) : {};

  const sessions = collectSessions();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(INDEX_PATH), { recursive: true });

  const rows = [];
  for (const s of sessions) {
    const raw = fs.readFileSync(s.file);
    const { text, frames, failures } = decompressMultiFrame(raw);
    const lines = text.split('\n').filter((l) => l.trim());
    if (lines.length === 0) continue;

    let records;
    try { records = lines.map((l) => JSON.parse(l)); }
    catch (e) { console.error(`SKIP ${s.dir}: bad jsonl (${e.message})`); continue; }

    const meta = summarize(records, s.dir);
    if (!ALL && meta.cwd !== CWD) continue; // 默认只导当前工作目录的会话

    const outFile = path.join(OUT_DIR, `${meta.session_id}.jsonl`);
    fs.writeFileSync(outFile, text.endsWith('\n') ? text : text + '\n');
    const relCandidate = path.relative(CWD, outFile);
    const rel = relCandidate.startsWith('..') ? outFile : relCandidate; // 仓外路径写绝对路径，避免 ../.. 污染索引
    const note = annotations[meta.session_id] ?? {};
    rows.push({
      session_id: meta.session_id,
      tool: meta.tool,
      model: meta.model,
      started_at: meta.started_at,
      ended_at: meta.ended_at,
      export_file: rel,
      purpose: note.purpose ?? meta.title,
      related_commits: note.related_commits ?? '(unspecified)',
    });
    console.log(`✓ ${rel}  frames=${frames} fail=${failures} records=${records.length} ` +
      `prompts=${meta.prompts} tool_calls=${meta.tool_calls} model=${meta.model}`);
  }

  if (rows.length === 0) { console.error('no sessions matched; use --all'); process.exit(1); }
  rows.sort((a, b) => a.started_at.localeCompare(b.started_at));

  const cols = ['session_id', 'tool', 'model', 'started_at', 'ended_at', 'export_file', 'purpose', 'related_commits'];
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';

  if (INDEX_ONLY_IF_OUT_INSIDE) {
    fs.writeFileSync(INDEX_PATH, csv);
    console.log(`✓ ${path.relative(CWD, INDEX_PATH)} (${rows.length} rows)`);
  } else {
    console.log(`(dry-run: index not written) rows=${rows.length}`);
    console.log(csv);
  }
}

main();
