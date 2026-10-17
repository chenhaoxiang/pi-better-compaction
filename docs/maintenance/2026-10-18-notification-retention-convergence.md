---
doc_type: report
project: pi-better-compaction
status: active
truth_mode: maintained
created: 2026-10-18
owner: chx
---

# Notification retention convergence

## Invariant

Pi converts extension `custom` messages into provider-role `user` messages. Provider role alone therefore cannot distinguish a human instruction from a peer status or child completion notice. Native V2 compaction now selects additional plaintext anchors from the active raw session branch: actual user/system messages survive, custom notices do not consume the 65,536-token retention budget.

The full native compaction request is unchanged and includes machine notices, tool evidence and prior opaque checkpoints. Their information remains available to the encrypted compaction result. The extension does not delete raw history, edit an existing checkpoint, infer task acceptance, filter by natural-language prefixes, or classify quoted human text as a machine event. Reprojection preserves context edits and the current branch.

## Regression evidence

- Human text beginning with `**From ...**` remains retained because source role, not wording, is authoritative.
- 500 synthetic custom status notices cannot evict an earlier human acceptance/stop criterion from a 100-token plaintext budget.
- Opaque checkpoints and raw session history remain byte-identical after anchor selection.
- Provider-free full suite: 285 passed, zero failed; coverage collection and frozen baseline gate pass. Isolated Pi RPC loader smoke passes 1/1 without a model request. Exact package/release/installed acceptance remains separate.

## Operational boundary

Only a successful new V2 checkpoint uses the new retention selection. Existing opaque blocks are not rewritten; the raw branch allows the next successful checkpoint to recover actual user anchors. No production provider or private session is used for tests. Installation does not hot-replace an active session; older locked package trees remain available for rollback. Necessary child results and explicit peer requests must still be delivered by their owner extensions.
