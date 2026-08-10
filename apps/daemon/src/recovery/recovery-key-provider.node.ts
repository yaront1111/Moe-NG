import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  asHostPlatform, protectionUnavailable, protectionUnverifiable,
} from "./recovery-key-provider-contract.js";
import type {
  RecoveryKeyProtectionResult, RecoveryKeyProviderPort,
} from "./recovery-key-provider-contract.js";

/**
 * The production host boundary for protecting the durable recovery key epoch.
 *
 * THE HONEST CONSTRAINT, stated the way `recovery-incarnation.node.ts` states
 * its own: Node exposes NO portable Windows/macOS/Linux ACL or keystore
 * primitive. There is nothing to call that means the same thing on three
 * platforms. So this module DETECTS the host, applies a mechanism it can NAME,
 * VERIFIES that mechanism by reading it back, and returns a typed UNKNOWN
 * everywhere else. A host that cannot provide the guarantee gets a refusal, not
 * an optimistic pass — an optimistic pass here would launder a crash-resume
 * claim through every layer above.
 *
 * WHAT IS ACTUALLY BEING PROTECTED, so nobody widens this into a secret store:
 * no private key material is persisted anywhere, by design — the private key is
 * non-extractable and dies with its process. The durable record holds PUBLIC
 * bytes (an SPKI, refs, digests, signatures). The property needed is therefore
 * ACCESS RESTRICTION against other local users; tamper-EVIDENCE already comes
 * from the anchored self-proofs. Secrecy is not claimed and is not achievable.
 *
 * WIN32 IS NOT POSIX. Mode bits are meaningless on win32 and are never applied
 * or claimed there, and nothing here claims directory-fsync semantics on any
 * platform — no fsync is performed, so none is asserted.
 *
 * Every host call is wrapped. A throw becomes a typed refusal carrying a code
 * and this layer; no exception escapes `protect`.
 */
const execFileAsync = promisify(execFile);

/** Bounded so a hung host tool refuses rather than stalling a restore. */
const RUN = Object.freeze({ timeout: 10_000, windowsHide: true });

const SYSTEM_ROOT = process.env["SystemRoot"] ?? "C:\\Windows";
const ICACLS = join(SYSTEM_ROOT, "System32", "icacls.exe");
const WHOAMI = join(SYSTEM_ROOT, "System32", "whoami.exe");

interface Ace {
  readonly principal: string;
  readonly flags: string;
}

/**
 * Parses the ACL block `icacls <dir>` prints: the first line carries the path
 * followed by an ACE, the rest are indented ACEs, and a blank line ends the
 * block before the localized "Successfully processed" summary — which is
 * deliberately never parsed. Returns null on anything unexpected, so an
 * unrecognised dialect reads as UNVERIFIABLE rather than as protected.
 */
function parseAces(stdout: string, directoryPath: string): readonly Ace[] | null {
  const aces: Ace[] = [];
  for (const [index, raw] of stdout.split(/\r?\n/).entries()) {
    if (index === 0 && !raw.startsWith(directoryPath)) return null;
    const text = (index === 0 ? raw.slice(directoryPath.length) : raw).trim();
    if (text.length === 0) break;
    // A Windows path contains `:\`, never `:(`, so the last `:(` is the boundary
    // between the principal and its rights however the principal is spelled.
    const boundary = text.lastIndexOf(":(");
    if (boundary <= 0) return null;
    aces.push({ flags: text.slice(boundary + 1), principal: text.slice(0, boundary) });
  }
  return aces;
}

/**
 * Applies a real Win32 discretionary ACL: `/inheritance:r` REMOVES every
 * inherited ACE and `/grant:r` replaces the grants, leaving exactly one explicit
 * ACE for the account this process runs as. The identity comes from `whoami`
 * rather than from `%USERNAME%`, because an environment variable is caller-owned
 * and this decides who keeps access.
 *
 * The read-back is the assertion. `icacls` exiting 0 only means the tool ran; a
 * volume without ACL support (FAT32, exFAT, some network redirectors) can accept
 * the call and keep an inherited ACL, so protection is claimed only when the
 * re-read shows ONE explicit ACE, owned by this identity, with no `(I)` flag.
 */
