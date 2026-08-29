/**
 * The genesis budget root as a CAPTURED LEG — the zero-amount authorization a project must hold
 * before it can spend anything, built at approval and committed by the approval's own decision.
 *
 * WHY IT IS A LEG AND NOT A COMMIT (the governor's Option-B ruling). Committing the root first
 * and approving second makes the root's `graphRevisionRef` binding PERMANENT the moment it
 * lands, because the once-only guard (budget-ledger.ts:104-106) forbids a second one: an
 * approval that then refuses would leave spend authority bound to a revision nobody approved,
 * uncorrectable. Captured as a leg, the root is bytes until the approval's decision commits it,
 * so a refused approval leaves NO root at all and neither aggregate moves.
 *
 * NOTHING HERE DECIDES ANYTHING ABOUT MONEY. `authorizeBudgetRoot` is the production writer and
 * still runs whole — admission, replay, the once-only guard, the `@moe/scheduler` reducer — with
 * a capturing commit port instead of the store. Its refusals are forwarded UNTOUCHED, because
 * every one of them is raised BEFORE the commit port is reached and restamping them would hide
 * which layer actually said no.
 *
 * AND THE OTHER HALF: `resolveApprovalBudgetRoot` at the foot of this file. Genesis answers a
 * project that has NEVER been authorized; a project that already holds a durable root needs its
 * DIGEST, not a second root the once-only guard would refuse anyway. Minting is therefore the
 * absent case, not the only case, and the two are kept in one module because they answer one
 * question — "which durable budget authorization does this approval bind to" — and separating
 * them would let a caller ask half of it.
 */

import type { ExpectedVersionDecisionLeg, SqliteEventStore } from "@moe/store";

import { captureBudgetLeg } from "../activation/activation-budget-derivation.js";
import { budgetCommitmentMaterial } from "./budget-commitment.js";
import { readGoalBudgetIdentity } from "./budget-durable-binding.js";
import type { GenesisApprovedRun } from "./budget-genesis-binding.js";
import { decodeBudgetLedgerRecord, encodeBudgetLedgerRecord } from "./budget-ledger-codec.js";
import {
  BUDGET_LEDGER_EVENT_TYPE,
  budgetLedgerRefusal,
  budgetProjectionRefusal,
  deriveBudgetAggregateId,
} from "./budget-ledger-contracts.js";
import type { BudgetLedgerRecord, BudgetRefusal } from "./budget-ledger-contracts.js";
import { authorizeBudgetRoot } from "./budget-ledger.js";
import type { BudgetCommitContext } from "./budget-ledger-requests.js";

/**
 * The genesis denominator: EVERY admission meter, each authorized at zero — nonempty and
 * bidirectionally complete, because `amounts: []` is refused by the scheduler and would erase
 * the distinction this record exists to make, while a denominator short of the roster leaves a
 * meter that can never be funded (the once-only guard means there is no second root).
 *
 * RE-EXPORTED, NOT REDECLARED (task-61a2e8ad, ruling condition 1): the amounts are part of the
 * material the decide-time commitment covers, so `budget-commitment.ts` owns them as the single
 * canonical builder and this module consumes them. Existing importers keep this name.
 */
export { GENESIS_AMOUNTS } from "./budget-commitment.js";

export interface GenesisLegInput {
  readonly approvedRun: GenesisApprovedRun;
  readonly context: BudgetCommitContext;
  readonly goalRef: string;
  readonly projectId: string;
}

/**
 * `digest` is the writer's OWN canonical digest over the record it would commit — the
 * server-computed value a caller's `budgetHash` is compared against, never adopted from.
 */
export type GenesisLegResult =
  | {
      readonly ok: true;
      readonly digest: string;
      readonly leg: ExpectedVersionDecisionLeg;
      readonly record: BudgetLedgerRecord;
    }
  | BudgetRefusal;

/**
 * Runs the production root writer against a capturing port and returns the leg it would write.
 *
 * The store is READ (bindings, replay, the once-only guard) and never written: a leg is a
 * proposal, and the only thing that can make it durable is the caller putting it in a decision.
 */
