/**
 * Inventory arms for the LIVE legacy quiesce (task-e60b874b).
 *
 * These cases never touch a real process, handle, watcher, scheduled start or
 * access path. They grade the RECORD SHAPE that a live run must produce, which
 * is the half that failed last time: task-4e1fe696 shipped a harness whose
 * output was indistinguishable, on its face, from a real run's.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  LIVE_QUIESCE_INVENTORY_LAYER,
  LIVE_QUIESCE_INVENTORY_REFUSAL_CODES,
  LIVE_QUIESCE_KINDS,
  buildLiveInventory,
  type LiveQuiesceInventoryInput,
  type LiveQuiesceItem,
  type LiveQuiesceKind,
} from "./live-quiesce-inventory.js";

const HOST = "win32/DESKTOP-TEST/node-24";

const itemOf = (kind: LiveQuiesceKind, id: string): LiveQuiesceItem => ({
  kind,
  id,
  discoveredBy: `Get-CimInstance Win32_Process -Filter "Name='node.exe'" # ${id}`,
  observedBefore: `${id} answered a live probe`,
});

/** Every roster kind populated, so no case below refuses for an unrelated reason. */
const fullPopulation = (): LiveQuiesceItem[] =>
  LIVE_QUIESCE_KINDS.map((kind) => itemOf(kind, `${kind.toLowerCase()}-1`));

/**
 * Overrides the first item and hands back BOTH the new list and the item it
 * replaced, so an arm can assert against the exact record it corrupted. The
 * throw is a fixture guard: `noUncheckedIndexedAccess` makes `items[0]`
 * possibly-undefined, and silently defaulting it would let a fixture that built
 * an empty population drive an arm that then proves nothing.
 */
const withFirstItem = (
  over: Partial<LiveQuiesceItem>,
): { readonly items: LiveQuiesceItem[]; readonly mutated: LiveQuiesceItem } => {
  const [first, ...rest] = fullPopulation();
  if (first === undefined) {
    throw new Error("fixture invariant: fullPopulation must yield at least one item");
  }
  const mutated: LiveQuiesceItem = { ...first, ...over };
  return { items: [mutated, ...rest], mutated };
};

/** Same guard on the read side, so an empty roster cannot make an arm vacuous. */
const onlyEntry = <T>(entries: readonly T[]): T => {
  const [first] = entries;
  if (first === undefined) {
    throw new Error("expected exactly one entry, received none");
  }
  return first;
};

const inputOf = (over: Partial<LiveQuiesceInventoryInput> = {}): LiveQuiesceInventoryInput => ({
  runMode: "LIVE",
  hostFingerprint: HOST,
  items: fullPopulation(),
  undiscoverableKinds: [],
  ...over,
});

/**
 * Codes actually OBSERVED firing by the arms below, recorded at runtime.
 * The roster test asserts this set equals the exported roster, which turns
 * "every code has an arm" from a hand-maintained claim into evidence: a code
 * whose arm is deleted or never written leaves this set and reds, even though
 * a literal mirror list would still agree with the roster.
 */
const observedCodes = new Set<string>();

