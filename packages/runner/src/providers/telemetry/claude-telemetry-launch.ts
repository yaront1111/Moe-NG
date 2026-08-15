/**
 * `launchClaudeWithTelemetry` — the real launch, plus the raw provider-run
 * handoff its result supports. It calls the production `launchClaude` and BINDS
 * what the launcher already observed; nothing here recomputes a digest, a
 * timestamp or an exit, because a second derivation could disagree with the
 * launcher's own and the disagreeing copy would be the one downstream trusted.
 *
 * THE SEPARATION DoD-3 EXISTS FOR. `declared` carries the caller's
 * `ClaudeLaunchSelection`; `observedModel` carries what the provider's own bytes
 * said. They are never merged, never defaulted from one another, and never
 * unified into a single `model` field. Likewise `concurrencyCeiling` sits on the
 * SELECTION and is therefore a request, so it is bound as `declaredCeiling` while
 * `achieved` stays unsupported — the pinned result schema carries no achieved
 * measurement at all. The REFUSED and ADOPTED/EXIT_BEFORE_LAUNCH arms carry no
 * observation, so they produce a handoff whose facts are UNKNOWN with the
 * launcher's own code and layer forwarded verbatim, never zero-filled.
 */
import { deepFreeze } from "../../canonical.js";
import { isHostileObject, snapshotLaunchSelection } from "../claude/claude-launch-selection.js";
import {
  launchClaude,
  type ClaudeLaunchErrorCode, type ClaudeLaunchExit, type ClaudeLaunchLayer,
  type ClaudeLaunchOptions, type ClaudeLaunchResult, type ClaudeLaunchSelection,
  type ClaudeLaunchTruthClass, type ClaudeStreamEvidence,
} from "../claude/claude-launcher.js";
import {
  CLAUDE_RESULT_TELEMETRY_VERSION, parseClaudeResultTelemetry,
  type ClaudeObservedModel, type ClaudeResultTelemetryVerdict, type ClaudeStepObservations,
  type ClaudeTokenObservations,
} from "./claude-result-telemetry.js";
import {
  countCoverage, knownCount, readText, snapshotRunRef, telemetryRefusal, unknownFact,
  type ProviderConcurrencyFact, type ProviderFactUnknown, type ProviderInfrastructureOutcome,
  type ProviderQuantity, type ProviderRunRef, type ProviderTelemetryCode,
  type ProviderTelemetryRefusal, type ProviderTerminalOutcome, type ProviderText,
} from "./provider-telemetry-contracts.js";

export const CLAUDE_TELEMETRY_HANDOFF_VERSION = "moe-claude-telemetry-handoff/1" as const;

export type ClaudeDeclaredSelection =
  | { readonly known: true; readonly selection: ClaudeLaunchSelection } | ProviderFactUnknown;
export interface ClaudeTelemetryConcurrency {
  readonly fact: ProviderConcurrencyFact;
  readonly declaredCeiling: ProviderQuantity;
  readonly achieved: ProviderQuantity;
}

/** Bound from `ClaudeLaunchObservation` verbatim; null on the arms that have none. */
export interface ClaudeTelemetryLaunchFacts {
  readonly kind: ClaudeLaunchResult["kind"];
  readonly truthClass: ClaudeLaunchTruthClass;
  readonly reasonCode: ClaudeLaunchErrorCode | null;
  readonly reasonLayer: ClaudeLaunchLayer | null;
  readonly exit: ClaudeLaunchExit | null;
  readonly effectDigest: string | null;
  readonly activationDigest: string | null;
  readonly runtimeBindingDigest: string | null;
  readonly quotedRuntimeDigest: string | null;
  readonly freshRuntimeDigest: string | null;
  readonly pinnedClosureDigest: string | null;
  readonly observationDigest: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}
export interface ClaudeTelemetryLaunchInput { readonly providerRunRef: unknown;
  readonly request: unknown; readonly options?: ClaudeLaunchOptions }
export type ClaudeTelemetryLaunchResult =
  | { readonly ok: true; readonly handoff: ClaudeTelemetryHandoff } | ProviderTelemetryRefusal;

export interface ClaudeTelemetryHandoff {
  readonly handoffVersion: typeof CLAUDE_TELEMETRY_HANDOFF_VERSION;
  readonly parserVersion: typeof CLAUDE_RESULT_TELEMETRY_VERSION;
  readonly providerRunRef: ProviderRunRef;
  readonly launch: ClaudeTelemetryLaunchFacts;
  readonly declared: ClaudeDeclaredSelection;
  readonly observedModel: ClaudeObservedModel;
  readonly terminal: ProviderTerminalOutcome;
  readonly infrastructure: ProviderInfrastructureOutcome;
  readonly tokens: ClaudeTokenObservations;
  readonly steps: ClaudeStepObservations;
  readonly sequence: ProviderQuantity;
  readonly concurrency: ClaudeTelemetryConcurrency;
  readonly stdoutReceiptDigest: ProviderText;
  readonly stderrReceiptDigest: ProviderText;
  readonly telemetryRefusal: ProviderTelemetryRefusal | null;
}