export function buildGenesisBudgetLeg(
  store: SqliteEventStore, input: GenesisLegInput,
): GenesisLegResult {
  // RULING CONDITION 1: the material comes from the ONE canonical builder, and the writer is
  // handed that exact object rather than a second assembly of the same facts. A refusal is
  // forwarded with the reader's own code and layer, unchanged.
  const material = budgetCommitmentMaterial(store, {
    approvedRun: input.approvedRun, goalRef: input.goalRef, projectId: input.projectId,
  });
  // The reader's OWN refusal, re-raised whole. Rebuilding one from `upstream` would drop
  // `sourceCode`/`sourceLayer`, and those are exactly what tells a clean empty project apart
  // from an unreadable history - the distinction budget-genesis-binding.ts exists to preserve.
  if (!material.ok) return material.refusal;
  const captured = captureBudgetLeg((commit) => authorizeBudgetRoot(
    store,
    {
      amounts: material.material.amounts,
      context: input.context,
      goalRef: input.goalRef,
      projectId: input.projectId,
    },
    commit,
    () => Object.freeze({ binding: material.material.binding, ok: true as const }),
  ));
  const result = captured.result;
  if (!result.ok) return result;
  if (!("leg" in captured)) {
    // The writer answered OK without reaching the commit port — a REPLAY of an earlier decision,
    // whose events are already durable somewhere else. There is no leg to hand back and
    // reporting one would fabricate a second write of bytes that already exist.
    return budgetLedgerRefusal("REFUSED", "BUDGET_LEDGER_IDEMPOTENCY_CONFLICT");
  }
  return Object.freeze({
    digest: result.digest, leg: captured.leg, ok: true as const, record: result.record,
  });
}

/**
 * The budget root an approval binds to, and where it came from.
 *
 * `GENESIS` carries a leg the caller MUST commit; `EXISTING` carries none, because the root is
 * already durable and this approval must not write a second one. Both carry the same thing the
 * approval actually needs: a digest recomputed from durable bytes.
 */
export type ApprovalBudgetRoot =
  | {
      readonly ok: true;
      readonly digest: string;
      readonly leg: ExpectedVersionDecisionLeg;
      readonly record: BudgetLedgerRecord;
      readonly source: "GENESIS";
    }
  | {
      readonly ok: true;
      readonly digest: string;
      readonly record: BudgetLedgerRecord;
      readonly source: "EXISTING";
    }
  | BudgetRefusal;

/**
 * The digest of a root that is ALREADY durable, RECOMPUTED from its own bytes.
 *
 * Nothing is trusted here: the frame's digest is verified against a re-hash of the body by the
 * codec, the decoded record is re-encoded and the two digests must agree, and the binding must
 * name THIS project and goal. The event id also embeds the digest and is deliberately NOT the
 * source — an id is a label a writer chose, and a label cannot be recomputed from the bytes it
 * labels.
 */
function readAuthorizedRootDigest(
  store: SqliteEventStore, projectId: string, goalRef: string,
): ApprovalBudgetRoot {
  const identity = readGoalBudgetIdentity(store, projectId, goalRef);
  if (!identity.ok) return identity;
  const [first] = store.readEvents(
    deriveBudgetAggregateId(projectId, identity.identity.budgetAccountRef));
  if (first === undefined) return budgetProjectionRefusal("BUDGET_PROJECTION_ABSENT");
  if (first.eventType !== BUDGET_LEDGER_EVENT_TYPE) {
    return budgetProjectionRefusal("BUDGET_PROJECTION_CORRUPT");
  }
  const decoded = decodeBudgetLedgerRecord(first.payload);
  if (!decoded.ok) return decoded;
  const record = decoded.record;
  if (record.transition !== "ROOT_AUTHORIZED") {
    return budgetProjectionRefusal("BUDGET_PROJECTION_CORRUPT");
  }
  if (record.binding.projectId !== projectId || record.binding.goalRef !== goalRef) {
    return budgetProjectionRefusal("BUDGET_PROJECTION_SCOPE_FOREIGN");
  }
  const reencoded = encodeBudgetLedgerRecord(record);
  if (!reencoded.ok) return reencoded;
  return Object.freeze({ digest: reencoded.digest, ok: true as const, record, source: "EXISTING" as const });
}

/**
 * MINT IF ABSENT, READ IF PRESENT — the whole budget question an approval has to answer.
 *
 * A project reaching its first approval has no budget account at all, and the genesis leg above
 * establishes one atomically with the decision. A project that ALREADY has a durable root must
 * not get a second: the once-only guard forbids it, and the approval's job was never to mint —
 * it was to bind this activation to the authorization in force, by a digest the server
 * recomputes. Both paths end at a durable record; neither ever reads a caller's hash.
 *
 * ONLY `BUDGET_LEDGER_ALREADY_AUTHORIZED` crosses over. Every other refusal — an absent goal, a
 * foreign scope, a corrupt graph history, a reducer declining — is forwarded untouched, so a
 * broken world can never be mistaken for an established one.
 */
export function resolveApprovalBudgetRoot(
  store: SqliteEventStore, input: GenesisLegInput,
): ApprovalBudgetRoot {
  const genesis = buildGenesisBudgetLeg(store, input);
  if (genesis.ok) {
    return Object.freeze({
      digest: genesis.digest, leg: genesis.leg, ok: true as const,
      record: genesis.record, source: "GENESIS" as const,
    });
  }
  if (genesis.code !== "BUDGET_LEDGER_ALREADY_AUTHORIZED") return genesis;
  return readAuthorizedRootDigest(store, input.projectId, input.goalRef);
}
