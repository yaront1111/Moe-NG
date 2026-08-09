import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { win32 } from "node:path";

/**
 * The filesystem boundary the Claude runtime pin operates through.
 *
 * Split out of `claude-runtime-pin.ts` so the pinning protocol and the adapter
 * that moves bytes stay separately readable, and so a test can wrap the REAL
 * adapter to inject a fault at an exact ordinal rather than reimplement it.
 *
 * Every read is chunked. A runtime closure can be gigabytes, and a port that
 * handed back a whole file would make bounded streaming unprovable no matter
 * what the caller does with it.
 */
export const RUNTIME_PIN_CHUNK_BYTES = 65536;

/**
 * `lstat`-shaped: a reparse point reports as itself and never as its target,
 * which is what makes a junction above a closure member detectable at all.
 */
export type RuntimeEntryKind = "FILE" | "DIRECTORY" | "REPARSE" | "OTHER" | "MISSING";

export interface ClaudeRuntimeWriteHandle {
  readonly write: (chunk: Uint8Array) => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface ClaudeRuntimeFsPort {
  readonly hostPlatform: () => string;
  readonly realpath: (path: string) => Promise<string>;
  readonly entryKind: (path: string) => Promise<RuntimeEntryKind>;
  readonly readChunks: (path: string) => AsyncIterable<Uint8Array>;
  /** Root-relative file paths, recursively, so an unexpected member is visible. */
  readonly listFiles: (path: string) => Promise<readonly string[]>;
  readonly ensureDirectory: (path: string) => Promise<void>;
  readonly createDirectoryExclusive: (path: string) => Promise<void>;
  readonly openExclusiveWrite: (path: string) => Promise<ClaudeRuntimeWriteHandle>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly removeTree: (path: string) => Promise<void>;
}

/** Owner-only: a pinned runtime is Moe-private and nothing else may read it. */
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

async function walkFiles(base: string, prefix: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(win32.join(base, prefix), { withFileTypes: true })) {
    const relativePath = prefix === "" ? entry.name : win32.join(prefix, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await walkFiles(base, relativePath)));
    } else {
      found.push(relativePath);
    }
  }
  return found;
}

export function createNodeClaudeRuntimeFs(): ClaudeRuntimeFsPort {
  return Object.freeze({
    hostPlatform: (): string => process.platform,
    realpath: async (path: string): Promise<string> => await realpath(path),
    entryKind: async (path: string): Promise<RuntimeEntryKind> => {
      try {
        const stats = await lstat(path);
        if (stats.isSymbolicLink()) return "REPARSE";
        if (stats.isDirectory()) return "DIRECTORY";
        return stats.isFile() ? "FILE" : "OTHER";
      } catch {
        // An unreadable entry is indistinguishable from an absent one here, and
        // both are equally disqualifying: neither can be hashed.
        return "MISSING";
      }
    },
    readChunks: (path: string): AsyncIterable<Uint8Array> =>
      createReadStream(path, { highWaterMark: RUNTIME_PIN_CHUNK_BYTES }),
    listFiles: async (path: string): Promise<readonly string[]> =>
      (await walkFiles(path, "")).sort(),
    ensureDirectory: async (path: string): Promise<void> => {
      await mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
    },
    createDirectoryExclusive: async (path: string): Promise<void> => {
      await mkdir(path, { mode: DIRECTORY_MODE });
    },
    openExclusiveWrite: async (path: string): Promise<ClaudeRuntimeWriteHandle> => {
      // `wx` is deliberate: a destination that already exists must fail rather
      // than have one attempt's bytes overwritten under another's.
      const handle = await open(path, "wx", FILE_MODE);
      return Object.freeze({
        write: async (chunk: Uint8Array): Promise<void> => {
          await handle.write(chunk);
        },
        close: async (): Promise<void> => {
          try {
            await handle.sync();
          } finally {
            // Closed even when the flush fails, so a failed copy cannot leave a
            // handle open on a tree the caller is about to remove.
            await handle.close();
          }
        },
      });
    },
    rename: async (from: string, to: string): Promise<void> => {
      await rename(from, to);
    },
    removeTree: async (path: string): Promise<void> => {
      await rm(path, { recursive: true, force: true });
    },
  });
}

/** Hashes through the port's bounded chunks; never materialises the file. */
export async function streamDigest(fs: ClaudeRuntimeFsPort, path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.readChunks(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}
