/**
 * The inventory's internal invariant guards.
 *
 * These four codes are declared by `cutover-inventory.ts` but cannot be reached
 * through the well-formed fixture table, so without this file they would be
 * shipped-but-unexercised: a whole refusal surface asserted by nothing. Each
 * case drives ONE defective table and asserts the exact stable code, the layer
 * that refused, and the offending path id by name.
 *
 * `inert-writes` is the one that matters most in a real cutover: a deny or a
 * restore that reports success while the underlying state never moved. The guard
 * exists so that "I denied everything" can never be a claim about a write that
 * did not land.
 *
 * Like the rest of this directory, nothing here touches a real process.
 */

import { describe, expect, it } from "vitest";

import { createDefectiveAccessTable } from "./cutover-fixture.js";
import { denyAccessPaths, inventoryAccessPaths, restoreAccessPaths } from "./cutover-inventory.js";
import type { AccessStateSnapshot } from "./cutover-inventory.js";

function assertRefused<T extends { readonly ok: boolean }>(
  result: T,
): asserts result is Extract<T, { readonly ok: false }> {
  if (result.ok) {
    throw new Error("expected a refusal, received ok:true");
  }
}

describe("the inventory refuses a table that violates its own invariants", () => {
  it("refuses a duplicated access path by name", () => {
    const refusal = inventoryAccessPaths(createDefectiveAccessTable("duplicate"));
    assertRefused(refusal);
    expect(refusal.code).toBe("CUTOVER_INVENTORY_DUPLICATE_PATH");
    expect(refusal.layer).toBe("cutover-inventory");
    expect(refusal.pathId).toBe("legacy-daemon");
  });

  it("refuses a declared path that carries no state", () => {
    const refusal = inventoryAccessPaths(createDefectiveAccessTable("missing-state"));
    assertRefused(refusal);
    expect(refusal.code).toBe("CUTOVER_INVENTORY_STATE_MISSING");
    expect(refusal.layer).toBe("cutover-inventory");
    expect(refusal.pathId).toBe("legacy-daemon");
  });

  it("refuses to report a deny that never landed", () => {
    const refusal = denyAccessPaths(createDefectiveAccessTable("inert-writes"));
    assertRefused(refusal);
    expect(refusal.code).toBe("CUTOVER_INVENTORY_DENY_NOT_APPLIED");
    expect(refusal.layer).toBe("cutover-inventory");
    // The readback walks ids in UTF-8 order; legacy-archive-mount was already
    // DENIED, so the first path proven not to have moved is this one.
    expect(refusal.pathId).toBe("legacy-cli-process");
  });

  it("refuses to report a restore that never landed", () => {
    const table = createDefectiveAccessTable("inert-writes");
    const inventoried = inventoryAccessPaths(table);
    if (!inventoried.ok) {
      throw new Error("expected the inert-writes table to inventory cleanly");
    }
    // A complete, well-formed snapshot that differs from the live state: every
    // declared path is named, so only the post-write readback can refuse.
    const saved: AccessStateSnapshot = Object.fromEntries(
      inventoried.inventory.paths.map((path) => [path.id, "DENIED"] as const),
    );

    const refusal = restoreAccessPaths(table, saved);
    assertRefused(refusal);
    expect(refusal.code).toBe("CUTOVER_INVENTORY_RESTORE_NOT_APPLIED");
    expect(refusal.layer).toBe("cutover-inventory");
    expect(refusal.pathId).toBe("legacy-cli-process");
  });
});
