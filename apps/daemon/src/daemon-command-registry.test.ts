import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { RuntimeCommandKind } from "@moe/contracts";
import { DurableStoreError, IdempotencyConflictError, SqliteEventStore } from "@moe/store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OPERATOR_CAPABILITIES, createDaemonCommandPorts } from "./daemon-command-registry.js";
import { PROJECT_ID as BOOTSTRAP_PROJECT_ID, driveThrough } from "./bootstrap/bootstrap-test-fixtures.js";
import { foundationSyncHandler } from "./daemon-foundation-command.js";
import { createFoundationCaptureLifecycle } from "./work/foundation-capture-lifecycle.js";
import { FOUNDATION_DISPATCH_COMMAND_KIND as FOUNDATION_DISPATCH_KIND } from "./work/foundation-attempt-contracts.js";
import { agentCapabilitiesFor, createStoreDependencies } from "./daemon-store-dependencies.js";
import { handleAsyncCommandRequest, handleCommandRequest } from "./http/http-adapter.js";
import { WIRE_PROTOCOL_VERSION } from "./http/http-contract.js";
import { readSessionLedger } from "./identity/session-read-model.js";
import { installTestRecoveryBinding } from "./identity/session-test-fixtures.js";
import { createGoalCatalogReadPort } from "./http/goal-catalog-read.js";

/**
 * Characterization of the registry the daemon actually serves. Every row was
 * MEASURED through `handleCommandRequest(createStoreDependencies(...).provide())`
 * and is transcribed here by hand: nothing is read back out of the production
 * maps, so a mapping that moves reddens a named case instead of regenerating the
 * expectation. `agent` is the ordered array `agentCapabilitiesFor` returns for
 * the kind, also transcribed rather than recomputed from `capability`.
 */
interface Row {
  readonly agent: readonly string[] | null;
  /** Served only on the asynchronous entry: its service returns a promise. */
  readonly asyncOnly?: true;
  readonly capability: string;
  readonly code: string;
  readonly kind: RuntimeCommandKind;
  readonly layer: string;
  readonly payloadKeys: readonly string[];
}

const ADMIN = "project.admin";
const GOAL = "goal.write";
const PLANNING = "planning.write";
const REVIEW = "review.write";
const WORK = "work.write";
const PREREQUISITE = "BOOTSTRAP_PREREQUISITE_MISSING";
const INGRESS = "DAEMON_INGRESS";
const PREREQ_LAYER = "DAEMON_PREREQUISITE";
const STEP_LAYER = "DAEMON_STEP_LIFECYCLE";
const PREPARATION_LAYER = "SUPERSESSION_PREPARATION";

