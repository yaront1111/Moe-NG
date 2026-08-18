/**
 * The sealed Foundation context manifest record: its roster, its admission
 * rules, and the property that its outer digest binds every outer field.
 *
 * WHY AN OUTER ENVELOPE EXISTS AT ALL. `digestContextManifest` binds exactly the
 * seven fields of `ContextDigestBinding` — optionalSelection, journalCountLimit,
 * journalTextLimit, ordering, rendererVersion, exclusions, exactBytes. It does
 * NOT bind projectId, sessionId, nodeKey, attemptRef, graphRevisionRef,
 * graphContentHash, graphEpoch, configurationDigest or inputManifestDigest. So
 * the inner digest can be identical for two records describing different
 * projects at different epochs, and reusing it as the record's identity would
 * let those two collide. The outer `recordDigest` is what makes the authority
 * fields part of the identity, and the per-field sweep below is what proves it.
 *
 * THE ROSTER IS TRANSCRIBED BY HAND, not derived from the production constants.
 * A roster built by mapping over the exported list grows on both sides at once
 * and stays green while a code is silently added or renamed.
 */

import {
  CONTEXT_MANIFEST_VERSION,
  DEFAULT_CONTEXT_BYTE_BUDGET,
  MAX_JOURNAL_ENTRY_COUNT,
  MAX_JOURNAL_TEXT_CHARACTERS,
  renderContext,
  selectContext,
} from "@moe/context";
import type {
  AdmittedContextSelection,
  ContextRenderManifest,
  ContextSelectionInput,
  MandatoryContextItem,
  OptionalContextItem,
} from "@moe/context";
import { describe, expect, it } from "vitest";

import {
  FOUNDATION_CONTEXT_CODEC,
  FOUNDATION_CONTEXT_MANIFEST_CODES,
  FOUNDATION_CONTEXT_RECORD_KEYS,
  FOUNDATION_CONTEXT_RECORD_VERSION,
  decodeFoundationContextManifestRecord,
  deriveFoundationContextRecordDigest,
  encodeFoundationContextManifestRecord,
} from "./foundation-context-manifest-codec.js";
import type {
  FoundationContextEncodeResult,
  FoundationContextManifestCode,
} from "./foundation-context-manifest-codec.js";

// --- hand-transcribed roster -------------------------------------------------

/** Written out by hand. Do not replace with a map over the production list. */
const EXPECTED_CODES = [
  "FOUNDATION_CONTEXT_MALFORMED",
  "FOUNDATION_CONTEXT_MANIFEST_DIGEST_MISMATCH",
  "FOUNDATION_CONTEXT_NONCANONICAL",
  "FOUNDATION_CONTEXT_RECORD_DIGEST_MISMATCH",
  "FOUNDATION_CONTEXT_VERSION_UNSUPPORTED",
] as const;

/** The exact outer key set, likewise transcribed. */
const EXPECTED_KEYS = [
  "attemptRef",
  "configurationDigest",
  "graphContentHash",
  "graphEpoch",
  "graphRevisionRef",
  "inputManifestDigest",
  "manifest",
  "nodeKey",
  "projectId",
  "recordDigest",
  "sessionId",
] as const;

/** Transcribed too, so the constant and the expectation check each other. */
const EXPECTED_CONTEXT_MANIFEST_VERSION = "context-manifest.v1";

// --- a real render manifest, produced by the real production chain -----------

function mandatory(id: string, content: string): MandatoryContextItem {
  return { id, section: "brief", content, kind: "MANDATORY" };
}

function optional(id: string, content: string, priority: number): OptionalContextItem {
  return { id, section: "notes", content, kind: "OPTIONAL", priority };
}

export function admittedSelection(): AdmittedContextSelection {
  const input: ContextSelectionInput = {
    mandatory: [mandatory("m-1", "the task"), mandatory("m-2", "the rails")],
    optional: [optional("o-1", "a prior finding", 5), optional("o-2", "a weaker note", 1)],
    exclusions: [{ itemId: "x-1", reason: "superseded" }],
    byteBudget: 4_096,
  };
  const selected = selectContext(input);
  if (selected.kind !== "ADMITTED") {
    throw new Error(`fixture selection refused: ${selected.code}`);
  }
  return selected.selection;
}

