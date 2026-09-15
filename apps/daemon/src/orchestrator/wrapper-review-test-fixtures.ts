import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { JsonObject } from "@moe/contracts";
import { GOAL_ID, PROJECT_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import { createDaemonCommandPorts, OPERATOR_CAPABILITIES } from "../daemon-command-registry.js";
import { createAffordancePort } from "../http/affordance-read.js";
import { handleAsyncCommandRequest } from "../http/http-adapter.js";
import { WIRE_PROTOCOL_VERSION } from "../http/http-contract.js";
import { createSessionAuthenticator } from "../identity/session-authenticator.js";
import { readGraphBody } from "../planning/graph-body-record.js";
import { approveGate1, approvePlan, boundWorld, committedRevision, structureOf, submit }
  from "../planning/plan-reject-test-fixtures.js";
import { createVerifiedWorkspacePort } from "../repository/git-verified-workspace-port.js";
import { readReviewLedger } from "../review/review-read-model.js";
import { verifyStoredPackageItems } from "../review/review-package-restore.js";
import { calibration, policyInput } from "../review/review-test-fixtures.js";
import { NODE_VERIFIER_PRINCIPAL_ID } from "../review/verifier-receipt-contracts.js";
import { compiledExecutionRef } from "./compiled-execution-ref.js";
import { createCompiledNodeSource } from "./compiled-node-source.js";
import { createNodeVerifier } from "./node-verifier.js";
import { createAgentWrapper } from "./agent-wrapper.js";
import type { SpawnRequest } from "./agent-wrapper.js";
import { staffingSurfaceOf } from "./agent-staffing-surface.js";
import { createReviewAwareNodeMissions } from "./wrapper-review-missions.js";

export const OPERATOR = "operator-local";
const CREDENTIAL = "wrapper-review-test-operator";
export const MARKER = "VERIFIER_EXPECTED_42_FROM_REAL_PROCESS";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** Real approved compiled authority, real Git candidate, normal registry and wrapper. */
export interface ReviewWorldOptions {
  /** A multi-node plan; the default is the single `node-slice` graph. */
  readonly nodes?: readonly Record<string, unknown>[];
  readonly completionNodeKey?: string;
  /** The node this world reviews, verifies and staffs. */
  readonly nodeKey?: string;
  readonly thirdCriterion?: boolean;
}

export function reviewWorld(options: ReviewWorldOptions = {}) {
  const store = boundWorld();
  const revision = committedRevision(store, options.thirdCriterion ?? false);
  approveGate1(store, revision);
  const sealed = submit(store, revision, options.nodes === undefined ? {}
    : { structure: structureOf(options.nodes, options.completionNodeKey) });
  if (!sealed.ok) throw new Error(sealed.code);
  approvePlan(store, sealed.runId);
  const graph = readGraphBody(store, PROJECT_ID, sealed.graphContentHash);
  if (!graph.ok) throw new Error(graph.code);
  const nodeRef = compiledExecutionRef(PROJECT_ID, {
    content: graph.content, goalRef: GOAL_ID, planningRunRef: sealed.runId,
  }, options.nodeKey ?? "node-slice");
  const workspace = mkdtempSync(join(tmpdir(), "moe-wrapper-review-"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.fsmonitor=false",
    "-c", "core.hooksPath=", ...args], { cwd: workspace, encoding: "utf8", windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main", "--template=");
  writeFileSync(join(workspace, "app.mjs"), "export const answer = 41;\n");
  writeFileSync(join(workspace, "check.mjs"),
    `import { answer } from './app.mjs';\nif(answer!==42){console.error('${MARKER}');process.exit(1)}\nconsole.log('verified 42');\n`);
  git("add", "--", "app.mjs", "check.mjs");
  git("-c", "commit.gpgSign=false", "-c", "user.name=Review Test", "-c", "user.email=review@test.invalid",
    "commit", "-qm", "real application baseline");
  const authenticator = createSessionAuthenticator(store, { clock: Date.now,
    operatorCapabilities: OPERATOR_CAPABILITIES, operatorCredential: CREDENTIAL,
    operatorPrincipalId: OPERATOR, projectId: PROJECT_ID });
  const ports = createDaemonCommandPorts({ clock: () => new Date().toISOString(),
    operatorPrincipalId: OPERATOR, projectId: PROJECT_ID, store,
    reviewSubmission: { workspace, authenticate: authenticator.authenticate } });
  const deps = { ...ports, authenticator };
  const compiled = createCompiledNodeSource({ projectId: PROJECT_ID, store, workspace, testCommand: "node check.mjs" });
  const missions = createReviewAwareNodeMissions({ workspace, testCommand: "node check.mjs",
    log: () => undefined, projectId: PROJECT_ID, operatorPrincipalId: OPERATOR, store: () => store });
  const affordances = staffingSurfaceOf(createAffordancePort({ projectId: PROJECT_ID, principalId: OPERATOR,
    store, nodes: compiled.nodes, mintId: () => randomUUID() }));
  const requests: SpawnRequest[] = [];
  let finish: (() => void) | undefined;
  const wrapper = createAgentWrapper({ affordances, deps, nodeMission: missions.nodeMission,
    reviewContinuation: missions.reviewContinuation,
    operatorCredential: CREDENTIAL, projectId: PROJECT_ID, clock: Date.now, claimTtlMs: 120_000,
    maxAgents: 1, mintSecret: () => randomUUID().replaceAll("-", ""), spawnAgent: async (request) => {
      requests.push(request);
      return { ok: true, pid: 919191, exit: new Promise<void>((resolve) => { finish = resolve; }) };
    } });
  const dispatch = async (request: SpawnRequest, kind: string, payload: JsonObject,
    expectedVersion: number, target: string = nodeRef) => handleAsyncCommandRequest(deps, {
      body: new TextEncoder().encode(JSON.stringify({ commandId: randomUUID(), commandKind: kind,
        correlationId: "wrapper-review-test", expectedVersion, payload,
        requestDigest: sha(JSON.stringify(payload)), schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
        sessionCredential: request.credential, targetAggregateId: target })),
      credential: request.credential, protocolVersion: WIRE_PROTOCOL_VERSION,
    }, "MCP_HTTP");
  const finishSeat = async () => { finish?.(); await wrapper.settle(); };
  let runs = 0;
  const verifier = createNodeVerifier({ deps, mintId: randomUUID, nodeMission: missions.nodeMission,
    nodes: compiled.nodes, operatorCredential: CREDENTIAL, projectId: PROJECT_ID, store,
    verifiedWorkspace: createVerifiedWorkspacePort(),
    verificationAuthority: () => {
      const latest = readReviewLedger(store, PROJECT_ID, nodeRef).rounds.at(-1);
      if (latest === undefined) return null;
      const restored = verifyStoredPackageItems(latest);
      return restored.ok ? { calibration: calibration(),
        packageItems: restored.items.filter((item) => item.kind !== "DAEMON_RECEIPT"),
        policy: policyInput({ actor: NODE_VERIFIER_PRINCIPAL_ID }) } : null;
    },
    runTest: async () => {
      runs += 1;
      const tested = spawnSync(process.execPath, ["check.mjs"], { cwd: workspace, encoding: "utf8", windowsHide: true });
      const output = tested.stdout + tested.stderr;
      return { byteCount: Buffer.byteLength(output), exitCode: tested.status, output, sha256: sha(output) };
    } });
  const submitSeat = async (request: SpawnRequest) => {
    const version = readReviewLedger(store, PROJECT_ID, nodeRef).version;
    return dispatch(request, "review.submit", { subjectRef: nodeRef, round: version + 1, findings: [], packageItems: [] }, version);
  };
  return { store, workspace, nodeRef, compiled, missions, requests, wrapper, finishSeat, verifier,
    submitSeat, dispatch, runs: () => runs };
}
