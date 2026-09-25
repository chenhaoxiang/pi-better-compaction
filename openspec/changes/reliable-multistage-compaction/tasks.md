# Tasks

## 1. High priority: prove the safe boundary

- [x] 1.1 Add provider-free local HTTP and Pi hook tests showing that `ctx.abort()` on a pending native checkpoint prevents the first incompatible request from reaching the server; verify both zero received requests and a visible aborted result.
- [x] 1.2 Add characterization tests for first/repeated native compaction, retain-none, fork, prior non-native summary, and omitted/replaced `context_edit` entries; verify the portable source contains exactly the projected hidden messages, no kept/tail duplication.

## 2. High priority: implement native-first continuity and accounting

- [x] 2.1 Add backwards-compatible ordered `additionalCompactionModels` config and a non-abort fallback loop after native failure; verify Kimi-first, secondary success, abort stop, and all-fail Pi-default cases.
- [x] 2.2 Make native V2 replay/compaction live-tail serialization honor Pi context edits; verify omission/replacement tests pass and original tool-call/result pairing remains intact.
- [x] 2.3 Implement bounded, on-demand portable summarization at the first incompatible-model request, persist one branch-bound custom summary, preserve native replay on switch-back, and stop unsafe cache warming; verify reload, fork, repeated compaction, switch-without-request, and failed-summary abort tests.
- [x] 2.4 Map valid V1/V2 provider token usage into Pi `CompactionResult.usage` with model pricing; verify usage/missing-usage tests and document that later lazy calls cannot yet enter Pi `/session` totals through the public extension API.
- [x] 2.5 Run `openspec validate reliable-multistage-compaction --strict --no-interactive`, all provider-free tests and diff checks; prepare a high-priority fork PR, obtain one fresh-context Kimi K3 read-only review tied to the exact head, resolve blockers, then merge and pin-install only after all safety gates pass.

## 3. Medium priority: retries and test infrastructure, after high priority is in fork main

- [x] 3.1 Classify terminal SSE failures separately from transient pre-completion transport errors and bound retries without duplicate calls for explicit failures; verify targeted fetch-count and abort tests.
- [x] 3.2 Replace the live-model `pi -p` smoke with a provider-free extension-load/runtime smoke, and add a real Pi converter compatibility test; verify the suite runs without credentials or network model calls.
- [x] 3.3 Define and test an honest baseline-pinned coverage non-regression policy plus focused new-code checks; add a GitHub CI workflow using only provider-free tests, and verify the current baseline and a deliberately regressed fixture produce the expected pass/fail outcomes.
- [x] 3.4 Validate OpenSpec, run local CI-equivalent commands, obtain one fresh-context Kimi K3 read-only review of the medium-priority head and gate-policy diff, resolve blockers, then merge and pin-install the new fork main commit; verify config points only to the fork and the previous known-good commit remains a rollback ref.

### Medium-priority acceptance and handoff (2026-09-26)

- Fork PR [#5](https://github.com/chenhaoxiang/pi-better-compaction/pull/5) merged normally at `1c1781e00656008846029ffed78109a3e35cf005`; both fresh-context Kimi K3 reviews were bound to their candidate heads, and the final `9957364f887f7862f130e4f42a608a3ac4fd6150` review is recorded in the PR comment. The reviewer found no P0/P1 blockers; theoretical quoted-path and out-of-`src/` added-line coverage limits remain P2 notes.
- Local OpenSpec strict validation, 195 provider-free tests, coverage gate (15/15 instrumented added runtime lines, two type-only lines not instrumented), offline Pi help-load, pack dry-run, and diff check passed. GitHub PR CI run [36191098823](https://github.com/chenhaoxiang/pi-better-compaction/actions/runs/36191098823) and merged-main push run [36191228392](https://github.com/chenhaoxiang/pi-better-compaction/actions/runs/36191228392) both passed the same 195 tests and coverage checks.
- Global Pi lists exactly one compaction package, pinned to this fork merge SHA; the installed cache has that HEAD and an isolated synthetic-model RPC `get_state` load passed. Fork canonical local `main` was synchronized ff-only and matches remote main. The prior known-good `481b30ed78b0a44454faafcd3db5e40b558f3424` remains the rollback commit; this is not a claim that a real-provider `/compact` was executed or that existing Pi processes have reloaded.
- Bun 1.4.2 reported no branch coverage metric, so branches are not a green gate. Strict TypeScript still had 21 baseline errors and is not a passing CI check. On-demand portable-summary usage is audit evidence but does not appear in Pi `/session` totals through the current extension API.
