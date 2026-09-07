/**
 * The operator-principal fence, measured under a REAL paired HUMAN session.
 *
 * Operator ruling 2026-08-30 (task-6093483c comment-18dc557c): a session minted by
 * the approved-pairing seam — a durable HUMAN principal — is the approver seat for
 * `approval.decide_intent`. Everything else on `OPERATOR_PRINCIPAL_KINDS` keeps the
 * configured-operator fence: an agent/scoped session stays 403 on the intent kind,
 * and even the paired HUMAN stays 403 on `goal.close` (the widening is one kind,
 * not a seat upgrade).
 *
 * The typed `SOFT_POLICY_WAIVER` arm of `approval.decide` is the second widening, and
 * it is narrower still: the same paired HUMAN must ALSO hold ADMIN, and only for the
 * exact nested union. The legacy `approval.decide` bytes stay configured-operator-only
 * for that very principal, which is what the divergence arms below measure.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { RuntimeCommandEnvelope, RuntimeCommandKind } from "@moe/contracts";
import { SqliteEventStore } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";

import { createStoreDependencies } from "./daemon-store-dependencies.js";
import { handleCommandRequest } from "./http/http-adapter.js";
import { WIRE_PROTOCOL_VERSION } from "./http/http-contract.js";
import type { AuthenticatedPrincipal, DurableDecision } from "./http/http-contract.js";
import { AGENT_PROVIDER_COMMAND_KIND } from "./orchestrator/agent-provider-command.js";
import { agentProviderAggregateId } from "./orchestrator/agent-provider-store.js";
import { CAPABILITIES, OPERATOR_CAPABILITIES } from "./daemon-command-vocabulary.js";
import { MCP_EXCLUDED_COMMAND_KINDS, wiredMcpToolKinds } from "./mcp-tool-allowlist.js";
import { createOperatorSessionHandshakePort } from "./identity/session-handshake.js";
import { isDurableHumanPrincipal } from "./identity/human-approver.js";
import { installTestRecoveryBinding } from "./identity/session-test-fixtures.js";
import { createAgentWrapper } from "./orchestrator/agent-wrapper.js";
import type { ChainStep } from "./http/affordance-contract.js";

const CREDENTIAL = "human-approver-operator-credential";
const PROJECT = "proj-human-approver";
const DECIDED_AT = "2026-08-30T12:00:00.000Z";
const CLOCK = (): string => DECIDED_AT;

const directory = mkdtempSync(join(tmpdir(), "moe-human-approver-"));
const storePath = join(directory, "store.db");

// One real approved-pairing mint, committed durably BEFORE the provider opens: a
// HUMAN principal record plus an open session whose credential the authenticator
// reads back from the same store. This is the production browser-pairing shape,
// not a fixture spelling of it.
const setupStore = SqliteEventStore.openForProject(storePath, PROJECT);
installTestRecoveryBinding(setupStore);

/** One real approved-pairing mint. `mintSessionId` is the port's own test seam, so a
 *  pairing can be given a KNOWN principal id and its derived refs written as literals. */
function mintPairing(
  capabilities: readonly string[], sessionId?: string,
): { credential: string; principalId: string } {
  const result = createOperatorSessionHandshakePort({
    capabilities,
    clock: Date.now,
    ...(sessionId === undefined ? {} : { mintSessionId: () => sessionId }),
    operatorPrincipalId: "operator-human-approver",
    projectId: PROJECT,
    sessionTtlMs: 24 * 60 * 60 * 1000,
    store: setupStore,
  }).mint();
  if (!result.ok) throw new Error(`pairing mint refused in fixture: ${result.code}`);
  return { credential: result.credential, principalId: result.principalId };
}

const minted = mintPairing(OPERATOR_CAPABILITIES);
const PAIRED_CREDENTIAL = minted.credential;
const PAIRED_PRINCIPAL_ID = minted.principalId;
// The waiver seat: a durable HUMAN that also holds ADMIN, under a pinned id.
const HUMAN_ADMIN = mintPairing(OPERATOR_CAPABILITIES, "sess-waiver-human-admin");
// A durable HUMAN with the ingress capability but WITHOUT ADMIN.
const HUMAN_NO_ADMIN = mintPairing([CAPABILITIES.PLANNING], "sess-waiver-human-noadmin");
setupStore.close();

