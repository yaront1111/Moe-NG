import { randomUUID } from "node:crypto";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { createAsyncCommandEntries } from "../daemon-command-async-entries.js";
import { DomainRefusal } from "../daemon-command-dispatch.js";
import { CAPABILITIES, OPERATOR_PRINCIPAL_KINDS } from "../daemon-command-vocabulary.js";
import type { CommandHandlerInput } from "../http/http-contract.js";
import { credentialSha256Of } from "../identity/session-authenticator.js";
import { readSessionLedger } from "../identity/session-read-model.js";
import { MCP_EXCLUDED_COMMAND_KINDS } from "../mcp-tool-allowlist.js";
import { RELEASE_DECIDE_COMMAND_KIND } from "./release-decide-contracts.js";
import { releaseDossierAggregateId } from "./release-dossier-contracts.js";
import {
  GOAL_ID, HEAD_SHA, OPERATOR, OPERATOR_CREDENTIAL, PROJECT, SESSION_TTL_MS,
  startReleaseAuthorizationHarness,
} from "./release-authorization-fixtures.js";
import type { ReleaseAuthorizationHarness } from "./release-authorization-fixtures.js";

/**
 * `release.decide` AUTHORIZATION, through the production HTTP ingress.
 *
 * Owner ruling comment-e9ecfd4c (2026-09-07): a currently authenticated, project-bound,
 * durable HUMAN principal holding ADMIN may reach `release.decide`, retaining its OWN
 * identity. Configured-operator behaviour and the MCP exclusion are unchanged.
 *
 * REACHING `RELEASE_REMOTE_MISSING` IS AUTHORIZATION EVIDENCE, NOT A RELEASE. The harness
 * binds no repository remote, so an authorized caller lands on the service's FIRST
 * prerequisite refusal with every effect port still at zero. The parent row owns the live
 * browser release proof; this row only certifies who may spend the command.
 */

const NO_EFFECTS = { dossier: 0, pr: 0, publish: 0 } as const;
const ADMIN_AND_GOAL = [CAPABILITIES.ADMIN, CAPABILITIES.GOAL];
const AUTHORIZED = {
  outcome: "PORT_REFUSED", stage: "DISPATCH",
  refusal: { code: "RELEASE_REMOTE_MISSING", layer: "PROJECT_REDUCER" },
} as const;
const FENCED = {
  httpStatus: 403, outcome: "PORT_REFUSED", stage: "DISPATCH",
  refusal: { code: "OPERATOR_PRINCIPAL_REQUIRED", layer: "DAEMON_AUTHORIZATION" },
} as const;

const open: ReleaseAuthorizationHarness[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()?.close();
});

async function harnessOf(
  options: Parameters<typeof startReleaseAuthorizationHarness>[0] = {},
): Promise<ReleaseAuthorizationHarness> {
  const harness = await startReleaseAuthorizationHarness(
    { capabilities: ADMIN_AND_GOAL, ...options },
  );
  open.push(harness);
  return harness;
}

/** Whether ANY release admission or decision reached the journal under this command id. */
function decisionFor(
  harness: ReleaseAuthorizationHarness, commandId: string, principalId: string,
): unknown {
  return harness.store.getCommandDecision({
    commandId, principalId, projectId: harness.projectId,
  });
}

/** A release entry composed OUTSIDE the listener, for the boundary cases HTTP cannot reach:
 *  the authenticator derives `projectId` from its own binding, so a project mismatch can only
 *  arrive at the command boundary, and a store that THROWS can only be injected here. */
function boundaryEntry(store: SqliteEventStore, projectId = PROJECT) {
  const entries = createAsyncCommandEntries({
    operatorPrincipalId: OPERATOR, projectId, store,
    releaseDecide: {
      dossierFacts: () => null, prPort: { async open() { throw new Error("unreachable"); } },
      publisher: { async publishOnce() { throw new Error("unreachable"); } },
      workspace: "/tmp/release-authorization-boundary",
    },
  });
  const handler = entries[RELEASE_DECIDE_COMMAND_KIND].asyncHandler;
  if (handler === undefined) throw new Error("RELEASE_ASYNC_ENTRY_ABSENT");
  return handler;
}

