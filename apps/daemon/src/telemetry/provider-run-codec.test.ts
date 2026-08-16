/**
 * Canonical bytes for one provider run: determinism, the digest DOMAIN, and the
 * two decode guards.
 *
 * WHY EVERY CASE PINS CODE **AND** LAYER **AND** OUTCOME. Four stages can refuse
 * in this family (provider-run-refusals.ts:19-24), so a case asserting only the
 * code stays green the moment the composition or the ledger stage starts
 * answering first. `outcome` is the field that separates an operation this codec
 * DECLINED from durable evidence it could not verify, and epic rail 4 turns on
 * exactly that distinction, so it is never left unasserted.
 *
 * WHY THE FORGERIES SPLICE PRODUCTION OUTPUT INSTEAD OF BUILDING FRAMES. Every
 * hostile fixture below is an EQUAL-LENGTH substitution inside bytes the real
 * encoder produced, so no frame length is ever rebuilt here. A test that framed
 * its own bytes would be asserting against its own reimplementation of the
 * format rather than against the codec, and would keep passing after the format
 * moved. `withBody` asserts the length it preserves, so a format change fails
 * loudly here instead of splicing garbage into a valid-looking record.
 */

import type { ProviderFactUnknown } from "@moe/runner";
import { describe, expect, it } from "vitest";

import {
  decodeProviderRunRecord,
  encodeProviderRunRecord,
} from "./provider-run-codec.js";
import type {
  ProviderRunDecodeResult,
  ProviderRunEncodeResult,
} from "./provider-run-codec.js";
import { PROVIDER_RUN_RECORD_VERSION } from "./provider-run-contracts.js";
import type { ProviderRunRecord } from "./provider-run-contracts.js";
import { PROVIDER_RUN_LEDGER_CODES, PROVIDER_RUN_LEDGER_LAYERS } from "./provider-run-refusals.js";
import type { ProviderRunCode, ProviderRunRefusal } from "./provider-run-refusals.js";

/** Every provider fact in the fixture is an honest blind, which is a legal run. */
const blind: ProviderFactUnknown = {
  known: false,
  code: "TELEMETRY_USAGE_ABSENT",
  layer: "TELEMETRY_RESULT",
};

const record = (overrides: Partial<ProviderRunRecord> = {}): ProviderRunRecord => ({
  recordVersion: PROVIDER_RUN_RECORD_VERSION,
  providerRunRef: {
    provider: "claude",
    runRef: "run-1",
    effectIntentId: "effect-1",
    attemptRef: "attempt-1",
    epoch: 1,
  },
  launch: {
    kind: "REFUSED",
    truthClass: "UNKNOWN",
    reasonCode: null,
    reasonLayer: null,
    exit: null,
    effectDigest: null,
    activationDigest: null,
    runtimeBindingDigest: null,
    quotedRuntimeDigest: null,
    freshRuntimeDigest: null,
    pinnedClosureDigest: null,
    observationDigest: null,
    startedAt: null,
    completedAt: null,
  },
  declared: blind,
  observedModel: { modelId: blind, snapshotKind: "UNKNOWN", snapshotEvidence: blind },
  terminal: "UNKNOWN",
  infrastructure: "EXIT_UNOBSERVED",
  tokens: {
    inputTokens: blind,
    outputTokens: blind,
    cacheCreationInputTokens: blind,
    cacheReadInputTokens: blind,
    coverage: "UNKNOWN",
  },
  steps: { turns: blind, coverage: "UNKNOWN" },
  sequence: { known: true, value: 3 },
  concurrency: { fact: "NO_CONCURRENCY_FACTS", declaredCeiling: blind, achieved: blind },
  observedStart: { serverWallSeconds: 1_700_000_000, bootId: "boot-1", monotonicObservation: 12 },
  observedEnd: null,
  usage: [],
  usageRefusals: [
    {
      providerSequence: 1,
      issues: [
        { layer: "CONTRACT", code: "BUDGET_MEASUREMENT_MALFORMED", message: "no measurement" },
      ],
    },
  ],
  upstreamRefusal: null,
  stdoutReceiptDigest: blind,
  stderrReceiptDigest: blind,
  recordDigest: "",
  ...overrides,
});

