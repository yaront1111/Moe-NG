import { readdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import {
  isAbsolute as nativeIsAbsolute,
  join as nativeJoin,
  relative as nativeRelative,
  sep as nativeSeparator,
  win32,
} from "node:path";

import {
  createNodeClaudeRuntimeFs,
  type ClaudeRuntimeFsPort,
} from "./claude-runtime-pin.js";

/** Stable Windows identity presented to runtime-pin unit fixtures on every host. */
export const EMULATED_WIN32_RUNTIME_ROOT = "C:\\moe-runtime";

function nativeEscape(relativePath: string): boolean {
  return relativePath === ".." ||
    relativePath.startsWith(`..${nativeSeparator}`) ||
    nativeIsAbsolute(relativePath);
}

function win32Escape(relativePath: string): boolean {
  return relativePath === ".." ||
    relativePath.startsWith(`..${win32.sep}`) ||
    win32.isAbsolute(relativePath);
}

/** Maps a synthetic Windows runtime path onto this fixture's real temporary root. */
export function nativeRuntimePath(nativeRoot: string, runtimePath: string): string {
  const relativePath = win32.relative(EMULATED_WIN32_RUNTIME_ROOT, runtimePath);
  if (win32Escape(relativePath)) {
    throw new Error(`${JSON.stringify(runtimePath)} escapes the emulated Windows runtime root`);
  }
  let current = nativeRoot;
  for (const segment of relativePath === "" ? [] : relativePath.split(win32.sep)) {
    let physicalSegment = segment;
    try {
      physicalSegment = readdirSync(current).find(
        (entry) => entry.toLowerCase() === segment.toLowerCase(),
      ) ?? segment;
    } catch {
      // A not-yet-created parent or leaf keeps the requested spelling.
    }
    current = nativeJoin(current, physicalSegment);
  }
  return current;
}

function runtimePath(nativeRoot: string, nativePath: string): string {
  const relativePath = nativeRelative(nativeRoot, nativePath);
  if (nativeEscape(relativePath)) {
    throw new Error(`${JSON.stringify(nativePath)} escapes the fixture's native root`);
  }
  return relativePath === ""
    ? EMULATED_WIN32_RUNTIME_ROOT
    : win32.join(
        EMULATED_WIN32_RUNTIME_ROOT,
        ...relativePath.split(nativeSeparator),
      );
}

async function listNativeFiles(root: string, prefix = ""): Promise<string[]> {
  const directory = prefix === "" ? root : nativeJoin(root, prefix);
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix === "" ? entry.name : nativeJoin(prefix, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await listNativeFiles(root, relativePath)));
    } else {
      found.push(relativePath.split(nativeSeparator).join(win32.sep));
    }
  }
  return found;
}

/**
 * Uses the production Node byte-moving adapter behind a Windows-path facade.
 * Unit tests can therefore exercise the Windows-only protocol on Linux/macOS
 * without weakening the production platform guard or touching a real runtime.
 */
export function createEmulatedWin32RuntimeFs(nativeRoot: string): ClaudeRuntimeFsPort {
  const base = createNodeClaudeRuntimeFs();
  const physical = (path: string): string => nativeRuntimePath(nativeRoot, path);
  return Object.freeze({
    hostPlatform: (): string => "win32",
    realpath: async (path: string): Promise<string> =>
      runtimePath(nativeRoot, await base.realpath(physical(path))),
    entryKind: async (path: string) => await base.entryKind(physical(path)),
    readChunks: (path: string) => base.readChunks(physical(path)),
    listFiles: async (path: string): Promise<readonly string[]> => [
      ...(process.platform === "win32"
        ? await base.listFiles(physical(path))
        : await listNativeFiles(physical(path))),
    ].sort(),
    ensureDirectory: async (path: string): Promise<void> => {
      await base.ensureDirectory(physical(path));
    },
    createDirectoryExclusive: async (path: string): Promise<void> => {
      await base.createDirectoryExclusive(physical(path));
    },
    openExclusiveWrite: async (path: string) => await base.openExclusiveWrite(physical(path)),
    rename: async (from: string, to: string): Promise<void> => {
      await base.rename(physical(from), physical(to));
    },
    removeTree: async (path: string): Promise<void> => {
      await base.removeTree(physical(path));
    },
  });
}