const provider = createStoreDependencies({
  clock: CLOCK,
  credential: CREDENTIAL,
  principalId: "operator-human-approver",
  projectId: PROJECT,
  storePath,
});
const deps = provider.provide();

it("release.decide never staffs the READY unclaimed human work item", async () => {
  const steps: readonly ChainStep[] = [{ aggregateId: "release-human-1", claim: null,
    claimAggregateVersion: 0, kind: "release.decide", missing: [], status: "READY", version: 1 }];
  const wrapper = createAgentWrapper({
    affordances: { boundProjectId: PROJECT, readSurface: () => ({
      nextAllowedCommands: [], outcome: "SURFACE", planningAuthorityByRun: {},
      planningGoalRefs: {}, planningGoalRef: null, steps,
    }) },
    claimTtlMs: 60_000, clock: () => Date.parse(DECIDED_AT), deps, maxAgents: 1,
    mintSecret: () => { throw new Error("release human gate must not mint a session"); },
    operatorCredential: CREDENTIAL,
    spawnAgent: () => { throw new Error("release human gate must not spawn"); },
  });
  expect(steps.filter((step) => step.kind === "release.decide"
    && step.status === "READY" && step.claim === null)).toHaveLength(1);
  const report = await wrapper.runOnce();
  expect(report.spawned.map((entry) => entry.workItemId))
    .not.toContain("release.decide@release-human-1");
  expect(report).toEqual({ active: 0, spawned: [], surfaceOutcome: "SURFACE" });
});

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
      commandId, commandKind, correlationId: "corr-human-approver", expectedVersion, payload,
      requestDigest: "a".repeat(64), schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: credential, targetAggregateId: "agg-human-approver",
    })),
    credential,
    protocolVersion: WIRE_PROTOCOL_VERSION,
  }, "HTTP_LISTENER");
}

