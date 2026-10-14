---
doc_type: guide
project: workspace
status: active
truth_mode: maintained
created: 2026-10-14
verified: 2026-10-14
---

# Read-only compaction diagnostics

`/compaction-status` reports the latest active-branch checkpoint kind, whether an opaque checkpoint has a digest-matching cached portable summary, up to12 returned attempt observations and token observations. `/compaction-status usage` shows only usage. Commands never resolve authentication, send model requests, prepare a portable summary, mutate checkpoints, or certify switch safety. Model/API/endpoint compatibility and raw-history safety are revalidated only on the actual request. No summary, blob, URL, credential or raw error is emitted. Returned response-ok is not proof of persisted checkpoint success. Runtime attempt observations reset at session start or tree navigation; old attempts are not reconstructed across reload. Reason labels use a closed allowlist, with unknown reasons shown as unclassified.

Usage is read only from active branch entries. CompactionEntry usage is already accounted by Pi; lazy custom portable-summary and failed portable-usage entries are separate observations not included in `/session` through the existing extension API. Nested usageRecords on a compaction entry are not added again. Duplicate entry IDs are counted once; omitted/unusable observations are reported, not zero-filled. Counts are partial provider-reported token observations, not estimates of missing calls or a complete bill. Cost remains unpriced/unknown rather than pretending configured zero price means free.

Existing native-first fallback, unsafe-history cancellation, chunk order, checkpoint persistence and transport policies are unchanged. The baseline274 tests pass before changes; all existing assertions remain. New synthetic tests exercise checkpoint kinds, usage separation/invalid counts/duplicates, read-only commands and sanitized failures; regression, baseline coverage and changed-line coverage are required. Real-provider compaction, billing and live TUI/old-session activation remain separate acceptance.
