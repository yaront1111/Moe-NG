/**
 * The J1 loop over REAL PROCESSES: `daemon-main.ts`, the shipped `demo-seed-main.ts` and
 * `agent-wrapper-main.ts`, each spawned as its own OS process, driving one seeded code node
 * from READY to COMMITTED.
 *
 * WHAT THIS TURNS INTO EVIDENCE. The "full loop live-proven Aug 9-10" premise is graded
 * PARTIAL: two agents over two chain steps are ledger-proven at d8a5632, full-chain code-node
 * delivery was prose in the runbook. This test is the ledger evidence for the whole chain with
 * a SCRIPTED coder. It does NOT cover the wrapper's `--bare` spawner flags — those belong to
 * `canary-self-host.e2e.test.ts`, which staffs the same node with a real `claude` child.
 *
 * EVERY VERDICT COMES FROM THE DURABLE LEDGER, read from the store FILE after the processes
 * are dead. Child stdout is used only to harvest the ephemeral origin, the pids, and the
 * refusal body the forged-credential arm must echo verbatim.
 */
import { existsSync } from "node:fs";

import { afterAll, describe, expect, it } from "vitest";

import {
  type ArmRun,
  type LedgerView,
  type PassWatcher,
  ARM_TIMEOUT_MS,
  OPERATOR_PRINCIPAL,
  VERIFIER_PRINCIPAL,
  authorityWatcher,
  printRunReceipt,
  readLedgerView,
  removeScratches,
  runPass,
} from "./j1-ledger-view.js";
import {
  type AgentArm,
  type J1Scratch,
  NODE_REF,
  pidIsAlive,
  runWrapper,
} from "./j1-loop-harness.js";
import { pidReaped } from "./orphan-reap.js";

const scratches: J1Scratch[] = [];

afterAll(() => {
  removeScratches(scratches);
});

/**
 * One full arm: fresh store, REAL daemon on an ephemeral port, REAL seed, REAL wrapper for a
 * single ONCE pass, then the daemon reaped. The wrapper is awaited rather than polled: in ONCE
 * mode it verifies, staffs, settles its children and verifies again before exiting, so its
 * exit is the honest boundary of the pass.
 */
async function runArm(arm: AgentArm, watch?: PassWatcher): Promise<ArmRun> {
  return await runPass(scratches, (scratch) => runWrapper(scratch, arm), watch);
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

describe("J1 loop over real daemon, wrapper and agent processes", () => {
  it("carries one seeded node to COMMITTED through the daemon's own verifier", async () => {
    const authority = authorityWatcher();
    const run = await runArm("complete", authority.watch);
    const view: LedgerView = readLedgerView(run.scratch);
    printRunReceipt("complete", run, view);

    // The authority sampler's OWN positive control, on the fast scripted lane: it observed a
    // holder while the journey ran, and never two at once. The canary lane makes the same
    // claim about a real `claude` child, and a sampler that could only ever answer "none"
    // would satisfy that claim without observing anything.
    expect(authority.samples.filter((sample) => sample.holders.length > 0).length)
      .toBeGreaterThan(0);
    expect(authority.samples.filter((sample) => sample.holders.length > 1)).toEqual([]);

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
      const alive = pid === null || pid === undefined ? false : !(await pidReaped(pid));
      expect({ alive, pid }).toEqual({ alive: false, pid });
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
