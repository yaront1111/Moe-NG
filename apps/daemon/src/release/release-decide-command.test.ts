import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import { afterEach, expect, it } from "vitest";
import { closeStores, openStore, openRestartableStore, reopen, PROJECT_ID } from "../review/review-test-fixtures.js";
import type { CommandHandlerInput } from "../http/http-contract.js";
import { buildCommandRegistry, WIRE_PROTOCOL_VERSION } from "../http/http-contract.js";
import { handleAsyncCommandRequest } from "../http/http-adapter.js";
import { createCommandDecisionPort } from "../daemon-command-decision-port.js";
import { DomainRefusal } from "../daemon-command-dispatch.js";
import { recordPublishReceipt } from "../repository/publish-ledger.js";
import { publishAggregateId, remoteAggregateId, REMOTE_BOUND_EVENT_TYPE } from "../repository/publish-receipt-contracts.js";
import { createReleaseDecideHandler } from "./release-decide-service.js";
import { GOAL_ID, HEAD_SHA, ancestryOf, dossierInput } from "./release-dossier-fixtures.js";
import { recordReleaseDossier } from "./release-dossier-ledger.js";
import { releaseDossierAggregateId } from "./release-dossier-contracts.js";
import { renderReleaseDossier } from "./release-dossier.js";

afterEach(closeStores);
const encoder = new TextEncoder();
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value));
const clock = () => "2026-09-06T00:00:00.000Z";
const operator = "operator", remoteUrl = "https://github.com/acme/product.git";

function harness(store = openStore()) {
  for (const [aggregateId, commandId, eventType, result] of [
    [remoteAggregateId(PROJECT_ID), "remote", REMOTE_BOUND_EVENT_TYPE, { boundAt: clock(), boundBy: operator, remoteUrl }],
    [publishAggregateId(GOAL_ID), "publish", "RepositoryPublishRequested", { goalId: GOAL_ID, remoteUrl }],
  ] as const) {
    store.commitExpectedVersionDecision({ commandKind: "repository.publish", committedResultBytes: bytes(result),
      correlationId: "release-test", decidedAt: clock(), key: { commandId, projectId: PROJECT_ID, principalId: operator },
      requestBytes: bytes(result), targetAggregateId: aggregateId, expectedVersion: store.getAggregateVersion(aggregateId),
      events: [{ eventId: `${commandId}-event`, eventType, payload: bytes(result) }] });
  }
  expect(recordPublishReceipt(store, { projectId: PROJECT_ID, goalId: GOAL_ID, decisionId: "publish", decidedAt: clock(),
    branch: "moe/release", refusal: null, remoteUrl, sha: HEAD_SHA, url: `${remoteUrl}/tree/moe/release` }).ok).toBe(true);
  const draft = dossierInput({ projectId: PROJECT_ID });
  const facts = { ...draft, criteria: draft.criteria.filter(row => row.criterionId !== "crit-charlie") };
  expect(recordReleaseDossier(store, { projectId: PROJECT_ID, goalId: GOAL_ID, sha: HEAD_SHA, decidedAt: clock(),
    markdown: renderReleaseDossier(facts, HEAD_SHA, ancestryOf().predicate) }).ok).toBe(true);
  const calls: string[] = [];
  const options = { projectId: PROJECT_ID, operatorPrincipalId: operator, store, clock,
    dossierFacts: () => { calls.push("facts"); return { input: facts, ancestry: ancestryOf().predicate }; },
    publisher: { publishOnce: async () => { calls.push("push"); return []; } },
    prPort: { open: async () => { calls.push("pr"); return { ok: true as const, prUrl: "https://github.com/acme/product/pull/7" }; } } };
  const input: CommandHandlerInput = { principal: { principalId: operator, projectId: PROJECT_ID, capabilities: ["goal.write"] },
    envelope: { commandId: "release-command-1", commandKind: "release.decide", correlationId: "release-test",
      schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION, sessionCredential: "test-session", requestDigest: "c".repeat(64),
      expectedVersion: store.getAggregateVersion(releaseDossierAggregateId(GOAL_ID)), targetAggregateId: releaseDossierAggregateId(GOAL_ID),
      payload: { base: "main", decision: "APPROVE", goalId: GOAL_ID, sha: HEAD_SHA } } };
  return { store, calls, options, input, handler: createReleaseDecideHandler(options) };
}

