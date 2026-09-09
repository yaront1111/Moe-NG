/**
 * THE PREVIEW RUNNER, driven against a REAL store and a REAL fixture product.
 *
 * The store is built through the production bootstrap sequence and its landings are written by
 * the lander's own writer (`seedLandingReceipt`), never planted — so the state the gate reads is
 * the state production writes. The product is a real http server in a real temp workspace that
 * really binds a port.
 *
 * EVERY REFUSAL ARM ASSERTS CODE **AND** LAYER. Three layers can refuse a preview
 * (GOAL_AUTHORITY, REQUEST, RUNNER) and they refuse in a fixed order, so an arm that asserted
 * only "it refused" would stay green while a cheaper gate answered first and the gate it names
 * stopped being reachable. Each arm below also pins WHICH gate answered by making every OTHER
 * gate passable.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  GOAL_ID, PROJECT_ID, driveThrough, openStore,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { seedLandingReceipt, seedReviewAcceptance } from "../goals/goal-closure-test-fixtures.js";
import { compiledExecutionRef } from "../orchestrator/compiled-execution-ref.js";
import { activeCompiledGraphs } from "../orchestrator/compiled-node-source.js";
import { readReviewLedgers } from "../review/review-read-model.js";
import { PREVIEW_CODE_LAYERS } from "./preview-contracts.js";
import { readGoalLandingStatus } from "./preview-goal-landing.js";
import { readPreviewReceipt } from "./preview-ledger.js";
import { previewCaptureDirectory, previewReceiptId } from "./preview-receipt-contracts.js";
import type { PreviewScreenshot } from "./preview-receipt-contracts.js";
import { runPreview } from "./preview-runner.js";
import type { PreviewCapturePort, PreviewRunnerConfig } from "./preview-runner.js";
import {
  LISTENING_SERVER, SILENT_SERVER, cleanupFixtureWorkspaces, fixtureWorkspace,
} from "./preview-test-fixtures.js";

type Store = ReturnType<typeof openStore>;

const SHA = "0123456789abcdef0123456789abcdef01234567";
const DECIDED_AT = "2026-09-05T12:00:00.000Z";

const started: { stop: () => Promise<void> }[] = [];

afterEach(async () => {
  // No arm may leave a server behind for the next arm's port to collide with.
  while (started.length > 0) await started.pop()?.stop();
  cleanupFixtureWorkspaces();
});

/** The seed world at EXECUTION_ENABLED: one activated graph, one node `node-a`, no landing. */
function enabledWorld(): Store {
  const store = openStore();
  driveThrough(store, "goal.close");
  return store;
}

/** The execution ref the landing writer keys on for a bare node key of this goal's graph. */
function scopedRef(store: Store, nodeKey: string): string {
  const graph = activeCompiledGraphs(store, PROJECT_ID).find((plan) =>
    plan.goalRef === GOAL_ID && plan.content.snapshot.nodes.some((node) => node.nodeKey === nodeKey));
  return graph === undefined ? nodeKey : compiledExecutionRef(PROJECT_ID, graph, nodeKey);
}

/** Writes a REAL landing receipt for `nodeKey` through the lander's own writer. */
function land(store: Store, nodeKey: string, outcome: Parameters<typeof seedLandingReceipt>[2]): void {
  const nodeRef = scopedRef(store, nodeKey);
  seedReviewAcceptance(store, nodeRef);
  seedLandingReceipt(store, nodeRef, outcome);
}

/**
 * The ledger's own answer for a node, read independently of the gate under test — keyed by the
 * SCOPED execution ref the landing writer actually keys on, so this read cannot answer null for
 * a receipt that really exists and make an arm look honest while it proves nothing.
 */
function ledgerOutcome(store: Store, nodeKey: string): string | null {
  const ref = scopedRef(store, nodeKey);
  return readReviewLedgers(store, PROJECT_ID, new Set([ref])).landings.get(ref)?.outcome ?? null;
}

const noCapture: PreviewCapturePort = async () => [];

