# 人工验收手册（Manual Test Guide）

> 自动化部分（44 项断言）不需要你做任何事；本文件只覆盖**必须人眼/人手确认**的内容。
> 全程约 10 分钟。

---

## 0. 前置条件

| 项 | 要求 | 检查命令 |
|---|---|---|
| Node | **≥ 22.5**（项目用了内置 `node:sqlite`） | `node -v` |
| 端口 | 3000 空闲 | `lsof -i:3000` （有输出就先 `pkill -f server/index.mjs`） |

> 本机实测 Node v24.18，可直接用。

---

## 1. 启动（一条命令）

```bash
cd ~/Documents/ocean_ai_real
npm start
```

它会依次打印四步，最后一行出现这个就是成功了：

```
▸ ① 安装依赖 / ① 安装 git hooks
▸ ② 构建前端
▸ ③ 初始化 demo 数据      ← 打印 {"seeded":true,"tenants":2,...}
▸ ④ 启动服务
certificate-admin listening on http://localhost:3000  (db=data/app.db, certificates=2)
```

打开 **http://localhost:3000**

> `npm start` 是前台阻塞的，占一个终端窗口。要停止：`Ctrl+C`。

### 演示账号（页面上用下拉框切换，无需登录）

| 显示名 | 账号 | 租户 | 时区 |
|---|---|---|---|
| Alice (East) | `alice@east.test` | East | Australia/Sydney |
| Bob (West) | `bob@west.test` | West | Australia/Perth |

---

## 2. 自动化部分（不用人工，1 条命令）

另开一个终端：

```bash
cd ~/Documents/ocean_ai_real
npm run verify            # → 结果：44 passed, 0 failed
npm run check:submission  # → 提交清单校验（written-answers 未提交时会有 1 条提醒，属正常）
```

这两条就是 A1–A7 的全部机器判据。**下面的手工项是它们覆盖不到的 UI 行为。**

---

## 3. 人工验收清单（打勾用）

### ✅ U1 — 切换账号，确认租户隔离

| 操作 | 期望结果 |
|---|---|
| 选 `alice@east.test`，看列表 | 只出现 **CERT-EAST-*** 序列号 |
| 切换成 `bob@west.test` | 列表立刻刷新，**只剩 CERT-WEST-***，看不到任何 EAST 记录 |
| 右侧「Tenant timezone」 | Alice → `East · Australia/Sydney`；Bob → `West · Australia/Perth` |

实测对照：
```
alice: CERT-EAST-000001  Priya Nair   2026-01-11 00:30  ACTIVE
bob:   CERT-WEST-000001  Alex Lee     2026-01-10 21:30  ACTIVE
```

### ✅ A5 — 同一 UTC 时刻，两个租户本地时间不同

这是 DST 的关键点，肉眼确认即可：

| 看谁 | 期望「Issued (local)」 |
|---|---|
| Alice 的 CERT-EAST-000001 | **2026-01-11 00:30** |
| Bob 的 CERT-WEST-000001 | **2026-01-10 21:30** |

两者 UTC 都是 `2026-01-10T13:30:00Z`。点开任一行的详情能看到 `Issued (UTC)` 一致。

### ✅ U2 — 列表的三种状态

| 操作 | 期望结果 |
|---|---|
| 搜索框输入 `Priya` | 只剩 1 行（CERT-EAST-000001） |
| 搜索框输入 `zzz` | 显示 **「No certificates match this search.」**（空态） |
| 清空搜索，把「Sort by」换成 `Learner name`，Order 换 `Ascending` | 列表按学员名重排，page 回到 1 |
| **错误态**：停掉服务（`Ctrl+C`）后点「Next」 | 出现红色 **「Could not load certificates: …」+ Retry 按钮**；重启服务后点 Retry 恢复 |
| 翻页 | 每页 20 条；少于 20 条时 Next 是灰的 |

> 想看翻页效果，用第 5 节的大数据集。

### ✅ U3 — 批量签发（重点：防重复提交 + 幂等）

