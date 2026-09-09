import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeAcceptanceContract, encodePlanRevision } from "@moe/core";
import { SqliteEventStore } from "@moe/store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BOOTSTRAP_HANDLERS, runBootstrapCommand } from "../bootstrap/bootstrap-services.js";
import {
  CLASSIFYING_POLICY_SLICE, POLICY_SLICE, PROVIDER_OBSERVATION,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { FIXTURE_ACTIVATION_RECEIPTS } from "../bootstrap/bootstrap-test-fixtures.js";
import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import { GOAL_HANDLERS } from "../goals/goal-services.js";
import { installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
import { journeyAuthority } from "../planning/journey-authority-bodies.js";
import { bodiesDigestOf } from "../planning/planning-authority-persistence.js";
import { PLANNING_HANDLERS } from "../planning/planning-services.js";
import { DEFAULT_GOAL_SUBJECT, DEFAULT_RUN_SUBJECT } from "./affordance-read.js";
import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import type { AuthenticationResult, CommandAdapterDeps } from "./http-contract.js";
import { startControlRoomListener } from "./http-listener.js";
import type { ControlRoomListener } from "./http-listener.js";
import { createPlanningRunReadPort } from "./planning-run-read.js";

/**
 * Drives the REAL listener end to end. The chain here is the same one
 * `affordance-read-planning.test.ts` walks to move `run-live-1` to PLAN_REVIEW, so the frame the
 * approver would read is measured against the run the board actually addresses, not a hand-shaped
 * fixture. A tampered bodies event is planted through the store to prove the read reports it as
 * unsealed rather than serving it or throwing.
 */

const PROJECT = "proj-planning-run-read";
const CSRF = "planning-run-csrf";
const CREDENTIAL = "planning-run-session";
const NO_CAPABILITY_CREDENTIAL = "planning-run-readonly";

const directory = mkdtempSync(join(tmpdir(), "moe-planning-run-read-"));
const store = SqliteEventStore.openForProject(join(directory, "store.db"), PROJECT);
installTestRecoveryBinding(store);

const encoder = new TextEncoder();
let minted = 0;

const sealed = journeyAuthority({
  authorRef: "operator-local",
  criterionIds: [`${DEFAULT_GOAL_SUBJECT}-criterion`],
  graphRevisionRef: "graph-revision-1",
  idPrefix: DEFAULT_RUN_SUBJECT,
  nodeIds: ["node-code-1"],
  stepDescription: "Land the live board's demo node.",
});

/** `commandId` is nameable because `goal.create` derives the goal it mints from it. */
function commitBootstrap(
  kind: string, payload: Record<string, unknown>, expectedVersion = 0, commandId?: string,
): void {
  const outcome = runBootstrapCommand(store, encoder.encode(JSON.stringify({
    commandId: commandId ?? `cmd-${kind}-${String(minted += 1)}`,
    correlationId: "corr-1",
    decidedAt: "2026-08-22T12:00:00.000Z",
    expectedVersion,
    kind,
    payload,
    principalId: "operator-local",
    projectId: PROJECT,
    schemaVersion: "moe-bootstrap-command/1",
  })), { ...BOOTSTRAP_HANDLERS, ...GOAL_HANDLERS, ...PLANNING_HANDLERS }, undefined,
  // `project.activate` MINTS its witness from measured receipts and refuses without them.
  FIXTURE_ACTIVATION_RECEIPTS);
  if (!outcome.ok) throw new Error(`${kind}: ${outcome.code} (${outcome.refusedBy})`);
}

function commitProposeChain(): void {
  commitBootstrap("plan.propose", {
    commands: [
      {
        commandId: "live-create", expectedVersion: 0, goalRef: DEFAULT_GOAL_SUBJECT,
        kind: "planning.create_draft", runId: DEFAULT_RUN_SUBJECT, runKind: "INITIAL",
      },
      {
        commandId: "live-ready", expectedVersion: 1, kind: "planning.ready",
        witness: {
          acceptanceCriteriaRef: "criteria-1", intentBaseRef: "intent-1",
          planningBudgetRef: "budget-1", truthClass: "DAEMON_VERIFIED",
        },
      },
      {
        commandId: "live-claim", expectedVersion: 2, kind: "planning.claim",
        witness: {
          attemptRef: "attempt-1", contextRef: "context-1", leaseRef: "lease-1",
          providerSlotRef: "slot-1", truthClass: "DAEMON_VERIFIED",
        },
      },
      {
        authority: sealed.authority,
        graphContentBytesBase64: sealed.graphContentBytesBase64,
        commandId: "live-propose",
        effectTerminalProof: {
          effectTerminalRef: "effect-terminal-1",
          resourcesTerminalRef: "resources-terminal-1", truthClass: "DAEMON_VERIFIED",
        },
        expectedVersion: 3, kind: "plan.propose", proposalKind: "INITIAL",
        submissionHash: sealed.submissionHash,
        witness: {
          attemptRef: "attempt-1", submissionRef: "submission-1", truthClass: "DAEMON_VERIFIED",
        },
      },
    ],
    runId: DEFAULT_RUN_SUBJECT,
  });
}

function commitFinalize(): void {
  commitBootstrap("plan.propose", {
    commands: [
      {
        commandId: "live-finalize", expectedVersion: 4, kind: "planning.finalize_submission",
        revision: {
          dependencyHash: "d1".padEnd(64, "0"), graphContentHash: sealed.graphContentHash,
          graphRevisionRef: "graph-revision-1", planHash: sealed.submissionHash,
          qualityHash: "dd".padEnd(64, "0"),
        },
        witness: {
          attemptTerminalRef: "attempt-terminal-1", effectTerminalRef: "effect-terminal-1",
          nodeSummaries: [{ executionBearing: true, nodeKey: "node-code-1" }],
          providerSlotTerminalRef: "slot-terminal-1",
          resourcesTerminalRef: "resources-terminal-1", truthClass: "DAEMON_VERIFIED",
        },
      },
    ],
    runId: DEFAULT_RUN_SUBJECT,
  }, 1);
}

/** Plants a known run whose SINGLE bodies event carries a wrong framed digest: every codec admits
 *  the bytes, so only the seal recompute can catch it. */
function plantTamperedRun(runId: string): void {
  const planEncoded = encodePlanRevision(sealed.authority["planRevision"]);
  const contractEncoded = encodeAcceptanceContract(sealed.authority["acceptanceContract"]);
  if (!planEncoded.ok || !contractEncoded.ok) throw new Error("could not encode tamper bodies");
  const runRecord = {
    authorityRef: `planning-authority/${runId}`,
    state: { goalRef: DEFAULT_GOAL_SUBJECT, lifecycle: "PLANNING", runId },
    submissionHash: sealed.submissionHash,
  };
  const bodies = {
    acceptanceContractBytesBase64: Buffer.from(contractEncoded.bytes).toString("base64"),
    bodiesDigest: "0".repeat(64),
    planRevisionBytesBase64: Buffer.from(planEncoded.bytes).toString("base64"),
  };
  store.commitExpectedVersionDecision({
    commandKind: "plan.propose", committedResultBytes: encoder.encode(JSON.stringify(runRecord)),
    correlationId: "corr-tamper", decidedAt: "2026-08-22T12:00:00.000Z",
    events: [{ eventId: `${runId}-PlanProposed`, eventType: "PlanProposed",
      payload: encoder.encode(JSON.stringify({})) }],
    expectedVersion: 0,
    key: { commandId: "cmd-tamper-run", principalId: "operator-local", projectId: PROJECT },
    requestBytes: encoder.encode("tamper-run"), targetAggregateId: runId,
  });
  store.commitExpectedVersionDecision({
    commandKind: "plan.propose", committedResultBytes: encoder.encode(JSON.stringify({})),
    correlationId: "corr-tamper", decidedAt: "2026-08-22T12:00:00.000Z",
    events: [{ eventId: `${runId}-bodies`, eventType: "PlanningAuthorityBodiesSealed",
      payload: encoder.encode(JSON.stringify(bodies)) }],
    expectedVersion: 0,
    key: { commandId: "cmd-tamper-bodies", principalId: "operator-local", projectId: PROJECT },
    requestBytes: encoder.encode("tamper-bodies"), targetAggregateId: `planning-authority/${runId}`,
  });
}

/** Plants a run whose SINGLE bodies event is internally consistent - valid codecs AND the WRITER's
 *  own correct framed digest - but whose plan hashes to a value the run's submissionHash does NOT
 *  carry. The framed recompute passes, so only the planHash-to-submissionHash bind can catch it:
 *  a whole-payload replant that seals another run's valid plan against this run's record. */
function plantMismatchedRun(runId: string, submissionHash: string): void {
  const planEncoded = encodePlanRevision(sealed.authority["planRevision"]);
  const contractEncoded = encodeAcceptanceContract(sealed.authority["acceptanceContract"]);
  if (!planEncoded.ok || !contractEncoded.ok) throw new Error("could not encode mismatch bodies");
  const runRecord = {
    authorityRef: `planning-authority/${runId}`,
    state: { goalRef: DEFAULT_GOAL_SUBJECT, lifecycle: "PLANNING", runId },
    submissionHash,
  };
  const bodies = {
    acceptanceContractBytesBase64: Buffer.from(contractEncoded.bytes).toString("base64"),
    bodiesDigest: bodiesDigestOf(planEncoded.bytes, contractEncoded.bytes),
    planRevisionBytesBase64: Buffer.from(planEncoded.bytes).toString("base64"),
  };
  store.commitExpectedVersionDecision({
    commandKind: "plan.propose", committedResultBytes: encoder.encode(JSON.stringify(runRecord)),
    correlationId: "corr-mismatch", decidedAt: "2026-08-22T12:00:00.000Z",
    events: [{ eventId: `${runId}-PlanProposed`, eventType: "PlanProposed",
      payload: encoder.encode(JSON.stringify({})) }],
    expectedVersion: 0,
    key: { commandId: "cmd-mismatch-run", principalId: "operator-local", projectId: PROJECT },
    requestBytes: encoder.encode("mismatch-run"), targetAggregateId: runId,
  });
  store.commitExpectedVersionDecision({
    commandKind: "plan.propose", committedResultBytes: encoder.encode(JSON.stringify({})),
    correlationId: "corr-mismatch", decidedAt: "2026-08-22T12:00:00.000Z",
    events: [{ eventId: `${runId}-bodies`, eventType: "PlanningAuthorityBodiesSealed",
      payload: encoder.encode(JSON.stringify(bodies)) }],
    expectedVersion: 0,
    key: { commandId: "cmd-mismatch-bodies", principalId: "operator-local", projectId: PROJECT },
    requestBytes: encoder.encode("mismatch-bodies"), targetAggregateId: `planning-authority/${runId}`,
  });
}

function authentication(credential: string | null): AuthenticationResult {
  if (credential === CREDENTIAL) {
    return {
      principal: {
        capabilities: [CAPABILITIES.PLANNING], principalId: "operator-local", projectId: PROJECT,
      },
      verdict: "AUTHENTICATED",
    };
  }
  if (credential === NO_CAPABILITY_CREDENTIAL) {
    return {
      principal: { capabilities: [], principalId: "reader-1", projectId: PROJECT },
      verdict: "AUTHENTICATED",
    };
  }
  return { verdict: "UNAUTHENTICATED" };
}

const deps: CommandAdapterDeps = {
  authenticator: { authenticate: authentication },
  decisions: {
    decide: (): never => { throw new Error("planning run read must not enter the decision port"); },
  },
  registry: {
    get: (): never => { throw new Error("planning run read must not enter the command registry"); },
  } as unknown as CommandAdapterDeps["registry"],
};

let listener: ControlRoomListener;

beforeAll(async () => {
  commitBootstrap("project.register", { owner: "operator-local" });
  commitBootstrap("project.bind_repository", {
    observation: {
      baseRevisionHash: "b".repeat(64), repositoryRef: "repo-1",
      scopeRef: "scope-1", truthClass: "DAEMON_VERIFIED",
    },
  }, 1);
  commitBootstrap("provider.probe", { observation: PROVIDER_OBSERVATION });
  commitBootstrap("policy.install", {
    slice: POLICY_SLICE,
  });
  // The finalize terminal refuses a run no installed policy can tier (task-a888038d), so this
  // world installs the risk-classifying table too or its proposal never reaches PLAN_REVIEW.
  commitBootstrap("policy.install", { slice: CLASSIFYING_POLICY_SLICE }, 1);
  commitBootstrap("project.activate", // NO WITNESS: the daemon mints it from its own measured receipts.
      {}, 2);
  // The default board subjects are a DERIVED PAIR now: command `live-1` mints `goal-live-1`
  // and its own `run-live-1`, which is the run this listener addresses.
  commitBootstrap(
    "goal.create",
    { instructions: "Drive the live planning run.", title: "Live board goal" },
    0,
    "live-1",
  );

  const candidate = await startControlRoomListener({
    csrfToken: CSRF, deps, planningRuns: createPlanningRunReadPort({ projectId: PROJECT, store }),
  });
  if (!candidate.ok) throw new Error(`listener failed: ${candidate.code}`);
  listener = candidate;
});

afterAll(async () => {
  await listener.close();
  store.close();
  rmSync(directory, { force: true, recursive: true });
});

interface Reply {
  readonly body: Record<string, unknown>;
  readonly status: number;
}

async function send(options: {
  readonly body?: Buffer | string;
  readonly credential?: string | null;
  readonly method?: string;
  readonly origin?: string;
} = {}): Promise<Reply> {
  const payload = options.body ?? JSON.stringify({ runId: DEFAULT_RUN_SUBJECT });
  const headers: Record<string, string | number> = {
    "content-length": Buffer.byteLength(payload),
    "content-type": "application/json",
    host: `127.0.0.1:${listener.port}`,
    origin: options.origin ?? listener.origin,
    "x-moe-csrf": CSRF,
    "x-moe-protocol-version": WIRE_PROTOCOL_VERSION,
  };
  if (options.credential !== null) {
    headers["x-moe-session-credential"] = options.credential ?? CREDENTIAL;
  }
  return await new Promise<Reply>((resolve, reject) => {
    const request = httpRequest({
      headers, host: "127.0.0.1", method: options.method ?? "POST",
      path: "/planning/run/read", port: listener.port, setHost: false,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          body: (text === "" ? {} : JSON.parse(text)) as Record<string, unknown>,
          status: response.statusCode ?? 0,
        });
      });
    });
    request.on("error", reject);
    request.end(payload);
  });
}

