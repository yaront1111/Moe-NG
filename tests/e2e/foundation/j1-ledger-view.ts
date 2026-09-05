/**
 * THE DURABLE READ SIDE of the J1 loop e2e, plus the one pass shape every arm travels.
 *
 * EVERY VERDICT COMES FROM THE LEDGER. The store file is opened after the processes are
 * dead and folded through the daemon's OWN read models — `readReviewLedger` and
 * `readWorkClaimLedger` — never through a reimplementation here. A view that recomputed the
 * fold would let a broken production fold and a broken test agree.
 *
 * Split out of `j1-loop-real-process.e2e.test.ts` when the canary lane pushed that file past
 * the 400-line threshold. The scripted arms and the canary now share ONE pass and ONE view,
 * so the two lanes travel identical daemon and seed code rather than two paths that merely
 * look alike.
 *
 * NO WALL CLOCK AND NO RANDOM SOURCE — `e2e-harness.test.ts` scans every non-test module in
 * this directory for four needles by plain substring match.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";

import { readReviewLedger } from "@moe/daemon";
import { SqliteEventStore } from "@moe/store";
import type { CommandDecisionRecord } from "@moe/store";
import { readLandingReceipt } from "../../../apps/daemon/src/repository/landing-ledger.js";
import { landingReceiptId } from "../../../apps/daemon/src/repository/landing-receipt-contracts.js";
import type { LandingReceiptV1 } from "../../../apps/daemon/src/repository/landing-receipt-contracts.js";

// The claim fold is not on the daemon's barrel, and this task certifies rather than edits
// production: the read model is imported at its own path instead of widening an export list.
import {
  readWorkClaimLedger,
} from "../../../apps/daemon/src/work/work-claim-read-model.js";
import {
  type J1Scratch,
  type ProcessRun,
  createJ1Scratch,
  killTree,
  runSeed,
  startDaemon,
} from "./j1-loop-harness.js";
import { executionNodeRef } from "./j1-repository-fixture.js";

/** Real processes under fleet load: a tight timeout is a flake, not a signal. */
export const ARM_TIMEOUT_MS = 240_000;
export const OPERATOR_PRINCIPAL = "operator-local";
export const VERIFIER_PRINCIPAL = "daemon:node-verifier";
const VERIFIER_RECEIPT_KIND = "internal.integration.verifier_receipt";

export interface ArmRun {
  readonly agentPid: number | null;
  readonly daemonBanner: string;
  readonly daemonPid: number;
  readonly origin: string;
  readonly scratch: J1Scratch;
  readonly seed: ProcessRun;
  readonly wrapper: ProcessRun;
}

/** Watches a pass while it runs. Returns when the pass it was handed has settled. */
export type PassWatcher = (scratch: J1Scratch, running: Promise<ProcessRun>) => Promise<void>;

/**
 * The shared pass: fresh store, REAL daemon, REAL seed, one wrapper pass, daemon reaped. The
 * only thing an arm chooses is WHICH agent the wrapper staffs.
 *
 * `sink` collects every scratch the caller created so its own `afterAll` can remove them:
 * ownership of the temp tree stays with the test file that registered the hook.
 */
export async function runPass(
  sink: J1Scratch[],
  pass: (scratch: J1Scratch) => Promise<ProcessRun>,
  watch?: PassWatcher,
  scratchOptions: Parameters<typeof createJ1Scratch>[0] = {},
): Promise<ArmRun> {
  const scratch = createJ1Scratch(scratchOptions);
  sink.push(scratch);
  const daemon = await startDaemon(scratch);
  const seed = await runSeed(scratch, daemon.origin);
  if (seed.code !== 0) throw new Error(`seed failed (${String(seed.code)}): ${seed.output}`);
  const running = pass(scratch);
  // The watcher owns the DURING window: it must not outlive the pass, so it is handed the
  // same promise the pass returns rather than a deadline of its own.
  if (watch !== undefined) await watch(scratch, running);
  const wrapper = await running;
  await killTree(daemon.child);
  const agentPid = readAgentPid(scratch);
  return {
    agentPid,
    daemonBanner: daemon.output(),
    daemonPid: daemon.pid,
    origin: daemon.origin,
    scratch,
    seed,
    wrapper,
  };
}

/** The scripted agent writes this file; a REAL agent does not, so null is an honest answer. */
function readAgentPid(scratch: J1Scratch): number | null {
  return existsSync(scratch.agentPidFile)
    ? Number.parseInt(readFileSync(scratch.agentPidFile, "utf8"), 10)
    : null;
}

/** Every durable decision, read from the store FILE after every process is gone. */
export function withStore<T>(scratch: J1Scratch, read: (store: SqliteEventStore) => T): T {
  const store = SqliteEventStore.openForProject(scratch.storePath, scratch.projectId);
  try {
    return read(store);
  } finally {
    store.close();
  }
}

