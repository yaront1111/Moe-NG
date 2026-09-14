import { createHash, randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { JsonObject, JsonValue } from "@moe/contracts";
import { closeStores, PROJECT_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import { createDaemonCommandPorts, OPERATOR_CAPABILITIES } from "../daemon-command-registry.js";
import { decisionsOf } from "../decision-ledger-memo.js";
import { createAffordancePort } from "../http/affordance-read.js";
import { handleAsyncCommandRequest } from "../http/http-adapter.js";
import { WIRE_PROTOCOL_VERSION } from "../http/http-contract.js";
import { createSessionAuthenticator } from "../identity/session-authenticator.js";
import { createOperatorSessionHandshakePort } from "../identity/session-handshake.js";
import { OPERATOR, reviewWorld } from "../orchestrator/wrapper-review-test-fixtures.js";
import { readReviewLedger } from "./review-read-model.js";
import { verifyStoredPackageItems } from "./review-package-restore.js";
import { implementationGuidanceResult, readReviewGuidanceSource, readReviewImplementationGuidance,
  validImplementationGuidance } from "./review-implementation-guidance.js";
import { commitAccepted } from "./review-ledger.js";
import { reviewContinuationSource } from "./review-continuation.js";
import { REVIEW_SCHEMA_VERSION } from "./review-contracts.js";
import { SESSION_SCHEMA_VERSION } from "../identity/session-contracts.js";
import { runSessionCommand } from "../identity/session-services.js";

const worlds: ReturnType<typeof reviewWorld>[] = [];
async function exhaustedWorld(packageMismatch?: string) {
  const w = reviewWorld(); worlds.push(w);
  for (let round = 1; round <= 3; round += 1) {
    expect((await w.wrapper.runOnce()).spawned).toMatchObject([{ outcome: "SPAWNED" }]);
    const prior = readReviewLedger(w.store, PROJECT_ID, w.nodeRef).rounds.at(-1);
    const restored = prior === undefined ? null : verifyStoredPackageItems(prior);
    const packageItems = round === 3 && packageMismatch !== undefined && restored?.ok
      ? restored.items.map(({ kind, locator, digest }) => ({ kind, locator,
        digest: kind === packageMismatch ? "a".repeat(64) : digest })) : [];
    expect(await w.dispatch(w.requests.at(-1)!, "review.submit", { subjectRef: w.nodeRef,
      round, packageItems, findings: [{ ruleId: "implementation-answer-required",
        detail: "Choose the approved implementation without waiving criteria", severity: "MAJOR",
        subject: { kind: "NODE", locator: w.nodeRef } }] }, round - 1)).toMatchObject({ ok: true });
    await w.finishSeat();
  }
  // Normal polling observes the human blocker and retires its advisory attempt counter.
  expect((await w.wrapper.runOnce()).spawned).toEqual([]);
  const human = createOperatorSessionHandshakePort({ store: w.store, projectId: PROJECT_ID,
    operatorPrincipalId: OPERATOR, capabilities: OPERATOR_CAPABILITIES, clock: Date.now,
    sessionTtlMs: 60_000 }).mint();
  if (!human.ok) throw new Error(human.code);
  let authenticationNow = Date.now();
  const authenticator = createSessionAuthenticator(w.store, { clock: () => authenticationNow,
    operatorCapabilities: OPERATOR_CAPABILITIES, operatorCredential: "private-guidance-operator",
    operatorPrincipalId: OPERATOR, projectId: PROJECT_ID });
  const ports = createDaemonCommandPorts({ store: w.store, projectId: PROJECT_ID,
    operatorPrincipalId: OPERATOR, clock: () => new Date().toISOString() });
  const approve = (extra: JsonObject = {}, expectedVersion = 3, commandId = randomUUID(),
    credential = human.credential) => {
    const payload = { decision: "ALLOW_MORE_ATTEMPTS", escalationRef: w.nodeRef, subjectRef: w.nodeRef, ...extra };
    return handleAsyncCommandRequest({ ...ports, authenticator }, {
      body: new TextEncoder().encode(JSON.stringify({ commandId, commandKind: "escalation.decide",
        correlationId: "guided-review", expectedVersion, payload,
        requestDigest: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
        schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION, sessionCredential: credential,
        targetAggregateId: w.nodeRef })), credential, protocolVersion: WIRE_PROTOCOL_VERSION,
    }, "HTTP_LISTENER");
  };
  return { ...w, approve, human, expireHuman: () => { authenticationNow += 60_001; } };
}
afterEach(async () => {
  for (const w of worlds) await w.finishSeat();
  closeStores();
  for (const w of worlds.splice(0)) {
    if (!resolve(w.workspace).startsWith(join(resolve(tmpdir()), "moe-wrapper-review-"))) throw new Error("foreign cleanup path");
    rmSync(w.workspace, { recursive: true, force: true });
  }
});

it("delivers one paired-human HTTP approval's exact guidance to the next real wrapper seat", async () => {
  const w = await exhaustedWorld();
  const before = readReviewLedger(w.store, PROJECT_ID, w.nodeRef);
  const packageBefore = verifyStoredPackageItems(before.rounds.at(-1)!);
  const app = readFileSync(join(w.workspace, "app.mjs"));
  const guidance = "  Choose server sessions.\nKeep every assigned criterion, including 😀.  ";
  expect(await w.approve({ implementationGuidance: guidance })).toMatchObject({ ok: true });
  const approved = readReviewLedger(w.store, PROJECT_ID, w.nodeRef);
  expect(approved).toMatchObject({ version: 4, accepted: undefined, continuation: { decisionVersion: 4 } });
  expect(approved.rounds).toEqual(before.rounds);
  expect(verifyStoredPackageItems(approved.rounds.at(-1)!)).toEqual(packageBefore);
  expect((await w.wrapper.runOnce()).spawned).toMatchObject([{ outcome: "SPAWNED" }]);
  const request = w.requests.at(-1)!;
  expect(request.mission).toContain("Operator implementation guidance");
  expect(request.mission).toContain(JSON.stringify(guidance));
  expect(request.mission).toContain("not a criterion waiver or verifier proof");
  expect(w.missions.nodeMission(w.nodeRef)?.test).toBe("node check.mjs");
  expect(w.missions.nodeMission("foreign-node")).toBeNull();
  expect(w.runs()).toBe(0);
  expect(readFileSync(join(w.workspace, "app.mjs"))).toEqual(app);
  expect(await w.dispatch(request, "review.submit", { subjectRef: w.nodeRef, round: 5, packageItems: [],
    findings: [{ ruleId: "still-incomplete", detail: "No additional attempt was authorized", severity: "MAJOR",
      subject: { kind: "NODE", locator: w.nodeRef } }] }, 4)).toMatchObject({ ok: true });
  await w.finishSeat();
  expect(readReviewLedger(w.store, PROJECT_ID, w.nodeRef)).toMatchObject({ version: 5, accepted: undefined });
  expect(readReviewLedger(w.store, PROJECT_ID, w.nodeRef).continuation).toBeUndefined();
  expect(w.missions.nodeMission(w.nodeRef)?.instructions).not.toContain(JSON.stringify(guidance));
  expect(readReviewImplementationGuidance(w.store, PROJECT_ID, w.nodeRef)).toEqual({ status: "ABSENT" });
  expect((await w.wrapper.runOnce()).spawned).toEqual([]);
  expect(w.requests).toHaveLength(4);
});

it("rejects malformed guidance and REPLAN guidance before any review effect", async () => {
  const w = await exhaustedWorld();
  const horizon = w.store.readEventHorizon();
  for (const implementationGuidance of [null, 42, "", "  \n", "x".repeat(4_001), "\uD800"]) {
    const result = await w.approve({ implementationGuidance });
    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error("malformed guidance admitted");
    expect(["REVIEW_PAYLOAD_INVALID", "INPUT_INVALID"]).toContain("error" in result ? result.error.code : result.refusal.code);
  }
  expect(await w.approve({ implementationGuidance: "valid text", decision: "REPLAN" }))
    .toMatchObject({ ok: false, refusal: { code: "REVIEW_PAYLOAD_INVALID" } });
  expect(w.store.readEventHorizon()).toBe(horizon);
  expect(readReviewLedger(w.store, PROJECT_ID, w.nodeRef).version).toBe(3);
  expect(readReviewLedger(w.store, PROJECT_ID, w.nodeRef).continuation).toBeUndefined();
});

it("bounds exact Unicode text without trimming or splitting surrogate pairs", () => {
  expect(validImplementationGuidance("😀".repeat(2_000))).toBe(true);
  expect(validImplementationGuidance("😀".repeat(2_000) + "x")).toBe(false);
  expect(validImplementationGuidance("\uDFFF")).toBe(false);
  expect(validImplementationGuidance("文".repeat(4_000))).toBe(true);
});

it("preserves ordinary approval without guidance and rejects a changed same-id retry", async () => {
  const w = await exhaustedWorld();
  const commandId = randomUUID();
  expect(await w.approve({}, 3, commandId)).toMatchObject({ ok: true });
  const latest = readReviewLedger(w.store, PROJECT_ID, w.nodeRef).rounds.at(-1)!;
  const committed = decisionsOf(w.store, 200).find((decision) => decision.key.commandId === commandId)!;
  expect(new TextDecoder().decode(committed.resultBytes)).toBe(JSON.stringify({
    continuationSource: reviewContinuationSource(PROJECT_ID, w.nodeRef, 3, latest),
    decision: "ALLOW_MORE_ATTEMPTS", escalationRef: w.nodeRef, unsuccessfulRounds: 3,
  }));
  expect(readReviewImplementationGuidance(w.store, PROJECT_ID, w.nodeRef)).toEqual({ status: "ABSENT" });
  expect(await w.approve({ implementationGuidance: "different payload" }, 3, commandId))
    .toMatchObject({ ok: false, refusal: { code: "REVIEW_COMMAND_BYTES_CONFLICT" } });
  expect(readReviewLedger(w.store, PROJECT_ID, w.nodeRef)).toMatchObject({ version: 4, continuation: { decisionVersion: 4 } });
});

it("rejects stale review versions, unknown credentials and expired paired humans without approval effects", async () => {
  const w = await exhaustedWorld();
  const payload = { implementationGuidance: "Keep the approved scope" };
  const horizon = w.store.readEventHorizon();
  expect(await w.approve(payload, 2)).toMatchObject({ ok: false, refusal: { code: "REVIEW_EXPECTED_VERSION_STALE" } });
  expect(await w.approve(payload, 3, randomUUID(), "unknown-private-token"))
    .toMatchObject({ ok: false, stage: "AUTHENTICATE", httpStatus: 401 });
  w.expireHuman();
  expect(await w.approve(payload)).toMatchObject({ ok: false, stage: "AUTHENTICATE", httpStatus: 401 });
  expect(w.store.readEventHorizon()).toBe(horizon);
  expect(readReviewLedger(w.store, PROJECT_ID, w.nodeRef).version).toBe(3);
  expect(readReviewLedger(w.store, PROJECT_ID, w.nodeRef).continuation).toBeUndefined();
});

it("does not carry guidance after a human closes this node for successor planning", async () => {
  const w = await exhaustedWorld();
  const text = "This answer belongs only to the approved node's continuation";
  expect(await w.approve({ implementationGuidance: text })).toMatchObject({ ok: true });
  expect(readReviewImplementationGuidance(w.store, PROJECT_ID, w.nodeRef)).toMatchObject({ status: "PRESENT", text });
  expect(await w.approve({ decision: "REPLAN" }, 4)).toMatchObject({ ok: true });
  expect(readReviewImplementationGuidance(w.store, PROJECT_ID, w.nodeRef)).toEqual({ status: "ABSENT" });
  expect(w.missions.nodeMission(w.nodeRef)?.instructions).not.toContain(JSON.stringify(text));
  expect((await w.wrapper.runOnce()).spawned).toEqual([]);
});

it.each(["GRAPH_HASH", "PLAN_HASH", "CRITERION"])("refuses guidance when the actual reviewed %s differs from approved source", async (kind) => {
  const w = await exhaustedWorld(kind);
  const ledger = readReviewLedger(w.store, PROJECT_ID, w.nodeRef);
  expect(verifyStoredPackageItems(ledger.rounds.at(-1)!)).toMatchObject({ ok: true });
  expect(readReviewGuidanceSource(w.store, PROJECT_ID, w.nodeRef, ledger.rounds.at(-1))).toBeNull();
  const horizon = w.store.readEventHorizon();
  expect(await w.approve({ implementationGuidance: "Must not bind another reviewed source" }))
    .toMatchObject({ ok: false, refusal: { code: "REVIEW_LINEAGE_UNREADABLE" } });
  expect(w.store.readEventHorizon()).toBe(horizon);
  const surface = createAffordancePort({ store: w.store, projectId: PROJECT_ID,
    principalId: OPERATOR, nodes: w.compiled.nodes, mintId: () => randomUUID() }).readSurface();
  if (surface.outcome !== "SURFACE") throw new Error(surface.code);
  expect(surface.nextAllowedCommands.find((offer) => offer.commandKind === "escalation.decide")?.inputSchemaVersion)
    .toBe(REVIEW_SCHEMA_VERSION);
  // Existing explicit package approvals remain usable when no optional guidance was requested.
  expect(await w.approve()).toMatchObject({ ok: true });
});

it.each(["text", "source", "version"])("refuses to spawn from durable present guidance with corrupt %s", async (field) => {
  const w = await exhaustedWorld();
  const ledger = readReviewLedger(w.store, PROJECT_ID, w.nodeRef);
  const latest = ledger.rounds.at(-1)!;
  const source = readReviewGuidanceSource(w.store, PROJECT_ID, w.nodeRef, latest)!;
  const guidance = { ...implementationGuidanceResult("Valid operator answer", source),
    [field]: field === "text" ? null : field === "source" ? { ...source, graphContentHash: "a".repeat(64) } : "foreign/1" };
  // Deliberately malformed semantic evidence with valid store digests: no production writer
  // can make these bytes, so the fixture must stage them through the trusted store seam.
  expect(commitAccepted(w.store, { commandId: randomUUID(), correlationId: "corrupt-guidance-fixture",
    decidedAt: new Date().toISOString(), expectedVersion: 3, kind: "escalation.decide",
    payload: { decision: "ALLOW_MORE_ATTEMPTS", escalationRef: w.nodeRef, subjectRef: w.nodeRef },
    principalId: w.human.principalId, projectId: PROJECT_ID, schemaVersion: REVIEW_SCHEMA_VERSION }, {
    aggregateId: w.nodeRef, eventPayload: { decision: "ALLOW_MORE_ATTEMPTS" }, eventType: "ReviewEscalated",
    expectedVersion: 3, result: { decision: "ALLOW_MORE_ATTEMPTS", escalationRef: w.nodeRef,
      unsuccessfulRounds: 3, continuationSource: reviewContinuationSource(PROJECT_ID, w.nodeRef, 3, latest),
      implementationGuidance: guidance } as unknown as JsonValue,
  })).toMatchObject({ ok: true });
  expect(readReviewLedger(w.store, PROJECT_ID, w.nodeRef).continuation).toBeDefined();
  expect(readReviewImplementationGuidance(w.store, PROJECT_ID, w.nodeRef)).toEqual({ status: "INVALID" });
  expect(w.missions.nodeMission(w.nodeRef)).toBeNull();
  const horizon = w.store.readEventHorizon();
  expect((await w.wrapper.runOnce()).spawned).toMatchObject([{ outcome: "NODE_BRIEF_MISSING" }]);
  expect(w.requests).toHaveLength(3);
  expect(w.store.readEventHorizon()).toBe(horizon);
});

it("refuses a real agent session with every operator capability at the human HTTP boundary", async () => {
  const w = await exhaustedWorld();
  const credential = "private-agent-guidance-fixture";
  expect(runSessionCommand(w.store, new TextEncoder().encode(JSON.stringify({ commandId: randomUUID(),
    correlationId: "agent-guidance-test", decidedAt: new Date().toISOString(), expectedVersion: 0,
    kind: "session.open", payload: { capabilities: OPERATOR_CAPABILITIES,
      credentialSha256: createHash("sha256").update(credential).digest("hex"),
      expiresAt: new Date(Date.now() + 60_000).toISOString(), sessionId: "agent-guidance-never-paired" },
    principalId: OPERATOR, projectId: PROJECT_ID, schemaVersion: SESSION_SCHEMA_VERSION,
  })))).toMatchObject({ ok: true });
  const horizon = w.store.readEventHorizon();
  expect(await w.approve({ implementationGuidance: "Agent cannot supply human answers" }, 3, randomUUID(), credential))
    .toMatchObject({ ok: false, refusal: { code: "OPERATOR_PRINCIPAL_REQUIRED", layer: "DAEMON_AUTHORIZATION" } });
  expect(w.store.readEventHorizon()).toBe(horizon);
  expect(readReviewLedger(w.store, PROJECT_ID, w.nodeRef).continuation).toBeUndefined();
});

it("advertises guidance only for an exhausted node whose compiled source matches its reviewed package", async () => {
  const w = await exhaustedWorld();
  const surface = createAffordancePort({ store: w.store, projectId: PROJECT_ID,
    principalId: OPERATOR, nodes: w.compiled.nodes, mintId: () => randomUUID() }).readSurface();
  expect(surface).toMatchObject({ outcome: "SURFACE" });
  if (surface.outcome !== "SURFACE") throw new Error(surface.code);
  expect(surface.nextAllowedCommands.filter((offer) => offer.commandKind === "escalation.decide"))
    .toMatchObject([{ targetAggregateId: w.nodeRef, expectedVersion: 3,
      inputSchemaVersion: "moe-review-escalation-guidance/1" }]);
});
