import { lstatSync } from "node:fs";

import type { ScopePathObserver } from "@moe/runner";

export interface FoundationInputPathSnapshot {
  readonly observer: ScopePathObserver;
  unchanged(path: string): boolean;
}

function fingerprint(path: string): string | null {
  try {
    const stat = lstatSync(path, { bigint: true });
    return [
      stat.dev,
      stat.ino,
      stat.mode,
      stat.nlink,
      stat.size,
      stat.mtimeNs,
      stat.ctimeNs,
    ].join(":");
  } catch {
    return null;
  }
}

/**
 * Records file identity when the runner checks existence, before its
 * containment realpath. The hydrator compares that identity after reading, so
 * a same-status content/inode swap cannot hide behind an unchanged git-path
 * attribution digest. `lstat` does not read bytes or follow a terminal link;
 * containment authority remains entirely with the delegated runner observer.
 */
export function snapshotFoundationInputPaths(
  delegate: ScopePathObserver,
): FoundationInputPathSnapshot {
  const initial = new Map<string, string | null>();
  return Object.freeze({
    observer: Object.freeze({
      exists(path: string): boolean {
        const exists = delegate.exists(path);
        if (exists && !initial.has(path)) initial.set(path, fingerprint(path));
        return exists;
      },
      realpath: (path: string): string => delegate.realpath(path),
    }),
    unchanged(path: string): boolean {
      const before = initial.get(path);
      return before !== undefined && before !== null && fingerprint(path) === before;
    },
  });
}
