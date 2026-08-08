import { deepFreeze } from "../canonical.js";
import { resolveDrainRow, type DrainOutcome } from "./drain-reconciliation.js";
import type { DrainTerminalTarget } from "./drain-table.js";
import { validateActivationCommit } from "./effect-grant.js";
import {
  isTerminalEffectState,
  supervisorFailure,
  type SupervisorErrorCode,
  type SupervisorFailure,
} from "./effect-kernel.js";
import { applyEffectTombstone } from "./effect-lifecycle.js";
import { parseRestartRecords, recordsDisagree, type RestartRecords } from "./restart-records.js";

/**
 * Re-derives exactly one legal state from durable records after a crash.
 *
 * The hard rule is that ambiguity is an ANSWER, not a nuisance to be resolved.
 * Where the records admit more than one reading the reconstruction returns
 * `UNKNOWN` or `SUSPECT`; where a terminal is claimed without the evidence that
 * proves it, it refuses. Epic rail 4: unverifiable evidence never gains
 * authority, and "the process is probably gone" is not evidence.
 *
 * Nothing here re-implements a check that already exists. Partial commits go to
 * child 1's `validateActivationCommit`, tombstone domination to
 * `applyEffectTombstone`, and every drain decision to the design-786/787 table
 * in `drain-reconciliation.ts` — duplicating that table here would give the
 * system two answers to the same question.
 */
export const RESTART_POST_STATES = Object.freeze([
  "ACTIVE_ADOPTED",
  "TOMBSTONED",
  "DRAINING",
  "TERMINAL_PROVEN",
  "RECONCILE_ONLY",
  "SUSPECT",
  "UNKNOWN",
] as const);
export type RestartPostState = (typeof RESTART_POST_STATES)[number];

export type RestartOutcome =
  | {
      readonly kind: "RECONSTRUCTED";
      readonly ok: true;
      readonly postState: RestartPostState;
      readonly terminalTarget: DrainTerminalTarget | null;
      readonly capacityHeld: boolean;
    }
  | { readonly kind: "REFUSED"; readonly failure: SupervisorFailure };

const COMMAND = "restart.reconstruct";

function refuse(code: SupervisorErrorCode, message: string): RestartOutcome {
  return Object.freeze({
    kind: "REFUSED" as const,
    failure: supervisorFailure(code, "RESTART", message, {
      state: null,
      command: COMMAND,
      leg: null,
    }),
  });
}

function reconstructed(
  postState: RestartPostState,
  terminalTarget: DrainTerminalTarget | null = null,
  capacityHeld = false,
): RestartOutcome {
  return deepFreeze({
    kind: "RECONSTRUCTED" as const,
    ok: true as const,
    postState,
    terminalTarget,
    capacityHeld,
  });
}

/**
 * A drain refusal is re-stamped at the RESTART layer because the restart is the
 * surface that answered the caller. The CODE is preserved verbatim, so
 * `RESTART_SAFE_HANDOFF_ABSENT` still names the same missing fact it names at
 * the drain layer, and only the layer says who refused.
 */
function fromDrain(outcome: DrainOutcome): RestartOutcome {
  switch (outcome.kind) {
    case "REFUSED":
      return refuse(outcome.failure.code, outcome.failure.message);
    case "TERMINALIZED":
      return reconstructed("TERMINAL_PROVEN", outcome.terminalTarget);
    case "DRAINING":
      return reconstructed("DRAINING", null, outcome.capacityHeld);
    case "TOMBSTONED":
      return reconstructed("TOMBSTONED");
    case "RECONCILE_ONLY":
      return reconstructed("RECONCILE_ONLY");
    case "ATOMIC_ACTIVATION":
      // A restart never re-runs the activation edge; that decision belongs to
      // `activateEffect` under a fresh grant, not to a rehydrating reader.
      return reconstructed("UNKNOWN");
  }
}

function routeToDrain(records: RestartRecords): RestartOutcome {
  return fromDrain(
    resolveDrainRow({
      attemptState: records.attemptState,
      effectState: records.intent.state,
      resourceFact: records.resourceFact,
      activationRequested: false,
      disposition: records.disposition,
      reconciliation: records.reconciliation,
      safeHandoff: records.safeHandoff,
    }),
  );
}

/**
 * Design 790: a terminal attempt never resurrects. A terminal EFFECT still has
 * to prove itself — a settled label with no reconciliation behind it is exactly
 * the premature terminal this refuses.
 */
function reconstructTerminalAttempt(records: RestartRecords): RestartOutcome {
  if (!isTerminalEffectState(records.intent.state)) {
    return reconstructed("RECONCILE_ONLY");
  }
  if (records.reconciliation === null) {
    return refuse(
      "RESTART_PREMATURE_TERMINAL",
      "a terminal effect state carries no reconciliation that proves it",
    );
  }
  if (records.resourceFact !== "PROVEN_RELEASED") {
    return reconstructed("UNKNOWN");
  }
  return reconstructed("TERMINAL_PROVEN");
}

/**
 * A `RUNNING` attempt is adoptable only when the records still identify the
 * process: a claim, a consumed-or-issued grant, a registration, and a held lock.
 * Missing any of them, two readings survive — the process is live and
 * unidentified, or it is gone — so the answer is UNKNOWN.
 */
function reconstructRunningAttempt(records: RestartRecords): RestartOutcome {
  const identified =
    records.claim !== null &&
    records.grant !== null &&
    records.registration !== null &&
    records.lockState === "HELD";
  return identified ? reconstructed("ACTIVE_ADOPTED", null, true) : reconstructed("UNKNOWN");
}

export function reconstructAfterRestart(recordsValue: unknown): RestartOutcome {
  const records = parseRestartRecords(recordsValue);
  if (records === null) {
    return refuse("RESTART_RECORDS_INCOHERENT", "the durable record set does not parse");
  }
  if (recordsDisagree(records)) {
    return refuse(
      "RESTART_RECORDS_INCOHERENT",
      "the attempt and effect records were not written together",
    );
  }
  if (records.attemptState === "RUNNING" && records.grant !== null) {
    const commit = validateActivationCommit(records.intent, records.attempt, records.grant);
    if (commit.kind === "REFUSED") {
      return refuse("RESTART_RECORDS_INCOHERENT", commit.failure.message);
    }
  }
  if (records.lockState === "UNKNOWN") {
    return reconstructed("SUSPECT");
  }
  if (records.observation !== null && records.registration === null) {
    return reconstructed("SUSPECT");
  }
  if (records.tombstone !== null && records.attemptState === "ABSENT") {
    const dominated = applyEffectTombstone(records.intent, records.tombstone);
    if (dominated.kind === "TRANSITIONED") {
      return reconstructed("TOMBSTONED");
    }
  }
  if (records.attemptState === "TERMINAL") {
    return reconstructTerminalAttempt(records);
  }
  if (records.attemptState === "RUNNING") {
    return reconstructRunningAttempt(records);
  }
  return routeToDrain(records);
}
