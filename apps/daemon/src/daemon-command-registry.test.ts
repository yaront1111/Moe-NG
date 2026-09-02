import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { RuntimeCommandEnvelope, RuntimeCommandKind } from "@moe/contracts";
import { admitProductContractRevisionRef, productContractGate1Authority } from "@moe/core";
import type { HttpDispatchPort } from "@moe/mcp";
import { DurableStoreError, IdempotencyConflictError, SqliteEventStore } from "@moe/store";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { OPERATOR_CAPABILITIES, createDaemonCommandPorts } from "./daemon-command-registry.js";
import type { DaemonCommandPortOptions } from "./daemon-command-registry.js";
import { createMcpDispatchPort } from "./mcp-dispatch-port.js";
import { CUTOVER_ACTIVATE_COMMAND_KIND } from "./cutover/cutover-activate-contracts.js";
import { commandFamilyFacts } from "./daemon-command-families.js";
import { PAYLOAD_KEYS, type WiredCommandKind } from "./daemon-command-vocabulary.js";
import { humanReviewWitness } from "./bootstrap/bootstrap-ledger.js";
import { COMMAND_PREREQUISITES } from "./bootstrap/bootstrap-sequence.js";
import {
  PROJECT_ID as BOOTSTRAP_PROJECT_ID,
  decisionCount,
  driveThrough,
} from "./bootstrap/bootstrap-test-fixtures.js";
import { foundationSyncHandler } from "./daemon-foundation-command.js";
import {
  DOCUMENT_INGEST_MEDIA_TYPES,
  MAX_DOCUMENT_INGEST_TEXT_UTF8_BYTES,
} from "./documents/document-source-contract.js";
import { readDocumentSourceView } from "./documents/document-source-read.js";
import { createFoundationCaptureLifecycle } from "./work/foundation-capture-lifecycle.js";
import { FOUNDATION_DISPATCH_COMMAND_KIND as FOUNDATION_DISPATCH_KIND } from "./work/foundation-attempt-contracts.js";
import { agentCapabilitiesFor, createStoreDependencies } from "./daemon-store-dependencies.js";
import {
  handleAsyncCommandRequest, handleCommandRequest, readCommandTransportOrigin,
} from "./http/http-adapter.js";
import { TRANSPORT_ORIGINS, WIRE_PROTOCOL_VERSION, buildCommandRegistry }
  from "./http/http-contract.js";
import type {
  CommandAdapterDeps, CommandHandlerInput, HttpCommandRequest, TransportOrigin,
} from "./http/http-contract.js";
import { readSessionLedger } from "./identity/session-read-model.js";
import { createSessionAuthority } from "./identity/session-authority.js";
import { installTestRecoveryBinding } from "./identity/session-test-fixtures.js";
import { createGoalCatalogReadPort } from "./http/goal-catalog-read.js";
import { startControlRoomListener } from "./http/http-listener.js";
import type { ControlRoomListener } from "./http/http-listener.js";
import {
  PRODUCT_CONTRACT_GATE_1_CODES, PRODUCT_CONTRACT_GATE_1_COMMAND_KIND,
  PRODUCT_CONTRACT_GATE_1_SCHEMA_VERSION, productContractGate1SubjectDigest,
} from "./product-contract/product-contract-gate-1-contract.js";
import { runProductContractGate1Command }
  from "./product-contract/product-contract-gate-1-command.js";
import type { ProductContractGate1Authority }
  from "./product-contract/product-contract-gate-1-command.js";

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
  // task-6646f888. Its own edge assembles the request, so the EXACT-SHAPE fence answers an empty
  // payload before any prerequisite is read -- a different code and layer from approval.decide
  // above, which reaches the bootstrap prerequisite. Same capability, because it is the same
  // authority on a different wire.
  { agent: [PLANNING, WORK], capability: PLANNING, code: "APPROVAL_INTENT_SHAPE_INVALID",
    kind: "approval.decide_intent", layer: "DAEMON_APPROVAL_INTENT",
    payloadKeys: ["decision", "decisionReason", "dependencyChanges", "runId"] },
  // task-b8272ee0. The SHIPPED daemon supplies no cutover evidence root, so the composition
  // root's own fail-closed branch answers here — registered and refusing, never removed from
  // the roster. The arm that proves the kind REACHES `activateCutover` builds ports WITH the
  // root and pins the admission's GA_ACTIVATION_BINDING refusal; both halves are needed,
  // because this row alone cannot tell "served" from "advertised".
  { agent: null, capability: ADMIN, code: "CUTOVER_ACTIVATE_UNCONFIGURED",
    kind: "cutover.activate", layer: "DAEMON_COMPOSITION", payloadKeys: ["record"] },
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
    // NARROWED TO TWO: the graph snapshot, the input manifest AND the launch template are
    // all derived server-side, so a payload carrying any of those keys is refused at the
    // seam rather than admitted. Only which activation and which attempt still cross.
    payloadKeys: ["activationRequestBytesBase64", "binding"] },
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
  { agent: [GOAL, WORK], capability: GOAL, code: PREREQUISITE,
    kind: "goal.create_with_source", layer: PREREQ_LAYER,
    payloadKeys: ["instructions", "source", "title"] },
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
  // The compile DISPATCHER's own request codec answers an empty payload -- the Gate 1
  // resolve, the digest compare and the run-version gates all sit below the shape fence.
  { agent: [PLANNING, WORK], capability: PLANNING, code: "SUBMIT_DECOMPOSITION_MALFORMED",
    kind: "planning.submit_decomposition", layer: "COMPILE_DISPATCHER",
    payloadKeys: ["gateRef", "goalRef", "structure"] },
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
  // The clarification lifecycle's OWN payload fence answers an empty payload.
  // HUMAN wire -- `agent` is null and the kind rides OPERATOR_PRINCIPAL_KINDS
  // (with the paired-HUMAN widening), so the empty-payload probe reaches this
  // refusal only because `send` authenticates as the CONFIGURED OPERATOR.
  { agent: null, capability: PLANNING, code: "PRODUCT_CONTRACT_CLARIFICATION_MALFORMED",
    kind: "product_contract.answer_clarification", layer: "PRODUCT_CONTRACT_CLARIFICATION",
    payloadKeys: ["answerProjectionDigest", "clarificationId", "contractId"] },
  // task-7997ba7c. ADMIN is the reach fence only: an empty payload carries no
  // presentation and no revision triple, so this writer's own envelope decode
  // answers long before the human authority gate that makes it human-only.
  { agent: [ADMIN, WORK], capability: ADMIN, code: "PRODUCT_CONTRACT_GATE_1_REQUEST_MALFORMED",
    kind: "product_contract.approve_gate_1", layer: "DAEMON_PRODUCT_CONTRACT_GATE_1",
    payloadKeys: ["authentication", "contractId", "revisionDigest", "revisionId"] },
  // Same lifecycle fence as answer_clarification above, but an AGENT wire:
  // asking a material question is a planning act, so the kind is staffable and
  // rides no operator fence.
  { agent: [PLANNING, WORK], capability: PLANNING,
    code: "PRODUCT_CONTRACT_CLARIFICATION_MALFORMED",
    kind: "product_contract.ask_clarification", layer: "PRODUCT_CONTRACT_CLARIFICATION",
    payloadKeys: ["contractId", "options", "question"] },
  // The Product Contract WRITER's own request codec answers an empty payload -- lineage,
  // provenance and the durable commit all sit below the shape fence.
  { agent: [PLANNING, WORK], capability: PLANNING, code: "PRODUCT_CONTRACT_PROPOSE_MALFORMED",
    kind: "product_contract.propose_revision", layer: "PRODUCT_CONTRACT_PROPOSE",
    payloadKeys: ["draft", "goalRef"] },
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
  "approval.decide", "approval.decide_intent",
  "planning.submit_decomposition", "product_contract.answer_clarification",
  "product_contract.ask_clarification", "product_contract.propose_revision",
  "events.resume", "work.resume", "effect.activate", "recovery.complete",
  "product_contract.approve_gate_1", "journal.append",
  "foundation.dispatch", "foundation.verification", "resource.reconcile",
  "resource.confirm_released",
  "step.start", "step.finish", "step.checkpoint", "cutover.activate",
  "escalation.decide", "goal.close", "goal.create", "goal.create_with_source",
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
  // BOTH approval wires. The intent seam derives the activation witness and the record the
  // caller-shaped wire used to accept, so gating one and not the other would leave the derived
  // wire reachable by a non-operator principal -- handing back exactly the authority it removes.
  "approval.decide", "approval.decide_intent", "goal.close",
  // The operator ANSWERS a material product question; an agent transport presenting
  // that answer would be quiet invention with a human label (see the vocabulary set).
  "product_contract.answer_clarification",
  // The two graph kinds that MOVE authority: one makes a graph the running one, the other
  // replaces the running one. Both are the human approve action on their own edge.
  "graph.approve", "graph.supersede",
  "integration.accept_output",
  "resource.confirm_released", "session.open",
  // The one-way GA activation: ADMIN fences reach, this set fences the human act itself.
  "cutover.activate",
];

