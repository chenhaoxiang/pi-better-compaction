# Proposal

## Why

A successful OpenAI native V2 compaction stores an opaque checkpoint but only a placeholder as Pi's portable summary. When a later request uses another model, or native replay fails, the extension can silently send that placeholder instead of the compacted history. Native usage is also omitted from Pi session totals, while failures do not yet have a configurable ordered fallback beyond one model.

## What Changes

- **High priority:** Keep OpenAI Responses native compaction first. On native failure, try the existing `compactionModel`, then configured additional models in order, then Pi's built-in compaction. Aborts never fall through. Preserve backwards compatibility when the additional list is absent.
- **High priority:** On the first actual request to a model that cannot replay a native checkpoint, reconstruct the active raw session branch with Pi's context-edit semantics, summarize it in bounded chunks using the configured fallback chain, persist a portable summary tied to that checkpoint, and inject that summary into the request. Do not summarize merely on model selection. Reuse the cached summary after reload and preserve native replay if the user switches back. If a safe summary cannot be produced, abort the request rather than sending the opaque-only placeholder. Stop any cache warming that could bypass this guard.
- **High priority:** Map provider-reported V1/V2 native compaction usage to Pi `Usage` and attach it to the compaction result when available. Do not invent usage or claim Pi totals include lazy-summary calls when the public extension API cannot record them; persist their attribution separately.
- **BREAKING compatibility:** Raise the fork's minimum Pi coding-agent version from 0.84.3 to 0.87.1; the official edit-aware session projection export used by lazy recovery does not exist in 0.84.3.
- **Medium priority (after the high-priority PR):** Distinguish terminal provider failures from transient transport failures before retrying, replace network-using smoke tests with provider-free tests, and add an honest executable coverage policy plus GitHub CI. Do not claim the current 100% coverage script passes.

## Capabilities

### New Capabilities
- `reliable-compaction`: Native-first, ordered text fallback, on-demand cross-model portability, failure safety, usage reporting, and deterministic validation.

### Modified Capabilities
- None; this repository has no existing OpenSpec capabilities.

## Impact

`src/config.ts`, `src/types.ts`, `src/extension-runtime.ts`, `src/native-fallback.ts`, `src/payload-rewrite.ts`, native compact clients, and their tests. Medium priority adds test and CI paths. The package remains a Pi extension; no Pi core modifications, npm publication, real-provider calls, or production data are in scope. Additional summarization cost occurs only after native failure or on the first actual incompatible-model request. Work is delivered as separate high- and medium-priority fork PRs, each with independent Kimi K3 review and local gates before installation of a pinned fork commit.
