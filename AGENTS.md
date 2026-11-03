# AGENTS.md — 本工作区准则（所有 Agent 必须遵循）

> **适用范围**：在 `/Users/zhihaomeng/Documents/ocean_ai_real` 启动的**所有** agent，包括 Lead、teammate、subagent。
> **开工顺序**：先读本文件 → 再读 [`docs/MILESTONES.md`](docs/MILESTONES.md)（38 个编号功能点 + M0–M7 里程碑）。
> **优先级**：考核 PDF 原文 > 本文件 > `docs/MILESTONES.md` > 个人偏好。

---

## 1. 任务

1 小时内从空仓构建 **Certificate Admin Console**：多租户培训平台的证书管理后台。
后端 Go/Python/Node + 主流框架 + SQLite/MySQL/PG（**禁止内存存储**）；前端 Vue 3 或 React。
交付物 = 可运行产品 + README + AI 证据（`ai/`）+ `written-answers.md`（无 AI）。

---

## 2. 硬性禁止

| # | 禁止 |
|---|---|
| 1 | **禁止 AI 参与 `written-answers.md`**（考核 §6）：不起草、不翻译、不润色、不校对、不总结。被请求时必须拒绝并说明是个人作答环节 |
| 2 | **禁止超范围功能**：登录 UI、生产鉴权、云部署、通知、图表、国际化、暗色主题 |
| 3 | **禁止内存存储**替代数据库 |
| 4 | **禁止人工编写/整理 `ai/` 下任何证据文件**（由脚本生成，见 §6） |
| 5 | **禁止编造 AI 失误**写入 decision-log；无真实失误就写验证过程 |
| 6 | **禁止伪造/回填** commit 时间与会话时间戳 |
| 7 | **禁止修改** `Ocean AI Labs Beijing - Technical Interview Assessment - 2026110201.pdf` |
| 8 | **禁止擅自开工**：范围变更必须先改 `docs/MILESTONES.md` 并经用户确认 |

---

## 3. 编号体系（所有任务、commit、报告必须引用）

| 前缀 | 含义 | 范围 |
|---|---|---|
| **B1–B6** | 基础能力 | 启动命令、actor 上下文、demo 数据、唯一索引、10 万生成器、验证命令 |
| **A1_1–A7_2** | 验收行为 | 21 个子项，对应 PDF §4 的 A1–A7 |
| **U1–U5** | 前端交互 | 只做 §3 要求的 5 个 |
| **E1–E6** | 证据自动化 | `ai/` 三件套 + completeness |

- 任务标题格式：`A2_2 并发重复请求只产生一次操作`
- commit 格式：`feat(A2_2): idempotent concurrent replay returns same result`
- 报告进度时**必须**用编号，不要用"做了批量签发"这种模糊描述。

---

## 4. 里程碑纪律

| 里程碑 | 时钟 | 编号 |
|---|---|---|
| M0 骨架 | 0–4′ | B1, B2, B4 |
| M1 读路径 | 4–14′ | B3, A1_1–A1_3, A5_1–A5_3 |
| M2 写路径 | 14–27′ | A1_4, A2_1–A2_4, A3_1, A3_2, A4_1–A4_3, A7_1, A7_2 |
| M3 导出 | 27–37′ | B5, A6_1–A6_3 |
| M4 前端 | 37–45′ | U1–U5 |
| M5 回归 | 45–53′ | B6 全量 |
| M6 文档+证据 | 53–58′ | E1–E4, E6 + README |
| M7 收尾 | 58–60′ | E5 + final commit |
| M8 提交校验 | 场外 | B6：`npm run check:submission` 机械核对 §8 清单 |

- **一次只推进一个里程碑**；上一个里程碑的判据跑过才允许进下一个。
- 超时砍法：U5 → U4 审计展示 → U2 错误态。**A1_1–A7_2 一条都不砍。**
- 禁止跳过判据"先写后面"。

---

## 5. 并行与写入范围

多 agent 并行时按**目录互斥**分工，禁止交叉：

| 范围 | 归属 |
|---|---|
| `server/`、`scripts/` | Lead |
| `web/` | 前端 agent（单人） |
| `ai/` | **仅由脚本写**，任何 agent 不得手改 |
| `docs/`、`README.md` | Lead |

- 共享文件（`package.json`、`README.md`、`AGENTS.md`）**只能由 Lead 改**。
- 提交前 Lead 负责跑一次全量 `npm run verify` 并 review diff。

---

## 6. 证据规则（零人工）

- `ai/` 下所有文件由 `scripts/ai-evidence.mjs` 生成；`postinstall` 安装 `.githooks/pre-commit`，**每次 commit 自动刷新并 `git add ai/`**。
- E1 会话原生导出 → `ai/sessions/<id>.jsonl`
- E2 `ai/session-index.csv`（purpose 取会话标题，related_commits 按时间窗匹配 `git log`）
- E3 `ai/decision-log.md` ← `ai/decisions.jsonl`（**agent 在决策发生时即时追加一行**，不做事后回忆）
- E4 `ai/completeness-declaration.md` 自动生成
- E6 提交前扫描 token/密钥，命中即中断，用 `[REDACTED: reason]` 最小替换
- 时间戳统一 `+08:00`。

---

## 7. 完成定义（DoD）

一个编号算"完成"，必须同时满足：

1. 代码已提交，commit message 带编号；
2. `npm run verify` 中存在**该编号的断言**且通过；
3. 若属于 M6/M7，`ai/` 证据已由 hook 自动同步；
4. README 的复现步骤与之对应。

---

## 8. 当前状态

- **技术栈**：Node 24 + Express + `node:sqlite` + React 18 + Vite
- **M0–M5 完成**：B1–B6、A1_1–A7_2 全部实现，`npm run verify` **44 passed / 0 failed**
- **M6 完成**：`ai/` 四件套由 pre-commit hook 自动生成并 `git add`（E5 已验证：3 次提交各自动同步一次）
- **M8 完成**：`npm run check:submission` 把 §8 清单变成可执行校验（仅校验元数据，不读 written-answers 内容）
- **待候选人完成**：① 提交 `written-answers.md`（§6，**禁止 AI 参与**）② 配置 remote 并推送

> 更新本文件"当前状态"是 Lead 的职责；其他 agent 只读。