function refused(result: ProviderRunEncodeResult | ProviderRunDecodeResult): ProviderRunRefusal {
  if (result.ok) throw new Error("expected a refusal, but the codec accepted the value");
  return result;
}

function encoded(value: unknown): Extract<ProviderRunEncodeResult, { ok: true }> {
  const result = encodeProviderRunRecord(value);
  if (!result.ok) throw new Error(`expected an encode, got ${result.code}`);
  return result;
}

const authentic = (): Uint8Array => encoded(record()).bytes;

/** Header is `${version}\n`, then a u32 length prefix, then the body. */
const BODY_START = PROVIDER_RUN_RECORD_VERSION.length + 1 + 4;
/** The trailing digest frame: a u32 length prefix plus 64 hex characters. */
const TAIL_BYTES = 4 + 64;

const bodyText = (bytes: Uint8Array): string =>
  new TextDecoder().decode(bytes.subarray(BODY_START, bytes.byteLength - TAIL_BYTES));

/**
 * Substitutes an EQUAL-LENGTH body into authentic bytes. The length assertion is
 * what keeps this honest: a framing change makes it fail here rather than
 * quietly producing bytes whose refusal proves nothing about the case's name.
 */
function withBody(text: string): Uint8Array {
  const bytes = authentic();
  const body = new TextEncoder().encode(text);
  expect(body.byteLength, "a spliced body must preserve every frame length").toBe(
    bytes.byteLength - TAIL_BYTES - BODY_START,
  );
  const forged = Uint8Array.from(bytes);
  forged.set(body, BODY_START);
  return forged;
}

const bodyLength = (): number => authentic().byteLength - TAIL_BYTES - BODY_START;

function paddedBody(value: Record<string, unknown>): string {
  const empty = JSON.stringify({ ...value, __padding__: "" });
  const padding = bodyLength() - new TextEncoder().encode(empty).byteLength;
  expect(padding, "the malformed record must fit the production body frame").toBeGreaterThan(0);
  return JSON.stringify({ ...value, __padding__: "x".repeat(padding) });
}

