import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { mapRunsAnswer, readRuns } from "./live-runs.js";

/**
 * The runs read client over the exact wire frames POST /runs/read emits (verified against
 * runs-read-contract.ts): a full RUNS frame with every node fact, a goal with no run and no
 * nodes, the route's own refusal, the listener's refusal, and frames whose nested rows drift.
 */

const NODE = Object.freeze({
  accepted: { verifierReceiptId: "receipt-a" },
  claim: { active: false, claimedBy: "sess-wrap-1", expiresAt: "2026-09-02T21:00:00.000Z", status: "RELEASED" },
  criterionIds: ["crit-1"], dependsOn: [], lastActivityAt: "2026-09-02T19:00:00.000Z",
  nodeKey: "node-a", nodeRef: "execution-node-a", objective: "Keep fields.",
  landing: null,
  receipt: { byteCount: 120, exitCode: 0, outputSha256: "o".repeat(64), test: "pnpm test", testedTreeSha: null, workspace: "D:/unai" },
  review: { escalated: false, findings: [{ detail: "Fine.", round: 1, ruleId: "rule-1", severity: "MINOR", subject: "NODE node-a" }], latestRoute: "ACCEPT", rounds: 1, unreadable: false, unsuccessfulRounds: 0, version: 3 },
  sharedKey: false,
  status: "ACCEPTED",
});
const DEPLOYMENT = Object.freeze({ environment: "production", target: { network: "product-net", host: "host.example" },
  sha: "a".repeat(40), time: "2026-09-06T11:00:00.000Z", url: "https://receipt.example", status: "DEPLOYED" });
const GOAL = Object.freeze({
  deployments: [DEPLOYMENT],
  goalId: "goal-1", lifecycle: "EXECUTION_ENABLED", nodes: [NODE],
  publish: null, run: { approval: "BOUND", lifecycle: "ACTIVATED", reviewable: false, runId: "run-1" }, title: "Build it",
});
const TOTALS = Object.freeze({
  ACCEPTED: 1, BLOCKED: 0, DELIVERED: 0, ESCALATED: 0, ESCALATION_REQUIRED: 0, IN_PROGRESS: 0, READY: 0,
  REPLANNED: 0, UNATTRIBUTABLE: 0, goals: 1, nodes: 1,
});
const RUNS = Object.freeze({ goals: [GOAL], outcome: "RUNS", totals: TOTALS });

const response = (status: number, body: unknown): Response => ({ json: async () => body, status } as unknown as Response);

