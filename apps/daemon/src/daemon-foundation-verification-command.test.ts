import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { RuntimeCommandEnvelope } from "@moe/contracts";
import { CLAUDE_LAUNCHER_VERSION, buildInputManifest, observeScope } from "@moe/runner";
import type { GitObserver, ScopeObservation } from "@moe/runner";
import { SqliteEventStore } from "@moe/store";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  ACTIVATION_INGRESS_SCHEMA_VERSION, EFFECT_ACTIVATE_COMMAND_KIND,
} from "./activation/activation-ingress-contracts.js";
import { runEffectActivateCommand } from "./activation/activation-ingress.js";
import { deriveActivationAggregateId } from "./activation/activation-ledger-contracts.js";
import { readFoundationActivationHistory } from "./activation/activation-ledger-reader.js";
import { createFoundationLauncherAuthority } from "./activation/foundation-launch-authority.js";
import { send as sendBootstrapCommand } from "./bootstrap/bootstrap-test-fixtures.js";
import { DomainRefusal } from "./daemon-command-dispatch.js";
import {
  CAPABILITIES, OPERATOR_PRINCIPAL_KINDS, PAYLOAD_KEYS, agentCapabilitiesFor,
} from "./daemon-command-vocabulary.js";
import {
  FOUNDATION_VERIFICATION_RESULT_CODE, createFoundationVerificationHandler,
} from "./daemon-foundation-verification-command.js";
import { createStoreDependencies } from "./daemon-store-dependencies.js";
import {
  PRINCIPAL_ID as HARNESS_PRINCIPAL_ID, PROJECT_ID as HARNESS_PROJECT_ID,
  cleanupRestoreHarnesses, openHarnessStore, seedReadyProject,
} from "./recovery/restore-test-harness.js";
import {
  FOUNDATION_RESERVATION_VERSION, deriveDispatchAggregateId,
} from "./work/foundation-attempt-contracts.js";
import type { FoundationAttemptBound } from "./work/foundation-attempt-contracts.js";
import { encodeFoundationPayload } from "./work/foundation-attempt-codec.js";
import {
  commitFoundationPhase, readDurableFoundationObservation, readFoundationAttemptRecord,
  recordProvenFoundationAttempt,
} from "./work/foundation-attempt-store.js";
import {
  CANDIDATE_TREE_BASE_PATH, candidateTreeEntries, materializeCandidateTree,
} from "./evidence/foundation-verification-tree-fixtures.js";
import type { CandidateTree } from "./evidence/foundation-verification-tree-fixtures.js";
import {
  FOUNDATION_VERIFICATION_COMMAND_KIND, FOUNDATION_VERIFICATION_REQUEST_KEYS,
} from "./evidence/foundation-verification-contracts.js";
import { deriveVerificationAggregateId } from "./evidence/foundation-verification-service.js";
import { storedRecipe } from "./evidence/foundation-verification-store.js";
import { derivedRecipeAggregateId } from "./evidence/recipe-seal-composition.js";
import { VERIFICATION_CATALOG_VERSION } from "./evidence/verification-catalog-contracts.js";
import { REVISION_ID, probeFor, validDraft }
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

/**
 * CATALOG ARGV DRIFT MUST REFUSE, NOT VERIFY THE STALE SEAL.
 *
 * The recipe identity is a pure function of (projectId, capability) — argv is
 * deliberately NOT an input, so an operator editing the catalog's argv for an
 * already-sealed pair drives `sealNamed` into its RECIPE_CONFLICT arm. If the
 * handler swallows that answer, `service.verify` cannot see it — the durable
 * seal still resolves, still re-derives, and still runs — so the command
 * executes the OLD argv and mints a receipt: drift reads as success, the exact
 * failure the conflict arm exists to prevent.
 *
 * This arm needs what no other case in this file needs: a PROVEN durable
 * attempt, so that pre-fix the verification actually SUCCEEDS over the stale
 * argv. The only route to one is the production chain over the restore
 * harness's seeded world (activation ingress -> launcher authority -> durable
 * attempt writer), which is bound to the harness's own project identity — so
 * this arm builds the handler DIRECTLY from the module the registry composes,
 * over one file-backed harness store. The routing describes above already pin
 * that the shipped registry serves exactly this handler.
 */
const DRIFT_CAPABILITY = "daemon-verification-drift";
const DRIFT_REVISION = "profile-revision-drift";
const DRIFT_DECIDED_AT = "2026-08-15T00:00:00.000Z";
const DRIFT_SESSION = "session-1";
const DRIFT_DIGEST = "a".repeat(64);
const DRIFT_DIGEST_A = "2".repeat(64), DRIFT_DIGEST_B = "3".repeat(64), DRIFT_DIGEST_C = "4".repeat(64);

