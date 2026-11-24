# 1.3.1 → 1.4.0 迁移说明

## 一、行为变化（会影响旧会话的体感）

| 变化 | 1.3.1 | 1.4.0 | 影响 |
|---|---|---|---|
| 相同调用的硬拦截 | 成功也拦，拒绝码 `REPEATED_IDENTICAL_FAILURE` | 只拦「同工具 + 同参数 + 同失败结果」；成功最多一条软提示 | 重复读取、重复查询不再被误判为空转 |
| 输出 streak | 全局比较，跨工具合并 | 按工具隔离，图片/资源参与 | 「no matches」「ok」不再被误报 |
| 自检时机 | 每 N 个用户轮次 | 连续 N 轮无新证据才触发 | 简单对话不再被塞自检提示 |
| 断点注入 | 每轮 step 1 重复注入 | 只在 resume / compaction / goal-change / milestone | 上下文占用下降 |
| 断点文件 | `schemaVersion: 1` | `schemaVersion: 2`（v1 可读并迁移） | 回滚前需按第四节处理 |

## 二、配置新增与变更

| 配置 | 默认 | 说明 |
|---|---|---|
| `loop-guard.config.enabled` | `true` | `false` = 完全不干预 |
| `loop-guard.config.denyOn` | `failure` | `never` = 只提示不拦截 |
| `loop-guard.config.threshold` | `3` | 连续相同失败次数，2..10，超出夹取 |
| `loop-guard.config.outputStreakThreshold` | `3` | 同工具连续相同输出，2..10 |
| `loop-guard.config.stallRounds` | `3` | 连续 N 轮无新证据触发停滞检查，2..10 |
| `loop-guard.config.selfCheckEvery` | `0` | 1.3.1 兼容项；`>0` 才按轮次自检 |
| `loop-guard.config.maxNoticesPerTurn` | `2` | 每轮最多注入条数，1..3 |
| `loop-guard.config.stats` | `memory` | `off` / `memory`（不记录参数正文） |
| `loop-guard.config.budget.*` | 20 / 240 / 5 / 8192 | 假设条数、命题长度、每条证据数、账本总字节 |
| `session-memory.config.writeSchema` | `2` | `1` = 写回 v1（回滚用） |
| `session-memory.config.injectOn` | 四项全开 | 注入时机白名单 |
| `session-memory.config.maxInjectChars` | `800` | 单次注入上限，200..2000 |

非法值不会静默生效：整数越界会夹取，类型/枚举不对会回退默认，并在 stderr 打一条 `[loop-guard] 配置 ...` 告警。

## 三、断点迁移

- 读取：`schemaVersion: 1` 的文件按旧格式解析，`note` 直接可用，结构化字段为空。
- 写入：下一次 `save` 自动写成 v2（`taskId`、`goalRef`、`state`）。
- 兼容：`state` 缺失、类型错误、文件超过 64 KB 都会判为损坏并隔离为 `.corrupt-<时间戳>.json`，不会让会话崩溃。
- 脱敏：落盘、投影、注入三处都会过滤密钥形态；这是正则脱敏，**不是**完整的秘密扫描器。

## 四、回滚到 1.3.1

1. 把 `session-memory.config.writeSchema` 改为 `1`，让会话再 `save` 一次（或直接删除 v2 断点文件）。
2. 回退代码。
3. 注意：1.3.1 只认 `schemaVersion: 1`，v2 文件会被它当成损坏并隔离——**断点内容会丢失**。这是唯一不可逆点。

只想关掉新行为而不回退代码时，优先用配置：`enabled: false`、`denyOn: never`、`selfCheckEvery: 3`、`injectOn: [resume]`。

## 五、未实施项（如实列出）

以下条件在本版本**没有**实现，不要当成已完成：

- 独立反方子代理的自动触发与回写（条件 81–90）：当前只有 persona 规则与 `subagent` 工具，没有自动触发与预算控制。
- standard / 1.3.1 / 候选 三臂对照、每用例 ≥3 次重复、消融实验（条件 132–134、137）。
- proof 独立行为评测（条件 139）：proof 仓只有单元测试，没有行为用例。
- 统计面板与额外性能优化（P2）。

## 六、验证方法

```powershell
# 单元测试（不需要 dsh、不消耗额度）
node --test

# 共享文件一致性（两仓各跑一次）
node sync-runtime.cjs --check

# 静态断言 + 负向自检（deliberate 仓；proof 目录默认 ../dsh-proof-preset）
node evaluate.cjs --self-test
node evaluate.cjs --static
```