describe("mapRunsAnswer", () => {
  it("preserves a valid tested tree and refuses malformed tree identity", () => {
    const frame = (testedTreeSha: unknown) => ({ ...RUNS, goals: [{ ...GOAL, nodes: [{ ...NODE,
      receipt: { ...NODE.receipt, testedTreeSha } }] }] });
    expect(mapRunsAnswer(200, frame("a".repeat(40)))).toMatchObject({ status: "RUNS", goals: [{ nodes: [{ receipt: { testedTreeSha: "a".repeat(40) } }] }] });
    for (const value of [undefined, "HEAD", "a".repeat(39), 42]) expect(mapRunsAnswer(200, frame(value))).toMatchObject({ status: "ERROR", code: "RUNS_RESPONSE_INVALID" });
  });
  it("maps a full RUNS frame with every node fact intact", () => {
    expect(mapRunsAnswer(200, RUNS)).toStrictEqual({ goals: [GOAL], status: "RUNS", totals: TOTALS });
  });

  it("maps a landed node's commit and a refused landing's code", () => {
    const committed = { branch: "main", code: null, files: ["src/a.ts"], outcome: "COMMITTED", sha: "a".repeat(40) };
    const refused = { branch: null, code: "NOTHING_TO_COMMIT", files: [], outcome: "REFUSED", sha: null };
    for (const landing of [committed, refused]) {
      const outcome = mapRunsAnswer(200, { ...RUNS, goals: [{ ...GOAL, nodes: [{ ...NODE, landing }] }] });
      expect(outcome).toMatchObject({ goals: [{ nodes: [{ landing }] }], status: "RUNS" });
    }
  });

  it("keeps a run-less, node-less goal honest", () => {
    const outcome = mapRunsAnswer(200, {
      goals: [{ deployments: [], goalId: "goal-0", lifecycle: "DRAFT", nodes: [], publish: null, run: null, title: null }],
      outcome: "RUNS", totals: { ...TOTALS, ACCEPTED: 0, nodes: 0 },
    });
    expect(outcome).toMatchObject({ goals: [{ deployments: [], goalId: "goal-0", nodes: [], publish: null, run: null, title: null }], status: "RUNS" });
  });

  it("carries refusals at their own layer", () => {
    expect(mapRunsAnswer(200, { code: "RUNS_READ_GOAL_UNKNOWN", layer: "RUNS_READ", outcome: "REFUSED" }))
      .toStrictEqual({ code: "RUNS_READ_GOAL_UNKNOWN", layer: "RUNS_READ", status: "REFUSED" });
    expect(mapRunsAnswer(503, { code: "LISTENER_RUNS_UNAVAILABLE", layer: "CONTROL_ROOM_LISTENER" }))
      .toStrictEqual({ code: "LISTENER_RUNS_UNAVAILABLE", layer: "CONTROL_ROOM_LISTENER", status: "REFUSED" });
  });

  it("reddens the whole answer when a nested row drifts", () => {
    const invalid = { code: "RUNS_RESPONSE_INVALID", layer: "CONTROL_ROOM_LIVE_RUNS", status: "ERROR" };
    expect(mapRunsAnswer(500, { unexpected: true })).toStrictEqual(invalid);
    expect(mapRunsAnswer(200, { ...RUNS, outcome: "RUN" })).toStrictEqual(invalid);
    expect(mapRunsAnswer(200, { ...RUNS, goals: [{ ...GOAL, nodes: [{ ...NODE, nodeRef: "" }] }] })).toStrictEqual(invalid);
    expect(mapRunsAnswer(200, { ...RUNS, goals: [{ ...GOAL, nodes: [{ ...NODE, status: "DONE" }] }] })).toStrictEqual(invalid);
    expect(mapRunsAnswer(200, { ...RUNS, goals: [{ ...GOAL, nodes: [{ ...NODE, claim: { active: true } }] }] })).toStrictEqual(invalid);
    expect(mapRunsAnswer(200, { ...RUNS, goals: [{ ...GOAL, nodes: [{ ...NODE, receipt: { exitCode: 0 } }] }] })).toStrictEqual(invalid);
    expect(mapRunsAnswer(200, { ...RUNS, goals: [{ ...GOAL, nodes: [{ ...NODE, landing: { outcome: "PUSHED" } }] }] })).toStrictEqual(invalid);
    expect(mapRunsAnswer(200, { ...RUNS, goals: [{ ...GOAL, nodes: [{ ...NODE, landing: { branch: "main", code: null, files: [1], outcome: "COMMITTED", sha: "a" } }] }] })).toStrictEqual(invalid);
    expect(mapRunsAnswer(200, { ...RUNS, goals: [{ ...GOAL, nodes: [{ ...NODE, review: { ...NODE.review, findings: [{ detail: 1 }] } }] }] })).toStrictEqual(invalid);
    expect(mapRunsAnswer(200, { ...RUNS, goals: [{ ...GOAL, run: { ...GOAL.run, approval: "MAYBE" } }] })).toStrictEqual(invalid);
    expect(mapRunsAnswer(200, { ...RUNS, totals: { ...TOTALS, extra: 1 } })).toStrictEqual(invalid);
  });
});

describe("readRuns", () => {
  it("posts exactly {} and maps the reply; a transport failure is an ERROR", async () => {
    const bodies: string[] = [];
    const outcome = await readRuns({ "x-moe-csrf": "t" }, async (body) => { bodies.push(body); return response(200, RUNS); });
    expect(bodies).toEqual(["{}"]);
    expect(outcome.status).toBe("RUNS");
    const scoped: string[] = [];
    await readRuns({}, async (body) => { scoped.push(body); return response(200, RUNS); }, "goal-1");
    expect(scoped).toEqual([JSON.stringify({ goalRef: "goal-1" })]);
    expect(await readRuns({}, async () => { throw new Error("down"); }))
      .toStrictEqual({ code: "TRANSPORT_REQUEST_FAILED", layer: "CONTROL_ROOM_LIVE_RUNS", status: "ERROR" });
  });
});

const INVALID = Object.freeze({ code: "RUNS_RESPONSE_INVALID", layer: "CONTROL_ROOM_LIVE_RUNS", status: "ERROR" });
const deploymentFrame = (deployments: unknown) => ({ ...RUNS, goals: [{ ...GOAL, deployments }] });
const receiptOnly = { environment: "production", sha: DEPLOYMENT.sha, time: DEPLOYMENT.time, status: "DEPLOYED" };