/** A genuine `renderContext` output — never hand-forged. */
export function realManifest(): ContextRenderManifest {
  return renderContext(admittedSelection()).manifest;
}

/** A SECOND genuine render over different content, for digest-variation arms. */
export function otherManifest(): ContextRenderManifest {
  const selected = selectContext({
    mandatory: [mandatory("m-1", "a DIFFERENT task")],
    optional: [], exclusions: [], byteBudget: 4_096,
  });
  if (selected.kind !== "ADMITTED") {
    throw new Error(`fixture selection refused: ${selected.code}`);
  }
  return renderContext(selected.selection).manifest;
}

// --- record fixtures ---------------------------------------------------------

/** The ten outer fields, before the digest that binds them is derived. */
export function outerFields(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    attemptRef: "attempt-0000000000000001",
    configurationDigest: "c".repeat(64),
    graphContentHash: "a".repeat(64),
    graphEpoch: 3,
    graphRevisionRef: "graph-revision-1",
    inputManifestDigest: "d".repeat(64),
    manifest: realManifest(),
    nodeKey: "dev-c",
    projectId: "proj-foundation-0001",
    sessionId: "session-0000000000000001",
    ...patch,
  };
}

/**
 * A well-formed record. The digest is produced by the PRODUCTION deriver, not by
 * a reimplementation — otherwise every acceptance here would be asserting that
 * two copies of the same arithmetic agree. What the suite actually proves about
 * the digest lives in the per-field sweep, which compares derived digests ACROSS
 * different inputs and is not circular.
 */
export function validRecord(patch: Record<string, unknown> = {}): Record<string, unknown> {
  const fields = outerFields(patch);
  return { ...fields, recordDigest: deriveFoundationContextRecordDigest(fields) };
}

/** Structural clone of a real manifest, so frozen fixtures can be varied. */
export function manifestWith(patch: {
  readonly version?: unknown;
  readonly digest?: unknown;
  readonly binding?: Record<string, unknown>;
}): unknown {
  const real = realManifest();
  return {
    version: "version" in patch ? patch.version : real.version,
    digest: "digest" in patch ? patch.digest : real.digest,
    binding: { ...real.binding, ...(patch.binding ?? {}) },
  };
}

function refusalOf(result: FoundationContextEncodeResult): { code: string; layer: string } {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a refusal, got an encoded record");
  // No authority may ride along on a refusal.
  expect(result).not.toHaveProperty("record");
  expect(result).not.toHaveProperty("bytes");
  return { code: result.code, layer: result.layer };
}

// --- tests -------------------------------------------------------------------

describe("foundation context manifest codec roster", () => {
  it("declares exactly the five distinct decoder codes", () => {
    expect([...FOUNDATION_CONTEXT_MANIFEST_CODES].sort()).toEqual([...EXPECTED_CODES]);
    expect(FOUNDATION_CONTEXT_MANIFEST_CODES).toHaveLength(5);
    expect(new Set(FOUNDATION_CONTEXT_MANIFEST_CODES).size).toBe(5);
    expect(Object.isFrozen(FOUNDATION_CONTEXT_MANIFEST_CODES)).toBe(true);
  });

  it("names one frozen layer", () => {
    expect(FOUNDATION_CONTEXT_CODEC).toBe("FOUNDATION_CONTEXT_CODEC");
  });

  it("declares exactly the eleven outer record keys", () => {
    expect([...FOUNDATION_CONTEXT_RECORD_KEYS].sort()).toEqual([...EXPECTED_KEYS]);
    expect(FOUNDATION_CONTEXT_RECORD_KEYS).toHaveLength(11);
    expect(new Set(FOUNDATION_CONTEXT_RECORD_KEYS).size).toBe(11);
    expect(Object.isFrozen(FOUNDATION_CONTEXT_RECORD_KEYS)).toBe(true);
  });

  it("pins its own record version separately from the context manifest version", () => {
    expect(FOUNDATION_CONTEXT_RECORD_VERSION).toBe("foundation-context-manifest.v1");
    // The two versions are independent: this record can rev without @moe/context
    // revving, and conflating them would hide exactly that.
    expect(FOUNDATION_CONTEXT_RECORD_VERSION).not.toBe(CONTEXT_MANIFEST_VERSION);
  });

  it("agrees with @moe/context on the manifest version literal", () => {
    // Checked against each other rather than one copied from the other.
    expect(EXPECTED_CONTEXT_MANIFEST_VERSION).toBe(CONTEXT_MANIFEST_VERSION);
  });

  it("produces a real render manifest carrying that version and nonempty bytes", () => {
    const manifest = realManifest();
    expect(manifest.version).toBe(CONTEXT_MANIFEST_VERSION);
    expect(manifest.binding.exactBytes.length).toBeGreaterThan(0);
    expect(typeof manifest.digest).toBe("string");
  });
});

