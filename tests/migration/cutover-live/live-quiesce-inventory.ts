/**
 * The inventory half of the LIVE legacy quiesce (task-e60b874b).
 *
 * WHY THIS EXISTS ALONGSIDE tests/migration/cutover/. That tree is
 * task-4e1fe696's, it is DONE, and it is SIMULATION-ONLY BY CONSTRUCTION —
 * cutover-inventory.ts:3-5 says so in its own words. It cannot discharge a
 * clause about the real host, and that is not a defect in it. This module is a
 * sibling, never an edit to it.
 *
 * WHAT IT GRADES. Not whether a stop worked — that is live-quiesce-actor.ts —
 * but whether the record of the population is one a later reader can trust:
 *  - every item names the EXACT command that found it, so it can be re-found;
 *  - every roster kind is either populated or explicitly declared undiscoverable
 *    with the method that failed, so nothing is silently omitted;
 *  - a LIVE record cannot be minted from a sandbox path or a harness runMode.
 *
 * THE UNDISCOVERABLE-KIND CASE IS NOT HYPOTHETICAL. Measured on this host
 * (2026-08-28, step 1): HANDLE has no read-only discovery method because
 * Sysinternals handle.exe is not installed, and WATCHER has none because Windows
 * exposes no enumeration of ReadDirectoryChangesW registrations without ETW.
 * Collapsing either into "nothing was found" would report an unmeasured kind as
 * quiesced. That is the failure this row was filed to correct, so the type
 * system refuses it rather than leaving it to a reader's attention.
 */

import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

export const LIVE_QUIESCE_INVENTORY_LAYER = "live-quiesce-inventory";

/** The five names DoD 1 enumerates, and no others. */
export const LIVE_QUIESCE_KINDS = Object.freeze([
  "PROCESS",
  "HANDLE",
  "WATCHER",
  "SCHEDULED_START",
  "ACCESS_PATH",
] as const);

export type LiveQuiesceKind = (typeof LIVE_QUIESCE_KINDS)[number];

export const LIVE_QUIESCE_INVENTORY_REFUSAL_CODES = Object.freeze([
  "LIVE_QUIESCE_POPULATION_EMPTY",
  "LIVE_QUIESCE_ITEM_UNDISCOVERABLE",
  "LIVE_QUIESCE_SANDBOX_PATH_IN_LIVE_RUN",
  "LIVE_QUIESCE_RUNMODE_MISSING",
  "LIVE_QUIESCE_KIND_UNKNOWN",
  "LIVE_QUIESCE_KIND_UNACCOUNTED",
] as const);

export type LiveQuiesceInventoryRefusalCode =
  (typeof LIVE_QUIESCE_INVENTORY_REFUSAL_CODES)[number];

export interface LiveQuiesceInventoryRefusal {
  readonly ok: false;
  readonly layer: typeof LIVE_QUIESCE_INVENTORY_LAYER;
  readonly code: LiveQuiesceInventoryRefusalCode;
  readonly detail: string;
}

export interface LiveQuiesceItem {
  readonly kind: LiveQuiesceKind;
  /** Stable identity on the host: a pid, an absolute path, a socket, a task name. */
  readonly id: string;
  /** The EXACT command that found it. An item nobody can re-find is an assertion. */
  readonly discoveredBy: string;
  /** What proved it live BEFORE any stop was attempted. */
  readonly observedBefore: string;
}

/**
 * A roster kind the host could not enumerate at all. Carried in the record as a
 * named refusal so a reader can tell "we looked and found none" apart from
 * "we had no way to look" — the two are not the same evidence.
 */
export interface LiveQuiesceUndiscoverableKind {
  readonly kind: LiveQuiesceKind;
  /** The discovery method that was attempted and what it returned. */
  readonly attemptedBy: string;
  /** Which layer refused: the host, a missing tool, a permission boundary. */
  readonly refusedByLayer: string;
}

export interface LiveQuiesceInventoryInput {
  /** Only "LIVE" mints a record. Absent or "HARNESS" refuses. */
  readonly runMode: "LIVE";
  readonly hostFingerprint: string;
  readonly items: readonly LiveQuiesceItem[];
  readonly undiscoverableKinds: readonly LiveQuiesceUndiscoverableKind[];
}

export interface LiveQuiesceInventory {
  readonly runMode: "LIVE";
  readonly hostFingerprint: string;
  /** Recorded explicitly so a truncated population cannot masquerade as complete. */
  readonly itemCount: number;
  readonly items: readonly LiveQuiesceItem[];
  readonly undiscoverableKinds: readonly LiveQuiesceUndiscoverableKind[];
}

export type LiveQuiesceInventoryResult =
  | { readonly ok: true; readonly inventory: LiveQuiesceInventory }
  | LiveQuiesceInventoryRefusal;

const refuse = (
  code: LiveQuiesceInventoryRefusalCode,
  detail: string,
): LiveQuiesceInventoryRefusal => ({
  ok: false,
  layer: LIVE_QUIESCE_INVENTORY_LAYER,
  code,
  detail,
});