const driftEncoder = new TextEncoder();
const driftRoots: string[] = [];

// Closes the harness store this arm opens (a held SQLite handle kills the
// worker); a no-op for every other case in this file, whose stores are its own.
afterEach(cleanupRestoreHarnesses);
afterAll(() => {
  while (driftRoots.length > 0) {
    const root = driftRoots.pop();
    // 20x250ms: one root holds a real Git repository and the other a SQLite
    // file; a trailing win32 handle turns short retries into a leaked directory.
    if (root !== undefined) {
      rmSync(root, { force: true, maxRetries: 20, recursive: true, retryDelay: 250 });
    }
  }
});

const DRIFT_LEASE_RECORD = {
  authorityHashRef: DRIFT_DIGEST, bootId: "boot-1", epoch: 3, kind: "ASSIGNMENT",
  leaseId: "lease-1", leaseToken: "token-1", monotonicObservation: 500,
  ownerSessionRef: DRIFT_SESSION, serverWallDeadline: 1_000, state: "ACTIVE", version: 7,
} as const;
const DRIFT_LEASE_PROOF = {
  authorityHashRef: DRIFT_DIGEST, epoch: 3, expectedVersion: 7, leaseToken: "token-1",
  ownerSessionRef: DRIFT_SESSION,
} as const;
const DRIFT_RESOURCE_ROW = {
  capacityUnits: 1, effectIntentRef: "intent-ref-1", epoch: 1, external: false, fenceable: true,
  resourceId: "res-1", state: "ACTIVE",
} as const;
const DRIFT_OBSERVATION = Object.freeze({
  activationDigest: DRIFT_DIGEST, completedAt: "2026-08-15T00:00:02.000Z",
  consumedGrantDigest: DRIFT_DIGEST_A, effectDigest: DRIFT_DIGEST_B,
  exit: { code: 0, kind: "EXITED" }, freshRuntimeDigest: DRIFT_DIGEST_C, grantId: "grant-x",
  launcherVersion: "moe-claude-launcher/1", lockIdentity: "lock-1",
  observationDigest: DRIFT_DIGEST_A, pinnedClosureDigest: DRIFT_DIGEST_B,
  processIdentity: "windows:4242:99", quotedRuntimeDigest: DRIFT_DIGEST, reasonCode: null,
  reasonLayer: null, registrationDigest: DRIFT_DIGEST_C, runtimeBindingDigest: DRIFT_DIGEST,
  startedAt: "2026-08-15T00:00:01.000Z", stderr: { sha256: DRIFT_DIGEST_B },
  stdout: { sha256: DRIFT_DIGEST_A }, truthClass: "PROVEN", wrapperIdentity: "wrapper-1",
});
const DRIFT_REGISTRATION = Object.freeze({
  bootstrapCredentialDigest: DRIFT_DIGEST_B, lockIdentity: "lock-1",
  processIdentity: "windows:4242:99", registeredAt: "2026-08-15T00:00:01.000Z",
  wrapperIdentity: "wrapper-1",
});

function driftNested(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const found = value[key];
  if (typeof found !== "object" || found === null || Array.isArray(found)) {
    throw new TypeError(`${key} is not a record`);
  }
  return found as Record<string, unknown>;
}

