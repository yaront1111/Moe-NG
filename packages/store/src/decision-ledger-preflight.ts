import { DurableStoreError } from "./store-contracts.js";
import type { CommandDecisionResponse } from "./store-contracts.js";
import type {
  SnapshotDecisionMetadata,
  SnapshotExpectedVersionRequest,
} from "./store-internals.js";
import { snapshotDecisionInputMetadata } from "./decision-ledger-canonical.js";
import type { DecisionIdentities } from "./decision-ledger-canonical.js";
import { DecisionReplayStore } from "./decision-ledger-replay.js";

/**
 * `SETTLED` means the preflight already produced the caller's answer without
 * opening a write transaction — a reconciled historical decision, or the refusal
 * reconciling it raised. `PROCEED` carries what the transaction still needs.
 */
export type DecisionPreflight =
  | { readonly kind: "SETTLED"; readonly response: CommandDecisionResponse }
  | {
      readonly kind: "PROCEED";
      readonly metadata: SnapshotDecisionMetadata;
      readonly observedVersion: number;
    };

/**
 * Everything a scoped decision must establish before it may take the write lock.
 * Shared verbatim by the single-aggregate and multi-leg entry points so both
 * enforce the same project scope, the same replay reconciliation and the same
 * one-read-snapshot discipline.
 */
export class DecisionPreflightStore extends DecisionReplayStore {
  protected requireDecisionWriteScope(): void {
    this.requireOpen();
    if (this.projectId === null || !this.writeProjectAsserted) {
      throw new DurableStoreError(
        "PROJECT_SCOPE_REQUIRED",
        "scoped command decisions require an explicitly project-asserted store handle",
      );
    }
  }

  protected preflightDecision(
    request: SnapshotExpectedVersionRequest,
    identities: DecisionIdentities,
  ): DecisionPreflight {
    if (request.key.projectId !== this.projectId) {
      throw new DurableStoreError(
        "PROJECT_SCOPE_MISMATCH",
        `the command belongs to project ${JSON.stringify(request.key.projectId)}, but this database is bound to ${JSON.stringify(this.projectId)}`,
      );
    }
    // One read snapshot for the two-SELECT tail check; a commit landing between
    // them must stay an ordinary race, not a STORE_CORRUPT preflight verdict.
    const snapshot = this.readSnapshotOperation("preflight expected-version decision", () => {
      this.assertDurableProjectBinding();
      return {
        historical: this.loadCommandDecisionByKey(request.key),
        observedVersion: this.assertAggregateTail(request.targetAggregateId),
      };
    });
    if (snapshot.historical !== null) {
      return this.settledPreflight(
        request,
        identities,
        new DurableStoreError(
          "STORE_CORRUPT",
          "a command decision disappeared between preflight and locked replay",
        ),
      );
    }
    try {
      return {
        kind: "PROCEED",
        metadata: snapshotDecisionInputMetadata(request),
        observedVersion: snapshot.observedVersion,
      };
    } catch (metadataError) {
      return this.settledPreflight(request, identities, metadataError);
    }
  }

  private settledPreflight(
    request: SnapshotExpectedVersionRequest,
    identities: DecisionIdentities,
    failure: unknown,
  ): DecisionPreflight {
    return {
      kind: "SETTLED",
      response: this.reconcileHistoricalDecision(
        request.key,
        identities.requestSha256,
        failure,
      ),
    };
  }
}
