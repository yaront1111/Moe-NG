/**
 * The Codex provider seam, curated rather than blanket re-exported.
 *
 * A consumer holding only these names can observe and re-verify a Codex runtime,
 * probe one into a capability profile, read the capability vocabulary, record a
 * raw stream into a bounded record, render a context envelope, and reconcile an
 * observed run into exactly one member of the closed outcome set.
 *
 * NAMING RULE, APPLIED WITHOUT EXCEPTION: every name published here is
 * Codex-distinct. That is not cosmetic. `index.ts` reaches this module through
 * `export *`, and when two star paths supply one name ESM DROPS the binding from
 * the namespace instead of erroring — no compile error, no diagnostic, just a
 * name that silently stops existing. Aliasing by construction makes that
 * unreachable; aliasing case-by-case would only be as complete as the collision
 * list behind it.
 *
 * FAMILY A — 16 provider-neutral names `providers/codex/` REDECLARES rather than
 * imports, all of which `surface/claude-surface.ts` already roots from the Claude
 * copy. Values OBSERVATION_TRUTH_CLASSES, RUNTIME_CLOSURE_KINDS,
 * RUNTIME_PINNING_METHODS, buildProviderRuntimeObservation, observationDigestInput,
 * runtimePinningIsAuthoritative; types BuildObservationInput, BuildObservationResult,
 * ObservationClock, ObservationTruthClass, PlatformIdentity, ProviderRuntimeObservation,
 * RuntimeClosureEntry, RuntimeClosureKind, RuntimePinningMethod and MoeEffectIdentity.
 * Every one is published below under a Codex-prefixed alias. The shapes are
 * identical to the Claude-rooted copies, so a consumer may build a Codex input
 * from either; the aliases exist to keep both reachable, not because they differ.
 *
 * FAMILY B — 10 Codex-prefixed types `surface/recovery-inventory-surface.ts`
 * ALREADY publishes from these same modules: ProbeCodexRuntimeInput,
 * CodexCancelObservation, CodexContextLimit, CodexCwdObservation, CodexProbePort,
 * CodexProbeReport, CodexProcessTreeObservation, CodexRunEnumerationObservation,
 * CodexStructuredSample and CodexTokenizerObservation. They are NOT re-exported
 * here. Re-exporting them would be legal ESM — one binding reached two ways — but
 * it would give one published name two owning seams, and that file is not this
 * task's to own. They remain reachable from the root exactly once.
 *
 * WITHHELD everywhere below: `codexFailure` and `capabilityStatus` (refusal and
 * status constructors — a consumer reads a refusal, it does not mint one),
 * `assessCapabilities` and `capabilitySchemaDigestOf` (the probe applies both
 * itself, and a consumer able to run them separately could assess one report and
 * present another), `isBoundedLabel` and `resolveContextLimit` (internal
 * validators carrying no Codex domain meaning), `UNPROVEN_PROBE_REPORT` (a
 * fixture-shaped constant that must never stand in for a real observation),
 * `frameStream` and `analyzeStream` (the two halves of stream recording, which
 * `recordCodexStream` composes and bounds), and every `MAX_*` bound with the raw
 * framing types `FramedStream`, `ParsedStreamLine` and `StreamAnalysis`.
 */

/**
 * OBSERVATION. `buildCodexRuntimeObservation` is mandatory rather than
 * convenience: a `CodexProviderRuntimeObservation` carries a digest over its own
 * field set and consumers re-verify it, so publishing the type without its
 * builder would publish a type nobody can legally construct.
 * `codexRuntimePinningIsAuthoritative` is the launch-admissibility question a
 * caller must be able to ask before acting on an observation, and
 * `codexObservationDigestInput` is how it re-derives the digest rather than
 * trusting the one it was handed.
 */
export {
  CODEX_OBSERVATION_ERROR_CODES,
  CODEX_RUNTIME_OBSERVATION_VERSION,
  OBSERVATION_TRUTH_CLASSES as CODEX_OBSERVATION_TRUTH_CLASSES,
  RUNTIME_CLOSURE_KINDS as CODEX_RUNTIME_CLOSURE_KINDS,
  RUNTIME_PINNING_METHODS as CODEX_RUNTIME_PINNING_METHODS,
  buildProviderRuntimeObservation as buildCodexRuntimeObservation,
  observationDigestInput as codexObservationDigestInput,
  runtimePinningIsAuthoritative as codexRuntimePinningIsAuthoritative,
  type CodexFailure,
  type CodexObservationErrorCode,
  type BuildObservationInput as CodexBuildObservationInput,
  type BuildObservationResult as CodexBuildObservationResult,
  type ObservationClock as CodexObservationClock,
  type ObservationTruthClass as CodexObservationTruthClass,
  type PlatformIdentity as CodexPlatformIdentity,
  type ProviderRuntimeObservation as CodexProviderRuntimeObservation,
  type RuntimeClosureEntry as CodexRuntimeClosureEntry,
  type RuntimeClosureKind as CodexRuntimeClosureKind,
  type RuntimePinningMethod as CodexRuntimePinningMethod,
} from "../providers/codex/codex-observation.js";
/**
 * PROBE. `probeCodexRuntime` turns a probe report into a capability profile and
 * a runtime observation in one step, so the two can never disagree about the
 * runtime they describe. Its input type `ProbeCodexRuntimeInput` is Family B and
 * already reaches the root from the recovery-inventory seam.
 */
