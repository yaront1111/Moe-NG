/**
 * The J1 loop over REAL PROCESSES: `daemon-main.ts`, the shipped `demo-seed-main.ts` and
 * `agent-wrapper-main.ts`, each spawned as its own OS process, driving one seeded code node
 * from READY to COMMITTED.
 *
 * WHAT THIS TURNS INTO EVIDENCE. The "full loop live-proven Aug 9-10" premise is graded
 * PARTIAL: two agents over two chain steps are ledger-proven at d8a5632, full-chain code-node
 * delivery was prose in the runbook. This test is the ledger evidence for the whole chain with
 * a SCRIPTED coder. It does NOT cover the wrapper's `--bare` spawner flags (by design: no real
 * `claude` in an automated run) — their first live proof belongs to the canary/demo lane.
 *
 * EVERY VERDICT COMES FROM THE DURABLE LEDGER, read from the store FILE after the processes
 * are dead. Child stdout is used only to harvest the ephemeral origin, the pids, and the
 * refusal body the forged-credential arm must echo verbatim.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";

import { readReviewLedger } from "@moe/daemon";
import { SqliteEventStore } from "@moe/store";
import type { CommandDecisionRecord } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";

import {
  type AgentArm,
  type J1Scratch,
  type ProcessRun,
  NODE_REF,
  createJ1Scratch,
  killTree,
  pidIsAlive,
  runSeed,
  runWrapper,
  startDaemon,
} from "./j1-loop-harness.js";

/** Real processes under fleet load: a tight timeout is a flake, not a signal. */
const ARM_TIMEOUT_MS = 240_000;
const OPERATOR_PRINCIPAL = "operator-local";
const VERIFIER_PRINCIPAL = "daemon:node-verifier";
const VERIFIER_RECEIPT_KIND = "internal.integration.verifier_receipt";

interface ArmRun {
  readonly agentPid: number | null;
  readonly daemonBanner: string;
  readonly daemonPid: number;
  readonly origin: string;
  readonly scratch: J1Scratch;
  readonly seed: ProcessRun;
  readonly wrapper: ProcessRun;
}

const scratches: J1Scratch[] = [];

afterAll(() => {
  for (const scratch of scratches) {
    try {
      rmSync(scratch.root, { force: true, maxRetries: 3, recursive: true });
    } catch {
      // A held handle on Windows is not a test verdict; the OS reclaims the temp dir.
    }
  }
});

/**
 * One full arm: fresh store, REAL daemon on an ephemeral port, REAL seed, REAL wrapper for a
 * single ONCE pass, then the daemon reaped. The wrapper is awaited rather than polled: in ONCE
 * mode it verifies, staffs, settles its children and verifies again before exiting, so its
 * exit is the honest boundary of the pass.
 */