describe("deployment wire facts", () => {
  it("preserves the empty list and absence of target, receipt and public URL facts", () => {
    const rows = [
      { environment: "local", target: { network: "local-net" } },
      { environment: "remote", target: { network: "remote-net", host: "host.example" } },
      receiptOnly,
    ];
    for (const deployments of [[], rows]) {
      const answer = mapRunsAnswer(200, deploymentFrame(deployments));
      expect(answer).toStrictEqual({ goals: [{ ...GOAL, deployments }], status: "RUNS", totals: TOTALS });
    }
  });

  it("preserves each closed refusal code without adding diagnostic detail", () => {
    for (const code of ["DEPLOY_BUILD_FAILED", "DEPLOY_DOCKER_UNAVAILABLE", "DEPLOY_HEALTH_TIMEOUT", "DEPLOY_TARGET_MISSING"]) {
      const deployments = [{ ...receiptOnly, status: "REFUSED", code }];
      expect(mapRunsAnswer(200, deploymentFrame(deployments)))
        .toStrictEqual({ goals: [{ ...GOAL, deployments }], status: "RUNS", totals: TOTALS });
    }
  });

  it("uses the durable nonempty time contract without inventing an ISO requirement", () => {
    const deployments = [{ ...receiptOnly, sha: "b".repeat(64), time: "durable-clock-value" }];
    expect(mapRunsAnswer(200, deploymentFrame(deployments)))
      .toStrictEqual({ goals: [{ ...GOAL, deployments }], status: "RUNS", totals: TOTALS });
  });

  it("requires the wire key even though legacy in-memory goal types permit its absence", () => {
    const withoutDeployments = Object.fromEntries(Object.entries(GOAL).filter(([key]) => key !== "deployments"));
    expect(mapRunsAnswer(200, { ...RUNS, goals: [withoutDeployments] })).toStrictEqual(INVALID);
    for (const deployments of [undefined, null, {}, "production"]) {
      expect(mapRunsAnswer(200, deploymentFrame(deployments))).toStrictEqual(INVALID);
    }
  });

  it.each([
    ["unknown optional key", { ...DEPLOYMENT, detail: "not a wire fact" }],
    ["unknown target key", { ...DEPLOYMENT, target: { network: "net", sshTarget: "host.example" } }],
    ["target binding URL", { ...DEPLOYMENT, target: { network: "net", url: "https://binding.example" } }],
    ["missing environment", { target: { network: "net" } }],
    ["invalid environment", { ...DEPLOYMENT, environment: "../production" }],
    ["numeric environment", { ...DEPLOYMENT, environment: 1 }],
    ["uppercase environment", { ...DEPLOYMENT, environment: "Production" }],
    ["empty environment", { ...DEPLOYMENT, environment: "" }],
    ["environment without facts", { environment: "production" }],
    ["null target", { ...DEPLOYMENT, target: null }],
    ["target without network", { ...DEPLOYMENT, target: { host: "host.example" } }],
    ["invalid network", { ...DEPLOYMENT, target: { network: "--network" } }],
    ["SSH username", { ...DEPLOYMENT, target: { network: "net", host: "operator@host.example" } }],
    ["empty host", { ...DEPLOYMENT, target: { network: "net", host: "" } }],
    ["undefined optional host", { ...DEPLOYMENT, target: { network: "net", host: undefined } }],
    ["URL userinfo", { ...DEPLOYMENT, url: "https://user:password@host.example" }],
    ["non-HTTP URL", { ...DEPLOYMENT, url: "file:///tmp/output" }],
    ["javascript URL", { ...DEPLOYMENT, url: "javascript:alert(1)" }],
    ["relative URL", { ...DEPLOYMENT, url: "/product" }],
    ["null URL", { ...DEPLOYMENT, url: null }],
    ["invalid SHA", { ...DEPLOYMENT, sha: "HEAD" }],
    ["empty time", { ...DEPLOYMENT, time: "" }],
    ["numeric time", { ...DEPLOYMENT, time: 1 }],
    ["unknown status", { ...DEPLOYMENT, status: "HEALTHY" }],
    ["deployed with refusal code", { ...DEPLOYMENT, code: "DEPLOY_BUILD_FAILED" }],
    ["refused without code", { ...DEPLOYMENT, status: "REFUSED" }],
    ["open refusal vocabulary", { ...DEPLOYMENT, status: "REFUSED", code: "SOMETHING_FAILED" }],
    ["receipt facts without status", { environment: "production", sha: DEPLOYMENT.sha, time: DEPLOYMENT.time }],
    ["status without SHA", { environment: "production", status: "DEPLOYED", time: DEPLOYMENT.time }],
    ["status without time", { environment: "production", status: "DEPLOYED", sha: DEPLOYMENT.sha }],
    ["URL without receipt", { environment: "production", target: { network: "net" }, url: DEPLOYMENT.url }],
    ["code without receipt", { environment: "production", target: { network: "net" }, code: "DEPLOY_BUILD_FAILED" }],
  ])("drops only the environment with %s", (_label, row) => {
    const other = { ...GOAL, goalId: "goal-other", deployments: [] };
    const frame = { ...RUNS, goals: [{ ...GOAL, deployments: [DEPLOYMENT, row] }, other] };
    expect(mapRunsAnswer(200, frame)).toStrictEqual({ status: "RUNS", totals: TOTALS,
      goals: [{ ...GOAL, deployments: [DEPLOYMENT] }, other] });
  });

  it("refuses accessors without executing them", () => {
    let accesses = 0;
    const row = { ...DEPLOYMENT };
    Object.defineProperty(row, "url", { enumerable: true, get: () => { accesses += 1; return DEPLOYMENT.url; } });
    expect(mapRunsAnswer(200, deploymentFrame([row]))).toStrictEqual({ status: "RUNS", totals: TOTALS,
      goals: [{ ...GOAL, deployments: [] }] });
    expect(accesses).toBe(0);
  });
});