it.each([
  ["project", "RELEASE_PROJECT_MISMATCH"], ["target", "RELEASE_TARGET_INVALID"],
  ["stale", "EXPECTED_VERSION_CONFLICT"], ["negative", "INPUT_INVALID"],
  ["kind", "INPUT_INVALID"], ["sha", "INPUT_INVALID"], ["base", "INPUT_INVALID"], ["schema", "SCHEMA_VERSION_UNSUPPORTED"],
])("refuses %s before dossier reads, publication, or PR creation", async (change, code) => {
  const h = harness();
  const envelope = { ...h.input.envelope, payload: { ...h.input.envelope.payload } }, principal = { ...h.input.principal };
  if (change === "project") principal.projectId = "foreign-project";
  if (change === "target") envelope.targetAggregateId = "release:foreign-goal";
  if (change === "stale") envelope.expectedVersion -= 1;
  if (change === "negative") envelope.expectedVersion = -1;
  if (change === "kind") envelope.commandKind = "deployment.deploy";
  if (change === "sha") envelope.payload["sha"] = "HEAD";
  if (change === "base") envelope.payload["base"] = "--force";
  if (change === "schema") Object.assign(envelope, { schemaVersion: "unsupported" });
  await expect(h.handler({ envelope, principal })).rejects.toMatchObject({ code });
  expect(h.calls).toEqual([]);
});

it("replays the original success after SQLite restart without reading changing evidence", async () => {
  const restartable = openRestartableStore(), h = harness(restartable.store);
  const first = await h.handler(h.input);
  const count = h.calls.length;
  const replay = await createReleaseDecideHandler({ ...h.options, store: reopen(restartable),
    dossierFacts: () => { throw new Error("evidence changed"); } })(h.input);
  expect(replay).toEqual({ ...first, disposition: "REPLAYED" });
  expect(h.calls).toHaveLength(count);
});

it("binds the exact base and decision bytes to the command id", async () => {
  const h = harness();
  await h.handler(h.input);
  const count = h.calls.length;
  await expect(h.handler({ ...h.input, envelope: { ...h.input.envelope,
    payload: { ...h.input.envelope.payload, base: "another-base" } } }))
    .rejects.toMatchObject({ code: "RELEASE_COMMAND_BYTES_CONFLICT" });
  expect(h.calls).toHaveLength(count);
});

it("requires the original command when an already released SHA is requested again", async () => {
  const h = harness();
  await h.handler(h.input);
  await expect(h.handler({ ...h.input, envelope: { ...h.input.envelope, commandId: "new-command",
    expectedVersion: h.store.getAggregateVersion(releaseDossierAggregateId(GOAL_ID)),
    payload: { ...h.input.envelope.payload, base: "another-base" } } }))
    .rejects.toMatchObject({ code: "RELEASE_COMMAND_ID_REQUIRED" });
  expect(h.calls.filter(value => value === "pr")).toHaveLength(1);
});

it("persists REJECT and replays it without reevaluating evidence", async () => {
  const restartable = openRestartableStore(), h = harness(restartable.store);
  const input = { ...h.input, envelope: { ...h.input.envelope, payload: { ...h.input.envelope.payload, decision: "REJECT" } } };
  const first = await h.handler(input);
  expect(first.resultCode).toBe("REJECTED");
  const replay = await createReleaseDecideHandler({ ...h.options, store: reopen(restartable), dossierFacts: () => null })(input);
  expect(replay).toEqual({ ...first, disposition: "REPLAYED" });
  expect(h.calls).toEqual(["facts"]);
});

it("replays the original domain refusal even after its prerequisite changes", async () => {
  const restartable = openRestartableStore(), h = harness(restartable.store);
  await expect(createReleaseDecideHandler({ ...h.options, dossierFacts: () => null })(h.input))
    .rejects.toMatchObject({ code: "RELEASE_EVIDENCE_INCOMPLETE" });
  await expect(createReleaseDecideHandler({ ...h.options, store: reopen(restartable) })(h.input))
    .rejects.toMatchObject({ code: "RELEASE_EVIDENCE_INCOMPLETE" });
  expect(h.calls).toEqual([]);
});

it("admits only one concurrent command from an offered release version", async () => {
  const h = harness();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const first = createReleaseDecideHandler({ ...h.options, publisher: { publishOnce: async () => {
    entered(); await gate; return [];
  } } })(h.input);
  try {
    await started;
    await expect(h.handler({ ...h.input, envelope: { ...h.input.envelope, commandId: "concurrent-command" } }))
      .rejects.toMatchObject({ code: "EXPECTED_VERSION_CONFLICT" });
    await expect(h.handler(h.input)).rejects.toMatchObject({ code: "RELEASE_COMMAND_IN_PROGRESS" });
    expect(h.calls.filter(value => value === "pr")).toEqual([]);
  } finally { release(); await first; }
});

