# pi-better-compaction

English | [中文](README.zh-CN.md)

A [pi](https://github.com/earendil-works/pi) extension that prioritizes provider-native context compaction and preserves safe cross-model continuation:

1. **OpenAI Responses APIs**, including supported GitHub Copilot models, use the provider's native compaction endpoint. The opaque checkpoint is the preferred same-model context.
2. On native failure, configured text models run in order; Pi's default compaction is the final pre-checkpoint fallback.
3. Only when an incompatible model actually makes a request after native compaction, the extension prepares and persists a portable summary from the active raw session branch. Merely switching models does not call a summarizer.

Failures *before* native compaction fall back. Once an opaque checkpoint exists, a request that cannot replay it or safely generate a portable summary is **aborted**, never silently sent with a placeholder history.

## Install

```bash
# Install this fork; replace main with a reviewed commit SHA to pin its behavior.
pi install git:github.com/chenhaoxiang/pi-better-compaction@main
```

The upstream npm package `@lll9p/pi-better-compaction` is a separate release and may not contain this fork's changes. After installation, run `/reload`.

## Requirements

- **pi** ≥ 0.87.1 (`@earendil-works/pi-coding-agent >= 0.87.1`); the earlier 0.84.3 runtime lacks the public session-projection export required for edit-aware portability.

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
| `enabled` | `boolean` | `true` | Set `false` to stop new native/fallback compaction and replay. A prior opaque-only checkpoint still triggers the safety abort guard; disabling cannot make its placeholder a real summary. |
| `compactionVersion` | `"v1" \| "v2"` | `"v2"` | Protocol for Responses-family APIs. **V2** (streaming, encrypted blob) is the current OpenAI default. **V1** uses the legacy `/responses/compact` endpoint. |
| `compactionModel` | `string \| null` | `null` | First text fallback after native failure and first portable summarizer on an actual incompatible-model request. Format: `"provider/model-id"`; `null` skips this candidate. |
| `additionalCompactionModels` | `string[]` | `[]` | Additional text summarizers tried in order after `compactionModel`, before Pi's default/current model. Invalid entries are skipped with warnings; duplicates are attempted once. |
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

Model entries are explicit provider/model choices. Do not put an untrusted relay in this list unless its own directory and content policy permits it.

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

2. **Not a Responses API, or native compact failed before any opaque checkpoint** → try `compactionModel`, then `additionalCompactionModels` in order using Pi's text `compact()`. On success stop; on abort cancel; if all configured models fail, Pi's default compaction receives the still-full context. **If a prior opaque checkpoint exists and a new native attempt fails**, rebuild the full pending history from raw session entries and try the configured portable summarizers followed by the current model; if all fail, cancel instead of asking Pi to summarize a marker.

3. **After a native checkpoint, on the first actual incompatible-model request** → rebuild the branch's hidden history with Pi context edits, produce a bounded portable text summary with the same configured model order (then the selected model), and persist it as branch-sensitive non-context state. On subsequent requests reuse it; on the original model keep native replay. If summarization or replay cannot proceed safely, abort the request and keep the session intact.

Selection is by API type, not provider — any compatible Responses API gets a native attempt. Native V1/V2 usage enters Pi's compaction totals when the provider reports it. On-demand portable-summary usage is stored with its custom session entry for audit but cannot currently enter Pi `/session` totals through the read-only extension session API.

**Do not uninstall or downgrade this fork while an active session depends on an opaque checkpoint.** Removing the extension also removes its request guard; an older version can send the placeholder without the hidden context. Finish or verify a portable continuation first, or keep the pinned version for that session.

## Debugging

Enable debug artifacts:

```json
{
  "debug": true,
  "logCompactResponses": true
}
```

Then `/reload`, run `/compact`, send a follow-up message, and inspect. Debug artifacts can still contain prompts and tool output even with key-pattern redaction; keep them private:

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
# Provider-free unit/contract and loopback-abort checks
bun test ./src ./test/runtime.test.ts ./test/provider-abort.test.ts
```

The older `test/pi-smoke.test.ts` still sends a model prompt and is not part of this offline command; the medium-priority test-infrastructure PR will replace it. The existing 100%-coverage checker also fails on the untouched baseline and is not a passing gate.

## License

MIT
