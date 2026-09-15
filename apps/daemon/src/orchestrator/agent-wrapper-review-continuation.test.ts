import { createHash, randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { ReviewContinuationApproval } from "@moe/review";
import { closeStores, PROJECT_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import { createDaemonCommandPorts, OPERATOR_CAPABILITIES } from "../daemon-command-registry.js";
import { createAffordancePort } from "../http/affordance-read.js";
import { handleAsyncCommandRequest } from "../http/http-adapter.js";
import { WIRE_PROTOCOL_VERSION } from "../http/http-contract.js";
import { createSessionAuthenticator } from "../identity/session-authenticator.js";
import { createOperatorSessionHandshakePort } from "../identity/session-handshake.js";
import { readReviewLedger } from "../review/review-read-model.js";
import { readWorkClaimLedger } from "../work/work-claim-services.js";
import { OPERATOR, reviewWorld } from "./wrapper-review-test-fixtures.js";
import { createAgentWrapper } from "./agent-wrapper.js";
import { staffingSurfaceOf } from "./agent-staffing-surface.js";

const worlds: ReturnType<typeof reviewWorld>[] = [];
async function approvedBetweenPolls() {
  const w = reviewWorld(); worlds.push(w);
  for (let round = 1; round <= 3; round += 1) {
    expect((await w.wrapper.runOnce()).spawned).toMatchObject([{ outcome: "SPAWNED" }]);
    // Each attempt changes the workspace: an exhausted cap, not a stall (review-stall.ts).
    writeFileSync(join(w.workspace, `attempt-${String(round)}.txt`), `attempt ${String(round)}`);
    expect(await w.dispatch(w.requests.at(-1)!, "review.submit", { subjectRef: w.nodeRef,
      round, packageItems: [], findings: [{ ruleId: "missing-implementation", detail: "Keep the assigned checks",
        severity: "MAJOR", subject: { kind: "NODE", locator: w.nodeRef } }] }, round - 1)).toMatchObject({ ok: true });
    await w.finishSeat();
  }
  // Deliberately NO wrapper poll observes the brief BLOCKED interval before human approval.
  const human = createOperatorSessionHandshakePort({ store: w.store, projectId: PROJECT_ID,
    operatorPrincipalId: OPERATOR, capabilities: OPERATOR_CAPABILITIES, clock: Date.now,
    sessionTtlMs: 60_000 }).mint();
  if (!human.ok) throw new Error(human.code);
  const authenticator = createSessionAuthenticator(w.store, { clock: Date.now,
    operatorCapabilities: OPERATOR_CAPABILITIES, operatorCredential: "private-fast-approval-operator",
    operatorPrincipalId: OPERATOR, projectId: PROJECT_ID });
  const ports = createDaemonCommandPorts({ store: w.store, projectId: PROJECT_ID,
    operatorPrincipalId: OPERATOR, clock: () => new Date().toISOString() });
  const payload = { decision: "ALLOW_MORE_ATTEMPTS", escalationRef: w.nodeRef, subjectRef: w.nodeRef,
    implementationGuidance: "Implement every assigned criterion; retain the required test." };
  expect(await handleAsyncCommandRequest({ ...ports, authenticator }, {
    body: new TextEncoder().encode(JSON.stringify({ commandId: randomUUID(), commandKind: "escalation.decide",
      correlationId: "fast-guided-review", expectedVersion: 3, payload,
      requestDigest: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
      schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION, sessionCredential: human.credential,
      targetAggregateId: w.nodeRef })), credential: human.credential, protocolVersion: WIRE_PROTOCOL_VERSION,
  }, "HTTP_LISTENER")).toMatchObject({ ok: true });
  return w;
}
afterEach(async () => {
  for (const w of worlds) await w.finishSeat();
  closeStores();
  for (const w of worlds.splice(0)) {
    if (!resolve(w.workspace).startsWith(join(resolve(tmpdir()), "moe-wrapper-review-"))) throw new Error("foreign cleanup path");
    rmSync(w.workspace, { recursive: true, force: true });
  }
});

it("observes a new durable human grant even when the wrapper missed its BLOCKED interval", async () => {
  const w = await approvedBetweenPolls();
  const approved = readReviewLedger(w.store, PROJECT_ID, w.nodeRef);
  expect(approved.continuation?.decisionVersion).toBe(4);
  expect((await w.wrapper.runOnce()).spawned).toMatchObject([{ outcome: "SPAWNED" }]);
  expect(w.requests).toHaveLength(4);
  expect(w.requests.at(-1)?.mission).toContain("Operator implementation guidance");
  expect(readReviewLedger(w.store, PROJECT_ID, w.nodeRef).continuation).toEqual(approved.continuation);
  expect(await w.dispatch(w.requests.at(-1)!, "review.submit", { subjectRef: w.nodeRef, round: 5,
    packageItems: [], findings: [{ ruleId: "still-missing", detail: "Approval is consumed by this review",
      severity: "MAJOR", subject: { kind: "NODE", locator: w.nodeRef } }] }, 4)).toMatchObject({ ok: true });
  await w.finishSeat();
  expect(readReviewLedger(w.store, PROJECT_ID, w.nodeRef).continuation).toBeUndefined();
  expect((await w.wrapper.runOnce()).spawned).toEqual([]);
  expect(w.requests).toHaveLength(4);
});

it("does not repeatedly reset attempts for one unconsumed grant or claim churn", async () => {
  const w = await approvedBetweenPolls();
  const grant = readReviewLedger(w.store, PROJECT_ID, w.nodeRef).continuation;
  const workItemId = `node.deliver@${w.nodeRef}`;
  const priorClaim = readWorkClaimLedger(w.store, PROJECT_ID).claims.get(workItemId)?.version ?? 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    expect((await w.wrapper.runOnce()).spawned).toMatchObject([{ outcome: "SPAWNED" }]);
    await w.finishSeat(); // The worker produced no review effect; the same grant is still open.
  }
  expect(readWorkClaimLedger(w.store, PROJECT_ID).claims.get(workItemId)!.version).toBeGreaterThan(priorClaim);
  expect(readReviewLedger(w.store, PROJECT_ID, w.nodeRef).continuation).toEqual(grant);
  expect((await w.wrapper.runOnce()).spawned).toMatchObject([{ outcome: "STAFFING_ATTEMPTS_EXHAUSTED" }]);
  expect(w.requests).toHaveLength(6);
});

async function exhaustedControlledWrapper(withPort: boolean) {
  const w = await approvedBetweenPolls();
  const original = w.missions.reviewContinuation(w.nodeRef)!;
  let candidate: unknown = original;
  let version = original.decisionVersion;
  let throwRead = false;
  let spawned = 0;
  const credential = "private-counter-operator";
  const authenticator = createSessionAuthenticator(w.store, { clock: Date.now,
    operatorCapabilities: OPERATOR_CAPABILITIES, operatorCredential: credential,
    operatorPrincipalId: OPERATOR, projectId: PROJECT_ID });
  const ports = createDaemonCommandPorts({ store: w.store, projectId: PROJECT_ID,
    operatorPrincipalId: OPERATOR, clock: () => new Date().toISOString() });
  const raw = staffingSurfaceOf(createAffordancePort({ store: w.store, projectId: PROJECT_ID,
    principalId: OPERATOR, nodes: w.compiled.nodes, mintId: () => randomUUID() }));
  const wrapper = createAgentWrapper({ deps: { ...ports, authenticator }, projectId: PROJECT_ID,
    affordances: { boundProjectId: PROJECT_ID, readSurface: () => {
      const surface = raw.readSurface();
      return surface.outcome !== "SURFACE" ? surface : { ...surface,
        steps: surface.steps.map((step) => step.aggregateId === w.nodeRef ? { ...step, version } : step) };
    } }, claimTtlMs: 60_000, clock: Date.now, maxAgents: 1, maxItemAttempts: 1,
    mintSecret: () => randomUUID().replaceAll("-", ""), operatorCredential: credential,
    nodeMission: w.missions.nodeMission,
    ...(withPort ? { reviewContinuation: () => {
      if (throwRead) throw new Error("private unknown review read");
      return candidate as ReviewContinuationApproval | null;
    } } : {}),
    spawnAgent: async () => { spawned += 1; return { ok: true, pid: 919192, exit: Promise.resolve() }; },
  });
  expect((await wrapper.runOnce()).spawned).toMatchObject([{ outcome: "SPAWNED" }]);
  await wrapper.settle();
  return { w, wrapper, original, spawned: () => spawned, set: (value: unknown, currentVersion: number, throws = false) => {
    candidate = value; version = currentVersion; throwRead = throws;
  } };
}

it("refuses resets for unknown, malformed, foreign, inconsistent, same-version and backward grant observations", async () => {
  const h = await exhaustedControlledWrapper(true);
  const original = h.original;
  const newerIdentity = { decisionId: "different-decision", decisionResultSha256: "b".repeat(64) };
  const candidates = [
    { name: "absent", value: null, version: 4 },
    { name: "plain READY version noise", value: null, version: 900 },
    { name: "unknown read", value: original, version: 4, throws: true },
    { name: "malformed", value: { ...original, decisionResultSha256: "unproved" }, version: 4 },
    { name: "foreign project", value: { ...original, projectId: "foreign-project" }, version: 4 },
    { name: "foreign node", value: { ...original, subjectRef: "foreign-node" }, version: 4 },
    { name: "stale against surface", value: original, version: 5 },
    { name: "inconsistent source version", value: { ...original, sourceAggregateVersion: 4 }, version: 4 },
    { name: "same version, different identity", value: { ...original, ...newerIdentity }, version: 4 },
    { name: "same decision id", value: { ...original, decisionVersion: 5, decisionResultSha256: "b".repeat(64) }, version: 5 },
    { name: "same result digest", value: { ...original, decisionVersion: 5, decisionId: "different" }, version: 5 },
    { name: "backward grant", value: { ...original, ...newerIdentity, decisionVersion: 3, sourceAggregateVersion: 2 }, version: 3 },
    { name: "replayed original", value: original, version: 4 },
  ];
  const horizon = h.w.store.readEventHorizon();
  for (const item of candidates) {
    h.set(item.value, item.version, item.throws);
    expect((await h.wrapper.runOnce()).spawned, item.name).toMatchObject([{ outcome: "STAFFING_ATTEMPTS_EXHAUSTED" }]);
    expect(h.spawned(), item.name).toBe(1);
    expect(h.w.store.readEventHorizon(), item.name).toBe(horizon);
  }
  expect(h.w.missions.reviewContinuation("foreign-node")).toBeNull();
});

it("preserves the existing attempt cap without a continuation reader despite version noise", async () => {
  const h = await exhaustedControlledWrapper(false);
  h.set(h.original, 999);
  expect((await h.wrapper.runOnce()).spawned).toMatchObject([{ outcome: "STAFFING_ATTEMPTS_EXHAUSTED" }]);
  expect(h.spawned()).toBe(1);
});

it("wires the production wrapper to the durable reader without placing the grant in mission text", () => {
  const source = readFileSync(new URL("./agent-wrapper-main.ts", import.meta.url), "utf8");
  const check = (text: string) => {
    expect(text).toMatch(/const \{ nodeMission, listNodes, reviewContinuation \} = createReviewAwareNodeMissions\(\{/u);
    const construction = text.slice(text.indexOf("= createReviewAwareNodeMissions({"), text.indexOf("// Opened BEFORE the wrapper"));
    expect(construction).toContain("projectId: config.projectId");
    expect(construction).toContain("store: () => verifierStore");
    const wrapper = text.slice(text.indexOf("wrapper = createAgentWrapper({"));
    expect(wrapper).toMatch(/^\s+reviewContinuation,\r?$/mu);
  };
  check(source);
  const unwired = source.replace("      reviewContinuation,", "      reviewContinuation: undefined,");
  expect(unwired).not.toBe(source);
  expect(() => check(unwired)).toThrow();
});
