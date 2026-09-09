import { mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

const LOCK_TIMEOUT_MS = 5_000;
const RETRY_INTERVAL_MS = 25;

async function canonicalCatalogPath(path: string): Promise<string> {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  try { return await realpath(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return join(await realpath(dirname(absolute)), basename(absolute));
  }
}

/**
 * A companion SQLite transaction serializes the complete catalog read/modify/write
 * across processes. The OS releases ownership when a process dies. Keep the file:
 * deleting it could let another opener lock a different inode at the same path.
 */
export async function withProjectCatalogLock(
  path: string,
  update: (canonicalPath: string) => Promise<void>,
  timeoutMs = LOCK_TIMEOUT_MS,
): Promise<void> {
  const canonicalPath = await canonicalCatalogPath(path);
  const database = new DatabaseSync(`${canonicalPath}.lock.sqlite`);
  try {
    // Retry asynchronously so a different registrar in this Node can finish its
    // filesystem work while this one waits for the same transaction lock.
    database.exec("PRAGMA busy_timeout = 0");
    const deadline = performance.now() + timeoutMs;
    while (true) {
      try { database.exec("BEGIN IMMEDIATE"); break; }
      catch (error) {
        const errcode = (error as { errcode?: number }).errcode;
        if ((errcode !== 5 && errcode !== 6) || performance.now() >= deadline) throw error;
        await delay(RETRY_INTERVAL_MS);
      }
    }
    try { await update(canonicalPath); }
    finally { database.exec("ROLLBACK"); }
  } finally { database.close(); }
}
