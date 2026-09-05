import type { RuntimeError } from "@moe/contracts";
import { DurableStoreError, IdempotencyConflictError, type SqliteEventStore } from "@moe/store";

import type { ActivationIngressOutcome } from "./activation/activation-ingress-contracts.js";
import type { ServiceOutcome } from "./bootstrap/bootstrap-ledger.js";
import type { SessionOutcome } from "./identity/session-ledger.js";
import type { JournalAppendOutcome } from "./journal/journal-contracts.js";
import type { ProductContractGate1Outcome }
  from "./product-contract/product-contract-gate-1-contract.js";
import type { RecoveryCompletionOutcome } from "./recovery/recovery-completion.js";
import type { ReviewOutcome } from "./review/review-ledger.js";
import type {
  CommandRegistryEntry, DecisionPortResult, DurableDecision,
} from "./http/http-contract.js";
import type { StepLifecycleOutcome } from "./work/step-lifecycle-contracts.js";
import type { WorkClaimOutcome } from "./work/work-claim-services.js";
import {
  admitV1AuthoritativeCommand,
  admitV2ActiveInstallation,
} from "./cutover/cutover-v2-authority.js";

/**
 * The dispatch plumbing shared by every registered command: the request encoder, the
 * error a family refusal is carried out on, the translation of a service outcome into
 * a durable decision, and the shape of a port refusal. None of it is command-specific
 * -- the tables live in `./daemon-command-vocabulary.js` and the composition root in
 * `./daemon-command-registry.js`, which is the only module that constructs these.
 *
 * A refusal keeps the code and the LAYER the family reported. Collapsing either into a
 * generic error would let a domain refusal read as a store fault at the HTTP seam.
 */

export const encoder = new TextEncoder();

export class DomainRefusal extends Error {
  public readonly code: string;
  public readonly detail: string;
  public readonly httpStatus: number;
  public readonly layer: string;

  public constructor(code: string, layer: string, detail: string, httpStatus = 422) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.detail = detail;
    this.httpStatus = httpStatus;
    this.layer = layer;
  }
}

/**
 * The refusing authority's OWN words, when it has any. Every edge used to pass the code as
 * its own detail, so a seat read `{"code":"X","detail":"X"}` and could correct nothing: one
 * real planning seat bisected seven graph shapes against a refusal whose cause it was never
 * told (2026-09-05). The code stays the floor for authorities that never say more.
 */
export function domainRefusalOf(
  outcome: Readonly<{ code: string; detail?: unknown; layer: string }>,
): DomainRefusal {
  const detail = typeof outcome.detail === "string" && outcome.detail.length > 0
    ? outcome.detail
    : outcome.code;
  return new DomainRefusal(outcome.code, outcome.layer, detail);
}

export interface CommandAuthorityGate {
  readonly assert: () => void;
  readonly wrapAsync: (entry: CommandRegistryEntry) => CommandRegistryEntry;
}

/**
 * Snapshots the selected cutover plane once and applies the same fail-closed admission to
 * synchronous and asynchronous registry entries. V1 returns async entries unchanged so
 * extraction does not alter their established identity.
 */
export function createCommandAuthorityGate(
  store: SqliteEventStore,
  projectId: string,
  requestedPlane: unknown,
): CommandAuthorityGate {
  const authorityPlane = requestedPlane ?? "V1";
  if (authorityPlane !== "V1" && authorityPlane !== "V2") {
    throw new Error("COMMAND_AUTHORITY_PLANE_INVALID");
  }
  const assert = (): void => {
    const authority = authorityPlane === "V2"
      ? admitV2ActiveInstallation(store, { projectId })
      : admitV1AuthoritativeCommand(store, { projectId });
    if (!authority.ok) throw domainRefusalOf(authority);
  };
  const wrapAsync = (entry: CommandRegistryEntry): CommandRegistryEntry => {
    if (authorityPlane === "V1") return entry;
    const asyncHandler = entry.asyncHandler;
    return Object.freeze({
      ...entry,
      ...(asyncHandler === undefined ? {} : {
        asyncHandler: async (...args: Parameters<typeof asyncHandler>) => {
          assert();
          return await asyncHandler(...args);
        },
      }),
      handler: (input: Parameters<typeof entry.handler>[0]) => {
        assert();
        return entry.handler(input);
      },
    });
  };
  return Object.freeze({ assert, wrapAsync });
}

/**
 * The refusal detail a caller reads on the wire. Generic on purpose: the error's own code,
 * then every registered detail key as `key=value` in sorted order. A caller told only
 * "EXPECTED_VERSION_CONFLICT" has nothing to retry at; told
 * `EXPECTED_VERSION_CONFLICT actualVersion=1 expectedVersion=0` it knows the one version to
 * resend at. No code is special-cased here, so every registered detail key becomes readable
 * the same way and there is nothing to keep in sync.
 *
 * The details are already sanitised to safe scalars by the runtime error registry, so no value
 * that reaches this string can carry attacker bytes or a separator.
 */
function detailOf(outcome: { readonly code: string; readonly error: RuntimeError | null }): string {
  const error = outcome.error;
  if (error === null) return outcome.code;
  const details = error.details;
  return [
    error.code,
    ...Object.keys(details).sort().map((key) => `${key}=${String(details[key])}`),
  ].join(" ");
}

export function decisionOf(
  outcome: ActivationIngressOutcome | JournalAppendOutcome | ProductContractGate1Outcome
    | RecoveryCompletionOutcome | ReviewOutcome | ServiceOutcome | SessionOutcome
    | StepLifecycleOutcome | WorkClaimOutcome,
): DurableDecision {
  if (!outcome.ok) {
    throw new DomainRefusal(outcome.code, outcome.refusedBy, detailOf(outcome));
  }
  return Object.freeze({
    commandId: outcome.decision.key.commandId,
    disposition: outcome.disposition,
    effectId: outcome.decision.decisionId,
    resultCode: outcome.decision.resultCode,
  });
}

export function refusal(
  code: string, httpStatus: number, detail: string, layer: string,
): DecisionPortResult {
  return Object.freeze({
    outcome: "REFUSED",
    refusal: Object.freeze({ code, detail, httpStatus, layer }),
  } as const);
}

/**
 * One translation of a FAILED commit, shared by the synchronous and the asynchronous
 * decision port: a thrown refusal and a REJECTED handler promise are the same fault and
 * may not answer differently. An error neither port understands is re-thrown rather than
 * flattened — an unrecognised fault is not a refusal.
 */
export function refusalFor(error: unknown): DecisionPortResult {
  if (error instanceof DomainRefusal) {
    return refusal(error.code, error.httpStatus, error.detail, error.layer);
  }
  if (error instanceof IdempotencyConflictError) {
    return refusal(
      error.code, 409,
      "same command identity with different request bytes", "DURABLE_STORE",
    );
  }
  if (error instanceof DurableStoreError) {
    return refusal(error.code, 503, error.message, "DURABLE_STORE");
  }
  throw error;
}
