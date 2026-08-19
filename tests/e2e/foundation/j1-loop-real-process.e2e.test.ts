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
// The claim fold is not on the daemon's barrel, and this task certifies rather than edits
// production: the read model is imported at its own path instead of widening an export list.
import {
  readWorkClaimLedger,
} from "../../../apps/daemon/src/work/work-claim-read-model.js";
import { SqliteEventStore } from "@moe/store";
import type { CommandDecisionRecord } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";

import {
  type AgentArm,
  type J1Scratch,
  type ProcessRun,
  NODE_REF,
  createJ1Scratch,
  credentialProvenance,
  killTree,
  pidIsAlive,
  probeBareAgent,
  resolveAgentCredential,
  runRealAgentWrapper,
  runSeed,
  runWrapper,
  startDaemon,
} from "./j1-loop-harness.js";

/** Real processes under fleet load: a tight timeout is a flake, not a signal. */
const ARM_TIMEOUT_MS = 240_000;
const OPERATOR_PRINCIPAL = "operator-local";
const VERIFIER_PRINCIPAL = "daemon:node-verifier";
const VERIFIER_RECEIPT_KIND = "internal.integration.verifier_receipt";

/**
 * THE CANARY LANE. `MOE_AGENT_COMMAND` carries the real CLI name, so the wrapper builds its
 * own `-p --bare --no-session-persistence --strict-mcp-config` invocation: the flags are
 * exercised as production emits them, never restated here.
 */
const CANARY_AGENT_COMMAND = "claude";
/** A real model does real work; the wrapper's own kill horizon has to outlast it. */
const CANARY_AGENT_TIMEOUT_MS = 900_000;
const CANARY_TIMEOUT_MS = 1_200_000;
/**
 * THE LANE IS OPT-IN, and deliberately not gated on the credential alone.
 *
 * The root gate's include glob is `tests/**` + `*.test.ts`, so this file already runs inside
 * `pnpm test`. Gating only on "a credential is resolvable" would fire a live model agent —
 * minutes of wall clock and real tokens — inside every repo-wide test run on any developer
 * host that happens to hold one. The opt-in keeps that gate hermetic and makes the live run
 * a deliberate act.
 *
 * A SKIP IS NOT A PASS. When the opt-in IS set the lane refuses to skip: an unresolvable
 * credential fails it with the probe evidence rather than quietly reporting green, and the
 * canary run itself sets the flag and carries the resulting receipt as its evidence.
 */
const CANARY_OPT_IN = process.env["MOE_CANARY_LIVE_AGENT"] === "1";
const CANARY_CREDENTIAL = CANARY_OPT_IN ? resolveAgentCredential() : null;

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
async function runArm(arm: AgentArm, watch?: PassWatcher): Promise<ArmRun> {
  return await runPass((scratch) => runWrapper(scratch, arm), watch);
}

/** Watches a pass while it runs. Returns when the pass it was handed has settled. */
type PassWatcher = (scratch: J1Scratch, running: Promise<ProcessRun>) => Promise<void>;

/**
 * The shared pass: fresh store, REAL daemon, REAL seed, one wrapper pass, daemon reaped. The
 * only thing an arm chooses is WHICH agent the wrapper staffs, so the scripted arms and the
 * canary's real `claude` child travel identical daemon and seed code rather than two paths
 * that merely look alike.
 */