describe("foundation context manifest encoder admission", () => {
  it("accepts a record built from a real renderContext manifest", () => {
    const result = encodeFoundationContextManifestRecord(validRecord());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`unexpected refusal ${result.code}`);
    expect(result.bytes.byteLength).toBeGreaterThan(0);
  });

  it("refuses a manifest version it does not support, distinctly from malformed", () => {
    const refusal = refusalOf(encodeFoundationContextManifestRecord(
      validRecord({ manifest: manifestWith({ version: "context-manifest.v2" }) }),
    ));
    expect(refusal.code).toBe("FOUNDATION_CONTEXT_VERSION_UNSUPPORTED");
    expect(refusal.layer).toBe(FOUNDATION_CONTEXT_CODEC);
    // A knowingly-declined real shape and a shape that is not what it claims
    // lead to opposite operator actions, so these two must never merge.
    expect(refusal.code).not.toBe("FOUNDATION_CONTEXT_MALFORMED");
  });

  it.each([
    ["above the byte range", 256],
    ["below the byte range", -1],
    ["not an integer", 12.5],
    ["not a number", "7"],
  ])("refuses an exactBytes entry %s", (_name, bad) => {
    const refusal = refusalOf(encodeFoundationContextManifestRecord(
      validRecord({ manifest: manifestWith({ binding: { exactBytes: [1, bad, 3] } }) }),
    ));
    expect(refusal.code).toBe("FOUNDATION_CONTEXT_MALFORMED");
    expect(refusal.layer).toBe(FOUNDATION_CONTEXT_CODEC);
  });

  it("refuses a NEGATIVE ZERO exactBytes entry that a canonical round-trip would hide", () => {
    // JSON.stringify(-0) is "0", so the bytes and every digest over them are
    // identical to the +0 case. Only Object.is can see this.
    expect(JSON.stringify(-0)).toBe("0");
    expect(-0 === 0).toBe(true);
    expect(Object.is(-0, 0)).toBe(false);

    const refusal = refusalOf(encodeFoundationContextManifestRecord(
      validRecord({ manifest: manifestWith({ binding: { exactBytes: [1, -0, 3] } }) }),
    ));
    expect(refusal.code).toBe("FOUNDATION_CONTEXT_MALFORMED");
    expect(refusal.layer).toBe(FOUNDATION_CONTEXT_CODEC);
  });

  it("refuses a NEGATIVE ZERO graphEpoch for the same reason", () => {
    const refusal = refusalOf(encodeFoundationContextManifestRecord(
      validRecord({ graphEpoch: -0 }),
    ));
    expect(refusal.code).toBe("FOUNDATION_CONTEXT_MALFORMED");
    expect(refusal.layer).toBe(FOUNDATION_CONTEXT_CODEC);
  });

  it("accepts a POSITIVE zero graphEpoch, so the drill above is not just rejecting zero", () => {
    const result = encodeFoundationContextManifestRecord(validRecord({ graphEpoch: 0 }));
    expect(result.ok).toBe(true);
  });

  it("refuses empty exactBytes, which a real render manifest never carries", () => {
    const refusal = refusalOf(encodeFoundationContextManifestRecord(
      validRecord({ manifest: manifestWith({ binding: { exactBytes: [] } }) }),
    ));
    expect(refusal.code).toBe("FOUNDATION_CONTEXT_MALFORMED");
    expect(refusal.layer).toBe(FOUNDATION_CONTEXT_CODEC);
  });

  it("refuses a manifest digest that is not a fresh digestContextManifest(binding)", () => {
    const refusal = refusalOf(encodeFoundationContextManifestRecord(
      validRecord({ manifest: manifestWith({ digest: "e".repeat(64) }) }),
    ));
    expect(refusal.code).toBe("FOUNDATION_CONTEXT_MANIFEST_DIGEST_MISMATCH");
    expect(refusal.layer).toBe(FOUNDATION_CONTEXT_CODEC);
  });

  it("refuses a caller recordDigest that disagrees with the derived one", () => {
    // Rail 2 forbids accepting a caller digest at all. The encoder DERIVES; this
    // refusal is how "the caller cannot supply authority" is proven rather than
    // merely asserted in a comment.
    const record = { ...validRecord(), recordDigest: "f".repeat(64) };
    const refusal = refusalOf(encodeFoundationContextManifestRecord(record));
    expect(refusal.code).toBe("FOUNDATION_CONTEXT_RECORD_DIGEST_MISMATCH");
    expect(refusal.layer).toBe(FOUNDATION_CONTEXT_CODEC);
  });

  it("returns the DERIVED digest, never the caller's, on the accepted path", () => {
    const fields = outerFields();
    const derived = deriveFoundationContextRecordDigest(fields);
    const result = encodeFoundationContextManifestRecord({ ...fields, recordDigest: derived });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`unexpected refusal ${result.code}`);
    expect(result.record.recordDigest).toBe(derived);
  });
});