const ROWS: readonly Row[] = [
  { agent: [PLANNING, WORK], capability: PLANNING, code: PREREQUISITE, kind: "approval.decide",
    layer: PREREQ_LAYER,
    payloadKeys: ["activation", "command", "graphRevisionRef", "record", "runId"] },
  // An empty payload carries none of the six sections, so the envelope decode —
  // the only stage above the recovery embargo — is what answers.
  { agent: [WORK], capability: WORK, code: "ACTIVATION_INGRESS_REQUEST_MALFORMED",
    kind: "effect.activate", layer: INGRESS,
    payloadKeys: ["activation", "effect", "lease", "liveClaims", "slot"] },
  { agent: [REVIEW, WORK], capability: REVIEW, code: "REVIEW_PAYLOAD_INVALID",
    kind: "escalation.decide", layer: INGRESS, payloadKeys: ["escalationRef", "subjectRef"] },
  { agent: null, capability: WORK, code: "EVENT_STREAM_RESUME_INPUT_INVALID",
    kind: "events.resume", layer: "DAEMON_EVENT_STREAM_RESUME",
    payloadKeys: ["presentedCursor", "projection", "subscriberId"] },
  // An empty payload carries no base64 blob, so the seam materializes no bytes and the
  // attempt codec's OWN refusal answers — the transport mints no code of its own.
  { agent: [WORK], asyncOnly: true, capability: WORK,
    code: "FOUNDATION_ATTEMPT_REQUEST_MALFORMED", kind: "foundation.dispatch",
    layer: "DAEMON_FOUNDATION_ATTEMPT",
    // NARROWED: the graph snapshot and the input manifest are derived server-side, so
    // a payload carrying either key is refused at the seam rather than admitted.
    payloadKeys: ["activationRequestBytesBase64", "binding", "launchTemplate"] },
  // An empty payload carries none of the five identities, so the verification service's
  // OWN request authority answers — the seam mints no code of its own here either.
  { agent: [WORK], asyncOnly: true, capability: WORK,
    code: "FOUNDATION_VERIFICATION_REQUEST_MALFORMED", kind: "foundation.verification",
    layer: "DAEMON_VERIFICATION_REQUEST",
    payloadKeys: [
      "attemptAggregateId", "candidateRoot", "expectedRecordDigest", "recipeAggregateId",
      "verificationId",
    ] },
  // An empty payload names no activation and no resource, so this ingress's own request
  // shape answers before the resource authority is ever called.
  { agent: [WORK], capability: WORK, code: "RESOURCE_RECONCILE_REQUEST_MALFORMED",
    kind: "resource.reconcile", layer: "DAEMON_RESOURCE_RECONCILE",
    payloadKeys: ["activationAggregateId", "disposition", "epoch", "kind", "resourceId"] },
  // OPERATOR-ONLY, so the empty-payload probe below only reaches this ingress's own
  // request shape because `send` authenticates as the CONFIGURED OPERATOR. A scoped
  // ADMIN session is refused one stage earlier, at OPERATOR_PRINCIPAL_REQUIRED.
  { agent: [ADMIN, WORK], capability: ADMIN, code: "RESOURCE_CONFIRM_RELEASED_REQUEST_MALFORMED",
    kind: "resource.confirm_released", layer: "DAEMON_RESOURCE_CONFIRM_RELEASED",
    payloadKeys: ["activationAggregateId", "proofRef"] },
  { agent: [GOAL, WORK], capability: GOAL, code: PREREQUISITE, kind: "goal.close",
    layer: PREREQ_LAYER, payloadKeys: ["closureWitness", "goalId", "zeroAuthorityWitness"] },
  { agent: [GOAL, WORK], capability: GOAL, code: PREREQUISITE, kind: "goal.create",
    layer: PREREQ_LAYER,
    payloadKeys: ["instructions", "title"] },
  // THE FIVE GRAPH MUTATION KINDS (task-931f99e8). Each empty-payload code below is the code of
  // the DURABLE SERVICE that answered, carried out unrestamped: the two approval-bearing kinds
  // are refused by the ingress that reads their approval members, and the other three by their
  // own service's exact-request codec.
  { agent: [PLANNING, WORK], capability: PLANNING, code: "BOOTSTRAP_PAYLOAD_INVALID",
    kind: "graph.approve", layer: INGRESS,
    payloadKeys: ["activation", "command", "graphRevisionRef", "record", "runId"] },
  { agent: [PLANNING, WORK], capability: PLANNING,
    code: "SUPERSESSION_PREPARATION_REQUEST_INVALID", kind: "graph.prepare_supersession",
    layer: PREPARATION_LAYER, payloadKeys: ["approvedTargetRevisionRef", "goalRef"] },
  { agent: [PLANNING, WORK], capability: PLANNING, code: "SUPERSESSION_RELEASE_REQUEST_INVALID",
    kind: "graph.release_preparation", layer: PREPARATION_LAYER,
    payloadKeys: ["expectedPreparationVersion", "generation", "goalRef"] },
  // The release authority reader is task-738a12a8's deliberate fail-closed default in
  // production, but the PAYLOAD codec answers first, so this row still measures the request.
  { agent: [PLANNING, WORK], capability: PLANNING, code: "EXPANSION_REQUEST_PAYLOAD_MALFORMED",
    kind: "graph.request_expansion", layer: "REQUEST",
    payloadKeys: ["goalRef", "parentNodeRef", "parentRunRef", "rationale"] },
  { agent: [PLANNING, WORK], capability: PLANNING, code: "BOOTSTRAP_PAYLOAD_INVALID",
    kind: "graph.supersede", layer: INGRESS,
    payloadKeys: [
      "command", "expectedPredecessorRevisionRef", "expectedPreparationVersion", "generation",
      "goalRef", "record", "successorGraphContentHash", "successorRevisionRef",
    ] },
  { agent: [REVIEW, WORK], capability: REVIEW, code: "REVIEW_PAYLOAD_INVALID",
    kind: "integration.accept_output", layer: INGRESS,
    payloadKeys: ["receiptId", "subjectRef"] },
  // An empty payload carries none of the three keys, so the journal writer's own
  // envelope decode answers before any binding, node or entry judgement runs.
  { agent: [WORK], capability: WORK, code: "JOURNAL_REQUEST_MALFORMED", kind: "journal.append",
    layer: "DAEMON_JOURNAL_APPEND",
    payloadKeys: ["attemptAggregateId", "effectId", "entries"] },
  { agent: [PLANNING, WORK], capability: PLANNING, code: PREREQUISITE, kind: "plan.propose",
    layer: PREREQ_LAYER, payloadKeys: ["commands", "runId"] },
  { agent: [ADMIN, WORK], capability: ADMIN, code: "BOOTSTRAP_PAYLOAD_INVALID",
    kind: "policy.install", layer: INGRESS, payloadKeys: ["slice"] },
  { agent: [ADMIN, WORK], capability: ADMIN, code: PREREQUISITE, kind: "policy.validate",
    layer: PREREQ_LAYER, payloadKeys: ["input"] },
  { agent: [ADMIN, WORK], capability: ADMIN, code: PREREQUISITE, kind: "project.activate",
    layer: PREREQ_LAYER, payloadKeys: ["witness"] },
  { agent: [ADMIN, WORK], capability: ADMIN, code: PREREQUISITE, kind: "project.bind_repository",
    layer: PREREQ_LAYER, payloadKeys: ["observation"] },
  { agent: [ADMIN, WORK], capability: ADMIN, code: "BOOTSTRAP_PAYLOAD_INVALID",
    kind: "project.register", layer: INGRESS, payloadKeys: ["owner"] },
  { agent: [ADMIN, WORK], capability: ADMIN, code: PREREQUISITE, kind: "provider.probe",
    layer: PREREQ_LAYER, payloadKeys: ["observation"] },
  // ADMIN is the reach fence only: an empty payload never reaches the R3
  // approval gate, which is what actually makes this command human-only.
  { agent: [ADMIN, WORK], capability: ADMIN, code: "RECOVERY_COMPLETION_REQUEST_MALFORMED",
    kind: "recovery.complete", layer: INGRESS,
    payloadKeys: ["approval", "authentication", "command", "reconciliationDigest"] },
  { agent: [REVIEW, WORK], capability: REVIEW, code: "REVIEW_PAYLOAD_INVALID",
    kind: "qualification.replan", layer: INGRESS,
    payloadKeys: ["nodes", "subjectRef", "successorPlanRef", "supportedCanonicalizerVersions"] },
  { agent: [REVIEW, WORK], capability: REVIEW, code: "REVIEW_PAYLOAD_INVALID",
    kind: "review.submit", layer: INGRESS,
    payloadKeys: ["findings", "packageItems", "round", "subjectRef"] },
  { agent: [ADMIN, WORK], capability: ADMIN, code: "SESSION_PAYLOAD_INVALID",
    kind: "session.close", layer: INGRESS, payloadKeys: ["sessionId"] },
  { agent: [ADMIN, WORK], capability: ADMIN, code: "SESSION_PAYLOAD_INVALID",
    kind: "session.open", layer: INGRESS,
    payloadKeys: ["capabilities", "credentialSha256", "expiresAt", "sessionId"] },
  { agent: [ADMIN, WORK], capability: ADMIN, code: "SESSION_PAYLOAD_INVALID",
    kind: "session.renew", layer: INGRESS, payloadKeys: ["expiresAt", "sessionId"] },
  // An empty payload carries none of the three keys, so the step writer's own envelope
  // decode answers before any binding, roster or checkpoint judgement runs.
  { agent: [WORK], capability: WORK, code: "STEP_REQUEST_MALFORMED", kind: "step.checkpoint",
    layer: STEP_LAYER,
    payloadKeys: ["attemptAggregateId", "effectId", "nextSafeActionRef"] },
  { agent: [WORK], capability: WORK, code: "STEP_REQUEST_MALFORMED", kind: "step.finish",
    layer: STEP_LAYER, payloadKeys: ["attemptAggregateId", "effectId", "stepRef"] },
  { agent: [WORK], capability: WORK, code: "STEP_REQUEST_MALFORMED", kind: "step.start",
    layer: STEP_LAYER, payloadKeys: ["attemptAggregateId", "effectId", "label"] },
  { agent: [WORK], capability: WORK, code: "WORK_CLAIM_PAYLOAD_INVALID", kind: "work.claim",
    layer: INGRESS, payloadKeys: ["expiresAt", "workItemId"] },
  { agent: [WORK], capability: WORK, code: "WORK_CLAIM_PAYLOAD_INVALID", kind: "work.release",
    layer: INGRESS, payloadKeys: ["workItemId"] },
  { agent: [WORK], capability: WORK, code: "WORK_CLAIM_PAYLOAD_INVALID", kind: "work.renew",
    layer: INGRESS, payloadKeys: ["expiresAt", "workItemId"] },
  // An empty payload carries neither ref, so the assembled request has six keys
  // where the continuation gate demands exactly eight — CONTINUATION answers.
  { agent: [WORK], capability: WORK, code: "CONTINUATION_REQUEST_SHAPE_INVALID",
    kind: "work.resume", layer: "CONTINUATION",
    payloadKeys: ["attemptRef", "successorRef"] },
];