const CREDENTIAL = "registry-operator-credential";
const PROJECT = "proj-command-registry";
const DECIDED_AT = "2026-08-09T12:00:00.000Z";
const CLOCK = (): string => DECIDED_AT;

const directory = mkdtempSync(join(tmpdir(), "moe-command-registry-"));
const storePath = join(directory, "store.db");

const setupStore = SqliteEventStore.openForProject(storePath, PROJECT);
installTestRecoveryBinding(setupStore);
const setupSessions = createSessionAuthority(setupStore, {
  clock: () => Date.parse(DECIDED_AT), projectId: PROJECT,
});
const setupPrincipal = setupSessions.createPrincipal({
  commandId: "cmd-transport-origin-principal",
  correlationId: "corr-transport-origin-principal",
  kind: "HUMAN",
  principalId: "operator-local",
  profileRevisionId: "profile-transport-origin",
});
if (!setupPrincipal.ok) throw new Error(`transport principal refused: ${setupPrincipal.code}`);
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
  }, "HTTP_LISTENER");
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
  }, "MCP_STDIO");
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

function transportRequest(
  commandId: string,
  payload: Readonly<Record<string, unknown>> = { title: "ship it" },
): HttpCommandRequest {
  return {
    body: new TextEncoder().encode(JSON.stringify({
      commandId, commandKind: "goal.create", correlationId: "corr-transport-origin",
      expectedVersion: 0, payload, requestDigest: "a".repeat(64),
      schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION, sessionCredential: CREDENTIAL,
      targetAggregateId: "agg-transport-origin",
    })),
    credential: CREDENTIAL,
    protocolVersion: WIRE_PROTOCOL_VERSION,
  };
}

function transportCaptureDeps(
  captured: CommandHandlerInput[],
  payloadKeys: readonly string[] = ["title"],
): CommandAdapterDeps {
  return {
    authenticator: deps.authenticator,
    decisions: deps.decisions,
    registry: buildCommandRegistry([{
      handler: (input) => {
        captured.push(input);
        return {
          commandId: input.envelope.commandId,
          disposition: "DECIDED",
          effectId: `effect-${input.envelope.commandId}`,
          resultCode: "EFFECTS_COMMITTED",
        };
      },
      kind: "goal.create",
      payloadKeys,
      requiredCapability: GOAL,
    }]),
  };
}

function gate1Payload(commandId: string): Readonly<Record<string, unknown>> {
  const triple = Object.freeze({
    contractId: "contract-transport-origin",
    revisionDigest: "ab".repeat(32),
    revisionId: `revision-${commandId}`,
  });
  const admitted = admitProductContractRevisionRef(triple);
  if (!admitted.ok) throw new Error(`transport triple refused: ${admitted.code}`);
  const gate = productContractGate1Authority(admitted.ref);
  return Object.freeze({
    authentication: Object.freeze({
      issuedAt: Date.parse(DECIDED_AT),
      kind: "BEARER",
      requestDigest: productContractGate1SubjectDigest({
        commandId, projectId: PROJECT, workRef: gate.workRef,
      }),
      requestId: commandId,
    }),
    ...triple,
  });
}

function gate1HttpRequest(
  commandId: string,
  payload: Readonly<Record<string, unknown>> = gate1Payload(commandId),
): HttpCommandRequest {
  return {
    body: new TextEncoder().encode(JSON.stringify({
      commandId, commandKind: PRODUCT_CONTRACT_GATE_1_COMMAND_KIND,
      correlationId: "corr-gate1-transport", expectedVersion: 0, payload,
      requestDigest: "a".repeat(64), schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: CREDENTIAL, targetAggregateId: "agg-gate1-transport",
    })),
    credential: CREDENTIAL,
    protocolVersion: WIRE_PROTOCOL_VERSION,
  };
}

function directGate1Request(commandId: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    commandId,
    correlationId: "corr-gate1-origin-direct",
    decidedAt: DECIDED_AT,
    expectedVersion: 0,
    kind: PRODUCT_CONTRACT_GATE_1_COMMAND_KIND,
    payload: gate1Payload(commandId),
    principalId: "operator-local",
    projectId: PROJECT,
    schemaVersion: PRODUCT_CONTRACT_GATE_1_SCHEMA_VERSION,
  }));
}

async function postTransportHeader(
  listener: ControlRoomListener,
  body: Uint8Array,
): Promise<{ readonly body: unknown; readonly status: number }> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest({
      headers: {
        "content-length": body.byteLength,
        "content-type": "application/json",
        host: `127.0.0.1:${listener.port}`,
        origin: listener.origin,
        transportOrigin: "MCP_STDIO",
        "x-moe-csrf": "csrf-transport-origin",
        "x-moe-protocol-version": WIRE_PROTOCOL_VERSION,
        "x-moe-session-credential": CREDENTIAL,
      },
      host: "127.0.0.1",
      method: "POST",
      path: "/command",
      port: listener.port,
      setHost: false,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ body: text === "" ? null : JSON.parse(text) as unknown,
          status: response.statusCode ?? 0 });
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}

