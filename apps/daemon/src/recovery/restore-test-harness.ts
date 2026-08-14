import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore, createBackupGeneration } from "@moe/store";

import { readDurableLedger, stateOf } from "../bootstrap/bootstrap-ledger.js";
import { BOOTSTRAP_HANDLERS, runBootstrapCommand } from "../bootstrap/bootstrap-services.js";
import { ACTIVATION_WITNESS, OBSERVATION, envelope } from "../bootstrap/bootstrap-test-fixtures.js";
import { anchorIncarnation } from "./recovery-incarnation-anchor.js";
import {
  createNodeRecoveryCryptoPort,
  createRecoveryIncarnationService,
} from "./recovery-incarnation.js";
import type { RestoreIncarnationBinding } from "./recovery-incarnation.js";
import type { RestoreControllerRequest } from "./restore-controller-contract.js";

/**
 * Inputs for the restore-controller suites, built entirely from production code:
 * a real bootstrapped project, a real signed backup generation, a real minted
 * and anchored incarnation. Nothing here reads a module under test and nothing
 * restates a controller rule — a helper that recomputed a manifest digest or an
 * admissible lifecycle would let a suite agree with itself while the shipped
 * composition drifted away from both.
 *
 * The type-only import above is erased at runtime and reaches no module; the
 * reachability suite still resolves the controller the way the daemon does.
 */

export const PROJECT_ID = "project-1";
export const PRINCIPAL_ID = "principal-1";
export const DECIDED_AT = "2026-08-11T00:00:00.000Z";

const encoder = new TextEncoder();
const roots: string[] = [];
const stores: SqliteEventStore[] = [];

export interface RestoreHarness {
  readonly container: unknown;
  readonly generationDigest: string;
  readonly logicalPaths: readonly string[];
  /**
   * Per harness, not per module. `createRecoveryIncarnationService` mints a
   * command id at most once per SERVICE and refuses to rebind it to a second
   * generation, so a shared instance would refuse the second harness that
   * reuses a command id — a fixture collision that reads like a real refusal.
   */
  readonly mint: (
    generationDigest: string,
    restoreCommandId: string,
  ) => Promise<RestoreIncarnationBinding>;
  readonly root: string;
  readonly store: SqliteEventStore;
  readonly storePath: string;
  readonly trust: {
    readonly anchoredKeys: readonly { readonly keyId: string; readonly publicKeySpkiDer: string }[];
  };
}

/** Recursive and forced: a win32 host holds a briefly-locked SQLite file. */
export function cleanupRestoreHarnesses(): void {
  while (stores.length > 0) {
    try {
      stores.pop()?.close();
    } catch {
      /* a poisoned handle still has to be released */
    }
  }
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { force: true, maxRetries: 5, recursive: true });
  }
}

export function openHarnessStore(storePath: string): SqliteEventStore {
  const store = SqliteEventStore.openForProject(storePath, PROJECT_ID);
  stores.push(store);
  return store;
}

function send(
  store: SqliteEventStore,
  kind: string,
  version: number,
  payload: Record<string, unknown>,
): void {
  const outcome = runBootstrapCommand(
    store,
    encoder.encode(JSON.stringify(envelope(kind, version, payload))),
    BOOTSTRAP_HANDLERS,
  );
  if (!outcome.ok) throw new Error(`seeding ${kind} failed: ${outcome.code}`);
}

/** Drives the real bootstrap path to READY; nothing here writes a project row by hand. */
export function seedReadyProject(store: SqliteEventStore): void {
  send(store, "project.register", 0, { owner: "owner-1" });
  send(store, "project.bind_repository", 1, { observation: OBSERVATION });
  send(store, "provider.probe", 0, {
    observation: { providerMinimumProfileRef: "provider-profile-1", truthClass: "DAEMON_VERIFIED" },
  });
  send(store, "project.activate", 2, { witness: ACTIVATION_WITNESS });
}

/** The four project-aggregate events the seed commits, so a cursor is not guessed. */
export const SEEDED_EVENT_TYPES = Object.freeze([
  "ProjectRegistered",
  "RepositoryBound",
  "ProjectActivated",
] as const);

export function projectLifecycle(store: SqliteEventStore): string | undefined {
  const state = stateOf(readDurableLedger(store, PROJECT_ID), PROJECT_ID);
  if (state === null || typeof state !== "object" || Array.isArray(state)) return undefined;
  const lifecycle = (state as Record<string, unknown>)["lifecycle"];
  return typeof lifecycle === "string" ? lifecycle : undefined;
}

export function committedEventTypes(store: SqliteEventStore): readonly string[] {
  return store.readAggregateEvents(PROJECT_ID, 0, 100).items.map((event) => event.eventType);
}

