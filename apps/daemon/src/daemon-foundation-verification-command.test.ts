import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { storedRecipe } from "./evidence/foundation-verification-store.js";
import { derivedRecipeAggregateId } from "./evidence/recipe-seal-composition.js";
import { VERIFICATION_CATALOG_VERSION } from "./evidence/verification-catalog-contracts.js";
import { REVISION_ID, probeFor }
  from "./provider-profile/provider-runtime-observation-test-fixtures.js";
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

/**
 * THE OUTER EDGE: served kind -> recipe seal composition.
 *
 * `recipe-seal-composition.test.ts` proves the INNER edge (composition ->
 * sealRecipe) by grepping production sources for the call. That arm is blind to
 * whether anything served imports the composition at all: delete the seal block
 * from the handler and the composition becomes an orphan with zero production
 * importers while every content grep still passes. Reported by QA in
 * comment-36ba55e9c14e49c194864182eb12fed5, and this is the arm that closes it.
 *
 * It is BEHAVIOURAL, not structural, so it cannot be satisfied by a spelling:
 * it drives `foundation.verification` through the shipped registry and asserts a
 * durable RECIPE_SEALED row appeared, carrying the operator's configured argv.
 */
const SEAL_PROJECT = "proj-foundation-verification-seal";
const SEAL_CAPABILITY = "daemon-verification";
const SEAL_ARGV = ["pnpm", "--filter", "@moe/daemon", "test"];

const sealDirectory = mkdtempSync(join(tmpdir(), "moe-verification-seal-edge-"));
const sealStorePath = join(sealDirectory, "store.db");
const sealCatalogPath = join(sealDirectory, "verification-catalog.json");

const sealSetup = SqliteEventStore.openForProject(sealStorePath, SEAL_PROJECT);
installTestRecoveryBinding(sealSetup);
sealSetup.close();

writeFileSync(sealCatalogPath, JSON.stringify({
  catalogVersion: VERIFICATION_CATALOG_VERSION,
  entries: [{
    argv: SEAL_ARGV, capability: SEAL_CAPABILITY, profileRevisionId: REVISION_ID,
    projectId: SEAL_PROJECT,
  }],
}), "utf8");

const sealProvider = createStoreDependencies({
  clock: (): string => DECIDED_AT,
  credential: CREDENTIAL,
  principalId: "operator-local",
  projectId: SEAL_PROJECT,
  storePath: sealStorePath,
  verificationCatalogPath: sealCatalogPath,
});
const sealDeps = sealProvider.provide();

afterAll(() => {
  sealProvider.close();
  rmSync(sealDirectory, { force: true, recursive: true });
});

const admin = (): AuthenticatedPrincipal => ({
  capabilities: [CAPABILITIES.ADMIN], principalId: "operator-local", projectId: SEAL_PROJECT,
});

/** The registry's own kind union, so a kind it does not serve is unrepresentable. */
type ServedKind = Parameters<typeof sealDeps.registry.get>[0];

/** Drives a bootstrap kind through the SAME registry the verification kind is served by. */
function bootstrap(kind: ServedKind, payload: Readonly<Record<string, unknown>>): void {
  const entry = sealDeps.registry.get(kind);
  if (entry === undefined) throw new Error(`${kind} is not registered`);
  entry.handler({
    envelope: {
      commandId: `cmd-${kind}`,
      commandKind: kind,
      correlationId: "corr-seal-edge",
      expectedVersion: 0,
      payload: payload as RuntimeCommandEnvelope["payload"],
      requestDigest: "c".repeat(64),
      schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: CREDENTIAL,
      targetAggregateId: `${SEAL_PROJECT}-provider`,
    },
    principal: admin(),
  });
}

describe("the served kind reaches the recipe seal (task-143cad76)", () => {
  it("seals the configured recipe on the way to verifying, from the served handler", async () => {
    bootstrap("project.register", { owner: "owner-1" });
    bootstrap("provider.probe", probeFor().payload);

    const recipeAggregateId = derivedRecipeAggregateId(SEAL_PROJECT, SEAL_CAPABILITY);
    const entry = sealDeps.registry.get(FOUNDATION_VERIFICATION_COMMAND_KIND);
    // The verification itself REFUSES: no attempt was ever dispatched. That is the
    // point - the seal has to have happened on the way there, before the refusal.
    await expect(entry?.asyncHandler?.({
      envelope: {
        commandId: "cmd-seal-edge",
        commandKind: FOUNDATION_VERIFICATION_COMMAND_KIND,
        correlationId: "corr-seal-edge",
        expectedVersion: 0,
        payload: {
          attemptAggregateId: ABSENT_ATTEMPT,
          candidateRoot: sealDirectory,
          expectedRecordDigest: "b".repeat(64),
          recipeAggregateId,
          verificationId: "verification-seal-edge",
        },
        requestDigest: "a".repeat(64),
        schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
        sessionCredential: CREDENTIAL,
        targetAggregateId: "agg-verification",
      },
      principal: {
        capabilities: [WORK], principalId: "operator-local", projectId: SEAL_PROJECT,
      },
    })).rejects.toBeInstanceOf(DomainRefusal);

    const reader = SqliteEventStore.openForProject(sealStorePath, SEAL_PROJECT);
    try {
      const sealed = storedRecipe(reader, recipeAggregateId);
      if (sealed === null || "ok" in sealed) {
        throw new Error("the served handler left no durable RECIPE_SEALED row");
      }
      // The operator's configured vector, read back off the durable seal: this
      // is what an orphaned composition can never produce.
      expect([...sealed.recipe.argv]).toEqual(SEAL_ARGV);
    } finally {
      reader.close();
    }
  });
});

describe("no catalog means no recipe, never an invented one (task-143cad76)", () => {
  it("seals nothing when no catalog is configured, and writes no row for the identity", async () => {
    // The provider in the first describe has NO verificationCatalogPath. The seal
    // seam is therefore a REFUSING state, not a skipped one: the handler must
    // leave the derived identity empty rather than materialize a placeholder.
    //
    // What this arm does NOT claim: that the seal's refusal is what the caller
    // sees. It is not, and the reason is ordering - `service.verify` reaches the
    // ATTEMPT record before the recipe, so with no attempt dispatched the answer
    // is FOUNDATION_ATTEMPT_RECORD_ABSENT under DAEMON_FOUNDATION_ATTEMPT. The
    // recipe refusal (FOUNDATION_VERIFICATION_RECIPE_UNRESOLVED under
    // DAEMON_VERIFICATION_IDENTITY) surfaces only once the attempt exists, which
    // is evidence/foundation-verification-service.test.ts's ground to cover.
    const unsealable = derivedRecipeAggregateId(PROJECT, SEAL_CAPABILITY);
    await expect(entryOf().asyncHandler?.({
      envelope: envelopeOf("cmd-unconfigured-catalog", {
        ...request(), recipeAggregateId: unsealable,
      }),
      principal: operator(),
    })).rejects.toMatchObject({
      code: "FOUNDATION_ATTEMPT_RECORD_ABSENT",
      layer: "DAEMON_FOUNDATION_ATTEMPT",
    });

    const reader = SqliteEventStore.openForProject(storePath, PROJECT);
    try {
      // Fail-closed, checked on the durable side: no catalog, no seal, no row -
      // and in particular no placeholder recipe minted to keep the path moving.
      expect(storedRecipe(reader, unsealable)).toBeNull();
    } finally {
      reader.close();
    }
  });
});