describe("server-authored command transport origin carrier", () => {
  it("declares one frozen exact origin roster", () => {
    expect(TRANSPORT_ORIGINS).toEqual([
      "HTTP_LISTENER", "MCP_STDIO", "MCP_HTTP", "AGENT_WRAPPER", "NODE_VERIFIER",
    ]);
    expect(TRANSPORT_ORIGINS.length).toBeGreaterThan(0);
    expect(new Set(TRANSPORT_ORIGINS).size).toBe(TRANSPORT_ORIGINS.length);
    expect(Object.isFrozen(TRANSPORT_ORIGINS)).toBe(true);
  });

  it("threads immutable hidden stamps through both entry shapes", async () => {
    const captured: CommandHandlerInput[] = [];
    const wired = transportCaptureDeps(captured);
    const sync = handleCommandRequest(
      wired, transportRequest("cmd-transport-sync"), "HTTP_LISTENER",
    );
    const asyncResult = await handleAsyncCommandRequest(
      wired, transportRequest("cmd-transport-async"), "MCP_STDIO",
    );

    expect(sync).toMatchObject({ outcome: "ACCEPTED" });
    expect(asyncResult).toMatchObject({ outcome: "ACCEPTED" });
    expect(captured.map(readCommandTransportOrigin)).toEqual(["HTTP_LISTENER", "MCP_STDIO"]);
    expect(captured).toHaveLength(2);
    for (const input of captured) {
      expect(Object.keys(input)).toEqual(["envelope", "principal"]);
      const symbols = Object.getOwnPropertySymbols(input);
      expect(symbols).toHaveLength(1);
      expect(Object.getOwnPropertyDescriptor(input, symbols[0] as symbol)).toMatchObject({
        configurable: false, enumerable: false, writable: false,
      });
      expect(Object.isFrozen(input)).toBe(true);
    }
  });

  it("keeps unstamped non-gate commands byte-identical on both legacy entries", async () => {
    const syncInputs: CommandHandlerInput[] = [];
    const asyncInputs: CommandHandlerInput[] = [];
    const request = transportRequest("cmd-transport-legacy");
    const sync = handleCommandRequest(transportCaptureDeps(syncInputs), request);
    const asyncResult = await handleAsyncCommandRequest(
      transportCaptureDeps(asyncInputs), request,
    );

    expect(asyncResult).toEqual(sync);
    expect(syncInputs).toHaveLength(1);
    expect(asyncInputs).toHaveLength(1);
    expect([...syncInputs, ...asyncInputs].map(readCommandTransportOrigin))
      .toEqual([undefined, undefined]);
    expect([...syncInputs, ...asyncInputs].map(Object.getOwnPropertySymbols))
      .toEqual([[], []]);
  });

  it("never derives an omitted stamp from a handler-admitted payload field", () => {
    const captured: CommandHandlerInput[] = [];
    const result = handleCommandRequest(
      transportCaptureDeps(captured, ["title", "transportOrigin"]),
      transportRequest("cmd-transport-wire-only", {
        title: "ship it", transportOrigin: "MCP_HTTP",
      }),
    );

    expect(result).toMatchObject({ outcome: "ACCEPTED" });
    expect(captured).toHaveLength(1);
    expect(readCommandTransportOrigin(captured[0] as CommandHandlerInput)).toBeUndefined();
  });
});

describe("Gate-1 transport origin admission", () => {
  const refusal = {
    httpStatus: 422,
    ok: false,
    outcome: "PORT_REFUSED",
    refusal: {
      code: "PRODUCT_CONTRACT_GATE_1_TRANSPORT_ORIGIN_INVALID",
      layer: "DAEMON_PRODUCT_CONTRACT_GATE_1",
    },
    stage: "DISPATCH",
  } as const;

  it("extends the command's closed refusal roster by exactly one code", () => {
    expect(PRODUCT_CONTRACT_GATE_1_CODES).toEqual([
      "PRODUCT_CONTRACT_GATE_1_REQUEST_MALFORMED",
      "PRODUCT_CONTRACT_GATE_1_AUTHENTICATION_INVALID",
      "PRODUCT_CONTRACT_GATE_1_TRANSPORT_ORIGIN_INVALID",
    ]);
  });

  it("composes the exact carrier value into the Gate-1 witness without remapping", () => {
    const source = readFileSync(new URL("./daemon-command-registry.ts", import.meta.url), "utf8");
    expect(source).toMatch(
      /transportOrigin:\s*readCommandTransportOrigin\(input\),/,
    );
  });

  it("admits the browser bearer beside the MCP survivor for a durable HUMAN principal", async () => {
    // HTTP_LISTENER joined the bearer origin roster for the Gate 1 card
    // (comment-18dc557c ruling): this suite's seeded durable HUMAN principal
    // now clears the origin fence over the browser wire too. What keeps agents
    // out is the KIND fence, pinned in product-contract-gate-1-bearer-origin's
    // own negative control, not the origin roster.
    const syncId = "cmd-gate1-origin-sync";
    const asyncId = "cmd-gate1-origin-async";
    const sync = handleCommandRequest(deps, gate1HttpRequest(syncId), "HTTP_LISTENER");
    const asyncResult = await handleAsyncCommandRequest(
      deps, gate1HttpRequest(asyncId), "MCP_STDIO",
    );

    expect(sync).toMatchObject({
      decision: { resultCode: "EFFECTS_COMMITTED" }, outcome: "ACCEPTED",
    });
    expect(asyncResult).toMatchObject({
      decision: { resultCode: "EFFECTS_COMMITTED" }, outcome: "ACCEPTED",
    });
  });

  it("refuses absent and non-roster stamps at the same named authority", () => {
    const absent = handleCommandRequest(
      deps, gate1HttpRequest("cmd-gate1-origin-absent"),
    );
    const nonRoster = handleCommandRequest(
      deps,
      gate1HttpRequest("cmd-gate1-origin-non-roster"),
      "WIRE_FIELD" as TransportOrigin,
    );

    expect(absent).toMatchObject(refusal);
    expect(nonRoster).toMatchObject(refusal);
  });

  it.each([
    { label: "absent", origin: undefined },
    { label: "non-roster", origin: "WIRE_FIELD" },
  ] as const)("refuses $label before any store or authority read", ({ label, origin }) => {
    const commandId = `cmd-gate1-origin-direct-${label}`;
    const storeRead = vi.fn(() => null);
    const unreadStore = { getCommandDecision: storeRead } as unknown as SqliteEventStore;
    const authorize = vi.fn(() => Object.freeze({
      advisoryOnly: true as const,
      authority: "NONE" as const,
      code: "UNEXPECTED_AUTHORITY_READ",
      error: null,
      kind: PRODUCT_CONTRACT_GATE_1_COMMAND_KIND,
      ok: false as const,
      reason: "origin admission ran too late",
      refusedBy: "TEST_AUTHORITY",
    }));
    const authority: ProductContractGate1Authority = Object.freeze({ authorize });
    const witness = Object.freeze({ sessionId: "operator-local", transportOrigin: origin });
    expect(runProductContractGate1Command(
      unreadStore, directGate1Request(commandId), authority, witness,
    )).toMatchObject({
      code: refusal.refusal.code, refusedBy: refusal.refusal.layer,
    });
    expect(storeRead).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
  });

  it("refuses a payload origin at PAYLOAD_SHAPE without calling the Gate-1 handler", () => {
    const entry = deps.registry.get(PRODUCT_CONTRACT_GATE_1_COMMAND_KIND);
    if (entry === undefined) throw new Error("Gate-1 registry entry absent");
    let handlerCalls = 0;
    const wired: CommandAdapterDeps = {
      ...deps,
      registry: buildCommandRegistry([{
        ...entry,
        handler: (input) => {
          handlerCalls += 1;
          return entry.handler(input);
        },
      }]),
    };
    const commandId = "cmd-gate1-origin-smuggled";
    const smuggled = handleCommandRequest(
      wired,
      gate1HttpRequest(commandId, { ...gate1Payload(commandId), transportOrigin: "MCP_STDIO" }),
      "HTTP_LISTENER",
    );

    expect(smuggled).toMatchObject({
      error: { code: "INPUT_INVALID" }, httpStatus: 400, outcome: "REFUSED",
      stage: "PAYLOAD_SHAPE",
    });
    expect(handlerCalls).toBe(0);
  });
});

