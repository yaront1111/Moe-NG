/**
 * THE CONCURRENCY WITNESS, PINNED IN BOTH DIRECTIONS.
 *
 * `concurrentStaffing` is the whole evidentiary weight of DoD 1's "at least 2 staffed
 * concurrently": the live drive asserts what it answers about a REAL wrapper transcript. A
 * detector that answered `true` for everything would make that arm vacuous, and the live drive
 * cannot show otherwise -- it only ever sees one transcript, the passing one. So the negative
 * direction is pinned here, on transcripts whose shapes are the ones a sequential wrapper and a
 * single-node board actually produce.
 *
 * THE LINES ARE VERBATIM from the run of 2026-09-09 (refs shortened), not invented formats: a
 * fixture that guessed the wrapper's wording would pass while the production line drifted.
 */
import { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DaemonLane, LaneScratch } from "./daemon-ports.js";
import { concurrentStaffing, landLiveProofNodes } from "./live-proof-landing.js";

const boundary = vi.hoisted(() => ({
  kill: vi.fn(), resolveScratch: vi.fn(), startWrapper: vi.fn(),
}));
vi.mock("./wrapper-lane.js", () => ({
  resolveLaneScratch: boundary.resolveScratch, startWrapper: boundary.startWrapper,
  wrapperEnv: () => ({}), WRAPPER_INTERVAL_MS: 1,
}));
vi.mock("./daemon-children.js", async (original) => ({
  ...await original<typeof import("./daemon-children.js")>(), killTree: boundary.kill,
}));
vi.mock("@moe/store", async (original) => ({
  ...await original<typeof import("@moe/store")>(),
  SqliteEventStore: { openForProject: () => ({ close: () => {} }) },
}));
vi.mock("../../../apps/daemon/src/orchestrator/compiled-node-source.js", () => ({
  activeCompiledGraphs: () => [{ content: { snapshot: { nodes: [{ nodeKey: "node-auth-api" }] } } }],
}));
vi.mock("../../../apps/daemon/src/orchestrator/compiled-execution-ref.js", () => ({
  compiledExecutionRef: () => "node:v1:aaa1",
}));

const created: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  for (const dir of created.splice(0)) {
    const within = relative(tmpdir(), dir);
    if (within.startsWith("..") || isAbsolute(within)) throw new Error("fixture escaped temp root");
    rmSync(dir, { recursive: true, force: true });
  }
});

const A = "node:v1:aaa1";
const B = "node:v1:bbb2";

const spawned = (ref: string): string => `[wrapper] node.deliver@${ref}: SPAWNED`;
const exited = (ref: string): string => `[wrapper] node.deliver@${ref} agent exited 0`;
const busy = (ref: string): string =>
  `[wrapper] node.deliver@${ref}: REPOSITORY_EXECUTION_BUSY (REPOSITORY_DELIVERY)`;

describe("concurrentStaffing", () => {
  it("reports the pair when B is refused BUSY inside A's delivery window", () => {
    const witness = concurrentStaffing([
      "[wrapper] reclaim pass: 0 reclaimed, 0 kept",
      `[lander] ${A}: BASELINE_RECORDED (0 dirty path(s) before the seat)`,
      spawned(A), busy(B), exited(A),
    ].join("\n"), [A, B]);

    expect(witness.concurrent).toBe(true);
    expect(witness.holder).toBe(A);
    expect(witness.waiter).toBe(B);
    // THE CODE, not merely "something matched": the refusal is what explains why only one node
    // proceeds, and a witness that dropped it would report concurrency with no reason attached.
    expect(witness.evidence).toContain("REPOSITORY_EXECUTION_BUSY");
  });

  it("reports NOT concurrent when the two deliveries are strictly sequential", () => {
    const witness = concurrentStaffing([
      spawned(A), exited(A), spawned(B), exited(B),
    ].join("\n"), [A, B]);

    expect(witness).toEqual({ concurrent: false, evidence: null, holder: null, waiter: null });
  });

  it("reports NOT concurrent when B's BUSY line falls AFTER A has exited", () => {
    // The window is what carries the claim. A BUSY refusal that arrives once the checkout is
    // already free says nothing about two nodes being staffed at one moment.
    const witness = concurrentStaffing([
      spawned(A), exited(A), busy(B),
    ].join("\n"), [A, B]);

    expect(witness.concurrent).toBe(false);
  });

  it("reports NOT concurrent for a board that only ever staffed one node", () => {
    const witness = concurrentStaffing([spawned(A), exited(A)].join("\n"), [A, B]);

    expect(witness.concurrent).toBe(false);
    expect(witness.evidence).toBeNull();
  });

  it("ignores a BUSY line belonging to a node outside the pair it was asked about", () => {
    const other = "node:v1:ccc3";
    const witness = concurrentStaffing([spawned(A), busy(other), exited(A)].join("\n"), [A, B]);

    expect(witness.concurrent).toBe(false);
  });

  it("still answers when the holder never printed an exit line", () => {
    // A wrapper killed mid-delivery leaves no `agent exited`; the window then runs to the end of
    // the transcript rather than collapsing to empty, which would lose a real observation.
    const witness = concurrentStaffing([spawned(A), busy(B)].join("\n"), [A, B]);

    expect(witness.concurrent).toBe(true);
    expect(witness.holder).toBe(A);
  });
});

