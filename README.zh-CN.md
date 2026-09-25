# pi-better-compaction

[English](README.md) | 中文

一个 [pi](https://github.com/nicepkg/pi) 扩展，通过两条协同策略提升上下文压缩效果：

1. **OpenAI Responses 系列 API** 使用提供商原生压缩端点，保留纯文本摘要无法留存的不透明上下文。
2. **其他所有 API**（Anthropic、Gemini 等）可用一个**独立的低成本模型**执行 pi 内置压缩，避免在主模型上消耗额度。

写入原生 checkpoint **之前**，失败会按配置逐级降级，最后由 Pi 默认压缩接管。写入不透明 checkpoint **之后**，切模型或回放失败仍可能只留下占位摘要；跨模型连续性会在下一批高优先级改动中单独修复。

## 安装

```bash
# 安装本 fork；需要固定行为时把 main 换成审核过的提交 SHA。
pi install git:github.com/chenhaoxiang/pi-better-compaction@main
```

上游 npm 包 `@lll9p/pi-better-compaction` 是独立发布版本，不一定包含本 fork 的修复。安装后执行 `/reload` 生效。

## 要求

- **pi** ≥ 0.84.3（`@earendil-works/pi-coding-agent >= 0.84.3`）

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
| `enabled` | `boolean` | `true` | 总开关。设为 `false` 完全禁用扩展。 |
| `compactionVersion` | `"v1" \| "v2"` | `"v2"` | Responses 系列 API 的压缩协议。**V2**（流式，加密 blob）是 OpenAI 当前默认协议；**V1** 使用旧版 `/responses/compact` 端点。 |
| `compactionModel` | `string \| null` | `null` | 原生失败后的第一文本回退模型，格式为 `"provider/model-id"`；`null` 表示跳过此候选。 |
| `additionalCompactionModels` | `string[]` | `[]` | 在 `compactionModel` 之后按顺序尝试的其他文本模型，最后才由 Pi 默认压缩接管。无效项会告警跳过，重复项只试一次。 |
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

只填写当前会话和目录政策允许的提供商/模型；写进回退列表不等于获得不受信中转渠道使用许可。

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

2. **非 Responses API，或原生压缩失败** → 依次尝试 `compactionModel` 和 `additionalCompactionModels`，使用 Pi 的文本 `compact()`；成功就停，用户中止就取消。

3. **所有配置模型都失败或没有配置** → Pi 默认压缩处理尚未写入 checkpoint 的完整上下文。

原生压缩按 API 类型而非提供商判断。V1/V2 提供商确实返回用量时，会附在 Pi 的压缩条目上并进入会话统计。

## 调试

启用调试文件输出：

```json
{
  "debug": true,
  "logCompactResponses": true
}
```

然后 `/reload`，执行 `/compact`，发送一条后续消息，检查：

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
# 不访问真实模型的单元与合同测试
bun test ./src ./test/runtime.test.ts
```

现有 `test/pi-smoke.test.ts` 会向模型发请求，不包含在这条离线命令中。全仓 100% 覆盖率检查在未改的 main 基线上就失败；测试设施独立改动完成前，不能称该门禁已通过。

## 许可证

MIT
