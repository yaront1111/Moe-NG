/**
 * Runtime guards for `provider-run-contracts.ts`. The refusal vocabulary it was
 * split from has its own suite beside it — a sibling test file is what makes a
 * module RUNTIME TIER in this package (runtime-entrypoint.test.ts:150-172), so
 * folding both modules into one suite would have classified the untested one as
 * scaffolding and rejected its `.js` bridge as unexpected.
 *
 * The record is almost entirely type declarations, which vanish before a test
 * can see them. So nothing here asserts that the module "is defined" — that
 * passes for any file, including an empty one. Every case below pins a RUNTIME
 * value: the two durable identity strings and the aggregate derivation.
 */

import type { ProviderRunRef } from "@moe/runner";
import { SqliteEventStore } from "@moe/store";
import { describe, expect, it } from "vitest";

import {
  PROVIDER_RUN_EVENT_TYPE,
  PROVIDER_RUN_RECORD_VERSION,
  deriveProviderRunAggregateId,
} from "./provider-run-contracts.js";

const ref = (overrides: Partial<ProviderRunRef> = {}): ProviderRunRef => ({
  provider: "claude",
  runRef: "run-1",
  effectIntentId: "effect-1",
  attemptRef: "attempt-1",
  epoch: 1,
  ...overrides,
});

describe("provider-run record identity", () => {
  it("pins the record version string", () => {
    expect(PROVIDER_RUN_RECORD_VERSION).toBe("moe-provider-run-record/1");
  });

  /**
   * The ledger slice writes this type and its reader accepts no other, so the
   * exact string is a durable contract between two modules that never compile
   * against one another's literals. A rename here would be invisible until a
   * read came back empty against events that were written fine.
   */
  it("pins the durable event type", () => {
    expect(PROVIDER_RUN_EVENT_TYPE).toBe("ProviderRunTelemetryCommitted");
  });
});

describe("deriveProviderRunAggregateId", () => {
  it("pins the deterministic aggregate id format", () => {
    expect(deriveProviderRunAggregateId(ref())).toBe(
      "moe-provider-run-record/1|aggregate|sha256:" +
      "cc903fb8a131c2302532b40e2287ffdf56f60e041f00d3a473db5dc05a5d4f69",
    );
  });

  /**
   * FIELD BY FIELD, because a derivation that silently ignores one identity
   * field is invisible to a round-trip test and to determinism: two different
   * runs would land on ONE aggregate head, and the ledger slice would then
   * reject a legitimate second run as an expected-version conflict.
   *
   * `provider` is single-valued today, so its row casts through the declared
   * field type — the same technique claude-launch-selection.test.ts:202 uses to
   * drill a literal-typed discriminant.
   */
  const VARIED: readonly (readonly [string, ProviderRunRef])[] = [
    ["provider", ref({ provider: "codex" as ProviderRunRef["provider"] })],
    ["runRef", ref({ runRef: "run-2" })],
    ["effectIntentId", ref({ effectIntentId: "effect-2" })],
    ["attemptRef", ref({ attemptRef: "attempt-2" })],
    ["epoch", ref({ epoch: 2 })],
  ];

  it.each(VARIED)("separates two runs differing only in %s", (_field, varied) => {
    expect(deriveProviderRunAggregateId(varied)).not.toBe(deriveProviderRunAggregateId(ref()));
  });

  it("drills every identity field of the run reference", () => {
    expect(VARIED.map(([field]) => field)).toEqual([
      "provider",
      "runRef",
      "effectIntentId",
      "attemptRef",
      "epoch",
    ]);
    expect(VARIED.length).toBe(Object.keys(ref()).length);
  });

  /**
   * Rows chosen to collide under a naive preimage join. Each pair moves one
   * character across a field boundary, so dropping the length framing feeds the
   * same bytes into the digest while every field-by-field row above stays green.
   * The row carrying `|` closes the variant that keeps a separator but drops only
   * the numeric prefix.
   */
  const COLLIDING: readonly (readonly [string, ProviderRunRef, ProviderRunRef])[] = [
    ["run/effect shift", ref({ runRef: "a", effectIntentId: "bc" }), ref({ runRef: "ab", effectIntentId: "c" })],
    ["effect/attempt shift", ref({ effectIntentId: "a", attemptRef: "bc" }), ref({ effectIntentId: "ab", attemptRef: "c" })],
    ["empty component swap", ref({ runRef: "", effectIntentId: "x" }), ref({ runRef: "x", effectIntentId: "" })],
    ["component bearing the separator", ref({ runRef: "a|b", effectIntentId: "c" }), ref({ runRef: "a", effectIntentId: "b|c" })],
    ["attempt/epoch digit shift", ref({ attemptRef: "1", epoch: 12 }), ref({ attemptRef: "11", epoch: 2 })],
  ];

  it.each(COLLIDING)("keeps a naive-join collision distinct: %s", (_case, left, right) => {
    expect(deriveProviderRunAggregateId(left)).not.toBe(deriveProviderRunAggregateId(right));
  });

  /**
   * A swept table that silently produced zero rows would pass while testing
   * nothing, so the cases are asserted to have been generated — by name, not by
   * a count alone. Four rows collide under a bare concatenation; the separator
   * row is the only one that also collides when the framing goes but the `|`
   * join stays, which is why dropping it would leave that mutant alive.
   */
  it("sweeps every reviewed collision shape", () => {
    expect(COLLIDING.map(([label]) => label)).toEqual([
      "run/effect shift",
      "effect/attempt shift",
      "empty component swap",
      "component bearing the separator",
      "attempt/epoch digit shift",
    ]);
  });

  /**
   * The store's `requireIdentifier` rejects an identifier containing a NUL, and
   * it does so at commit time — after the codec, the framing table and every
   * injectivity row above have gone green. Pin the printable alphabet here so a
   * separator regression is caught by this suite instead of by a real store.
   */
  it("derives an identifier of printable characters only", () => {
    expect(deriveProviderRunAggregateId(ref())).toMatch(/^[!-~]+$/u);
  });

  it("derives a store-admissible id from maximum producer run references", () => {
    const maximumRef = ref({
      attemptRef: "a".repeat(200),
      effectIntentId: "e".repeat(200),
      epoch: Number.MAX_SAFE_INTEGER,
      runRef: "r".repeat(200),
    });
    const store = SqliteEventStore.openEphemeralForProjectTest("provider-run-contract-test");
    try {
      expect(store.readEvents(deriveProviderRunAggregateId(maximumRef))).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("namespaces the aggregate id with the record version", () => {
    expect(deriveProviderRunAggregateId(ref())).toContain(PROVIDER_RUN_RECORD_VERSION);
  });
});
