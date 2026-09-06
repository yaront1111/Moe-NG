/**
 * THE `preview.decide` DAEMON EDGE, driven over a REAL store, a REAL bootstrap world and REAL
 * receipts written by the production writer.
 *
 * WHY EVERY ARM ASSERTS FROM THE DURABLE READ RATHER THAN FROM THE RETURN VALUE. The edge
 * answers a `DurableDecision` — `{commandId, disposition, effectId, resultCode}` — which carries
 * no verdict and no findings, so an arm that asserted on it would prove only that the function
 * returned. The verdict is asserted from `/activity/read`'s port and the findings from
 * `readPreviewDecision`, both of which read the bytes the STORE holds.
 *
 * WHY EVERY REFUSAL ARM MAKES EVERY OTHER GATE PASSABLE. Three layers can refuse a decide
 * (REQUEST, GOAL_AUTHORITY, RUNNER) and they refuse in a fixed order. Before this row the
 * registry threw PREVIEW_GOAL_NOT_LANDED for EVERY well-formed decide, so an arm asserting
 * merely "it refused" was green against a stub that did nothing. Each arm below therefore
 * satisfies the gates above the one it names, asserts the code AND the layer, and is paired
 * with a POSITIVE CONTROL over the same world that commits — so a gate that started refusing
 * for the wrong reason reddens the control instead of hiding inside the refusal.
 */
import { afterEach, describe, expect, it } from "vitest";

import { GOAL_ID, PROJECT_ID, closeStores, driveThrough, openStore }
  from "../bootstrap/bootstrap-test-fixtures.js";
import { readDurableLedger, stateOf } from "../bootstrap/bootstrap-ledger.js";
import { startDaemon } from "../daemon-entry.js";
import { authenticator, decisionPort } from "../http/http-test-fixtures.js";
import { probeProcessAlive } from "../orchestrator/process-runner-lifecycle.js";
import { seedLandingReceipt, seedReviewAcceptance } from "../goals/goal-closure-test-fixtures.js";
import { createActivityReadPort } from "../http/activity-read.js";
import { compiledExecutionRef } from "../orchestrator/compiled-execution-ref.js";
import { activeCompiledGraphs } from "../orchestrator/compiled-node-source.js";
import { PREVIEW_CODE_LAYERS } from "./preview-contracts.js";
import type { PreviewCode } from "./preview-contracts.js";
import {
  PREVIEW_DECIDE_RESULT_CODE, createPreviewDaemonPort, createPreviewReceiptReader,
  readPreviewDecision, runPreviewDecideEdge,
} from "./preview-daemon-edge.js";
import type { PreviewDaemonPort, PreviewDecideEdgeContext } from "./preview-daemon-edge.js";
import { readGoalLandingStatus } from "./preview-goal-landing.js";
import { recordPreviewReceipt } from "./preview-ledger.js";
import { previewAggregateId } from "./preview-receipt-contracts.js";
import {
  LISTENING_SERVER, awaitPidGone, cleanupFixtureWorkspaces, fixtureWorkspace,
} from "./preview-test-fixtures.js";

type Store = ReturnType<typeof openStore>;

const SHA = "0123456789abcdef0123456789abcdef01234567";
const DECIDED_AT = "2026-09-06T09:00:00.000Z";
const OPERATOR = "operator-1";
const NODE_KEY = "node-a";

afterEach(() => { closeStores(); cleanupFixtureWorkspaces(); });

/** The execution ref the landing writer keys on for a bare node key of this goal's graph. */
function scopedRef(store: Store, nodeKey: string): string {
  const graph = activeCompiledGraphs(store, PROJECT_ID).find((plan) =>
    plan.goalRef === GOAL_ID && plan.content.snapshot.nodes.some((n) => n.nodeKey === nodeKey));
  return graph === undefined ? nodeKey : compiledExecutionRef(PROJECT_ID, graph, nodeKey);
}

/** The seed world at EXECUTION_ENABLED. Its one execution-bearing node is NOT landed. */
function enabledWorld(): Store {
  const store = openStore();
  driveThrough(store, "goal.close");
  return store;
}