function openScopedSession(
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

describe("paired HUMAN principal at the operator fence", () => {
  it("records the pairing mint as a durable HUMAN principal (fixture positive control)", () => {
    const reader = SqliteEventStore.openForProject(storePath, PROJECT);
    try {
      expect(isDurableHumanPrincipal(reader, PAIRED_PRINCIPAL_ID)).toBe(true);
      expect(isDurableHumanPrincipal(reader, "principal-that-never-was")).toBe(false);
    } finally {
      reader.close();
    }
  });

  it("admits the paired HUMAN session past the fence on approval.decide_intent", () => {
    // On HEAD this refused 403 OPERATOR_PRINCIPAL_REQUIRED — the browser could
    // never approve. Past the fence the intent seam answers with its OWN refusal
    // (payload/record stage); which one is that seam's business, not this fence's.
    const outcome = send("cmd-human-intent", "approval.decide_intent", {}, PAIRED_CREDENTIAL);
    expect(outcome.ok).toBe(false);
    expect(outcome).not.toMatchObject({ httpStatus: 401 });
    expect(outcome).not.toMatchObject({ httpStatus: 403 });
    const code = (outcome as { refusal?: { code?: string }; error?: { code?: string } });
    expect(code.refusal?.code ?? code.error?.code).not.toBe("OPERATOR_PRINCIPAL_REQUIRED");
  });

  it("keeps a scoped non-HUMAN session behind the fence on approval.decide_intent", () => {
    const secret = openScopedSession(
      "cmd-open-scoped", "sess-scoped-agent", "secret-scoped-agent",
      ["planning.write", "work.write"],
    );
    expect(send("cmd-agent-intent", "approval.decide_intent", {}, secret)).toMatchObject({
      httpStatus: 403,
      ok: false,
      refusal: { code: "OPERATOR_PRINCIPAL_REQUIRED" },
    });
  });

  it("keeps even the paired HUMAN behind the fence on goal.close (one kind, not a seat)", () => {
    expect(send("cmd-human-goal-close", "goal.close", {}, PAIRED_CREDENTIAL)).toMatchObject({
      httpStatus: 403,
      ok: false,
      refusal: { code: "OPERATOR_PRINCIPAL_REQUIRED" },
    });
  });

  it("leaves the configured operator's own path untouched", () => {
    const outcome = send("cmd-operator-intent", "approval.decide_intent", {});
    expect(outcome.ok).toBe(false);
    expect(outcome).not.toMatchObject({ httpStatus: 403 });
    const code = (outcome as { refusal?: { code?: string }; error?: { code?: string } });
    expect(code.refusal?.code ?? code.error?.code).not.toBe("OPERATOR_PRINCIPAL_REQUIRED");
  });
});

/**
 * Recomputed OUT OF BAND against the landed policy-waiver contract and written here as
 * literals, so a drifted derivation reddens against a constant rather than against itself.
 */
const OPERATOR_WAIVER_AGGREGATE =
  "policy-waiver:aggregate:v1:sha256:58df18b251a7cc592005d5b1c6135d6a69c5adb6f311e148c49d30c74e726ecf";
const HUMAN_WAIVER_AGGREGATE =
  "policy-waiver:aggregate:v1:sha256:ecd7f0eef50a5773d99b85b93cb14cf60710c7a19d653f2da5f1fd867916660c";
const HUMAN_GRANT_STEP_UP_REF =
  "b77a6d68cdb2ef6d32ed3a9b32b4cc9e7d8e8c9286c52e1b150e1867ad03a5c7";
const HUMAN_GRANT_RECORD_JSON = "{\"actionKind\":\"plan.apply\",\"approvedAt\":\"2026-08-30T12:00:00.000Z\""
  + ",\"approvedBy\":\"sess-waiver-human-admin\",\"commandId\":\"cmd-waiver-human-grant\""
  + ",\"decisionReason\":\"operator accepts the residual risk for one shift\""
  + ",\"expiresAtEpochMs\":1788112800000,\"humanApprovalRef\":\"approval:policy-waiver:sha256:"
  + "341ed8f7f87254ec7d7f6b0afe1e7cd2261845c2bc5b1ca08fcdd7bec89aacb4\""
  + ",\"namedObligationId\":\"obligation-secondary-review\""
  + ",\"policyRevisionRef\":\"policy-revision-2026-08-30\",\"projectId\":\"proj-human-approver\""
  + ",\"scope\":[\"repo:moe-next\",\"task:task-4704a298\"]"
  + ",\"stepUpAuthRef\":\"b77a6d68cdb2ef6d32ed3a9b32b4cc9e7d8e8c9286c52e1b150e1867ad03a5c7\""
  + ",\"supersedesWaiverRef\":null,\"waiverRef\":\"policy-waiver:sha256:"
  + "b521a73da27ceba74141e6c7d77684e4e8816aad1660172098fe5dda0a4e7ca2\"}";

const WAIVER_REASON = "operator accepts the residual risk for one shift";

/** The exact nested union. `extra` adds ONE more nested key, which must always refuse. */
function waiverCommand(
  operation: "GRANT" | "REVOKE", extra: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    command: {
      actionKind: "plan.apply",
      decisionKind: "SOFT_POLICY_WAIVER",
      decisionReason: WAIVER_REASON,
      ...(operation === "GRANT" ? { expiresAt: "2026-08-30T18:00:00.000Z" } : {}),
      namedObligationId: "obligation-secondary-review",
      operation,
      policyRevisionRef: "policy-revision-2026-08-30",
      scope: ["repo:moe-next", "task:task-4704a298"],
      ...extra,
    },
  };
}

/** The legacy `approval.decide` shape: no nested discriminator, so the branch declines it. */
const LEGACY_APPROVAL: Readonly<Record<string, unknown>> = Object.freeze({
  command: { decision: "APPROVE", kind: "PLAN" }, runId: "run-human-approver-legacy",
});

function ledger(aggregateId: string): readonly string[] {
  const reader = SqliteEventStore.openForProject(storePath, PROJECT);
  try {
    return reader.readEvents(aggregateId)
      .map((event) => new TextDecoder().decode(event.payload));
  } finally {
    reader.close();
  }
}

function refusalOf(outcome: ReturnType<typeof handleCommandRequest>):
{ code: string; httpStatus: number; layer: string } {
  if (outcome.ok) throw new Error("expected a refusal; the command was ACCEPTED");
  const refused = outcome as { httpStatus: number; refusal?: { code: string; layer: string } };
  const refusal = refused.refusal;
  if (refusal === undefined) throw new Error("expected a port refusal carrying code and layer");
  return { code: refusal.code, httpStatus: refused.httpStatus, layer: refusal.layer };
}

