import { randomUUID } from "node:crypto";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { closeStores, openStore, PROJECT_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import { DomainRefusal } from "../daemon-command-dispatch.js";
import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import type { CommandHandlerInput } from "../http/http-contract.js";
import { isDurableHumanPrincipal } from "../identity/human-approver.js";
import { createOperatorSessionHandshakePort } from "../identity/session-handshake.js";
import { installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
import { createPublishResolveCommandEntry } from "./publish-resolve-command.js";
import { PUBLISH_RESOLVE_COMMAND_KIND } from "./publish-resolve-contracts.js";

/**
 * The resolve entry fence, exercised DIRECTLY. Ingress never reaches the no-ADMIN
 * conjunct (CAPABILITY_DENIED @ AUTHORIZE answers first); these arms pin defence in
 * depth. Owner ruling comment-00ce6540 on task-4f16c331: a paired durable HUMAN
 * holding ADMIN may pass, matching release.decide's assertReleasePrincipal.
 */

const OPERATOR = "operator-publish-resolve-fence";
const PROJECT = PROJECT_ID;
const ADMIN = [CAPABILITIES.ADMIN] as const;
const FENCE = {
  code: "OPERATOR_PRINCIPAL_REQUIRED",
  detail: "this command requires the configured operator principal",
  httpStatus: 403,
  layer: "DAEMON_AUTHORIZATION",
} as const;
const NEXT = {
  code: "PUBLISH_RESOLVE_DECISION_NOT_FOUND",
  detail: "no publish request has this decision id",
  layer: "DAEMON_PREREQUISITE",
} as const;

afterEach(closeStores);

function handlerOf(store: SqliteEventStore) {
  const handler = createPublishResolveCommandEntry({
    operatorPrincipalId: OPERATOR, projectId: PROJECT, store,
  }).asyncHandler;
  if (handler === undefined) throw new Error("PUBLISH_RESOLVE_ASYNC_ENTRY_ABSENT");
  return handler;
}

function openFenceStore(): SqliteEventStore {
  const store = openStore();
  installTestRecoveryBinding(store);
  return store;
}

function mintHuman(store: SqliteEventStore, capabilities: readonly string[], sessionId: string) {
  const minted = createOperatorSessionHandshakePort({
    capabilities, clock: Date.now, mintSessionId: () => sessionId,
    operatorPrincipalId: OPERATOR, projectId: PROJECT,
    reservedPrincipalIds: [OPERATOR], sessionTtlMs: 3_600_000, store,
  }).mint();
  if (!minted.ok) throw new Error(minted.code);
  return minted;
}

function boundaryInput(principal: CommandHandlerInput["principal"]): CommandHandlerInput {
  const decisionId = `decision-${randomUUID()}`;
  return {
    envelope: {
      commandId: `cmd-${randomUUID()}`, commandKind: PUBLISH_RESOLVE_COMMAND_KIND,
      correlationId: "publish-resolve-fence", expectedVersion: 0,
      payload: { decisionId, resolution: "NOT_TRANSMITTED" },
      requestDigest: "0".repeat(64), schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: randomUUID(), targetAggregateId: `publish-resolve:${decisionId}`,
    },
    principal,
  };
}

async function refusalOf(promise: Promise<unknown>): Promise<DomainRefusal> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainRefusal) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

function expectFence(refusal: DomainRefusal): void {
  expect(refusal.code).toBe(FENCE.code);
  expect(refusal.layer).toBe(FENCE.layer);
  expect(refusal.detail).toBe(FENCE.detail);
  expect(refusal.httpStatus).toBe(FENCE.httpStatus);
}

function expectNextLayer(refusal: DomainRefusal): void {
  expect(refusal.code).toBe(NEXT.code);
  expect(refusal.layer).toBe(NEXT.layer);
  expect(refusal.detail).toBe(NEXT.detail);
}

describe("repository.publish_resolve entry fence", () => {
  it("lets the configured operator reach the next layer on a well-formed absent decision", async () => {
    expectNextLayer(await refusalOf(handlerOf(openFenceStore())(boundaryInput({
      capabilities: [...ADMIN], principalId: OPERATOR, projectId: PROJECT,
    }))));
  });

  it("lets a durable HUMAN on the project holding ADMIN reach the same next layer", async () => {
    const store = openFenceStore();
    const human = mintHuman(store, ADMIN, "session-resolve-admin");
    expect(isDurableHumanPrincipal(store, human.principalId)).toBe(true);
    expect(human.principalId).not.toBe(OPERATOR);
    expectNextLayer(await refusalOf(handlerOf(store)(boundaryInput({
      capabilities: [...ADMIN], principalId: human.principalId, projectId: PROJECT,
    }))));
  });

  it("refuses a durable HUMAN without ADMIN at the entry fence (defence in depth)", async () => {
    const store = openFenceStore();
    const human = mintHuman(store, [CAPABILITIES.GOAL], "session-resolve-no-admin");
    expect(isDurableHumanPrincipal(store, human.principalId)).toBe(true);
    expectFence(await refusalOf(handlerOf(store)(boundaryInput({
      capabilities: [CAPABILITIES.GOAL], principalId: human.principalId, projectId: PROJECT,
    }))));
  });

  it("refuses a non-human principal holding ADMIN", async () => {
    const store = openFenceStore();
    expect(isDurableHumanPrincipal(store, "agent-admin")).toBe(false);
    expectFence(await refusalOf(handlerOf(store)(boundaryInput({
      capabilities: [...ADMIN], principalId: "agent-admin", projectId: PROJECT,
    }))));
  });

  it("refuses a durable HUMAN with ADMIN on a different projectId", async () => {
    const store = openFenceStore();
    const human = mintHuman(store, ADMIN, "session-resolve-other-project");
    expectFence(await refusalOf(handlerOf(store)(boundaryInput({
      capabilities: [...ADMIN], principalId: human.principalId,
      projectId: "project-somewhere-else",
    }))));
  });

  it("fails closed when the durable principal read throws", async () => {
    const store = openFenceStore();
    const human = mintHuman(store, ADMIN, "session-resolve-throwing");
    const throwing = new Proxy(store, {
      get(target, property, receiver) {
        if (property === "readEvents") {
          return () => { throw new Error("PRINCIPAL_READ_UNAVAILABLE"); };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    }) as SqliteEventStore;
    expectFence(await refusalOf(handlerOf(throwing)(boundaryInput({
      capabilities: [...ADMIN], principalId: human.principalId, projectId: PROJECT,
    }))));
  });
});
