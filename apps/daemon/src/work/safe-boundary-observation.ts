import { createHash } from "node:crypto";

import type { ProviderRunRef } from "@moe/runner";
import type {
  CommandDecisionKey, CommandDecisionResponse, CommitExpectedVersionDecisionInput, StoredEvent,
} from "@moe/store";

import { readCurrentProviderRun } from "../telemetry/provider-run-reader.js";
import type { ProviderRunReadStore } from "../telemetry/provider-run-reader.js";

/**
 * The durable safe-boundary observation: a FACT ABOUT WHAT THE HOST SAW.
 *
 * The producer for `ExpansionReleaseEvidence`'s `safeBoundaryObserved` and `observationRef`.
 * The field exists separately from the terminality flags for exactly one reason — an agent
 * must not be able to declare its own boundary safe — so the input carries attempt IDENTITY
 * and decision metadata only and every boundary fact is DERIVED from the durable
 * provider-run record the host committed.
 *
 * THE PREDICATE, and the arm that makes it subtle: TRUE only when the record decodes AND
 * `launch.truthClass === "PROVEN"` AND `launch.exit` is `EXITED` or `SIGNALLED` AND
 * `terminal !== "UNKNOWN"` AND `launch.completedAt !== null`. `ClaudeLaunchExit` has a THIRD
 * arm, `{kind: "UNOBSERVED"}`, which is NON-NULL and whose entire meaning is that the host
 * did NOT see the process cross its boundary — so `exit !== null` would answer TRUE on the
 * one value that denies observation.
 *
 * FAIL CLOSED TWO WAYS, because they demand opposite repairs. A record that exists but does
 * not prove the crossing yields a RECORDED `false` naming the clause that failed — a fact,
 * and one that blocks the release. A record absent or unreadable yields a typed UNKNOWN and
 * records NOTHING: an unknown is not a false, and writing one would manufacture evidence.
 */

const LAYER = "DAEMON_SAFE_BOUNDARY_OBSERVATION";
/** A closed TYPE plus the one literal consumers pin; no caller can widen the vocabulary. */
export type SafeBoundaryObservationLayer = typeof LAYER;
export const SAFE_BOUNDARY_OBSERVATION_LAYER: SafeBoundaryObservationLayer = LAYER;

export const SAFE_BOUNDARY_OBSERVATION_VERSION = "moe-safe-boundary-observation/1";
export const SAFE_BOUNDARY_REFUSAL_CODES = Object.freeze([
  "SAFE_BOUNDARY_INPUT_MALFORMED", "SAFE_BOUNDARY_RUN_UNREADABLE",
  "SAFE_BOUNDARY_OBSERVATION_ABSENT", "SAFE_BOUNDARY_OBSERVATION_UNREADABLE",
  "SAFE_BOUNDARY_COMMIT_CONFLICT",
] as const);
export type SafeBoundaryRefusalCode = (typeof SAFE_BOUNDARY_REFUSAL_CODES)[number];
/** Why a present record still failed to prove the crossing. `null` on the true arm. */
export const SAFE_BOUNDARY_REASON_CODES = Object.freeze([
  "SAFE_BOUNDARY_EXIT_UNOBSERVED", "SAFE_BOUNDARY_TRUTH_INADEQUATE",
  "SAFE_BOUNDARY_TERMINAL_UNCLASSIFIED", "SAFE_BOUNDARY_END_UNRECORDED",
] as const);
export type SafeBoundaryReasonCode = (typeof SAFE_BOUNDARY_REASON_CODES)[number];

/** Identity and decision metadata ONLY. No `decidedAt`: the release path is clock-free by
 *  design, so `derivedAt` comes off the DURABLE record — a time the host observed. */
export interface SafeBoundaryObservationInput {
  readonly attemptRef: string; readonly correlationId: string;
  readonly key: CommandDecisionKey; readonly projectId: string;
  readonly requestBytes: Uint8Array;
}

/** Exactly the keys the writer accepts. Any other — above all a boundary claim, a ref or
 *  a flag — is REFUSED, never ignored: a dropped claim is indistinguishable from an
 *  honoured one at the call site. */
const INPUT_KEYS = Object.freeze([
  "attemptRef", "correlationId", "key", "projectId", "requestBytes",
] as const);

export interface SafeBoundaryObservation {
  readonly attemptRef: string; readonly derivedAt: string; readonly observationRef: string;
  readonly observationVersion: typeof SAFE_BOUNDARY_OBSERVATION_VERSION;
  readonly projectId: string; readonly providerRunRef: ProviderRunRef;
  readonly reasonCode: SafeBoundaryReasonCode | null; readonly recordDigest: string;
  readonly safeBoundaryObserved: boolean;
}