/** Label-derived so the intent, aggregate and grant are this arm's own. */
function driftActivationBytes(label: string): Uint8Array {
  const intentId = `intent-${label}`;
  return driftEncoder.encode(JSON.stringify({
    commandId: `cmd-${label}`, correlationId: `corr-${label}`, decidedAt: DRIFT_DECIDED_AT,
    expectedVersion: 0, kind: EFFECT_ACTIVATE_COMMAND_KIND,
    payload: structuredClone({
      activation: {
        attempt: {
          aggregateId: `agg-${label}`, attemptId: `attempt-${label}`, intentId,
          state: "LAUNCH_REQUESTED", version: 0,
        },
        claim: {
          claimId: `claim-${label}`, claimedAt: DRIFT_DECIDED_AT, intentId,
          lockIdentity: "lock-1", wrapperIdentity: "wrapper-1",
        },
        dependencyWitnesses: [], desiredState: "ACTIVE", leaseProof: DRIFT_LEASE_PROOF,
        lockIdentity: "lock-1", observedGraphEpoch: 4, observedRuntimeDigest: DRIFT_DIGEST,
        tombstone: null, wrapperIdentity: "wrapper-1",
      },
      effect: {
        command: { kind: "claim" },
        intent: {
          aggregateId: `agg-${label}`, desiredState: "ACTIVE", expectedGraphEpoch: 4,
          idempotencyKey: `idem-${label}`, inputBinding: DRIFT_DIGEST, intentId,
          leaseBinding: DRIFT_LEASE_RECORD, predecessorCursor: "cursor-1",
          protocolVersion: "moe-effect-intent/1", runtimeObservationDigest: DRIFT_DIGEST,
          state: "PENDING", version: 0,
        },
      },
      lease: { proof: DRIFT_LEASE_PROOF, record: DRIFT_LEASE_RECORD },
      liveClaims: [{ dimension: "default", slotRef: "held-0", state: "RESERVED" }],
      slot: { dimension: "default", requestId: "req-1", rows: [DRIFT_RESOURCE_ROW], slotRef: "slot-1" },
    }),
    principalId: HARNESS_PRINCIPAL_ID, projectId: HARNESS_PROJECT_ID,
    schemaVersion: ACTIVATION_INGRESS_SCHEMA_VERSION,
  }));
}

/** The attempt-side observation is a fixture over the tree's REAL head; the
 *  verification-side one is taken by production over the real repository. */
function driftFakeGit(head: string): GitObserver {
  return {
    headCommit: () => head, lsFilesIgnored: () => [], lsFilesTracked: () => [],
    statusPorcelainV2: () => driftEncoder.encode(`# branch.oid ${head}\0`), submodulePaths: () => [],
  };
}

function driftScopeObservation(head: string): ScopeObservation {
  const observed = observeScope({
    baseIdentity: head, declaredScopePaths: ["pkg/src"], gitObserver: driftFakeGit(head),
    observedAt: "2026-08-15T00:00:02Z", observerVersion: "moe-runner-scope-observer/1",
    pathObserver: { exists: () => false, realpath: (path: string) => path },
    worktreeRoot: "fixture-root",
  });
  if (!observed.ok) throw new Error(`scope fixture failed: ${observed.code}`);
  return observed.observation;
}

/** The capture answer the result builder accepts, so the record lands PROVEN. */
function driftCaptureAnswer(tree: CandidateTree): Record<string, unknown> {
  return {
    authoredPaths: ["pkg/src/authored.ts"],
    declaredArtifactRefs: [],
    resultTreeEntries: [
      {
        byteLength: tree.byteLength, kind: "REGULAR", origin: "INHERITED",
        path: CANDIDATE_TREE_BASE_PATH, sha256: tree.sha256,
      },
      {
        byteLength: 4, kind: "REGULAR", origin: "AUTHORED", path: "pkg/src/authored.ts",
        sha256: DRIFT_DIGEST_B,
      },
    ],
    scopeObservation: driftScopeObservation(tree.head),
  };
}

function driftSealedInput(tree: CandidateTree): Record<string, unknown> {
  const built = buildInputManifest({
    baseIdentity: tree.head, entries: candidateTreeEntries(tree) as never,
  });
  if (!built.ok) throw new Error(`input manifest fixture refused: ${built.code}`);
  return built.manifest as unknown as Record<string, unknown>;
}

interface DriftAttempt {
  readonly attemptAggregateId: string;
  readonly candidateRoot: string;
  readonly recordDigest: string;
}

/**
 * A PROVEN durable attempt record over the REAL tree, produced by the
 * production chain only — the same chain `foundation-verification-service.test.ts`
 * drives: activation ingress -> launcher authority -> durable observation ->
 * reservation -> `recordProvenFoundationAttempt`. Nothing here hand-forges an
 * activation; the grant is the one production minted.
 */
