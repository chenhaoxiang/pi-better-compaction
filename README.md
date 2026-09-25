# pi-better-compaction

English | [中文](README.zh-CN.md)

A [pi](https://github.com/nicepkg/pi) extension that upgrades context compaction with two coordinated strategies:

1. **OpenAI Responses APIs**, including supported GitHub Copilot models, use the provider's native compaction endpoint, preserving opaque context that plain text summaries lose.
2. **All other APIs** (Anthropic, Gemini, etc.) can run pi's built-in compaction with a **dedicated cheaper/faster model**, so summarization doesn't consume quota on your primary model.

Before a native checkpoint is written, configured failures fall through to the next text model and finally to Pi's default compaction. **After** an opaque-only checkpoint, changing models or failing to replay it can still leave only a placeholder summary; a separate continuity change is in progress.

## Install

```bash
# Install this fork; replace main with a reviewed commit SHA to pin its behavior.
pi install git:github.com/chenhaoxiang/pi-better-compaction@main
```

The upstream npm package `@lll9p/pi-better-compaction` is a separate release and may not contain this fork's changes. After installation, run `/reload`.

## Requirements

- **pi** ≥ 0.84.3 (`@earendil-works/pi-coding-agent >= 0.84.3`)

## Configuration

Config file location:

```
~/.pi/agent/extensions/pi-better-compaction/config.json
```

If the file doesn't exist, all defaults apply. The extension never creates this file.

### Defaults

```jsonc
{
  "enabled": true,
  "compactionVersion": "v2",
  "compactionModel": null,
  "additionalCompactionModels": [],
  "compactionThinkingLevel": "off",
  "responsesCompactApis": ["openai-responses", "openai-codex-responses"],
  "allowCompactionContinuityBreak": false,

  // Debug & logging
  "notifyOnLoad": false,
  "debug": false,
  "logProviderPayloads": false,
  "logCompactResponses": false,
  "redactSensitiveData": true,
  "artifactRoot": "~/.pi/agent/artifacts/pi-better-compaction"
}
```

### Options reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Master switch. Set `false` to disable the extension entirely. |
| `compactionVersion` | `"v1" \| "v2"` | `"v2"` | Protocol for Responses-family APIs. **V2** (streaming, encrypted blob) is the current OpenAI default. **V1** uses the legacy `/responses/compact` endpoint. |
| `compactionModel` | `string \| null` | `null` | First fallback model after native failure. Format: `"provider/model-id"`; `null` skips this candidate. |
| `additionalCompactionModels` | `string[]` | `[]` | Additional text models attempted in order after `compactionModel` and before Pi's default. Invalid entries warn and are skipped; duplicates are tried once. |
| `compactionThinkingLevel` | `string` | `"off"` | Thinking level for the fallback compaction model. One of: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `responsesCompactApis` | `string[]` | `["openai-responses", "openai-codex-responses"]` | Which Responses APIs use native compaction. Can only narrow the built-in set; unknown entries are ignored with a warning. |
| `allowCompactionContinuityBreak` | `boolean` | `false` | Allow restarting native compaction when the latest session compaction was created by pi's default path (not this extension). Sacrifices opaque-window continuity at that boundary. |
| `notifyOnLoad` | `boolean` | `false` | Show a notification in the TUI when the extension loads. |
| `debug` | `boolean` | `false` | Write lifecycle and compaction-event debug artifacts. |
| `logProviderPayloads` | `boolean` | `false` | Write `before_provider_request` payload artifacts. |
| `logCompactResponses` | `boolean` | `false` | Write compact endpoint request/response artifacts. |
| `redactSensitiveData` | `boolean` | `true` | Redact secrets in debug artifacts. |
| `artifactRoot` | `string` | `"~/.pi/agent/artifacts/pi-better-compaction"` | Root directory for debug artifacts. Supports `~/` and relative paths (resolved against config dir). |

### Example: ordered text fallbacks

```json
{
  "compactionModel": "codex-local/kimi-k3",
  "additionalCompactionModels": ["codex-local/gpt-5.6-sol"],
  "compactionThinkingLevel": "high"
}
```

Use only explicit provider/model entries permitted by the current session's trust and directory policy.

### Example: force V1 compaction protocol

```json
{
  "compactionVersion": "v1"
}
```

## How it works

When pi triggers compaction (`session_before_compact`):

1. **Responses API detected** → run native compaction (V2 or V1 per config):
   - **V2**: streams a request with `compaction_trigger` to `/responses`; the API returns an encrypted compaction blob. Retained user/developer messages + blob form the compacted context.
   - **V1**: POSTs to `/responses/compact`; receives an opaque compacted window.
   - On success, the compacted window is stored and replayed on subsequent requests via `before_provider_request`.

2. **Not a Responses API, or native compact failed** → try `compactionModel`, then each `additionalCompactionModels` entry in order with Pi's text `compact()`. Success stops the chain and user abort cancels it.

3. **All configured models fail or none is set** → Pi's default compaction receives the still-full pre-checkpoint context.

Selection is by API type, not provider — any compatible Responses API gets a native attempt. When the provider reports V1/V2 compaction usage, it is attached to Pi's compaction entry and counted in session totals.

## Debugging

Enable debug artifacts:

```json
{
  "debug": true,
  "logCompactResponses": true
}
```

Then `/reload`, run `/compact`, send a follow-up message, and inspect:

```
<artifactRoot>/sessions/<session-id>/
├── provider-requests/
├── compact-responses/
├── compaction-events/
└── lifecycle/
```

## Tests

```bash
npm install --ignore-scripts --package-lock=false
# Provider-free unit and contract tests
bun test ./src ./test/runtime.test.ts
```

The existing `test/pi-smoke.test.ts` makes a real model request and is excluded from this offline command. The existing 100%-coverage checker fails on the untouched main baseline; it is not a passing gate until the separate test-infrastructure change.

## License

MIT