describe("production command transport stamps", () => {
  it("matches the closed roster bidirectionally from the four production callers", () => {
    const cases = [
      {
        expected: ["HTTP_LISTENER"],
        file: "./http/http-listener-command-stream-routes.ts",
        pattern: /handleAsyncCommandRequest\(options\.deps,\s*\{[\s\S]*?protocolVersion:\s*protocolVersionOf\(request\),?\s*\},\s*"([A-Z_]+)"\s*\)/,
      },
      {
        expected: ["MCP_STDIO", "MCP_HTTP"],
        file: "./mcp-dispatch-port.ts",
        pattern: /handleAsyncCommandRequest\(plane\.deps,\s*\{[\s\S]*?protocolVersion:\s*WIRE_PROTOCOL_VERSION,?\s*\},\s*context === undefined\s*\?\s*"([A-Z_]+)"\s*:\s*"([A-Z_]+)"\s*\)/,
      },
      {
        expected: ["AGENT_WRAPPER"],
        file: "./orchestrator/agent-wrapper.ts",
        pattern: /handleCommandRequest\(config\.deps,\s*\{[\s\S]*?protocolVersion:\s*WIRE_PROTOCOL_VERSION,?\s*\},\s*"([A-Z_]+)"\s*\)/,
      },
      {
        expected: ["NODE_VERIFIER"],
        file: "./orchestrator/node-verifier.ts",
        pattern: /handleCommandRequest\(config\.deps,\s*\{[\s\S]*?protocolVersion:\s*WIRE_PROTOCOL_VERSION,?\s*\},\s*"([A-Z_]+)"\s*\)/,
      },
    ] as const;
    const served: string[] = [];
    for (const entry of cases) {
      const source = readFileSync(new URL(entry.file, import.meta.url), "utf8");
      const match = source.match(entry.pattern);
      expect(match, entry.file).not.toBeNull();
      const origins = match?.slice(1) ?? [];
      expect(origins, entry.file).toEqual(entry.expected);
      served.push(...origins);
    }
    expect(served).toHaveLength(5);
    expect([...new Set(served)].sort()).toEqual([...TRANSPORT_ORIGINS].sort());
  });

  it("derives stdio and HTTP MCP origins only from server dispatch context", async () => {
    if (stream === undefined) throw new Error("subscription port unavailable");
    const captured: CommandHandlerInput[] = [];
    const port = createMcpDispatchPort({
      deps: transportCaptureDeps(captured),
      fallbackCredential: CREDENTIAL,
      subscriptions: stream,
    });
    const stdioBody = transportRequest("cmd-origin-mcp-stdio").body;
    const httpBody = transportRequest("cmd-origin-mcp-http").body;
    if (!(stdioBody instanceof Uint8Array) || !(httpBody instanceof Uint8Array)) {
      throw new Error("transport request bytes unavailable");
    }

    await port.dispatchCommandBytes(stdioBody);
    await (port as unknown as HttpDispatchPort).dispatchCommandBytes(
      httpBody, { credential: CREDENTIAL },
    );
    expect(captured.map(readCommandTransportOrigin)).toEqual(["MCP_STDIO", "MCP_HTTP"]);
  });

  it("ignores transportOrigin header and payload claims in favor of the listener stamp", async () => {
    const captured: CommandHandlerInput[] = [];
    const started = await startControlRoomListener({
      csrfToken: "csrf-transport-origin",
      deps: transportCaptureDeps(captured, ["title", "transportOrigin"]),
    });
    if (!started.ok) throw new Error(`listener start refused: ${started.code}`);
    const request = transportRequest("cmd-origin-http-wire", {
      title: "ship it", transportOrigin: "MCP_HTTP",
    });
    if (!(request.body instanceof Uint8Array)) throw new Error("transport request bytes absent");
    try {
      const reply = await postTransportHeader(started, request.body);
      expect(reply.status).toBe(200);
      expect(captured).toHaveLength(1);
      expect(readCommandTransportOrigin(captured[0] as CommandHandlerInput)).toBe("HTTP_LISTENER");
      expect(captured[0]?.envelope.payload["transportOrigin"]).toBe("MCP_HTTP");
    } finally {
      await started.close();
    }
  });
});

describe("registered command table", () => {
  it("serves exactly the forty-five characterized kinds and nothing else", () => {
    // Pins the swept case count: an it.each over an empty or shortened table
    // would otherwise pass while asserting nothing.
    expect(ROWS).toHaveLength(45);
    expect(deps.registry.size).toBe(45);
    expect([...deps.registry.keys()].sort()).toEqual(ROWS.map((row) => row.kind).sort());
  });

  it("keeps the registration order the payload table declares", () => {
    // The sorted-set assertion above cannot see a reordered table, and a move that
    // reshuffles the literal is exactly the silent edit a mechanical split makes.
    expect(REGISTRATION_ORDER).toHaveLength(45);
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

    it("gates exactly the ten transcribed kinds and no others", () => {
      expect(OPERATOR_ONLY).toHaveLength(10);
      expect(ROWS.filter((row) => OPERATOR_ONLY.includes(row.kind))).toHaveLength(10);
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
      }, "HTTP_LISTENER");
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
  }, "HTTP_LISTENER");

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
          // FOREIGN, PRE-EXISTING RED, repaired rather than hidden: commit 9091fcac
          // (task-221fa0c3) made `goal-catalog-entry.ts:166` emit `binding` on EVERY row —
          // null for a prose-only goal, which is this one — and left this expectation
          // unchanged, so the arm was already red at HEAD ee4d4b50 before task-b8272ee0
          // touched the file. The key is ADDED, never relaxed: `toEqual` stays exact and now
          // pins the null a non-source goal must carry.
          binding: null,
          brief: {
            instructions: "Carry J1 from an activated project to an accepted goal.",
            title: "Seam goal",
          },
          goalId: "goal-cmd-goal-prose-only", planningRunRef: "run-cmd-goal-prose-only",
          truthClass: "DAEMON_VERIFIED",
        }],
        nextCursor: null,
        outcome: "GOALS",
      });
    } finally {
      reader.close();
    }
  });
});

