import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";

import type { EnvironmentStoreConfig } from "./environment-store.js";

/**
 * Scaffolding for the environment-store suites.
 *
 * Every helper builds INPUT or opens a store; none restates a rule and none reimplements a
 * production surface, so an assertion written against these helpers is still an assertion about
 * shipped code. Test-tier only: reached from `*.test.ts`, never from a published unit, so it has
 * no `.js` runtime bridge - matching `identity/session-test-fixtures.ts`.
 */

export const PROJECT_ID = "project-environment-1";
export const CREDENTIAL = "daemon-credential-environment-fixture";
export const OTHER_CREDENTIAL = "daemon-credential-environment-other";
export const NOW = "2026-09-05T00:00:00.000Z";

const openStores: SqliteEventStore[] = [];
const temporaryDirectories: string[] = [];

export function openMemoryStore(): SqliteEventStore {
  const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
  openStores.push(store);
  return store;
}

export interface FileBackedStore {
  readonly databasePath: string;
  readonly directory: string;
  readonly store: SqliteEventStore;
}

/**
 * A store on a REAL FILE, which is what the canary and at-rest suites need: an in-memory store
 * has no bytes to grep, so proving "the plaintext is not on disk" against one would prove nothing.
 */
export function openFileStore(label = "store"): FileBackedStore {
  const directory = mkdtempSync(join(tmpdir(), "moe-env-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, `${label}.db`);
  const store = SqliteEventStore.openForProject(databasePath, PROJECT_ID);
  openStores.push(store);
  return { databasePath, directory, store };
}

/**
 * Re-opens an EXISTING database file - the exfiltrated-copy case. Registered for cleanup like
 * any other store.
 */
export function openExistingStore(databasePath: string): SqliteEventStore {
  const store = SqliteEventStore.openForProject(databasePath, PROJECT_ID);
  openStores.push(store);
  return store;
}

export function closeStores(): void {
  while (openStores.length > 0) {
    try {
      openStores.pop()?.close();
    } catch {
      // Cleanup must not mask a test failure.
    }
  }
}

export function removeTemporaryDirectories(): void {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory === undefined) continue;
    try {
      rmSync(directory, { force: true, recursive: true });
    } catch {
      // A held SQLite handle on Windows must not mask a test failure.
    }
  }
}

export function cleanUp(): void {
  closeStores();
  removeTemporaryDirectories();
}

/** A credential source that answers `credential`, or is unavailable when it is null. */
export function credentialSource(credential: string | null): () => string | null {
  return () => credential;
}

/** A credential that EXISTS but cannot be read - the EACCES-shaped case. */
export function unreadableCredentialSource(): () => string | null {
  return () => {
    throw new Error("EACCES: permission denied, open '.moe/credential'");
  };
}

export function configFor(
  store: SqliteEventStore,
  credential: string | null = CREDENTIAL,
): EnvironmentStoreConfig {
  return {
    credential: credentialSource(credential),
    now: () => NOW,
    projectId: PROJECT_ID,
    store,
  };
}