/** The same world with its node landed as a real commit, through the lander's own writer. */
function landedWorld(): Store {
  const store = enabledWorld();
  const nodeRef = scopedRef(store, NODE_KEY);
  seedReviewAcceptance(store, nodeRef);
  seedLandingReceipt(store, nodeRef, "COMMITTED");
  // Asserted, not assumed: every arm below depends on the landing gate being PASSABLE, so a
  // fixture that silently stopped landing would make every refusal arm vacuous.
  expect(readGoalLandingStatus(store, PROJECT_ID, GOAL_ID).allLanded).toBe(true);
  return store;
}

/** A receipt written by the PRODUCTION writer. `code` null records STARTED, a code REFUSED. */
function receipt(store: Store, code: PreviewCode | null = null, sha = SHA): string {
  const recorded = recordPreviewReceipt(store, {
    code,
    decidedAt: DECIDED_AT,
    goalId: GOAL_ID,
    pid: code === null ? 4242 : null,
    projectId: PROJECT_ID,
    screenshots: [],
    sha,
    url: code === null ? "http://127.0.0.1:5199/" : null,
  });
  if (!recorded.ok) throw new Error(`receipt fixture refused: ${recorded.code}`);
  return recorded.receipt.receiptId;
}

/** One goal's receipt state, through the PRODUCTION reader the offer surface uses. A fresh
 *  reader per call, because the reader memoises its one ledger walk on purpose. */
function receiptState(store: Store, goalId: string): string | null {
  return createPreviewReceiptReader(store, PROJECT_ID)(goalId);
}

/** A port whose stop is recorded rather than performed: the process half is proven in the
 *  shutdown arm below, against a real child. */
function spyPort(): { readonly port: PreviewDaemonPort; readonly released: string[] } {
  const released: string[] = [];
  return {
    port: Object.freeze({
      close: async (): Promise<void> => undefined,
      release: (receiptId: string): void => { released.push(receiptId); },
    }),
    released,
  };
}

let minted = 0;

function decide(
  store: Store, payload: Readonly<Record<string, unknown>>,
  overrides: Partial<PreviewDecideEdgeContext> = {},
): { readonly commandId: string; readonly result: ReturnType<typeof runPreviewDecideEdge> } {
  const commandId = `cmd-preview-${(minted += 1)}`;
  const context: PreviewDecideEdgeContext = {
    envelope: {
      commandId,
      correlationId: `corr-${commandId}`,
      expectedVersion: store.getAggregateVersion(previewAggregateId(GOAL_ID)),
      payload,
    },
    now: () => DECIDED_AT,
    port: spyPort().port,
    principalId: OPERATOR,
    projectId: PROJECT_ID,
    store,
    ...overrides,
  };
  return { commandId, result: runPreviewDecideEdge(context) };
}

/** What the edge threw, or a failure naming what it returned instead. */
function refusalOf(run: () => unknown): { readonly code: unknown; readonly layer: unknown } {
  try {
    const answer = run();
    throw new Error(`expected a refusal, got ${JSON.stringify(answer)}`);
  } catch (error) {
    const thrown = error as { code?: unknown; layer?: unknown };
    if (thrown.code === undefined) throw error;
    return { code: thrown.code, layer: thrown.layer };
  }
}

/** The verdict `/activity/read` reports for one command id, through the production port. */
function verdictFromActivityRead(store: Store, commandId: string): string | null {
  const view = createActivityReadPort({ projectId: PROJECT_ID, store }).readActivity({});
  if (view.outcome !== "ACTIVITY") throw new Error(`activity read refused: ${view.code}`);
  const decision = readPreviewDecision(store, PROJECT_ID, OPERATOR, commandId);
  if (decision === null) throw new Error("no preview decision was persisted");
  const entries = view.entries.filter((entry) => entry.commandKind === "preview.decide"
    && entry.targetAggregateId === previewAggregateId(GOAL_ID));
  expect(entries).toHaveLength(1);
  return entries[0]?.verdict ?? null;
}

