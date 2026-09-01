/**
 * The GA activation record: one honest, scoped statement about ONE source commit.
 *
 * IT CANNOT REPORT AN ACTIVATION. The only two activation statuses this composer can emit are
 * `NOT_ACTIVATED` (carrying the binding refusal verbatim) and `BINDING_ADMITTED_ACT_PENDING`.
 * There is no `ACTIVE` status and no first-authoritative-command field, because performing the
 * one-way act is the successor row's tooling (design section 21 items 12-13), not this row's.
 * A record that could say ACTIVE would be a place for a future edit to claim an activation that
 * never happened.
 *
 * EVERYTHING IS DERIVED FROM A PRODUCTION SURFACE, never copied into this module:
 *  - the ten gate-family verdicts come from `resolveAll`, which fills every omitted family with
 *    UNKNOWN and treats an exit code without a nonzero count line as UNKNOWN rather than PASS;
 *  - the reached rung comes from `resolveReachedRung`, which stops authority at the last
 *    all-PASS rung and never upgrades absence or UNKNOWN into PASS;
 *  - every claim sentence is checked by `permitClaim` against that rung;
 *  - the activation verdict comes from `admitActivationBinding`.
 * Each of those refusals is returned VERBATIM with its own code and layer, so a reader can tell
 * WHICH surface refused. Only three failures belong to this module and carry its own layer.
 */
import { admitActivationBinding, GA_ACTIVATION_WORK_REF } from "./activation-binding.js";
import type { ActivationBinding } from "./activation-binding.js";
import { PINNED_SPEC_SHA256 } from "./claim-ladder-contract.js";
import type { ReachedRung } from "./claim-ladder-contract.js";
import { resolveReachedRung } from "./claim-ladder-resolver.js";
import type { ClaimGateVerdict, ClaimLadderGateRefusal } from "./claim-ladder-resolver.js";
import { permitClaim } from "./claim-permit.js";
import type { ClaimPermitCode } from "./claim-permit.js";
import { resolveAll } from "./gate-family-resolver.js";
import type {
  GateFamilyEvidence,
  GateFamilyRefusal,
  GateFamilyVerdictRow,
} from "./gate-family-resolver.js";

export const GA_ACTIVATION_RECORD_LAYER = "GA_ACTIVATION_RECORD" as const;
export const GA_ACTIVATION_RECORD_SCHEMA_VERSION = "moe-ga-activation-record/1" as const;

export const GA_ACTIVATION_RECORD_CODES = Object.freeze([
  "ACTIVATION_RECORD_SOURCE_COMMIT_INVALID",
  "ACTIVATION_RECORD_SPEC_MISMATCH",
  "ACTIVATION_RECORD_CLAIM_REFUSED",
] as const);

export type ActivationRecordCode = (typeof GA_ACTIVATION_RECORD_CODES)[number];
export type ActivationRecordLayer = typeof GA_ACTIVATION_RECORD_LAYER;

export interface ActivationRecordRefusal {
  readonly code: ActivationRecordCode;
  readonly layer: ActivationRecordLayer;
  readonly ok: false;
  readonly permitCode?: ClaimPermitCode;
  readonly sentence?: string;
}

export interface ActivationNotActivated {
  readonly refusal: { readonly code: string; readonly layer: string };
  readonly status: "NOT_ACTIVATED";
}

export interface ActivationBindingAdmitted {
  readonly binding: ActivationBinding;
  readonly status: "BINDING_ADMITTED_ACT_PENDING";
}

export type ActivationOutcome = ActivationBindingAdmitted | ActivationNotActivated;

export interface ActivationRecord {
  readonly activation: ActivationOutcome;
  readonly activationRow: typeof GA_ACTIVATION_WORK_REF;
  readonly claimSentences: readonly string[];
  readonly gateFamilies: readonly GateFamilyVerdictRow[];
  readonly pinnedSpecSha256: string;
  readonly reachedRung: ReachedRung;
  readonly schemaVersion: typeof GA_ACTIVATION_RECORD_SCHEMA_VERSION;
  readonly scopeNotEstablished: readonly string[];
  readonly sourceCommit: string;
}

export interface ActivationRecordInput {
  readonly binding: unknown;
  readonly campaignVerdicts: Readonly<Record<string, ClaimGateVerdict>>;
  readonly claimSentences: readonly string[];
  readonly familyEvidence: readonly GateFamilyEvidence[];
  readonly pinnedSpecSha256: string;
  readonly scopeNotEstablished: readonly string[];
  readonly sourceCommit: string;
}

export type ActivationRecordResult =
  | { readonly ok: true; readonly record: ActivationRecord }
  | ActivationRecordRefusal
  | ClaimLadderGateRefusal
  | GateFamilyRefusal;

const COMMIT_HEX = /^[0-9a-f]{40}$/;

function refuse(code: ActivationRecordCode): ActivationRecordRefusal {
  return Object.freeze({ code, layer: GA_ACTIVATION_RECORD_LAYER, ok: false as const });
}

function claimRefused(permitCode: ClaimPermitCode, sentence: string): ActivationRecordRefusal {
  return Object.freeze({
    code: "ACTIVATION_RECORD_CLAIM_REFUSED" as const,
    layer: GA_ACTIVATION_RECORD_LAYER,
    ok: false as const,
    permitCode,
    sentence,
  });
}

/**
 * The binding verdict, stated so that the absence of an activation is the DEFAULT reading.
 * A refused binding is recorded with the refusing surface's own code and layer rather than
 * summarised, so nobody has to trust this module's paraphrase of why activation did not happen.
 */
function activationOutcome(binding: unknown): ActivationOutcome {
  const admitted = admitActivationBinding(binding);
  if (admitted.ok) {
    return Object.freeze({
      binding: admitted.binding, status: "BINDING_ADMITTED_ACT_PENDING" as const,
    });
  }
  return Object.freeze({
    refusal: Object.freeze({ code: admitted.code, layer: admitted.layer }),
    status: "NOT_ACTIVATED" as const,
  });
}

/** Composes the record, or returns the first refusal — this module's or a surface's. */
export function composeActivationRecord(input: ActivationRecordInput): ActivationRecordResult {
  if (typeof input.sourceCommit !== "string" || !COMMIT_HEX.test(input.sourceCommit)) {
    return refuse("ACTIVATION_RECORD_SOURCE_COMMIT_INVALID");
  }
  if (input.pinnedSpecSha256 !== PINNED_SPEC_SHA256) {
    return refuse("ACTIVATION_RECORD_SPEC_MISMATCH");
  }
  const families = resolveAll(input.familyEvidence);
  if (!families.ok) return families;
  const rung = resolveReachedRung(input.campaignVerdicts);
  if (!rung.ok) return rung;
  for (const sentence of input.claimSentences) {
    const permitted = permitClaim(sentence, rung.rung);
    if (!permitted.ok) return claimRefused(permitted.code, sentence);
  }
  return Object.freeze({
    ok: true as const,
    record: Object.freeze({
      activation: activationOutcome(input.binding),
      activationRow: GA_ACTIVATION_WORK_REF,
      claimSentences: Object.freeze([...input.claimSentences]),
      gateFamilies: families.verdicts,
      pinnedSpecSha256: input.pinnedSpecSha256,
      reachedRung: rung.rung,
      schemaVersion: GA_ACTIVATION_RECORD_SCHEMA_VERSION,
      scopeNotEstablished: Object.freeze([...input.scopeNotEstablished]),
      sourceCommit: input.sourceCommit,
    }),
  });
}