/**
 * The order the registry is BUILT in, transcribed by hand from the `PAYLOAD_KEYS`
 * literal rather than sorted: `buildCommandRegistry` fills a Map, so `keys()` is
 * that literal's key order. `ROWS` above is alphabetical, so a move that reordered
 * the table would agree with it. This one does not.
 */
const REGISTRATION_ORDER: readonly RuntimeCommandKind[] = [
  "approval.decide", "events.resume", "work.resume", "effect.activate", "recovery.complete", "journal.append",
  "foundation.dispatch", "foundation.verification", "resource.reconcile",
  "resource.confirm_released",
  "step.start", "step.finish", "step.checkpoint",
  "escalation.decide", "goal.close", "goal.create",
  "graph.approve", "graph.prepare_supersession", "graph.release_preparation",
  "graph.request_expansion", "graph.supersede",
  "integration.accept_output",
  "plan.propose", "policy.install", "policy.validate", "project.activate",
  "project.bind_repository", "project.register", "provider.probe", "qualification.replan",
  "review.submit", "session.close", "session.open", "session.renew",
  "work.claim", "work.release", "work.renew",
];

/**
 * The kinds the registry gates behind the configured operator principal, transcribed
 * by hand. The sweep below asserts this set BOTH ways over every wired kind: a kind
 * added here reddens on the twenty that must reach their own family, and a kind
 * dropped reddens on the four that must not.
 */