describe("task-e60b874b: the live quiesce inventory refuses what it cannot honestly record", () => {
  it("accepts a well-formed LIVE inventory covering every roster kind", () => {
    const outcome = buildLiveInventory(inputOf());

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error(`expected acceptance, refused ${outcome.code}`);
    }
    expect(outcome.inventory.runMode).toBe("LIVE");
    expect(outcome.inventory.hostFingerprint).toBe(HOST);
    expect(outcome.inventory.itemCount).toBe(LIVE_QUIESCE_KINDS.length);
    expect(outcome.inventory.items).toHaveLength(outcome.inventory.itemCount);
  });

  it("refuses an empty population rather than reporting everything already stopped", () => {
    const outcome = buildLiveInventory(
      inputOf({
        items: [],
        // Declared so the refusal below is EMPTY_POPULATION and not KIND_UNACCOUNTED.
        undiscoverableKinds: LIVE_QUIESCE_KINDS.map((kind) => ({
          kind,
          attemptedBy: "no discovery method on this host",
          refusedByLayer: "host",
        })),
      }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error("an empty population must never be accepted");
    }
    expect(outcome.code).toBe("LIVE_QUIESCE_POPULATION_EMPTY");
    expect(outcome.layer).toBe(LIVE_QUIESCE_INVENTORY_LAYER);
    observedCodes.add(outcome.code);
  });

  it.each([
    ["absent", undefined],
    ["blank", "   "],
  ])("refuses an item whose discoveredBy is %s — nobody could re-find it", (_label, value) => {
    const { items, mutated } = withFirstItem({ discoveredBy: value as string });

    const outcome = buildLiveInventory(inputOf({ items }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error("an unfindable item must never be accepted");
    }
    expect(outcome.code).toBe("LIVE_QUIESCE_ITEM_UNDISCOVERABLE");
    expect(outcome.layer).toBe(LIVE_QUIESCE_INVENTORY_LAYER);
    observedCodes.add(outcome.code);
    expect(outcome.detail).toContain(mutated.id);
  });

  it("refuses a sandbox path inside a LIVE record — the exact task-4e1fe696 confusion", () => {
    const sandbox = join(tmpdir(), "moe-cutover-abc123", "state.json");
    const { items } = withFirstItem({ kind: "ACCESS_PATH", id: sandbox });

    const outcome = buildLiveInventory(inputOf({ items }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error("a tmpdir path in a LIVE record must never be accepted");
    }
    expect(outcome.code).toBe("LIVE_QUIESCE_SANDBOX_PATH_IN_LIVE_RUN");
    expect(outcome.layer).toBe(LIVE_QUIESCE_INVENTORY_LAYER);
    observedCodes.add(outcome.code);
  });

  it.each([
    ["absent", undefined],
    ["HARNESS", "HARNESS"],
  ])("refuses runMode %s so a harness run can never mint a live record", (_label, value) => {
    const outcome = buildLiveInventory(
      inputOf({ runMode: value as LiveQuiesceInventoryInput["runMode"] }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error("only runMode LIVE may mint this record");
    }
    expect(outcome.code).toBe("LIVE_QUIESCE_RUNMODE_MISSING");
    expect(outcome.layer).toBe(LIVE_QUIESCE_INVENTORY_LAYER);
    observedCodes.add(outcome.code);
  });

  it("refuses a kind outside the roster", () => {
    const { items } = withFirstItem({ kind: "REGISTRY_KEY" as LiveQuiesceKind });

    const outcome = buildLiveInventory(inputOf({ items }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error("an off-roster kind must never be accepted");
    }
    expect(outcome.code).toBe("LIVE_QUIESCE_KIND_UNKNOWN");
    expect(outcome.layer).toBe(LIVE_QUIESCE_INVENTORY_LAYER);
    observedCodes.add(outcome.code);
    expect(outcome.detail).toContain("REGISTRY_KEY");
  });

  it("refuses a roster kind that is neither populated nor declared undiscoverable", () => {
    const items = fullPopulation().filter((item) => item.kind !== "WATCHER");

    const outcome = buildLiveInventory(inputOf({ items }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error("a silently omitted kind must never be accepted");
    }
    expect(outcome.code).toBe("LIVE_QUIESCE_KIND_UNACCOUNTED");
    expect(outcome.layer).toBe(LIVE_QUIESCE_INVENTORY_LAYER);
    observedCodes.add(outcome.code);
    expect(outcome.detail).toContain("WATCHER");
  });

  it("accepts an undeclarable kind ONLY when the failed discovery method is named", () => {
    const items = fullPopulation().filter((item) => item.kind !== "HANDLE");

    const outcome = buildLiveInventory(
      inputOf({
        items,
        undiscoverableKinds: [
          {
            kind: "HANDLE",
            attemptedBy: "Get-Command handle.exe -> NOT PRESENT",
            refusedByLayer: "host",
          },
        ],
      }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error(`expected acceptance, refused ${outcome.code}`);
    }
    // The distinction this row exists to preserve: an undiscoverable kind is
    // carried as a named refusal, never collapsed into "nothing was found".
    expect(outcome.inventory.undiscoverableKinds).toHaveLength(1);
    const declared = onlyEntry(outcome.inventory.undiscoverableKinds);
    expect(declared.kind).toBe("HANDLE");
    expect(declared.attemptedBy).toContain("handle.exe");
    expect(outcome.inventory.items.some((item) => item.kind === "HANDLE")).toBe(false);
  });

  it("refuses an undiscoverable declaration whose attemptedBy is blank", () => {
    const items = fullPopulation().filter((item) => item.kind !== "HANDLE");

    const outcome = buildLiveInventory(
      inputOf({
        items,
        undiscoverableKinds: [{ kind: "HANDLE", attemptedBy: "  ", refusedByLayer: "host" }],
      }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error("an unexplained undiscoverable kind must never be accepted");
    }
    expect(outcome.code).toBe("LIVE_QUIESCE_ITEM_UNDISCOVERABLE");
    expect(outcome.layer).toBe(LIVE_QUIESCE_INVENTORY_LAYER);
    observedCodes.add(outcome.code);
  });
});

describe("task-e60b874b: inventory rosters and denominators", () => {
  it("LIVE_QUIESCE_KINDS holds exactly the five DoD-1 names, set-equal in both directions", () => {
    const expected = ["PROCESS", "HANDLE", "WATCHER", "SCHEDULED_START", "ACCESS_PATH"];

    expect(LIVE_QUIESCE_KINDS).toHaveLength(5);
    expect(expected).toHaveLength(5);
    // Both directions: a subset check alone stays green when a member is deleted,
    // because the roster's own iteration shrinks with it.
    for (const name of expected) {
      expect(LIVE_QUIESCE_KINDS).toContain(name);
    }
    for (const kind of LIVE_QUIESCE_KINDS) {
      expect(expected).toContain(kind);
    }
  });

  it("the refusal-code roster is frozen, non-empty, and every code has an arm above", () => {
    expect(LIVE_QUIESCE_INVENTORY_REFUSAL_CODES).toHaveLength(6);
    expect(Object.isFrozen(LIVE_QUIESCE_INVENTORY_REFUSAL_CODES)).toBe(true);
    expect(Object.isFrozen(LIVE_QUIESCE_KINDS)).toBe(true);

    const asserted = [
      "LIVE_QUIESCE_POPULATION_EMPTY",
      "LIVE_QUIESCE_ITEM_UNDISCOVERABLE",
      "LIVE_QUIESCE_SANDBOX_PATH_IN_LIVE_RUN",
      "LIVE_QUIESCE_RUNMODE_MISSING",
      "LIVE_QUIESCE_KIND_UNKNOWN",
      "LIVE_QUIESCE_KIND_UNACCOUNTED",
    ];
    expect(asserted).toHaveLength(LIVE_QUIESCE_INVENTORY_REFUSAL_CODES.length);
    for (const code of LIVE_QUIESCE_INVENTORY_REFUSAL_CODES) {
      expect(asserted).toContain(code);
    }
    for (const code of asserted) {
      expect(LIVE_QUIESCE_INVENTORY_REFUSAL_CODES).toContain(code);
    }
  });

  it("every roster code was OBSERVED firing above, not merely listed", () => {
    // Denominator stated. The literal list one case up agrees with the roster
    // even when an arm is deleted, because both are static; this set only grows
    // when a refusal actually fires, so a missing arm reds here.
    expect(observedCodes.size).toBe(LIVE_QUIESCE_INVENTORY_REFUSAL_CODES.length);
    expect(observedCodes.size).toBeGreaterThan(0);
    for (const code of LIVE_QUIESCE_INVENTORY_REFUSAL_CODES) {
      expect([...observedCodes]).toContain(code);
    }
    for (const code of observedCodes) {
      expect(LIVE_QUIESCE_INVENTORY_REFUSAL_CODES).toContain(code);
    }
  });
});