const INFRASTRUCTURE_BY_CODE:
  Readonly<Partial<Record<ProviderTelemetryCode, ProviderInfrastructureOutcome>>> = Object.freeze({
    TELEMETRY_CAPTURE_INCOMPLETE: "CAPTURE_INCOMPLETE",
    TELEMETRY_CAPTURE_TRUNCATED: "CAPTURE_TRUNCATED", TELEMETRY_CAPTURE_UNDECODABLE: "UNKNOWN",
    TELEMETRY_SCHEMA_UNSUPPORTED: "SCHEMA_UNSUPPORTED",
    TELEMETRY_STREAM_ANOMALOUS: "STREAM_ANOMALOUS" });

const blindTokens = (fact: ProviderFactUnknown): ClaudeTokenObservations => Object.freeze({
  inputTokens: fact, outputTokens: fact, cacheCreationInputTokens: fact,
  cacheReadInputTokens: fact, coverage: countCoverage([fact, fact, fact, fact]) });
const blindSteps = (fact: ProviderFactUnknown): ClaudeStepObservations =>
  Object.freeze({ turns: fact, coverage: countCoverage([fact]) });
const blindModel = (fact: ProviderFactUnknown): ClaudeObservedModel =>
  Object.freeze({ modelId: fact, snapshotKind: "UNKNOWN", snapshotEvidence: fact });
/** Bound rather than re-hashed, but through the same bounded-text reader every
 *  other observed string uses: an empty or unprintable digest becomes an
 *  explicit UNKNOWN receipt, never a known one nobody can verify. */
const receipt = (evidence: ClaudeStreamEvidence): ProviderText => readText(
  { sha256: evidence.sha256 }, "sha256",
  unknownFact("TELEMETRY_CAPTURE_UNDECODABLE", "TELEMETRY_CAPTURE"));

/**
 * Own DATA descriptors only, behind the launcher's own proxy guard. An accessor
 * on `launchSelection` is the caller's code running inside the read that decides
 * whether to trust the caller at all.
 */
function declaredOf(request: unknown): ClaudeDeclaredSelection {
  const unreadable = unknownFact("TELEMETRY_DECLARED_SELECTION_UNREADABLE", "TELEMETRY_INPUT");
  if (typeof request !== "object" || request === null || isHostileObject(request)) return unreadable;
  let descriptor: PropertyDescriptor | undefined;
  try { descriptor = Object.getOwnPropertyDescriptor(request, "launchSelection"); }
  catch { return unreadable; }
  if (descriptor === undefined || !("value" in descriptor)) return unreadable;
  // The launcher's OWN selection reader, not a second copy that could disagree.
  const selection = snapshotLaunchSelection(descriptor.value);
  return selection === null ? unreadable : deepFreeze({ known: true as const, selection });
}

/**
 * The declared ceiling is carried under a name that says DECLARED, and `achieved`
 * can only ever be unsupported: no branch here lets one become the other.
 */
function concurrencyOf(declared: ClaudeDeclaredSelection): ClaudeTelemetryConcurrency {
  const achieved = unknownFact("TELEMETRY_ACHIEVED_CONCURRENCY_UNSUPPORTED", "TELEMETRY_SCHEMA");
  if (!declared.known) {
    return Object.freeze({ fact: "NO_CONCURRENCY_FACTS", declaredCeiling: declared, achieved });
  }
  const declaredCeiling = knownCount(declared.selection.concurrencyCeiling) ??
    unknownFact("TELEMETRY_DECLARED_SELECTION_UNREADABLE", "TELEMETRY_INPUT");
  return Object.freeze({ fact: "DECLARED_CEILING_ONLY", declaredCeiling, achieved });
}

const NO_LAUNCH_DIGESTS = Object.freeze({
  effectDigest: null, activationDigest: null, runtimeBindingDigest: null, exit: null,
  quotedRuntimeDigest: null, freshRuntimeDigest: null, pinnedClosureDigest: null,
  observationDigest: null, startedAt: null, completedAt: null });

function blindHandoff(
  providerRunRef: ProviderRunRef, declared: ClaudeDeclaredSelection, result: ClaudeLaunchResult,
  code: "TELEMETRY_LAUNCH_REFUSED" | "TELEMETRY_LAUNCH_NOT_ATTEMPTED",
  terminal: ProviderTerminalOutcome, infrastructure: ProviderInfrastructureOutcome,
): ClaudeTelemetryHandoff {
  const fact = unknownFact(code, "TELEMETRY_LAUNCH");
  return deepFreeze({
    handoffVersion: CLAUDE_TELEMETRY_HANDOFF_VERSION,
    parserVersion: CLAUDE_RESULT_TELEMETRY_VERSION,
    providerRunRef,
    launch: {
      kind: result.kind, truthClass: result.truthClass, reasonCode: result.code,
      reasonLayer: result.layer, ...NO_LAUNCH_DIGESTS,
    },
    declared, observedModel: blindModel(fact), terminal, infrastructure,
    tokens: blindTokens(fact), steps: blindSteps(fact), sequence: fact,
    concurrency: concurrencyOf(declared),
    stdoutReceiptDigest: fact, stderrReceiptDigest: fact,
    telemetryRefusal: telemetryRefusal(code, "TELEMETRY_LAUNCH"),
  });
}

