/**
 * Canonical bytes for the durable activation ledger: injectivity of the derived
 * aggregate id, round trip, digest binding, and the encoder's shape refusals.
 *
 * The reader's own cases live beside the reader in
 * `activation-ledger-reader.test.ts`; fixtures are shared through
 * `activation-ledger-fixtures.ts` so the suites cannot drift apart about what a
 * legal activation looks like.
 */

import { SUPERVISOR_ACTIVATION_VERSION } from "@moe/runner";
import { describe, expect, it } from "vitest";

import {
  decodeActivationLedgerRecord,
  encodeActivationLedgerRecord,
} from "./activation-ledger-codec.js";
import {
  ACTIVATION_LEDGER_LAYER,
  ACTIVATION_LEDGER_RECORD_KEYS,
  ACTIVATION_LEDGER_RECORD_VERSION,
  deriveActivationAggregateId,
} from "./activation-ledger-contracts.js";
import { digestOf, encodedBytes, record } from "./activation-ledger-fixtures.js";

describe("deriveActivationAggregateId", () => {
  /**
   * Chosen to collide under a naive join. ('a','bc') vs ('ab','c') collide under
   * bare concatenation; the empty-component rows collide under that too.
   *
   * THE SEPARATOR-BEARING ROWS MUST CARRY THE PRODUCTION SEPARATOR, which is
   * `|`. Rows smuggling only `:` are not a separator test at all: dropping the
   * length prefixes while keeping `|` leaves every one of them distinct, so the
   * table stays green against a derivation whose framing has been removed. The
   * ("a|b","c") / ("a","b|c") pair is the one that closes it — both join to
   * `a|b|c` the moment the lengths go — and the `1:`-prefixed rows do the same
   * job for a scheme that keeps `|` but drops only the numeric prefix.
   */
  const COLLIDING_PAIRS: readonly (readonly [string, string])[] = [
    ["a", "bc"],
    ["ab", "c"],
    ["abc", ""],
    ["", "abc"],
    ["a|b", "c"],
    ["a", "b|c"],
    ["a:b", "c"],
    ["a", "b:c"],
    ["a b", "c"],
    ["a", " bc"],
    ["1:a", "1:b"],
    ["1", ":a1:b"],
  ];

  it("derives a distinct aggregate id for every pair a naive join would collide", () => {
    expect(COLLIDING_PAIRS.length).toBe(12);
    const derived = COLLIDING_PAIRS.map(([aggregateId, key]) =>
      deriveActivationAggregateId(aggregateId, key),
    );
    expect(new Set(derived).size).toBe(COLLIDING_PAIRS.length);
  });

  /**
   * Guards the table itself. A collision table that collides under nothing is a
   * transcript: it passes against a derivation with the framing torn out, and
   * the assertion above quietly stops discriminating. This pins the premise —
   * these rows DO collide once the length prefixes go, separately for the bare
   * join and for the separator-only join that keeps `|`.
   */
  it("holds rows that genuinely collide once the length framing is removed", () => {
    const bare = COLLIDING_PAIRS.map(([aggregateId, key]) => `${aggregateId}${key}`);
    expect(new Set(bare).size).toBeLessThan(COLLIDING_PAIRS.length);
    const separatorOnly = COLLIDING_PAIRS.map(([aggregateId, key]) => `${aggregateId}|${key}`);
    expect(new Set(separatorOnly).size).toBeLessThan(COLLIDING_PAIRS.length);
  });

  it("derives an identical aggregate id for identical inputs across calls", () => {
    for (const [aggregateId, key] of COLLIDING_PAIRS) {
      expect(deriveActivationAggregateId(aggregateId, key)).toBe(
        deriveActivationAggregateId(aggregateId, key),
      );
    }
  });
});