function config(store: Store, overrides: Partial<PreviewRunnerConfig> = {}): PreviewRunnerConfig {
  return {
    capture: noCapture,
    clock: () => DECIDED_AT,
    projectId: PROJECT_ID,
    store,
    ...overrides,
  };
}

describe("PREVIEW_GOAL_NOT_LANDED", () => {
  it("refuses with its code AND its GOAL_AUTHORITY layer when the goal's node is not landed", async () => {
    const store = enabledWorld();
    // The command gate is made PASSABLE, so a refusal here can only be the landing gate: a
    // workspace with a `preview` script and a contract that names a command.
    const workspace = fixtureWorkspace({ scripts: { preview: "node --version" } });

    const result = await runPreview(config(store), { goalId: GOAL_ID, sha: SHA, workspace });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.refusal.code).toBe("PREVIEW_GOAL_NOT_LANDED");
    expect(result.refusal.layer).toBe("GOAL_AUTHORITY");
    expect(result.refusal.layer).toBe(PREVIEW_CODE_LAYERS.PREVIEW_GOAL_NOT_LANDED);
  });

  it("still refuses when the goal's only landing was REFUSED, against a LIVE receipt", async () => {
    // A landing ATTEMPT is not a landed commit. This arm is honest because the receipt really
    // exists — the ledger read below proves it — so the gate is rejecting an outcome, not an
    // absence.
    const store = enabledWorld();
    land(store, "node-a", { refusalCode: "NOTHING_TO_COMMIT" });
    expect(ledgerOutcome(store, "node-a")).toBe("REFUSED");

    const workspace = fixtureWorkspace({ scripts: { preview: "node --version" } });
    const result = await runPreview(config(store), { goalId: GOAL_ID, sha: SHA, workspace });

    if (result.ok) throw new Error("expected a refusal");
    expect(result.refusal.code).toBe("PREVIEW_GOAL_NOT_LANDED");
    expect(result.refusal.layer).toBe("GOAL_AUTHORITY");
    expect(readGoalLandingStatus(store, PROJECT_ID, GOAL_ID).missing).toStrictEqual(["node-a"]);
  });

  it("counts only THIS goal's nodes: a sibling node's COMMITTED landing does not satisfy it", async () => {
    // A project-wide read would answer "landed" here and start a server for a goal that built
    // nothing. `node-1` really lands — the independent ledger read says COMMITTED.
    const store = enabledWorld();
    land(store, "node-1", "COMMITTED");
    expect(ledgerOutcome(store, "node-1")).toBe("COMMITTED");

    const workspace = fixtureWorkspace({ scripts: { preview: "node --version" } });
    const result = await runPreview(config(store), { goalId: GOAL_ID, sha: SHA, workspace });

    if (result.ok) throw new Error("expected a refusal");
    expect(result.refusal.code).toBe("PREVIEW_GOAL_NOT_LANDED");
    expect(readGoalLandingStatus(store, PROJECT_ID, GOAL_ID).allLanded).toBe(false);
  });

  it("PASSES the gate once every node of the goal carries a COMMITTED landing", async () => {
    // Without this arm the three above would also pass against a gate that always refused.
    const store = enabledWorld();
    land(store, "node-a", "COMMITTED");

    const status = readGoalLandingStatus(store, PROJECT_ID, GOAL_ID);
    expect(status.nodes).toStrictEqual(["node-a"]);
    expect(status.missing).toStrictEqual([]);
    expect(status.allLanded).toBe(true);

    // The run now reaches the NEXT gate, which is the proof the landing gate let it through.
    const workspace = fixtureWorkspace({ scripts: { build: "tsc" } });
    const result = await runPreview(config(store), { goalId: GOAL_ID, sha: SHA, workspace });
    if (result.ok) throw new Error("expected a refusal");
    expect(result.refusal.code).toBe("PREVIEW_COMMAND_MISSING");
  });

  it("refuses a goalId that would escape the capture directory, before any path is joined", async () => {
    const store = enabledWorld();
    land(store, "node-a", "COMMITTED");
    const workspace = fixtureWorkspace({ scripts: { preview: "node --version" } });

    for (const goalId of ["../escape", "a/b", "a\\b", ".."]) {
      const result = await runPreview(config(store), { goalId, sha: SHA, workspace });
      if (result.ok) throw new Error(`expected a refusal for ${goalId}`);
      expect(result.refusal.code).toBe("PREVIEW_GOAL_NOT_LANDED");
      expect(result.refusal.layer).toBe("GOAL_AUTHORITY");
    }
  });
});

