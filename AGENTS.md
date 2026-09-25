# Project guidance

This repository is a Pi extension. Keep compaction behavior, provider transport, session persistence, and debug logging compatible with the supported Pi version in `package.json`. Never assume that an opaque native checkpoint is a portable text summary.

## Documentation map

- `README.md` / `README.zh-CN.md`: user installation, configuration, safety limits, and testing commands.
- `openspec/changes/reliable-multistage-compaction/`: current behavior contract (`specs/reliable-compaction/spec.md`), design rationale, and high-then-medium delivery tasks. This is the owner change for the native-first, lazy-portability, and ordered-fallback work; do not create a competing spec.
- `src/` and `test/`: implementation and provider-free regression tests. The older `test/pi-smoke.test.ts` performs a model call until the medium-priority test-infrastructure change replaces it; do not run it as an offline check.

Use an isolated branch/worktree for source changes. Validate the exact diff and keep high- and medium-priority PRs separate. New and CI tests must not use a production provider, real API key, or private session data. The legacy `test/pi-smoke.test.ts` is an explicit pre-existing exception pending replacement, not an offline acceptance gate. A green unit test does not prove a real provider, merge, npm publication, or live installation succeeded.