describe("activation ledger codec round trip", () => {
  it("decodes to a value equal field for field with no normalisation", () => {
    const original = record();
    const decoded = decodeActivationLedgerRecord(encodedBytes(original));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.record).toEqual(original);
  });

  it("returns a graph sharing no object identity with the encoded input", () => {
    const original = record();
    const decoded = decodeActivationLedgerRecord(encodedBytes(original));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.record).not.toBe(original);
    expect(decoded.record.lease).not.toBe(original.lease);
    expect(decoded.record.grant).not.toBe(original.grant);
    expect(decoded.record.effectIntent).not.toBe(original.effectIntent);
    expect(decoded.record.effectIntent.leaseBinding).not.toBe(original.effectIntent.leaseBinding);
    expect(decoded.record.budgetView.meters).not.toBe(original.budgetView.meters);
  });

  it("produces identical bytes and digest for two callers holding the same record", () => {
    const first = encodeActivationLedgerRecord(record());
    const second = encodeActivationLedgerRecord(record());
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect([...first.bytes]).toEqual([...second.bytes]);
    expect(first.digest).toBe(second.digest);
  });
});

/**
 * A value distinguishable from the fixture's, per field, so the sweep below
 * mutates something real. Bounded by ACTIVATION_LEDGER_RECORD_KEYS rather than
 * by a hand-written list, so a field added later cannot escape the sweep.
 */
const MUTATIONS: Readonly<Record<(typeof ACTIVATION_LEDGER_RECORD_KEYS)[number], unknown>> = {
  activationDigest: digestOf("other-activation"),
  // Same LENGTH as the authentic literal on purpose — see forgeBody.
  activationVersion: "moe-effect-activation/2",
  attempt: { ...record().attempt, version: 99 },
  budgetReservation: { ...record().budgetReservation, version: 99 },
  budgetView: { ...record().budgetView, version: 99 },
  effectIntent: { ...record().effectIntent, version: 99 },
  grant: { ...record().grant, grantId: "grant-9999" },
  lease: { ...record().lease, version: 99 },
  predecessorAttemptVersion: 99,
  predecessorIntentVersion: 99,
  providerSlot: { ...record().providerSlot, slotRef: "slot-9999" },
  recordVersion: "moe-activation-ledger/2",
};

/**
 * The body bytes of a record differing from the fixture in exactly ONE field.
 *
 * Two branches, because two fields are pinned literals that the production
 * encoder refuses outright — which is a stronger guard, not a weaker one, and
 * means those two cannot be forged by re-encoding a mutated record. For them the
 * authentic literal is overwritten in place with an equal-LENGTH variant, so
 * every frame length stays valid and the digest is the only thing left that can
 * catch the drift. Neither branch rebuilds framing: branch A calls the
 * production encoder, branch B substitutes bytes inside its output.
 */
function forgeBody(key: (typeof ACTIVATION_LEDGER_RECORD_KEYS)[number]): Uint8Array {
  const authentic = encodedBytes();
  const body = authentic.subarray(0, authentic.byteLength - 68);
  const mutated = encodeActivationLedgerRecord({ ...record(), [key]: MUTATIONS[key] });
  if (mutated.ok) return mutated.bytes.subarray(0, mutated.bytes.byteLength - 68);

  const literal = key === "recordVersion" ? ACTIVATION_LEDGER_RECORD_VERSION : SUPERVISOR_ACTIVATION_VERSION;
  const replacement = MUTATIONS[key] as string;
  expect(replacement.length, `${key} replacement must preserve framing`).toBe(literal.length);
  const at = Buffer.from(body).indexOf(literal, 0, "latin1");
  expect(at, `${key} literal must be present in the encoded body`).toBeGreaterThan(-1);
  const forged = Uint8Array.from(body);
  forged.set(new TextEncoder().encode(replacement), at);
  return forged;
}

