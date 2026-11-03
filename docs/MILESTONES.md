# 里程碑与功能点（60 分钟）

> Ocean AI Labs — Certificate Admin Console。1 小时单次会话，空仓起。
> 原则：核心行为正确 > 视觉打磨；只做 §3 四个工作流，不做超范围功能。

## 0. 一句话策略

后端用唯一索引 + 条件更新，把 A1–A7 做成**结构性正确**；前端只做 5 个交互；
证据链由 **git hook 自动同步**，全程零人工整理。

---

## 1. 编号规则

| 前缀 | 含义 | 说明 |
|---|---|---|
| **B** | 基础能力 | 被 A 依赖的地基（启动、actor、数据、索引、生成器、验证） |
| **A** | 验收行为 | 对应 PDF §4 的 A1–A7，拆成可独立验证的子项 |
| **U** | 前端交互 | UI 层，只做 §3 要求的 |
| **E** | 证据自动化 | `ai/` 三件套 + completeness，全部脚本生成 |

---

## 2. 功能点总表

### B 系列 — 基础能力

| 编号 | 功能点 | 作用（为什么必须有） |
|---|---|---|
| **B1** | 一条命令启动 `npm start`：装依赖 → 建库 → 塞 demo 数据 → 起服务 | §2 硬约束。评委拿到仓库能直接跑起来，不依赖口头说明 |
| **B2** | actor 上下文：`X-Actor-Email` → admin/tenant/timezone；未知 actor → 401 | 无登录 UI 时确定租户边界，是 A1 的地基 |
| **B3** | demo 数据：East/Sydney、West/Perth、双租户同名 Safety 101 与 Alex Lee、三种 enrollment 状态 | §4 强制要求；同时为 A4/A5 提供可复现场景 |
| **B4** | 表结构 + 唯一索引（证书唯一、审计唯一、幂等主键） | 把 A2/A4/A7 变成数据库层面的保证，代码写错也出不了脏数据 |
| **B5** | 10 万行生成器 `npm run seed:100k`，写独立 DB 文件 | §4 要求"不改动默认 quick-start 数据集" |
| **B6** | 一键验证 `npm run verify` 跑 A1–A7 | A 系列的自动回归，同时是提交的验证证据 |

### A 系列 — 验收行为

| 编号 | 功能点 | 作用 |
|---|---|---|
| **A1_1** | 列表只返回本租户证书 | 隔离的最基本入口，泄露即整体失败 |
| **A1_2** | 跨租户详情返回 **404**（非 403） | 不用 403 是因为 403 会泄露"该证书存在" |
| **A1_3** | 导出只含本租户数据 | 导出是第 4 个越权面，容易漏 |
| **A1_4** | 跨租户批量签发被拒，且**零副作用**（无证书、无审计、无占位残留） | PDF 明确要求"creates no certificates or audit events" |
| **A2_1** | 串行重放同一 key → 返回同一 logical operation 的结果 | 用户重试/网络重放不能变成二次签发 |
| **A2_2** | 并发重复请求 → 只产生一次操作 | 双击提交、并发重试的真实场景 |
| **A2_3** | 每合格学员至多一张证书 | 由 `(tenant,course,learner)` 唯一索引兜底 |
| **A2_4** | 每次实际签发恰好一条 ISSUED 审计 | 由审计唯一索引兜底，审计不能重复也不能缺 |
| **A3_1** | 同 key 不同 payload → **409** | 防止 key 被误用成"万能重试键" |
| **A3_2** | 409 时不执行第二次、不覆盖首次结果 | 拒绝之后状态必须保持原样 |
| **A4_1** | 仅 `completed` 且无证书者签发 | 资格判定的正例 |
| **A4_2** | `incomplete` → `skipped(incomplete_enrollment)` | 必须带原因，不能只是"没发" |
| **A4_3** | 已持证 → `skipped(already_certified)` | 同上，且不报错 |
| **A5_1** | 本地时间显示：East `2026-01-11 00:30` / West `2026-01-10 21:30` | DST 正确性，悉尼 +11 会跨日 |
| **A5_2** | 列表排序用**本地日历日**而非 UTC | 按 UTC 排会把 East 的 1/11 排到 1/10 前面 |
| **A5_3** | CSV 用本地日历日 | 与列表口径一致 |
| **A6_1** | 10 万行导出 < 60s | 性能硬指标 |
| **A6_2** | 两次导出逐字节一致（相同 sort key 顺序稳定） | 靠 `ORDER BY <sort>, id ASC` 全序兜底 |
| **A6_3** | 导出进行中，列表请求正常返回 200 | 同步生成 CSV 会卡死事件循环 |
| **A7_1** | 吊销改状态 + 写一条 REVOKED 审计 | 状态与审计必须原子 |
| **A7_2** | 重复吊销不产生重复审计 | 靠 `WHERE status='ACTIVE'` + `changes()===1` 判定 |

### U 系列 — 前端（只做这些）