async function runPass(
  pass: (scratch: J1Scratch) => Promise<ProcessRun>, watch?: PassWatcher,
): Promise<ArmRun> {
  const scratch = createJ1Scratch();
  scratches.push(scratch);
  const daemon = await startDaemon(scratch);
  const seed = await runSeed(scratch, daemon.origin);
  if (seed.code !== 0) throw new Error(`seed failed (${String(seed.code)}): ${seed.output}`);
  const running = pass(scratch);
  // The watcher owns the DURING window: it must not outlive the pass, so it is handed the
  // same promise the pass returns rather than a deadline of its own.
  if (watch !== undefined) await watch(scratch, running);
  const wrapper = await running;
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
function printRunReceipt(arm: AgentArm | "canary-real-claude", run: ArmRun, view: LedgerView): void {
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
    const authority = authorityWatcher();
    const run = await runArm("complete", authority.watch);
    const view = readLedgerView(run.scratch);
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

/**
 * ONE INSTANT OF THE AUTHORITY REGISTER, read from the durable claim fold while the journey
 * is still running. Sampling only after the processes are dead would answer a different and
 * much weaker question: a second holder that appeared and released mid-run leaves the final
 * state single-holder, and an end-state assertion reads green over exactly the collision it
 * was written to catch.
 */
interface AuthoritySample {
  readonly holders: readonly string[];
  readonly readable: boolean;
}

const SAMPLE_INTERVAL_MS = 750;

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
function authorityWatcher(): { readonly samples: AuthoritySample[]; readonly watch: PassWatcher } {
  const samples: AuthoritySample[] = [];
  const watch: PassWatcher = async (scratch, running) => {
    let settled = false;
    void running.then(() => { settled = true; }, () => { settled = true; });
    while (!settled) {
      samples.push(sampleAuthority(scratch));
      await new Promise<void>((resolve) => { setTimeout(resolve, SAMPLE_INTERVAL_MS); });
    }
  };
  return { samples, watch };
}

/** The typed session rows the journey wrote, decoded from the durable event payloads. */
function sessionRows(scratch: J1Scratch): readonly Record<string, unknown>[] {
  const decoder = new TextDecoder();
  return withStore(scratch, (store) => store
    .readEventsByTypeAfter("SessionOpened", 0n, 100).items
    .map((event) => JSON.parse(decoder.decode(event.payload)) as Record<string, unknown>));
}

/** The deliverable's own bytes, read from the workspace the real agent worked in. */
function authoredDelta(scratch: J1Scratch): { readonly bytes: string; readonly path: string } {
  for (const separator of ["/", "\\"]) {
    const path = `${scratch.workspace}${separator}math.mjs`;
    if (existsSync(path)) return { bytes: readFileSync(path, "utf8"), path };
  }
  return { bytes: "", path: `${scratch.workspace}/math.mjs` };
}

describe("Foundation self-host canary: the wrapper's --bare flags against the REAL Claude CLI", () => {
  /**
   * THE FIRST LIVE PROOF of the spawner's `--bare` flags. Every other lane in this file
   * staffs a scripted `.mjs` coder, which exercises the loop but can never exercise the CLI
   * contract: `--bare`, `--strict-mcp-config` and the per-agent MCP config are claims about
   * a real `claude` process, and only a real one can refute them.
   *
   * WHAT WOULD MAKE THIS A TAUTOLOGY, and is therefore absent: no mocked child, no fake
   * credential, no dropped flag, and no acceptance the agent reports about itself. The
   * verdict is the DAEMON's — its own verifier ran the seeded test against bytes the agent
   * wrote, and the acceptance is read from the durable ledger after every process is dead.
   */
  it.skipIf(!CANARY_OPT_IN)(
    "carries the exclusive node to COMMITTED through a real claude -p --bare child",
    async () => {
      if (CANARY_CREDENTIAL === null) {
        // Opted in and unresolvable: the lane FAILS. Falling back to a skip here would let the
        // one gate this task exists to prove report green having proved nothing.
        throw new Error(
          "MOE_CANARY_LIVE_AGENT=1 but no credential resolved from env, User or Machine scope",
        );
      }
      const credential = CANARY_CREDENTIAL;
      // The probe FIRST, because `--bare` reads no keychain: without it a credential fault
      // arrives later disguised as an agent process failure and reads as an orchestration bug.
      const probe = await probeBareAgent(CANARY_AGENT_COMMAND, credential);
      // eslint-disable-next-line no-console
      console.log(`CANARY BARE PROBE ${JSON.stringify({
        code: probe.code, credential: credentialProvenance(credential),
      })}`);
      if (probe.code !== 0) {
        throw new Error(`claude -p --bare refused the resolved credential: ${probe.output}`);
      }
      // The probe grades AUTHENTICATION, not model semantics: a reply's wording is not a
      // contract, but an unauthenticated `--bare` child is — it exits 1 and says so.
      expect(probe.output.trim().length).toBeGreaterThan(0);
      expect(probe.output).not.toContain("Not logged in");

      const authority = authorityWatcher();
      const run = await runPass((scratch) => runRealAgentWrapper(scratch, {
        agentCommand: CANARY_AGENT_COMMAND,
        credential,
        timeoutMs: CANARY_AGENT_TIMEOUT_MS,
      }), authority.watch);
      const view = readLedgerView(run.scratch);
      printRunReceipt("canary-real-claude", run, view);

      if (run.wrapper.code !== 0) {
        throw new Error(`wrapper exited ${String(run.wrapper.code)}: ${run.wrapper.output}`);
      }

      // A NON-EMPTY AUTHORED DELTA, never narrowed to a clean run: the workspace holds bytes
      // that did not exist before the agent ran, and the daemon's verifier ran its test over
      // exactly those bytes. `math.mjs` is deliberately absent from the seeded scratch.
      const delta = authoredDelta(run.scratch);
      // eslint-disable-next-line no-console
      console.log(`CANARY AUTHORED DELTA ${JSON.stringify({
        bytes: delta.bytes.length, path: delta.path,
      })}`);
      expect(delta.bytes.length).toBeGreaterThan(0);
      expect(delta.bytes).toContain("export");

      // ACCEPT, from the durable ledger and attributed to the DAEMON's verifier principal.
      expect(view.rounds).toBeGreaterThan(0);
      expect(view.acceptedReceiptId).toBeDefined();
      expect(view.receiptRow?.key.commandId).toBe(view.acceptedReceiptId);
      expect(view.receiptRow?.key.principalId).toBe(VERIFIER_PRINCIPAL);
      expect(view.receiptEventCount).toBeGreaterThan(0);

      // The real agent's submission is attributed to its SCOPED session principal — one, and
      // neither the operator's nor the verifier's.
      expect(view.submitPrincipals).toHaveLength(1);
      expect(view.submitPrincipals).not.toContain(OPERATOR_PRINCIPAL);
      expect(view.submitPrincipals).not.toContain(VERIFIER_PRINCIPAL);

      // TYPED SESSION ROW, decoded from the durable payload and BOUND to the submission:
      // exactly one session was opened, the OPERATOR opened it (an agent never mints its own
      // authority), and the scoped principal the review is attributed to IS that session's
      // id. Counting rows would leave the two facts merely coexisting in one store.
      const sessions = sessionRows(run.scratch);
      expect(sessions).toHaveLength(1);
      const opened = sessions[0] as Record<string, unknown>;
      expect(view.submitPrincipals).toEqual([opened["sessionId"]]);
      expect(opened["principalId"]).toBe(OPERATOR_PRINCIPAL);
      // The exact receipt, not a shape: this is the capability set a code agent is scoped to.
      expect(opened["capabilities"]).toEqual(["review.write", "work.write"]);
      expect(opened["credentialSha256"]).toMatch(/^[0-9a-f]{64}$/u);

      // NO DUPLICATE AUTHORITY AT ANY SAMPLED INSTANT, and the sampler's own positive control
      // first: an empty sample set, or one that never saw a holder at all, would satisfy
      // "never two" vacuously. `readable` is asserted so a run of failed reads cannot pass as
      // a run of honest zero-holder observations.
      // eslint-disable-next-line no-console
      console.log(`CANARY AUTHORITY SAMPLES ${JSON.stringify({
        held: authority.samples.filter((sample) => sample.holders.length > 0).length,
        taken: authority.samples.length,
        unreadable: authority.samples.filter((sample) => !sample.readable).length,
      })}`);
      expect(authority.samples.length).toBeGreaterThan(1);
      expect(authority.samples.filter((sample) => sample.holders.length > 0).length)
        .toBeGreaterThan(0);
      expect(authority.samples.filter((sample) => !sample.readable)).toEqual([]);
      expect(authority.samples.filter((sample) => sample.holders.length > 1)).toEqual([]);
      expect([...new Set(authority.samples.flatMap((sample) => sample.holders))])
        .toHaveLength(1);

      // No orphans: the real CLI spawns its own children, so the containment claim is
      // stronger here than on any scripted arm.
      expect(pidIsAlive(process.pid)).toBe(true);
      for (const pid of [run.daemonPid, run.wrapper.pid]) {
        expect({ alive: pid === undefined ? false : pidIsAlive(pid), pid })
          .toEqual({ alive: false, pid });
      }
    }, CANARY_TIMEOUT_MS);
});