async function runArm(arm: AgentArm): Promise<ArmRun> {
  const scratch = createJ1Scratch();
  scratches.push(scratch);
  const daemon = await startDaemon(scratch);
  const seed = await runSeed(scratch, daemon.origin);
  if (seed.code !== 0) throw new Error(`seed failed (${String(seed.code)}): ${seed.output}`);
  const wrapper = await runWrapper(scratch, arm);
  await killTree(daemon.child);
  const agentPid = existsSync(scratch.agentPidFile)
    ? Number.parseInt(readFileSync(scratch.agentPidFile, "utf8"), 10)
    : null;
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

/** Every durable decision, read from the store FILE after every process is gone. */
function withStore<T>(scratch: J1Scratch, read: (store: SqliteEventStore) => T): T {
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

interface LedgerView {
  readonly acceptedReceiptId: string | undefined;
  readonly agentPrincipals: readonly string[];
  readonly receiptEventCount: number;
  readonly receiptRow: CommandDecisionRecord | undefined;
  readonly rounds: number;
  readonly submitPrincipals: readonly string[];
}

function readLedgerView(scratch: J1Scratch): LedgerView {
  return withStore(scratch, (store) => {
    const ledger = readReviewLedger(store, scratch.projectId, NODE_REF);
    const rows = decisions(store);
    const submits = rows.filter((row) => row.commandKind === "review.submit");
    return {
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

/**
 * The daemon's own READY foundation receipt, parsed off its banner. Asserting the PARSED
 * record rather than a substring is what makes it evidence: the receipt names the pid this
 * test spawned and the scratch store it opened, so a stub printing a plausible line cannot
 * satisfy it.
 */
function readyReceipt(banner: string): Record<string, unknown> {
  const line = banner.split("\n")
    .find((candidate) => candidate.includes('"kind":"READY"'));
  if (line === undefined) throw new Error(`the daemon printed no READY receipt: ${banner}`);
  return JSON.parse(line.trim()) as Record<string, unknown>;
}

/**
 * The refusal the wrapper's MCP host returned to the forged bearer, echoed by the agent and
 * lifted here VERBATIM so the code and the layer are reviewable without rerunning the suite.
 */
function refusalLine(output: string): string {
  return output.split("\n")
    .find((line) => line.includes("fake-agent: REFUSED status="))?.trim() ?? "<no refusal line>";
}

/**
 * The same refusal, PARSED. A missing line throws rather than returning an empty object: a
 * `toMatchObject` against `{}` would pass on a run where nothing was ever refused.
 */
function refusalBody(output: string): unknown {
  const line = refusalLine(output);
  const marker = line.indexOf("body=");
  if (marker === -1) throw new Error(`no refusal body in wrapper output: ${line}`);
  return JSON.parse(line.slice(marker + "body=".length)) as unknown;
}

/** The run receipt the binding planning comment requires: ledger-derived, printed verbatim. */
function printRunReceipt(arm: AgentArm, run: ArmRun, view: LedgerView): void {
  // eslint-disable-next-line no-console
  console.log(`J1 RUN RECEIPT ${JSON.stringify({
    acceptedVerifierReceiptId: view.acceptedReceiptId ?? null,
    arm,
    daemonOrigin: run.origin,
    nodeRef: NODE_REF,
    pids: { agent: run.agentPid, daemon: run.daemonPid, wrapper: run.wrapper.pid ?? null },
    receiptDecisionId: view.receiptRow?.decisionId ?? null,
    reviewRounds: view.rounds,
    storePath: run.scratch.storePath,
    submitPrincipals: view.submitPrincipals,
    verifierReceiptEvents: view.receiptEventCount,
  }, null, 2)}`);
}

describe("J1 loop over real daemon, wrapper and agent processes", () => {
  it("carries one seeded node to COMMITTED through the daemon's own verifier", async () => {
    const run = await runArm("complete");
    const view = readLedgerView(run.scratch);
    printRunReceipt("complete", run, view);

    // DoD 1 — REAL entrypoints, not stubs: the daemon bound an ephemeral port and printed its
    // own READY receipt naming the control-room entry, its pid and the scratch store it opened.
    expect(run.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(readyReceipt(run.daemonBanner)).toMatchObject({
      entry: "CONTROL_ROOM_HTTP",
      pid: run.daemonPid,
      projectId: run.scratch.projectId,
      storePath: run.scratch.storePath,
    });
    expect(run.seed.output).toContain(`READY node.deliver@${NODE_REF}`);
    // The wrapper's own output is the only place a spawn refusal is stated, so a nonzero pass
    // surfaces it verbatim instead of failing on a bare exit code with nothing to read.
    if (run.wrapper.code !== 0) {
      throw new Error(`wrapper exited ${String(run.wrapper.code)}: ${run.wrapper.output}`);
    }
    expect(run.wrapper.code).toBe(0);

    // DoD 1 — COMMITTED, asserted from the durable ledger and not from any process output.
    expect(view.rounds).toBeGreaterThan(0);
    expect(view.acceptedReceiptId).toBeDefined();

    // The DAEMON-SIDE verifier acceptance, explicitly instead of an agent self-report: the
    // receipt row is the one `recordVerifierReceipt` wrote, keyed on the acceptance the review
    // ledger folded, and attributed to the daemon's own verifier principal.
    expect(view.receiptRow?.key.commandId).toBe(view.acceptedReceiptId);
    expect(view.receiptRow?.key.principalId).toBe(VERIFIER_PRINCIPAL);
    expect(view.receiptEventCount).toBeGreaterThan(0);

    // The agent's submission is attributed to its SCOPED session principal, never the operator.
    expect(view.submitPrincipals).toHaveLength(1);
    expect(view.submitPrincipals).not.toContain(OPERATOR_PRINCIPAL);
    expect(view.submitPrincipals).not.toContain(VERIFIER_PRINCIPAL);

    // DoD 3 — no orphans: every pid this run started is gone from the OS process table.
    // The probe's own positive control comes first: `pidIsAlive` answers false on a throw, so
    // without this the orphan assertions would pass on a probe that can only ever say "gone".
    expect(pidIsAlive(process.pid)).toBe(true);
    expect(run.agentPid).not.toBeNull();
    for (const pid of [run.daemonPid, run.wrapper.pid, run.agentPid]) {
      expect({ alive: pid === null || pid === undefined ? false : pidIsAlive(pid), pid })
        .toEqual({ alive: false, pid });
    }
  }, ARM_TIMEOUT_MS);

  it("refuses a forged bearer with AUTHENTICATION_FAILED and commits nothing", async () => {
    const run = await runArm("forge-credential");
    const view = readLedgerView(run.scratch);
    printRunReceipt("forge-credential", run, view);
    // eslint-disable-next-line no-console
    console.log(`J1 FORGED-BEARER REFUSAL ${refusalLine(run.wrapper.output)}`);

    // The refusal body the wrapper's MCP host returned, echoed by the agent verbatim and
    // PARSED rather than substring-matched: the code and the layer are separate claims and a
    // bare "it was refused" would stay green if a different layer started answering first.
    // The forged bearer is SAME-SHAPE as the minted one, so this is the credential screen
    // answering PRE-DISPATCH and not a transport rejecting a malformed header.
    expect(run.wrapper.output).toContain("fake-agent: REFUSED status=401");
    expect(run.wrapper.output).toContain("arm=forge-credential refused as designed");
    expect(refusalBody(run.wrapper.output)).toMatchObject({
      error: {
        code: -32001,
        data: {
          code: "AUTHENTICATION_FAILED",
          recoveryCategory: "REAUTHENTICATE",
          transport: { category: "UNAUTHENTICATED", httpStatus: 401, mcpCode: -32001 },
        },
      },
    });

    // Nothing durable followed the refusal: no round, no acceptance, no verifier receipt.
    expect(view.rounds).toBe(0);
    expect(view.acceptedReceiptId).toBeUndefined();
    expect(view.receiptRow).toBeUndefined();
    expect(view.receiptEventCount).toBe(0);
  }, ARM_TIMEOUT_MS);

  it("stays un-COMMITTED when the agent exits 0 without submitting", async () => {
    const run = await runArm("skip-review");
    const view = readLedgerView(run.scratch);
    printRunReceipt("skip-review", run, view);

    // The arm ran: the agent reached the offer, wrote its deliverable, and exited CLEANLY.
    // That is the whole point — a COMMITTED assertion attached to process exit codes instead
    // of to the ledger would be green here.
    expect(run.wrapper.output).toContain("fake-agent: wrote math.mjs");
    expect(run.wrapper.output).toContain("arm=skip-review exiting 0 without review_submit");
    expect(existsSync(`${run.scratch.workspace}\\math.mjs`)
      || existsSync(`${run.scratch.workspace}/math.mjs`)).toBe(true);

    expect(view.rounds).toBe(0);
    expect(view.acceptedReceiptId).toBeUndefined();
    expect(view.receiptEventCount).toBe(0);
  }, ARM_TIMEOUT_MS);
});
