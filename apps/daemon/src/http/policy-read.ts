/**
 * POLICY, the read: what policy this project has installed and how it has been evaluated,
 * from the `${projectId}-policy` aggregate alone. Every installed slice is listed by ref
 * with what it is (an evaluation slice whose ref is its content digest; the verifier policy
 * and reviewer calibration artifacts the seed installs at their well-known refs; anything
 * else, an artifact), whether its stored bytes still digest to their ref, and its counts.
 * Evaluations are the durable PolicyEvaluated rows, latest first. The verifier's standing
 * authority is the same reading the affordance surface makes for `node.deliver`.
 *
 * Waivers are reported UNSUPPORTED here on purpose: the ledger contract exists, but no
 * command on this branch writes to it and the evaluator resolves waivers as empty.
 */
import { decodeBoundedJsonBytes } from "@moe/contracts";
import { derivePolicySliceDigest } from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import { readDurableLedger, stateOf, versionOf } from "../bootstrap/bootstrap-ledger.js";
import { installedSlices } from "../bootstrap/bootstrap-policy-services.js";
import { policyAggregateId } from "../bootstrap/bootstrap-sequence.js";
import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import { reviewerCalibrationSlice, validatablePolicySlice, verifierPolicySlice } from "../orchestrator/demo-seed-policy.js";
import { readVerifierStandingAuthority } from "../review/verifier-authority-provider.js";
import type { VerifierStandingAuthority } from "../review/verifier-authority-provider.js";
import { authenticateHttpRequest } from "./http-command-ingress.js";
import type { Authenticator, HttpPortRefused, HttpRefused } from "./http-contract.js";

export const POLICY_READ_PATH = "/policy/read" as const;
const LAYER = "POLICY_READ" as const;
const VERIFIER_POLICY_SLICE_REF = "moe-verifier-policy/1";
const REVIEWER_CALIBRATION_SLICE_REF = "moe-reviewer-calibration/1";
const LOWER_HEX_64 = /^[0-9a-f]{64}$/u;
const MAX_EVALUATIONS = 20;

export const POLICY_READ_CODES = Object.freeze([
  "POLICY_READ_CAPABILITY_DENIED", "POLICY_READ_PROJECT_MISMATCH", "POLICY_READ_UNREADABLE",
] as const);

export type PolicySliceKind = "ARTIFACT" | "EVALUATION" | "REVIEWER_CALIBRATION" | "VERIFIER_POLICY";
export interface PolicySliceView {
  readonly autoApprovalOptIns: number | null;
  /** True when the stored bytes digest to the ref; null when the slice is not a core slice. */
  readonly contentDigestMatches: boolean | null;
  readonly installedAt: string | null;
  readonly kind: PolicySliceKind;
  readonly riskClassifications: number | null;
  readonly rules: number | null;
  readonly sliceRef: string;
}
export interface PolicyEvaluationView {
  readonly decidedAt: string;
  readonly decision: string | null;
  readonly policyRef: string;
  readonly principalId: string | null;
}
/**
 * One of the three slices a fresh project needs before delivered work can be accepted,
 * with the body the daemon would install: the browser spends the daemon's own
 * `policy.install` offer with this body verbatim, so what a person installs is what the
 * seed installs. `installed` is read off the same aggregate as `slices`.
 */
export interface StandardSliceView {
  readonly installed: boolean;
  readonly kind: "EVALUATION" | "REVIEWER_CALIBRATION" | "VERIFIER_POLICY";
  readonly slice: Readonly<Record<string, unknown>>;
  readonly sliceRef: string;
}
export interface PolicyView {
  readonly aggregateVersion: number;
  readonly evaluations: readonly PolicyEvaluationView[];
  readonly outcome: "POLICY";
  readonly slices: readonly PolicySliceView[];
  /** The standard slices in install order; the verifier reads the first two by ref. */
  readonly standard: readonly StandardSliceView[];
  readonly verifier: VerifierStandingAuthority;
  readonly waivers: { readonly reason: string; readonly supported: false };
}
export interface PolicyRefused { readonly code: string; readonly layer: string; readonly outcome: "REFUSED" }
export type PolicyReadResult = PolicyRefused | PolicyView;
export interface PolicyReadPort {
  readonly boundProjectId: string;
  readPolicy(): PolicyReadResult;
}