function driftProvenAttempt(store: SqliteEventStore, label: string, tree: CandidateTree): DriftAttempt {
  const activationAggregate = deriveActivationAggregateId(`agg-${label}`, `idem-${label}`);
  const activated = runEffectActivateCommand(store, driftActivationBytes(label));
  if (!activated.ok) throw new Error(`activation refused: ${activated.code}`);
  const initial = readFoundationActivationHistory(
    activationAggregate, store.readEvents(activationAggregate), HARNESS_PROJECT_ID);
  if (!initial.ok) throw new Error(`activation unreadable: ${initial.result.status}`);
  const { record } = initial.history;
  const claim = {
    claimId: `claim-${label}`, claimedAt: DRIFT_DECIDED_AT, intentId: `intent-${label}`,
    lockIdentity: "lock-1", wrapperIdentity: "wrapper-1",
  };
  const authority = createFoundationLauncherAuthority({
    aggregateId: activationAggregate, correlationId: `corr-tail-${label}`,
    key: {
      commandId: `cmd-tail-${label}`, principalId: HARNESS_PRINCIPAL_ID,
      projectId: HARNESS_PROJECT_ID,
    },
    projectId: HARNESS_PROJECT_ID, store,
  });
  const consumed = authority.consumeGrantDurably(record.grant, record.grant.wrapperIdentity);
  const grant = driftNested(consumed as Record<string, unknown>, "grant");
  authority.commitProcessRegistration({
    claim, phase: "PREFLIGHT", prior: null,
    registration: {
      ...DRIFT_REGISTRATION, processIdentity: `pending:${record.grant.wrapperIdentity}`,
      registeredAt: "2026-08-15T00:00:00.500Z",
    },
  });
  authority.commitProcessRegistration({
    claim, phase: "STARTED", prior: null, registration: DRIFT_REGISTRATION,
  });
  const bound: FoundationAttemptBound = Object.freeze({
    aggregateId: activationAggregate, claim, commandId: `cmd-dispatch-${label}`,
    correlationId: `corr-dispatch-${label}`, nodeKey: "dev-done",
    principalId: HARNESS_PRINCIPAL_ID, projectId: HARNESS_PROJECT_ID, sessionId: DRIFT_SESSION,
    target: deriveDispatchAggregateId(activationAggregate),
  });
  const value = {
    code: null, consumedGrant: grant, kind: "OBSERVED", layer: null,
    observation: {
      ...DRIFT_OBSERVATION, activationDigest: record.activationDigest,
      grantId: record.grant.grantId, launcherVersion: CLAUDE_LAUNCHER_VERSION,
      lockIdentity: DRIFT_REGISTRATION.lockIdentity,
      processIdentity: DRIFT_REGISTRATION.processIdentity, reasonCode: null, reasonLayer: null,
      truthClass: "PROVEN", wrapperIdentity: DRIFT_REGISTRATION.wrapperIdentity,
    },
    ok: true, registration: { ...DRIFT_REGISTRATION }, truthClass: "PROVEN",
  };
  const observed = readDurableFoundationObservation(store, bound, record, value);
  if (observed === null) throw new Error("durable observation fixture was refused");
  const reservation = encodeFoundationPayload({
    activationDigest: record.activationDigest, attemptAggregateId: bound.aggregateId,
    attemptId: record.attempt.attemptId, grantId: record.grant.grantId, nodeKey: bound.nodeKey,
    recordVersion: FOUNDATION_RESERVATION_VERSION, requestDigest: DRIFT_DIGEST_A,
    sessionId: bound.sessionId,
  });
  if (!reservation.ok) throw new Error("reservation fixture refused");
  const reserved = commitFoundationPhase(
    store, bound, "RESERVED", reservation.bytes, 0, `${record.grant.grantId}:RESERVED`);
  if (reserved === null || reserved.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    throw new Error("reservation fixture was not committed");
  }
  recordProvenFoundationAttempt(store, bound, record, driftSealedInput(tree), {
    answer: driftCaptureAnswer(tree), observation: observed[0], registration: observed[1],
  });
  const stored = readFoundationAttemptRecord(store, activationAggregate);
  if (!stored.ok) throw new Error(`record fixture unreadable: ${stored.code}`);
  return {
    attemptAggregateId: activationAggregate, candidateRoot: tree.root, recordDigest: stored.digest,
  };
}

/**
 * An executable the CATALOG can admit AND the wrapper's launch gate can start:
 * `admitArgv` refuses any element carrying whitespace, a quote or a backslash
 * (the documented space-join must stay lossless), and `process.execPath` on
 * Windows carries both a space and backslashes — so the real node binary is
 * copied to a join-safe absolute path inside this arm's own root. `.exe` is not
 * a shim extension, and a forward-slashed absolute path spawns fine on win32.
 */
function driftVerifierExecutable(root: string): string {
  const target = join(root, process.platform === "win32" ? "node-verifier.exe" : "node-verifier");
  copyFileSync(process.execPath, target);
  chmodSync(target, 0o755);
  return target.replaceAll("\\", "/");
}