/**
 * The single branch on the parse verdict. A refusal turns into UNKNOWN facts
 * carrying the parser's exact code and layer — never a partial sum and never a
 * zero — and the refusal record travels with them.
 */
interface ParsedFacts {
  readonly observedModel: ClaudeObservedModel;
  readonly terminal: ProviderTerminalOutcome;
  readonly tokens: ClaudeTokenObservations;
  readonly steps: ClaudeStepObservations;
  readonly sequence: ProviderQuantity;
  readonly telemetryRefusal: ProviderTelemetryRefusal | null;
}
function factsOf(parsed: ClaudeResultTelemetryVerdict): ParsedFacts {
  if (parsed.ok) {
    const { observedModel, terminal, tokens, steps, sequence } = parsed.telemetry;
    return Object.freeze({ observedModel, terminal, tokens, steps, sequence, telemetryRefusal: null });
  }
  const fact = unknownFact(parsed.code, parsed.layer);
  return Object.freeze({ observedModel: blindModel(fact), terminal: "UNKNOWN" as const,
    tokens: blindTokens(fact), steps: blindSteps(fact), sequence: fact, telemetryRefusal: parsed });
}

/**
 * `NONE` asserts an ABSENCE of infrastructure fault, so it is the one member
 * that must be EARNED: the exit observed, the capture parsed, and the launcher
 * itself having PROVEN the run. A launch it could not prove — a failed stderr
 * capture, an unproven boundary identity — reports UNKNOWN even when stdout
 * reads perfectly.
 */
function infrastructureOf(
  exit: ClaudeLaunchExit, parsed: ClaudeResultTelemetryVerdict, truthClass: ClaudeLaunchTruthClass,
): ProviderInfrastructureOutcome {
  if (exit.kind === "SIGNALLED") return "PROCESS_SIGNALLED";
  if (exit.kind === "UNOBSERVED") return "EXIT_UNOBSERVED";
  if (!parsed.ok) return INFRASTRUCTURE_BY_CODE[parsed.code] ?? "UNKNOWN";
  return truthClass === "PROVEN" ? "NONE" : "UNKNOWN";
}

export async function launchClaudeWithTelemetry(
  input: ClaudeTelemetryLaunchInput,
): Promise<ClaudeTelemetryLaunchResult> {
  const providerRunRef = snapshotRunRef(input.providerRunRef);
  // Refused BEFORE the launch: a process this handoff could not attribute to a
  // run is worse than no process at all.
  if (providerRunRef === null) {
    return telemetryRefusal("TELEMETRY_RUN_REF_MALFORMED", "TELEMETRY_INPUT");
  }
  const declared = declaredOf(input.request);
  const result = await launchClaude(input.request, input.options ?? {});
  if (result.kind === "REFUSED") {
    return Object.freeze({ ok: true as const, handoff: blindHandoff(
      providerRunRef, declared, result, "TELEMETRY_LAUNCH_REFUSED", "REFUSED", "LAUNCH_REFUSED") });
  }
  if (result.kind !== "OBSERVED") {
    return Object.freeze({ ok: true as const, handoff: blindHandoff(
      providerRunRef, declared, result, "TELEMETRY_LAUNCH_NOT_ATTEMPTED", "UNKNOWN",
      "LAUNCH_NOT_ATTEMPTED") });
  }
  const observation = result.observation;
  const parsed = parseClaudeResultTelemetry({ providerRunRef, stdout: observation.stdout });
  return Object.freeze({ ok: true as const, handoff: deepFreeze({
    handoffVersion: CLAUDE_TELEMETRY_HANDOFF_VERSION,
    parserVersion: CLAUDE_RESULT_TELEMETRY_VERSION,
    providerRunRef,
    launch: {
      kind: result.kind, truthClass: observation.truthClass, reasonCode: observation.reasonCode,
      reasonLayer: observation.reasonLayer, effectDigest: observation.effectDigest,
      activationDigest: observation.activationDigest,
      runtimeBindingDigest: observation.runtimeBindingDigest,
      quotedRuntimeDigest: observation.quotedRuntimeDigest,
      freshRuntimeDigest: observation.freshRuntimeDigest,
      pinnedClosureDigest: observation.pinnedClosureDigest,
      observationDigest: observation.observationDigest, startedAt: observation.startedAt,
      completedAt: observation.completedAt, exit: observation.exit,
    },
    declared,
    ...factsOf(parsed),
    infrastructure: infrastructureOf(observation.exit, parsed, observation.truthClass),
    concurrency: concurrencyOf(declared),
    stdoutReceiptDigest: receipt(observation.stdout),
    stderrReceiptDigest: receipt(observation.stderr),
  }) });
}