const GOAL_CREATE_WITH_SOURCE_HOSTILE_EXTRAS = Object.freeze([
  ["goalId", "goal-browser-chosen"],
  ["budgetAccountRef", "budget-account-browser-chosen"],
  ["planningRunRef", "run-browser-chosen"],
  ["witness", { projectReadyRef: "ready-browser", truthClass: "HUMAN_APPROVED" }],
  ["brief", { instructions: "already admitted", title: "already admitted" }],
  ["sourceRef", "source-browser-chosen"],
  ["documentId", "document-browser-chosen"],
  ["aggregateId", "aggregate-browser-chosen"],
] as const);

const GOAL_CREATE_WITH_SOURCE_FENCE_EXTRAS = Object.freeze([
  ["objective", "Caller-chosen authority must not enter the bound source."],
  ["sourceRef", "source-browser-chosen"],
  ["aggregateId", "aggregate-browser-chosen"],
] as const);

describe("goal.create_with_source admits a brief plus one bounded source and nothing else", () => {
  const sourceDirectory = mkdtempSync(join(tmpdir(), "moe-goal-source-seam-"));
  const sourceStorePath = join(sourceDirectory, "store.db");
  const inactiveDirectory = mkdtempSync(join(tmpdir(), "moe-goal-source-inactive-"));
  const inactiveStorePath = join(inactiveDirectory, "store.db");
  const credential = "goal-source-operator";
  const runRef = createHash("sha256").update(sourceStorePath).digest("hex").slice(0, 12);
  let sourceProvider: ReturnType<typeof createStoreDependencies>;
  let inactiveProvider: ReturnType<typeof createStoreDependencies>;

  const readStore = <T>(path: string, read: (store: SqliteEventStore) => T): T => {
    const store = SqliteEventStore.openForProject(path, BOOTSTRAP_PROJECT_ID);
    try {
      return read(store);
    } finally {
      store.close();
    }
  };

  const sourceText = (commandId: string): string =>
    `# ${commandId}\n\nUnique registry source ${runRef}.\n`;

  const sourceOf = (commandId: string): Readonly<Record<string, unknown>> => ({
    displayPath: "prd.md",
    mediaType: DOCUMENT_INGEST_MEDIA_TYPES[0],
    text: sourceText(commandId),
  });

  const payloadOf = (commandId: string): Readonly<Record<string, unknown>> => ({
    instructions: "Carry the admitted PRD through one atomic goal decision.",
    source: sourceOf(commandId),
    title: "Source-bound seam goal",
  });

  const sendSource = (
    target: ReturnType<typeof createStoreDependencies>,
    commandId: string,
    payload: Readonly<Record<string, unknown>>,
  ): ReturnType<typeof handleCommandRequest> => handleCommandRequest(target.provide(), {
    body: new TextEncoder().encode(JSON.stringify({
      commandId,
      commandKind: "goal.create_with_source",
      correlationId: `corr-${commandId}`,
      expectedVersion: 0,
      payload,
      requestDigest: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
      schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: credential,
      targetAggregateId: `goal-${commandId}`,
    })),
    credential,
    protocolVersion: WIRE_PROTOCOL_VERSION,
  }, "HTTP_LISTENER");

  const goalFact = (store: SqliteEventStore, commandId: string): Readonly<Record<string, unknown>> => {
    const goalId = `goal-${commandId}`;
    const events = store.readEvents(goalId);
    expect(store.getAggregateVersion(goalId)).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("GoalCreated");
    const decoded = JSON.parse(new TextDecoder().decode(events[0]?.payload)) as unknown;
    expect(Array.isArray(decoded)).toBe(true);
    const facts = decoded as readonly Readonly<Record<string, unknown>>[];
    expect(facts).toHaveLength(1);
    const fact = facts[0];
    if (fact === undefined) throw new Error("missing durable GoalCreated fact");
    return fact;
  };

  const snapshot = (path = sourceStorePath) => readStore(path, (store) => ({
    decisions: decisionCount(store),
    eventHorizon: store.readEventHorizon(),
  }));

  beforeAll(() => {
    const active = SqliteEventStore.openForProject(sourceStorePath, BOOTSTRAP_PROJECT_ID);
    installTestRecoveryBinding(active);
    driveThrough(active, "goal.create");
    active.close();
    sourceProvider = createStoreDependencies({
      clock: CLOCK, credential, principalId: "operator-local",
      projectId: BOOTSTRAP_PROJECT_ID, storePath: sourceStorePath,
    });

    const inactive = SqliteEventStore.openForProject(inactiveStorePath, BOOTSTRAP_PROJECT_ID);
    installTestRecoveryBinding(inactive);
    driveThrough(inactive, "provider.probe");
    inactive.close();
    inactiveProvider = createStoreDependencies({
      clock: CLOCK, credential, principalId: "operator-local",
      projectId: BOOTSTRAP_PROJECT_ID, storePath: inactiveStorePath,
    });
  });

  afterAll(() => {
    sourceProvider.close();
    inactiveProvider.close();
    rmSync(sourceDirectory, { force: true, recursive: true });
    rmSync(inactiveDirectory, { force: true, recursive: true });
  });

  it("commits one GoalCreated fact and a production-readable document source", () => {
    const commandId = "cmd-goal-source-accepted";
    const text = sourceText(commandId);
    const digest = createHash("sha256").update(text).digest("hex");

    expect(sendSource(sourceProvider, commandId, payloadOf(commandId))).toMatchObject({
      decision: { disposition: "DECIDED", resultCode: "EFFECTS_COMMITTED" },
      outcome: "ACCEPTED",
    });

    readStore(sourceStorePath, (store) => {
      const fact = goalFact(store, commandId);
      expect(fact["brief"]).toEqual({
        instructions: "Carry the admitted PRD through one atomic goal decision.",
        title: "Source-bound seam goal",
      });
      const binding = fact["binding"] as Readonly<Record<string, unknown>>;
      expect(Object.keys(binding).sort())
        .toEqual(["byteLength", "contentSha256", "sourceAggregateId", "sourceRef"]);
      expect(binding["contentSha256"]).toBe(digest);
      expect(typeof binding["sourceAggregateId"]).toBe("string");
      expect(typeof binding["sourceRef"]).toBe("string");
      const sourceAggregateId = binding["sourceAggregateId"];
      const sourceRef = binding["sourceRef"];
      if (typeof sourceAggregateId !== "string") throw new Error("missing source aggregate id");
      if (typeof sourceRef !== "string") throw new Error("missing bound sourceRef");
      expect(store.getAggregateVersion(sourceAggregateId)).toBe(1);
      const sourceEvents = store.readEvents(sourceAggregateId);
      expect(sourceEvents).toHaveLength(1);
      expect(sourceEvents[0]?.eventType).toBe("DocumentSourceTextRecorded");
      expect(readDocumentSourceView(
        store, BOOTSTRAP_PROJECT_ID, digest, sourceRef,
      )).toEqual({
        kind: "VIEW",
        view: {
          byteLength: new TextEncoder().encode(text).byteLength,
          contentSha256: digest,
          displayPath: "prd.md",
          excerpt: text,
          excerptTruncated: false,
          mediaType: DOCUMENT_INGEST_MEDIA_TYPES[0],
        },
      });
    });
  });

  it("carries a nonzero exact roster of top-level hostile extras", () => {
    expect(GOAL_CREATE_WITH_SOURCE_HOSTILE_EXTRAS).toHaveLength(8);
    expect(GOAL_CREATE_WITH_SOURCE_HOSTILE_EXTRAS.map(([key]) => key)).toEqual([
      "goalId", "budgetAccountRef", "planningRunRef", "witness", "brief", "sourceRef",
      "documentId", "aggregateId",
    ]);
    expect(new Set(GOAL_CREATE_WITH_SOURCE_HOSTILE_EXTRAS.map(([key]) => key)).size)
      .toBe(GOAL_CREATE_WITH_SOURCE_HOSTILE_EXTRAS.length);
  });

  it.each(GOAL_CREATE_WITH_SOURCE_HOSTILE_EXTRAS)(
    "refuses top-level %s INPUT_INVALID at PAYLOAD_SHAPE and writes nothing",
    (key, value) => {
      const commandId = `cmd-goal-source-extra-${key}`;
      const before = snapshot();
      expect(sendSource(sourceProvider, commandId, {
        ...payloadOf(commandId), [key]: value,
      })).toMatchObject({
        error: { code: "INPUT_INVALID" },
        ok: false,
        outcome: "REFUSED",
        stage: "PAYLOAD_SHAPE",
      });
      expect(snapshot()).toEqual(before);
      readStore(sourceStorePath, (store) => {
        expect(store.readEvents(`goal-${commandId}`)).toHaveLength(0);
      });
    },
  );

  it("carries a nonzero exact roster of nested source-key fence cases", () => {
    expect(GOAL_CREATE_WITH_SOURCE_FENCE_EXTRAS).toHaveLength(3);
    expect(GOAL_CREATE_WITH_SOURCE_FENCE_EXTRAS.map(([key]) => key))
      .toEqual(["objective", "sourceRef", "aggregateId"]);
    expect(new Set(GOAL_CREATE_WITH_SOURCE_FENCE_EXTRAS.map(([key]) => key)).size)
      .toBe(GOAL_CREATE_WITH_SOURCE_FENCE_EXTRAS.length);
  });

  it.each(GOAL_CREATE_WITH_SOURCE_FENCE_EXTRAS)(
    "refuses source.%s GOAL_CREATE_SOURCE_KEYS_INVALID at DAEMON_INGRESS",
    (key, value) => {
      const commandId = `cmd-goal-source-fence-${key}`;
      const before = snapshot();
      expect(sendSource(sourceProvider, commandId, {
        ...payloadOf(commandId), source: { ...sourceOf(commandId), [key]: value },
      })).toMatchObject({
        ok: false,
        outcome: "PORT_REFUSED",
        refusal: { code: "GOAL_CREATE_SOURCE_KEYS_INVALID", layer: "DAEMON_INGRESS" },
        stage: "DISPATCH",
      });
      expect(snapshot()).toEqual(before);
    },
  );

  const malformedSources = Object.freeze([
    { code: "DOCUMENT_WORK_INGEST_PAYLOAD_INVALID", label: "missing text", source: {
      displayPath: "prd.md", mediaType: DOCUMENT_INGEST_MEDIA_TYPES[0],
    } },
    { code: "DOCUMENT_WORK_INGEST_PAYLOAD_INVALID", label: "non-string display path", source: {
      displayPath: 7, mediaType: DOCUMENT_INGEST_MEDIA_TYPES[0], text: "valid text",
    } },
    { code: "DOCUMENT_WORK_INGEST_MEDIA_TYPE_UNSUPPORTED", label: "unlisted media type", source: {
      displayPath: "prd.md", mediaType: "application/pdf", text: "valid text",
    } },
    { code: "DOCUMENT_WORK_INGEST_TEXT_TOO_LARGE", label: "oversized text", source: {
      displayPath: "prd.md", mediaType: DOCUMENT_INGEST_MEDIA_TYPES[0],
      text: "x".repeat(MAX_DOCUMENT_INGEST_TEXT_UTF8_BYTES + 1),
    } },
  ] as const);

  it("generates four distinct malformed-source cases", () => {
    expect(malformedSources).toHaveLength(4);
    expect(new Set(malformedSources.map(({ label }) => label)).size).toBe(malformedSources.length);
  });

  it.each(malformedSources)(
    "refuses $label with $code at DAEMON_INGRESS and writes nothing",
    ({ code, label, source }) => {
      const commandId = `cmd-goal-source-malformed-${label.replaceAll(" ", "-")}`;
      const before = snapshot();
      expect(sendSource(sourceProvider, commandId, {
        ...payloadOf(commandId), source,
      })).toMatchObject({
        ok: false,
        outcome: "PORT_REFUSED",
        refusal: { code, layer: "DAEMON_INGRESS" },
        stage: "DISPATCH",
      });
      expect(snapshot()).toEqual(before);
    },
  );

  it("carries the brief contract's GOAL_BRIEF_INPUT_INVALID at DAEMON_INGRESS", () => {
    const commandId = "cmd-goal-source-malformed-brief";
    const before = snapshot();
    expect(sendSource(sourceProvider, commandId, {
      ...payloadOf(commandId), title: "   ",
    })).toMatchObject({
      ok: false,
      outcome: "PORT_REFUSED",
      refusal: { code: "GOAL_BRIEF_INPUT_INVALID", layer: "DAEMON_INGRESS" },
      stage: "DISPATCH",
    });
    expect(snapshot()).toEqual(before);
  });

  it("replays identical bytes without another decision or event row", () => {
    const commandId = "cmd-goal-source-replay";
    const payload = payloadOf(commandId);
    expect(sendSource(sourceProvider, commandId, payload)).toMatchObject({
      decision: { disposition: "DECIDED" }, outcome: "ACCEPTED",
    });
    const before = snapshot();

    expect(sendSource(sourceProvider, commandId, payload)).toMatchObject({
      decision: { disposition: "REPLAYED" }, outcome: "ACCEPTED",
    });
    expect(snapshot()).toEqual(before);
    readStore(sourceStorePath, (store) => {
      expect(store.readEvents(`goal-${commandId}`)).toHaveLength(1);
      const binding = goalFact(store, commandId)["binding"] as Readonly<Record<string, unknown>>;
      const sourceAggregateId = binding["sourceAggregateId"];
      if (typeof sourceAggregateId !== "string") throw new Error("missing source aggregate id");
      expect(store.readEvents(sourceAggregateId)).toHaveLength(1);
    });
  });

  it("refuses changed source bytes under one command identity without mutation", () => {
    const commandId = "cmd-goal-source-conflict";
    expect(sendSource(sourceProvider, commandId, payloadOf(commandId))).toMatchObject({
      decision: { disposition: "DECIDED" }, outcome: "ACCEPTED",
    });
    const before = snapshot();

    expect(sendSource(sourceProvider, commandId, {
      ...payloadOf(commandId),
      source: { ...sourceOf(commandId), text: `${sourceText(commandId)}changed\n` },
    })).toMatchObject({
      ok: false,
      outcome: "PORT_REFUSED",
      refusal: {
        code: "BOOTSTRAP_COMMAND_BYTES_CONFLICT",
        layer: "DAEMON_PREREQUISITE",
      },
      stage: "DISPATCH",
    });
    expect(snapshot()).toEqual(before);
  });

  it("refuses before activation and pins project.activate as the prerequisite", () => {
    const commandId = "cmd-goal-source-before-activation";
    const before = snapshot(inactiveStorePath);
    expect(sendSource(inactiveProvider, commandId, payloadOf(commandId))).toMatchObject({
      ok: false,
      outcome: "PORT_REFUSED",
      refusal: {
        code: "BOOTSTRAP_PREREQUISITE_MISSING",
        layer: "DAEMON_PREREQUISITE",
      },
      stage: "DISPATCH",
    });
    expect(snapshot(inactiveStorePath)).toEqual(before);
    // The refusal response intentionally carries no missing-kind detail; pin the production
    // prerequisite roster instead of inventing a transport field.
    const prerequisites = COMMAND_PREREQUISITES as Readonly<Partial<
      Record<RuntimeCommandKind, readonly RuntimeCommandKind[]>
    >>;
    expect(prerequisites["goal.create_with_source"]).toEqual(["project.activate"]);
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
    expect(ports.registry.size).toBe(45);
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
    expect(supplied.registry.size).toBe(45);
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

  it("snapshots and validates the command authority plane at construction", () => {
    let reads = 0;
    const options = {
      get authorityPlane(): "V1" | "V2" {
        reads += 1;
        return reads === 1 ? "V1" : "V2";
      },
      clock: CLOCK,
      operatorPrincipalId: "operator-local",
      projectId: PROJECT,
      store: portStore,
    } satisfies DaemonCommandPortOptions;

    const snapshotPorts = createDaemonCommandPorts(options);
    expect(reads).toBe(1);
    expect(snapshotPorts.registry.size).toBe(45);
    expect(reads).toBe(1);

    expect(() => createDaemonCommandPorts({
      ...options,
      authorityPlane: "V3" as never,
    })).toThrow("COMMAND_AUTHORITY_PLANE_INVALID");
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

/**
 * THE COMPOSITION-ROOT WITNESS FACTORY (task-3b61860f).
 *
 * `humanReviewWitness` is the ONE constructor every mint site calls, so the three composition
 * roots that hold both the authenticated principal and the configured operator —
 * `daemon-command-registry.ts:200` (graph), `:255` (bootstrap) and `daemon-command-edges.ts:55`
 * (the approval intent seam) — cannot disagree about the shape of the same operator's evidence.
 *
 * WHAT IT IS NOT ARMED FOR HERE. The MINTING CONDITION (`principal === operator`) is deliberately
 * NOT asserted through this registry: `approval.decide_intent` is also in
 * `OPERATOR_PRINCIPAL_KINDS`, so a non-operator dispatch is refused 403
 * `OPERATOR_PRINCIPAL_REQUIRED` @ `DAEMON_AUTHORIZATION` by the gate above and never reaches the
 * mint. A fixture that "reaches" through here would prove the SYSTEM refuses, not that the mint
 * withholds the witness. That arm lives in `approval-intent.test.ts`, against the exported edge,
 * where the gate is out of the call path and only the conditional can answer.
 */
describe("the human-review witness carries a server-known transport fact", () => {
  it("derives the transport identity from the two server facts and nothing else", () => {
    expect(humanReviewWitness("operator-local", "cmd-witness-mint")).toEqual({
      principalId: "operator-local",
      transport: { commandId: "cmd-witness-mint", sessionRef: "operator-local" },
    });
  });

  it("is a pure function of those two facts, so nothing ambient can vary it", () => {
    expect(humanReviewWitness("operator-local", "cmd-same"))
      .toEqual(humanReviewWitness("operator-local", "cmd-same"));
    expect(humanReviewWitness("operator-local", "cmd-a"))
      .not.toEqual(humanReviewWitness("operator-local", "cmd-b"));
    expect(humanReviewWitness("operator-a", "cmd-same"))
      .not.toEqual(humanReviewWitness("operator-b", "cmd-same"));
  });

  it("freezes the witness AND its transport, so no consumer can restate either", () => {
    const minted = humanReviewWitness("operator-local", "cmd-frozen");
    const transport = minted.transport;
    if (transport === undefined) throw new Error("expected a minted transport fact");

    expect(Object.isFrozen(minted)).toBe(true);
    expect(Object.isFrozen(transport)).toBe(true);
    expect(() => {
      (transport as { sessionRef: string }).sessionRef = "operator-elsewhere";
    }).toThrowError(TypeError);
    expect(minted.transport?.sessionRef).toBe("operator-local");
  });
});

/**
 * `cutover.activate` is registered on its OWN EDGE, not as a `BootstrapCommandKind`
 * (task-b8272ee0, governor ruling comment-ec6d4cbf). The reason is measurable rather than
 * stylistic: `activateCutover` takes `CutoverGenerationPorts`, the bootstrap `CommandHandler`
 * takes none, and every bootstrap parity guard reads its SERVED side off the three
 * module-level tables — so roster membership would advertise a kind those tables cannot serve.
 * daemon-command-vocabulary.ts already states that rule for `resource.reconcile` and
 * `events.resume`.
 */
describe("cutover.activate is served on its own edge", () => {
  const cutoverDirectory = mkdtempSync(join(tmpdir(), "moe-cutover-edge-"));
  let cutoverStore: SqliteEventStore;

  beforeAll(() => {
    cutoverStore = SqliteEventStore.openForProject(join(cutoverDirectory, "store.db"), PROJECT);
  });

  afterAll(() => {
    cutoverStore.close();
    rmSync(cutoverDirectory, { force: true, recursive: true });
  });

  /** The evidence root is never read on these paths; a reader that throws proves it. */
  const unreadableEvidence = (): string => {
    throw new Error("CUTOVER_EVIDENCE_READ_UNEXPECTED");
  };

  const configuredPorts = (): ReturnType<typeof createDaemonCommandPorts> =>
    createDaemonCommandPorts({
      clock: CLOCK,
      cutoverActivation: { evidenceRoot: cutoverDirectory, readFileText: unreadableEvidence },
      operatorPrincipalId: "operator-local",
      projectId: PROJECT,
      store: cutoverStore,
    });

  const cutoverEnvelope = (commandId: string, payload: Readonly<Record<string, unknown>>):
  RuntimeCommandEnvelope => ({
    commandId,
    commandKind: "cutover.activate",
    correlationId: "corr-cutover",
    expectedVersion: 0,
    payload: payload as RuntimeCommandEnvelope["payload"],
    requestDigest: "a".repeat(64),
    schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    sessionCredential: CREDENTIAL,
    targetAggregateId: "agg-cutover",
  });

  const refusalOf = (
    registry: ReturnType<typeof createDaemonCommandPorts>["registry"],
    payload: Readonly<Record<string, unknown>>,
    principalId = "operator-local",
  ): unknown => {
    const entry = registry.get("cutover.activate");
    if (entry === undefined) throw new Error("CUTOVER_ACTIVATE_ENTRY_ABSENT");
    try {
      entry.handler({
        envelope: cutoverEnvelope("cmd-cutover-edge", payload),
        principal: { capabilities: [ADMIN, WORK], principalId, projectId: PROJECT },
      });
    } catch (error) {
      return error;
    }
    throw new Error("CUTOVER_ACTIVATE_REFUSAL_EXPECTED");
  };

  it("is admitted with the record-only allow-list and ADMIN reach", () => {
    const entry = deps.registry.get("cutover.activate");
    expect(entry).toBeDefined();
    expect(entry?.kind).toBe("cutover.activate");
    expect(entry?.payloadKeys).toEqual(["record"]);
    expect(entry?.requiredCapability).toBe(ADMIN);
    expect(entry?.asyncHandler).toBeUndefined();
  });

  /**
   * THE ARM THAT PROVES REGISTRATION, not merely advertisement. The refusal is the
   * ADMISSION'S own code and layer, forwarded from inside `activateCutover`: a kind that
   * were advertised but unserved would answer at DAEMON_INGRESS instead, and one that never
   * reached the handler could not name GA_ACTIVATION_BINDING at all.
   */
  it("reaches the handler, which refuses an absent binding with its own code and layer", () => {
    expect(refusalOf(configuredPorts().registry, {})).toMatchObject({
      code: "ACTIVATION_BINDING_ABSENT",
      layer: "GA_ACTIVATION_BINDING",
    });
  });

  /** An unconfigured evidence root is a REFUSING state, never a skipped one. */
  it("refuses fail-closed when no evidence root is configured", () => {
    const unconfigured = createDaemonCommandPorts({
      clock: CLOCK, operatorPrincipalId: "operator-local", projectId: PROJECT,
      store: cutoverStore,
    });

    expect(unconfigured.registry.get("cutover.activate")).toBeDefined();
    expect(refusalOf(unconfigured.registry, {})).toMatchObject({
      code: "CUTOVER_ACTIVATE_UNCONFIGURED",
      httpStatus: 422,
      layer: "DAEMON_COMPOSITION",
    });
  });

  /** The human-only fence answers BEFORE the handler, so no agent principal reaches it. */
  it("refuses a non-operator principal before the handler runs", () => {
    expect(refusalOf(configuredPorts().registry, {}, "agent-session-1")).toMatchObject({
      code: "OPERATOR_PRINCIPAL_REQUIRED",
      layer: "DAEMON_AUTHORIZATION",
    });
  });

  /**
   * BIDIRECTIONAL, and the SERVED side is witnessed by the HANDLER MODULE'S OWN CONSTANT
   * rather than by the roster. The edge is reached if and only if `commandFamilyFacts(kind)
   * .cutover` holds, and that predicate compares against `CUTOVER_ACTIVATE_COMMAND_KIND`
   * exported by cutover-activate-contracts.ts — so "served but not advertised" is exactly
   * "that constant is missing from PAYLOAD_KEYS", which the second half pins. An arm that read
   * both sides off PAYLOAD_KEYS could only ever prove the roster equals itself.
   */
  it("routes exactly one advertised kind to the cutover edge, and advertises that kind", () => {
    // The SYNC half of the advertised roster, taken off the registry itself: the two async
    // kinds are served by their own entries and carry no family at all, so asking one for its
    // family facts throws rather than answering false. Deriving the exclusion from
    // `asyncHandler` keeps this sweep total without a hand-written skip list.
    const syncAdvertised = [...deps.registry.entries()]
      .filter(([, entry]) => entry.asyncHandler === undefined)
      .map(([kind]) => kind as WiredCommandKind);
    expect(syncAdvertised.length).toBeGreaterThan(30);
    const routed = syncAdvertised.filter((kind) => commandFamilyFacts(kind).cutover);

    // SERVED -> ADVERTISED: no kind reaches this edge that the roster does not declare.
    expect(routed).toEqual([CUTOVER_ACTIVATE_COMMAND_KIND]);
    // ADVERTISED -> SERVED: the handler module's own kind is on the roster and in the map.
    expect(Object.keys(PAYLOAD_KEYS)).toContain(CUTOVER_ACTIVATE_COMMAND_KIND);
    expect([...deps.registry.keys()]).toContain(CUTOVER_ACTIVATE_COMMAND_KIND);
    // The entry's allow-list is the vocabulary's own array, not a retyped copy of it.
    expect(deps.registry.get(CUTOVER_ACTIVATE_COMMAND_KIND)?.payloadKeys)
      .toBe(PAYLOAD_KEYS[CUTOVER_ACTIVATE_COMMAND_KIND]);
    // ADMIN is the reach fence and the family branch is the only source of it.
    expect(commandFamilyFacts(CUTOVER_ACTIVATE_COMMAND_KIND).requiredCapability).toBe(ADMIN);
  });

  /**
   * THE PAYLOAD FENCE, BOTH DIRECTIONS. `record` is the one declared key and the handler
   * HONOURS it — a present-but-malformed binding answers SHAPE_INVALID where an absent one
   * answers ABSENT, so the value demonstrably crosses into `activateCutover` rather than being
   * dropped. And no admitted key is missing from the roster: every other field of
   * ActivateCutoverInput is a SERVER fact, so a caller naming one is refused structurally at
   * PAYLOAD_SHAPE before dispatch.
   */
  it("honours its one declared key and refuses every server fact a caller might name", () => {
    expect(refusalOf(configuredPorts().registry, { record: {} })).toMatchObject({
      code: "ACTIVATION_BINDING_SHAPE_INVALID",
      layer: "GA_ACTIVATION_BINDING",
    });

    const serverFacts = ["activatedAtEpochMs", "correlationId", "decidedAt", "projectId"];
    expect(serverFacts).toHaveLength(4);
    for (const key of serverFacts) {
      expect(send(`cmd-cutover-${key}`, "cutover.activate", { [key]: "presented" }))
        .toMatchObject({
          error: { code: "INPUT_INVALID" }, httpStatus: 400, ok: false, stage: "PAYLOAD_SHAPE",
        });
    }
  });

  it("refuses a smuggled key at the seam, and answers the shipped daemon fail-closed", () => {
    expect(send("cmd-cutover-smuggled", "cutover.activate", { smuggled: true })).toMatchObject({
      error: { code: "INPUT_INVALID" }, httpStatus: 400, ok: false, stage: "PAYLOAD_SHAPE",
    });
    // The composition root supplies no evidence root, so the shipped daemon registers the
    // kind and refuses it — the posture this row's rail 4 requires ("registers a command;
    // it does not activate anything"). Wiring the root belongs to the GA activation row.
    expect(send("cmd-cutover-shipped", "cutover.activate", {})).toMatchObject({
      outcome: "PORT_REFUSED",
      refusal: { code: "CUTOVER_ACTIVATE_UNCONFIGURED", layer: "DAEMON_COMPOSITION" },
      stage: "DISPATCH",
    });
  });
});
