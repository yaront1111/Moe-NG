# Claude runtime adapter — implementation handoff

Task `task-5ff2b39df70c4451ae07a44c92935b42`, worker `worker-29a7f3a3`.
13 files, all under `packages/runner/src/providers/claude/**` and
`packages/testkit/src/providers/claude/**`. Focused gate exit 0
(7 files / 153 tests runner; 17 files / 229 testkit). Repo gate green
(109 files / 1549 passed, 1 skipped).

## Modules

    claude-observation.ts        300  ProviderRuntimeObservation + shared ClaudeFailure
    claude-capabilities.ts       289  closed 11-capability vocabulary + proof rules
    claude-probe.ts              120  probeClaudeRuntime, binds profile <-> observation
    claude-stream-anomalies.ts   265  framing, parsing, anomaly vocabulary, disposition
    claude-stream.ts             215  dual record, bounded retention, effect binding
    claude-render.ts             372  deterministic provider-input render
    claude-cancel-reconcile.ts   131  typed reconciliation outcomes
    testkit claude-golden-streams.ts 262  9-case DEVELOPMENT_ONLY corpus

`claudeFailure` / `ClaudeFailure<Code>` live in claude-observation.ts and are the
shared rejection shape for the whole adapter. Reuse them; do not invent a second.

## The cross-package trick the next adapter will need

Runner tests CANNOT import testkit TS (`rootDir: "src"` + composite -> the file
is outside the project). The corpus is therefore committed as **one JSON
document in a template literal** between two marker comments
(`moe-claude-golden-corpus/1 DATA BEGIN` / `... DATA END`, both exported as
string constants). Runner tests `readFileSync` the module, `lastIndexOf` both
markers, slice, `JSON.parse`. See `claude-stream.test.ts:loadGoldenCorpus`.

**Per-case `sha256` is over the RAW DECODED BYTES, not canonical JSON.** That is
deliberate: it means the reader needs only a sha256 implementation, so runner's
`canonicalJson` and testkit's `canonicalize` never have to agree byte-for-byte.
Making a cross-package gate depend on two independent canonicalizers agreeing
would be a latent trap. Corpus-level stability stays in-package via
`identifyCanonicalEvidence` pinned to `CLAUDE_GOLDEN_CORPUS_DIGEST`.

Verified by red-team: flipping one nibble of a pinned digest fails BOTH suites at
module load with "no tests" — before any assertion consumes the fixture.

## Design decisions that must not be "simplified"

- **Closure is sorted by path before hashing.** Discovery order is not a fact
  about the runtime; letting it into `observationDigest` would make the
  wrapper's pre-activate comparison report drift that never happened. Duplicate
  paths are REFUSED, not deduped.
- **`truthClass` is independent of `pinningMethod`.** An honestly observed
  runtime that cannot be pinned is still honestly observed. The launch question
  is the separate predicate `runtimePinningIsAuthoritative()`.
- **Proof is observation, not claim.** The probe port returns observation
  records; a record that contradicts its own claim proves the OPPOSITE
  (`childrenAfter > 0` -> PROCESS_TREE_TERMINATION UNSUPPORTED). `helpText` is
  carried for diagnostics and proves nothing. RESUME is hard-pinned UNSUPPORTED
  in v1 regardless of what the CLI advertises.
- **`ClaudeProbeReport` fields are required and nullable, never optional.** With
  `exactOptionalPropertyTypes`, an omitted field would read as a deliberate
  absence — a port that forgot to observe something would look like one that
  proved it absent.
- **GAP is computed over the SET of sequences, not delivery order**, or
  out-of-order delivery (1,3,2) falsely raises GAP. A malformed record COUNTS as
  occupying a slot, or (1, unreadable, 3) invents a gap. COUNTER_REGRESSION
  suppresses gap analysis entirely — contiguity is undefined across a restart.
  The first record establishes the origin and is never gap-checked, so
  RESUME_DISCONTINUITY keys on an explicit `resumedFrom`, never on "first seq
  != 1".
