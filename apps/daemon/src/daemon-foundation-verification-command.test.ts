import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { RuntimeCommandEnvelope } from "@moe/contracts";
import { SqliteEventStore } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";

import { DomainRefusal } from "./daemon-command-dispatch.js";
import {
  CAPABILITIES, OPERATOR_PRINCIPAL_KINDS, PAYLOAD_KEYS, agentCapabilitiesFor,
} from "./daemon-command-vocabulary.js";
import { FOUNDATION_VERIFICATION_RESULT_CODE } from "./daemon-foundation-verification-command.js";
import { createStoreDependencies } from "./daemon-store-dependencies.js";
import {
  FOUNDATION_VERIFICATION_COMMAND_KIND, FOUNDATION_VERIFICATION_REQUEST_KEYS,
} from "./evidence/foundation-verification-contracts.js";
import { deriveVerificationAggregateId } from "./evidence/foundation-verification-service.js";
import { handleAsyncCommandRequest, handleCommandRequest } from "./http/http-adapter.js";
import { ASYNC_ENTRY_REQUIRED_CODE, DAEMON_COMMAND_SEAM } from "./http/http-async-contract.js";
import type { AuthenticatedPrincipal } from "./http/http-contract.js";
import { WIRE_PROTOCOL_VERSION } from "./http/http-contract.js";
import { installTestRecoveryBinding } from "./identity/session-test-fixtures.js";

/**
 * `foundation.verification` as the production registry actually serves it. Every case
 * below drives the SHIPPED composition — `createStoreDependencies(...).provide()` over a
 * real file-backed store — so nothing here can pass against a hand-built entry.
 *
 * The heavy accepted path (sealed recipe -> PROVEN attempt -> real verifier process ->
 * receipt) belongs to `evidence/foundation-verification-service.test.ts` and is NOT
 * restated. What this file proves is ROUTING: the caller reaches
 * `createFoundationVerificationService` and its refusals arrive with the ORIGINATING
 * authority's own code and layer, never re-stamped by the seam.
 */

const WORK = "work.write";
const CREDENTIAL = "verification-operator-credential";
const PROJECT = "proj-foundation-verification-command";
const DECIDED_AT = "2026-08-18T12:00:00.000Z";
/** The absent-attempt identity every refusal case names: nothing is ever written for it. */
const ABSENT_ATTEMPT = "attempt-never-dispatched";
const VERIFICATION_ID = "verification-routing-probe";

const directory = mkdtempSync(join(tmpdir(), "moe-foundation-verification-command-"));
const storePath = join(directory, "store.db");

const setupStore = SqliteEventStore.openForProject(storePath, PROJECT);
installTestRecoveryBinding(setupStore);
setupStore.close();

const provider = createStoreDependencies({
  clock: (): string => DECIDED_AT,
  credential: CREDENTIAL,
  principalId: "operator-local",
  projectId: PROJECT,
  storePath,
});
const deps = provider.provide();

afterAll(() => {
  provider.close();
  rmSync(directory, { force: true, recursive: true });
});

const entryOf = (): NonNullable<ReturnType<typeof deps.registry.get>> => {
  const entry = deps.registry.get(FOUNDATION_VERIFICATION_COMMAND_KIND);
  if (entry === undefined) throw new Error("FOUNDATION_VERIFICATION_ENTRY_ABSENT");
  return entry;
};

/** The five identities, all non-empty, naming durable state that does not exist. */
const request = (): Readonly<Record<string, string>> => Object.freeze({
  attemptAggregateId: ABSENT_ATTEMPT,
  candidateRoot: directory,
  expectedRecordDigest: "b".repeat(64),
  recipeAggregateId: "recipe-never-sealed",
  verificationId: VERIFICATION_ID,
});

const envelopeOf = (
  commandId: string, payload: Readonly<Record<string, unknown>>,
): RuntimeCommandEnvelope => ({
  commandId,
  commandKind: FOUNDATION_VERIFICATION_COMMAND_KIND,
  correlationId: "corr-verification",
  expectedVersion: 0,
  payload: payload as RuntimeCommandEnvelope["payload"],
  requestDigest: "a".repeat(64),
  schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
  sessionCredential: CREDENTIAL,
  targetAggregateId: "agg-verification",
});

const bodyOf = (
  commandId: string, payload: Readonly<Record<string, unknown>>,
): Uint8Array => new TextEncoder().encode(JSON.stringify(envelopeOf(commandId, payload)));

const operator = (): AuthenticatedPrincipal =>
  ({ capabilities: [WORK], principalId: "operator-local", projectId: PROJECT });

interface DurableCounts {
  readonly decisions: number;
  readonly events: number;
}

function counts(): DurableCounts {
  const reader = SqliteEventStore.openForProject(storePath, PROJECT);
  try {
    let events = 0;
    try { events = reader.readEvents(deriveVerificationAggregateId(VERIFICATION_ID)).length; }
    catch { events = 0; }
    return {
      decisions: reader.readCommandDecisionsAfter(0n, 1_000).items.length,
      events,
    };
  } finally {
    reader.close();
  }
}