| 编号 | 功能点 | 作用 |
|---|---|---|
| **U1** | actor 切换（alice / bob） | 让评委两秒验证 A1 |
| **U2** | 列表：搜索 + 排序 + 分页 + loading/empty/error 三态 | §3 明确要求三态 |
| **U3** | 批量签发：选课程、提交中禁用按钮、逐人结果表 | §3 要求"disable duplicate UI submission" |
| **U4** | 详情 + 吊销二次确认 | §3 要求 confirmation |
| **U5** | 导出按钮，带当前搜索/排序参数 | §3 要求"preserve current search and sort" |

### E 系列 — 证据自动化（零人工）

| 编号 | 功能点 | 作用 |
|---|---|---|
| **E1** | 会话原生导出 → `ai/sessions/*.jsonl`（含 prompt、回复全文、tool call/result、毫秒时间戳、model） | §5 硬要求；缺失即"不可评审" |
| **E2** | `ai/session-index.csv` 自动生成：`purpose` 取会话标题、`related_commits` 按会话时间窗自动匹配 `git log` | 不需要人工填表 |
| **E3** | `ai/decision-log.md` 由 `ai/decisions.jsonl` 自动渲染（AI 干活时即时追加，人工不编辑） | 保证 3 条决策（采纳/驳回/权衡）不遗漏、不补写 |
| **E4** | `ai/completeness-declaration.md` 自动生成（工具清单 + 导出限制） | §5 要求声明所有用过的工具 |
| **E5** | 触发方式：`postinstall` 自动安装 git hook，**每次 commit 自动刷新并 `git add ai/`** | 这就是"证据同步添加，不靠人工" |
| **E6** | 导出时扫描 token/密钥，命中则拒绝提交并提示 `[REDACTED: reason]` | §5 要求提交前清除凭据 |

---

## 3. 里程碑拆分（按编号）

| 里程碑 | 时钟 | 实现编号 | 完成判据 |
|---|---|---|---|
| **M0 骨架** | 0–4′ | B1, B2, B4 | `curl localhost:3000/api/health` → 200；未知 actor → 401 |
| **M1 读路径** | 4–14′ | B3, A1_1, A1_2, A1_3, A5_1, A5_2, A5_3 | 列表只见本租户；跨租户详情 404；East `00:30` / West `21:30` 逐字匹配 |
| **M2 写路径** | 14–27′ | A1_4, A2_1, A2_2, A2_3, A2_4, A3_1, A3_2, A4_1, A4_2, A4_3, A7_1, A7_2 | 串行/并发重放返回同结果；409 不覆盖；三种 outcome 齐全；重复吊销只有 1 条审计 |
| **M3 导出** | 27–37′ | B5, A6_1, A6_2, A6_3 | 两次导出 `diff` 为空；导出中列表 200；10 万行 < 60s |
| **M4 前端** | 37–45′ | U1, U2, U3, U4, U5 | 手动点一遍：切 actor、搜、翻页、批量、吊销、导出 |
| **M5 回归** | 45–53′ | B6（跑 A1_1–A7_2 全量） | `npm run verify` 全绿，输出留档 |
| **M6 文档+证据** | 53–58′ | E1, E2, E3, E4, E6 + README | `ai/` 三件套齐全；completeness 列出全部工具；README 含已知缺陷 |
| **M7 收尾** | 58–60′ | E5 触发 + final commit | 记下 commit SHA，`ai/` 已随 commit 同步 |
| *场外* | *+20–25′* | `written-answers.md`（**无 AI**） | 你自己写 |

**超时砍法**：U5 → U4 审计展示 → U2 错误态。**A1_1–A7_2 一条都不砍。**

---

## 4. 证据自动化怎么跑

```
postinstall  →  安装 .githooks/pre-commit
每次 commit  →  node scripts/ai-evidence.mjs --stage
                 ├─ E1 解压 DSH 多帧 zstd → ai/sessions/<id>.jsonl
                 ├─ E2 生成 ai/session-index.csv（时间窗匹配 git log 得 related_commits）
                 ├─ E3 渲染 ai/decision-log.md ← ai/decisions.jsonl
                 ├─ E4 生成 ai/completeness-declaration.md
                 ├─ E6 扫描密钥，命中则中断提交
                 └─ git add ai/
```

- `ai/decisions.jsonl` 由我在干活时**即时追加**一行（type/purpose/evidence/commit），不靠事后回忆。
- 全程你**不需要手写任何证据文件**。
- 时间戳统一 `+08:00`，保证 `session-index.csv` 口径一致。

---

## 5. 注意点

1. **文档自相矛盾**：封面写 1 hour，§7 建议表加起来 180 min。以 1h 为准，README 写明。
2. **§6 三题禁止 AI**：不起草/不翻译/不润色，被问会拒绝。
3. **A2 并发不是 409**：第二个请求要等到第一个完成，返回同一份结果。
4. **A5 排序≠UTC 排序**：必须落库本地日历日。
5. **A6 不能用同步循环**：会让列表请求超时。
6. **证据时间线要和 commit 对得上**：不允许回填 commit 时间。

---

## 6. 待确认

1. 这套编号（B/A/U/E）和时间分配认可吗？
2. 已建的 `package.json`、`server/db.mjs`、`server/seed.mjs`：删掉保持空仓，还是保留？
3. 计时起点：现在开表，还是等你说"开始"？
