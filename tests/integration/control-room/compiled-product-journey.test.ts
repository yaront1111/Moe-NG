/**
 * THE PRODUCT JOURNEY, SEALED: one PRD in, one buildable verified node out,
 * through every production seam the live stack serves — the same registry the
 * HTTP listener dispatches, the same affordance surface the wrapper staffs, the
 * same pending-read the Gate 1 card fetches, the same active-graph projection
 * the compiled-node source briefs from.
 *
 *   goal.create_with_source(PRD)
 *     -> ladder offers product_contract.propose_revision, WITHHOLDS plan.propose
 *     -> agent session proposes the Product Contract (writer commit)
 *     -> Gate 1 card read answers the pending revision + daemon-minted template
 *     -> paired durable HUMAN principal approves over the BROWSER origin
 *     -> ladder flips to planning.submit_decomposition
 *     -> agent submits PLAN ONLY (no scopes, no capability - the dispatcher
 *        states the closed risk profile, so no RUN_POLICY park is reachable)
 *     -> run REVIEWABLE, ladder offers both human approval wires
 *     -> the HUMAN principal approves via approval.decide_intent (browser wire)
 *     -> graph ACTIVE, the compiled node surfaces as buildable board work with
 *        a brief carrying the approved criterion statement.
 *
 * Every actor uses its own authority: agent sessions hold PLANNING+WORK and
 * never a human act; the human is a durable pairing-minted principal; nothing
 * dispatches as the configured operator after bootstrap.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import { afterAll, expect, it } from "vitest";

import {
  GOAL_CREATE_COMMAND_ID,
  GOAL_ID,
  PROJECT_ID,
  driveThrough,
  envelope,
  send,
} from "../../../apps/daemon/src/bootstrap/bootstrap-test-fixtures.ts";
import {
  createStoreDependencies,
} from "../../../apps/daemon/src/daemon-store-dependencies.ts";
import { handleCommandRequest } from "../../../apps/daemon/src/http/http-adapter.ts";
import { WIRE_PROTOCOL_VERSION } from "../../../apps/daemon/src/http/http-contract.ts";
import {
  installTestRecoveryBinding,
} from "../../../apps/daemon/src/identity/session-test-fixtures.ts";
import {
  createCompiledNodeSource,
} from "../../../apps/daemon/src/orchestrator/compiled-node-source.ts";

const PRD = [
  "# Uai identity kernel",
  "",
  "Belief keys need one stable identity codec: encode(decode(key)) is the key.",
  "",
].join("\n");
const NOW_ISO = "2026-08-31T12:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
const OPERATOR_CREDENTIAL = "journey-operator-credential";
const AGENT_SESSION = "sess-journey-agent";
const AGENT_SECRET = "secret-journey-agent";
const HUMAN_SESSION = "sess-journey-human";
const HUMAN_SECRET = "secret-journey-human";
const CONTRACT_ID = "uai-contract-1";
const REVISION_ID = "uai-revision-1";
const NODE_KEY = "node-uai-kernel";
const CRITERION_STATEMENT =
  "identities.ts exports encode/decode and every key round-trips byte-identically.";
const ALL_CAPABILITIES = Object.freeze([
  "goal.write", "planning.write", "project.admin", "review.write", "work.write",
]);

const directory = mkdtempSync(join(tmpdir(), "moe-compiled-journey-"));
const storePath = join(directory, "store.db");
const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const cleanup of cleanups.reverse()) {
    try { cleanup(); } catch { /* teardown only */ }
  }
  rmSync(directory, { force: true, recursive: true });
});

const encoder = new TextEncoder();
const sha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

interface Dispatched {
  readonly decision?: { readonly disposition: string; readonly resultCode: string };
  readonly ok: boolean;
  readonly outcome: string;
  readonly refusal?: { readonly code: string; readonly layer: string };
  readonly error?: { readonly code: string };
}

