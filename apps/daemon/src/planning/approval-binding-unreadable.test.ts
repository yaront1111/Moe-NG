import { describe, expect, it } from "vitest";

import type { SqliteEventStore } from "@moe/store";

import {
  APPROVAL_RUN_BINDING_CODES, verifyApprovedRunBinding,
} from "./approval-run-binding.js";

/**
 * "I COULD NOT READ THE SEAL" IS NOT "THIS RUN WAS NEVER SEALED".
 *
 * `sealedBodiesDigest` reads the planning-authority aggregate and answered `null` for a store
 * throw — the same null it answers when the bodies event is genuinely missing. The verifier then
 * refuses APPROVAL_AUTHORITY_UNSEALED, the affirmative claim that this run's planning authority
 * was never sealed. The file already documents that exact misdiagnosis for a different cause
 * (a renamed event type "presents as APPROVAL_AUTHORITY_UNSEALED on a sealed run — a refusal
 * that looks like a missing seal rather than a broken selector").
 *
 * The all-three-or-nothing rule is untouched: an unread digest still binds nothing. Only the
 * name changes, so an operator looking at a refused approval is sent to the store instead of
 * being told to re-run planning on a run that sealed fine.
 */

const RUN_ID = "run-1";
const REVISION = "graph-revision-1";

/** A run record that passes both upstream checks, so the seal read is actually reached. */
const REVIEWABLE_RUN = {
  authorityRef: "authority-1",
  envelopeDigest: "e".repeat(64),
  state: { graphRevisionRef: REVISION, lifecycle: "PLAN_REVIEW" },
};

const unreadableStore = (): SqliteEventStore => ({
  readEvents: (): never => {
    throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
  },
}) as unknown as SqliteEventStore;

const emptyStore = (): SqliteEventStore =>
  ({ readEvents: () => [] }) as unknown as SqliteEventStore;

const verify = (store: SqliteEventStore) => verifyApprovedRunBinding({
  graphRevisionRef: REVISION, run: REVIEWABLE_RUN, runId: RUN_ID, store,
});

describe("verifyApprovedRunBinding", () => {
  it("refuses UNREADABLE, not UNSEALED, when the authority aggregate cannot be read", () => {
    expect(verify(unreadableStore()))
      .toMatchObject({ code: "APPROVAL_AUTHORITY_UNREADABLE", ok: false });
  });

  it("still refuses UNSEALED for a run whose bodies event genuinely is not there", () => {
    expect(verify(emptyStore()))
      .toMatchObject({ code: "APPROVAL_AUTHORITY_UNSEALED", ok: false });
  });

  it("binds nothing on either arm, so all-three-or-nothing is unchanged", () => {
    for (const store of [unreadableStore(), emptyStore()]) {
      const result = verify(store);

      expect(result.ok).toBe(false);
      expect("binding" in result).toBe(false);
    }
  });

  it("keeps the upstream order: a non-reviewable run never consults the store", () => {
    const result = verifyApprovedRunBinding({
      graphRevisionRef: REVISION,
      run: { ...REVIEWABLE_RUN, state: { graphRevisionRef: REVISION, lifecycle: "DRAFT" } },
      runId: RUN_ID,
      store: unreadableStore(),
    });

    expect(result).toMatchObject({ code: "APPROVAL_RUN_NOT_REVIEWABLE", ok: false });
  });

  it("keeps the new code in the closed roster", () => {
    expect([...APPROVAL_RUN_BINDING_CODES]).toContain("APPROVAL_AUTHORITY_UNREADABLE");
  });
});