describe("encodeProviderRunRecord", () => {
  /**
   * Compared as BYTES. Asserting two encodings equal through their digests
   * would be circular: the digest is the thing under test.
   */
  it("encodes one record to byte-identical output twice", () => {
    expect(encoded(record()).bytes).toEqual(encoded(record()).bytes);
  });

  it("parses back as JSON at the body offset every forgery splices into", () => {
    expect(() => JSON.parse(bodyText(authentic()))).not.toThrow();
  });

  /**
   * THE DIGEST DOMAIN. `recordDigest` is a field ON the record, so a digest over
   * the whole record would fold the digest into its own input. Two records
   * differing ONLY there must encode to the SAME bytes — that is what proves the
   * field is excluded from the domain rather than merely overwritten afterwards.
   */
  it("excludes recordDigest from the bytes it digests", () => {
    expect(encoded(record({ recordDigest: "a".repeat(64) })).bytes).toEqual(
      encoded(record({ recordDigest: "b".repeat(64) })).bytes,
    );
  });

  /**
   * The forged-digest-through-the-front-door path: if the encoder kept the
   * caller's value, a record whose own digest field describes nothing would be
   * handed to the ledger and every later verification against it is theatre.
   */
  it("overwrites a caller-supplied recordDigest with the digest of its own bytes", () => {
    const result = encoded(record({ recordDigest: "not-a-digest" }));
    expect(result.record.recordDigest).toBe(result.digest);
    expect(result.record.recordDigest).not.toBe("not-a-digest");
    expect(decodeProviderRunRecord(result.bytes).ok).toBe(true);
  });

  it("refuses an accessor-backed caller digest without invoking it", () => {
    const hostile = record();
    let invoked = false;
    Object.defineProperty(hostile, "recordDigest", {
      enumerable: true,
      get: () => {
        invoked = true;
        throw new Error("the caller digest must stay unread");
      },
    });

    const refusal = refused(encodeProviderRunRecord(hostile));
    expect(refusal.code).toBe("PROVIDER_RUN_FIELD_INVALID");
    expect(refusal.layer).toBe("PROVIDER_RUN_CODEC");
    expect(refusal.outcome).toBe("REFUSED");
    expect(invoked).toBe(false);
  });

  it("refuses a nested proxy rather than sealing trap-controlled evidence", () => {
    const refusal = refused(
      encodeProviderRunRecord(record({ sequence: new Proxy({ known: true, value: 3 }, {}) })),
    );
    expect(refusal.code).toBe("PROVIDER_RUN_FIELD_INVALID");
    expect(refusal.layer).toBe("PROVIDER_RUN_CODEC");
    expect(refusal.outcome).toBe("REFUSED");
  });

  it("preserves an own __proto__ field instead of collapsing it into the prototype setter", () => {
    const hostile = record();
    Object.defineProperty(hostile, "__proto__", { enumerable: true, value: "evidence" });
    const result = encoded(hostile);
    expect(JSON.parse(bodyText(result.bytes))).toHaveProperty("__proto__", "evidence");
    expect(result.bytes).not.toEqual(encoded(record()).bytes);
  });

  it("returns a frozen snapshot detached from the caller", () => {
    const input = record();
    const result = encoded(input);
    (input.providerRunRef as { runRef: string }).runRef = "moved-after-encode";
    expect(result.record.providerRunRef.runRef).toBe("run-1");
    expect(Object.isFrozen(result.record)).toBe(true);
    expect(Object.isFrozen(result.record.providerRunRef)).toBe(true);
  });

  it("round-trips a record through encode and decode", () => {
    const result = encoded(record());
    const decoded = decodeProviderRunRecord(result.bytes);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.record).toEqual({ ...record(), recordDigest: result.digest });
    expect(decoded.digest).toBe(result.digest);
  });

  it("refuses a value that is not a record at all", () => {
    for (const hostile of [null, undefined, 42, "record", []]) {
      const refusal = refused(encodeProviderRunRecord(hostile));
      expect(refusal.code).toBe("PROVIDER_RUN_RECORD_MALFORMED");
      expect(refusal.layer).toBe("PROVIDER_RUN_CODEC");
      expect(refusal.outcome).toBe("REFUSED");
    }
    expect(encodeProviderRunRecord(record()).ok).toBe(true);
  });

  it("refuses a partial plain object rather than adopting it as a record", () => {
    const refusal = refused(
      encodeProviderRunRecord({ recordVersion: PROVIDER_RUN_RECORD_VERSION }),
    );
    expect(refusal.code).toBe("PROVIDER_RUN_RECORD_MALFORMED");
    expect(refusal.layer).toBe("PROVIDER_RUN_CODEC");
    expect(refusal.outcome).toBe("REFUSED");
  });

  it("refuses every record missing a required identity or fact field", () => {
    const required = [
      "recordVersion", "providerRunRef", "launch", "declared", "observedModel",
      "terminal", "infrastructure", "tokens", "steps", "sequence", "concurrency",
      "usage", "usageRefusals", "stdoutReceiptDigest", "stderrReceiptDigest",
    ] as const;
    expect(required).toHaveLength(15);
    for (const key of required) {
      const incomplete = { ...record() } as Record<string, unknown>;
      delete incomplete[key];
      const refusal = refused(encodeProviderRunRecord(incomplete));
      expect(refusal.code, key).toBe("PROVIDER_RUN_RECORD_MALFORMED");
      expect(refusal.layer, key).toBe("PROVIDER_RUN_CODEC");
      expect(refusal.outcome, key).toBe("REFUSED");
    }
  });

  it("refuses a malformed nested record field", () => {
    const malformed = [
      record({ sequence: { known: true, value: "3" } as never }),
      record({ launch: { ...record().launch, kind: "FORGED" as never } }),
      record({ terminal: "FORGED" as never }),
      record({ usage: [{} as never] }),
    ];
    expect(malformed).toHaveLength(4);
    for (const candidate of malformed) {
      const refusal = refused(encodeProviderRunRecord(candidate));
      expect(refusal.code).toBe("PROVIDER_RUN_FIELD_INVALID");
      expect(refusal.layer).toBe("PROVIDER_RUN_CODEC");
      expect(refusal.outcome).toBe("REFUSED");
    }
  });

  it("refuses a record version this codec does not write", () => {
    const refusal = refused(
      encodeProviderRunRecord(record({ recordVersion: "moe-provider-run-record/9" as never })),
    );
    expect(refusal.code).toBe("PROVIDER_RUN_VERSION_UNSUPPORTED");
    expect(refusal.layer).toBe("PROVIDER_RUN_CODEC");
    expect(refusal.outcome).toBe("REFUSED");
  });

  /**
   * UNDEFINED VS ABSENT VS NULL, the rule this module states in its header.
   * `undefined` REFUSES rather than being silently coerced: JSON.stringify drops
   * it, so a coercing codec would encode a field nobody set and a field set to
   * nothing to the same bytes. `null` is data and absent stays absent.
   */
  it("refuses a record carrying undefined where a value belongs", () => {
    const refusal = refused(
      encodeProviderRunRecord(record({ observedEnd: undefined as unknown as null })),
    );
    expect(refusal.code).toBe("PROVIDER_RUN_FIELD_INVALID");
    expect(refusal.layer).toBe("PROVIDER_RUN_CODEC");
    expect(refusal.outcome).toBe("REFUSED");
  });

  it("refuses undefined hiding inside a nested array hole", () => {
    const holed = record();
    const refusal = refused(
      encodeProviderRunRecord({ ...holed, usage: new Array(2) as ProviderRunRecord["usage"] }),
    );
    expect(refusal.code).toBe("PROVIDER_RUN_FIELD_INVALID");
    expect(refusal.layer).toBe("PROVIDER_RUN_CODEC");
    expect(refusal.outcome).toBe("REFUSED");
  });

  it("keeps an absent field distinct from an explicit null", () => {
    const { observedEnd: _dropped, ...missing } = record();
    expect(encoded(missing).bytes).not.toEqual(encoded(record({ observedEnd: null })).bytes);
  });

  /**
   * JSON.stringify turns NaN and Infinity into `null`, so an unencodable
   * quantity would otherwise become an explicit "no value" inside durable bytes
   * that nobody can tell apart from a real one.
   */
  it("refuses a numeric field JSON cannot represent", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const refusal = refused(
        encodeProviderRunRecord(record({ sequence: { known: true, value } })),
      );
      expect(refusal.code).toBe("PROVIDER_RUN_FIELD_INVALID");
      expect(refusal.layer).toBe("PROVIDER_RUN_CODEC");
      expect(refusal.outcome).toBe("REFUSED");
    }
  });

  it("refuses a cyclic record instead of overflowing the stack", () => {
    const cyclic: Record<string, unknown> = { ...record() };
    cyclic["self"] = cyclic;
    const refusal = refused(encodeProviderRunRecord(cyclic));
    expect(refusal.code).toBe("PROVIDER_RUN_FIELD_INVALID");
    expect(refusal.layer).toBe("PROVIDER_RUN_CODEC");
    expect(refusal.outcome).toBe("REFUSED");
  });
});