describe("activation ledger digest binding", () => {
  it("refuses every single-field mutation of the encoded payload", () => {
    const authentic = encodedBytes();
    /** Everything after the framed body: the trailing digest the bytes carry. */
    const authenticTail = authentic.subarray(authentic.byteLength - 68);
    let swept = 0;
    for (const key of ACTIVATION_LEDGER_RECORD_KEYS) {
      // The mutated body carried under the AUTHENTIC digest: exactly the drift a
      // tamperer produces, and the only shape the digest check can catch.
      // Re-encoding a mutated record wholesale would re-derive its digest too
      // and would prove nothing at all.
      const body = forgeBody(key);
      const forged = new Uint8Array(body.byteLength + 68);
      forged.set(body, 0);
      forged.set(authenticTail, body.byteLength);
      const decoded = decodeActivationLedgerRecord(forged);
      expect(decoded.ok, `field ${key} escaped the digest`).toBe(false);
      if (decoded.ok) continue;
      expect(decoded.code).toBe("ACTIVATION_LEDGER_DIGEST_MISMATCH");
      expect(decoded.layer).toBe(ACTIVATION_LEDGER_LAYER);
      swept += 1;
    }
    expect(swept).toBe(ACTIVATION_LEDGER_RECORD_KEYS.length);
    expect(swept).toBe(12);
  });

  it("accepts the authentic bytes the sweep forged against", () => {
    expect(decodeActivationLedgerRecord(encodedBytes()).ok).toBe(true);
  });
});

describe("activation ledger encoder shape refusals", () => {
  it("refuses a record carrying an extra key", () => {
    const encoded = encodeActivationLedgerRecord({ ...record(), sneaked: true });
    expect(encoded.ok).toBe(false);
    if (encoded.ok) return;
    expect(encoded.code).toBe("ACTIVATION_LEDGER_RECORD_MALFORMED");
    expect(encoded.layer).toBe(ACTIVATION_LEDGER_LAYER);
    expect(encodeActivationLedgerRecord(record()).ok).toBe(true);
  });

  it("refuses a record missing a key", () => {
    const { grant: _dropped, ...missing } = record();
    const encoded = encodeActivationLedgerRecord(missing);
    expect(encoded.ok).toBe(false);
    if (encoded.ok) return;
    expect(encoded.code).toBe("ACTIVATION_LEDGER_RECORD_MALFORMED");
    expect(encodeActivationLedgerRecord(record()).ok).toBe(true);
  });

  it("refuses an unsupported record version", () => {
    const encoded = encodeActivationLedgerRecord({
      ...record(),
      recordVersion: "moe-activation-ledger/999",
    });
    expect(encoded.ok).toBe(false);
    if (encoded.ok) return;
    expect(encoded.code).toBe("ACTIVATION_LEDGER_VERSION_UNSUPPORTED");
    expect(encodeActivationLedgerRecord(record()).ok).toBe(true);
  });

  it("refuses a non-object and a malformed field without throwing", () => {
    for (const hostile of [null, undefined, 42, "record", []]) {
      const encoded = encodeActivationLedgerRecord(hostile);
      expect(encoded.ok).toBe(false);
      if (encoded.ok) continue;
      expect(encoded.code).toBe("ACTIVATION_LEDGER_RECORD_MALFORMED");
    }
    const badField = encodeActivationLedgerRecord({ ...record(), predecessorIntentVersion: -1 });
    expect(badField.ok).toBe(false);
    if (badField.ok) return;
    expect(badField.code).toBe("ACTIVATION_LEDGER_FIELD_INVALID");
    expect(encodeActivationLedgerRecord(record()).ok).toBe(true);
  });

  it("refuses decoding bytes that are not bytes at all", () => {
    for (const hostile of [null, undefined, "bytes", 42, new Uint8Array(0)]) {
      const decoded = decodeActivationLedgerRecord(hostile);
      expect(decoded.ok).toBe(false);
      if (decoded.ok) continue;
      expect(decoded.code).toBe("ACTIVATION_LEDGER_BYTES_MALFORMED");
      expect(decoded.layer).toBe(ACTIVATION_LEDGER_LAYER);
    }
    expect(decodeActivationLedgerRecord(encodedBytes()).ok).toBe(true);
  });
});
