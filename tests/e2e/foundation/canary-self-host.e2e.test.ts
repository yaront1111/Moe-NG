/**
 * THE FOUNDATION SELF-HOST CANARY: the wrapper's `--bare` spawner flags against the REAL
 * Claude CLI, staffing the exclusive seeded node.
 *
 * THE FIRST LIVE PROOF of those flags. Every arm in `j1-loop-real-process.e2e.test.ts`
 * staffs a scripted `.mjs` coder, which exercises the loop but can never exercise the CLI
 * contract: `--bare`, `--strict-mcp-config` and the per-agent MCP config are claims about a
 * real `claude` process, and only a real one can refute them.
 *
 * WHAT WOULD MAKE THIS A TAUTOLOGY, and is therefore absent: no mocked child, no fake
 * credential, no dropped flag, and no acceptance the agent reports about itself. The verdict
 * is the DAEMON's — its own verifier ran the seeded test against bytes the agent wrote, and
 * the acceptance is read from the durable ledger after every process is dead.
 */
import { existsSync, readFileSync } from "node:fs";

import { afterAll, describe, expect, it } from "vitest";

import {
  credentialProvenance,
  resolveAgentCredential,
} from "./agent-credential.js";
import {
  LIVE_SAMPLE_INTERVAL_MS,
  OPERATOR_PRINCIPAL,
  VERIFIER_PRINCIPAL,
  authorityWatcher,
  printRunReceipt,
  readLedgerView,
  removeScratches,
  runPass,
  sessionRows,
} from "./j1-ledger-view.js";
import {
  type J1Scratch,
  pidIsAlive,
  probeBareAgent,
  runRealAgentWrapper,
} from "./j1-loop-harness.js";
import { pidReaped } from "./orphan-reap.js";

/**
 * `MOE_AGENT_COMMAND` carries the real CLI name, so the wrapper builds its own
 * `-p --bare --no-session-persistence --strict-mcp-config` invocation: the flags are
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

const scratches: J1Scratch[] = [];

afterAll(() => {
  removeScratches(scratches);
});

/** The deliverable's own bytes, read from the workspace the real agent worked in. */
function authoredDelta(scratch: J1Scratch): { readonly bytes: string; readonly path: string } {
  for (const separator of ["/", "\\"]) {
    const path = `${scratch.workspace}${separator}math.mjs`;
    if (existsSync(path)) return { bytes: readFileSync(path, "utf8"), path };
  }
  return { bytes: "", path: `${scratch.workspace}/math.mjs` };
}

describe("Foundation self-host canary: the wrapper's --bare flags against the REAL Claude CLI", () => {
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

      const authority = authorityWatcher(LIVE_SAMPLE_INTERVAL_MS);
      const run = await runPass(scratches, (scratch) => runRealAgentWrapper(scratch, {
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
        const alive = pid === undefined ? false : !(await pidReaped(pid));
        expect({ alive, pid }).toEqual({ alive: false, pid });
      }
    }, CANARY_TIMEOUT_MS);
});
