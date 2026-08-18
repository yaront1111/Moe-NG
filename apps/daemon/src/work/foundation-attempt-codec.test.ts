/**
 * The shared hostile-input snapshot bound, tested on the helper that owns it.
 *
 * WHY THIS FILE EXISTS. `snapshotFoundationValue` is imported by the evidence
 * verification service and store, goal qualification reads, journal append and
 * read, the attempt-release path and the context-manifest codec — but it had no
 * suite of its own; every existing assertion about it reaches it through one of
 * those consumers. The bound this file pins is per-TYPE, and a per-type rule can
 * only be stated where both types are reachable: through the context codec, the
 * generic-array half is unreachable, because that codec's `exactBytes` guard
 * (`boundedInteger(byte, 255)` on every element, and it rejects `-0` itself)
 * answers first and would make these arms green while testing nothing.
 *
 * THE RULE. A generic array stops at 512 items. An array whose EVERY element is
 * a byte may run to `FOUNDATION_ATTEMPT_MAX_REQUEST_BYTES`, the same 1 MiB
 * ceiling this codec already enforces on `Uint8Array.byteLength`, so one payload
 * is bounded alike whether it arrives as a typed array or as a JSON number array
 * — which is how a rendered context manifest carries its bytes.
 *
 * Every arm asserts the exact refusal code. `decodeFoundationAttemptRequest` is
 * the production surface used deliberately: it is what maps this helper's
 * sentinel onto a stable code, and asserting "the snapshot came back as a
 * symbol" would pin an internal instead.
 */

import { describe, expect, it } from "vitest";

import {
  FOUNDATION_ATTEMPT_MAX_REQUEST_BYTES,
  decodeFoundationAttemptRequest,
} from "./foundation-attempt-codec.js";

/** Hand-transcribed, so a silent change to the production constant reddens here
 *  rather than being followed silently by a test that imports it. */
const EXPECTED_BYTE_CEILING = 1_048_576;
/** The generic array bound, likewise transcribed rather than imported. */
const GENERIC_ITEM_LIMIT = 512;

const MALFORMED = "FOUNDATION_ATTEMPT_REQUEST_MALFORMED";

/** A minimal request every field of which is valid, so only `graphSnapshot` varies. */
function requestWith(graphSnapshot: unknown): Record<string, unknown> {
  return {
    activationRequestBytes: new TextEncoder().encode("{\"activate\":true}"),
    binding: {
      attemptAggregateId: "foundation-attempt-0001",
      nodeKey: "dev-c",
      sessionId: "session-0000000000000001",
    },
    graphSnapshot,
    inputManifest: { baseIdentity: "a".repeat(64), entries: [] },
    launchTemplate: {
      argv: ["claude"],
      bootstrapCredentialDigest: "b".repeat(64),
      cwd: "D:/projexts/moe-next",
      environment: {},
      launchSelection: null,
      limits: null,
      runtime: { installedRoot: "D:/runtime", pinRoot: "D:/pin", quotedObservation: {} },
    },
  };
}

/** `n` bytes, with `patch` applied to the LAST index — the position a sampled or
 *  first-element check would never look at. */
function byteArray(n: number, patch?: unknown): unknown[] {
  const items: unknown[] = new Array(n).fill(7);
  if (patch !== undefined) items[n - 1] = patch;
  return items;
}

/** `levels` nested objects around `{ bytes }`, so depth can be varied exactly. */
function wrapped(levels: number, bytes: unknown[]): unknown {
  let nested: unknown = { bytes };
  for (let level = 0; level < levels; level += 1) nested = { nested };
  return nested;
}

function refusalCodeOf(graphSnapshot: unknown): string | null {
  const decoded = decodeFoundationAttemptRequest(requestWith(graphSnapshot));
  return decoded.ok ? null : decoded.code;
}

function admittedSnapshotOf(graphSnapshot: unknown): unknown {
  const decoded = decodeFoundationAttemptRequest(requestWith(graphSnapshot));
  if (!decoded.ok) throw new Error(`expected an admission, got ${decoded.code}`);
  return decoded.request.graphSnapshot;
}

describe("the published byte ceiling", () => {
  it("is the codec's own request-byte bound, and it is 1 MiB", () => {
    // Both halves matter: the transcription catches a silent change to the
    // constant, and the identity catches the two byte bounds drifting apart.
    expect(FOUNDATION_ATTEMPT_MAX_REQUEST_BYTES).toBe(EXPECTED_BYTE_CEILING);
  });
});

