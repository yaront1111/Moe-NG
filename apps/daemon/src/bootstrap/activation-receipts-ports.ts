/**
 * The ports the activation measurement runs on, and the ONE production bundle that
 * touches a node API. Keeping the node surface here is what lets
 * `activation-receipts-measure.ts` stay a pure function of its inputs: every test
 * arm drives fakes, and the only code that opens a database, spawns git or reads
 * the filesystem is in this file. The one exception is the agent-CLI version probe,
 * which lives in `activation-provider-version.ts`: it is the only production spawn on
 * this path and is worth being findable on its own.
 */

import { createHash } from "node:crypto";
import {
  createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";

import { readProviderVersion } from "./activation-provider-version.js";
import type { ProviderVersionRun } from "./activation-provider-version.js";
import { nodeGitRunner } from "../repository/git-landing-port.js";
import type { GitRunner } from "../repository/git-landing-port.js";

const DETAIL_TAIL = 600;

/** Refusal details are bounded and well-formed; a stderr tail can carry lone surrogates. */
export const receiptDetail = (text: string): string =>
  text.slice(-DETAIL_TAIL).toWellFormed();

export interface ActivationReceiptFs {
  exists(path: string): boolean;
  /** Entry names of a directory; throws when it cannot be listed. */
  list(directory: string): readonly string[];
  /** Recursive; throws when a plain file already occupies the path. */
  mkdir(path: string): void;
  readBytes(path: string): Uint8Array | null;
  /** Removes one file; throws when it cannot. */
  remove(path: string): void;
  stat(path: string): { readonly size: number } | null;
}

export type ActivationBackupOutcome =
  | { readonly byteLength: number; readonly ok: true; readonly sha256: string }
  | { readonly detail: string; readonly ok: false };

export type { ProviderVersionRun } from "./activation-provider-version.js";

export interface ActivationReceiptPorts {
  readonly backup: (storePath: string, destination: string) => Promise<ActivationBackupOutcome>;
  readonly committedProbeRef: () => Promise<string | null>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fs: ActivationReceiptFs;
  readonly git: GitRunner;
  readonly installedPolicySliceRefs: () => Promise<readonly string[]>;
  readonly now: () => Date;
  readonly providerVersion: (command: string) => Promise<ProviderVersionRun>;
  readonly sqliteApplicationId: (storePath: string) => number | null;
}

interface SqliteModule {
  readonly DatabaseSync: new (
    path: string, options?: { readonly readOnly?: boolean },
  ) => DatabaseSync;
  readonly backup: (source: DatabaseSync, destination: string) => Promise<unknown>;
}

let sqliteCache: SqliteModule | null | undefined;

/**
 * Guarded: a host whose Node predates `node:sqlite` must refuse the STORE MEMBER
 * with its own code, not fail to load this module. A static import would take the
 * whole daemon down instead of producing ACTIVATION_STORE_UNMEASURED.
 */
function loadSqlite(): SqliteModule | null {
  if (sqliteCache === undefined) {
    try {
      sqliteCache = createRequire(import.meta.url)("node:sqlite") as SqliteModule;
    } catch {
      sqliteCache = null;
    }
  }
  return sqliteCache;
}

function readApplicationId(storePath: string): number | null {
  const sqlite = loadSqlite();
  if (sqlite === null) return null;
  let database: DatabaseSync | null = null;
  try {
    database = new sqlite.DatabaseSync(storePath, { readOnly: true });
    const row = database.prepare("PRAGMA application_id").get() as Record<string, unknown> | undefined;
    const value = Object.values(row ?? {})[0];
    return typeof value === "number" ? value : null;
  } catch {
    return null;
  } finally {
    try {
      database?.close();
    } catch {
      // The handle is released with the scope; a failed close is not a read failure.
    }
  }
}

/** Streamed, never buffered: a real store can be gigabytes. */
function streamSha256(
  path: string,
): Promise<{ readonly byteLength: number; readonly sha256: string }> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    let byteLength = 0;
    const stream = createReadStream(path);
    stream.on("data", (chunk: Buffer | string) => {
      byteLength += chunk.length;
      hash.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => {
      resolve({ byteLength, sha256: hash.digest("hex") });
    });
  });
}

/** Best effort: the refusal already carries the real failure, so a failed unlink is silent. */
function discard(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Nothing to add: the caller is already refusing with the originating error.
  }
}

/**
 * `node:sqlite`'s ONLINE backup, not a file copy: the daemon holds the store open
 * in WAL mode and a plain copy can miss unflushed pages. The source handle closes
 * on every exit path, a partial copy is discarded rather than left looking like a
 * backup, and no `-wal`/`-shm` sibling survives because the online API checkpoints
 * into the destination.
 */
async function copyStore(
  storePath: string, destination: string,
): Promise<ActivationBackupOutcome> {
  const sqlite = loadSqlite();
  if (sqlite === null) return { detail: "node:sqlite is unavailable on this host", ok: false };
  let source: DatabaseSync | null = null;
  try {
    source = new sqlite.DatabaseSync(storePath, { readOnly: true });
    await sqlite.backup(source, destination);
  } catch (error) {
    // A half-written copy must never survive to look like a backup at this name.
    discard(destination);
    return { detail: receiptDetail(String(error)), ok: false };
  } finally {
    try {
      source?.close();
    } catch {
      // The process releases the handle regardless; a failed close is not a backup failure.
    }
  }
  try {
    return { ...(await streamSha256(destination)), ok: true as const };
  } catch (error) {
    discard(destination);
    return { detail: receiptDetail(String(error)), ok: false };
  }
}

const nodeFs: ActivationReceiptFs = Object.freeze({
  exists: (path: string) => existsSync(path),
  list: (directory: string) => readdirSync(directory),
  mkdir: (path: string) => {
    mkdirSync(path, { recursive: true });
  },
  readBytes: (path: string) => {
    try {
      return new Uint8Array(readFileSync(path));
    } catch {
      return null;
    }
  },
  remove: (path: string) => {
    unlinkSync(path);
  },
  stat: (path: string) => {
    try {
      return { size: statSync(path).size };
    } catch {
      return null;
    }
  },
});

/**
 * The production bundle. `committedProbeRef` and `installedPolicySliceRefs` default
 * to ABSENT rather than to a fabricated value: a caller that has not wired the
 * durable readers gets an honest ACTIVATION_PROVIDER_UNMEASURED /
 * ACTIVATION_POLICY_UNMEASURED, never an invented ref.
 *
 * `providerVersion` is the opposite case and defaults to the REAL reader: it needs
 * no durable wiring, only a host, so an absent default would be a version nobody
 * read wearing a measurement's clothes — the defect this member exists to remove.
 */
export function nodeActivationReceiptPorts(
  overrides: Partial<ActivationReceiptPorts> = {},
): ActivationReceiptPorts {
  return Object.freeze({
    backup: copyStore,
    committedProbeRef: () => Promise.resolve(null),
    env: process.env,
    fs: nodeFs,
    git: nodeGitRunner,
    installedPolicySliceRefs: () => Promise.resolve([]),
    now: () => new Date(),
    providerVersion: readProviderVersion,
    sqliteApplicationId: readApplicationId,
    ...overrides,
  });
}