describe("foundation context manifest hostile input", () => {
  /**
   * Each case is a named builder rather than a prebuilt value: a revoked proxy
   * cannot survive being stored in an array literal that later gets inspected,
   * and building lazily keeps every case hostile at the moment it is used.
   *
   * THE THIRD ELEMENT IS THE EXACT EXPECTED CODE. Asserting only that the answer
   * is SOME member of this codec's own five-code roster is free: every guard
   * already answers with one of them, so the assertion survives a mutation that
   * swaps one guard's code for another's — exactly the substitution the arm at
   * test:222 forbids for VERSION_UNSUPPORTED. The column is also deliberately
   * NON-CONSTANT: the last three cases expect codes other than MALFORMED, so a
   * change that collapsed every refusal onto a single code reddens here too.
   */
  const HOSTILE_CASES: readonly (
    readonly [string, () => unknown, FoundationContextManifestCode]
  )[] = [
    ["accessor on the outer record", () => {
      const record = validRecord();
      return Object.defineProperty({ ...record }, "projectId", {
        configurable: true, enumerable: true, get: () => "proj-attacker",
      });
    }, "FOUNDATION_CONTEXT_MALFORMED"],
    ["accessor on manifest.binding", () => {
      const real = realManifest();
      const binding = Object.defineProperty({ ...real.binding }, "ordering", {
        configurable: true, enumerable: true, get: () => "ATTACKER_ORDERING",
      });
      return validRecord({ manifest: { version: real.version, digest: real.digest, binding } });
    }, "FOUNDATION_CONTEXT_MALFORMED"],
    ["revoked proxy as the record", () => {
      const revocable = Proxy.revocable({ ...validRecord() }, {});
      revocable.revoke();
      return revocable.proxy;
    }, "FOUNDATION_CONTEXT_MALFORMED"],
    ["revoked proxy as the manifest", () => {
      const revocable = Proxy.revocable({ ...realManifest() }, {});
      revocable.revoke();
      return validRecord({ manifest: revocable.proxy });
    }, "FOUNDATION_CONTEXT_MALFORMED"],
    ["an extra unknown key", () => ({ ...validRecord(), attackerKey: "x" }),
      "FOUNDATION_CONTEXT_MALFORMED"],
    ["a missing key", () => {
      const record = { ...validRecord() };
      delete record["sessionId"];
      return record;
    }, "FOUNDATION_CONTEXT_MALFORMED"],
    ["a null-prototype record", () => Object.assign(Object.create(null), validRecord()),
      "FOUNDATION_CONTEXT_MALFORMED"],
    ["an array instead of a record", () => [validRecord()], "FOUNDATION_CONTEXT_MALFORMED"],
    ["null instead of a record", () => null, "FOUNDATION_CONTEXT_MALFORMED"],
    ["a string instead of a record", () => "not-a-record", "FOUNDATION_CONTEXT_MALFORMED"],
    ["an oversize manifest past the bounded limit", () => validRecord({
      manifest: manifestWith({ binding: { exactBytes: new Array(1_200_000).fill(7) } }),
    }), "FOUNDATION_CONTEXT_MALFORMED"],
    // The three below are structurally well-formed attacks, so they must reach
    // past the shape guards and be answered by their OWN code.
    ["a manifest claiming a version this codec never issued", () => validRecord({
      manifest: manifestWith({ version: "context-manifest.v0" }),
    }), "FOUNDATION_CONTEXT_VERSION_UNSUPPORTED"],
    ["a real binding swapped in under the original digest", () => {
      const real = realManifest();
      return validRecord({
        manifest: { version: real.version, digest: real.digest, binding: otherManifest().binding },
      });
    }, "FOUNDATION_CONTEXT_MANIFEST_DIGEST_MISMATCH"],
    ["an outer identity swapped under its now-stale recordDigest", () => ({
      ...validRecord(), projectId: "proj-attacker",
    }), "FOUNDATION_CONTEXT_RECORD_DIGEST_MISMATCH"],
  ];

  // A sweep that silently produced zero cases would pass while testing nothing.
  it("generates a positive count of hostile cases over a non-constant code column", () => {
    expect(HOSTILE_CASES.length).toBeGreaterThan(0);
    expect(HOSTILE_CASES.length).toBe(14);
    expect(new Set(HOSTILE_CASES.map(([name]) => name)).size).toBe(HOSTILE_CASES.length);

    // Hand-written: the column must not quietly become one repeated code, which
    // is what would make the per-case assertion below free again.
    const expected = HOSTILE_CASES.map(([, , code]) => code);
    expect([...new Set(expected)].sort()).toEqual([
      "FOUNDATION_CONTEXT_MALFORMED",
      "FOUNDATION_CONTEXT_MANIFEST_DIGEST_MISMATCH",
      "FOUNDATION_CONTEXT_RECORD_DIGEST_MISMATCH",
      "FOUNDATION_CONTEXT_VERSION_UNSUPPORTED",
    ]);
    // NONCANONICAL is decoder-only; its arm is the non-canonical-bytes test below.
    for (const code of expected) expect(FOUNDATION_CONTEXT_MANIFEST_CODES).toContain(code);
  });

  it.each(HOSTILE_CASES)("refuses %s with its exact code", (_name, build, expected) => {
    const result = encodeFoundationContextManifestRecord(build());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("a hostile input was admitted");
    expect(result.code).toBe(expected);
    expect(result.layer).toBe(FOUNDATION_CONTEXT_CODEC);
    expect(result).not.toHaveProperty("record");
  });

  it("refuses truncated bytes at the decoder with its own code", () => {
    const encoded = encodeFoundationContextManifestRecord(validRecord());
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) throw new Error(`fixture failed to encode: ${encoded.code}`);

    const truncated = encoded.bytes.slice(0, encoded.bytes.byteLength - 3);
    const result = decodeFoundationContextManifestRecord(truncated);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("truncated bytes decoded");
    expect(result.code).toBe("FOUNDATION_CONTEXT_MALFORMED");
    expect(result.layer).toBe(FOUNDATION_CONTEXT_CODEC);
  });

  it("refuses non-canonical bytes that still parse to the same record", () => {
    const encoded = encodeFoundationContextManifestRecord(validRecord());
    if (!encoded.ok) throw new Error(`fixture failed to encode: ${encoded.code}`);

    // A single leading space: valid JSON, same parsed value, different bytes.
    const loosened = new TextEncoder().encode(
      ` ${new TextDecoder("utf-8", { fatal: true }).decode(encoded.bytes)}`,
    );
    const result = decodeFoundationContextManifestRecord(loosened);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("non-canonical bytes decoded");
    expect(result.code).toBe("FOUNDATION_CONTEXT_NONCANONICAL");
    expect(result.layer).toBe(FOUNDATION_CONTEXT_CODEC);
  });
});