/** The sealed closure demands every category; an empty set refuses CATEGORY_INCOMPLETE. */
const BACKUP_CATEGORIES = Object.freeze([
  "ARTIFACT",
  "CONTEXT",
  "KEY_CHAIN",
  "MANIFEST",
  "RECEIPT",
] as const);

function backupObjects(root: string, sourceGenerationDigest: string): Record<string, unknown>[] {
  const objectRoot = join(root, "objects");
  mkdirSync(objectRoot, { recursive: true });
  return BACKUP_CATEGORIES.map((category, index) => {
    const payload = encoder.encode(`${category}-object-${index}`);
    const sourcePath = join(objectRoot, `${category.toLowerCase()}.bin`);
    writeFileSync(sourcePath, payload);
    return {
      byteLength: String(payload.byteLength),
      category,
      digest: createHash("sha256").update(payload).digest("hex"),
      logicalId: `${category.toLowerCase()}-1`,
      logicalPath: `${category.toLowerCase()}/object.bin`,
      sourceGenerationDigest,
      sourcePath,
    };
  });
}

export async function restoreHarness(label: string): Promise<RestoreHarness> {
  const root = mkdtempSync(join(tmpdir(), `moe-restore-${label}-`));
  roots.push(root);
  const storePath = join(root, "project.db");

  const seed = SqliteEventStore.openForProject(storePath, PROJECT_ID);
  let cursor: string;
  try {
    seedReadyProject(seed);
    // Read back rather than assumed: the capture refuses a cursor that is ahead
    // of or behind the database it is copying.
    cursor = String(seed.readEventsAfter(0n, 100).items.length);
  } finally {
    seed.close();
  }

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyId = "restore-key-1";
  const destinationPath = join(root, "generation");
  const sourceGenerationDigest = createHash("sha256").update(label).digest("hex");
  const created = await createBackupGeneration({
    cursor,
    databasePath: storePath,
    destinationPath,
    keyChain: [{ keyId, role: "LEAF" }],
    objects: backupObjects(root, sourceGenerationDigest),
    projectId: PROJECT_ID,
    signing: { keyId, privateKey },
    sourceGenerationDigest,
  });
  if (!created.ok) throw new Error(`backup generation failed: ${created.reason}`);
  const container: unknown = JSON.parse(
    readFileSync(join(destinationPath, "manifest.json"), "utf8"),
  );

  const service = createRecoveryIncarnationService(createNodeRecoveryCryptoPort());
  return Object.freeze({
    container,
    generationDigest: created.manifest.generationDigest,
    logicalPaths: created.manifest.objects.map((entry) => entry.logicalPath),
    mint: async (generationDigest: string, restoreCommandId: string) => {
      const minted = await service.mint({
        backupGenerationDigest: generationDigest,
        restoreCommandId,
      });
      if (!minted.ok) throw new Error(`incarnation mint failed: ${minted.code}`);
      return minted.binding;
    },
    root,
    store: openHarnessStore(storePath),
    storePath,
    trust: Object.freeze({
      anchoredKeys: Object.freeze([
        Object.freeze({
          keyId,
          publicKeySpkiDer: publicKey.export({ format: "der", type: "spki" }).toString("hex"),
        }),
      ]),
    }),
  });
}

export function anchorInto(
  store: SqliteEventStore,
  binding: RestoreIncarnationBinding,
): void {
  const anchored = anchorIncarnation(
    store,
    {
      correlationId: "corr-1",
      decidedAt: DECIDED_AT,
      principalId: PRINCIPAL_ID,
      projectId: PROJECT_ID,
    },
    binding,
  );
  if (!anchored) throw new Error("anchoring the minted incarnation failed");
}

/** Mints and anchors one incarnation through production code in the harness store. */
export async function anchoredIncarnation(
  harness: RestoreHarness,
  restoreCommandId: string,
): Promise<RestoreIncarnationBinding> {
  const binding = await harness.mint(harness.generationDigest, restoreCommandId);
  anchorInto(harness.store, binding);
  return binding;
}

export function restoreRequest(
  harness: RestoreHarness,
  binding: RestoreIncarnationBinding,
  overrides: Partial<RestoreControllerRequest> = {},
): RestoreControllerRequest {
  return {
    container: harness.container,
    correlationId: "corr-1",
    decidedAt: DECIDED_AT,
    incarnationRef: binding.incarnationRef,
    keyEpochRef: binding.keyEpochRef,
    logicalPaths: harness.logicalPaths,
    principalId: PRINCIPAL_ID,
    projectId: PROJECT_ID,
    restoreCommandId: binding.restoreCommandId,
    trust: harness.trust,
    ...overrides,
  };
}