- **UNKNOWN_SCHEMA is NOT PROVIDER_CAPABILITY_CHANGED.** The latter is the
  wrapper's pre-activation refusal; a test asserts that string appears nowhere in
  a serialized record.
- **Retention is bounded; digest coverage is not.** Over 16 MiB flips to
  `{kind:"ARTIFACT_REF", artifactRequired:true}` while sha256/byteLength still
  span every byte. When the stream overflows, per-event `lineBase64` is
  suppressed too — 16k events of base64 would have reintroduced the unbounded
  buffer through the back door.
- **`renderedBase64`, never a Uint8Array.** `Object.freeze` throws on a
  non-empty typed array AND runner's `deepFreeze` treats one as a plain record,
  so a bytes field inside a frozen record crashes at construction. Same reason
  @moe/skills uses `contentBase64`.
- **Render output has no command/effect/lease field to set.** A test asserts the
  EXACT sorted key list, so a future field that could carry authority breaks the
  test rather than slipping in.

## Hardening added during adversarial self-review (all had no failing test first)

- `MAX_FRAMED_LINES` 262_144 -> `CLAUDE_STREAM_EVENT_LIMIT_EXCEEDED`. The events
  array was unbounded on a >16 MiB capture even though raw retention was capped.
- `MAX_MIRRORED_SKILLS` 16 / `MAX_MIRRORED_SKILL_FILES` 64 ->
  `CLAUDE_RENDER_SKILL_SNAPSHOT_LIMIT`. Advisory bytes were concatenated BEFORE
  the context limit could reject them, so the limit was not a memory bound.
- Tokenizer port wrapped in try/catch -> `CLAUDE_RENDER_CONTEXT_LIMIT_UNKNOWN`.
  A caller exception was escaping a function whose contract is typed refusal.
- `normalizeClosure` guards non-array closure and non-record entries. A lying
  probe port crashed on `.length` instead of returning a typed failure.
- Mandatory size checked BEFORE framing (framing only grows the payload).

## No @moe/skills dependency

`claude-render.ts` mirrors `SkillRendererInput` structurally with the version
literal `moe-skill-renderer-input/1` pinned. A dependency would touch
`packages/runner/package.json` (outside owned paths) and make runner the first
dependent of a package it needs only a shape from. Drift is caught by the
version-literal refusal. See `mem:task-task-eca1a82ffa844c679d25a60ad8bd165e-handoff`
for the shape (`contentBase64` is PER-FILE, two levels down).

`packages/testkit/src/index.ts` was NOT touched (outside owned paths), so the
corpus is not on the testkit entrypoint and needs no `.js` shim.

## Supervisor fence

Zero `child_process` / `spawn(` / `.kill(` / `Date.now` / `Math.random`.
Cancellation is an INPUT and process death is a caller-supplied observation
(`EXITED{code} | SIGNALLED{signal} | UNOBSERVED`). Launch locks, job-object death
proof, ARMED/SUSPECT, pinning EXECUTION and relaunch belong to
`task-312c1de3` (`packages/runner/src/supervisor/**`), which hard-depends on
this task. The only ARMED/SUSPECT/effect.activate strings in the tree are doc
comments stating the fence is not crossed.

## Auto-commit swept every file — see `mem:gotcha-moe-wrapper-autocommit`

I never ran `git commit`. The harness swept all 13 files into THREE foreign
tasks' commits: `4e8ac7c` (Policy approval core), `f8db0a5` (Planning run
contract decomposition), `d6c7bcf` (Foundation executable specification). By the
time step 7 reached its explicit-pathspec commit there was nothing left to
commit, so no commit of mine exists.

Content is intact — `git show HEAD:<path> | sha256sum` equals the working tree
for all 13, and the CRLF fixture round-trips byte-exact from the committed blob
(cases=9, digestMismatches=0, crlfPairsInComplete=3). Only attribution is wrong.
History was NOT rewritten: the epic rails forbid reset and rewriting shared
commits is destructive.

**QA: `git log --oneline -- packages/runner/src/providers/claude` shows foreign
task IDs. That is harness behavior, not worker drift, and a qa_reject cannot fix
it.** Diff `d6c7bcf` for the bulk of the work.