/** `upstreamCode` preserves the refusing layer's OWN code rather than flattening it. */
export interface SafeBoundaryRefused {
  readonly code: SafeBoundaryRefusalCode; readonly layer: SafeBoundaryObservationLayer;
  readonly ok: false; readonly upstreamCode: string;
}

export interface SafeBoundaryWritten {
  readonly aggregateId: string; readonly disposition: "COMMITTED" | "REPLAYED";
  readonly observation: SafeBoundaryObservation; readonly ok: true;
}
export type SafeBoundaryWriteResult = SafeBoundaryRefused | SafeBoundaryWritten;
export type SafeBoundaryReadResult =
  | SafeBoundaryRefused | { readonly observation: SafeBoundaryObservation; readonly ok: true };

export interface SafeBoundaryStore extends ProviderRunReadStore {
  commitExpectedVersionDecision(input: CommitExpectedVersionDecisionInput): CommandDecisionResponse;
}
export interface SafeBoundaryReadRequest {
  readonly observationRef: string; readonly projectId: string;
}

const SAFE_BOUNDARY_COMMAND_KIND = "safe_boundary.observe";
const SAFE_BOUNDARY_EVENT_TYPE = "SafeBoundaryObserved";
const AGGREGATE_DOMAIN = "moe.safe-boundary.aggregate-id.v1";
const REF_DOMAIN = "moe.safe-boundary.observation-ref.v1", EXPECTED_VERSION = 0;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const refuse = (code: SafeBoundaryRefusalCode, upstreamCode: string): SafeBoundaryRefused =>
  Object.freeze({ code, layer: LAYER, ok: false as const, upstreamCode });

/** Length-framed before hashing: a bare join would map `a|bc` onto `ab|c`. */
function digestOf(domain: string, components: readonly string[]): string {
  const hash = createHash("sha256").update(`${domain}\u0000`, "utf8");
  for (const component of components) {
    const bytes = encoder.encode(component);
    hash.update(`${String(bytes.byteLength)}:`, "ascii").update(bytes);
  }
  return hash.digest("hex");
}

function admit(value: unknown): SafeBoundaryObservationInput | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Reflect.ownKeys(value);
  const allowed = new Set<string | symbol>(INPUT_KEYS);
  if (keys.length !== INPUT_KEYS.length || keys.some((key) => !allowed.has(key))) return null;
  const record = value as Record<string, unknown>;
  if (["attemptRef", "correlationId", "projectId"].some(
    (key) => typeof record[key] !== "string" || record[key] === "",
  )) return null;
  if (!(record["requestBytes"] instanceof Uint8Array)) return null;
  if (typeof record["key"] !== "object" || record["key"] === null) return null;
  return value as SafeBoundaryObservationInput;
}
interface Derived {
  readonly reasonCode: SafeBoundaryReasonCode | null; readonly safeBoundaryObserved: boolean;
}

/** The predicate, one clause at a time so a weakening reddens exactly one arm — a COVERAGE
 *  claim, true only while every arm has a test: flipping `failed()` to TRUE must redden FIVE
 *  named tests (it reddened three until TERMINAL_UNCLASSIFIED and END_UNRECORDED were added). */
function deriveBoundary(record: {
  readonly launch: { readonly completedAt: string | null;
    readonly exit: { readonly kind: string } | null; readonly truthClass: string };
  readonly terminal: string;
}): Derived {
  const { launch } = record;
  const failed = (r: SafeBoundaryReasonCode): Derived => ({ reasonCode: r, safeBoundaryObserved: false });
  if (launch.truthClass !== "PROVEN") return failed("SAFE_BOUNDARY_TRUTH_INADEQUATE");
  if (launch.exit === null || launch.exit.kind === "UNOBSERVED") {
    return failed("SAFE_BOUNDARY_EXIT_UNOBSERVED");
  }
  if (record.terminal === "UNKNOWN") return failed("SAFE_BOUNDARY_TERMINAL_UNCLASSIFIED");
  if (launch.completedAt === null) return failed("SAFE_BOUNDARY_END_UNRECORDED");
  return { reasonCode: null, safeBoundaryObserved: true };
}

/** The upstream code, whichever of the three result vocabularies answered. */
function upstreamCodeOf(result: object): string {
  const record = result as Record<string, unknown>;
  if (typeof record["code"] === "string") return record["code"];
  if (typeof record["status"] === "string") return record["status"];
  return "UNKNOWN";
}

const aggregateOf = (observationRef: string): string =>
  digestOf(AGGREGATE_DOMAIN, [observationRef]);