const refused = (code: string): PolicyRefused => Object.freeze({ code, layer: LAYER, outcome: "REFUSED" as const });
const dataRecord = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : null;
const countOf = (value: unknown): number | null => (Array.isArray(value) ? value.length : null);

export function sliceKindOf(sliceRef: string, slice: unknown): PolicySliceKind {
  if (sliceRef === VERIFIER_POLICY_SLICE_REF) return "VERIFIER_POLICY";
  if (sliceRef === REVIEWER_CALIBRATION_SLICE_REF) return "REVIEWER_CALIBRATION";
  return LOWER_HEX_64.test(sliceRef) && Array.isArray(dataRecord(slice)?.["rules"]) ? "EVALUATION" : "ARTIFACT";
}

function decisionWord(value: unknown): string | null {
  if (typeof value === "string") return value;
  const record = dataRecord(value);
  const word = record?.["outcome"] ?? record?.["decision"];
  return typeof word === "string" ? word : null;
}

/**
 * The standard bodies for a project, in the order the seed installs them. PURE. The verifier
 * policy and the calibration are installed by REF (the verifier reads those refs); the
 * evaluation row is satisfied by ANY installed evaluation slice, because a project may
 * install its own classifying policy at its own digest and the finalize terminal accepts it.
 */
export function standardSlicesOf(projectId: string, installed: Readonly<Record<string, unknown>>): readonly StandardSliceView[] {
  const installedRefs = new Set(Object.keys(installed));
  const evaluationInstalled = Object.entries(installed).some(([ref, slice]) => sliceKindOf(ref, slice) === "EVALUATION");
  const bodies: readonly { readonly kind: StandardSliceView["kind"]; readonly slice: Readonly<Record<string, unknown>> }[] = [
    { kind: "VERIFIER_POLICY", slice: verifierPolicySlice({ projectId }) },
    { kind: "REVIEWER_CALIBRATION", slice: reviewerCalibrationSlice({ projectId }) },
    { kind: "EVALUATION", slice: validatablePolicySlice() },
  ];
  return Object.freeze(bodies.map(({ kind, slice }) => {
    const sliceRef = slice["sliceRef"];
    if (typeof sliceRef !== "string") throw new Error(`standard ${kind} slice carries no sliceRef`);
    const isInstalled = kind === "EVALUATION" ? evaluationInstalled || installedRefs.has(sliceRef) : installedRefs.has(sliceRef);
    return Object.freeze({ installed: isInstalled, kind, slice: Object.freeze({ ...slice }), sliceRef });
  }));
}