describe("decodeProviderRunRecord refusals", () => {
  it("refuses input that is not durable bytes at all", () => {
    for (const hostile of [null, undefined, "bytes", 42, new Uint8Array(0)]) {
      const refusal = refused(decodeProviderRunRecord(hostile));
      expect(refusal.code).toBe("PROVIDER_RUN_BYTES_MALFORMED");
      expect(refusal.layer).toBe("PROVIDER_RUN_CODEC");
      expect(refusal.outcome).toBe("UNKNOWN");
    }
  });

  it("contains a trap-backed Uint8Array as malformed bytes", () => {
    const refusal = refused(decodeProviderRunRecord(new Proxy(authentic(), {})));
    expect(refusal.code).toBe("PROVIDER_RUN_BYTES_MALFORMED");
    expect(refusal.layer).toBe("PROVIDER_RUN_CODEC");
    expect(refusal.outcome).toBe("UNKNOWN");
  });

  it("refuses truncated bytes", () => {
    const whole = authentic();
    for (const cut of [1, TAIL_BYTES, whole.byteLength - BODY_START]) {
      const refusal = refused(decodeProviderRunRecord(whole.subarray(0, whole.byteLength - cut)));
      expect(refusal.code).toBe("PROVIDER_RUN_BYTES_MALFORMED");
      expect(refusal.layer).toBe("PROVIDER_RUN_CODEC");
      expect(refusal.outcome).toBe("UNKNOWN");
    }
  });

  it("refuses a body that is not parseable JSON", () => {
    const refusal = refused(decodeProviderRunRecord(withBody("x".repeat(bodyLength()))));
    expect(refusal.code).toBe("PROVIDER_RUN_BYTES_MALFORMED");
    expect(refusal.layer).toBe("PROVIDER_RUN_CODEC");
    expect(refusal.outcome).toBe("UNKNOWN");
  });

  /**
   * Parses cleanly and is still not a record. Refused as UNREADABLE rather than
   * as a digest mismatch, because a shape this codec could never have written is
   * a different fact from evidence that drifted, and the ledger reader has to be
   * able to tell them apart.
   */
  it("refuses a body that parses to something other than a record", () => {
    const refusal = refused(
      decodeProviderRunRecord(withBody(`"${"x".repeat(bodyLength() - 2)}"`)),
    );
    expect(refusal.code).toBe("PROVIDER_RUN_RECORD_UNREADABLE");
    expect(refusal.layer).toBe("PROVIDER_RUN_CODEC");
    expect(refusal.outcome).toBe("UNKNOWN");
  });

  it("refuses a parsed partial object before either verification guard can answer", () => {
    const partial = paddedBody({ recordVersion: PROVIDER_RUN_RECORD_VERSION });
    expect(new TextEncoder().encode(partial).byteLength).toBe(bodyLength());
    const refusal = refused(decodeProviderRunRecord(withBody(partial)));
    expect(refusal.code).toBe("PROVIDER_RUN_RECORD_UNREADABLE");
    expect(refusal.layer).toBe("PROVIDER_RUN_CODEC");
    expect(refusal.outcome).toBe("UNKNOWN");
  });

  it("refuses bytes stamped with a record version this codec does not read", () => {
    const stamped = authentic();
    const forged = Uint8Array.from(stamped);
    forged.set(new TextEncoder().encode("moe-provider-run-record/9"), 0);
    const refusal = refused(decodeProviderRunRecord(forged));
    expect(refusal.code).toBe("PROVIDER_RUN_VERSION_UNSUPPORTED");
    expect(refusal.layer).toBe("PROVIDER_RUN_CODEC");
    expect(refusal.outcome).toBe("UNKNOWN");
  });

  it("refuses a body whose own recordVersion was swapped under the header", () => {
    const swapped = bodyText(authentic()).replace(
      `"${PROVIDER_RUN_RECORD_VERSION}"`,
      '"moe-provider-run-record/9"',
    );
    expect(swapped).not.toBe(bodyText(authentic()));
    const refusal = refused(decodeProviderRunRecord(withBody(swapped)));
    expect(refusal.code).toBe("PROVIDER_RUN_VERSION_UNSUPPORTED");
    expect(refusal.layer).toBe("PROVIDER_RUN_CODEC");
    expect(refusal.outcome).toBe("UNKNOWN");
  });
});

