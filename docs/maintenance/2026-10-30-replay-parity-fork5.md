---
doc_type: report
project: pi-better-compaction
status: active
truth_mode: maintained
created: 2026-10-30
verified: 2026-10-30
verified_by: manual
owner: chx
verification_scope: exact merged main, provider-free tests, Pi 1.3/1.4 isolated loader, loopback replay, release asset and installation bytes
---

# 0.7.4-fork.5 replay parity maintenance

## Scope

`0.7.4-fork.5` is the maintained fork release based on community `0.7.4` and merged source `f6fa6be420f5043afc5cb607774b0e28dd412867` (PR #24). It addresses a native opaque-checkpoint replay false rejection when `context_with_system` adds the exact `pi_subagents_notice` provenance envelope to persisted `subagent-*` / `subagent_*` custom notices at request time.

The fallback is deliberately narrow: exact raw custom-message body/type/content-block order and serialized item count remain required; human messages, arbitrary rewrites, omissions, missing tool outputs and unsafe checkpoint edits remain fail-closed. The actual provider tail is preserved, kept history is not duplicated, and persisted checkpoints are not modified. A bounded `Native replay guard` observation is available through `/compaction-status`; it stores only a closed reason label, not request payloads or checkpoint contents.

## Evidence

- PR #24: https://github.com/chenhaoxiang/pi-better-compaction/pull/24
- Merge: `f6fa6be420f5043afc5cb607774b0e28dd412867`
- Release: https://github.com/chenhaoxiang/pi-better-compaction/releases/tag/v0.7.4-fork.5
- Independent review: exact head `5f64d3b0b810510c8f9286b7ceffa7f07d164b04`, verdict OK with notes, blocker 0, major 0, report-level minor 4 cumulative; first review was before merge and complete-range supplement was after merge/before release.
- Post-merge CI: provider-free workflow run `41067444387` passed.
- Local candidate: `npm test` 302 pass / 0 fail; `npm run test:pi` passed; coverage baseline passed with 34/34 measured changed executable lines covered. No branch-coverage claim.
- Loopback regression: old source aborted with zero HTTP requests; candidate Pi loader + separate request-local provenance handler + production replay hook made exactly one local request containing the opaque blob and annotated tail, omitted the placeholder and kept the checkpoint byte-stable. Both Pi 1.3.0-fork.1 and 1.4.0-fork.2 hosts and both extension load orders passed.
- Fresh release asset: 31/31 package files matched exact merged source; `SHA256SUMS` and manifest passed; fresh isolated RPC and loopback smoke passed.
- Installed selection: `git:github.com/chenhaoxiang/pi-better-compaction@v0.7.4-fork.5`; fork.4 package remains preserved for rollback. Existing active Pi sessions were not reloaded or force-restarted.

## Limits and follow-ups

The original private session's actual request payload was not recorded, so real-provider acceptance and end-to-end recovery of that old session remain unverified. The fix is provider-free and does not claim billing or production behavior. A future benchmark may compare native/portable quality, latency and token use on an approved synthetic corpus; it is not a release blocker for this compatibility fix.

The release manifest and package checksums are attached to the immutable GitHub Release. Do not replace the published tarball/tag; future corrections require a new fork revision.
