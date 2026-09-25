# pi-better-compaction

[English](README.md) | 中文

一个 [Pi](https://github.com/earendil-works/pi) 上下文压缩扩展，优先使用提供商原生能力，同时保护切模型后的历史连续性：

1. **OpenAI Responses 系列 API**（含支持的 GitHub Copilot 模型）优先使用原生压缩。同一模型继续会话时，以加密 checkpoint 保留上下文。
2. 原生压缩失败后，按配置顺序尝试文本摘要模型；全部失败才交给 Pi 默认压缩。
3. 原生压缩成功后，只有真正向不兼容模型发出请求时，才从当前会话分支的原始历史生成可移植摘要；仅切换模型不会额外调用摘要模型。

**生成 checkpoint 之前**可以逐级降级；**生成之后**若无法安全回放或生成可移植摘要，请求会中止，不会把占位文本当成完整历史悄悄发给模型。

## 安装

```bash
# 安装本 fork；需要固定行为时把 main 换成审核过的提交 SHA。
pi install git:github.com/chenhaoxiang/pi-better-compaction@main
```

上游 npm 包 `@lll9p/pi-better-compaction` 是独立发布版本，不一定包含本 fork 的修复。安装后执行 `/reload` 生效。

## 要求

- **Pi** ≥ 0.87.1（`@earendil-works/pi-coding-agent >= 0.87.1`）。旧版 0.84.3 没有按需恢复历史所需的公开会话投影接口。

## 配置

配置文件路径：

```
~/.pi/agent/extensions/pi-better-compaction/config.json
```

文件不存在时使用默认值。扩展不会自动创建此文件。

### 默认配置

```jsonc
{
  "enabled": true,
  "compactionVersion": "v2",
  "compactionModel": null,
  "additionalCompactionModels": [],
  "compactionThinkingLevel": "off",
  "responsesCompactApis": ["openai-responses", "openai-codex-responses"],
  "allowCompactionContinuityBreak": false,

  // 调试与日志
  "notifyOnLoad": false,
  "debug": false,
  "logProviderPayloads": false,
  "logCompactResponses": false,
  "redactSensitiveData": true,
  "artifactRoot": "~/.pi/agent/artifacts/pi-better-compaction"
}
```

### 配置项说明

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | `boolean` | `true` | 设为 `false` 可停用新压缩与原生回放；若当前会话已有只含占位摘要的原生 checkpoint，安全中止保护仍生效，不能把占位文本当真实摘要发送。 |
| `compactionVersion` | `"v1" \| "v2"` | `"v2"` | Responses 系列 API 的压缩协议。**V2**（流式，加密 blob）是 OpenAI 当前默认协议；**V1** 使用旧版 `/responses/compact` 端点。 |
| `compactionModel` | `string \| null` | `null` | 原生失败后的第一文本回退模型，也是实际跨模型请求时首个可移植摘要候选。格式为 `"provider/model-id"`；`null` 表示跳过此候选。 |
| `additionalCompactionModels` | `string[]` | `[]` | 在 `compactionModel` 之后依次尝试的其他文本模型，最后才用 Pi 默认/当前模型。无效项会告警跳过，重复项只试一次。 |
| `compactionThinkingLevel` | `string` | `"off"` | 回退压缩模型的思考级别。可选：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。 |
| `responsesCompactApis` | `string[]` | `["openai-responses", "openai-codex-responses"]` | 启用原生压缩的 Responses API 列表。只能缩小内置集合，不能添加新值。 |
| `allowCompactionContinuityBreak` | `boolean` | `false` | 当会话最近一次压缩不是本扩展创建的时，是否允许重新开始原生压缩。会在该边界处牺牲不透明窗口的连续性。 |
| `notifyOnLoad` | `boolean` | `false` | 扩展加载时在 TUI 中显示通知。 |
| `debug` | `boolean` | `false` | 写入生命周期和压缩事件的调试文件。 |
| `logProviderPayloads` | `boolean` | `false` | 写入 `before_provider_request` 请求体调试文件。 |
| `logCompactResponses` | `boolean` | `false` | 写入压缩端点的请求/响应调试文件。 |
| `redactSensitiveData` | `boolean` | `true` | 在调试文件中脱敏。 |
| `artifactRoot` | `string` | `"~/.pi/agent/artifacts/pi-better-compaction"` | 调试文件根目录。支持 `~/` 和相对路径（相对于配置文件目录解析）。 |

### 示例：按顺序配置文本回退模型

```json
{
  "compactionModel": "codex-local/kimi-k3",
  "additionalCompactionModels": ["codex-local/gpt-5.6-sol"],
  "compactionThinkingLevel": "high"
}
```

模型条目必须明确指定提供商和型号；不受信中转渠道仍须遵守其目录及内容隔离规则，不能仅因写进回退列表就获得使用许可。

### 示例：强制使用 V1 压缩协议

```json
{
  "compactionVersion": "v1"
}
```

## 工作原理

pi 触发压缩时（`session_before_compact`）：

1. **检测到 Responses API** → 执行原生压缩（根据配置选择 V2 或 V1）：
   - **V2**：向 `/responses` 端点发送携带 `compaction_trigger` 的流式请求，API 返回加密压缩 blob。保留的用户/开发者消息 + blob 组成压缩后的上下文。
   - **V1**：POST 到 `/responses/compact`，接收不透明的压缩窗口。
   - 成功后，压缩窗口被存储，后续请求通过 `before_provider_request` 钩子回放。

2. **非 Responses API，或原生压缩失败** → 按顺序调用 `compactionModel`、`additionalCompactionModels` 执行 Pi 的文本 `compact()`；成功即停，用户中止则取消，全部失败后让 Pi 默认压缩处理仍完整的原始上下文。

3. **原生压缩之后第一次实际请求不兼容模型** → 按 Pi 的上下文编辑规则重建被隐藏的历史，分块生成文本摘要并存入当前分支；后续复用。切回原模型仍使用原生 checkpoint。若重建、摘要或原生回放失败，请求会明确中止，保留原会话以便重试。

原生压缩按 API 类型而非提供商判断。提供商报告的 V1/V2 原生用量会进入 Pi 压缩统计；按需生成的可移植摘要用量记在扩展的会话条目中，但受 Pi 当前只读扩展接口限制，暂不计入 `/session` 总量。

**会话仍依赖加密 checkpoint 时，不要直接卸载或降级本 fork。** 卸载会连同请求保护一起移除，旧版可能只把占位文本发给模型。应先结束会话、核实可移植摘要能继续使用，或暂时保留该会话所需的锁定版本。

## 调试

启用调试文件输出：

```json
{
  "debug": true,
  "logCompactResponses": true
}
```

然后 `/reload`，执行 `/compact`，发送后续消息并检查。即使启用键名脱敏，调试文件仍可能包含提示词和工具输出，请妥善保管：

```
<artifactRoot>/sessions/<session-id>/
├── provider-requests/
├── compact-responses/
├── compaction-events/
└── lifecycle/
```

## 测试

```bash
npm install --ignore-scripts --package-lock=false
# 不访问真实模型的单元、合同及本机回环 abort 测试
bun test ./src ./test/runtime.test.ts ./test/provider-abort.test.ts
```

旧的 `test/pi-smoke.test.ts` 仍会发送模型请求，不包含在上述离线命令内；中优先级的测试设施 PR 将替换它。现有要求全仓 100% 覆盖率的脚本在未改基线上也失败，不能算通过门禁。

## 许可证

MIT