/**
 * THE TWO GUARDS, drilled one at a time by the cases below.
 *
 * Guard A recomputes the digest over the DECODED value; guard B re-encodes that
 * value and compares BYTES. Neither implies the other, and each case here is the
 * forgery its own guard is the only one that catches:
 *
 * - `digest that does not match` passes guard B untouched — the body is the
 *   authentic canonical body — so only guard A can refuse it.
 * - `non-canonical encoding` passes guard A untouched — the digest carried is
 *   the digest of the value, and the value is unchanged by re-ordering its keys
 *   — so only guard B can refuse it.
 *
 * Disabling either guard therefore reddens exactly one of these named cases. A
 * drill that disabled both would prove nothing about either.
 */
describe("decodeProviderRunRecord verification guards", () => {
  it("refuses bytes whose carried digest does not match the record: guard A", () => {
    const bytes = authentic();
    const forged = Uint8Array.from(bytes);
    const substitute = "a".repeat(64);
    expect(new TextDecoder().decode(bytes.subarray(bytes.byteLength - 64))).not.toBe(substitute);
    forged.set(new TextEncoder().encode(substitute), bytes.byteLength - 64);
    expect(bodyText(forged)).toBe(bodyText(bytes));

    const refusal = refused(decodeProviderRunRecord(forged));
    expect(refusal.code).toBe("PROVIDER_RUN_DIGEST_MISMATCH");
    expect(refusal.layer).toBe("PROVIDER_RUN_CODEC");
    expect(refusal.outcome).toBe("UNKNOWN");
  });

  it("refuses a non-canonical encoding of an otherwise authentic record: guard B", () => {
    const canonical = bodyText(authentic());
    const parsed = JSON.parse(canonical) as Record<string, unknown>;
    const reordered: Record<string, unknown> = {};
    for (const key of Object.keys(parsed).reverse()) reordered[key] = parsed[key];
    const shuffled = JSON.stringify(reordered);
    expect(shuffled, "the re-ordered body must actually differ").not.toBe(canonical);
    expect(JSON.parse(shuffled)).toEqual(parsed);

    const refusal = refused(decodeProviderRunRecord(withBody(shuffled)));
    expect(refusal.code).toBe("PROVIDER_RUN_DIGEST_MISMATCH");
    expect(refusal.layer).toBe("PROVIDER_RUN_CODEC");
    expect(refusal.outcome).toBe("UNKNOWN");
  });

  it("accepts the authentic bytes every forgery above was spliced from", () => {
    expect(decodeProviderRunRecord(authentic()).ok).toBe(true);
  });
});

