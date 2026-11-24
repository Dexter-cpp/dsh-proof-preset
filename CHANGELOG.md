# 更新记录

本文件从 `1.3.0` 起记录；更早的版本没有留下条目。

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
