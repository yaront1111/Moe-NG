/**
 * Settlement half of the Foundation attempt service, carved out of
 * foundation-attempt-service.ts so neither production file exceeds the epic's
 * 250-line target. PURE MOVEMENT: every function below is byte-identical to the
 * definition it replaced, including its comments, and `dispatch` calls them by
 * the same names with the same signatures.
 *
 * The factory shape mirrors the service's: it closes over the SAME
 * `FoundationAttemptDeps` instance, so `store`, `captureResult` and `lifecycle`
 * reach these functions exactly as they did when they were nested. The type is
 * imported type-only from the service to keep the runtime edge one-directional
 * — service imports settlement, never the reverse.
 */

import type { SqliteEventStore, StoredEvent } from "@moe/store";

import type { ActivationLedgerRecord } from "../activation/activation-ledger-contracts.js";
import { readFoundationActivationHistory } from "../activation/activation-ledger-reader.js";
import { applyProviderUsageToBudget } from "../budget/budget-settlement-application.js";
import { recordAttemptRelease } from "./attempt-release-disposition.js";
import { recordTerminalEffect } from "./effect-terminal-ledger.js";
import { snapshotFoundationValue } from "./foundation-attempt-codec.js";
import { foundationAttemptRefusal, refuseLocal } from "./foundation-attempt-contracts.js";
import type { FoundationAttemptBound, FoundationAttemptRefused } from "./foundation-attempt-contracts.js";
import type { FoundationAttemptDeps } from "./foundation-attempt-service.js";
import { recordProvenFoundationAttempt } from "./foundation-attempt-store.js";
import type { FoundationAttemptOutcome } from "./foundation-attempt-store.js";
import { settleUnprovenFoundationAttempt } from "./foundation-attempt-unproven-settlement.js";
import type { PreparedCapture } from "./foundation-capture-lifecycle.js";

/** Read the bound activation from durable history, never from the caller's copy. */
export function durableActivation(
  store: SqliteEventStore, bound: FoundationAttemptBound,
): ActivationLedgerRecord | FoundationAttemptRefused {
  let events: readonly StoredEvent[];
  try {
    events = store.readEvents(bound.aggregateId);
  } catch {
    return refuseLocal("FOUNDATION_ATTEMPT_ACTIVATION_UNREADABLE");
  }
  const history = readFoundationActivationHistory(bound.aggregateId, events, bound.projectId);
  if (!history.ok) {
    const { result } = history;
    return result.status === "BOUND" ? refuseLocal("FOUNDATION_ATTEMPT_ACTIVATION_UNREADABLE")
      : foundationAttemptRefusal(result.code, result.layer);
  }
  const { record } = history.history;
  return record.lease.ownerSessionRef === bound.sessionId
    && bound.claim["intentId"] === record.effectIntent.intentId
    && bound.claim["wrapperIdentity"] === record.grant.wrapperIdentity
    ? record : refuseLocal("FOUNDATION_ATTEMPT_BINDING_MISMATCH");
}

/** Snapshot capture answers without awaiting untrusted non-native thenables. */
async function contained(call: () => unknown): Promise<unknown> {
  try {
    const pending = call();
    return snapshotFoundationValue(pending instanceof Promise ? await pending : pending);
  } catch { return null; }
}

/** Only a proven settle earns the unchanged resumable release reason. */
const SETTLE_REASONS = Object.freeze({
  PROVEN: "WORK_RELEASE_OR_PAUSE", UNPROVEN: "WORK_CANCEL",
} as const);