/**
 * The codec answers in SIX codes and one layer, all imported. Seventeen codes
 * exist; the other eleven belong to the composition, ledger and reader stages,
 * and answering with one of those here would put this stage's verdict in another
 * stage's vocabulary. Every one of the six is asserted reachable, so a code that
 * quietly became dead is caught here rather than by a reader that never sees it.
 */
describe("provider-run codec vocabulary", () => {
  const OWNED: readonly ProviderRunCode[] = [
    "PROVIDER_RUN_RECORD_MALFORMED",
    "PROVIDER_RUN_FIELD_INVALID",
    "PROVIDER_RUN_VERSION_UNSUPPORTED",
    "PROVIDER_RUN_BYTES_MALFORMED",
    "PROVIDER_RUN_DIGEST_MISMATCH",
    "PROVIDER_RUN_RECORD_UNREADABLE",
  ];

  it("selects only this stage's six codes and only this stage's layer", () => {
    const digestForged = Uint8Array.from(authentic());
    digestForged.set(new TextEncoder().encode("a".repeat(64)), digestForged.byteLength - 64);
    const versionForged = Uint8Array.from(authentic());
    versionForged.set(new TextEncoder().encode("moe-provider-run-record/9"), 0);

    const emitted = [
      refused(encodeProviderRunRecord(42)),
      refused(encodeProviderRunRecord(record({ observedEnd: undefined as unknown as null }))),
      refused(encodeProviderRunRecord(record({ recordVersion: "x" as never }))),
      refused(decodeProviderRunRecord(new Uint8Array([1, 2, 3]))),
      refused(decodeProviderRunRecord(digestForged)),
      refused(decodeProviderRunRecord(withBody(`"${"x".repeat(bodyLength() - 2)}"`))),
      refused(decodeProviderRunRecord(versionForged)),
    ];

    expect(emitted.length).toBe(7);
    for (const refusal of emitted) {
      expect(PROVIDER_RUN_LEDGER_CODES).toContain(refusal.code);
      expect(PROVIDER_RUN_LEDGER_LAYERS).toContain(refusal.layer);
      expect(refusal.layer).toBe("PROVIDER_RUN_CODEC");
      expect(refusal.storeCode).toBeNull();
    }
    expect([...new Set(emitted.map((refusal) => refusal.code))].sort()).toEqual([...OWNED].sort());
  });
});