describe("foundation context manifest accepted control", () => {
  it("round-trips a record built from the REAL selectContext + renderContext chain", () => {
    const manifest = realManifest();
    const fields = outerFields({ manifest });
    const encoded = encodeFoundationContextManifestRecord({
      ...fields, recordDigest: deriveFoundationContextRecordDigest(fields),
    });
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) throw new Error(`the real chain was refused: ${encoded.code}`);

    const decoded = decodeFoundationContextManifestRecord(encoded.bytes);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error(`round trip refused: ${decoded.code}`);

    const record = decoded.record;
    expect(record.projectId).toBe("proj-foundation-0001");
    expect(record.sessionId).toBe("session-0000000000000001");
    expect(record.nodeKey).toBe("dev-c");
    expect(record.attemptRef).toBe("attempt-0000000000000001");
    expect(record.graphRevisionRef).toBe("graph-revision-1");
    expect(record.graphContentHash).toBe("a".repeat(64));
    expect(record.graphEpoch).toBe(3);
    expect(record.configurationDigest).toBe("c".repeat(64));
    expect(record.inputManifestDigest).toBe("d".repeat(64));
    expect(record.recordDigest).toBe(encoded.record.recordDigest);

    // The complete public manifest survives, not a summary of it.
    expect(record.manifest.version).toBe(manifest.version);
    expect(record.manifest.digest).toBe(manifest.digest);
    expect(record.manifest.binding.ordering).toBe(manifest.binding.ordering);
    expect(record.manifest.binding.rendererVersion).toBe(manifest.binding.rendererVersion);
    expect(record.manifest.binding.journalCountLimit).toBe(manifest.binding.journalCountLimit);
    expect(record.manifest.binding.journalTextLimit).toBe(manifest.binding.journalTextLimit);
    expect([...record.manifest.binding.exactBytes]).toEqual([...manifest.binding.exactBytes]);
    expect(record.manifest.binding.exclusions).toEqual(manifest.binding.exclusions);
    expect(record.manifest.binding.optionalSelection)
      .toEqual(manifest.binding.optionalSelection);
  });

  it("returns a DEEPLY frozen record", () => {
    const decoded = decodeFoundationContextManifestRecord(
      (encodeFoundationContextManifestRecord(validRecord()) as { bytes: Uint8Array }).bytes,
    );
    if (!decoded.ok) throw new Error(`round trip refused: ${decoded.code}`);
    expect(Object.isFrozen(decoded.record)).toBe(true);
    expect(Object.isFrozen(decoded.record.manifest)).toBe(true);
    expect(Object.isFrozen(decoded.record.manifest.binding)).toBe(true);
    expect(Object.isFrozen(decoded.record.manifest.binding.exactBytes)).toBe(true);
    expect(Object.isFrozen(decoded.record.manifest.binding.exclusions)).toBe(true);
    expect(Object.isFrozen(decoded.record.manifest.binding.optionalSelection)).toBe(true);
  });

  it("re-encodes to byte-identical output, so the record is its own canonical form", () => {
    const first = encodeFoundationContextManifestRecord(validRecord());
    if (!first.ok) throw new Error(`fixture failed: ${first.code}`);
    const decoded = decodeFoundationContextManifestRecord(first.bytes);
    if (!decoded.ok) throw new Error(`round trip refused: ${decoded.code}`);
    const second = encodeFoundationContextManifestRecord(decoded.record);
    if (!second.ok) throw new Error(`re-encode refused: ${second.code}`);
    expect([...second.bytes]).toEqual([...first.bytes]);
  });
});

