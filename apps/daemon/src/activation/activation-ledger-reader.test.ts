/**
 * The production reader for the durable activation ledger.
 *
 * Beside the unit it tests, which is also what makes the reader a published unit
 * rather than scaffolding: `runtime-entrypoint.test.ts` classifies a module as
 * runtime tier when it has a direct `.test.ts` sibling or is reached from one.
 * When these cases lived inside the codec suite the reader was reachable only
 * from a test, so the bridge guard correctly called its `.js` bridge unexpected.
 *
 * The reader is where authority is most easily invented, so every refusal case
 * is paired with a POSITIVE accepted control through the SAME production reader
 * (task rail 2). A table of refusals with no accepted control is passed by a
 * reader that refuses everything — the worst possible bug here, dressed as the
 * safest one.
 */

import type { StoredEvent } from "@moe/store";
import { describe, expect, it } from "vitest";

import {
  ACTIVATION_LEDGER_LAYER,
  deriveActivationAggregateId,
} from "./activation-ledger-contracts.js";
import {
  DERIVED,
  EFFECT_AGGREGATE,
  encodedBytes,
  record,
  storedEvent,
} from "./activation-ledger-fixtures.js";
import { readActivationLedgerRecord } from "./activation-ledger-reader.js";

describe("activation ledger reader", () => {
  it("accepts exactly one correctly typed event and returns the record", () => {
    const read = readActivationLedgerRecord(DERIVED, [storedEvent()]);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.record).toEqual(record());
  });

  const REFUSALS: readonly {
    readonly name: string;
    readonly code: string;
    readonly events: readonly StoredEvent[];
  }[] = [
    { code: "ACTIVATION_LEDGER_EVIDENCE_ABSENT", events: [], name: "zero events" },
    {
      code: "ACTIVATION_LEDGER_EVIDENCE_AMBIGUOUS",
      events: [storedEvent(), storedEvent({ aggregateSequence: 2, eventId: "grant-0002" })],
      name: "two events",
    },
    {
      code: "ACTIVATION_LEDGER_EVENT_TYPE_UNEXPECTED",
      events: [storedEvent({ eventType: "SomethingElseHappened" })],
      name: "wrong event type",
    },
    {
      code: "ACTIVATION_LEDGER_EVENT_ID_MISMATCH",
      events: [storedEvent({ eventId: "not-the-grant-id" })],
      name: "event id is not the record's grantId",
    },
    {
      code: "ACTIVATION_LEDGER_BYTES_MALFORMED",
      events: [
        storedEvent({ payload: encodedBytes().subarray(0, encodedBytes().byteLength - 10) }),
      ],
      name: "truncated bytes",
    },
  ];

  for (const refusal of REFUSALS) {
    it(`refuses ${refusal.name} as UNKNOWN with its exact code and layer`, () => {
      const read = readActivationLedgerRecord(DERIVED, refusal.events);
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.code).toBe(refusal.code);
      expect(read.layer).toBe(ACTIVATION_LEDGER_LAYER);
      expect(read.outcome).toBe("UNKNOWN");
      // POSITIVE CONTROL, same production reader, same call shape: a reader that
      // refuses everything cannot pass this table.
      expect(readActivationLedgerRecord(DERIVED, [storedEvent()]).ok).toBe(true);
    });
  }

  it("refuses a payload whose derived aggregate id disagrees with the event's aggregate", () => {
    const read = readActivationLedgerRecord(
      deriveActivationAggregateId(EFFECT_AGGREGATE, "a-different-idempotency-key"),
      [storedEvent({ aggregateId: deriveActivationAggregateId(EFFECT_AGGREGATE, "a-different-idempotency-key") })],
    );
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.code).toBe("ACTIVATION_LEDGER_AGGREGATE_MISMATCH");
    expect(read.layer).toBe(ACTIVATION_LEDGER_LAYER);
    expect(readActivationLedgerRecord(DERIVED, [storedEvent()]).ok).toBe(true);
  });

  it("refuses when the successor intent version does not follow its predecessor", () => {
    const drifted = record({ predecessorIntentVersion: 1 });
    const read = readActivationLedgerRecord(DERIVED, [
      storedEvent({ payload: encodedBytes(drifted) }),
    ]);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.code).toBe("ACTIVATION_LEDGER_VERSION_MISMATCH");
    expect(read.layer).toBe(ACTIVATION_LEDGER_LAYER);
    expect(readActivationLedgerRecord(DERIVED, [storedEvent()]).ok).toBe(true);
  });

  it("refuses when the successor attempt version does not follow its predecessor", () => {
    const drifted = record({ predecessorAttemptVersion: 1 });
    const read = readActivationLedgerRecord(DERIVED, [
      storedEvent({ payload: encodedBytes(drifted) }),
    ]);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.code).toBe("ACTIVATION_LEDGER_VERSION_MISMATCH");
    expect(readActivationLedgerRecord(DERIVED, [storedEvent()]).ok).toBe(true);
  });

  it("refuses a digest that does not cover the bytes it is carried with", () => {
    const forged = Uint8Array.from(encodedBytes());
    // The LAST byte is the final hex character of the trailing digest. Index
    // -65 would be the digest frame's own length prefix, which refuses as
    // malformed framing and would never reach the digest comparison at all.
    const last = forged.byteLength - 1;
    forged[last] = forged[last] === 97 ? 98 : 97;
    const read = readActivationLedgerRecord(DERIVED, [storedEvent({ payload: forged })]);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.code).toBe("ACTIVATION_LEDGER_DIGEST_MISMATCH");
    expect(readActivationLedgerRecord(DERIVED, [storedEvent()]).ok).toBe(true);
  });
});
