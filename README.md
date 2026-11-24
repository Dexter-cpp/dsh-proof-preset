# 求证 · DSH Agent Preset

版本 1.1.0-beta.1。适用于 OI 解题、反例定位与有限预算的对拍。

「求证」是 DeepSeek Harness 的一个 agent preset bundle：一个 persona 插件定义求证工作流，一个 `memory.cjs` 插件注册 `proof_checkpoint` 工具与同错复现守卫，其余是标准工具配置。

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
dsh plugin --profile desktop add file:C:/path/to/local-dsh-proof-preset-1.1.0-beta.1.tgz
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
| `cordis.patch.yml` | 声明 `@deepseek-ai/dsh-agent-preset`（`id: proof`、`order: 6`）及其子插件：persona、`memory.cjs`、`dsh-tool-fs`/`-pwsh`/`-jobs`/`-skill` 等 |
| `memory.cjs` | Cordis 插件：注册 `proof_checkpoint`（save/read/clear），并用 `ctx.tools.guard` + `agent/pre-step` 钩子处理重复失败 |

## 行为说明

两次相同参数的工具调用连续报告相同文本错误时，下一步会提醒换路。三次后会拦下相同调用。如果继续撞上同一拦截两次，下一个模型步骤会结束本轮。新用户轮次重新计数，其他正常工具操作成功也会解除这段连续失败记录。模型自己发现的 WA、成功退出却没有进展等情况由模式规则处理。

`proof_checkpoint` 支持 save、read、clear，在同一会话中保存最多 800 字符的断点。继续工作和压缩后会重新提示已保存的断点。切换任务时清除当前断点；原工具调用仍属于 DSH 的会话历史。全新独立会话从空断点开始。

## 许可

MIT。persona 与工具子树基于 DeepSeek Harness 的 `standard` 组合派生，见 `LICENSE`。