const OPERATOR_ONLY: readonly RuntimeCommandKind[] = [
  "approval.decide", "goal.close",
  // The two graph kinds that MOVE authority: one makes a graph the running one, the other
  // replaces the running one. Both are the human approve action on their own edge.
  "graph.approve", "graph.supersede",
  "integration.accept_output",
  "resource.confirm_released", "session.open",
];

const CREDENTIAL = "registry-operator-credential";
const PROJECT = "proj-command-registry";
const DECIDED_AT = "2026-08-09T12:00:00.000Z";
const CLOCK = (): string => DECIDED_AT;

const directory = mkdtempSync(join(tmpdir(), "moe-command-registry-"));
const storePath = join(directory, "store.db");

const setupStore = SqliteEventStore.openForProject(storePath, PROJECT);
installTestRecoveryBinding(setupStore);
setupStore.close();

const provider = createStoreDependencies({
  clock: CLOCK,
  credential: CREDENTIAL,
  principalId: "operator-local",
  projectId: PROJECT,
  storePath,
});
const deps = provider.provide();
const stream = provider.subscriptions?.();

afterAll(() => {
  provider.close();
  rmSync(directory, { force: true, recursive: true });
});

function send(
  commandId: string,
  commandKind: RuntimeCommandKind,
  payload: Readonly<Record<string, unknown>>,
  credential: string = CREDENTIAL,
  expectedVersion = 0,
): ReturnType<typeof handleCommandRequest> {
  return handleCommandRequest(deps, {
    body: new TextEncoder().encode(JSON.stringify({
      commandId, commandKind, correlationId: "corr-registry", expectedVersion, payload,
      requestDigest: "a".repeat(64), schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: credential, targetAggregateId: "agg-registry",
    })),
    credential,
    protocolVersion: WIRE_PROTOCOL_VERSION,
  });
}

/** The same request, on the asynchronous entry: an async-only kind has no answer on the
 *  synchronous one, and every other kind is served identically by both. */
async function sendAsync(
  commandId: string,
  commandKind: RuntimeCommandKind,
  payload: Readonly<Record<string, unknown>>,
  credential: string = CREDENTIAL,
): Promise<Awaited<ReturnType<typeof handleAsyncCommandRequest>>> {
  return await handleAsyncCommandRequest(deps, {
    body: new TextEncoder().encode(JSON.stringify({
      commandId, commandKind, correlationId: "corr-registry", expectedVersion: 0, payload,
      requestDigest: "a".repeat(64), schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: credential, targetAggregateId: "agg-registry",
    })),
    credential,
    protocolVersion: WIRE_PROTOCOL_VERSION,
  });
}

function openSession(
  commandId: string, sessionId: string, secret: string, capabilities: readonly string[],
): string {
  const opened = send(commandId, "session.open", {
    capabilities,
    credentialSha256: createHash("sha256").update(secret, "utf8").digest("hex"),
    expiresAt: "2027-01-01T00:00:00.000Z",
    sessionId,
  });
  expect(opened).toMatchObject({ decision: { disposition: "DECIDED" }, outcome: "ACCEPTED" });
  return secret;
}

describe("registered command table", () => {
  it("serves exactly the thirty-seven characterized kinds and nothing else", () => {
    // Pins the swept case count: an it.each over an empty or shortened table
    // would otherwise pass while asserting nothing.
    expect(ROWS).toHaveLength(37);
    expect(deps.registry.size).toBe(37);
    expect([...deps.registry.keys()].sort()).toEqual(ROWS.map((row) => row.kind).sort());
  });

  it("keeps the registration order the payload table declares", () => {
    // The sorted-set assertion above cannot see a reordered table, and a move that
    // reshuffles the literal is exactly the silent edit a mechanical split makes.
    expect(REGISTRATION_ORDER).toHaveLength(37);
    expect([...deps.registry.keys()]).toEqual(REGISTRATION_ORDER);
  });

  it.each(ROWS)("$kind keeps its capability and ordered payload allow-list", (row) => {
    const entry = deps.registry.get(row.kind);
    expect(entry).toBeDefined();
    expect(entry?.requiredCapability).toBe(row.capability);
    expect(entry?.payloadKeys).toEqual(row.payloadKeys);
    // The entry the seam reads is frozen and self-describing: a table moved through
    // a spread can lose either property without changing any mapping value.
    expect(entry?.kind).toBe(row.kind);
    expect(Object.isFrozen(entry)).toBe(true);
  });

  it.each(ROWS)("$kind refuses a smuggled key before it can reach dispatch", (row) => {
    expect(send(`cmd-smuggled-${row.kind}`, row.kind, { smuggled: true })).toMatchObject({
      error: { code: "INPUT_INVALID" },
      httpStatus: 400,
      ok: false,
      outcome: "REFUSED",
      stage: "PAYLOAD_SHAPE",
    });
  });

  it.each(ROWS)("$kind reaches its own family handler and refuses with its code", async (row) => {
    const answered = row.asyncOnly === true
      ? await sendAsync(`cmd-empty-${row.kind}`, row.kind, {})
      : send(`cmd-empty-${row.kind}`, row.kind, {});
    expect(answered).toMatchObject({
      httpStatus: 422,
      ok: false,
      outcome: "PORT_REFUSED",
      refusal: { code: row.code, layer: row.layer },
      stage: "DISPATCH",
    });
  });

  it.each(ROWS)("$kind exposes its agent capability list through the old module", (row) => {
    const capabilities = agentCapabilitiesFor(row.kind);
    expect(capabilities).toEqual(row.agent);
    if (capabilities !== null) expect(Object.isFrozen(capabilities)).toBe(true);
  });

  it("answers node.deliver and refuses an unknown kind", () => {
    const delivered = agentCapabilitiesFor("node.deliver");
    expect(delivered).toEqual([REVIEW, WORK]);
    expect(Object.isFrozen(delivered)).toBe(true);
    expect(agentCapabilitiesFor("cutover.preview")).toBeNull();
    expect(agentCapabilitiesFor("")).toBeNull();
  });

  it("keeps the operator capability set frozen and ordered", () => {
    expect(OPERATOR_CAPABILITIES).toEqual([ADMIN, GOAL, PLANNING, REVIEW, WORK]);
    expect(Object.isFrozen(OPERATOR_CAPABILITIES)).toBe(true);
  });
});