export function recordSafeBoundaryObservation(
  store: SafeBoundaryStore, value: unknown,
): SafeBoundaryWriteResult {
  const input = admit(value);
  if (input === null) return refuse("SAFE_BOUNDARY_INPUT_MALFORMED", "EXACT_RECORD");

  const run = readCurrentProviderRun(store, {
    attemptRef: input.attemptRef, projectId: input.projectId,
  });
  if (!("ok" in run) || run.ok !== true) {
    return refuse("SAFE_BOUNDARY_RUN_UNREADABLE", upstreamCodeOf(run));
  }

  const derived = deriveBoundary(run.record);
  // A DURABLE instant, never a clock read: end recorded, else start observed, else the wall
  // reading CONVERTED (arithmetic on evidence, not a sample). It must be CANONICAL — the store
  // refuses a non-canonical `decidedAt`, so a merely descriptive fallback costs the observation.
  const wall = run.record.observedStart?.serverWallSeconds;
  const derivedAt = run.record.launch.completedAt ?? run.record.launch.startedAt
    ?? (typeof wall === "number" && Number.isFinite(wall)
      ? new Date(wall * 1_000).toISOString() : null);
  if (derivedAt === null) return refuse("SAFE_BOUNDARY_RUN_UNREADABLE", "NO_DURABLE_INSTANT");
  const observationRef = digestOf(REF_DOMAIN, [
    input.projectId, input.attemptRef, JSON.stringify(run.record.providerRunRef), run.recordDigest,
  ]);
  const observation: SafeBoundaryObservation = Object.freeze({
    attemptRef: input.attemptRef, derivedAt, observationRef,
    observationVersion: SAFE_BOUNDARY_OBSERVATION_VERSION, projectId: input.projectId,
    providerRunRef: run.record.providerRunRef, reasonCode: derived.reasonCode,
    recordDigest: run.recordDigest, safeBoundaryObserved: derived.safeBoundaryObserved,
  });

  const aggregateId = aggregateOf(observationRef);
  const bytes = encoder.encode(JSON.stringify(observation));
  let response: CommandDecisionResponse;
  try {
    response = store.commitExpectedVersionDecision({
      commandKind: SAFE_BOUNDARY_COMMAND_KIND,
      committedResultBytes: bytes,
      correlationId: input.correlationId,
      decidedAt: derivedAt,
      events: [{ eventId: observationRef, eventType: SAFE_BOUNDARY_EVENT_TYPE, payload: bytes }],
      expectedVersion: EXPECTED_VERSION,
      key: input.key,
      requestBytes: input.requestBytes,
      targetAggregateId: aggregateId,
    });
  } catch (error) {
    return refuse("SAFE_BOUNDARY_COMMIT_CONFLICT", error instanceof Error ? error.message : "T");
  }
  if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    return refuse("SAFE_BOUNDARY_COMMIT_CONFLICT", response.decision.resultCode);
  }
  const disposition = response.disposition === "REPLAYED" ? "REPLAYED" : "COMMITTED";
  return Object.freeze({ aggregateId, disposition, observation, ok: true as const });
}

function decodeObservation(event: StoredEvent): SafeBoundaryObservation | null {
  let parsed: unknown;
  try { parsed = JSON.parse(decoder.decode(event.payload)); } catch { return null; }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as SafeBoundaryObservation;
  if (candidate.observationVersion !== SAFE_BOUNDARY_OBSERVATION_VERSION) return null;
  if (typeof candidate.safeBoundaryObserved !== "boolean") return null;
  // Re-encoded and byte-compared: bytes that differ from the durable ones are not the
  // record that was committed, and answering from them would echo the reader.
  const reencoded = encoder.encode(JSON.stringify(candidate));
  if (Buffer.compare(Buffer.from(reencoded), Buffer.from(event.payload)) !== 0) return null;
  return Object.freeze(candidate);
}

export function readSafeBoundaryObservation(
  store: SafeBoundaryStore, request: SafeBoundaryReadRequest,
): SafeBoundaryReadResult {
  const { observationRef } = request;
  if (typeof observationRef !== "string" || observationRef === "") {
    return refuse("SAFE_BOUNDARY_INPUT_MALFORMED", "EXACT_RECORD");
  }
  let events: readonly StoredEvent[];
  try {
    events = store.readEvents(aggregateOf(observationRef));
  } catch (error) {
    return refuse("SAFE_BOUNDARY_OBSERVATION_UNREADABLE",
      error instanceof Error ? error.message : "T");
  }
  const event = events.find((candidate) => candidate.eventType === SAFE_BOUNDARY_EVENT_TYPE);
  // A ref that names nothing is REFUSED, never accepted as an identifier.
  if (event === undefined) return refuse("SAFE_BOUNDARY_OBSERVATION_ABSENT", "NO_EVENT");
  const observation = decodeObservation(event);
  if (observation === null) return refuse("SAFE_BOUNDARY_OBSERVATION_UNREADABLE", "DECODE");
  if (observation.projectId !== request.projectId) {
    return refuse("SAFE_BOUNDARY_OBSERVATION_ABSENT", "PROJECT_MISMATCH");
  }
  return Object.freeze({ observation, ok: true as const });
}
