# Why

Machine peer notices and compatibility wake prompts were projected as user messages and retained verbatim through native compaction, while long-running tasks repeatedly woke on status-only events. The operator approved a bounded cross-component fix, not a project-management framework or a reduction of required evidence.

# What Changes

- Pi-subagents and Intercom use native custom trigger turns on supported Pi 1.3+ hosts; older supported hosts keep their hook-preserving compatibility path.
- Intercom defaults ordinary send to context-only; explicit asks/replies, handovers and `wake: true` requests remain actionable and receiver policy remains authoritative.
- Native V2 compaction selects plaintext retention anchors from actual session provenance. Full request and opaque checkpoint safety stay unchanged.
- Existing task IDs, PASS invalidation evidence and BLOCKED status are reused; no new task engine, approval ledger or unconditional background task continuation is added.

# Capabilities

## New Capabilities
- `notification-provenance`: machine events do not masquerade as fresh human requirements or evict human plaintext anchors.

# Impact

Owner change lives in pi-better-compaction; the corresponding owner fixes and validation live in pi-subagents and pi-intercom. Only synthetic/provider-free tests are used. Exact-source PR/release/install and existing-session activation remain separate evidence.