describe("SOFT_POLICY_WAIVER over the real HTTP ingress", () => {
  it("admits a paired durable HUMAN holding ADMIN and writes the exact ledger bytes", () => {
    const outcome = send(
      "cmd-waiver-human-grant", "approval.decide", waiverCommand("GRANT"), HUMAN_ADMIN.credential,
    );
    expect(outcome).toMatchObject({
      decision: { commandId: "cmd-waiver-human-grant", disposition: "DECIDED",
        resultCode: "EFFECTS_COMMITTED" },
      httpStatus: 200, ok: true, outcome: "ACCEPTED",
    });
    expect(ledger(HUMAN_WAIVER_AGGREGATE)).toEqual([HUMAN_GRANT_RECORD_JSON]);
    // The step-up was burned in the SAME decision, so it can never be spent twice.
    expect(ledger(`moe.session-authority.v1/replay/${HUMAN_GRANT_STEP_UP_REF}`)).toHaveLength(1);
  });

  it("carries the configured operator through GRANT, superseding GRANT and REVOKE", () => {
    for (const [commandId, operation, expectedVersion] of [
      ["cmd-waiver-op-grant", "GRANT", 0],
      ["cmd-waiver-op-grant-2", "GRANT", 1],
      ["cmd-waiver-op-revoke", "REVOKE", 2],
    ] as readonly (readonly [string, "GRANT" | "REVOKE", number])[]) {
      expect(send(commandId, "approval.decide", waiverCommand(operation), CREDENTIAL,
        expectedVersion)).toMatchObject({ httpStatus: 200, ok: true, outcome: "ACCEPTED" });
    }
    const events = ledger(OPERATOR_WAIVER_AGGREGATE).map((text) =>
      JSON.parse(text) as { revokedWaiverRef?: string; supersedesWaiverRef?: string | null;
        waiverRef?: string });
    expect(events).toHaveLength(3);
    expect(events[0]?.supersedesWaiverRef).toBeNull();
    expect(events[1]?.supersedesWaiverRef).toBe(events[0]?.waiverRef);
    expect(events[2]?.revokedWaiverRef).toBe(events[1]?.waiverRef);
  });

  it("refuses a durable HUMAN without ADMIN at POLICY_WAIVER_ADMIN_REQUIRED only", () => {
    // Every unrelated fence is satisfied: durable HUMAN, planning.write for the ingress
    // capability check, canonical payload. ADMIN is the ONLY missing thing.
    const reader = SqliteEventStore.openForProject(storePath, PROJECT);
    try {
      expect(isDurableHumanPrincipal(reader, HUMAN_NO_ADMIN.principalId)).toBe(true);
    } finally {
      reader.close();
    }
    expect(refusalOf(send("cmd-waiver-human-noadmin", "approval.decide", waiverCommand("GRANT"),
      HUMAN_NO_ADMIN.credential))).toEqual({
      code: "POLICY_WAIVER_ADMIN_REQUIRED", httpStatus: 403, layer: "DAEMON_POLICY_WAIVER",
    });
  });

  it("refuses a non-HUMAN session holding ADMIN at POLICY_WAIVER_HUMAN_REQUIRED only", () => {
    const secret = openScopedSession(
      "cmd-open-waiver-agent", "sess-waiver-agent", "secret-waiver-agent",
      [CAPABILITIES.PLANNING, CAPABILITIES.ADMIN],
    );
    expect(refusalOf(send("cmd-waiver-agent-grant", "approval.decide", waiverCommand("GRANT"),
      secret))).toEqual({
      code: "POLICY_WAIVER_HUMAN_REQUIRED", httpStatus: 403, layer: "DAEMON_POLICY_WAIVER",
    });
  });

  it("refuses a marker-bearing payload at POLICY_WAIVER_PAYLOAD_INVALID, writing nothing", () => {
    const before = ledger(OPERATOR_WAIVER_AGGREGATE).length;
    expect(refusalOf(send("cmd-waiver-op-malformed", "approval.decide",
      waiverCommand("GRANT", { stepUpAuthRef: "a".repeat(64) }), CREDENTIAL))).toEqual({
      code: "POLICY_WAIVER_PAYLOAD_INVALID", httpStatus: 422, layer: "DAEMON_POLICY_WAIVER",
    });
    expect(ledger(OPERATOR_WAIVER_AGGREGATE)).toHaveLength(before);
  });

  it("keeps the SAME paired HUMAN behind the operator fence on legacy approval.decide", () => {
    // The widening is bytes-scoped, not seat-scoped: this principal just succeeded above.
    expect(refusalOf(send("cmd-waiver-human-legacy", "approval.decide", LEGACY_APPROVAL,
      HUMAN_ADMIN.credential))).toEqual({
      code: "OPERATOR_PRINCIPAL_REQUIRED", httpStatus: 403, layer: "DAEMON_AUTHORIZATION",
    });
  });

  it("serves approval.decide from the registry while MCP neither advertises nor serves it", () => {
    // The operator-only class less `session.open` (the operator's own scoped-session mint over
    // the bearer-authorized MCP HTTP path); production derives this from the vocabulary.
    const expectedExclusions: readonly string[] = Object.freeze([
      "project.set_agent_provider",
      "criterion_check.approve", "criterion_check.verify", "repository.recover",
      "approval.decide", "approval.decide_intent", "cutover.activate", "goal.close",
      "graph.approve", "graph.supersede", "integration.accept_output", "preview.decide",
      "product_contract.answer_clarification", "repository.publish", "resource.confirm_released",
      // Landed by task-a2409cba: writing a production secret is never reachable over MCP.
      "environment.set_variable", "environment.unset_variable",
      // Creating a repository at an operator-supplied path. The MCP port authenticates with the
      // operator bootstrap credential, so an advertised operator kind would let an agent arrive
      // AS THE OPERATOR — the exclusion is derived from OPERATOR_PRINCIPAL_KINDS, not typed here.
      "repository.bootstrap",
      "release.decide", "deployment.deploy", "deployment.migrate_down", "deployment.rollback", "deployment.set_target",
      // Committing in the operator's own product repository; derived from
      // OPERATOR_PRINCIPAL_KINDS like the rest, never typed into the allowlist.
      "product_contract.sync_env_example",
      // Asking for a product preview runs the product on the daemon's host, so it is the
      // operator's act and never an agent's. Derived from OPERATOR_PRINCIPAL_KINDS like the rest.
      "preview.start",
    ]);
    expect(expectedExclusions).toHaveLength(25);
    expect(MCP_EXCLUDED_COMMAND_KINDS).toHaveLength(25);
    expect([...MCP_EXCLUDED_COMMAND_KINDS].sort()).toEqual([...expectedExclusions].sort());
    // Direction 1: the production registry SERVES the kind this branch composes into.
    expect(deps.registry.has("approval.decide")).toBe(true);
    // Direction 2: the advertised MCP roster does not carry it, so the witness minted on
    // principal identity alone stays trustworthy.
    expect(wiredMcpToolKinds()).not.toContain("approval.decide");
  });
});