describe("authorization ordering under a real session", () => {
  it("lets the capability holder reach payload shape and denies the one without it", () => {
    const allowed = openSession("cmd-sess-allow", "sess-allow", "secret-allow", [REVIEW, WORK]);
    expect(send("cmd-review-allowed", "review.submit", { smuggled: true }, allowed)).toMatchObject({
      error: { code: "INPUT_INVALID" }, httpStatus: 400, stage: "PAYLOAD_SHAPE",
    });

    const denied = openSession("cmd-sess-deny", "sess-deny", "secret-deny", [WORK]);
    expect(send("cmd-review-denied", "review.submit", { smuggled: true }, denied)).toMatchObject({
      error: { code: "CAPABILITY_DENIED" }, httpStatus: 403, ok: false,
      outcome: "REFUSED", stage: "AUTHORIZE",
    });

    // Neither refusal may leave a durable decision behind: replaying the same
    // command ids as the operator must reach DISPATCH afresh rather than return
    // a stored decision.
    expect(send("cmd-review-allowed", "review.submit", {})).toMatchObject({
      outcome: "PORT_REFUSED", refusal: { code: "REVIEW_PAYLOAD_INVALID" }, stage: "DISPATCH",
    });
    expect(send("cmd-review-denied", "review.submit", {})).toMatchObject({
      outcome: "PORT_REFUSED", refusal: { code: "REVIEW_PAYLOAD_INVALID" }, stage: "DISPATCH",
    });
  });

  it.each([
    { capabilities: [PLANNING, WORK], kind: "approval.decide" },
    { capabilities: [GOAL, WORK], kind: "goal.close" },
    { capabilities: [REVIEW, WORK], kind: "integration.accept_output" },
  ] as const)("keeps $kind behind the operator principal even when a session has its capability", ({
    capabilities,
    kind,
  }) => {
    const suffix = kind.replaceAll(".", "-");
    const credential = openSession(
      `cmd-open-operator-only-${suffix}`,
      `sess-operator-only-${suffix}`,
      `secret-operator-only-${suffix}`,
      capabilities,
    );
    const reader = SqliteEventStore.openForProject(storePath, PROJECT);
    const before = reader.readCommandDecisionsAfter(0n, 1_000).items.length;

    const refused = send(`cmd-forbidden-${suffix}`, kind, {}, credential);

    expect(refused).toMatchObject({
      httpStatus: 403,
      ok: false,
      outcome: "PORT_REFUSED",
      refusal: {
        code: "OPERATOR_PRINCIPAL_REQUIRED",
        layer: "DAEMON_AUTHORIZATION",
      },
      stage: "DISPATCH",
    });
    expect(reader.readCommandDecisionsAfter(0n, 1_000).items).toHaveLength(before);
    reader.close();
  });

  it("keeps session.open behind the operator principal even for an admin session", () => {
    const attacker = openSession(
      "cmd-open-admin-attacker",
      "sess-admin-attacker",
      "secret-admin-attacker",
      [ADMIN, WORK],
    );
    const descendantSecret = "secret-admin-descendant";
    const descendantSessionId = "sess-admin-descendant";
    const reader = SqliteEventStore.openForProject(storePath, PROJECT);
    try {
      const before = reader.readCommandDecisionsAfter(0n, 1_000).items.length;

      const refused = send("cmd-forbidden-session-open", "session.open", {
        capabilities: [...OPERATOR_CAPABILITIES],
        credentialSha256: createHash("sha256")
          .update(descendantSecret, "utf8")
          .digest("hex"),
        expiresAt: "2027-01-01T00:00:00.000Z",
        sessionId: descendantSessionId,
      }, attacker);

      expect(refused).toMatchObject({
        httpStatus: 403,
        ok: false,
        outcome: "PORT_REFUSED",
        refusal: {
          code: "OPERATOR_PRINCIPAL_REQUIRED",
          layer: "DAEMON_AUTHORIZATION",
        },
        stage: "DISPATCH",
      });
      expect(reader.readCommandDecisionsAfter(0n, 1_000).items).toHaveLength(before);
      expect(readSessionLedger(reader, PROJECT).sessions.has(descendantSessionId)).toBe(false);
    } finally {
      reader.close();
    }
  });

  describe("operator-principal gate membership", () => {
    // One session holding every capability, so AUTHORIZE never answers first and
    // the operator gate is the only thing that can refuse with 403. Without the
    // negative half, a kind silently ADDED to the gate set would pass unnoticed:
    // nothing else in this file asserts that a kind reaches its own family.
    let sessionCredential = "";

    beforeAll(() => {
      sessionCredential = openSession(
        "cmd-open-gate-sweep", "sess-gate-sweep", "secret-gate-sweep",
        [ADMIN, GOAL, PLANNING, REVIEW, WORK],
      );
    });

    it("gates exactly the seven transcribed kinds and no others", () => {
      expect(OPERATOR_ONLY).toHaveLength(7);
      expect(ROWS.filter((row) => OPERATOR_ONLY.includes(row.kind))).toHaveLength(7);
    });

    it.each(ROWS)("$kind answers the non-operator session from its own layer", async (row) => {
      const gated = OPERATOR_ONLY.includes(row.kind);
      const answered = row.asyncOnly === true
        ? await sendAsync(`cmd-gate-sweep-${row.kind}`, row.kind, {}, sessionCredential)
        : send(`cmd-gate-sweep-${row.kind}`, row.kind, {}, sessionCredential);
      expect(answered).toMatchObject({
        httpStatus: gated ? 403 : 422,
        outcome: "PORT_REFUSED",
        refusal: gated
          ? { code: "OPERATOR_PRINCIPAL_REQUIRED", layer: "DAEMON_AUTHORIZATION" }
          : { code: row.code, layer: row.layer },
        stage: "DISPATCH",
      });
    });
  });
});

