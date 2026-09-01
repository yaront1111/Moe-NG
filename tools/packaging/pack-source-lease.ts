import { join } from "node:path";

import { capturePackFileIdentity } from "./pack-tool-identity.js";
import {
  leaseEntriesForFiles, type WindowsLeaseEntry,
} from "./pack-windows-process-lease.js";

export function materializedPackSourceLeaseEntries(
  root: string,
  trackedEntries: readonly Readonly<{
    readonly path: string;
    readonly sha256: string;
    readonly size: number;
  }>[],
): readonly WindowsLeaseEntry[] {
  const identities = trackedEntries.map((entry) => {
    const identity = capturePackFileIdentity(join(root, ...entry.path.split("/")), false, true);
    if (identity.sha256 !== entry.sha256 || identity.size !== entry.size) {
      throw new Error("PACK_WINDOWS_LEASE_FAILED");
    }
    return identity;
  });
  return leaseEntriesForFiles(identities);
}