describe("foundation context record digest binds every outer field", () => {
  /**
   * One variation per non-digest outer field, each moving THAT FIELD ALONE.
   *
   * Per-field is the whole point. A single "the digest changes when the record
   * changes" assertion stays green while nine of the ten fields are unhashed —
   * which is exactly the defect DoD 4's mutation clause names, and exactly what
   * step 7's drill (ii) reproduces by omitting one field from the hashed input.
   */
  const FIELD_VARIATIONS: readonly (readonly [string, unknown])[] = [
    ["projectId", "proj-foundation-0002"],
    ["sessionId", "session-0000000000000002"],
    ["nodeKey", "dev-b"],
    ["attemptRef", "attempt-0000000000000002"],
    ["graphRevisionRef", "graph-revision-2"],
    ["graphContentHash", "b".repeat(64)],
    ["graphEpoch", 4],
    ["configurationDigest", "e".repeat(64)],
    ["inputManifestDigest", "f".repeat(64)],
    ["manifest", null],
  ];

  it("sweeps exactly the ten non-digest outer fields", () => {
    expect(FIELD_VARIATIONS.length).toBeGreaterThan(0);
    expect(FIELD_VARIATIONS.length).toBe(10);
    const swept = FIELD_VARIATIONS.map(([field]) => field).sort();
    // The swept set is exactly the outer keys minus recordDigest, checked
    // against production's own key list so a new field cannot be added without
    // either being swept or failing here.
    const expected = [...FOUNDATION_CONTEXT_RECORD_KEYS]
      .filter((key) => key !== "recordDigest").sort();
    expect(swept).toEqual(expected);
  });

  it.each(FIELD_VARIATIONS)("moves the recordDigest when %s alone changes", (field, value) => {
    const base = outerFields();
    // `manifest` is varied through a genuinely different render, not a null.
    const replacement = field === "manifest" ? otherManifest() : value;
    const varied = { ...base, [field]: replacement };

    expect(varied[field]).not.toEqual(base[field]);
    expect(deriveFoundationContextRecordDigest(varied))
      .not.toBe(deriveFoundationContextRecordDigest(base));
  });

  it("is stable: the same fields derive the same digest twice", () => {
    // Without this, a deriver that returned a random value would pass every
    // "the digest changed" arm above while binding nothing at all.
    expect(deriveFoundationContextRecordDigest(outerFields()))
      .toBe(deriveFoundationContextRecordDigest(outerFields()));
  });

  it("does NOT let an outer identity change the inner manifest digest", () => {
    // Rail 2, executable: the inner digest binds seven render fields and has no
    // opinion about project, session, node, attempt, graph, config or input.
    const base = outerFields();
    const moved = outerFields({ projectId: "proj-foundation-0002", graphEpoch: 9 });
    const baseManifest = base["manifest"] as ContextRenderManifest;
    const movedManifest = moved["manifest"] as ContextRenderManifest;
    expect(movedManifest.digest).toBe(baseManifest.digest);
    // ...while the OUTER digest does move, which is the whole reason it exists.
    expect(deriveFoundationContextRecordDigest(moved))
      .not.toBe(deriveFoundationContextRecordDigest(base));
  });

  it("lets a manifest.binding change move BOTH digests", () => {
    const base = outerFields();
    const other = otherManifest();
    const baseManifest = base["manifest"] as ContextRenderManifest;

    expect(other.digest).not.toBe(baseManifest.digest);
    expect(deriveFoundationContextRecordDigest({ ...base, manifest: other }))
      .not.toBe(deriveFoundationContextRecordDigest(base));
  });
});