it("keeps an uncertain pending command closed across restart", async () => {
  const restartable = openRestartableStore(), h = harness(restartable.store);
  await expect(createReleaseDecideHandler({ ...h.options, publisher: { publishOnce: async () => {
    throw new Error("injected publisher interruption");
  } } })(h.input)).rejects.toThrow("injected publisher interruption");
  const count = h.calls.length;
  const restarted = reopen(restartable);
  await expect(createReleaseDecideHandler({ ...h.options, store: restarted })(h.input))
    .rejects.toMatchObject({ code: "RELEASE_COMMAND_IN_PROGRESS" });
  expect(h.calls).toHaveLength(count);
  await expect(createReleaseDecideHandler({ ...h.options, store: restarted })({
    ...h.input, envelope: { ...h.input.envelope, commandId: "new-after-interruption",
      expectedVersion: restarted.getAggregateVersion(releaseDossierAggregateId(GOAL_ID)) },
  })).rejects.toMatchObject({ code: "RELEASE_COMMAND_IN_PROGRESS" });
});

it("holds release target ownership while PR creation awaits even if another caller refreshes its version", async () => {
  const h = harness();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const first = createReleaseDecideHandler({ ...h.options, prPort: { open: async () => {
    entered(); await gate; return { ok: true, prUrl: "https://github.com/acme/product/pull/7" };
  } } })(h.input);
  try {
    await started;
    await expect(h.handler({ ...h.input, envelope: { ...h.input.envelope, commandId: "refreshed-command",
      expectedVersion: h.store.getAggregateVersion(releaseDossierAggregateId(GOAL_ID)) } }))
      .rejects.toMatchObject({ code: "RELEASE_COMMAND_IN_PROGRESS" });
    expect(h.calls.filter(value => value === "pr")).toEqual([]);
  } finally { release(); await first; }
});

it("does not confuse a domain refusal with a released decision", async () => {
  const h = harness();
  await expect(createReleaseDecideHandler({ ...h.options, publisher: { publishOnce: async () => {
    throw new DomainRefusal("RELEASE_TEST_REFUSAL", "TEST_PORT", "measured refusal", 409);
  } } })(h.input)).rejects.toMatchObject({ code: "RELEASE_TEST_REFUSAL", httpStatus: 409 });
  await expect(h.handler(h.input)).rejects.toMatchObject({ code: "RELEASE_TEST_REFUSAL", httpStatus: 409 });
  expect(h.calls.filter(value => value === "pr")).toEqual([]);
});

it("roundtrips canonical release envelopes through the production asynchronous command route", async () => {
  const h = harness();
  const deps = { authenticator: { authenticate: () => ({ verdict: "AUTHENTICATED" as const, principal: h.input.principal }) },
    decisions: createCommandDecisionPort(), registry: buildCommandRegistry([{ kind: "release.decide",
      requiredCapability: "goal.write", payloadKeys: ["base", "decision", "goalId", "sha"], asyncHandler: h.handler,
      handler: () => { throw new Error("synchronous release entry reached"); } }]) };
  const request = { credential: h.input.envelope.sessionCredential, protocolVersion: WIRE_PROTOCOL_VERSION,
    body: bytes(h.input.envelope) };
  const first = await handleAsyncCommandRequest(deps, request, "HTTP_LISTENER");
  expect(first).toMatchObject({ ok: true, httpStatus: 200, decision: { resultCode: "RELEASED", disposition: "DECIDED" } });
  expect(await handleAsyncCommandRequest(deps, request, "HTTP_LISTENER"))
    .toMatchObject({ ok: true, decision: { resultCode: "RELEASED", disposition: "REPLAYED" } });
  expect(h.calls.filter(value => value === "pr")).toHaveLength(1);
  expect(await handleAsyncCommandRequest(deps, { ...request, body: bytes({ ...h.input.envelope,
    payload: { ...h.input.envelope.payload, base: "another-base" } }) }, "HTTP_LISTENER"))
    .toMatchObject({ ok: false, httpStatus: 409, refusal: { code: "RELEASE_COMMAND_BYTES_CONFLICT" } });
});