export function createFoundationAttemptSettlement(deps: FoundationAttemptDeps) {
  const { store } = deps;

  /** NONE of the four settle facts is ours to report any more, so none is here:
   *  `safeBoundaryObserved` comes from the durable provider-run record
   *  (task-ded026d6), the terminality pair from the terminal ledger and the
   *  resource authority (task-6d400781), and the nine-key scheduler `handoff` is
   *  now SERVER-BUILT from durable Foundation facts (task-a20e8ef6). A request
   *  carrying any of the four is refused, not obeyed — including one that merely
   *  spells `handoff`, which is why the key is absent here rather than null. */
  function noteRelease(
    bound: FoundationAttemptBound, record: ActivationLedgerRecord,
    settled: FoundationAttemptOutcome, reason = settled.ok
      ? SETTLE_REASONS.PROVEN
      : SETTLE_REASONS.UNPROVEN,
  ): FoundationAttemptOutcome {
    recordAttemptRelease(store, bound, record, {
      disposition: null,
      intentRefs: [record.effectIntent.intentId],
      reason,
    });
    return settled;
  }

  /** Only a proven physical observation reaches result capture. The captureRef
   *  travels here lexically, from the preparation this very dispatch made, and so
   *  does `decidedAt`: it is the ACTIVATION's own decided-at, the single durable
   *  stamp this dispatch was decided under. No daemon clock exists to read one
   *  from, and a stamp invented here would be a durable audit field asserting a
   *  time nothing observed. */
  async function capture(
    bound: FoundationAttemptBound, record: ActivationLedgerRecord,
    input: Record<string, unknown>, observation: unknown, registration: unknown,
    prepared: PreparedCapture, decidedAt: string,
  ): Promise<FoundationAttemptOutcome> {
    const answer = await contained(() => deps.captureResult({
      attemptId: record.attempt.attemptId, baseIdentity: input["baseIdentity"] as string,
      captureRef: prepared.captureRef, nodeKey: bound.nodeKey, observation,
      // THE PROOF TRAVELS LEXICALLY TOO, and it has to: it is not a field of the
      // durable record, re-deriving one after a launch refuses a tree the attempt
      // legitimately changed, and `sealPrelaunchProof` is withheld from
      // `@moe/runner` so no consumer may mint one. Like `captureRef` it comes from
      // the preparation THIS dispatch made, never from anything a caller sent.
      proof: prepared.proof, sessionId: bound.sessionId,
    }));
    // THE AUTHORITY'S SEALED INPUT, not the caller's proposal. `input` here is
    // `buildInputManifest` over the entries the REQUEST proposed, and a request
    // may lawfully propose a subset — `entriesAgree` checks each proposed entry
    // against the hydrated bytes and admits a partial (even empty) list. Sealing
    // the result against that subset makes the proposal decide which paths are
    // attributable: every honestly captured in-scope path the caller did not
    // name comes back RUNNER_WORKSPACE_PATH_UNDECLARED. Measured, not feared —
    // that is exactly how the first real producer answer refused. The workspace
    // the answer describes was hydrated from the AUTHORITATIVE declared scope,
    // so that is the input it must be sealed against.
    // THE DURABLE TERMINAL, derived by the runner from already-committed evidence and recorded
    // BEFORE the advisory release, which now DERIVES its terminality from this very ledger —
    // load-bearing order, not incidental. Refusals are still not consumed: no terminal proven
    // must not stop an attempt that ran, and the release says so by draining, not releasing.
    const terminal = recordTerminalEffect(store, {
      attemptRef: record.attempt.attemptId, projectId: bound.projectId,
    });
    // THE BUDGET SETTLES ONLY AFTER THE TERMINAL IS DURABLE, AND ON ITS OWN DECISION.
    //
    // `recordTerminalEffect` refuses EFFECT_TERMINAL_EVIDENCE_ABSENT unless the provider run is
    // already committed for this attempt, so gating on its ok is what makes telemetry durability
    // a PRECONDITION of settlement rather than a coincidence: wired any earlier, every settlement
    // would read UNKNOWN forever while its own UNKNOWN arm passed.
    //
    // It rides a SEPARATE decision rather than a leg of the terminal's: that path commits a
    // single-target decision, and converting it to the legs API would change a landed replay
    // identity on a surface this change does not own. A settlement refusal is ADVISORY here for
    // the same reason the terminal's own refusal is — an attempt that ran is not unmade by a
    // ledger that could not be read, and the refusal carries its own code and layer for a reader.
    //
    // THE DECISION KEY IS THE DURABLE TRUTH, NOT A CONVENIENCE. `decidedAt` is written straight
    // onto the durable decision as its own `decidedAt` (and onto the rejection audit as
    // `committedAt`), and `principalId` is a third of `budgetDecisionKey` — together they are the
    // row a recovery reads to answer WHO decided this settlement and WHEN.
    // Both therefore come from durable facts this dispatch already holds: the activation's own
    // decided-at, and the lease owner session the provider-run commit below is keyed by too.
    // Neither is a daemon clock reading and neither is the project — a project decides nothing.
    if (terminal.ok) {
      applyProviderUsageToBudget(store, {
        attemptRef: record.attempt.attemptId,
        context: {
          commandId: `settle-${record.attempt.attemptId}`,
          correlationId: `budget-settlement-${record.attempt.attemptId}`,
          decidedAt, principalId: record.lease.ownerSessionRef,
        },
        projectId: bound.projectId,
      });
    }
    const settled = noteRelease(bound, record, recordProvenFoundationAttempt(
      store, bound, record, prepared.inputManifest as unknown as Record<string, unknown>,
      { answer, observation, registration }));
    // ONLY a proven durable result may release its tree. An unproven or uncertain
    // settlement retains the bytes: they are the only evidence of what ran.
    if (settled.ok) {
      deps.lifecycle.releaseWorktree({
        assignment: prepared.assignment, callerIntent: "ATTEMPT_TERMINAL",
      });
    }
    return settled;
  }

  /** Persist unproven advisory truth under the upstream code/layer. */
  function unproven(
    bound: FoundationAttemptBound, record: ActivationLedgerRecord,
    input: Record<string, unknown>, result: Record<string, unknown> | null,
  ): FoundationAttemptOutcome {
    return settleUnprovenFoundationAttempt(
      store, bound, record, input, result,
      // NO REASON OVERRIDE HERE, and the omission is load-bearing. `noteRelease` already
      // defaults to SETTLE_REASONS.UNPROVEN for a non-ok settle, and this path is always
      // non-ok. Passing SETTLE_REASONS.PROVEN instead would FABRICATE AN AUTHORITY TOKEN:
      // `expansion-release-authority.ts` reads this very row through `readAttemptRelease`,
      // and its `releaseUnsafe` admits a release only when `reason`,
      // `disposition.strongestReason` and `disposition.resumable` all equal
      // WORK_RELEASE_OR_PAUSE — so an attempt refusing FOUNDATION_ATTEMPT_LAUNCH_UNKNOWN
      // would clear a gate built to refuse it, durably and at expectedVersion 0.
      // Nor is the override defensible as DRAIN avoidance: `lease-drain` computes
      // `settled = safeBoundaryObserved && effectsTerminal && resourcesTerminal`, in which
      // `reason` is not a term, so WORK_CANCEL cannot force DRAINING on a settled
      // boundary. The rule at SETTLE_REASONS holds unqualified: only a proven settle
      // earns the resumable release reason.
      (settled) => noteRelease(bound, record, settled),
    );
  }
  return Object.freeze({ capture, noteRelease, unproven });
}
