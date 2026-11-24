# 求证 · DSH Agent Preset

版本 1.3.1。适用于 OI 解题、反例定位与有限预算的对拍。

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
dsh plugin --profile desktop add file:C:/path/to/local-dsh-proof-preset-1.3.1.tgz
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
| `loop-guard.cjs` | 运行时防循环 hook：连续相同调用/输出硬拦截 + 每 N 个用户轮次注入事前自检 + `proof_directions` 方向记录 |
| `memory.cjs` | 只做断点：注册 `proof_checkpoint`（save 落盘 / read / clear）。不参与防循环计数，也不再注入换路提示 |

工具组合：原始 23 项（含 `session-memory`）保持不变，另新增 `loop-guard`。

## 防循环（运行时硬拦截）

`loop-guard.cjs` 是运行时 hook，规则用可计算度量（SHA256），不做语义相似：

1. **连续相同调用**：同一工具 + 同一参数签名（`signature()`）+ 同一输出 hash 连续 N 次（默认 3）后，第 N+1 次在 `tools/pre-execute` 被拒绝，错误码沿用 `REPEATED_IDENTICAL_FAILURE`。拒绝理由本身带换路指令，同一步还会用 `createUserMessage` 注入一条「当前做法已连续 N 次相同，请换一个可检验的新策略，并先说明新假设与判定标准」——不是只回一个拒绝码。
2. **连续相同输出**：参数不同但连续 N 次输出 hash 相同，只注入提示，不硬拒绝（合法的重复检查不该被拦）。
3. **轮次自检**：每 `selfCheckEvery` 个用户轮次注入一次「当前做法是否在重复之前失败过的路径」。

连续两次撞上同一拦截会结束本轮；同一轮只拒绝一次，不会无限拒绝。`*_checkpoint`、`*_directions`、`todo_write` 等记账工具不参与计数。

## 配置

两个计数器**完全独立**，各有各的配置项，改一个不影响另一个：

| 配置项 | 默认 | 含义 | 怎么改 |
|---|---|---|---|
| `loop-guard.config.threshold` | `3` | B1：同一工具 + 同一参数 + 同一输出连续 N 次后拦截第 N+1 次 | 改 `cordis.patch.yml` 里 `loop-guard` 行的 `threshold`。必须正整数；`0`、负数、非数字、小数都会回退默认 `3`，并在 stderr 打一条 `[loop-guard] 配置 ... 不是正整数` 告警 |
| `loop-guard.config.selfCheckEvery` | `3` | C2：每 N 个用户轮次注入一次事前自检 | 同上，改 `selfCheckEvery`。同样必须正整数，非法值回退 `3` |

`threshold` 数的是「连续相同调用次数」，`selfCheckEvery` 数的是「用户轮次」，两者不共用计数器。想看实际生效值，跑 `dsh --profile headless --patch ./cordis.patch.yml --dump-config`。

## 方向记录

`proof_directions` 在会话内保存本轮列出的 2–3 个方向（各一句 + 一句利弊），最多 3 条、每条 200 字符，**不落盘**。卡住或准备换路时，防循环提示会把这份记录带出来，先看有没有漏掉但能用的方向，再决定是否重想。简单问答可以不用。

```
proof_directions { action: "set", items: ["方向 A（利/弊）", "方向 B（利/弊）"] }
proof_directions { action: "read" }
proof_directions { action: "clear" }
```

## 断点生命周期

一句话：**断点存在 `<DSH_HOME>/checkpoints/<profile>/` 下的会话级 JSON 文件；同一会话重启后仍能读回，新建会话或 `clear` 后失效。**

实现见 `memory.cjs`：save 写文件；read 文件优先，`ctx.sessionProjections` 的内存投影兜底。落盘 JSON 的 schema 固定为：

```json
{"schemaVersion":1,"sessionId":"session-…","profile":"desktop","note":"断点正文（≤800 字符）","updatedAt":"2026-11-24T03:00:00.000Z"}
```

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

## 许可

MIT。persona 与工具子树基于 DeepSeek Harness 的 `standard` 组合派生，见 `LICENSE`。