// Plain Node executes the real daemon producer; no cross-workspace TS import or authority mock.
// Dynamic imports also permit child-local load-hook omission drills before the producer loads.
const DAEMON_RUNS_SOURCE = String.raw`
const f = await import("./src/bootstrap/bootstrap-test-fixtures.js");
const { recordDeployReceipt } = await import("./src/deployment/deploy-ledger.js");
const { createRunsReadPort } = await import("./src/http/runs-read.js");
const store = f.openStore();
try {
  f.driveThrough(store, "goal.create");
  const bound = f.send(store, f.envelope("goal.create_with_source", 0, {
    instructions: "Build this PRD.", source: { displayPath: "docs/prd.md", mediaType: "text/markdown",
      text: "# Run me\n\n## 11. Evidence\nRows are immutable.\n" }, title: "Runs goal",
  }, f.GOAL_CREATE_COMMAND_ID));
  if (!bound.ok) throw new Error(bound.code);
  const empty = createRunsReadPort({ projectId: f.PROJECT_ID, store }).readRuns({});
  const target = f.send(store, f.envelope("deployment.set_target", 0, {
    environment: "production", network: "product-net", sshTarget: "operator@host.example",
    url: "https://binding.example",
  }, "cross-end-target"));
  if (!target.ok) throw new Error(target.code);
  const receipt = recordDeployReceipt(store, { projectId: f.PROJECT_ID, environment: "production",
    decisionId: "cross-end-deploy", sha: "a".repeat(40), imageDigest: "sha256:" + "b".repeat(64),
    refusal: null, releaseDecision: null, url: "https://receipt.example", decidedAt: "2026-09-06T11:00:00.000Z" });
  if (!receipt.ok) throw new Error(receipt.code);
  process.stdout.write(JSON.stringify({ empty,
    populated: createRunsReadPort({ projectId: f.PROJECT_ID, store }).readRuns({}) }));
} finally { f.closeStores(); }
`;

function recordOf(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected wire record");
  return value as Record<string, unknown>;
}

function expectSameKeys(served: unknown, decoded: unknown): void {
  if (Array.isArray(served)) {
    expect(Array.isArray(decoded)).toBe(true);
    if (!Array.isArray(decoded)) throw new Error("Decoded list missing");
    expect(decoded).toHaveLength(served.length);
    served.forEach((row: unknown, index: number) => expectSameKeys(row, decoded[index]));
  } else if (served !== null && typeof served === "object") {
    const source = recordOf(served), result = recordOf(decoded);
    expect(Object.keys(result).sort()).toStrictEqual(Object.keys(source).sort());
    for (const key of Object.keys(source)) expectSameKeys(source[key], result[key]);
  } else expect(decoded).toStrictEqual(served);
}

it("decodes actual daemon-served deployment keys bidirectionally without dropping or inventing facts", () => {
  const cwd = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "daemon");
  const stdout = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", DAEMON_RUNS_SOURCE],
    { cwd, encoding: "utf8", shell: false, windowsHide: true, timeout: 30_000, maxBuffer: 1_000_000 });
  const frames = recordOf(JSON.parse(stdout) as unknown), frame = frames["populated"];
  const empty = mapRunsAnswer(200, frames["empty"]);
  expect(empty.status).toBe("RUNS");
  expect(frames["empty"]).toMatchObject({ outcome: "RUNS", goals: [{ deployments: [] }] });
  if (empty.status !== "RUNS") throw new Error("Daemon omitted required empty deployment roster");
  expectSameKeys(recordOf(frames["empty"])["goals"], empty.goals);
  expect(frame).toMatchObject({ outcome: "RUNS", goals: [{ goalId: "goal-1", deployments: [DEPLOYMENT] }] });
  const answer = mapRunsAnswer(200, frame);
  expect(answer.status).toBe("RUNS");
  if (answer.status !== "RUNS") throw new Error("Actual daemon wire failed browser decoding");
  expectSameKeys(recordOf(frame)["goals"], answer.goals);
  expect(answer.goals).toStrictEqual(recordOf(frame)["goals"]);
}, 35_000);
