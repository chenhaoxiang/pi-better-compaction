---
doc_type: runbook
project: pi-better-compaction
status: active
truth_mode: maintained
created: 2026-10-21
verified: 2026-10-21
verification_scope: pinned SDK source, provider-free local validation and explicit delivery boundaries
owner: chx
---

# Pi 1.3 development SDK baseline

Development and provider-free tests use the verified immutable `v1.3.0-fork.1` SDK assets from `chenhaoxiang/pi`, not registry 0.87.1. Exact tarball URLs and transitive Pi overrides are committed with an npm lockfile; CI uses `npm ci --ignore-scripts`. Runtime Pi packages remain host-provided peers, never bundled dependencies. The minimum supported coding-agent peer is now `>=1.3.0-fork.1`; this change does not claim compatibility with older hosts.

The pinned SDK exposed one real parity difference: Pi 1.3 drops foreign-model reasoning rather than converting it into visible assistant text. The local Responses serializer now follows that rule while preserving visible answers and same-model signed/redacted reasoning. Raw sessions, encrypted checkpoints, lazy portability, fallback, retention and usage accounting remain intact. The independent SDK converter is the parity oracle; explicit assertions also check that foreign reasoning is absent and native signatures survive.

Validation: the full provider-free suite and coverage baseline pass; changed executable serializer lines are covered. Tests include isolated RPC loading, abort-before-provider, actual session projection and mixed-model converter parity. Branch coverage has no baseline and is not claimed. Strict tsc remains an existing non-passing, non-gated check; this work does not broaden it into a type cleanup.

`test/sdk-baseline.test.ts` binds declared and installed SDK identity to the exact locked release, including transitive peers and integrity. Source/PR/CI evidence belongs to the associated PR; no version bump, Release, installation or live-session reload is performed. Existing immutable releases and old installation files are unchanged.