describe("PREVIEW_COMMAND_MISSING", () => {
  it("refuses with its code AND its RUNNER layer when the workspace names no command", async () => {
    // The landing gate is made PASSABLE, so this refusal can only be the command gate — the
    // discriminator that keeps this arm from passing on a goal that simply was not landed.
    const store = enabledWorld();
    land(store, "node-a", "COMMITTED");
    const workspace = fixtureWorkspace({ scripts: { build: "tsc", lint: "eslint ." } });

    const result = await runPreview(config(store), { goalId: GOAL_ID, sha: SHA, workspace });

    if (result.ok) throw new Error("expected a refusal");
    expect(result.refusal.code).toBe("PREVIEW_COMMAND_MISSING");
    expect(result.refusal.layer).toBe("RUNNER");
    expect(result.refusal.layer).toBe(PREVIEW_CODE_LAYERS.PREVIEW_COMMAND_MISSING);
  });

  it("records the refusal durably, with its code and NO url", async () => {
    const store = enabledWorld();
    land(store, "node-a", "COMMITTED");
    const workspace = fixtureWorkspace({ scripts: { build: "tsc" } });

    await runPreview(config(store), { goalId: GOAL_ID, sha: SHA, workspace });

    const read = readPreviewReceipt(store, PROJECT_ID, previewReceiptId(PROJECT_ID, GOAL_ID, SHA));
    if (!read.ok) throw new Error(read.code);
    expect(read.receipt.outcome).toBe("REFUSED");
    expect(read.receipt.code).toBe("PREVIEW_COMMAND_MISSING");
    expect(read.receipt.url).toBeNull();
    expect(read.receipt.pid).toBeNull();
    expect(read.receipt.screenshots).toStrictEqual([]);
  });
});

describe("PREVIEW_START_TIMEOUT", () => {
  it("refuses with its code AND its RUNNER layer for a product that starts and never listens", async () => {
    // Both earlier gates are PASSABLE: the goal is landed and the workspace names a command.
    // The fixture process is healthy and noisy — it simply never becomes answerable.
    const store = enabledWorld();
    land(store, "node-a", "COMMITTED");
    const workspace = fixtureWorkspace({
      files: { "silent.mjs": SILENT_SERVER },
      scripts: { preview: "node silent.mjs" },
    });

    const result = await runPreview(
      config(store, {
        contractFacts: () => ({
          deploymentStatements: ["preview command: node silent.mjs"], journeys: [],
        }),
        // INJECTED so the arm does not wait the 30-minute production default.
        process: { startTimeoutMs: 900 },
      }),
      { goalId: GOAL_ID, sha: SHA, workspace },
    );

    if (result.ok) throw new Error("expected a refusal");
    expect(result.refusal.code).toBe("PREVIEW_START_TIMEOUT");
    expect(result.refusal.layer).toBe("RUNNER");
    expect(result.refusal.layer).toBe(PREVIEW_CODE_LAYERS.PREVIEW_START_TIMEOUT);
  });

  it("does NOT time out a product that really listens — the same fixture path, answered", async () => {
    // Without this arm the timeout arm above would also pass against a runner that timed out
    // unconditionally.
    const store = enabledWorld();
    land(store, "node-a", "COMMITTED");
    const workspace = fixtureWorkspace({
      files: { "server.mjs": LISTENING_SERVER },
      scripts: { preview: "node server.mjs" },
    });
    const captured: PreviewScreenshot[] = [];
    const capture: PreviewCapturePort = async (input) => {
      captured.push({ journeyRef: "j", path: `${input.goalId}/${input.sha}` });
      return [];
    };

    const result = await runPreview(
      config(store, {
        capture,
        contractFacts: () => ({
          deploymentStatements: ["preview command: node server.mjs"], journeys: [],
        }),
        process: { startTimeoutMs: 20_000 },
      }),
      { goalId: GOAL_ID, sha: SHA, workspace },
    );

    if (!result.ok) throw new Error(`expected a start, got ${result.refusal.code}`);
    started.push(result.started.handle);
    expect(result.started.handle.port).toBeGreaterThan(0);
    expect(result.started.handle.origin).toBe(`http://127.0.0.1:${String(result.started.handle.port)}`);
    expect(result.started.receipt.outcome).toBe("STARTED");
    expect(captured).toHaveLength(1);
  });
});