export function createPolicyReadPort(options: {
  readonly projectId: string;
  readonly readVerifier?: (store: SqliteEventStore, projectId: string) => VerifierStandingAuthority;
  readonly store: SqliteEventStore;
}): PolicyReadPort {
  const { projectId, store } = options;
  const readVerifier = options.readVerifier ?? readVerifierStandingAuthority;
  const aggregateId = policyAggregateId(projectId);

  const readPolicy = (): PolicyReadResult => {
    try {
      const ledger = readDurableLedger(store, projectId);
      const slices = installedSlices(stateOf(ledger, aggregateId));
      const installedAt = new Map<string, string>();
      const evaluations: PolicyEvaluationView[] = [];
      for (const event of store.readEvents(aggregateId)) {
        if (event.aggregateId !== aggregateId) continue;
        const decoded = decodeBoundedJsonBytes(event.payload);
        const payload = decoded.ok ? dataRecord(decoded.value) : null;
        if (payload === null) continue;
        if (event.eventType === "PolicyInstalled" && typeof payload["sliceRef"] === "string") {
          installedAt.set(payload["sliceRef"], event.committedAt);
        } else if (event.eventType === "PolicyEvaluated" && typeof payload["policyRef"] === "string") {
          evaluations.push(Object.freeze({
            decidedAt: event.committedAt,
            decision: decisionWord(payload["decision"]),
            policyRef: payload["policyRef"],
            principalId: typeof payload["principalId"] === "string" ? payload["principalId"] : null,
          }));
        }
      }
      const rows = Object.keys(slices).sort().map((sliceRef): PolicySliceView => {
        const slice = slices[sliceRef];
        const record = dataRecord(slice);
        const kind = sliceKindOf(sliceRef, slice);
        const digest = derivePolicySliceDigest(slice);
        return Object.freeze({
          autoApprovalOptIns: countOf(record?.["autoApprovalOptIns"]),
          contentDigestMatches: digest.ok ? digest.digest === sliceRef : null,
          installedAt: installedAt.get(sliceRef) ?? null,
          kind,
          riskClassifications: countOf(record?.["riskClassifications"]),
          rules: countOf(record?.["rules"]),
          sliceRef,
        });
      });
      return Object.freeze({
        aggregateVersion: versionOf(ledger, aggregateId),
        evaluations: Object.freeze(evaluations.reverse().slice(0, MAX_EVALUATIONS)),
        outcome: "POLICY" as const,
        slices: Object.freeze(rows),
        standard: standardSlicesOf(projectId, slices),
        verifier: readVerifier(store, projectId),
        waivers: Object.freeze({
          reason: "No command on this daemon records a policy waiver; the evaluator resolves waivers as empty.",
          supported: false as const,
        }),
      });
    } catch {
      return refused("POLICY_READ_UNREADABLE");
    }
  };
  return Object.freeze({ boundProjectId: projectId, readPolicy });
}

export type PolicyReadDispatch =
  | { readonly body: PolicyReadResult | HttpPortRefused | HttpRefused; readonly httpStatus: number; readonly kind: "REPLY" }
  | { readonly code: "LISTENER_POLICY_REQUEST_INVALID" | "LISTENER_POLICY_UNAVAILABLE"; readonly kind: "LISTENER_REFUSAL" };

/** The body must be empty or exactly `{}`: this read takes no operand a caller could shape. */
export function emptyBody(body: unknown): boolean {
  if (body instanceof Uint8Array && body.length === 0) return true;
  const decoded = decodeBoundedJsonBytes(body);
  return decoded.ok && dataRecord(decoded.value) !== null && Object.keys(decoded.value as object).length === 0;
}

export function handlePolicyReadRequest(
  dependencies: { readonly authenticator: Authenticator; readonly policy?: PolicyReadPort | undefined },
  request: { readonly body: unknown; readonly credential: string | null; readonly protocolVersion: unknown },
): PolicyReadDispatch {
  const access = authenticateHttpRequest(dependencies.authenticator, request.credential, request.protocolVersion);
  if (!access.ok) return Object.freeze({ body: access, httpStatus: access.httpStatus, kind: "REPLY" });
  if (!access.principal.capabilities.includes(CAPABILITIES.GOAL)) {
    return Object.freeze({ body: refused("POLICY_READ_CAPABILITY_DENIED"), httpStatus: 200, kind: "REPLY" });
  }
  const port = dependencies.policy;
  if (port === undefined) return Object.freeze({ code: "LISTENER_POLICY_UNAVAILABLE", kind: "LISTENER_REFUSAL" });
  if (access.principal.projectId !== port.boundProjectId) {
    return Object.freeze({ body: refused("POLICY_READ_PROJECT_MISMATCH"), httpStatus: 200, kind: "REPLY" });
  }
  if (!emptyBody(request.body)) return Object.freeze({ code: "LISTENER_POLICY_REQUEST_INVALID", kind: "LISTENER_REFUSAL" });
  return Object.freeze({ body: port.readPolicy(), httpStatus: 200, kind: "REPLY" });
}