describe("preview.decide commits a durable decision", () => {
  it("APPROVE over a STARTED receipt reads back from /activity/read carrying its verdict", () => {
    const store = landedWorld();
    const previewRef = receipt(store);

    const { commandId, result } = decide(store, { decision: "APPROVE", previewRef });

    expect(result.resultCode).toBe(PREVIEW_DECIDE_RESULT_CODE);
    expect(result.disposition).toBe("DECIDED");
    // THE ASSERTION THAT MATTERS: the verdict comes off the ACTIVITY READ, not the return value.
    expect(verdictFromActivityRead(store, commandId)).toBe("APPROVE");
  });

  it("stops the live preview process for the decided receipt", () => {
    const store = landedWorld();
    const previewRef = receipt(store);
    const spy = spyPort();

    decide(store, { decision: "APPROVE", previewRef }, { port: spy.port });

    expect(spy.released).toEqual([previewRef]);
  });

  /**
   * THE AGGREGATE CHOICE IS LOAD-BEARING, not a style preference. `readDurableLedger` keys
   * aggregates by `targetAggregateId` and keeps the LAST committed decision's result, so a
   * decide committed on the bare goal aggregate would overwrite the goal's durable state — and
   * `durableGoals` (affordance-planning-offers.ts) requires `state.goalId === aggregateId`, so
   * the goal would vanish from the whole affordance surface after one decide. This arm reddens
   * if the target ever moves onto the goal.
   */
  it("leaves the goal's own durable state intact, because it targets preview:<goalId>", () => {
    const store = landedWorld();
    const previewRef = receipt(store);

    decide(store, { decision: "APPROVE", previewRef });

    const goal = stateOf(readDurableLedger(store, PROJECT_ID), GOAL_ID);
    expect((goal as { goalId?: unknown } | undefined)?.goalId).toBe(GOAL_ID);
  });

  it("REJECT persists its findings roster, each naming a node reworkable on the graph", () => {
    const store = landedWorld();
    const previewRef = receipt(store);
    const nodeRef = scopedRef(store, NODE_KEY);

    const { commandId } = decide(store, {
      decision: "REJECT",
      findings: [
        { detail: "the checkout page renders no total", nodeRef: NODE_KEY },
        { detail: "the header overlaps the cart", nodeRef: NODE_KEY },
      ],
      previewRef,
    });

    // Read back from the STORE, element by element — never from the decoded payload.
    const persisted = readPreviewDecision(store, PROJECT_ID, OPERATOR, commandId);
    expect(persisted?.decision).toBe("REJECT");
    expect(persisted?.findings).toEqual([
      { detail: "the checkout page renders no total", nodeRef: NODE_KEY },
      { detail: "the header overlaps the cart", nodeRef: NODE_KEY },
    ]);
    // Each persisted nodeRef names a node of THIS goal's active graph, so it is reworkable:
    // the same roster the landing gate walks, and the same ref the lander keys on.
    const nodes = readGoalLandingStatus(store, PROJECT_ID, GOAL_ID).nodes;
    for (const finding of persisted?.findings ?? []) {
      expect(nodes).toContain(finding.nodeRef);
      expect(scopedRef(store, finding.nodeRef)).toBe(nodeRef);
    }
    expect(verdictFromActivityRead(store, commandId)).toBe("REJECT");
  });
});

describe("PREVIEW_DECISION_INVALID @ REQUEST", () => {
  it("refuses a payload the decoder will not admit, with every other gate passable", () => {
    const store = landedWorld();
    const previewRef = receipt(store);
    // APPROVE carrying `findings` is a CONTRADICTION the decoder refuses structurally. The
    // receipt exists, the goal is landed and the port is wired, so only the decoder can answer.
    const refusal = refusalOf(() => decide(store, {
      decision: "APPROVE", findings: [{ detail: "d", nodeRef: NODE_KEY }], previewRef,
    }).result);

    expect(refusal.code).toBe("PREVIEW_DECISION_INVALID");
    expect(refusal.layer).toBe("REQUEST");
    expect(refusal.layer).toBe(PREVIEW_CODE_LAYERS.PREVIEW_DECISION_INVALID);
  });

  it("refuses a REJECT naming a node that is not on the goal's graph", () => {
    const store = landedWorld();
    const previewRef = receipt(store);

    const refusal = refusalOf(() => decide(store, {
      decision: "REJECT", findings: [{ detail: "d", nodeRef: "node-not-on-this-goal" }], previewRef,
    }).result);

    expect(refusal.code).toBe("PREVIEW_DECISION_INVALID");
    expect(refusal.layer).toBe("REQUEST");
  });

  it("POSITIVE CONTROL: the same world admits a well-formed decision", () => {
    const store = landedWorld();
    const previewRef = receipt(store);

    const { commandId } = decide(store, {
      decision: "REJECT", findings: [{ detail: "d", nodeRef: NODE_KEY }], previewRef,
    });

    expect(verdictFromActivityRead(store, commandId)).toBe("REJECT");
  });
});

