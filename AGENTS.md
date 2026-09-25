# Project guidance

This repository is a Pi extension. Keep compaction behavior, provider transport, session persistence, and debug logging compatible with the supported Pi version in `package.json`. Never assume that an opaque native checkpoint is a portable text summary.

## Documentation map

- `README.md` / `README.zh-CN.md`: user installation, configuration, safety limits, and testing commands.
- `openspec/changes/reliable-multistage-compaction/`: current behavior contract (`specs/reliable-compaction/spec.md`), design rationale, and high-then-medium delivery tasks. This is the owner change for the native-first, lazy-portability, and ordered-fallback work; do not create a competing spec.
- `src/` and `test/`: implementation and provider-free regression tests. `test/pi-smoke.test.ts` uses isolated RPC state inspection; `test/provider-abort.test.ts` uses a synthetic 127.0.0.1 provider. Neither sends a prompt to a real model.
- `test/coverage-baseline.json`, `scripts/check-lcov.mjs`, `.github/workflows/ci.yml`: pinned coverage non-regression and provider-free CI. Bun reports no branch metric on the recorded baseline; do not call branch coverage green.

Use an isolated branch/worktree for source changes. Validate the exact diff and keep high- and medium-priority PRs separate. Tests and CI must not use a production provider, real API key, or private session data. Run `npm test` and `npm run test:coverage` after installing development dependencies. Strict tsc has pre-existing errors and is not an implemented passing gate. A green test does not prove a real provider, merge, npm publication, or live installation succeeded.