async function protectWin32(directoryPath: string): Promise<RecoveryKeyProtectionResult> {
  if (!existsSync(ICACLS) || !existsSync(WHOAMI)) return protectionUnavailable("win32");
  let identity: string;
  try {
    identity = (await execFileAsync(WHOAMI, [], RUN)).stdout.trim();
    if (identity.length === 0) return protectionUnavailable("win32");
    await execFileAsync(
      ICACLS,
      [directoryPath, "/inheritance:r", "/grant:r", `${identity}:(OI)(CI)F`],
      RUN,
    );
  } catch {
    return protectionUnavailable("win32");
  }

  let aces: readonly Ace[] | null;
  try {
    aces = parseAces((await execFileAsync(ICACLS, [directoryPath], RUN)).stdout, directoryPath);
  } catch {
    return protectionUnverifiable("win32");
  }
  if (aces === null || aces.length !== 1) return protectionUnverifiable("win32");
  const [ace] = aces;
  if (ace === undefined) return protectionUnverifiable("win32");
  // `(I)` marks an INHERITED ace. One surviving inherited entry means the
  // volume ignored `/inheritance:r`, which is exactly the silent no-op case.
  if (ace.flags.includes("(I)")) return protectionUnverifiable("win32");
  if (ace.principal.toLowerCase() !== identity.toLowerCase()) {
    return protectionUnverifiable("win32");
  }
  if (!ace.flags.includes("(F)")) return protectionUnverifiable("win32");
  return Object.freeze({
    mechanism: "WIN32_DACL_EXPLICIT_OWNER_ONLY" as const,
    ok: true as const,
    platform: "win32" as const,
  });
}

/**
 * Applies POSIX discretionary access control: mode 0700 on the directory, so
 * group and other have no path in at all.
 *
 * Read back rather than assumed. `chmod` succeeding proves the syscall was
 * accepted, not that the filesystem honours mode bits — FAT, exFAT, many 9p and
 * SMB mounts silently report a fixed mode — so the stat must show exactly 0700
 * AND an owner matching this process before protection is claimed.
 */
async function protectPosix(
  directoryPath: string,
  platform: "darwin" | "linux",
): Promise<RecoveryKeyProtectionResult> {
  try {
    await chmod(directoryPath, 0o700);
  } catch {
    return protectionUnavailable(platform);
  }
  let mode: number;
  let uid: number;
  try {
    const stats = await stat(directoryPath);
    if (!stats.isDirectory()) return protectionUnavailable(platform);
    mode = stats.mode;
    uid = stats.uid;
  } catch {
    return protectionUnverifiable(platform);
  }
  if ((mode & 0o777) !== 0o700) return protectionUnverifiable(platform);
  // `getuid` is absent on some hosts; an owner that cannot be established is an
  // unverified owner, never an assumed one.
  const self = typeof process.getuid === "function" ? process.getuid() : null;
  if (self === null || uid !== self) return protectionUnverifiable(platform);
  return Object.freeze({
    mechanism: "POSIX_MODE_0700_OWNER_ONLY" as const,
    ok: true as const,
    platform,
  });
}

/**
 * The port the daemon injects into `createRecoveryKeyProvider`. `platform` is
 * read once at construction so a refusal always names the real host, including
 * when a host call throws before it could report one.
 */
export function createNodeRecoveryKeyProviderPort(): RecoveryKeyProviderPort {
  const platform = asHostPlatform(process.platform);

  const protect = (directoryPath: string): Promise<RecoveryKeyProtectionResult> => {
    if (platform === "win32") return protectWin32(directoryPath);
    if (platform === "darwin" || platform === "linux") {
      return protectPosix(directoryPath, platform);
    }
    // No detection, no fallback, no mode bits pretending to be an ACL: a host
    // this module cannot name a mechanism for is a typed UNKNOWN.
    return Promise.resolve(protectionUnavailable(platform));
  };

  return Object.freeze({ platform, protect });
}
