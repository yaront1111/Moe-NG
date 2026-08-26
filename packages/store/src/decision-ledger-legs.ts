import { identifyCommandRequest } from "./store-digests.js";
import {
  commitAcceptedDecisionEffect,
  commitRejectedDecisionEffect,
} from "./decision-ledger-canonical.js";
import type {
  DecisionEffectContext,
  DecisionIdentities,
} from "./decision-ledger-canonical.js";
import type {
  AppendDecisionLegPlan,
  DecisionLegPlan,
  DecisionLegsPlan,
} from "./decision-ledger-fences.js";
import { buildDecisionLegRoster } from "./decision-leg-roster-persistence.js";
import { writeCanonicalDecision } from "./decision-ledger-record.js";
import type { DecisionRecordContext } from "./decision-ledger-record.js";
import type {
  SnapshotDecisionMetadata,
  StoredCommandDecision,
  StoredCommitResult,
} from "./store-internals.js";

export interface DecisionLegsContext {
  readonly effect: DecisionEffectContext;
  readonly record: DecisionRecordContext;
}

function rejectedDecision(
  ctx: DecisionLegsContext,
  identities: DecisionIdentities,
  metadata: SnapshotDecisionMetadata,
  plan: DecisionLegsPlan,
  staleLeg: DecisionLegPlan,
  observedVersion: number,
): StoredCommandDecision {
  return writeCanonicalDecision(ctx.record, {
    effect: commitRejectedDecisionEffect(
      ctx.effect,
      staleLeg.request,
      identities,
      metadata.decidedAt,
      observedVersion,
    ),
    identities,
    metadata,
    observedVersion,
    request: staleLeg.request,
    roster: buildDecisionLegRoster(
      identities.decisionId,
      plan.legs.map(({ aggregateId, expectedVersion }) => ({
        aggregateId,
        expectedVersion,
        receipt: null,
      })),
    ),
  });
}

function appendSecondary(
  ctx: DecisionLegsContext,
  plan: AppendDecisionLegPlan,
  observedVersion: number,
): StoredCommitResult {
  return ctx.effect.writeCommitEffects(
    plan.commitInput,
    identifyCommandRequest(plan.commitInput),
    observedVersion,
  );
}

/** Checks every version before writing any effect; caller already holds the write lock. */
export function decideLegsUnderLock(
  ctx: DecisionLegsContext,
  identities: DecisionIdentities,
  metadata: SnapshotDecisionMetadata,
  plan: DecisionLegsPlan,
): StoredCommandDecision {
  const observedVersions = plan.legs.map(({ aggregateId }) =>
    ctx.effect.assertAggregateTail(aggregateId));
  const staleIndex = observedVersions.findIndex(
    (version, index) => version !== plan.legs[index]!.expectedVersion,
  );
  if (staleIndex !== -1) {
    return rejectedDecision(
      ctx,
      identities,
      metadata,
      plan,
      plan.legs[staleIndex]!,
      observedVersions[staleIndex]!,
    );
  }

  const primary = plan.legs[0];
  const effect = commitAcceptedDecisionEffect(
    ctx.effect,
    { commitInput: primary.commitInput, resultBytes: plan.resultBytes },
    observedVersions[0]!,
  );
  const receipts: (StoredCommitResult | null)[] = [effect.receipt];
  for (let index = 1; index < plan.legs.length; index += 1) {
    const leg = plan.legs[index]!;
    receipts.push(
      leg.kind === "APPEND" ? appendSecondary(ctx, leg, observedVersions[index]!) : null,
    );
  }
  return writeCanonicalDecision(ctx.record, {
    effect,
    identities,
    metadata,
    observedVersion: observedVersions[0]!,
    request: primary.request,
    roster: buildDecisionLegRoster(
      identities.decisionId,
      plan.legs.map(({ aggregateId, expectedVersion }, index) => ({
        aggregateId,
        expectedVersion,
        receipt: receipts[index] ?? null,
      })),
    ),
  });
}
