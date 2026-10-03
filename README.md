# pi-better-compaction

English | [中文](README.zh-CN.md)

A maintained fork of [`pi-better-compaction`](https://github.com/lll9p/pi-better-compaction) for Pi. It keeps provider-native compaction when possible and adds a safe, observable path for continuing a session after the active model changes.

> Fork repository: <https://github.com/chenhaoxiang/pi-better-compaction>
>
> This README describes the fork on `main`. The upstream npm package and the fork are separate release lines.

## What this fork does

The extension uses a native-first compaction strategy:

1. **Responses APIs** use the provider's native compaction endpoint. The opaque checkpoint is the preferred context for the same model.
2. **Before an opaque checkpoint exists**, configured text models are attempted in order; Pi's default compaction remains the final fallback.
3. **After a native checkpoint**, the fork waits until an incompatible model actually makes a request before generating a portable summary. Merely switching models does not spend a summarization request.
4. If the opaque checkpoint cannot be replayed and a safe portable summary cannot be produced, the request is aborted rather than sent with a placeholder history.

Fork-specific improvements include:

- ordered `localCompactionModels` priorities for installations with several local providers;
- configurable text fallback and portable-summary candidates with deterministic ordering;
- visible portable-summary chunk progress in the Pi status bar;
- serializer and replay fixes for mixed-model history, tool results, and system messages;
- redacted debug artifacts with explicit session and provider-request boundaries.

## Install this fork

Install the maintained fork rather than the similarly named upstream npm package:

```bash
pi install git:github.com/chenhaoxiang/pi-better-compaction@main
```

For reproducible behavior, pin a reviewed commit instead of `main`:

```bash
pi install git:github.com/chenhaoxiang/pi-better-compaction@<reviewed-commit>
```

Restart Pi or run `/reload` after installation. Do not remove or downgrade the extension while an active session depends on an opaque checkpoint; the older runtime may not be able to reconstruct the hidden context.

## Requirements

- Pi with `@earendil-works/pi-coding-agent` **0.87.1 or newer**;
- a Node runtime supported by the installed Pi;
- no provider credential or network probe is required during extension startup.

## Configuration

The optional configuration file is:

```text
~/.pi/agent/extensions/pi-better-compaction/config.json
```

The extension does not create this file. With no file, the defaults below apply:

```jsonc
{
  "enabled": true,
  "compactionVersion": "v2",
  "compactionModel": null,
  "additionalCompactionModels": [],
  "localCompactionModels": [],
  "compactionThinkingLevel": "off",
  "responsesCompactApis": ["openai-responses", "openai-codex-responses"],
  "allowCompactionContinuityBreak": false,
  "notifyOnLoad": false,
  "debug": false,
  "logProviderPayloads": false,
  "logCompactResponses": false,
  "redactSensitiveData": true,
  "artifactRoot": "~/.pi/agent/artifacts/pi-better-compaction"
}
```

| Option | Purpose |
| --- | --- |
| `enabled` | Disable new compaction work while retaining the safety guard for an existing opaque checkpoint. |
| `compactionVersion` | Select the Responses protocol, `v1` or `v2`; `v2` is the default. |
| `compactionModel` | First explicit text fallback and first portable-summary candidate, in `provider/model` form. |
| `additionalCompactionModels` | Additional text candidates attempted in order. |
| `localCompactionModels` | Ordered `{ modelId, thinkingLevel }` priorities for registered providers whose name contains `local`. |
| `compactionThinkingLevel` | Thinking level for the legacy explicit-provider fallback. |
| `responsesCompactApis` | Narrow the built-in set of APIs that receive a native attempt. |
| `allowCompactionContinuityBreak` | Allow a new native attempt after a checkpoint created by Pi's default compaction; this trades away opaque-window continuity. |
| `debug` / logging options | Write lifecycle, request, and compact-response artifacts. Keep the artifact directory private. |
| `redactSensitiveData` | Redact key-like values in debug artifacts; keep this enabled unless a controlled local investigation requires otherwise. |
| `artifactRoot` | Change the local debug-artifact root. |

Example ordered fallback configuration:

```json
{
  "compactionModel": "codex-local/kimi-k3",
  "additionalCompactionModels": ["codex-local/gpt-5.6-sol"],
  "compactionThinkingLevel": "high"
}
```

Example local model-ID priorities:

```json
{
  "localCompactionModels": [
    { "modelId": "gpt-6-sol", "thinkingLevel": "max" },
    { "modelId": "kimi-k3", "thinkingLevel": "max" },
    { "modelId": "gpt-6-astra", "thinkingLevel": "high" }
  ]
}
```

Native compaction still runs first. The `local` provider-name filter is only a selection convention; it is not proof that a provider is local or trusted.

## Safety boundaries

- A fallback candidate is used only when the current compaction attempt failed before it produced a usable checkpoint.
- A portable summary is generated only for an actual incompatible-model request after native compaction.
- If raw session history cannot be rebuilt or the candidate chain cannot produce a safe summary, the request fails closed.
- The extension never writes Pi's `settings.json`, `models.json`, or session history outside its own extension state and debug artifacts.
- Debug artifacts can contain prompts, tool output, and provider payloads. Store them locally and treat them as sensitive even when redaction is enabled.

## Debugging

Enable local artifacts, then reload and exercise compaction:

```json
{
  "debug": true,
  "logCompactResponses": true
}
```

Run `/reload`, invoke `/compact`, switch to an incompatible model, and inspect:

```text
<artifactRoot>/sessions/<session-id>/
├── provider-requests/
├── compact-responses/
├── compaction-events/
└── lifecycle/
```

## Development and tests

Tests are provider-free and must not use production credentials or private session data:

```bash
npm install --ignore-scripts --package-lock=false
npm test
npm run test:coverage
npm run test:pi
```

The coverage command checks the repository's pinned non-regression baseline. A passing local test suite does not by itself prove a real-provider run, a Git merge, or a published package.

## License

MIT
