import { grantRefusal } from "../supervisor/effect-grant.js";
import {
  processRefusal,
  supervisorRefusal,
  type RunVerifierProcessInput,
  type RunVerifierProcessResult,
} from "./verifier-process-contract.js";
import { launchGateRefusal } from "./verifier-process-gate.js";
import { executeVerifierRun } from "./verifier-process-run.js";

export { createNodeProcessLauncher } from "./verifier-process-launcher.js";
export type {
  LaunchedProcess,
  ProcessLauncher,
  VerifierExitObservation,
  VerifierLaunchSpec,
} from "./verifier-process-launcher.js";
export type {
  RunVerifierProcessInput,
  RunVerifierProcessOk,
  RunVerifierProcessRefused,
  RunVerifierProcessResult,
  VerifierActivation,
} from "./verifier-process-contract.js";

/**
 * The memory a pure activation grant cannot have, and the bound on that memory.
 *
 * `consumeActivationGrant` handed the same stale UNUSED record twice consumes it
 * twice, because a pure function has no memory of the first call. Two maps are
 * that memory. `IN_FLIGHT` holds the live run a duplicate delivery adopts and is
 * deleted the moment that run settles. `CONSUMED` holds what remains of a
 * settled grant: its id and the recipe digest it was bound to, never the
 * captured bytes, which would grow into an unbounded cache of every verifier's
 * output.
 *
 * `CONSUMED` retains at most `MAX_CONSUMED_GRANT_MEMORY` ids and drops the
 * longest-settled one first, so neither map gains a permanent entry per grant
 * for the life of the daemon. Forgetting an evicted id weakens no durable
 * guarantee: durable one-use memory is the daemon's compare-and-set on the
 * stored grant, and that ledger still refuses a replay of an id this map has
 * already dropped. What these maps close is the in-process window a pure
 * function cannot see at all, and they close it for THIS wrapper only, never
 * across a restart.
 */
export const MAX_CONSUMED_GRANT_MEMORY = 10_000;

interface InFlightRun {
  readonly recipeSha256: string;
  readonly run: Promise<RunVerifierProcessResult>;
}

const IN_FLIGHT = new Map<string, InFlightRun>();
/** grantId -> the recipe digest it was bound to, in settle order. */
const CONSUMED = new Map<string, string>();

/** Insertion order is eviction order, so the id dropped first settled longest ago. */
function remember(grantId: string, recipeSha256: string): void {
  CONSUMED.set(grantId, recipeSha256);
  for (const oldest of CONSUMED.keys()) {
    if (CONSUMED.size <= MAX_CONSUMED_GRANT_MEMORY) {
      break;
    }
    CONSUMED.delete(oldest);
  }
}

/** Null is the only answer that permits a launch: this grant is in neither map. */
function registryRefusalOrAdoption(
  grantId: string,
  recipeSha256: string,
): Promise<RunVerifierProcessResult> | RunVerifierProcessResult | null {
  const inFlight = IN_FLIGHT.get(grantId);
  const bound = inFlight?.recipeSha256 ?? CONSUMED.get(grantId);
  if (bound === undefined) {
    return null;
  }
  if (bound !== recipeSha256) {
    // The grant id derives from the intent and attempt and never covers the
    // recipe, so one grant presented with two recipes is a real collision.
    return processRefusal(
      "VERIFIER_PROCESS_GRANT_RUN_DIVERGENT",
      "REGISTRY",
      "this grant is already bound to a run of a different recipe",
    );
  }
  return (
    inFlight?.run ??
    supervisorRefusal(
      grantRefusal("GRANT_ALREADY_CONSUMED", "GRANT", "this grant has already launched a verifier")
        .failure,
    )
  );
}

/**
 * Launches an exact verification recipe as a real child process.
 *
 * Reads top to bottom as GATE, then REGISTRY, then SPAWN. Nothing below the gate
 * runs without a coherent, unspent activation, and nothing below the registry
 * runs twice under one grant. What comes back is at most an
 * `ObservedVerifierExecution` the production evidence layer already accepted:
 * this module never builds a receipt, because every other field a receipt binds
 * — result manifest, graph, lease, effect identity, obligations — is the
 * daemon's fact rather than the process wrapper's.
 */
export async function runVerifierProcess(
  input: RunVerifierProcessInput,
): Promise<RunVerifierProcessResult> {
  const refusal = launchGateRefusal(input);
  if (refusal !== null) {
    return refusal;
  }
  const grantId = input.activation.grant.grantId;
  const recipeSha256 = input.recipe.sha256;
  const registered = registryRefusalOrAdoption(grantId, recipeSha256);
  if (registered !== null) {
    return registered;
  }
  // Registered before the launcher is reached rather than after it returns, so a
  // duplicate delivery arriving in the same tick, including one re-entering
  // through the caller's own launcher, adopts this run rather than minting a
  // second child.
  let begin: (run: Promise<RunVerifierProcessResult>) => void = () => undefined;
  const run = new Promise<RunVerifierProcessResult>((resolve) => {
    begin = resolve;
  });
  IN_FLIGHT.set(grantId, { recipeSha256, run });
  const settle = (): void => {
    IN_FLIGHT.delete(grantId);
    remember(grantId, recipeSha256);
  };
  run.then(settle, settle);
  begin(executeVerifierRun(input));
  return run;
}