/** Real marker reads and refusal/teardown; no wrapper, provider, Git, or daemon is launched. */
async function refusedSeat(mark: Readonly<Record<string, unknown>>) {
  const root = mkdtempSync(join(tmpdir(), "moe-live-refusal-test-"));
  created.push(root);
  const nodeSpecsDir = join(root, "node-specs");
  mkdirSync(nodeSpecsDir);
  const scratch: LaneScratch = {
    catalogPath: join(root, "catalog.json"), nodeRef: A, nodeSpecsDir, projectId: "project-test",
    root, storePath: join(root, "store.sqlite"), tag: "test", workspace: root, workspaceSha: "",
  };
  const lane: DaemonLane = {
    ...scratch, approvePairing: null, baseUrl: "", credential: "", csrfToken: "",
    daemonOrigin: "", daemonPid: 0, repoRoot: root, seedPid: null, serverPid: 0,
  };
  const marker = join(root, "seat-node-auth-api.end");
  writeFileSync(marker, JSON.stringify(mark));
  boundary.resolveScratch.mockReturnValue(scratch);
  boundary.startWrapper.mockImplementation((_root, _env, tracked: ChildProcess[]) => {
    const child = new ChildProcess();
    tracked.push(child);
    return { child, transcript: () => spawned(A), waitFor: async () => null };
  });
  boundary.kill.mockImplementation(async () => { rmSync(marker); });
  const result = await landLiveProofNodes(lane, root, ["node-auth-api"], []);
  expect(boundary.kill).toHaveBeenCalledOnce();
  expect(existsSync(marker)).toBe(false);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected the provider completion refusal");
  expect(result.detail.split("\n")[0]).toBe("SEAT_PROVIDER_COMPLETION_UNPROVEN node-auth-api");
  return result;
}

describe("live landing refusal evidence", () => {
  it.each([
    { label: "nonzero exit after writing", providerStatus: 1, moduleBytes: 23, realProvider: true },
    { label: "provider timeout", providerStatus: null, moduleBytes: 0, realProvider: true },
    { label: "injected process", providerStatus: 0, moduleBytes: 23, realProvider: false },
  ])("retains the $label witness after teardown", async ({ label: _label, ...fields }) => {
    const result = await refusedSeat({ ...fields, startedAt: 100, endedAt: 200, ok: false });
    expect(result).toHaveProperty("seats", [
      { ...fields, nodeKey: "node-auth-api", startedAt: 100, endedAt: 200 },
    ]);
  });

  it("publishes only validated scalar fields from an untrusted marker", async () => {
    const privateText = "PRIVATE-PROVIDER-DIAGNOSTIC";
    const result = await refusedSeat({
      agent: privateText, transcriptTail: privateText, providerStatus: privateText,
      moduleBytes: { text: privateText }, realProvider: privateText,
      startedAt: privateText, endedAt: [privateText], ok: false,
    });
    expect(result).toHaveProperty("seats", [{
      nodeKey: "node-auth-api", providerStatus: null, moduleBytes: 0,
      realProvider: false, startedAt: 0, endedAt: 0,
    }]);
    expect(JSON.stringify(result)).not.toContain(privateText);
  });
});
