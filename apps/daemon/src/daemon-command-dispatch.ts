import type { ActivationIngressOutcome } from "./activation/activation-ingress-contracts.js";
import type { ServiceOutcome } from "./bootstrap/bootstrap-ledger.js";
import type { SessionOutcome } from "./identity/session-ledger.js";
import type { JournalAppendOutcome } from "./journal/journal-contracts.js";
import type { RecoveryCompletionOutcome } from "./recovery/recovery-completion.js";
import type { ReviewOutcome } from "./review/review-ledger.js";
import type { DecisionPortResult, DurableDecision } from "./http/http-contract.js";
import type { WorkClaimOutcome } from "./work/work-claim-services.js";

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

export function decisionOf(
  outcome: ActivationIngressOutcome | JournalAppendOutcome | RecoveryCompletionOutcome
    | ReviewOutcome | ServiceOutcome | SessionOutcome | WorkClaimOutcome,
): DurableDecision {
  if (!outcome.ok) {
    throw new DomainRefusal(
      outcome.code,
      outcome.refusedBy,
      outcome.error === null ? outcome.code : outcome.error.code,
    );
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