describe("server-injected request fields", () => {
  it("commits with the daemon's own project, clock and kind, never the caller's", () => {
    const seated = stream?.readPage({ projection: "moe.board", subscriberId: "control-room-1" });
    expect(seated).toMatchObject({ outcome: "PAGE" });
    if (seated?.outcome !== "PAGE" || seated.nextCursor === null) {
      throw new Error("expected an acknowledgeable initial page");
    }
    expect(stream?.acknowledge({
      cursor: seated.nextCursor,
      subscriberId: "control-room-1",
    })).toMatchObject({ outcome: "ACKNOWLEDGED" });

    expect(send("cmd-register-1", "project.register", { owner: "operator-local" })).toMatchObject({
      decision: { commandId: "cmd-register-1", disposition: "DECIDED",
        resultCode: "EFFECTS_COMMITTED" },
      httpStatus: 200,
      ok: true,
      outcome: "ACCEPTED",
    });

    // Exactly one registration event, carrying the daemon's project as the
    // aggregate and the injected clock as the commit time. Other suites in this
    // file open sessions, so the registration rows are selected by type rather
    // than by draining the cursor - and "exactly one" also rules out a second
    // effect behind the replay below.
    const page = stream?.readPage({ projection: "moe.board", subscriberId: "control-room-1" });
    if (page?.outcome !== "PAGE") throw new Error("expected a page after the commit");
    expect(page.events
      .filter((event) => event.eventType === "ProjectRegistered")
      .map((event) => ({
        aggregateId: event.aggregateId, committedAt: event.committedAt, eventType: event.eventType,
      }))).toEqual([
      { aggregateId: PROJECT, committedAt: DECIDED_AT, eventType: "ProjectRegistered" },
    ]);
  });

  it("carries the caller's expected version into the durable decision", () => {
    expect(send("cmd-register-stale", "project.register", { owner: "operator-local" },
      CREDENTIAL, 5)).toMatchObject({
      httpStatus: 422,
      outcome: "PORT_REFUSED",
      refusal: { code: "EXPECTED_VERSION_CONFLICT", layer: "CORE_REDUCER" },
      stage: "DISPATCH",
    });
  });

  it("replays the identical command and replays again on a fresh store handle", () => {
    expect(send("cmd-register-1", "project.register", { owner: "operator-local" })).toMatchObject({
      decision: { disposition: "REPLAYED", resultCode: "EFFECTS_COMMITTED" },
      ok: true,
      outcome: "ACCEPTED",
    });

    const reopened = createStoreDependencies({
      clock: CLOCK, credential: CREDENTIAL, principalId: "operator-local",
      projectId: PROJECT, storePath,
    });
    try {
      const replayed = handleCommandRequest(reopened.provide(), {
        body: new TextEncoder().encode(JSON.stringify({
          commandId: "cmd-register-1", commandKind: "project.register",
          correlationId: "corr-registry", expectedVersion: 0,
          payload: { owner: "operator-local" }, requestDigest: "a".repeat(64),
          schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION, sessionCredential: CREDENTIAL,
          targetAggregateId: "agg-registry",
        })),
        credential: CREDENTIAL,
        protocolVersion: WIRE_PROTOCOL_VERSION,
      });
      expect(replayed).toMatchObject({
        decision: { disposition: "REPLAYED", resultCode: "EFFECTS_COMMITTED" },
        outcome: "ACCEPTED",
      });
    } finally {
      reopened.close();
    }
  });
});

