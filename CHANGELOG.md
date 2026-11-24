# 更新记录

本文件从 `1.3.0` 起记录；更早的版本没有留下条目。

## 1.4.5

- 只在歧义影响结论时重述目标。求证模式遇到合法反例即可结束相应命题的验证；权衡模式优先选择能区分原因的检查。
- 防循环比较实际错误和完整输出，同一调用的报错改变时重新计数。新增 A/B 交替失败检测，沿用 threshold 和 denyOn。
- 用户新一轮可重新尝试。提示按用户轮限额；停滞由工具步骤的重复观察触发。变更目标会清除旧方向和失败记录。
- 假设创建和修改共用证据校验。断点成功保存后向守卫同步目标及新增的运行、反例和排除记录，兼容 v1/v2 断点。

## 1.4.1

只修一致性校验与文档，运行时（`loop-guard.cjs` / `memory.cjs` / `state-bus.cjs` / `ledger.cjs`）未改。

- **parity 哈希改为行尾归一化**：`sync-runtime.cjs` 与 `parity.test.cjs` 先做 CRLF → LF、去 BOM 再算 SHA256，并重写 `runtime-parity.json`。修复 1.4.0 的清单在混合行尾的工作区上生成、换行不同就报「共享文件被单边修改」的问题——Windows 默认 `core.autocrlf=true` 的克隆与 Linux/macOS 的 LF 克隆此前都会在 `node --test` 里失败。
- 运行时、persona、断点格式、工具组合与 1.4.0 完全相同，升级无需迁移。

## 1.4.0

与 `@local/dsh-deliberate-preset` 同版本。运行时行为、断点格式、评测与文档同步升级。

- **成功调用不再被硬拦**：`tools/pre-execute` 只有在「同工具 + 同参数 + 同**失败**结果」连续 N 次后才拒绝；成功调用最多得到一条软提示。拒绝码 `REPEATED_IDENTICAL_FAILURE` 只用于失败重复。修复 1.3.1 把正常重复读取判成空转的缺陷。
- **签名与输出哈希改为全量流式 canonical 编码**（`sig/v2` / `out/v2`）：删除 8 KB 前缀截断，前缀相同不再视为同一调用；BigInt、循环引用、抛错访问器、Buffer、Date、Error、NaN/Infinity 都有确定性标记。
- **输出 streak 按工具隔离**，图片/资源等非文本 block 参与比较；失败结果不再重复报「相同输出」。
- **停滞自检改为状态触发**：连续 N 轮没有新证据才注入；`selfCheckEvery` 保留为 1.3.1 兼容项，默认 0（关闭）。
- **新增 `proof_hypotheses`**：结构化假设账本（五态 + 终态 + 证据驱动 + 数量/长度/总大小上限），在 `loop-guard.cjs` 内注册，不新增插件行。`proof_directions` 参数与文案保持不变，并镜像进账本。
- **新增 `proof_guard_stats`**：观察/软提示/硬拦截/恢复计数与按工具分布，默认不记录参数正文。
- **断点升级到 v2**：新增 taskId / goalRef / 结构化 state（goal、excluded、decisions、runs、counterexamples）；v1 断点可读并迁移，`writeSchema: 1` 可写回旧格式用于回滚。
- **注入按事件触发**（resume / compaction / goal-change / milestone），不再每轮重复同一段正文；投影 fold 阶段就脱敏，内存态不留明文密钥。
- **宿主能力逐项降级**：`sessionProjections` / `zod` / `defineTool` / `createUserMessage` 缺失时只降级对应功能，不再整插件加载失败；`memory.cjs` 的 `inject` 从 `['tools','sessionProjections']` 改为 `['tools']`。
- **原子替换在 Windows 上对 EPERM/EBUSY 重试**；POSIX 下断点文件 0600、目录 0700。
- **测试可独立运行**：新增 `state-bus.cjs` / `ledger.cjs` / `runtime-parity.json` / `sync-runtime.cjs`；`parity.test.cjs` 改为哈希清单校验，不再依赖相邻仓库目录；本仓库补上 `loop-guard.test.cjs`、`memory.test.cjs`、`parity.test.cjs`（33 + 13 + 12 条）。
- **工具组合**：proof 原始 23 项保持不变，新增项仍只有 `loop-guard`；新工具注册在既有插件内，`cordis.patch.yml` 未增删插件行。
- 未实施（不写成已完成）：独立反方子代理、三臂对照评测、proof 行为评测、消融实验——见 `MIGRATION.md` 的「未实施项」。

## 1.3.1

与 `@local/dsh-deliberate-preset` 同版本。只修评测器与文档，`loop-guard.cjs` / `memory.cjs` 未改。

- **工具组合**：proof 原始 23 项（含 `session-memory`）保持不变，另新增 `loop-guard`；评测器按 preset 分列基准（proof 23 项 / deliberate 22 项），新增项单独报告、不算失败。
- **文档**：README 补工具组合说明；版本号 `1.3.0` → `1.3.1`。

## 1.3.0

与 `@local/dsh-deliberate-preset` 同版本发布，补齐两轮审查（R1–R12）里属于求证模式的条目。

- **R1 防循环归位**：新增 `loop-guard.cjs`（与 deliberate 逐字节一致），`cordis.patch.yml` 注册 `- id: loop-guard`（`threshold: 3`、`selfCheckEvery: 3`），排在 `session-memory` 之前。`memory.cjs` 删除旧的 `ctx.tools.guard` 三次守卫与「已连续 N 次」注入，只保留 `proof_checkpoint`。
- **R2 拦截即换路**：第 4 次相同调用被拒绝时，拒绝理由与下一步注入的 user 消息都写明「当前做法已连续 N 次相同，请换一个可检验的新策略，并先说明新假设与判定标准」。
- **R3 计数器分离**：连续相同调用（`threshold`）与每 N 轮自检（`selfCheckEvery`）各自计数、各自可配。
- **R6 hook 不崩**：监听器全程 `try/catch`，异常降级为放行 + stderr 日志；签名只取前 8 KB。
- **R7 配置校验**：非法值回退默认 `3` 并告警，README 增加配置表。
- **R8 方向留痕**：新增 `proof_directions`（会话内、不落盘），卡住时提示会引用已记录方向。
- **R9 断点安全**：落盘前过滤密钥/token/密码；损坏文件隔离为 `.corrupt-<时间戳>.json` 并按空断点重建；README 补手动清理。
- **R11 与 deliberate 对齐**：prefix 增加方向记录，断点段增加「先回看方向」，交付段增加「静态检查与运行验证分开写」「不编造风险」，防循环段注明由 `loop-guard` 每 3 轮计数。
- **R12 文档**：README 重写（去掉「同错复现守卫」等旧说法），版本升到 `1.3.0`，`package.json` 收录 `loop-guard.cjs` 与 `CHANGELOG.md`。
