/**
 * Access-path inventory, deny, and abort-restore for the legacy quiesce drill.
 *
 * THERE IS NO REAL-PROCESS CODE PATH IN THIS MODULE AND ITS ABSENCE IS
 * DELIBERATE. Every function here reads and writes the simulated table from
 * `cutover-fixture.ts` and nothing else. It never spawns, signals, kills,
 * connects to, or even enumerates a real daemon, IDE, launcher, watcher,
 * scheduled start, process or handle. The next reader will otherwise assume a
 * real path is missing: it is not missing, it is withheld. The live quiesce is
 * gated on an explicit human GO_QUIESCE that has not been given, and the moe
 * daemon serving this board is itself one of the paths DoD 1 enumerates.
 *
 * Two vacuities are refused rather than tested around:
 *   - an inventory over ZERO paths trivially reports "everything is stopped";
 *   - a restore to "everything open" trivially satisfies "restore ran".
 * Both get a stable code, and every refusal names the layer that produced it so
 * a test can assert WHICH layer refused rather than merely that something did.
 */

import type { AccessPathKind, AccessPathState, CutoverAccessTable } from "./cutover-fixture.js";

export const CUTOVER_INVENTORY_LAYER = "cutover-inventory";

export type CutoverInventoryRefusalCode =
  | "CUTOVER_INVENTORY_EMPTY_POPULATION"
  | "CUTOVER_INVENTORY_DUPLICATE_PATH"
  | "CUTOVER_INVENTORY_STATE_MISSING"
  | "CUTOVER_INVENTORY_UNDENIABLE_PATH"
  | "CUTOVER_INVENTORY_DENY_NOT_APPLIED"
  | "CUTOVER_INVENTORY_RESTORE_UNKNOWN_PATH"
  | "CUTOVER_INVENTORY_RESTORE_INCOMPLETE"
  | "CUTOVER_INVENTORY_RESTORE_NOT_APPLIED";

export interface CutoverInventoryRefusal {
  readonly ok: false;
  readonly layer: typeof CUTOVER_INVENTORY_LAYER;
  readonly code: CutoverInventoryRefusalCode;
  readonly pathId: string;
  readonly detail: string;
}

export interface InventoriedPath {
  readonly id: string;
  readonly kind: AccessPathKind;
  readonly deniable: boolean;
  readonly state: AccessPathState;
}

export interface CutoverInventory {
  /** Recorded explicitly: a count that came from the same empty array proves nothing. */
  readonly pathCount: number;
  readonly paths: readonly InventoriedPath[];
}

export type AccessStateSnapshot = Readonly<Record<string, AccessPathState>>;

export type CutoverInventoryResult = { readonly ok: true; readonly inventory: CutoverInventory } | CutoverInventoryRefusal;
export type CutoverDenyResult = { readonly ok: true; readonly denied: readonly string[] } | CutoverInventoryRefusal;
export type CutoverRestoreResult = { readonly ok: true; readonly restored: readonly string[] } | CutoverInventoryRefusal;

const refuse = (code: CutoverInventoryRefusalCode, pathId: string, detail: string): CutoverInventoryRefusal =>
  ({ ok: false, layer: CUTOVER_INVENTORY_LAYER, code, pathId, detail });

/** Locale-free, case-preserving id order, matching the manifest's ordering rule. */
const byId = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

/**
 * Every declared access path, in a fixed order, with its live state. Refuses an
 * empty population: "all paths stopped" over zero paths is the exact vacuity
 * epic rail 6 warns about, and it must never be answerable with ok:true.
 */