// --- realistic context sizes -------------------------------------------------

/**
 * WHY THE CEILING IS SIZED FROM THE DESIGN AND NOT FROM THE DoD FLOOR.
 *
 * `manifest.binding.exactBytes` is the rendered context as a NUMBER ARRAY, one
 * entry per byte, and it passes through `snapshotFoundationValue`, whose generic
 * array bound is 512 items. So the codec refused any context over 512 rendered
 * bytes — measured at 513.
 *
 * The requirement is not 4KiB. `@moe/context` publishes its own limits:
 *   DEFAULT_CONTEXT_BYTE_BUDGET     = 64 * 1024  =  65,536 rendered bytes
 *   MAX_JOURNAL_ENTRY_COUNT         = 8
 *   MAX_JOURNAL_TEXT_CHARACTERS     = 12 * 1024  =  12,288 characters
 * so journal content alone reaches 8 * 12,288 = 98,304 characters BEFORE the
 * mandatory items, the optional selection and the exclusions are added. A cap
 * chosen to clear the DoD's 4KiB floor would still refuse a legitimate context,
 * which is how this defect was filed in the first place.
 *
 * The number the fix uses is therefore the file's OWN byte ceiling,
 * MAX_BYTES = 1_048_576, already enforced on `Uint8Array.byteLength` — so a byte
 * payload is bounded identically whether it arrives as a typed array or as a
 * JSON number array, rather than by two unrelated magic numbers.
 */
