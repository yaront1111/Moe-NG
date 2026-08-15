# Codex redeclares Claude's observation leaves — never re-export both

Measured 2026-08-13 in `packages/runner`.

`providers/codex/codex-observation.ts` declares its OWN `ObservationClock` (:60),
`PlatformIdentity` (:54), `RuntimeClosureEntry` (:48), `RuntimeClosureKind` (:14),
`RuntimePinningMethod` (:21) and `OBSERVATION_TRUTH_CLASSES` (:23). Every one is
byte-identical in shape and membership to the `providers/claude/claude-observation.ts`
declaration of the same name — the Codex slice copied them rather than importing.

`surface/claude-surface.ts` already roots the Claude copies. So when you publish a
Codex type whose closure reaches these leaves (e.g. `ProbeCodexRuntimeInput`,
`CodexProbeReport`), you must publish ONLY the `Codex*`-prefixed leaves and omit the
shared ones. Re-exporting the Codex copies makes two `export *` surfaces both supply
`ObservationClock`, which ESM resolves by DROPPING the ambiguous binding from the
namespace rather than erroring loudly.

Consumers are unaffected: a `ProbeCodexRuntimeInput` built from the Claude-rooted
`ObservationClock`/`PlatformIdentity` typechecks, because the shapes are identical.

The failure this prevents is invisible in a package-local test that imports relatively;
it only shows up as a missing name in a root-namespace equality test or in a real
child-Node bare-specifier probe. Cheap check before publishing:

    grep -n "export interface ObservationClock\|export interface PlatformIdentity" \
      providers/*/​*-observation.ts

Related: `mem:task-task-fb997625e61f487a9afa1cc56c67687a-handoff`.
