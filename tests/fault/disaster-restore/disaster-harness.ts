/**
 * Fixture builder for the CORE-S14 disaster-restore lane. FIXTURES ONLY.
 *
 * Nothing here decides anything. It never recomputes a digest, never judges a
 * slot, never classifies a refusal — every verdict the three `.fault.ts` files
 * assert is read off a production function. A helper that graded its own
 * fixtures would let the lane agree with itself while the shipped surface
 * drifted away from both.
 *
 * Import rules: @moe/store arrives through the relative barrel (the lane's
 * established pattern), @moe/daemon through its BARE specifier (the root
 * package declares it `workspace:*`). No deep import into apps/daemon/src/**.
 */
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore, createBackupGeneration } from "../../../packages/store/src/index.js";

export const DISASTER_PROJECT_ID = "project-disaster-1";
export const DISASTER_PRINCIPAL_ID = "principal-disaster-1";
export const DISASTER_PREPARED_AT = "2026-08-16T00:00:00.000Z";

const roots: string[] = [];
const stores: SqliteEventStore[] = [];

/** A fresh per-case temp root, registered for teardown. */
export function disasterRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `moe-disaster-${label}-`));
  roots.push(root);
  return root;
}

/** Opens a store through production and registers the handle for teardown. */
export function openDisasterStore(storePath: string, projectId = DISASTER_PROJECT_ID) {
  const store = SqliteEventStore.openForProject(storePath, projectId);
  stores.push(store);
  return store;
}

/**
 * Close every handle, then remove every root. A SQLite handle that outlives the
 * file kills the vitest worker outright, and this lane runs
 * `fileParallelism: false`, so one leak stalls everything queued behind it.
 */