const JOURNAL_CHARACTER_CEILING = MAX_JOURNAL_ENTRY_COUNT * MAX_JOURNAL_TEXT_CHARACTERS;

/** A real render of roughly `contentBytes` of ASCII content, through the real chain. */
export function largeManifest(contentBytes: number): ContextRenderManifest {
  const selected = selectContext({
    mandatory: [mandatory("m-1", "x".repeat(contentBytes))],
    optional: [],
    exclusions: [],
    byteBudget: Math.max(contentBytes * 2, DEFAULT_CONTEXT_BYTE_BUDGET),
  });
  if (selected.kind !== "ADMITTED") {
    throw new Error(`large fixture selection refused: ${selected.code}`);
  }
  return renderContext(selected.selection).manifest;
}

/** The record shape the codec seals, carrying a genuinely large rendered context. */
function largeRecord(contentBytes: number): Record<string, unknown> {
  return validRecord({ manifest: largeManifest(contentBytes) });
}

describe("a context of realistic size", () => {
  it("renders more bytes than the design's own journal ceiling would need", () => {
    // The fixture must actually be large, or every arm below proves nothing.
    expect(JOURNAL_CHARACTER_CEILING).toBe(98_304);
    expect(largeManifest(4_096).binding.exactBytes.length).toBeGreaterThan(4_096);
  });

  it.each([
    ["the DoD floor, 4KiB", 4_096],
    ["a realistic full-budget context, 64KiB", DEFAULT_CONTEXT_BYTE_BUDGET],
    ["the design's journal ceiling, 96KiB", JOURNAL_CHARACTER_CEILING],
  ])("seals and re-admits %s with both digests intact", (_label: string, contentBytes: number) => {
    const record = largeRecord(contentBytes);
    const manifest = record["manifest"] as ContextRenderManifest;
    // The fixture is only evidence if it really is that large: a selection that
    // silently dropped content would leave this arm proving the small case twice.
    expect(manifest.binding.exactBytes.length).toBeGreaterThan(contentBytes);

    const encoded = encodeFoundationContextManifestRecord(record);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) throw new Error(`a ${contentBytes}-byte context refused: ${encoded.code}`);

    const decoded = decodeFoundationContextManifestRecord(encoded.bytes);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error(`a ${contentBytes}-byte context failed: ${decoded.code}`);
    // The round trip is only evidence if BOTH digests survive it: the claim is
    // that widening the bound did not perturb canonical bytes at size.
    expect(decoded.record.recordDigest).toBe(record["recordDigest"]);
    expect(decoded.record.manifest.digest).toBe(manifest.digest);
    // And the bytes themselves come back, not a truncation that still digests.
    expect(decoded.record.manifest.binding.exactBytes)
      .toEqual(manifest.binding.exactBytes);
  });
});
