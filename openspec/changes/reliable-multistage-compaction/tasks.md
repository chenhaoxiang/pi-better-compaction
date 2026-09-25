# Tasks

## 1. High priority: prove the safe boundary

- [ ] 1.1 Add provider-free local HTTP and Pi hook tests showing that `ctx.abort()` on a pending native checkpoint prevents the first incompatible request from reaching the server; verify both zero received requests and a visible aborted result.
- [ ] 1.2 Add characterization tests for first/repeated native compaction, retain-none, fork, prior non-native summary, and omitted/replaced `context_edit` entries; verify the portable source contains exactly the projected hidden messages, no kept/tail duplication.

## 2. High priority: implement native-first continuity and accounting

- [x] 2.1 Add backwards-compatible ordered `additionalCompactionModels` config and a non-abort fallback loop after native failure; verify Kimi-first, secondary success, abort stop, and all-fail Pi-default cases.
- [ ] 2.2 Make native V2 replay/compaction live-tail serialization honor Pi context edits; verify omission/replacement tests pass and original tool-call/result pairing remains intact.
- [ ] 2.3 Implement bounded, on-demand portable summarization at the first incompatible-model request, persist one branch-bound custom summary, preserve native replay on switch-back, and stop unsafe cache warming; verify reload, fork, repeated compaction, switch-without-request, and failed-summary abort tests.
- [x] 2.4 Map valid V1/V2 provider token usage into Pi `CompactionResult.usage` with model pricing; verify usage/missing-usage tests and document that later lazy calls cannot yet enter Pi `/session` totals through the public extension API.
- [ ] 2.5 Run `openspec validate reliable-multistage-compaction --strict --no-interactive`, all provider-free tests and diff checks; prepare a high-priority fork PR, obtain one fresh-context Kimi K3 read-only review tied to the exact head, resolve blockers, then merge and pin-install only after all safety gates pass.

## 3. Medium priority: retries and test infrastructure, after high priority is in fork main

- [ ] 3.1 Classify terminal SSE failures separately from transient pre-completion transport errors and bound retries without duplicate calls for explicit failures; verify targeted fetch-count and abort tests.
- [ ] 3.2 Replace the live-model `pi -p` smoke with a provider-free extension-load/runtime smoke, and add a real Pi converter compatibility test; verify the suite runs without credentials or network model calls.
- [ ] 3.3 Define and test an honest baseline-pinned coverage non-regression policy plus focused new-code checks; add a GitHub CI workflow using only provider-free tests, and verify the current baseline and a deliberately regressed fixture produce the expected pass/fail outcomes.
- [ ] 3.4 Validate OpenSpec, run local CI-equivalent commands, obtain one fresh-context Kimi K3 read-only review of the medium-priority head and gate-policy diff, resolve blockers, then merge and pin-install the new fork main commit; verify config points only to the fork and the previous known-good commit remains a rollback ref.