function boundaryInput(principal: CommandHandlerInput["principal"]): CommandHandlerInput {
  return {
    envelope: {
      commandId: `cmd-boundary-${randomUUID()}`, commandKind: RELEASE_DECIDE_COMMAND_KIND,
      correlationId: "release-authorization-boundary", expectedVersion: 0,
      payload: { base: "main", decision: "APPROVE", goalId: GOAL_ID, sha: HEAD_SHA },
      requestDigest: "0".repeat(64), schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: randomUUID(),
      targetAggregateId: releaseDossierAggregateId(GOAL_ID),
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

describe("release.decide admits the owner-approved paired ADMIN human", () => {
  it("admits a paired durable HUMAN holding ADMIN under its OWN principal id", async () => {
    const harness = await harnessOf();
    const browser = await harness.pair("session-release-admin");
    expect(browser.principalId).toBe("session-release-admin");
    expect(browser.principalId).not.toBe(OPERATOR);
    expect(browser.capabilities).toContain(CAPABILITIES.ADMIN);

    const commandId = "cmd-release-actor-identity";
    const reply = await harness.send(browser.credential, { commandId });

    expect(reply.body).toMatchObject(AUTHORIZED);
    // Authorization only: no dossier read, no push, no pull request.
    expect(harness.counts).toEqual(NO_EFFECTS);
    // The durable record is keyed by the ACTUAL actor, and the operator key is absent.
    expect(decisionFor(harness, commandId, browser.principalId)).toMatchObject({
      commandKind: RELEASE_DECIDE_COMMAND_KIND,
    });
    expect(decisionFor(harness, commandId, OPERATOR)).toBe(null);
  }, 30_000);

  it("leaves the CONFIGURED operator's own release admission unchanged", async () => {
    const harness = await harnessOf();
    const commandId = "cmd-release-operator";
    expect((await harness.send(OPERATOR_CREDENTIAL, { commandId })).body)
      .toMatchObject(AUTHORIZED);
    expect(harness.counts).toEqual(NO_EFFECTS);
    expect(decisionFor(harness, commandId, OPERATOR)).toMatchObject({
      commandKind: RELEASE_DECIDE_COMMAND_KIND,
    });
  }, 30_000);
});

describe("release.decide refuses everything the ruling did not approve", () => {
  it("refuses a paired HUMAN with GOAL but NO ADMIN at DAEMON_AUTHORIZATION", async () => {
    const harness = await harnessOf({ capabilities: [CAPABILITIES.GOAL] });
    const browser = await harness.pair("session-release-no-admin");
    const commandId = "cmd-release-no-admin";

    expect((await harness.send(browser.credential, { commandId })).body).toMatchObject(FENCED);
    expect(harness.counts).toEqual(NO_EFFECTS);
    // Authorization precedes admission: nothing was journalled for this actor.
    expect(decisionFor(harness, commandId, browser.principalId)).toBe(null);
  }, 30_000);

  it("refuses a paired HUMAN with ADMIN but no GOAL at the AUTHORIZE capability gate",
    async () => {
      const harness = await harnessOf({ capabilities: [CAPABILITIES.ADMIN] });
      const browser = await harness.pair("session-release-no-goal");
      expect((await harness.send(browser.credential)).body).toMatchObject({
        httpStatus: 403, outcome: "REFUSED", stage: "AUTHORIZE",
        error: { code: "CAPABILITY_DENIED" },
      });
      expect(harness.counts).toEqual(NO_EFFECTS);
    }, 30_000);

  it("refuses an agent session that never minted a durable HUMAN principal", async () => {
    const harness = await harnessOf();
    const sessionId = "session-release-agent";
    const credential = "release-authorization-agent-credential";
    const opened = await harness.command("session.open", OPERATOR_CREDENTIAL, {
      capabilities: [...ADMIN_AND_GOAL], credentialSha256: credentialSha256Of(credential),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(), sessionId,
    }, { targetAggregateId: sessionId });
    expect(opened.body).toMatchObject({ outcome: "ACCEPTED" });

    // The wrapper's own session path leaves NO principal record, so the disjunct's durable
    // HUMAN conjunct is the only thing standing between an agent and the release command.
    expect((await harness.send(credential)).body).toMatchObject(FENCED);
    expect(harness.counts).toEqual(NO_EFFECTS);
  }, 30_000);

  it("refuses an unknown credential at AUTHENTICATE", async () => {
    const harness = await harnessOf();
    await harness.pair("session-release-present");
    expect((await harness.send("release-authorization-unknown-credential")).body)
      .toMatchObject({
        httpStatus: 401, outcome: "REFUSED", stage: "AUTHENTICATE",
        error: { code: "AUTHENTICATION_FAILED" },
      });
    expect(harness.counts).toEqual(NO_EFFECTS);
  }, 30_000);

  it("refuses a CLOSED paired ADMIN credential at AUTHENTICATE", async () => {
    const harness = await harnessOf();
    const browser = await harness.pair("session-release-closing");
    expect((await harness.send(browser.credential)).body).toMatchObject(AUTHORIZED);

    // Closed through the production session command by the operator, not by writing rows.
    const live = readSessionLedger(harness.store, harness.projectId)
      .sessions.get(browser.principalId);
    expect(live).toBeDefined();
    const closed = await harness.command("session.close", OPERATOR_CREDENTIAL, {
      sessionId: browser.principalId,
    }, { expectedVersion: live?.version, targetAggregateId: browser.principalId });
    expect(closed.body).toMatchObject({ outcome: "ACCEPTED" });

    expect((await harness.send(browser.credential)).body).toMatchObject({
      httpStatus: 401, outcome: "REFUSED", stage: "AUTHENTICATE",
      error: { code: "AUTHENTICATION_FAILED" },
    });
    expect(harness.counts).toEqual(NO_EFFECTS);
  }, 30_000);

  it("refuses a paired ADMIN credential at EXACT expiry, at AUTHENTICATE", async () => {
    const harness = await harnessOf();
    const browser = await harness.pair("session-release-expiring");
    expect((await harness.send(browser.credential)).body).toMatchObject(AUTHORIZED);

    harness.advanceMs(SESSION_TTL_MS);
    expect((await harness.send(browser.credential)).body).toMatchObject({
      httpStatus: 401, outcome: "REFUSED", stage: "AUTHENTICATE",
      error: { code: "AUTHENTICATION_FAILED" },
    });
  }, 30_000);

  it("refuses a credential minted in ANOTHER project's daemon at AUTHENTICATE", async () => {
    const mine = await harnessOf();
    const theirs = await harnessOf({ projectId: "project-release-authorization-other" });
    const foreign = await theirs.pair("session-release-foreign");

    expect((await mine.send(foreign.credential)).body).toMatchObject({
      httpStatus: 401, outcome: "REFUSED", stage: "AUTHENTICATE",
      error: { code: "AUTHENTICATION_FAILED" },
    });
    expect(mine.counts).toEqual(NO_EFFECTS);
  }, 30_000);

  it("does NOT extend the disjunct to a wrong-project principal at the command boundary",
    async () => {
      const harness = await harnessOf();
      const browser = await harness.pair("session-release-boundary-human");
      const refusal = await refusalOf(boundaryEntry(harness.store)(boundaryInput({
        capabilities: [...ADMIN_AND_GOAL], principalId: browser.principalId,
        projectId: "project-somewhere-else",
      })));
      expect(refusal.code).toBe("OPERATOR_PRINCIPAL_REQUIRED");
      expect(refusal.layer).toBe("DAEMON_AUTHORIZATION");
      expect(refusal.httpStatus).toBe(403);
    }, 30_000);

  it("keeps RELEASE_PROJECT_MISMATCH for the CONFIGURED operator on a wrong project",
    async () => {
      const harness = await harnessOf();
      const refusal = await refusalOf(boundaryEntry(harness.store)(boundaryInput({
        capabilities: [...ADMIN_AND_GOAL], principalId: OPERATOR,
        projectId: "project-somewhere-else",
      })));
      expect(refusal.code).toBe("RELEASE_PROJECT_MISMATCH");
      expect(refusal.layer).toBe("DAEMON_COMMAND_SEAM");
      expect(refusal.httpStatus).toBe(403);
    }, 30_000);

  it("fails CLOSED when the durable principal read throws", async () => {
    const harness = await harnessOf();
    const browser = await harness.pair("session-release-throwing");
    const throwing = new Proxy(harness.store, {
      get(target, property, receiver) {
        if (property === "readEvents") {
          return () => { throw new Error("PRINCIPAL_READ_UNAVAILABLE"); };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    }) as SqliteEventStore;
    const refusal = await refusalOf(boundaryEntry(throwing)(boundaryInput({
      capabilities: [...ADMIN_AND_GOAL], principalId: browser.principalId, projectId: PROJECT,
    })));
    expect(refusal.code).toBe("OPERATOR_PRINCIPAL_REQUIRED");
    expect(refusal.layer).toBe("DAEMON_AUTHORIZATION");
    expect(refusal.httpStatus).toBe(403);
  }, 30_000);
});

describe("release.decide authorization on an UNCONFIGURED daemon", () => {
  it("lets an authorized paired ADMIN reach the honest missing-composition refusal",
    async () => {
      const harness = await harnessOf({ composed: false });
      const browser = await harness.pair("session-release-unconfigured-admin");
      expect((await harness.send(browser.credential)).body).toMatchObject({
        outcome: "PORT_REFUSED", stage: "DISPATCH",
        refusal: { code: "RELEASE_PR_FAILED", layer: "RUNNER_WORKSPACE" },
      });
    }, 30_000);

  it("still stops an unauthorized paired human at AUTHORIZATION, before that refusal",
    async () => {
      const harness = await harnessOf({ capabilities: [CAPABILITIES.GOAL], composed: false });
      const browser = await harness.pair("session-release-unconfigured-no-admin");
      expect((await harness.send(browser.credential)).body).toMatchObject(FENCED);
    }, 30_000);
});

describe("release.decide replay keeps the actual actor's identity", () => {
  it("replays the SAME actor's refusal under the SAME durable key", async () => {
    const harness = await harnessOf();
    const browser = await harness.pair("session-release-replay");
    const commandId = "cmd-release-replay";

    expect((await harness.send(browser.credential, { commandId })).body)
      .toMatchObject(AUTHORIZED);
    expect((await harness.send(browser.credential, { commandId })).body)
      .toMatchObject(AUTHORIZED);
    expect(decisionFor(harness, commandId, browser.principalId)).toMatchObject({
      commandKind: RELEASE_DECIDE_COMMAND_KIND,
    });
    expect(decisionFor(harness, commandId, OPERATOR)).toBe(null);
    expect(harness.counts).toEqual(NO_EFFECTS);
  }, 30_000);

  it("refuses the SAME replay at AUTHENTICATE once the credential expires", async () => {
    const harness = await harnessOf();
    const browser = await harness.pair("session-release-replay-expiry");
    const commandId = "cmd-release-replay-expiry";
    expect((await harness.send(browser.credential, { commandId })).body)
      .toMatchObject(AUTHORIZED);

    harness.advanceMs(SESSION_TTL_MS);
    expect((await harness.send(browser.credential, { commandId })).body).toMatchObject({
      httpStatus: 401, outcome: "REFUSED", stage: "AUTHENTICATE",
      error: { code: "AUTHENTICATION_FAILED" },
    });
  }, 30_000);

  it("denies a SECOND minted human the first actor's decision record", async () => {
    const harness = await harnessOf();
    const first = await harness.pair("session-release-first");
    const second = await harness.pair("session-release-second");
    expect(second.principalId).not.toBe(first.principalId);
    const commandId = "cmd-release-contested";

    expect((await harness.send(first.credential, { commandId })).body).toMatchObject(AUTHORIZED);
    // The second actor has no record under its OWN key, so it re-enters admission and meets
    // the shared intent journal -- whose request bytes embed the FIRST actor's principal id.
    // The mismatch is the point: request identity is derived from the ACTUAL caller, so a
    // second human can neither inherit the first's answer nor overwrite its record.
    expect((await harness.send(second.credential, { commandId })).body).toMatchObject({
      httpStatus: 409, outcome: "PORT_REFUSED", stage: "DISPATCH",
      refusal: { code: "RELEASE_COMMAND_BYTES_CONFLICT", layer: "DAEMON_COMMAND_SEAM" },
    });
    expect(decisionFor(harness, commandId, second.principalId)).toBe(null);
  }, 30_000);
});

describe("release.decide classification is untouched by this widening", () => {
  it("keeps release.decide operator-classified AND MCP-excluded", () => {
    // Removing the kind from OPERATOR_PRINCIPAL_KINDS would open the MCP fence too, because
    // MCP_EXCLUDED_COMMAND_KINDS derives from it. `mcp-tool-allowlist.test.ts` owns the
    // bidirectional served/excluded set-equality; this arm pins only the two memberships.
    expect(OPERATOR_PRINCIPAL_KINDS.has(RELEASE_DECIDE_COMMAND_KIND)).toBe(true);
    expect(MCP_EXCLUDED_COMMAND_KINDS).toContain(RELEASE_DECIDE_COMMAND_KIND);
  });

  it("does NOT widen a DIFFERENT operator kind for the same paired ADMIN", async () => {
    const harness = await harnessOf();
    const browser = await harness.pair("session-release-negative-control");
    // `goal.close` needs GOAL, which this principal HOLDS, so an earlier capability refusal
    // cannot stand in for the operator fence being the thing that answers.
    expect(browser.capabilities).toContain(CAPABILITIES.GOAL);
    const reply = await harness.command("goal.close", browser.credential, {
      closureWitness: "release-authorization-witness", goalId: GOAL_ID,
      zeroAuthorityWitness: "release-authorization-zero-authority",
    }, { targetAggregateId: GOAL_ID });
    // The SAME fence shape release spends -- code, layer and stage -- so this arm goes red if
    // the widening ever leaks to another operator kind, or if the layer regresses.
    expect(reply.body).toMatchObject(FENCED);
  }, 30_000);
});