export {
  probeCodexRuntime,
  type ProbeCodexRuntimeOk,
  type ProbeCodexRuntimeResult,
} from "../providers/codex/codex-probe.js";

/**
 * CAPABILITY VOCABULARY. The closed member sets a consumer needs in order to
 * read a profile it did not build: which capabilities exist, which statuses and
 * proof methods a record may carry, and which context policies a limit may
 * resolve to. `CodexContextLimit` is Family B. The assessment helpers behind
 * these vocabularies stay internal.
 */
export {
  CODEX_CAPABILITIES,
  CODEX_CAPABILITY_PROFILE_VERSION,
  CODEX_CAPABILITY_STATUSES,
  CODEX_CONTEXT_POLICIES,
  CODEX_PROOF_METHODS,
  type CodexCapability,
  type CodexCapabilityProfile,
  type CodexCapabilityRecord,
  type CodexCapabilityStatus,
  type CodexContextPolicy,
  type CodexProofMethod,
} from "../providers/codex/codex-capabilities.js";

/**
 * STREAM RECORDING. `recordCodexStream` is published rather than withheld, and
 * that is a deliberate divergence from `claude-surface.ts`, which publishes the
 * Claude stream type closure but not its recorder. A Codex stream record is not
 * plain data a consumer can assemble: it is the bounded, anomaly-classified
 * result of framing raw bytes, and `frameStream`/`analyzeStream` — the two
 * halves that do the bounding — stay internal. Withholding the recorder here
 * would leave the record type unreachable in practice.
 */
export {
  CODEX_ACCEPTED_SCHEMA_VERSIONS,
  CODEX_STREAM_ANOMALIES,
  CODEX_STREAM_DISPOSITIONS,
  CODEX_STREAM_ERROR_CODES,
  CODEX_STREAM_RECORD_VERSION,
  recordCodexStream,
  type CodexRawRetention,
  type CodexStreamAnomaly,
  type CodexStreamDisposition,
  type CodexStreamErrorCode,
  type CodexStreamEvent,
  type CodexStreamRecord,
  type RecordCodexStreamInput,
  type RecordCodexStreamResult,
  type MoeEffectIdentity as CodexEffectIdentity,
} from "../providers/codex/codex-stream.js";

/**
 * RENDER. `renderCodexContext` builds the context envelope and
 * `codexRendererEnvelopeIdentity` names the envelope it built, which is what a
 * consumer compares across two renders. `CodexTokenizerPort` comes with them
 * because `RenderCodexContextInput` names it as a caller-supplied slot: a
 * consumer unable to declare that port could not call the renderer at all.
 */
export {
  CODEX_RENDERER_ENVELOPE_VERSION,
  CODEX_RENDER_ERROR_CODES,
  CODEX_RENDER_LAYERS,
  MIRRORED_SKILL_RENDERER_INPUT_VERSION as CODEX_MIRRORED_SKILL_RENDERER_INPUT_VERSION,
  renderCodexContext,
  rendererEnvelopeIdentity as codexRendererEnvelopeIdentity,
  type CodexRenderErrorCode,
  type CodexRenderLayer,
  type CodexRenderLayerEntry,
  type CodexRenderedContext,
  type CodexTokenizerPort,
  type RenderCodexContextInput,
  type RenderCodexContextResult,
  type MirroredSkillEntry as CodexMirroredSkillEntry,
  type MirroredSkillFile as CodexMirroredSkillFile,
  type MirroredSkillRendererInput as CodexMirroredSkillRendererInput,
} from "../providers/codex/codex-render.js";
/**
 * ADVISORY SKILLS. `renderCodexAdvisorySkills` renders the mirrored skill
 * snapshot that `RenderCodexContextInput.skillSnapshot` carries, so it travels
 * with the renderer. The Codex prefix on this group marks PROVENANCE — these are
 * the copies the Codex slice owns — not a Codex-specific schema: the underlying
 * version literal is still `moe-skill-renderer-input/1`. They are aliased under
 * the same blanket rule as Family A, because a Claude skills renderer landing
 * later with these exact names would silently delete them from the root.
 */
export { renderAdvisorySkills as renderCodexAdvisorySkills } from "../providers/codex/codex-render-skills.js";

/**
 * RECONCILIATION. The closed outcome set plus the reconciler that maps an
 * observed process exit onto exactly one member of it. `CodexProcessExit` is the
 * caller-supplied evidence and is published for the same reason as the tokenizer
 * port: a consumer that cannot name it cannot call `reconcileCodexRun`.
 */
export {
  CODEX_RECONCILED_OUTCOMES,
  CODEX_RECONCILIATION_VERSION,
  reconcileCodexRun,
  type CodexProcessExit,
  type CodexReconciledOutcome,
  type CodexReconciliation,
  type ReconcileCodexRunInput,
} from "../providers/codex/codex-cancel-reconcile.js";