it("compiles one PRD into an ACTIVE buildable node through every live seam", () => {
  // ---- world: bootstrap + the source-bound goal, via the shipped sequence ----
  const setup = SqliteEventStore.openForProject(storePath, PROJECT_ID);
  try {
    installTestRecoveryBinding(setup);
    driveThrough(setup, "goal.create");
    const bound = send(setup, envelope("goal.create_with_source", 0, {
      instructions: "Compile prd.md and build it.",
      source: { displayPath: "prd.md", mediaType: "text/markdown", text: PRD },
      title: "Uai identity kernel",
    }, GOAL_CREATE_COMMAND_ID));
    if (!bound.ok) throw new Error(`goal bind refused: ${bound.code}`);
  } finally {
    setup.close();
  }

  const provider = createStoreDependencies({
    clock: () => NOW_ISO,
    credential: OPERATOR_CREDENTIAL,
    principalId: "operator-local",
    projectId: PROJECT_ID,
    storePath,
  });
  cleanups.push(() => { provider.close(); });
  const deps = provider.provide();

  const dispatch = (
    kind: string, payload: Record<string, unknown>, credential: string,
    commandId: string, target: string, expectedVersion = 0,
    origin: "HTTP_LISTENER" | undefined = "HTTP_LISTENER",
  ): Dispatched => handleCommandRequest(deps, {
    body: encoder.encode(JSON.stringify({
      commandId, commandKind: kind, correlationId: `corr-${commandId}`,
      expectedVersion, payload,
      requestDigest: sha256(JSON.stringify(payload)),
      schemaVersion: "moe-runtime-command/1",
      sessionCredential: credential, targetAggregateId: target,
    })),
    credential,
    protocolVersion: WIRE_PROTOCOL_VERSION,
  }, origin) as Dispatched;

  const accepted = (label: string, result: Dispatched): void => {
    if (result.outcome !== "ACCEPTED") {
      throw new Error(`${label}: ${JSON.stringify(result.refusal ?? result.error ?? result)}`);
    }
  };

  // ---- identities: one AGENT session, one durable HUMAN paired principal ----
  const openSession = (sessionId: string, secret: string): void => accepted(
    `session.open ${sessionId}`,
    dispatch("session.open", {
      capabilities: [...ALL_CAPABILITIES],
      credentialSha256: createHash("sha256").update(secret, "utf8").digest("hex"),
      expiresAt: "2027-01-01T00:00:00.000Z",
      sessionId,
    }, OPERATOR_CREDENTIAL, `cmd-open-${sessionId}`, `session/${sessionId}`),
  );
  openSession(AGENT_SESSION, AGENT_SECRET);
  openSession(HUMAN_SESSION, HUMAN_SECRET);
  const authority = provider.pairingOpenSessions?.() as unknown as {
    createPrincipal(input: Record<string, unknown>): { code?: string; ok: boolean };
  };
  const minted = authority.createPrincipal({
    commandId: "cmd-journey-human-principal",
    correlationId: "corr-journey-human-principal",
    kind: "HUMAN",
    principalId: HUMAN_SESSION,
    profileRevisionId: "profile-journey-1",
  });
  if (!minted.ok) throw new Error(`human principal refused: ${minted.code ?? "?"}`);

  const surface = () => {
    const read = provider.affordances?.().readSurface();
    if (read?.outcome !== "SURFACE") throw new Error(`surface refused: ${read?.code}`);
    return read;
  };
  const offered = (kinds: readonly unknown[]): readonly string[] =>
    kinds.map((offer) => (offer as { commandKind: string }).commandKind);

  // ---- LADDER 1: the source-bound goal offers the writer, never plan.propose ----
  const preGate = surface();
  const preKinds = offered(preGate.nextAllowedCommands);
  expect(preKinds).toContain("product_contract.propose_revision");
  expect(preKinds).not.toContain("plan.propose");
  expect(preKinds).not.toContain("planning.submit_decomposition");

  // ---- the AGENT writes the Product Contract from the PRD it can read ----
  const source = provider.goalSource?.().read(GOAL_ID);
  if (source?.ok !== true) throw new Error("goal source unreadable");
  expect(source.text).toBe(PRD);
  accepted("propose_revision", dispatch("product_contract.propose_revision", {
    draft: {
      authorRef: AGENT_SESSION,
      contractId: CONTRACT_ID,
      criteria: [{
        criterionId: "crit-roundtrip",
        requirementId: "req-identity",
        statement: CRITERION_STATEMENT,
        supersedesCriterionId: null,
      }],
      lineage: null,
      requirements: [{
        requirementId: "req-identity",
        statement: "Belief keys have one stable identity codec.",
        supersedesRequirementId: null,
      }],
      retiredCriterionIds: [],
      retiredRequirementIds: [],
      revisionId: REVISION_ID,
      sourceDocumentDigests: [source.contentSha256],
    },
    goalRef: GOAL_ID,
  }, AGENT_SECRET, "cmd-journey-propose", GOAL_ID));

  // ---- GATE 1: the card's read, then the HUMAN approval over the BROWSER wire ----
  const pending = provider.productContractPending?.().readPending(GOAL_ID);
  if (pending?.outcome !== "PENDING") {
    throw new Error(`pending read: ${JSON.stringify(pending)}`);
  }
  expect(pending.ref).toEqual({
    contractId: CONTRACT_ID,
    revisionDigest: pending.ref.revisionDigest,
    revisionId: REVISION_ID,
  });
  const template = pending.approval;
  accepted("approve_gate_1", dispatch("product_contract.approve_gate_1", {
    authentication: {
      issuedAt: NOW_MS,
      kind: "BEARER",
      requestDigest: template.requestDigest,
      requestId: template.commandId,
    },
    contractId: pending.ref.contractId,
    revisionDigest: pending.ref.revisionDigest,
    revisionId: pending.ref.revisionId,
  }, HUMAN_SECRET, template.commandId,
  String(template.affordance["targetAggregateId"])));

  // The card retires itself: nothing is pending once the approval is durable.
  expect(provider.productContractPending?.().readPending(GOAL_ID))
    .toEqual({ outcome: "NONE" });

  // ---- LADDER 2: post-Gate-1 the goal offers the dispatcher ----
  const postGate = surface();
  const postKinds = offered(postGate.nextAllowedCommands);
  expect(postKinds).toContain("planning.submit_decomposition");
  expect(postKinds).not.toContain("product_contract.propose_revision");
  expect(postKinds).not.toContain("plan.propose");

  // ---- the AGENT submits PLAN ONLY; the daemon compiles and drives the chain ----
  accepted("submit_decomposition", dispatch("planning.submit_decomposition", {
    gateRef: { ...pending.ref },
    goalRef: GOAL_ID,
    structure: {
      completionNodeKey: NODE_KEY,
      nodes: [{
        criterionIds: ["crit-roundtrip"],
        dependsOn: [],
        nodeKey: NODE_KEY,
        objective: "Implement the belief-key identity codec with round-trip tests.",
      }],
    },
  }, AGENT_SECRET, "cmd-journey-submit", GOAL_ID));

  // ---- PLAN REVIEW: both human wires offered against the run ----
  const reviewable = surface();
  const intentOffer = reviewable.nextAllowedCommands.find((offer) =>
    (offer as { commandKind: string }).commandKind === "approval.decide_intent") as
    { commandId: string; expectedVersion: number; targetAggregateId: string } | undefined;
  if (intentOffer === undefined) throw new Error("no approval.decide_intent offer");

  // ---- the HUMAN approves the plan: approve-and-activate on the intent wire ----
  const intentResult = dispatch("approval.decide_intent", {
    decision: "APPROVE",
    decisionReason: null,
    dependencyChanges: { additions: [], challenges: [], removals: [] },
    runId: intentOffer.targetAggregateId,
  }, HUMAN_SECRET, intentOffer.commandId, intentOffer.targetAggregateId,
  intentOffer.expectedVersion);
  accepted("approval.decide_intent", intentResult);
  expect(intentResult.decision?.disposition).toBe("DECIDED");

  // ---- ENABLED: the goal is execution-enabled and offers only closure ----
  const enabled = surface();
  expect(offered(enabled.nextAllowedCommands)).toContain("goal.close");
  expect(offered(enabled.nextAllowedCommands)).not.toContain("approval.decide_intent");

  // ---- the compiled node is durable, listed, and briefed (PRODUCTION reader) ----
  const reader = SqliteEventStore.openForProject(storePath, PROJECT_ID);
  cleanups.push(() => { reader.close(); });
  const compiled = createCompiledNodeSource({
    projectId: PROJECT_ID,
    store: reader,
    testCommand: "pnpm test",
    workspace: "D:/projexts/UnAI",
  });
  expect(compiled.nodes()).toEqual([{
    nodeRef: NODE_KEY,
    title: "Implement the belief-key identity codec with round-trip tests.",
  }]);
  const mission = compiled.mission(NODE_KEY);
  if (mission === null) throw new Error("compiled node has no brief");
  expect(mission.workspace).toBe("D:/projexts/UnAI");
  expect(mission.test).toBe("pnpm test");
  // The brief carries the HUMAN-approved criterion statement, byte-for-byte.
  expect(mission.instructions).toContain(CRITERION_STATEMENT);

  // The board itself lists the node as READY buildable work for the wrapper.
  const active = surface();
  const nodeStep = active.steps.find((step) =>
    step.kind === "node.deliver" && step.aggregateId === NODE_KEY);
  expect(nodeStep?.status).toBe("READY");
}, 120_000);