/**
 * `project.set_agent_provider` — the third widening, and the narrowest of them.
 *
 * WHY THESE ARMS RUN AT THE REGISTRY HANDLER SEAM AND NOT OVER HTTP. This kind's
 * `requiredCapability` is `CAPABILITIES.ADMIN` (`SETTINGS_FAMILY`), and the HTTP ingress
 * checks `requiredCapability` BEFORE it reaches any handler (`http-command-ingress.ts:158`).
 * So a no-ADMIN principal sent over HTTP is refused `CAPABILITY_DENIED @ AUTHORIZE` and
 * NEVER REACHES THE FENCE: an ingress-level negative arm would stay green even with the
 * fence's ADMIN check deleted outright, which is exactly the "one added layer away from
 * vacuous" failure global rail 1 names. The seam arms below drive `entry.handler` directly,
 * where the fence is the only thing that can answer, and the HTTP arm at the end pins the
 * OTHER layer by name so neither refusal can silently stand in for the other.
 */
const PROVIDER_AGGREGATE = agentProviderAggregateId(PROJECT);
/** The project-default scope: empty `goalId` is the command contract's own sentinel. */
const PROVIDER_PAYLOAD = Object.freeze({ base: "", goalId: "", provider: "codex" });
const NEVER_PAIRED_PRINCIPAL = "principal-agent-never-paired";