export function cleanupDisasterRoots(): void {
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

/** The sealed closure demands every category; an empty set refuses CATEGORY_INCOMPLETE. */
const BACKUP_CATEGORIES = Object.freeze([
  "ARTIFACT",
  "CONTEXT",
  "KEY_CHAIN",
  "MANIFEST",
  "RECEIPT",
] as const);

const encoder = new TextEncoder();

function backupObjects(root: string, sourceGenerationDigest: string): Record<string, unknown>[] {
  const objectRoot = join(root, "objects");
  mkdirSync(objectRoot, { recursive: true });
  return BACKUP_CATEGORIES.map((category, index) => {
    const payload = encoder.encode(`${category}-disaster-object-${index}`);
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

export interface RestoredArtifact {
  readonly bytes: Uint8Array;
  readonly logicalPath: string;
}

export interface SeededGeneration {
  readonly artifacts: readonly RestoredArtifact[];
  readonly container: unknown;
  readonly databaseBytes: Uint8Array;
  readonly generationDigest: string;
  readonly generationPath: string;
  readonly projectId: string;
  readonly root: string;
}

/**
 * One REAL backup generation, produced by `createBackupGeneration`. The restored
 * payload handed to the anchor is read back off the published generation rather
 * than synthesised, so the anchor installs bytes a real backup actually emitted.
 */
export async function seedGeneration(label: string): Promise<SeededGeneration> {
  const root = disasterRoot(label);
  const storePath = join(root, "source.db");
  const seed = SqliteEventStore.openForProject(storePath, DISASTER_PROJECT_ID);
  let cursor: string;
  try {
    // Read back rather than assumed: the capture refuses a cursor that is ahead
    // of or behind the database it is copying.
    cursor = String(seed.readEventsAfter(0n, 1).items.length);
  } finally {
    seed.close();
  }

  const { privateKey } = generateKeyPairSync("ed25519");
  const keyId = `disaster-key-${label}`;
  const generationPath = join(root, "generation");
  const sourceGenerationDigest = createHash("sha256").update(label).digest("hex");
  const created = await createBackupGeneration({
    cursor,
    databasePath: storePath,
    destinationPath: generationPath,
    keyChain: [{ keyId, role: "LEAF" }],
    objects: backupObjects(root, sourceGenerationDigest),
    projectId: DISASTER_PROJECT_ID,
    signing: { keyId, privateKey },
    sourceGenerationDigest,
  });
  if (!created.ok) throw new Error(`backup generation failed: ${created.reason}`);

  return Object.freeze({
    artifacts: Object.freeze(
      created.manifest.objects.map((entry) =>
        Object.freeze({
          bytes: new Uint8Array(readFileSync(join(generationPath, ...entry.logicalPath.split("/")))),
          logicalPath: entry.logicalPath,
        }),
      ),
    ),
    container: created.container,
    databaseBytes: new Uint8Array(readFileSync(join(generationPath, "database.sqlite"))),
    generationDigest: created.manifest.generationDigest,
    generationPath,
    projectId: DISASTER_PROJECT_ID,
    root,
  });
}

/**
 * A well-formed `recovery.complete` envelope. Only the ENVELOPE is built here:
 * every section value rides through `decodeRecoveryCompleteRequest` untouched,
 * so nothing in this file can make a request look authorised. The shape is read
 * off the production key list rather than restated, and the request is valid at
 * DAEMON_INGRESS by construction so the guard under test is the one that answers.
 */
export function recoveryCompleteEnvelope(input: {
  readonly commandId: string;
  readonly payloadKeys: readonly string[];
  readonly projectId?: string;
  readonly reconciliationDigest: string;
  readonly schemaVersion: string;
}): Uint8Array {
  const payload: Record<string, unknown> = {};
  for (const key of input.payloadKeys) payload[key] = null;
  payload["reconciliationDigest"] = input.reconciliationDigest;
  return encoder.encode(
    JSON.stringify({
      commandId: input.commandId,
      correlationId: `correlation-${input.commandId}`,
      decidedAt: DISASTER_PREPARED_AT,
      expectedVersion: 0,
      kind: "recovery.complete",
      payload,
      principalId: DISASTER_PRINCIPAL_ID,
      projectId: input.projectId ?? DISASTER_PROJECT_ID,
      schemaVersion: input.schemaVersion,
    }),
  );
}

/**
 * An authority port that refuses to be an authority. Every case in this lane
 * expects `recovery.complete` to be refused BEFORE approval is ever consulted,
 * so reaching this is itself the failure.
 */
export function unreachableAuthority(): { readonly authorize: () => never } {
  return {
    authorize: (): never => {
      throw new Error("the completion authority was consulted on a refused completion");
    },
  };
}

/** Thrown by an injected fault. Distinguishable from any production failure. */
export class CrashSignal extends Error {
  readonly point: string;

  constructor(point: string) {
    super(`crash injected at ${point}`);
    this.name = "CrashSignal";
    this.point = point;
  }
}

/**
 * An `injectFault` callback that dies at exactly one boundary. The install
 * protocol calls it with the boundary name before crossing; anything else
 * returns undefined so the protocol proceeds normally.
 */
export function crashAt(point: string): (visited: string) => void {
  return (visited: string): void => {
    if (visited === point) throw new CrashSignal(point);
  };
}

export interface AnchorRequestInput {
  readonly anchorRoot: string;
  readonly generation: SeededGeneration;
  readonly incarnationRef: string;
  readonly injectFault?: (point: string) => void;
  readonly keyEpochRef: string;
  readonly preparedAt?: string;
  readonly projectId?: string;
  readonly restoreCommandId: string;
}

/**
 * The plain request object `prepareRecoveryAnchor` / `installRecoveryAnchor` /
 * `resumeRecoveryAnchor` consume. `injectFault` is snapshotted through the
 * public entry, so crash injection reaches the protocol with no deep import.
 */
export function anchorRequest(input: AnchorRequestInput): Record<string, unknown> {
  const request: Record<string, unknown> = {
    anchorRoot: input.anchorRoot,
    generationDigest: input.generation.generationDigest,
    incarnationRef: input.incarnationRef,
    keyEpochRef: input.keyEpochRef,
    payload: {
      artifacts: input.generation.artifacts.map((artifact) => ({
        bytes: artifact.bytes,
        logicalPath: artifact.logicalPath,
      })),
      databaseBytes: input.generation.databaseBytes,
    },
    preparedAt: input.preparedAt ?? DISASTER_PREPARED_AT,
    projectId: input.projectId ?? input.generation.projectId,
    restoreCommandId: input.restoreCommandId,
  };
  if (input.injectFault !== undefined) request["injectFault"] = input.injectFault;
  return request;
}
