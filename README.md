# 求证 · DSH Agent Preset

版本 1.4.1。适用于 OI 解题、反例定位与有限预算的对拍。

「求证」是 DeepSeek Harness 的一个 agent preset bundle：persona 定义求证工作流，`loop-guard.cjs` 做运行时防循环，`memory.cjs` 注册 `proof_checkpoint` 断点工具，其余是标准工具配置。

## 安装

DSH 从 profile 装载插件，profile 目录在 `$DSH_HOME/profiles/<name>`（Windows 上即 `C:\Users\<你>\.dsh\profiles\<name>`）。

**从 GitHub 安装**（把 `desktop` 换成你的 profile 名）：

```powershell
dsh plugin --profile desktop add github:Dexter-cpp/dsh-proof-preset
```

`dsh plugin` 只是把参数转给 pnpm，装完还要让 profile 启用这个 bundle：在 profile 的 `package.json` 里把它加进 `dsh.profile.bundles`。

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@local/dsh-proof-preset"]
    }
  }
}
```

`package.json` 里的 `name` 是 `@local/dsh-proof-preset`，`bundles` 里写的也是这个名字。用图形界面的插件管理器启用等价。

**离线 tgz**（仓库里不带，需用 `npm pack` 自己产出）：

```powershell
dsh plugin --profile desktop add file:C:/path/to/local-dsh-proof-preset-1.4.0.tgz
```

**源码直连**，改完立刻生效，适合自己调：

```json
{
  "dependencies": {
    "@local/dsh-proof-preset": "link:C:/path/to/proof-preset"
  }
}
```

## 使用

装好后**新建会话**，在模式选择器里选「求证」。已打开的旧会话可能仍绑定旧版模式，重启 DSH 后再开新会话最稳。

## 内容

| 文件 | 作用 |
|---|---|
| `cordis.patch.yml` | 声明 `@deepseek-ai/dsh-agent-preset`（`id: proof`、`order: 6`）及其子插件：persona、`loop-guard`、`memory`、`dsh-tool-fs`/`-pwsh`/`-jobs`/`-skill` 等标准工具子树 |
| `loop-guard.cjs` | 运行时防循环 hook：只拦失败重复 + 按工具的输出 streak + 状态触发的停滞检查；注册 `proof_directions`、`proof_hypotheses`、`proof_guard_stats` |
| `memory.cjs` | 只做断点：注册 `proof_checkpoint`（save 落盘 / read / clear），v2 格式，按事件注入 |
| `ledger.cjs` | 假设账本逻辑：五态状态机、证据校验、预算上限（无插件依赖） |
| `state-bus.cjs` | 同包内 loop-guard 与 memory 共享的会话信号（新证据 / 目标版本），不落盘 |
| `runtime-parity.json` + `sync-runtime.cjs` | 共享文件哈希清单与同步/校验脚本 |

工具组合：原始 23 项（含 `session-memory`）保持不变，另新增 `loop-guard`；`proof_hypotheses` 与 `proof_guard_stats` 注册在 `loop-guard` 内，**不新增插件行**。

## 防循环（运行时硬拦截）

`loop-guard.cjs` 是运行时 hook，规则用可计算度量（SHA256），不做语义相似：

1. **连续相同失败**：同一工具 + 同一参数签名 + 同一**失败**结果连续 N 次（默认 3）后，第 N+1 次在 `tools/pre-execute` 被拒绝，错误码 `REPEATED_IDENTICAL_FAILURE`。拒绝理由本身带换路指令，同一步还会用 `createUserMessage` 注入一条「请换一个可检验的新策略，并先说明新假设与判定标准」。
2. **成功调用永不硬拦**：重复读取、重复查询最多得到一条软提示；1.3.1 把成功重复判成失败的问题已修复。
3. **连续相同输出**：参数不同但**同一工具**输出连续 N 次相同，只注入提示，不硬拒绝；streak 按工具隔离，图片/资源等非文本输出也参与比较。
4. **停滞检查**：连续 N 轮没有新证据（`proof_hypotheses` 状态变化、断点保存都算新证据）才注入一次「写出当前假设与下一个区分性观察」，不再按用户轮次机械触发。

连续两次撞上同一拦截会结束本轮；同一轮只拒绝一次，不会无限拒绝。`*_checkpoint`、`*_directions`、`*_hypotheses`、`*_guard_stats`、`todo_write` 等记账工具不参与计数。

签名与输出哈希是**全量**流式 canonical 编码（`sig/v2` / `out/v2`）：没有 8 KB 截断，前缀相同不会被当成同一调用；BigInt、循环引用、抛错访问器、Buffer、Date、Error 都有确定性标记。

## 配置

三个计数器**完全独立**，各有各的配置项：

| 配置项 | 默认 | 含义 | 怎么改 |
|---|---|---|---|
| `loop-guard.config.enabled` | `true` | 总开关；`false` = 完全不干预 | 改 `cordis.patch.yml` 里 `loop-guard` 行的 `enabled` |
| `loop-guard.config.denyOn` | `failure` | 只有失败重复才硬拦；`never` = 只提示 | 同上，改 `denyOn` |
| `loop-guard.config.threshold` | `3` | 连续相同失败 N 次后拦第 N+1 次；2..10，超出夹取 | 同上，改 `threshold` |
| `loop-guard.config.outputStreakThreshold` | `3` | 同工具连续相同输出 N 次 → 软提示；2..10 | 同上 |
| `loop-guard.config.stallRounds` | `3` | 连续 N 轮无新证据 → 停滞检查；2..10 | 同上 |
| `loop-guard.config.selfCheckEvery` | `0` | 1.3.1 兼容项；`>0` 才按用户轮次自检 | 同上 |
| `loop-guard.config.maxNoticesPerTurn` | `2` | 每轮最多注入条数；1..3 | 同上 |
| `loop-guard.config.stats` | `memory` | `off` / `memory`（只在内存计数，不记参数正文） | 同上 |
| `loop-guard.config.budget.*` | 20 / 240 / 5 / 8192 | 假设条数、命题长度、每条证据数、账本总字节 | 同上 |
| `session-memory.config.writeSchema` | `2` | 断点写 v2；`1` = 写回 v1（回滚用） | 改 `session-memory` 行 |
| `session-memory.config.injectOn` | 四项全开 | 注入时机：resume / compaction / goal-change / milestone | 同上 |
| `session-memory.config.maxInjectChars` | `800` | 单次注入上限；200..2000 | 同上 |

`threshold` 数的是「连续相同失败次数」，`stallRounds` 数的是「连续无新证据轮次」，`outputStreakThreshold` 数的是「同工具相同输出次数」，三者不共用计数器。非法值不会静默生效：整数越界会夹取，类型/枚举不对会回退默认，并在 stderr 打 `[loop-guard] 配置 ...` 告警。想看实际生效值，跑 `dsh --profile headless --patch ./cordis.patch.yml --dump-config`。

## 假设账本

`proof_hypotheses` 记录结构化假设，不是一段提示词：

```
proof_hypotheses { action: "set", statement: "贪心按右端点排序即可", axis: "algorithm", risk: "high", nextCheck: "n≤6 穷举 200 组" }
proof_hypotheses { action: "update", id: "H1", status: "falsified", evidence: [{ kind: "test", source: "stress seed 12345", result: "得到 4，期望 5" }] }
proof_hypotheses { action: "read" }
```

- 状态只有 `untested / testing / supported / falsified / blocked`；`falsified` 是终态，不能改名重开，只能新建并标 `supersedes`。
- `supported` 需要至少一条有效且非自证（`kind !== "self"`）的证据；`falsified` 需要反例/矛盾证据；高风险假设进入 `testing` 前必须写 `nextCheck`。
- 上限：20 条未归档、命题 ≤240 字符、每条 ≤5 条证据、账本 ≤8 KB；超限报错且不改变原状态。
- 会话内保留，不落盘；需要跨会话时把结论写进 `proof_checkpoint`。

## 方向记录

`proof_directions` 在会话内保存本轮列出的 1–3 个方向（各一句 + 一句利弊），最多 3 条、每条 200 字符，**不落盘**；同时镜像成 `axis: "direction"` 的假设。卡住或准备换路时，防循环提示会把这份记录带出来。

```
proof_directions { action: "set", items: ["方向 A（利/弊）", "方向 B（利/弊）"] }
proof_directions { action: "read" }
proof_directions { action: "clear" }
```

## 断点生命周期

一句话：**断点存在 `<DSH_HOME>/checkpoints/<profile>/` 下的会话级 JSON 文件；同一会话重启后仍能读回，新建会话或 `clear` 后失效。**

实现见 `memory.cjs`：save 写文件；read 文件优先，`ctx.sessionProjections` 的内存投影兜底（投影缺失时只用文件）。落盘 JSON 的 schema 为 v2：

```json
{"schemaVersion":2,"sessionId":"session-…","profile":"desktop","taskId":"","goalRef":{"id":"g1","revision":3},"note":"断点正文（≤800 字符）","state":{"goal":{"objective":"…","acceptance":["…"]},"excluded":["编码问题"],"nextAction":"跑 test3"},"updatedAt":"2026-11-24T03:00:00.000Z"}
```

`schemaVersion: 1` 的旧文件仍可读，下一次 save 自动升级为 v2；`writeSchema: 1` 可写回旧格式用于回滚（见 `MIGRATION.md`）。

| 问题 | 结论 |
|---|---|
| 存在哪 | `<DSH_HOME>/checkpoints/<profile>/<sha256(sessionId) 前 32 位>.json`；文件名用哈希，避免 session id 里的特殊字符造成路径问题 |
| 什么时候失效 | 新建会话（新 session id）读不到；切换 preset 同理；`clear` 删除文件；删除会话后文件成为孤儿，不再被任何会话引用，可手动清理 |
| 切换模型 | 不失效：文件与模型选择无关，同一会话内断点保留 |
| 上下文压缩 | 不失效：文件在，投影仍能从会话事件重建 |
| 是否按项目目录共享 | 不共享：按会话隔离，两个 cwd 相同的会话各有各的文件 |
| 并发写 | 一个会话只有一个写者；写入先写临时文件再原子 rename，最后写入者生效，不会读到半截 JSON |
| 多 profile | 路径含 profile 名，互不覆盖 |
| 和 sessionProjections 的关系 | 并存，不是替换：文件是持久层，投影负责本会话内的即时提示与兜底 |

### 敏感字段与损坏文件

- **落盘前过滤**：`api_key` / `token` / `password` / `Authorization` / `sk-…` / `ghp_…` / `AKIA…` / JWT / 私钥块等形态的字段会被替换成 `[已过滤]`，工具会告诉你「疑似密钥字段已过滤」。宁可多过滤，也不要把凭据留在明文 JSON 里。
- **文件损坏**：JSON 解析失败或 `schemaVersion` 不符时，文件被重命名为 `<hash>.json.corrupt-<时间戳>.json`，按空断点重建，不会让会话崩掉；stderr 会有 `[checkpoint] 断点文件损坏` 告警。

### 手动清理（`clear` 之外）

```powershell
# 删掉某个 profile 的全部断点
Remove-Item "$env:DSH_HOME\checkpoints\<profile>" -Recurse -Force
# 只删某个会话的断点（文件名是 sessionId 的 sha256 前 32 位）
Remove-Item "$env:DSH_HOME\checkpoints\<profile>\<hash>.json"
# 隔离出来的损坏文件可以随时删
Remove-Item "$env:DSH_HOME\checkpoints\<profile>\*.corrupt-*.json"
```

`$env:DSH_HOME` 未设置时默认是 `~/.dsh`。

## 测试

```powershell
node --test                  # 单元测试：守卫 33 条 + 断点 13 条 + parity 12 条，不需要 dsh
node sync-runtime.cjs --check  # 共享文件与 runtime-parity.json 是否一致
```

测试**不依赖**另一个仓库的目录：跨仓库一致性由 `runtime-parity.json` 的哈希清单校验。改动共享文件后，用 `node sync-runtime.cjs --write ../dsh-deliberate-preset` 同步并重写清单。

## 许可

MIT。persona 与工具子树基于 DeepSeek Harness 的 `standard` 组合派生，见 `LICENSE`。