describe("the whole runner, with the REAL browser and the REAL server", () => {
  it("records screenshots[] naming files that are on disk and DECODE as PNGs", async () => {
    // End to end through the SHIPPED composition: no `capture` override, so `runPreview` uses
    // its production default (`capturePreviewJourneys`) and really launches Chromium. A port
    // whose only implementation lived in a test would make every arm above a test of the test.
    const store = enabledWorld();
    land(store, "node-a", "COMMITTED");
    const workspace = fixtureWorkspace({
      files: { "server.mjs": LISTENING_SERVER },
      scripts: { preview: "node server.mjs" },
    });

    // No `capture` KEY at all — not `capture: undefined`, which under this package's
    // `exactOptionalPropertyTypes: true` is a different type from an absent property. The point
    // is that `runPreview` falls through to its own default.
    const result = await runPreview(
      {
        clock: () => DECIDED_AT,
        contractFacts: () => ({
          deploymentStatements: ["preview command: node server.mjs"],
          journeys: [
            { journeyId: "journey-home", statement: "Arrive." },
            { journeyId: "journey-checkout", statement: "Buy.\npreview path: /checkout" },
          ],
        }),
        process: { startTimeoutMs: 30_000 },
        projectId: PROJECT_ID,
        store,
      },
      { goalId: GOAL_ID, sha: SHA, workspace },
    );

    if (!result.ok) throw new Error(`expected a start, got ${result.refusal.code}`);
    started.push(result.started.handle);

    // READ THE RECEIPT BACK FROM THE STORE, not from the return value.
    const read = readPreviewReceipt(store, PROJECT_ID, previewReceiptId(PROJECT_ID, GOAL_ID, SHA));
    if (!read.ok) throw new Error(read.code);
    expect(read.receipt.outcome).toBe("STARTED");
    expect(read.receipt.code).toBeNull();
    expect(read.receipt.url).toBe(result.started.handle.origin);
    expect(read.receipt.pid).toBe(result.started.handle.pid);
    expect(read.receipt.goalId).toBe(GOAL_ID);
    expect(read.receipt.sha).toBe(SHA);

    const prefix = `${previewCaptureDirectory(GOAL_ID, SHA)}/`;
    expect(read.receipt.screenshots.map((shot) => shot.path)).toStrictEqual([
      `${prefix}journey-home.png`,
      `${prefix}journey-checkout.png`,
    ]);
    // EVERY advertised entry is real bytes: the file exists AND its PNG header decodes with
    // non-zero dimensions. `existsSync` alone passes on the zero-byte file a failed capture
    // leaves, which is exactly the failure this asserts against.
    for (const shot of read.receipt.screenshots) {
      const bytes = readFileSync(join(workspace, ...shot.path.split("/")));
      expect([...bytes.subarray(0, 8)]).toStrictEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(bytes.readUInt32BE(16)).toBeGreaterThan(0);
      expect(bytes.readUInt32BE(20)).toBeGreaterThan(0);
    }
  }, 180_000);
});
