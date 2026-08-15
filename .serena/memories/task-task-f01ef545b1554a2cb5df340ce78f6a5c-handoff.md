# task-f01ef545b1554a2cb5df340ce78f6a5c — Linux platform observation boundary (DONE -> REVIEW)

worker-4e85eff4, 2026-08-09. Commit `f6cc227`, 13 files, 1666 insertions. Gate: `pnpm --filter @moe/runner typecheck && pnpm --filter @moe/runner test` -> exit 0, 39 files / 1184 tests.

## What landed
First `packages/runner/src/platform/**` surface. FIVE production modules, not the planned two (the single adapter measured 385 lines; rail says split, not trim):

| file | lines | role |
|---|---|---|
| `platform-contract.ts` | 250 | OS-neutral vocabulary, failure shape, shape gates |
| `linux-facts.ts` | 244 | per-boundary payload classifiers, `PLATFORM_LINUX_LAYER`, `linuxRefusal` |
| `linux-boundary.ts` | 179 | gate ORDER: `classifyLinuxBoundary`, envelope gates, freshness |
| `linux-observation.ts` | 166 | top-level gates, input types, aggregate |
| `platform-instant.ts` | 44 | epoch arithmetic, no `Date` |

Acyclic: `observation -> boundary -> facts -> contract`, `boundary -> instant`. Every `.ts` has its `.js` sibling. `platform/linux/` and `platform/macos/` deliberately NOT created — owned by task-e87a7353 and task-e94b2055.

## Design decisions a follow-up must not undo

**`PlatformFactEnvelope {host, observedAt, truthClass, fact}` is forced by the data, not taste.** Four of the seven composed contracts (`WorkspaceInputManifest`, `MirroredLeaseRecord`, `ClaudeReconciliation`, `CrashClassification`) carry NO host and NO instant. Without the envelope, the "embedded host agrees" and "freshness" gates have nothing to read on them.

**`facts` is an EXACT 7-key record.** Explicit `null` = declared absence (`PLATFORM_FACT_ABSENT`); a MISSING key = coverage gap (`PLATFORM_COVERAGE_INCOMPLETE`). Without this the two codes are the same input. A caller must positively state what it did not observe.

**Hostile-input entry points take `unknown`** (`observeLinuxPlatform(input: unknown)`, `classifyLinuxBoundary(boundary, envelope, context: unknown)`), matching `classifyCrash(inputValue: unknown)` and `parseMirroredLease(value: unknown)`. `PlatformObservation.host` is `PlatformHostIdentity | null` — an unusable host record must not be reported as an invented default.

**`classifyLinuxBoundary` returns `PlatformBoundaryVerdict | PlatformFailure`.** An unusable boundary NAME has no valid `boundary` field to build a verdict around.

**`payloadRejection`'s switch has NO `default`.** The declared return type makes an unhandled eighth boundary a COMPILE error; a default would make it a silent pass.

**A `CrashClassification` of kind `REFUSED` -> `PLATFORM_FACT_UNPROVEN`.** A recovery layer that declined to classify is not evidence about a platform.

## Consumer edge (global rail Clause 1)
- `task-e87a735386f643fe92c0eeff09bc4275` (Linux effect conformance) — real consumer of the Linux facts, owns `platform/linux/**`.
- `task-e94b2055e281489ea9e97820919f6856` (macOS effect conformance) — consumes ONLY the OS-neutral contract, inherits no Linux fact. **Enforced** by the coherent-darwin test, not merely intended.
- Intra-package edge landed here: `index.ts` + a driving test in `index-surface.test.ts`.

## Scope
NO Linux host fact was observed. Host is win32. Ships a boundary, certifies nothing; all host facts stay UNKNOWN until a real-host task observes one.

## See also
`mem:gotcha-off-host-refusal-tests-are-vacuous-by-default`, `mem:gotcha-runner-root-namespace-is-exact-and-drifts`