const HEX64 = /^[0-9a-f]{64}$/u;

describe("POST /planning/run/read", () => {
  it("serves the sealed plan and criteria while the run is still PLANNING", async () => {
    commitProposeChain();
    const reply = await send();
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({
      lifecycle: "PLANNING", outcome: "RUN", reviewable: false,
      runId: DEFAULT_RUN_SUBJECT, submissionHash: sealed.submissionHash,
    });
    const authority = reply.body["authority"] as Record<string, unknown>;
    expect(authority["authorityRef"]).toBe(`planning-authority/${DEFAULT_RUN_SUBJECT}`);
    expect(authority["envelopeDigest"]).toBeNull();
    expect(authority["bodiesDigest"]).toMatch(HEX64);
    const plan = reply.body["plan"] as Record<string, unknown>;
    expect(plan["planHash"]).toBe(sealed.submissionHash);
    expect(plan["affectedNodeIds"]).toStrictEqual(["node-code-1"]);
    expect(plan["affectedCriterionIds"]).toStrictEqual([`${DEFAULT_GOAL_SUBJECT}-criterion`]);
    expect(plan["steps"]).toStrictEqual([
      { description: "Land the live board's demo node.", kind: "ANALYSIS", stepId: "step-00001" },
    ]);
    const acceptance = reply.body["acceptance"] as Record<string, unknown>;
    expect(acceptance["criteriaDigest"]).toMatch(HEX64);
    expect((acceptance["obligations"] as unknown[]).length).toBe(1);
    expect((acceptance["obligations"] as Record<string, unknown>[])[0]).toMatchObject({
      criterionId: `${DEFAULT_GOAL_SUBJECT}-criterion`,
      statement: `the run satisfies ${DEFAULT_GOAL_SUBJECT}-criterion`,
    });
  });

  it("reports the run reviewable once the finalize terminal lands, carrying the envelope digest", async () => {
    commitFinalize();
    const reply = await send();
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({
      approval: "ABSENT", lifecycle: "PLAN_REVIEW", outcome: "RUN", reviewable: true,
      runId: DEFAULT_RUN_SUBJECT, submissionHash: sealed.submissionHash,
    });
    const authority = reply.body["authority"] as Record<string, unknown>;
    expect(authority["authorityRef"]).toBe(`planning-authority/${DEFAULT_RUN_SUBJECT}`);
    expect(authority["bodiesDigest"]).toMatch(HEX64);
    expect(authority["envelopeDigest"]).toMatch(HEX64);
    expect(reply.body["acceptance"]).not.toBeNull();
    expect(reply.body["plan"]).not.toBeNull();
  });

  it("refuses a runId no committed run answers for", async () => {
    const reply = await send({ body: JSON.stringify({ runId: "run-does-not-exist" }) });
    expect(reply.status).toBe(200);
    expect(reply.body).toStrictEqual({
      code: "PLANNING_RUN_READ_RUN_UNKNOWN", layer: "PLANNING_RUN_READ", outcome: "REFUSED",
    });
  });

  it("refuses an unauthenticated read before touching the port", async () => {
    const reply = await send({ credential: null });
    expect(reply.status).toBe(401);
    expect(reply.body).toMatchObject({
      error: { code: "AUTHENTICATION_FAILED" }, ok: false, outcome: "REFUSED", stage: "AUTHENTICATE",
    });
  });

  it("refuses a foreign Origin ahead of the read", async () => {
    const reply = await send({ origin: "http://attacker.invalid" });
    expect(reply.status).toBe(403);
    expect(reply.body).toStrictEqual({
      code: "LISTENER_ORIGIN_INVALID", layer: "CONTROL_ROOM_LISTENER",
    });
  });

  it("refuses a principal that lacks the planning capability", async () => {
    const reply = await send({ credential: NO_CAPABILITY_CREDENTIAL });
    expect(reply.status).toBe(200);
    expect(reply.body).toStrictEqual({
      code: "PLANNING_RUN_READ_CAPABILITY_DENIED", layer: "PLANNING_RUN_READ", outcome: "REFUSED",
    });
  });

  it("reports bodies whose plan hashes to another run as unsealed, not this run's answer", async () => {
    const otherHash = "a".repeat(64);
    expect(otherHash).not.toBe(sealed.submissionHash);
    plantMismatchedRun("run-mismatch-1", otherHash);
    const reply = await send({ body: JSON.stringify({ runId: "run-mismatch-1" }) });
    expect(reply.status).toBe(200);
    expect(reply.body).toStrictEqual({
      acceptance: null, approval: "ABSENT", authority: null, lifecycle: "PLANNING",
      outcome: "RUN", plan: null, reviewable: false, runId: "run-mismatch-1",
      submissionHash: otherHash,
    });
  });

  it("reports tampered bodies as unsealed rather than serving them or throwing", async () => {
    plantTamperedRun("run-tamper-1");
    const reply = await send({ body: JSON.stringify({ runId: "run-tamper-1" }) });
    expect(reply.status).toBe(200);
    expect(reply.body).toStrictEqual({
      acceptance: null, approval: "ABSENT", authority: null, lifecycle: "PLANNING",
      outcome: "RUN", plan: null, reviewable: false, runId: "run-tamper-1",
      submissionHash: sealed.submissionHash,
    });
  });
});