export const inventoryAccessPaths = (table: CutoverAccessTable): CutoverInventoryResult => {
  const declarations = table.declarations;
  if (declarations.length === 0) {
    return refuse("CUTOVER_INVENTORY_EMPTY_POPULATION", "", "no access paths are declared; an empty inventory proves nothing");
  }

  const seen = new Set<string>();
  const paths: InventoriedPath[] = [];
  for (const declaration of declarations) {
    if (seen.has(declaration.id)) {
      return refuse("CUTOVER_INVENTORY_DUPLICATE_PATH", declaration.id, "declared more than once");
    }
    seen.add(declaration.id);
    const state = table.stateOf(declaration.id);
    if (state === undefined) {
      return refuse("CUTOVER_INVENTORY_STATE_MISSING", declaration.id, "declared but carries no state");
    }
    paths.push(Object.freeze({ id: declaration.id, kind: declaration.kind, deniable: declaration.deniable, state }));
  }

  paths.sort((left, right) => byId(left.id, right.id));
  return { ok: true, inventory: Object.freeze({ pathCount: paths.length, paths: Object.freeze(paths) }) };
};

/** The exact states to put back on abort. Taken from the inventory, never re-derived. */
export const snapshotAccessStates = (inventory: CutoverInventory): AccessStateSnapshot =>
  Object.freeze(Object.fromEntries(inventory.paths.map((path) => [path.id, path.state])));

/**
 * Flip every OPEN path to DENIED and report exactly which ids changed.
 *
 * An undeniable path refuses BY NAME before anything is mutated, so the table is
 * never left half-quiesced by a refusal, and a path that could not be denied is
 * never quietly counted as denied.
 */
export const denyAccessPaths = (table: CutoverAccessTable): CutoverDenyResult => {
  const inventoried = inventoryAccessPaths(table);
  if (!inventoried.ok) {
    return inventoried;
  }

  for (const path of inventoried.inventory.paths) {
    if (!path.deniable && path.state !== "DENIED") {
      return refuse("CUTOVER_INVENTORY_UNDENIABLE_PATH", path.id, "path cannot be denied and is still open");
    }
  }

  const denied: string[] = [];
  for (const path of inventoried.inventory.paths) {
    if (path.state === "DENIED") {
      continue;
    }
    table.setState(path.id, "DENIED");
    denied.push(path.id);
  }

  for (const path of inventoried.inventory.paths) {
    if (table.stateOf(path.id) !== "DENIED") {
      return refuse("CUTOVER_INVENTORY_DENY_NOT_APPLIED", path.id, "still not DENIED after the deny pass");
    }
  }
  return { ok: true, denied };
};

/**
 * Abort: put every path back to the state it actually held before the drill.
 *
 * "Restore to all open" is NOT an acceptable approximation. The fixture starts
 * with one path already DENIED precisely so that the difference is observable,
 * and DoD 3 asks that pre-cutover access be restored — not that access be
 * maximised. The snapshot must cover the declared population exactly: an id it
 * omits and an id it invents are both refusals, because either one means the
 * caller is restoring from evidence that does not describe this table.
 */
export const restoreAccessPaths = (
  table: CutoverAccessTable,
  saved: AccessStateSnapshot,
): CutoverRestoreResult => {
  const inventoried = inventoryAccessPaths(table);
  if (!inventoried.ok) {
    return inventoried;
  }
  const declaredIds = new Set(inventoried.inventory.paths.map((path) => path.id));

  for (const id of Object.keys(saved).sort(byId)) {
    if (!declaredIds.has(id)) {
      return refuse("CUTOVER_INVENTORY_RESTORE_UNKNOWN_PATH", id, "saved state names a path this table does not declare");
    }
  }
  for (const path of inventoried.inventory.paths) {
    if (saved[path.id] === undefined) {
      return refuse("CUTOVER_INVENTORY_RESTORE_INCOMPLETE", path.id, "declared path is absent from the saved state");
    }
  }

  const restored: string[] = [];
  for (const path of inventoried.inventory.paths) {
    const target = saved[path.id];
    if (target === undefined) {
      return refuse("CUTOVER_INVENTORY_RESTORE_INCOMPLETE", path.id, "declared path is absent from the saved state");
    }
    if (table.stateOf(path.id) !== target) {
      table.setState(path.id, target);
      restored.push(path.id);
    }
  }

  for (const path of inventoried.inventory.paths) {
    if (table.stateOf(path.id) !== saved[path.id]) {
      return refuse("CUTOVER_INVENTORY_RESTORE_NOT_APPLIED", path.id, "state after restore does not equal the saved state");
    }
  }
  return { ok: true, restored };
};