describe("foundation.verification is reachable from the production registry", () => {
  it("is admitted with an async handler, the contracts tuple and WORK authority", () => {
    const entry = entryOf();
    expect(entry.asyncHandler).toBeDefined();
    // IDENTITY, not deep equality: a hand-retyped copy of the five keys would satisfy
    // `toEqual` while detaching the seam's allow-list from its owning contract.
    expect(entry.payloadKeys).toBe(FOUNDATION_VERIFICATION_REQUEST_KEYS);
    expect(PAYLOAD_KEYS[FOUNDATION_VERIFICATION_COMMAND_KIND])
      .toBe(FOUNDATION_VERIFICATION_REQUEST_KEYS);
    expect(entry.requiredCapability).toBe(CAPABILITIES.WORK);
    expect(entry.kind).toBe(FOUNDATION_VERIFICATION_COMMAND_KIND);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(FOUNDATION_VERIFICATION_RESULT_CODE).toBe("FOUNDATION_VERIFICATION_RECORDED");
  });

  it("hands an agent WORK alone and is not gated behind the operator principal", () => {
    const capabilities = agentCapabilitiesFor(FOUNDATION_VERIFICATION_COMMAND_KIND);
    expect(capabilities).toEqual([WORK]);
    expect(Object.isFrozen(capabilities)).toBe(true);
    expect(OPERATOR_PRINCIPAL_KINDS.has(FOUNDATION_VERIFICATION_COMMAND_KIND)).toBe(false);
  });

  it("refuses the synchronous entry from the seam, naming the seam as the layer", () => {
    // The registered synchronous handler, called directly: it refuses rather than
    // inventing a decision for a verification that has not run.
    let thrown: unknown = null;
    try { entryOf().handler({ envelope: envelopeOf("cmd-sync", request()), principal: operator() }); }
    catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(DomainRefusal);
    const refusal = thrown as DomainRefusal;
    expect(refusal.code).toBe(ASYNC_ENTRY_REQUIRED_CODE);
    expect(refusal.layer).toBe(DAEMON_COMMAND_SEAM);
    expect(refusal.httpStatus).toBe(422);

    // And on the shipped synchronous transport the SEAM answers first, so the code
    // above is unreachable in production: which layer refused is pinned, not assumed.
    expect(handleCommandRequest(deps, {
      body: bodyOf("cmd-sync-entry", request()),
      credential: CREDENTIAL,
      protocolVersion: WIRE_PROTOCOL_VERSION,
    })).toMatchObject({
      httpStatus: 422,
      ok: false,
      outcome: "PORT_REFUSED",
      refusal: { code: ASYNC_ENTRY_REQUIRED_CODE, layer: DAEMON_COMMAND_SEAM },
      stage: "DISPATCH",
    });
  });

  it("refuses a smuggled key at the allow-list and commits nothing", async () => {
    const before = counts();
    const answered = await handleAsyncCommandRequest(deps, {
      body: bodyOf("cmd-smuggled", { ...request(), smuggled: true }),
      credential: CREDENTIAL,
      protocolVersion: WIRE_PROTOCOL_VERSION,
    });
    // The INGRESS refuses, above the service: `INPUT_INVALID` at `PAYLOAD_SHAPE`, not the
    // service's request code. Two layers can refuse a bad payload; this names which one.
    expect(answered).toMatchObject({
      error: { code: "INPUT_INVALID" },
      httpStatus: 400,
      ok: false,
      outcome: "REFUSED",
      stage: "PAYLOAD_SHAPE",
    });
    expect(counts()).toEqual(before);
  });

  it("carries the attempt store's own code and layer out of the async handler", async () => {
    // Only the real `createFoundationVerificationService` speaks this pair: the seam has
    // no FOUNDATION_ATTEMPT vocabulary, so the code arriving here proves the routing.
    await expect(entryOf().asyncHandler?.({
      envelope: envelopeOf("cmd-absent-direct", request()),
      principal: operator(),
    })).rejects.toMatchObject({
      code: "FOUNDATION_ATTEMPT_RECORD_ABSENT",
      layer: "DAEMON_FOUNDATION_ATTEMPT",
    });
  });

  it("surfaces that same refusal verbatim through the asynchronous transport", async () => {
    const before = counts();
    expect(await handleAsyncCommandRequest(deps, {
      body: bodyOf("cmd-absent-entry", request()),
      credential: CREDENTIAL,
      protocolVersion: WIRE_PROTOCOL_VERSION,
    })).toMatchObject({
      httpStatus: 422,
      ok: false,
      outcome: "PORT_REFUSED",
      refusal: { code: "FOUNDATION_ATTEMPT_RECORD_ABSENT", layer: "DAEMON_FOUNDATION_ATTEMPT" },
      stage: "DISPATCH",
    });
    // An unproven identity leaves no receipt and no verification history behind.
    expect(counts().events).toBe(before.events);
  });

  it("refuses an incomplete request with the service's own request code", async () => {
    // Every listed key is permitted, so the ingress passes and the SERVICE answers:
    // its request authority, not the seam's, decides that an identity is missing.
    await expect(entryOf().asyncHandler?.({
      envelope: envelopeOf("cmd-empty", {}),
      principal: operator(),
    })).rejects.toMatchObject({
      code: "FOUNDATION_VERIFICATION_REQUEST_MALFORMED",
      layer: "DAEMON_VERIFICATION_REQUEST",
    });
  });

  it("reads the authenticated principal on every call, never a build-time one", async () => {
    // The service commits under the CALLER's identity, so the handler must construct it
    // per call. A hardcoded principal, or one captured when the handler was built, reads
    // this getter zero times.
    const reads: string[] = [];
    const spying = (principalId: string): AuthenticatedPrincipal => ({
      capabilities: [WORK],
      get principalId(): string {
        reads.push(principalId);
        return principalId;
      },
      projectId: PROJECT,
    });
    const handler = entryOf().asyncHandler;
    for (const who of ["agent-first", "agent-second"]) {
      await expect(handler?.({
        envelope: envelopeOf(`cmd-principal-${who}`, request()),
        principal: spying(who),
      })).rejects.toBeInstanceOf(DomainRefusal);
    }
    expect(reads).toEqual(["agent-first", "agent-second"]);
  });
});