describe("PREVIEW_GOAL_NOT_LANDED @ GOAL_AUTHORITY", () => {
  it("refuses when no receipt names the previewRef, with the payload well-formed", () => {
    const store = landedWorld();

    const refusal = refusalOf(() => decide(store, {
      decision: "APPROVE", previewRef: "preview-receipt-that-was-never-written",
    }).result);

    expect(refusal.code).toBe("PREVIEW_GOAL_NOT_LANDED");
    expect(refusal.layer).toBe("GOAL_AUTHORITY");
    expect(refusal.layer).toBe(PREVIEW_CODE_LAYERS.PREVIEW_GOAL_NOT_LANDED);
  });

  it("refuses when the receipt is real but the goal's node is not landed", () => {
    const store = enabledWorld();
    const previewRef = receipt(store);
    // Asserted independently, so the arm rejects an OUTCOME rather than an absence.
    expect(readGoalLandingStatus(store, PROJECT_ID, GOAL_ID).allLanded).toBe(false);
    expect(receiptState(store, GOAL_ID)).toBe("STARTED");

    const refusal = refusalOf(() => decide(store, { decision: "APPROVE", previewRef }).result);

    expect(refusal.code).toBe("PREVIEW_GOAL_NOT_LANDED");
    expect(refusal.layer).toBe("GOAL_AUTHORITY");
  });

  it("POSITIVE CONTROL: the same payload commits once the receipt exists and the goal landed", () => {
    const store = landedWorld();
    const previewRef = receipt(store);

    const { commandId } = decide(store, { decision: "APPROVE", previewRef });

    expect(verdictFromActivityRead(store, commandId)).toBe("APPROVE");
  });
});

describe("the RUNNER's own codes travel back UNRESTAMPED", () => {
  for (const code of ["PREVIEW_COMMAND_MISSING", "PREVIEW_START_TIMEOUT"] as const) {
    it(`answers ${code} @ RUNNER for a receipt REFUSED with it`, () => {
      const store = landedWorld();
      const previewRef = receipt(store, code);
      expect(receiptState(store, GOAL_ID)).toBe("REFUSED");

      const refusal = refusalOf(() => decide(store, { decision: "APPROVE", previewRef }).result);

      expect(refusal.code).toBe(code);
      expect(refusal.layer).toBe("RUNNER");
      expect(refusal.layer).toBe(PREVIEW_CODE_LAYERS[code]);
    });
  }

  it("refuses PREVIEW_COMMAND_MISSING @ RUNNER when the daemon wired no preview port", () => {
    const store = landedWorld();
    const previewRef = receipt(store);

    const refusal = refusalOf(() =>
      decide(store, { decision: "APPROVE", previewRef }, { port: undefined }).result);

    expect(refusal.code).toBe("PREVIEW_COMMAND_MISSING");
    expect(refusal.layer).toBe("RUNNER");
  });

  /**
   * A FENCED decide is RETURNED by the store, not thrown, so "it did not throw" is not success
   * here. This arm dispatches a SECOND decide carrying the version the first one already
   * consumed — the shape two operator tabs produce — and pins that it is refused with the
   * STORE's own code and layer rather than reported as a second recorded verdict.
   */
  it("refuses a stale expectedVersion with the store's own EXPECTED_VERSION_CONFLICT", () => {
    const store = landedWorld();
    const previewRef = receipt(store);
    const stale = store.getAggregateVersion(previewAggregateId(GOAL_ID));
    decide(store, { decision: "APPROVE", previewRef });

    const refusal = refusalOf(() => decide(
      store, { decision: "REJECT", findings: [{ detail: "d", nodeRef: NODE_KEY }], previewRef },
      { envelope: {
        commandId: "cmd-preview-stale", correlationId: "corr-stale",
        expectedVersion: stale,
        payload: {
          decision: "REJECT", findings: [{ detail: "d", nodeRef: NODE_KEY }], previewRef,
        },
      } },
    ).result);

    expect(refusal.code).toBe("EXPECTED_VERSION_CONFLICT");
    expect(refusal.layer).toBe("DURABLE_STORE");
    // And nothing was recorded under the losing command id.
    expect(readPreviewDecision(store, PROJECT_ID, OPERATOR, "cmd-preview-stale")).toBeNull();
  });

  it("POSITIVE CONTROL: a STARTED receipt over the same world commits", () => {
    const store = landedWorld();
    const previewRef = receipt(store);

    const { commandId } = decide(store, { decision: "APPROVE", previewRef });

    expect(verdictFromActivityRead(store, commandId)).toBe("APPROVE");
  });
});