const isBlank = (value: string | undefined): boolean =>
  typeof value !== "string" || value.trim().length === 0;

/**
 * Windows reports the same directory under several spellings, so one string
 * compare is not enough. We normalize separators and case, and additionally
 * test the realpath of tmpdir() because an 8.3 short form (RUNNER~1) and its
 * long form name the same directory while sharing no prefix.
 *
 * KNOWN LIMIT, stated rather than hidden: this catches paths under the CURRENT
 * process's tmpdir. A sandbox rooted at a different temp directory — another
 * user's, or one set by a TMPDIR override in a child process — is not caught
 * here and is caught instead by the ACCESS_PATH item's own observation.
 */
const sandboxRoots = (): readonly string[] => {
  const base = tmpdir();
  const roots = [base];
  try {
    roots.push(realpathSync(base));
  } catch {
    // An unresolvable tmpdir is not a reason to refuse the whole record; the
    // literal form above still guards the ordinary case.
  }
  return roots.map(normalizePath);
};

const normalizePath = (value: string): string => value.replaceAll("\\", "/").toLowerCase();

const isSandboxPath = (value: string, roots: readonly string[]): boolean => {
  const candidate = normalizePath(value);
  return roots.some((root) => candidate === root || candidate.startsWith(`${root}/`));
};

const isKnownKind = (kind: string): kind is LiveQuiesceKind =>
  (LIVE_QUIESCE_KINDS as readonly string[]).includes(kind);

/**
 * Builds the record, or refuses with the exact code and this layer.
 *
 * ORDER IS DELIBERATE. runMode is checked before anything else, because every
 * later check means something different in a harness run; the population check
 * follows, because a per-item check over an empty list is vacuously green.
 */
export const buildLiveInventory = (
  input: LiveQuiesceInventoryInput,
): LiveQuiesceInventoryResult => {
  if (input.runMode !== "LIVE") {
    return refuse(
      "LIVE_QUIESCE_RUNMODE_MISSING",
      `runMode must be "LIVE" to mint a live record; received ${JSON.stringify(input.runMode)}`,
    );
  }

  if (isBlank(input.hostFingerprint)) {
    return refuse(
      "LIVE_QUIESCE_RUNMODE_MISSING",
      "a LIVE record without a hostFingerprint cannot be attributed to a machine",
    );
  }

  if (input.items.length === 0) {
    return refuse(
      "LIVE_QUIESCE_POPULATION_EMPTY",
      "an empty population is a refusal, never a claim that everything is already stopped",
    );
  }

  const roots = sandboxRoots();

  for (const item of input.items) {
    if (!isKnownKind(item.kind)) {
      return refuse(
        "LIVE_QUIESCE_KIND_UNKNOWN",
        `kind ${String(item.kind)} is outside the roster of ${LIVE_QUIESCE_KINDS.length}`,
      );
    }
    if (isBlank(item.discoveredBy)) {
      return refuse(
        "LIVE_QUIESCE_ITEM_UNDISCOVERABLE",
        `item ${item.id} carries no discoveredBy, so nobody can re-find it`,
      );
    }
    if (isBlank(item.observedBefore)) {
      return refuse(
        "LIVE_QUIESCE_ITEM_UNDISCOVERABLE",
        `item ${item.id} carries no observedBefore, so nothing proved it was live`,
      );
    }
    if (isSandboxPath(item.id, roots)) {
      return refuse(
        "LIVE_QUIESCE_SANDBOX_PATH_IN_LIVE_RUN",
        `item ${item.id} is under the OS temp dir; a LIVE record may not name a sandbox path`,
      );
    }
  }

  for (const declared of input.undiscoverableKinds) {
    if (!isKnownKind(declared.kind)) {
      return refuse(
        "LIVE_QUIESCE_KIND_UNKNOWN",
        `undiscoverable kind ${String(declared.kind)} is outside the roster`,
      );
    }
    if (isBlank(declared.attemptedBy) || isBlank(declared.refusedByLayer)) {
      return refuse(
        "LIVE_QUIESCE_ITEM_UNDISCOVERABLE",
        `kind ${declared.kind} is declared undiscoverable without naming the method that failed`,
      );
    }
  }

  const populated = new Set(input.items.map((item) => item.kind));
  const declaredMissing = new Set(input.undiscoverableKinds.map((entry) => entry.kind));
  const unaccounted = LIVE_QUIESCE_KINDS.filter(
    (kind) => !populated.has(kind) && !declaredMissing.has(kind),
  );
  if (unaccounted.length > 0) {
    return refuse(
      "LIVE_QUIESCE_KIND_UNACCOUNTED",
      `kind(s) ${unaccounted.join(", ")} were neither populated nor declared undiscoverable`,
    );
  }

  return {
    ok: true,
    inventory: {
      runMode: "LIVE",
      hostFingerprint: input.hostFingerprint,
      itemCount: input.items.length,
      items: [...input.items],
      undiscoverableKinds: [...input.undiscoverableKinds],
    },
  };
};
