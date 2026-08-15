# macOS platform observation boundary — worker handoff (DELIVERED)

- Task `task-45d12ecfa6ae4938b23af28fe7876a44`, worker `worker-5dfdc624`. Status REVIEW.
- Commit `13c03d974ef622f39bab54b57c350be52d007772` on `moe/work-2026-08-08`, exactly the 10 owned paths, 1517+/65-.
- Gate: `pnpm --filter @moe/runner typecheck && pnpm --filter @moe/runner test` exit 0, 58 files / 1927 tests.
- Design SHA-256 rechecked at `D:/projexts/moes/docs/plans/2026-08-05-moe-rebuild-design.md` — matches the epic rail. Note the design doc lives in the `moes` repo, NOT in `moe-next`.

## What shipped

- `platform/macos/macos-facts.ts` 249, `macos-boundary.ts` 184, `macos-observation.ts` 170, each with an exact one-line LF `.js` bridge.
- `platform-contract.ts` 250 — `PLATFORM_MACOS` is now the third `PlatformLayer`. Boundaries (7), error codes (9), truth classes (2), observation version all UNCHANGED. Darwin refusals are distinguished by LAYER, never by a duplicated code vocabulary.
- `index.ts` 249 — publishes `MACOS_SUPPORTED_ARCHITECTURES`, `PLATFORM_MACOS_LAYER`, `classifyMacosBoundary`, `observeMacosPlatform` plus `MacosBoundaryFacts / MacosClassificationContext / MacosPathFact / MacosWorkspaceFact / ObserveMacosPlatformInput`. Root namespace count 195 -> 199.

## Shared-helper change future tasks must know about

`snapshotExactRecord` in `platform-contract.ts` was hardened and is used well beyond platform/: `linux-facts`, `linux-boundary`, `linux-observation`, `platform/windows/windows-launch-request.ts`, `providers/claude/claude-launch-selection.ts`, `providers/claude/claude-launcher-input.ts`. It now:
1. counts exactness over `Reflect.ownKeys`, not `Object.keys`;
2. requires each expected key to be an ENUMERABLE own data property;
3. returns null instead of throwing when a reflective call is trapped.
Clause 2 is not optional decoration — without it, moving to `Reflect.ownKeys` NEWLY ACCEPTS a non-enumerable expected field that the old `Object.keys` count happened to reject, i.e. the "hardening" would be a net weakening. Drilled both clauses separately.

`packages/core/src/identity/identity-snapshot.ts` has its OWN unrelated `snapshotExactRecord`. Different function, untouched.

## Consumers

`task-e94b2055e281489ea9e97820919f6856` (archived macOS conformance), `task-22cfca91c5134b24aaf3e5734444fb93` (portability shadow gate), `task-01c5f96ec1e247dc846fd628c929974a` (direct cross-host evidence — was BACKLOG blocked on this, now unblocked).

## Scope line to keep repeating

Deterministic darwin classification BOUNDARY, not live macOS conformance. Every fact is caller-supplied; PROVEN means the supplied darwin observation is coherent, never that a macOS host was observed. Host-native evidence belongs to task-01c5f96.

## State of the tree when I finished

Foreign uncommitted work was live in `apps/daemon/src/recovery/**` and `apps/daemon/src/identity/**` (plus untracked `restore-genesis-classifier.ts/.js`). Not staged, reset or stashed. Pre-existing foreign red, present at my baseline before I wrote a byte: `tests/integration/control-room/control-room-transport.test.ts > "transports a committed read whose payload EQUALS the in-process handler's"` — an 8ms wall-clock diff inside a `seamObservation.reading.value`. Looks like a timing flake, not a real regression.