| 操作 | 期望结果 |
|---|---|
| 课程选 **Safety 101**，直接点「Issue certificates」 | 按钮变成 **「Issuing…」并禁用**；结果表出现 3 行：`Alex Lee → issued`、`Priya Nair → skipped / already_certified`、`Tom Silva → skipped / incomplete_enrollment` |
| **不改 Idempotency-Key**，再点一次「Issue certificates」 | 结果与上次**完全一样**，且横幅里出现 **`(replayed — no new certificates)`**；列表里**没有新增证书** |
| 点「New key」，再签发一次 | 因为是新 key，同样返回同一结果（再发也不会重复，因为学员已持证） |
| 把课程换成 **Data Privacy**，**保持原 key** | 红色 **「Bulk issue failed: Idempotency-Key was already used with a different request payload」**（即 409），列表不变 |

实测：
```
第1次: summary {"total":3,"issued":1,"skipped":2,"failed":0}
第2次: summary {"total":3,"issued":1,"skipped":2,"failed":0}  + Idempotent-Replay: true
```

### ✅ U4 — 详情 + 吊销二次确认

| 操作 | 期望结果 |
|---|---|
| 点任意一行 | 下方出现详情卡：序列号、课程、学员、`Issued (tenant local)`、`Issued (UTC)`、状态徽章 |
| 点「Revoke certificate」 | 浏览器弹 **原生确认框**「Revoke certificate …? This cannot be undone.」 |
| 点「取消」 | 什么都不发生 |
| 点「确定」 | 状态变成 **REVOKED**（红色徽章）；按钮变灰成「Already revoked」；audit 表出现 1 条 **REVOKED** |
| 审计表 | 正常应为 2 条：`ISSUED` + `REVOKED`，都不会重复 |

实测：
```
第1次吊销: status=REVOKED alreadyRevoked=false
第2次吊销: status=REVOKED alreadyRevoked=true     ← 审计不会多出第 3 条
```

### ✅ U5 — 导出必须保留当前搜索与排序

| 操作 | 期望结果 |
|---|---|
| 先搜索 `Priya`，排序选 `Learner name` / `Ascending`，再点「Export CSV」 | 下载的文件**只含匹配 `Priya` 的行**，且顺序与页面一致 |
| 打开 CSV（Excel/Numbers/`cat`） | 表头恰为 `learner_name,course_title,serial_number,issue_date_local`，4 列 |
| 日期的租户本地性 | Alice 导出的 East 证书日期是 `2026-01-11`；Bob 导出的 West 是 `2026-01-10` |
| 清空搜索后再导出 | 导出**全部**本租户记录（不受分页限制） |

实测：
```
learner_name,course_title,serial_number,issue_date_local
Alex Lee,Safety 101,CERT-EAST-000002,2026-11-03
Priya Nair,Safety 101,CERT-EAST-000001,2026-01-11
```

---

## 4. 出错时怎么排查

| 现象 | 原因 / 处理 |
|---|---|
| 页面打开但列表报错 `Could not load…: Failed to fetch` | 后端没起 → 确认 `npm start` 那个终端没退出 |
| 所有请求 401 | demo 数据没初始化 → `rm -f data/app.db*` 后重新 `npm start`（会自动 seed） |
| 端口占用 `EADDRINUSE` | `pkill -f "server/index.mjs"` 后重试，或 `PORT=3001 npm start` |
| 想把 demo 数据恢复成初始状态 | `rm -f data/app.db data/app.db-wal data/app.db-shm && npm start` |

> 注意：吊销是**不可逆**的（没有"取消吊销"功能，这是设计上的取舍，已写进 README 已知缺陷）。想反复演示就先重置 DB。

---

## 5. 可选：10 万行大数据集（验证导出规模与翻页）

```bash
npm run seed:100k                  # 生成 data/perf.db（不碰 data/app.db）
DB_PATH=data/perf.db npm start     # 用大数据集启动
```

然后：

| 操作 | 期望结果 |
|---|---|
| 搜索 `Perf Learner` | 出现大量结果，翻页按钮可用 |
| 点「Export CSV」 | 很快完成；打开看行数 = 100000 |
| 导出期间**同时**点「Next」翻页 | 页面正常响应，不会卡死（A6_3） |

实测：10 万行导出 **0.27 秒**，两次导出文件逐字节一致。

---

## 6. 只有你能做的部分（AI 不能参与）

1. **`written-answers.md`** —— 考核 §6 三道题，用你自己的话写。不借助 AI 起草/翻译/润色/校对。
   写完后自己提交：
   ```bash
   git add written-answers.md
   git commit -m "docs(§6): written answers"
   git push
   ```
2. 上面第 3 节的 **U1–U5 打勾**（`npm run verify` 覆盖不到 UI 行为）。

做完这两件，提交就完整了。