function decisions(store: SqliteEventStore): readonly CommandDecisionRecord[] {
  const rows: CommandDecisionRecord[] = [];
  let cursor = 0n;
  for (;;) {
    const page = store.readCommandDecisionsAfter(cursor, 200);
    rows.push(...page.items);
    if (!page.hasMore || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return rows;
}

export interface LedgerView {
  readonly nodeRef: string;
  readonly landingReceipt: LandingReceiptV1 | null;
  readonly acceptedReceiptId: string | undefined;
  readonly agentPrincipals: readonly string[];
  readonly receiptEventCount: number;
  readonly receiptRow: CommandDecisionRecord | undefined;
  readonly rounds: number;
  readonly submitPrincipals: readonly string[];
}

export function readLedgerView(scratch: J1Scratch): LedgerView {
  const nodeRef = executionNodeRef(scratch);
  return withStore(scratch, (store) => {
    const ledger = readReviewLedger(store, scratch.projectId, nodeRef);
    const landed = ledger.accepted === undefined ? null : readLandingReceipt(store, scratch.projectId,
      landingReceiptId(scratch.projectId, nodeRef, ledger.accepted.verifierReceiptId));
    const rows = decisions(store);
    const submits = rows.filter((row) => row.commandKind === "review.submit");
    return {
      nodeRef,
      landingReceipt: landed?.ok === true ? landed.receipt : null,
      acceptedReceiptId: ledger.accepted?.verifierReceiptId,
      agentPrincipals: [...new Set(rows.map((row) => row.key.principalId))].sort(),
      receiptEventCount: store
        .readEventsByTypeAfter("VerifierReceiptRecorded", 0n, 100).items.length,
      receiptRow: rows.find((row) => row.commandKind === VERIFIER_RECEIPT_KIND),
      rounds: ledger.rounds.length,
      submitPrincipals: [...new Set(submits.map((row) => row.key.principalId))].sort(),
    };
  });
}

/** The typed session rows the journey wrote, decoded from the durable event payloads. */
export function sessionRows(scratch: J1Scratch): readonly Record<string, unknown>[] {
  const decoder = new TextDecoder();
  return withStore(scratch, (store) => store
    .readEventsByTypeAfter("SessionOpened", 0n, 100).items
    .map((event) => JSON.parse(decoder.decode(event.payload)) as Record<string, unknown>));
}

/** The run receipt the binding planning comment requires: ledger-derived, printed verbatim. */
export function printRunReceipt(arm: string, run: ArmRun, view: LedgerView): void {
  // eslint-disable-next-line no-console
  console.log(`J1 RUN RECEIPT ${JSON.stringify({
    acceptedVerifierReceiptId: view.acceptedReceiptId ?? null,
    arm,
    daemonOrigin: run.origin,
    nodeRef: view.nodeRef,
    pids: { agent: run.agentPid, daemon: run.daemonPid, wrapper: run.wrapper.pid ?? null },
    receiptDecisionId: view.receiptRow?.decisionId ?? null,
    reviewRounds: view.rounds,
    storePath: run.scratch.storePath,
    submitPrincipals: view.submitPrincipals,
    verifierReceiptEvents: view.receiptEventCount,
  }, null, 2)}`);
}

/**
 * ONE INSTANT OF THE AUTHORITY REGISTER, read from the durable claim fold while the journey
 * is still running. Sampling only after the processes are dead would answer a different and
 * much weaker question: a second holder that appeared and released mid-run leaves the final
 * state single-holder, and an end-state assertion reads green over exactly the collision it
 * was written to catch.
 */
export interface AuthoritySample {
  readonly holders: readonly string[];
  readonly readable: boolean;
}

/**
 * Fast enough that the SCRIPTED arm's claim window cannot be stepped over.
 *
 * At 750ms this sampler measured zero holders on a ~3.5s arm when the suite ran under
 * parallel load: the claim was opened and released between two samples, and the positive
 * control — "this sampler observed a holder at least once" — went red for a run in which
 * nothing was wrong. The cadence is a property of the OBSERVER, so it is the observer that
 * had to change; loosening the assertion instead would have retired the control.
 */
const SAMPLE_INTERVAL_MS = 100;
/**
 * The LIVE-agent lane samples less often on purpose. Its journey runs for minutes rather than
 * seconds, so the claim window is never at risk of being stepped over, and each sample opens
 * and closes the store file — thousands of extra opens against a store a real agent is
 * writing to would be the observer creating the contention it is there to observe.
 */
export const LIVE_SAMPLE_INTERVAL_MS = 750;

function sampleAuthority(scratch: J1Scratch): AuthoritySample {
  try {
    return withStore(scratch, (store) => {
      const ledger = readWorkClaimLedger(store, scratch.projectId);
      const open = [...ledger.claims.values()].filter((claim) => claim.status === "OPEN");
      // `unreadable` is carried, never swallowed: corrupt stored bytes must not read as
      // "nobody holds anything", which is the fail-open shape of this whole question.
      return {
        holders: [...new Set(open.map((claim) => claim.claimedBy))].sort(),
        readable: !ledger.unreadable,
      };
    });
  } catch {
    // The store file can be locked or half-created at any instant; a failed sample is
    // recorded as unreadable rather than as an observation of zero holders.
    return { holders: [], readable: false };
  }
}

/** A watcher plus the samples it took, so the test can assert the sampling itself happened. */
export function authorityWatcher(intervalMs = SAMPLE_INTERVAL_MS): {
  readonly samples: AuthoritySample[];
  readonly watch: PassWatcher;
} {
  const samples: AuthoritySample[] = [];
  const watch: PassWatcher = async (scratch, running) => {
    let settled = false;
    void running.then(() => { settled = true; }, () => { settled = true; });
    while (!settled) {
      samples.push(sampleAuthority(scratch));
      await new Promise<void>((resolve) => { setTimeout(resolve, intervalMs); });
    }
  };
  return { samples, watch };
}

/** Removes every scratch a run registered. A held Windows handle is not a test verdict. */
export function removeScratches(sink: readonly J1Scratch[]): void {
  for (const scratch of sink) {
    try {
      rmSync(scratch.root, { force: true, maxRetries: 3, recursive: true });
    } catch {
      // The OS reclaims the temp directory; failing teardown here would hide the verdict.
    }
  }
}