/**
 * ROSTER B - THE FORMER AUTHORITY KEYS, ON THE REAL COMMAND SEAM (task-9d86234a, DoD 4).
 *
 * DIVERGENCE: every case carries a VALID brief plus exactly ONE extra key, so the brief contract
 * inside the handler cannot be the mechanism that answers - the structural allow-list at
 * PAYLOAD_SHAPE is, and it answers before dispatch. Roster A (malformed briefs carrying no extra
 * key) lives in `goals/goal-services.test.ts` for the mirror-image reason. Re-admit any key
 * below to `PAYLOAD_KEYS["goal.create"]` and its case reds while roster A stays green.
 *
 * This describe replaced an arm that asserted GOAL_CREATE_TARGET_MISMATCH, a registry fence that
 * compared payload `goalId` against the daemon-issued target. The payload cannot name a goalId
 * any more, so that fence was unreachable and was deleted with it.
 */
const GOAL_CREATE_HOSTILE_EXTRAS: readonly (readonly [string, unknown])[] = Object.freeze([
  ["goalId", "goal-browser-chosen"],
  ["planningRunRef", "run-browser-chosen"],
  ["budgetAccountRef", "budget-account-browser-chosen"],
  ["witness", { projectReadyRef: "ready-browser", truthClass: "HUMAN_APPROVED" }],
  ["projectId", "project-other"],
  ["principalId", "operator-elsewhere"],
  ["decidedAt", "2026-08-26T00:00:00.000Z"],
  ["brief", { instructions: "already normalized", title: "already normalized" }],
] as const);

describe("goal.create admits prose and nothing else", () => {
  const goalDirectory = mkdtempSync(join(tmpdir(), "moe-goal-brief-seam-"));
  const goalStorePath = join(goalDirectory, "store.db");
  const credential = "goal-brief-operator";
  let goalProvider: ReturnType<typeof createStoreDependencies>;

  beforeAll(() => {
    const seeded = SqliteEventStore.openForProject(goalStorePath, BOOTSTRAP_PROJECT_ID);
    installTestRecoveryBinding(seeded);
    driveThrough(seeded, "goal.create");
    seeded.close();
    goalProvider = createStoreDependencies({
      clock: CLOCK,
      credential,
      principalId: "operator-local",
      projectId: BOOTSTRAP_PROJECT_ID,
      storePath: goalStorePath,
    });
  });

  afterAll(() => {
    goalProvider.close();
    rmSync(goalDirectory, { force: true, recursive: true });
  });

  const sendGoal = (
    commandId: string, payload: Readonly<Record<string, unknown>>,
  ): ReturnType<typeof handleCommandRequest> => handleCommandRequest(goalProvider.provide(), {
    body: new TextEncoder().encode(JSON.stringify({
      commandId,
      commandKind: "goal.create",
      correlationId: `corr-${commandId}`,
      expectedVersion: 0,
      payload,
      requestDigest: "b".repeat(64),
      schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: credential,
      targetAggregateId: `goal-${commandId}`,
    })),
    credential,
    protocolVersion: WIRE_PROTOCOL_VERSION,
  });

  const brief = (): Record<string, unknown> => ({
    instructions: "Carry J1 from an activated project to an accepted goal.",
    title: "Seam goal",
  });

  it("carries a nonzero roster of hostile extras, each of them unique", () => {
    expect(GOAL_CREATE_HOSTILE_EXTRAS).toHaveLength(8);
    expect(new Set(GOAL_CREATE_HOSTILE_EXTRAS.map(([key]) => key)).size)
      .toBe(GOAL_CREATE_HOSTILE_EXTRAS.length);
    // The four keys the command used to carry are all in the roster, by name.
    expect(GOAL_CREATE_HOSTILE_EXTRAS.map(([key]) => key))
      .toEqual(expect.arrayContaining([
        "budgetAccountRef", "goalId", "planningRunRef", "witness",
      ]));
  });

  it.each(GOAL_CREATE_HOSTILE_EXTRAS)(
    "refuses a brief carrying %s INPUT_INVALID at PAYLOAD_SHAPE, committing nothing",
    (key, value) => {
      const commandId = `cmd-goal-extra-${key}`;
      expect(sendGoal(commandId, { ...brief(), [key]: value })).toMatchObject({
        error: { code: "INPUT_INVALID" },
        httpStatus: 400,
        ok: false,
        outcome: "REFUSED",
        stage: "PAYLOAD_SHAPE",
      });

      // Read the store back: refused at PAYLOAD_SHAPE means no handler ran, so neither the
      // goal the extra key named nor the goal this command would have minted may exist.
      const reader = SqliteEventStore.openForProject(goalStorePath, BOOTSTRAP_PROJECT_ID);
      try {
        expect(reader.readEvents(`goal-${commandId}`)).toHaveLength(0);
        expect(reader.readEvents("goal-browser-chosen")).toHaveLength(0);
        const catalog = createGoalCatalogReadPort({
          projectId: BOOTSTRAP_PROJECT_ID, store: reader,
        }).readGoals();
        expect(catalog.outcome).toBe("GOALS");
        expect("goals" in catalog ? catalog.goals.map((goal) => goal.goalId) : ["UNREADABLE"])
          .not.toEqual(expect.arrayContaining([`goal-${commandId}`, "goal-browser-chosen"]));
      } finally {
        reader.close();
      }
    },
  );

  it("accepts the prose-only payload and mints the goal from the command identity", () => {
    expect(sendGoal("cmd-goal-prose-only", brief())).toMatchObject({
      decision: { disposition: "DECIDED", resultCode: "EFFECTS_COMMITTED" },
      outcome: "ACCEPTED",
    });

    const reader = SqliteEventStore.openForProject(goalStorePath, BOOTSTRAP_PROJECT_ID);
    try {
      expect(reader.readEvents("goal-cmd-goal-prose-only")).toHaveLength(1);
      expect(createGoalCatalogReadPort({
        projectId: BOOTSTRAP_PROJECT_ID, store: reader,
      }).readGoals()).toEqual({
        goals: [{
          goalId: "goal-cmd-goal-prose-only", planningRunRef: "run-cmd-goal-prose-only",
        }],
        outcome: "GOALS",
      });
    } finally {
      reader.close();
    }
  });
});