/**
 * THE RECEIPT-STATE FACT the affordance surface offers off. Established here through the
 * PRODUCTION writer over a real store; the offer LADDER's own arms live in
 * `http/affordance-planning-offers.test.ts`, which takes it as a fact the way it takes
 * `landedCommit` — the same split `affordance-compiler-lane.test.ts` uses.
 */
describe("the preview receipt reader", () => {
  it("answers null for a goal with no receipt, STARTED for one, REFUSED for a refusal", () => {
    const store = landedWorld();
    expect(receiptState(store, GOAL_ID)).toBeNull();

    receipt(store);
    expect(receiptState(store, GOAL_ID)).toBe("STARTED");

    // A LATER revision refused: the state follows the newest receipt on the goal's aggregate.
    receipt(store, "PREVIEW_COMMAND_MISSING", "f".repeat(40));
    expect(receiptState(store, GOAL_ID)).toBe("REFUSED");
  });

  it("never answers another goal's receipt", () => {
    const store = landedWorld();
    receipt(store);
    expect(receiptState(store, "goal-that-has-no-preview")).toBeNull();
  });
});

/**
 * DAEMON SHUTDOWN SWEEPS LIVE PREVIEWS (DoD 6), driven through the PRODUCTION shutdown path.
 *
 * The preview is a REAL child process serving REAL html on a REAL port, started through the same
 * `createPreviewDaemonPort` the composition root constructs, and the daemon is started and
 * stopped by `startDaemon`/`shutdown` — not by calling `close()` directly, which would prove the
 * supervisor works and say nothing about whether anything CALLS it.
 *
 * LIVENESS IS ASSERTED BY PID, through `awaitPidGone` over the production probe
 * `probeProcessAlive` (orchestrator/process-runner-lifecycle.ts). No third liveness helper: a
 * bespoke one could agree with a bespoke stop and both be wrong together.
 */
describe("daemon shutdown", () => {
  it("stops a preview this daemon started, proven by its pid leaving the OS table", async () => {
    const store = landedWorld();
    const workspace = fixtureWorkspace({
      files: { "server.mjs": LISTENING_SERVER },
      scripts: { preview: "node server.mjs" },
    });
    const port = createPreviewDaemonPort({
      capture: async () => [],
      contractFacts: () => ({
        deploymentStatements: ["preview command: node server.mjs"], journeys: [],
      }),
      process: { startTimeoutMs: 20_000 },
      projectId: PROJECT_ID,
      store,
    });

    const run = await port.supervisor.start({ goalId: GOAL_ID, sha: SHA, workspace });
    if (!run.ok) throw new Error(`expected a started preview, got ${run.refusal.code}`);
    const pid = run.started.handle.pid;
    // The child is ALIVE before the sweep, so "gone afterwards" measures the sweep and not a
    // process that never started.
    expect(probeProcessAlive(pid)).toBe(true);
    expect(port.supervisor.active().map((live) => live.pid)).toEqual([pid]);

    const daemon = await startDaemon({
      dependencies: {
        previews: () => port,
        provide: () => ({
          authenticator: authenticator(), decisions: decisionPort(), registry: new Map(),
        }),
      },
    });
    if (!daemon.ok) throw new Error(`daemon refused: ${daemon.code}`);
    const stopped = await daemon.shutdown();

    expect(stopped.ok).toBe(true);
    expect(await awaitPidGone(pid, probeProcessAlive)).toBe(true);
    expect(port.supervisor.active()).toEqual([]);
  }, 60_000);
});