function providerEnvelope(commandId: string): RuntimeCommandEnvelope {
  return {
    commandId, commandKind: AGENT_PROVIDER_COMMAND_KIND,
    correlationId: "corr-human-approver", expectedVersion: 0, payload: { ...PROVIDER_PAYLOAD },
    requestDigest: "a".repeat(64), schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    // Never read at this seam: authentication already happened upstream, and supplying a
    // real credential here would hide that the fence reads `principal`, not the envelope.
    sessionCredential: "not-read-at-the-handler-seam",
    targetAggregateId: "agg-human-approver",
  };
}

function principalOf(
  principalId: string, capabilities: readonly string[],
): AuthenticatedPrincipal {
  return { capabilities, principalId, projectId: PROJECT };
}

/** Dispatches straight into the registered handler — past authentication and past the
 *  ingress capability gate, so the operator fence is the only authority left to answer. */
function dispatchAtSeam(commandId: string, principal: AuthenticatedPrincipal): DurableDecision {
  const entry = deps.registry.get(AGENT_PROVIDER_COMMAND_KIND);
  if (entry === undefined) throw new Error("the registry must serve project.set_agent_provider");
  return entry.handler({ envelope: providerEnvelope(commandId), principal });
}

/** The seam throws `DomainRefusal` rather than returning a port refusal, so the code and
 *  layer are read off the thrown value. A RETURNED decision is a drill failure, not a pass. */
function seamRefusalOf(
  commandId: string, principal: AuthenticatedPrincipal,
): { code: string; httpStatus: number; layer: string } {
  let decision: DurableDecision | null = null;
  try {
    decision = dispatchAtSeam(commandId, principal);
  } catch (thrown) {
    const refusal = thrown as { code?: unknown; httpStatus?: unknown; layer?: unknown };
    if (typeof refusal.code !== "string" || typeof refusal.layer !== "string") throw thrown;
    return { code: refusal.code, httpStatus: Number(refusal.httpStatus), layer: refusal.layer };
  }
  throw new Error("expected a refusal at the operator fence; the handler ACCEPTED: "
    + JSON.stringify(decision));
}

function isDurableHuman(principalId: string): boolean {
  const reader = SqliteEventStore.openForProject(storePath, PROJECT);
  try {
    return isDurableHumanPrincipal(reader, principalId);
  } finally {
    reader.close();
  }
}