/** The handler over the harness store, with the catalog source this arm controls. */
function driftHandlerFor(
  store: SqliteEventStore, argv: readonly string[],
): ReturnType<typeof createFoundationVerificationHandler> {
  return createFoundationVerificationHandler({
    projectId: HARNESS_PROJECT_ID, store,
    verificationCatalogSource: () => ({
      catalogVersion: VERIFICATION_CATALOG_VERSION,
      entries: [{
        argv: [...argv], capability: DRIFT_CAPABILITY, profileRevisionId: DRIFT_REVISION,
        projectId: HARNESS_PROJECT_ID,
      }],
    }),
  });
}

describe("an edited catalog argv for a sealed pair refuses, never verifying the stale seal", () => {
  it("surfaces the seal's RECIPE_CONFLICT instead of minting a receipt over argv A", async () => {
    const root = mkdtempSync(join(tmpdir(), "moe-verification-drift-"));
    driftRoots.push(root);
    const store = openHarnessStore(join(root, "store.db"));
    seedReadyProject(store);
    // The CURRENT probe, under this arm's own revision, WITH a runtime section:
    // the seal composition reads the LATEST ProviderProbed and the seeded one
    // carries no runtime observation at all.
    const probed = sendBootstrapCommand(store, probeFor({
      commandId: "cmd-probe-drift", expectedVersion: 1, profile: validDraft(DRIFT_REVISION),
    }));
    if (!probed.ok) throw new Error(`drift probe refused: ${probed.code}`);

    const tree = materializeCandidateTree("catalog-drift");
    driftRoots.push(tree.root);
    const attempt = driftProvenAttempt(store, "catalog-drift", tree);
    const recipeAggregateId = derivedRecipeAggregateId(HARNESS_PROJECT_ID, DRIFT_CAPABILITY);
    const verifier = driftVerifierExecutable(root);
    // Both catalog-admissible AND genuinely runnable, so that a swallowed
    // conflict has a real receipt to mint pre-fix rather than some other refusal.
    const argvA = Object.freeze([verifier, "-e", "process.exit(0)"]);
    const argvB = Object.freeze([verifier, "-e", "process.exit(3)"]);
    const principal: AuthenticatedPrincipal = {
      capabilities: [WORK], principalId: HARNESS_PRINCIPAL_ID, projectId: HARNESS_PROJECT_ID,
    };

    // Seal the pair from catalog argv A on the way to a refusing verification,
    // exactly as the seal-edge arm above pins: the attempt named here was never
    // dispatched, and the seal has to have happened before that refusal.
    await expect(driftHandlerFor(store, argvA)({
      envelope: envelopeOf("cmd-drift-seal", {
        attemptAggregateId: ABSENT_ATTEMPT, candidateRoot: tree.root,
        expectedRecordDigest: "b".repeat(64), recipeAggregateId,
        verificationId: "verification-drift-seal",
      }),
      principal,
    })).rejects.toMatchObject({ code: "FOUNDATION_ATTEMPT_RECORD_ABSENT" });
    const sealed = storedRecipe(store, recipeAggregateId);
    if (sealed === null || "ok" in sealed) throw new Error("argv A was never durably sealed");
    expect([...sealed.recipe.argv]).toEqual([...argvA]);

    // The operator edits the catalog argv for the SAME (projectId, capability).
    // The identity is unchanged — argv is deliberately not an input to it — so
    // `sealNamed` answers RECIPE_CONFLICT, and the command must surface that
    // answer as its own refusal: a swallowed conflict leaves `service.verify`
    // facing a perfectly resolvable stale seal, which it would happily execute.
    await expect(driftHandlerFor(store, argvB)({
      envelope: envelopeOf("cmd-drift-conflict", {
        attemptAggregateId: attempt.attemptAggregateId, candidateRoot: attempt.candidateRoot,
        expectedRecordDigest: attempt.recordDigest, recipeAggregateId,
        verificationId: "verification-drift-conflict",
      }),
      principal,
    })).rejects.toMatchObject({
      code: "FOUNDATION_VERIFICATION_RECIPE_CONFLICT",
      httpStatus: 422,
      layer: "DAEMON_VERIFICATION_IDENTITY",
    });

    // The refusal surfaced BEFORE the verification: nothing was activated, no
    // receipt exists for the identity, and the first seal's bytes are exactly
    // where they were — argv A, undisturbed by the drifted catalog.
    expect(store.readEvents(deriveVerificationAggregateId("verification-drift-conflict")))
      .toHaveLength(0);
    const after = storedRecipe(store, recipeAggregateId);
    if (after === null || "ok" in after) throw new Error("the sealed recipe went unreadable");
    expect([...after.recipe.argv]).toEqual([...argvA]);
  });
});
