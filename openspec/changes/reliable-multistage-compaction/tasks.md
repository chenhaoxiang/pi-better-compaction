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

## 4. Follow-up: local model priority and visible method (2026-09-27)

- [x] 4.1 Pin the native-first and legacy fallback behavior, then test exact model-ID matching under `local`-named registered providers, per-model thinking, missing/auth failure and no extra network probe.
- [x] 4.2 Use the same ordered candidates for pre-checkpoint text compaction and post-checkpoint portable summaries; report current/confirmed method in UI while preserving the opaque-marker abort boundary.
- [x] 4.3 Document configuration and its lexical-filter limitation in both READMEs; run strict OpenSpec validation, provider-free tests, coverage patch gate and independent review before proposing a fork PR. Merge/install only after the applicable gate and explicit authorization.

### Local model priority acceptance and handoff (2026-09-27)

- Fork PR [#8](https://github.com/chenhaoxiang/pi-better-compaction/pull/8) merged with the ordinary merge method at `3b81f2ae84ff5872c010ffef94cae3311220f878`; candidate head `aa969dc3d0a0a34c5b92f4711a6d773f937e1ad1` is an ancestor of remote and canonical local `main`. The public fork was unlisted in the workspace S-rating registry, so no AI auto-merge verdict was claimed; the owner explicitly approved this merge and machine-wide installation after reviewing the green PR.
- Fresh-context `codex-local/kimi-k3:max` read-only review checked `0751f43` and then the final `aa969dc` correction. The four non-blocking findings were resolved; no P0/P1 or remaining P2 was reported. Both reviews and their exact-SHA record are in [PR #8's review comment](https://github.com/chenhaoxiang/pi-better-compaction/pull/8#issuecomment-5849786158) (record SHA-256 `489b3176bd3c6bcf5098b84b90acaaa85c76c7f1728bb0c536efadeda3cb6f7f`). This is AI engineering review, not a second human approval.
- Local `npm test` passed 220 provider-free tests; `npm run test:coverage` and the PR patch check passed (121/121 instrumented added source lines, 33 not instrumented; no branch metric); strict OpenSpec validation, `git diff --check`, and `npm pack --dry-run --json` (new helper included) passed. Exact-head [PR CI run 36271006810](https://github.com/chenhaoxiang/pi-better-compaction/actions/runs/36271006810) and [merged-main CI run 36272094114](https://github.com/chenhaoxiang/pi-better-compaction/actions/runs/36272094114) both succeeded. Strict TypeScript was not a passing gate.
- Global Pi has exactly one compaction package, pinned to the fork merge SHA `3b81f2ae84ff5872c010ffef94cae3311220f878`; installed cache HEAD matches. The existing `~/.pi/agent/extensions/pi-better-compaction/config.json` now selects `gpt-6-sol(max) → kimi-k3(max) → gpt-6-astra(high)` by exact model ID under registered `local`-named providers; older explicit-provider config fields remain for rollback. An isolated synthetic-model RPC `get_state` loaded the installed package without a model prompt, and the installed config loader returned all three entries with no warnings. The cache has an untracked `package-lock.json`, left untouched rather than cleaning someone else's work.
- No real-provider `/compact`, real network pre-probe, or cross-model live continuation was executed; current Pi processes require `/reload` to load the installed code. The lexical provider-name filter is not a trusted endpoint check. Avoid downgrading/uninstalling this fork while an active session depends on an opaque checkpoint.

### Medium-priority acceptance and handoff (2026-09-26)

- Fork PR [#5](https://github.com/chenhaoxiang/pi-better-compaction/pull/5) merged normally at `1c1781e00656008846029ffed78109a3e35cf005`; both fresh-context Kimi K3 reviews were bound to their candidate heads, and the final `9957364f887f7862f130e4f42a608a3ac4fd6150` review is recorded in the PR comment. The reviewer found no P0/P1 blockers; theoretical quoted-path and out-of-`src/` added-line coverage limits remain P2 notes.
- Local OpenSpec strict validation, 195 provider-free tests, coverage gate (15/15 instrumented added runtime lines, two type-only lines not instrumented), offline Pi help-load, pack dry-run, and diff check passed. GitHub PR CI run [36191098823](https://github.com/chenhaoxiang/pi-better-compaction/actions/runs/36191098823) and merged-main push run [36191228392](https://github.com/chenhaoxiang/pi-better-compaction/actions/runs/36191228392) both passed the same 195 tests and coverage checks.
- Global Pi lists exactly one compaction package, pinned to this fork merge SHA; the installed cache has that HEAD and an isolated synthetic-model RPC `get_state` load passed. Fork canonical local `main` was synchronized ff-only and matches remote main. The prior known-good `481b30ed78b0a44454faafcd3db5e40b558f3424` remains the rollback commit; this is not a claim that a real-provider `/compact` was executed or that existing Pi processes have reloaded.
- Bun 1.4.2 reported no branch coverage metric, so branches are not a green gate. Strict TypeScript still had 21 baseline errors and is not a passing CI check. On-demand portable-summary usage is audit evidence but does not appear in Pi `/session` totals through the current extension API.