describe("generic arrays keep the 512-item bound", () => {
  it("admits a generic array exactly at the limit", () => {
    const strings = new Array(GENERIC_ITEM_LIMIT).fill("x");
    expect(admittedSnapshotOf({ items: strings })).toEqual({ items: strings });
  });

  it("refuses a generic array one item past the limit with the exact code", () => {
    // THE PER-TYPE PROOF. If the fix had raised MAX_ITEMS globally, this admits.
    expect(refusalCodeOf({ items: new Array(GENERIC_ITEM_LIMIT + 1).fill("x") })).toBe(MALFORMED);
  });

  it("refuses an over-length array of mixed values even when most are bytes", () => {
    expect(refusalCodeOf({ items: byteArray(GENERIC_ITEM_LIMIT + 1, "x") })).toBe(MALFORMED);
  });

  it("admits an empty array, which the widened path must not have disturbed", () => {
    expect(admittedSnapshotOf({ items: [] })).toEqual({ items: [] });
  });

  it("refuses an over-length SPARSE array rather than filling its holes", () => {
    // A hole is not a byte. The failure worth preventing is a widened path that
    // treats `undefined` as admissible and hands back a densified array — the
    // snapshot would then carry values the caller never sent.
    // eslint-disable-next-line no-sparse-arrays
    const sparse: unknown[] = new Array(GENERIC_ITEM_LIMIT + 1);
    sparse[0] = 7;
    expect(refusalCodeOf({ bytes: sparse })).toBe(MALFORMED);
  });
});

describe("byte arrays run to the byte ceiling", () => {
  it("admits a byte array past the generic limit, unchanged", () => {
    const bytes = byteArray(GENERIC_ITEM_LIMIT + 1);
    expect(admittedSnapshotOf({ bytes })).toEqual({ bytes });
  });

  it("admits a byte array at exactly the ceiling", () => {
    const admitted = admittedSnapshotOf({ bytes: byteArray(EXPECTED_BYTE_CEILING) });
    expect((admitted as { bytes: unknown[] }).bytes).toHaveLength(EXPECTED_BYTE_CEILING);
  });

  it("refuses a byte array one element past the ceiling", () => {
    // Nothing became unbounded: the widened path is explicit and finite.
    expect(refusalCodeOf({ bytes: byteArray(EXPECTED_BYTE_CEILING + 1) })).toBe(MALFORMED);
  });

  it("refuses an over-ceiling array on its LENGTH ALONE, reading no element", () => {
    // THE GUARD-ORDER PROPERTY, asserted as bounded WORK rather than as elapsed
    // time — a wall-clock threshold would be a flake on a loaded machine.
    //
    // A proxy over a real array keeps `Array.isArray` true while reporting a
    // length past the ceiling. If the ceiling is checked first, the codec reads
    // `length` and refuses; if anything materializes the element list first
    // (even just to build the key array), the element reads show up here. Both
    // orders end in the same refusal, so the refusal alone cannot tell them
    // apart — the read counter is the whole discriminator.
    let elementReads = 0;
    const probe = new Proxy([1, 2, 3], {
      get(target, key, receiver) {
        if (key === "length") return EXPECTED_BYTE_CEILING + 1;
        elementReads += 1;
        // Bound the drilled case too: without this, an inverted guard walks a
        // million proxy traps before the assertion below gets to speak.
        if (elementReads > 8) throw new Error("read an element past the ceiling check");
        return Reflect.get(target, key, receiver);
      },
    });

    expect(refusalCodeOf({ bytes: probe })).toBe(MALFORMED);
    expect(elementReads, "the ceiling must answer before any element is touched").toBe(0);
  });

  it("admits an over-length byte array at the DEEPEST position the depth bound allows", () => {
    // Measured, not guessed: the request object is depth 0, `graphSnapshot` is
    // visited at depth 1, each wrapper adds one, the array itself one more, and
    // its elements one beyond that. Nine wrappers puts the elements at exactly
    // MAX_DEPTH = 12, the last depth `copyValue` admits.
    const nested = wrapped(9, byteArray(GENERIC_ITEM_LIMIT + 1));
    expect(admittedSnapshotOf(nested)).toEqual(nested);
  });

  it("refuses the same array one level deeper, on depth rather than on width", () => {
    // The companion to the arm above: without it, "admits at depth" could be
    // satisfied by a codec with no depth bound at all.
    expect(refusalCodeOf(wrapped(10, byteArray(GENERIC_ITEM_LIMIT + 1)))).toBe(MALFORMED);
  });
});

describe("every element must earn the widened bound", () => {
  it.each([
    ["a value above 255, in the LAST position", 256],
    ["a negative value", -1],
    ["a non-integer", 1.5],
    ["a non-number", "7"],
    ["null", null],
    ["a nested array", [7]],
    ["NEGATIVE ZERO", -0],
  ])("refuses an over-length byte array carrying %s", (_label: string, patch: unknown) => {
    // Each of these sits at the LAST index: a check that sampled, or looked only
    // at the first element, would admit every one of them.
    expect(refusalCodeOf({ bytes: byteArray(GENERIC_ITEM_LIMIT + 1, patch) })).toBe(MALFORMED);
  });

  it("still admits those same values BELOW the generic limit", () => {
    // The widened path is what tightened; the ordinary path is unchanged, and
    // without this the arms above would also pass under a codec that simply
    // refused every array containing a string or a null.
    const mixed = [256, -1, 1.5, "7", null, [7], -0];
    expect(admittedSnapshotOf({ mixed })).toEqual({ mixed });
  });
});