describe("createDaemonCommandPorts", () => {
  const key = { commandId: "cmd-port", principalId: "operator-local", projectId: PROJECT };
  const portDirectory = mkdtempSync(join(tmpdir(), "moe-command-ports-"));
  let portStore: SqliteEventStore;
  let ports: ReturnType<typeof createDaemonCommandPorts>;

  // Its own store handle and directory: a handle opened at collection time and
  // held over the other suites would keep the shared file locked on Windows.
  beforeAll(() => {
    portStore = SqliteEventStore.openForProject(join(portDirectory, "store.db"), PROJECT);
    ports = createDaemonCommandPorts({ clock: CLOCK, operatorPrincipalId: "operator-local", projectId: PROJECT, store: portStore });
  });

  afterAll(() => {
    portStore.close();
    rmSync(portDirectory, { force: true, recursive: true });
  });

  it("returns a frozen pair carrying the whole registry", () => {
    expect(Object.isFrozen(ports)).toBe(true);
    expect(ports.registry.size).toBe(37);
    expect(ports.registry.get("project.register")).toMatchObject({
      kind: "project.register", payloadKeys: ["owner"], requiredCapability: ADMIN,
    });
  });

  /**
   * The workspace lifecycle is an OPTION, and an absent one must not silently
   * remove a command kind — an unconfigured workspace authority refuses
   * PREPARATION at dispatch time, which is a different thing from a registry
   * that never offered the kind. Both rosters are compared whole, in order.
   */
  it("keeps the roster and its order identical with and without a supplied lifecycle", () => {
    const supplied = createDaemonCommandPorts({
      clock: CLOCK,
      foundationLifecycle: createFoundationCaptureLifecycle({
        catalogSource: (): unknown => undefined, store: portStore,
      }),
      operatorPrincipalId: "operator-local", projectId: PROJECT, store: portStore,
    });

    expect([...supplied.registry.keys()]).toEqual([...ports.registry.keys()]);
    expect(supplied.registry.size).toBe(37);
    for (const roster of [ports.registry, supplied.registry]) {
      const entry = roster.get(FOUNDATION_DISPATCH_KIND);
      expect(entry?.asyncHandler).toBeDefined();
      expect(entry?.handler).toBe(foundationSyncHandler);
    }
  });

  it("refuses an operator id that collides with the reserved verifier service", () => {
    expect(() => createDaemonCommandPorts({
      clock: CLOCK,
      operatorPrincipalId: "daemon:node-verifier",
      projectId: PROJECT,
      store: portStore,
    })).toThrow("OPERATOR_PRINCIPAL_RESERVED");
  });

  it("passes a committed decision through unchanged", () => {
    const decision = {
      commandId: key.commandId, disposition: "DECIDED" as const,
      effectId: "effect-1", resultCode: "EFFECTS_COMMITTED",
    };
    const result = ports.decisions.decide(key, "a".repeat(64), () => decision);
    expect(result).toEqual({ decision, outcome: "DECIDED" });
  });

  it("translates an idempotency conflict to 409 under the durable store layer", () => {
    expect(ports.decisions.decide(key, "a".repeat(64), () => {
      throw new IdempotencyConflictError(key);
    })).toEqual({
      outcome: "REFUSED",
      refusal: {
        code: "IDEMPOTENCY_CONFLICT",
        detail: "same command identity with different request bytes",
        httpStatus: 409,
        layer: "DURABLE_STORE",
      },
    });
  });

  it("translates any other durable store failure to 503 with its own code", () => {
    expect(ports.decisions.decide(key, "a".repeat(64), () => {
      throw new DurableStoreError("STORE_BUSY", "database is locked");
    })).toEqual({
      outcome: "REFUSED",
      refusal: {
        code: "STORE_BUSY",
        detail: "STORE_BUSY: database is locked",
        httpStatus: 503,
        layer: "DURABLE_STORE",
      },
    });
  });

  it("rethrows an error it cannot classify instead of inventing a refusal", () => {
    expect(() => ports.decisions.decide(key, "a".repeat(64), () => {
      throw new TypeError("unexpected");
    })).toThrowError("unexpected");
  });
});