describe("project.set_agent_provider for a paired browser HUMAN holding ADMIN", () => {
  it("admits the paired HUMAN holding ADMIN at the fence and writes the provider durably", () => {
    expect(isDurableHuman(HUMAN_ADMIN.principalId)).toBe(true);
    const before = ledger(PROVIDER_AGGREGATE).length;
    expect(dispatchAtSeam("cmd-provider-human-admin",
      principalOf(HUMAN_ADMIN.principalId, OPERATOR_CAPABILITIES))).toMatchObject({
      commandId: "cmd-provider-human-admin", disposition: "DECIDED",
      resultCode: "AGENT_PROVIDER_SET",
    });
    // Reaching `runAgentProviderCommand` is the claim, so the durable event is the evidence:
    // a fence that admitted but wrote nothing would satisfy the result code alone.
    const written = ledger(PROVIDER_AGGREGATE);
    expect(written).toHaveLength(before + 1);
    expect(JSON.parse(written[written.length - 1] ?? "null")).toMatchObject({
      goalId: "", provider: "codex",
    });
  });

  it("refuses a durable HUMAN WITHOUT ADMIN: OPERATOR_PRINCIPAL_REQUIRED @ DAEMON_AUTHORIZATION", () => {
    // THE ARM DoD 2's DRILL REDDENS. Every other condition is satisfied — durable HUMAN,
    // canonical payload, the kind's own handler — so ADMIN is the ONLY thing missing, and
    // deleting the fence's ADMIN check turns this refusal into an acceptance.
    expect(isDurableHuman(HUMAN_NO_ADMIN.principalId)).toBe(true);
    const before = ledger(PROVIDER_AGGREGATE).length;
    expect(seamRefusalOf("cmd-provider-human-noadmin",
      principalOf(HUMAN_NO_ADMIN.principalId, [CAPABILITIES.PLANNING]))).toEqual({
      code: "OPERATOR_PRINCIPAL_REQUIRED", httpStatus: 403, layer: "DAEMON_AUTHORIZATION",
    });
    expect(ledger(PROVIDER_AGGREGATE)).toHaveLength(before);
  });

  it("refuses a NON-human principal holding ADMIN the same way (pairing, not capabilities)", () => {
    // The widening turns on the pairing ledger. A principal that was never paired cannot buy
    // its way past the fence with capabilities, however complete they are.
    expect(isDurableHuman(NEVER_PAIRED_PRINCIPAL)).toBe(false);
    const before = ledger(PROVIDER_AGGREGATE).length;
    expect(seamRefusalOf("cmd-provider-agent-admin",
      principalOf(NEVER_PAIRED_PRINCIPAL, OPERATOR_CAPABILITIES))).toEqual({
      code: "OPERATOR_PRINCIPAL_REQUIRED", httpStatus: 403, layer: "DAEMON_AUTHORIZATION",
    });
    expect(ledger(PROVIDER_AGGREGATE)).toHaveLength(before);
  });

  it("refuses a no-ADMIN principal at the INGRESS instead: CAPABILITY_DENIED @ AUTHORIZE", () => {
    // THE OTHER LAYER, PINNED BY NAME. Same principal as the seam negative above, sent over
    // the real HTTP path: the ingress answers first and the fence is never consulted. This is
    // why the arm above cannot live here — this one is green with or without the widening.
    // The ingress reports its layer as `stage` on the refusal envelope, not `refusal.layer`.
    expect(send("cmd-provider-http-noadmin", AGENT_PROVIDER_COMMAND_KIND,
      { ...PROVIDER_PAYLOAD }, HUMAN_NO_ADMIN.credential)).toMatchObject({
      error: { code: "CAPABILITY_DENIED" }, httpStatus: 403, ok: false,
      outcome: "REFUSED", stage: "AUTHORIZE",
    });
  });

  it("carries the paired HUMAN holding ADMIN through the REAL ingress end to end", () => {
    // The browser's actual path, not a seam shortcut: authentication, the ingress capability
    // gate, the payload allow-list and the fence, all in production order. This is the arm
    // the control-room journey mirrors.
    expect(send("cmd-provider-http-human-admin", AGENT_PROVIDER_COMMAND_KIND,
      { ...PROVIDER_PAYLOAD, provider: "claude" }, HUMAN_ADMIN.credential)).toMatchObject({
      decision: { disposition: "DECIDED", resultCode: "AGENT_PROVIDER_SET" },
      httpStatus: 200, ok: true, outcome: "ACCEPTED",
    });
  });

  it("keeps the kind MCP-unreachable in BOTH directions (the widening's standing condition)", () => {
    // Global rail 9: enumerate the SERVED set from the dispatch seam, not only the roster
    // constant, and assert set-equality rather than a subset. Admitting a paired HUMAN on
    // principal identity alone is only sound while no agent can reach the kind over MCP —
    // `MCP_EXCLUDED_COMMAND_KINDS` is DERIVED from `OPERATOR_PRINCIPAL_KINDS`, so this arm is
    // what would catch a roster edit that opened both fences at once.
    const served = new Set<string>(wiredMcpToolKinds());
    const excluded = new Set<string>(MCP_EXCLUDED_COMMAND_KINDS);
    expect(excluded.has(AGENT_PROVIDER_COMMAND_KIND)).toBe(true);
    expect(served.has(AGENT_PROVIDER_COMMAND_KIND)).toBe(false);
    // Direction 1: nothing served is excluded. Direction 2: nothing excluded is served.
    // Iterating one roster alone would shrink with it and stay green.
    expect([...served].filter((kind) => excluded.has(kind))).toEqual([]);
    expect([...excluded].filter((kind) => served.has(kind))).toEqual([]);
    // The registry DOES serve it — the exclusion is MCP-only, not a de-registration.
    expect(deps.registry.has(AGENT_PROVIDER_COMMAND_KIND)).toBe(true);
  });
});
