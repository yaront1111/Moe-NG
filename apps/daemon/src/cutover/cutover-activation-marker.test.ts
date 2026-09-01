import { describe, expect, it } from "vitest";

const ACTIVATED_AT = 1_756_000_000_000;
const SOURCE_COMMIT = "0123456789abcdef0123456789abcdef01234567";

const GENERATIONS = Object.freeze({
  backupGenerationDigest: "a".repeat(64),
  distributionManifestSha256: "b".repeat(64),
  importGenerationSha256: "c".repeat(64),
  quiesceRecordSha256: "d".repeat(64),
});

async function markerModule() {
  return import("./cutover-activation-marker.js");
}

describe("cutover activation marker shape", () => {
  it("publishes the exact frozen marker-key roster without exporting its private layer", async () => {
    const marker = await markerModule();

    expect(marker.CUTOVER_ACTIVATION_MARKER_KEYS).toEqual([
      "activatedAtEpochMs", "generations", "schemaVersion", "sourceCommit",
    ]);
    expect(marker.CUTOVER_ACTIVATION_MARKER_KEYS).toHaveLength(4);
    expect(Object.isFrozen(marker.CUTOVER_ACTIVATION_MARKER_KEYS)).toBe(true);
    expect("CUTOVER_ACTIVATION_MARKER_LAYER" in marker).toBe(false);
  });

  it("composes a frozen marker from the admitted binding evidence", async () => {
    const { composeCutoverActivationMarker } = await markerModule();

    const result = composeCutoverActivationMarker({
      activatedAtEpochMs: ACTIVATED_AT,
      generations: GENERATIONS,
      sourceCommit: SOURCE_COMMIT,
      sourceState: "ACTIVATE_APPROVED",
    });

    expect(result).toEqual({
      marker: {
        activatedAtEpochMs: ACTIVATED_AT,
        generations: GENERATIONS,
        schemaVersion: "moe-cutover-activation-marker/1",
        sourceCommit: SOURCE_COMMIT,
      },
      ok: true,
    });
    if (!result.ok) throw new Error(`unexpected refusal ${result.error.code}`);
    expect(Object.keys(result.marker).sort()).toEqual([
      "activatedAtEpochMs", "generations", "schemaVersion", "sourceCommit",
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.marker)).toBe(true);
    expect(Object.isFrozen(result.marker.generations)).toBe(true);
    expect(result.marker.generations).not.toBe(GENERATIONS);
    expect(Object.keys(result.marker.generations).sort()).toEqual([
      "backupGenerationDigest", "distributionManifestSha256", "importGenerationSha256",
      "quiesceRecordSha256",
    ]);
  });
});

describe("cutover activation marker refusals", () => {
  it("publishes the exact nonzero refusal-code roster", async () => {
    const { CUTOVER_ACTIVATION_MARKER_REFUSAL_CODES } = await markerModule();

    expect(CUTOVER_ACTIVATION_MARKER_REFUSAL_CODES).toEqual([
      "INPUT_INVALID", "ILLEGAL_TRANSITION", "CUTOVER_STATE_INVALID",
    ]);
    expect(CUTOVER_ACTIVATION_MARKER_REFUSAL_CODES).toHaveLength(3);
    expect(Object.isFrozen(CUTOVER_ACTIVATION_MARKER_REFUSAL_CODES)).toBe(true);
  });

  it("refuses a source outside ACTIVATE_APPROVED by exact code and layer", async () => {
    const { composeCutoverActivationMarker } = await markerModule();

    const result = composeCutoverActivationMarker({
      activatedAtEpochMs: ACTIVATED_AT,
      generations: GENERATIONS,
      sourceCommit: SOURCE_COMMIT,
      sourceState: "IMPORT_VERIFIED",
    });

    expect(result).toMatchObject({
      error: {
        code: "ILLEGAL_TRANSITION",
        details: {
          aggregateKind: "CUTOVER",
          commandKind: "cutover.activate",
          sourceState: "IMPORT_VERIFIED",
        },
      },
      layer: "CUTOVER_ACTIVATION_MARKER",
      ok: false,
    });
  });

  it("refuses an unreadable source without attaching an invalid lifecycle source", async () => {
    const { composeCutoverActivationMarker } = await markerModule();

    const result = composeCutoverActivationMarker({
      activatedAtEpochMs: ACTIVATED_AT,
      generations: GENERATIONS,
      sourceCommit: SOURCE_COMMIT,
      sourceState: "TELEPORTED" as "ACTIVATE_APPROVED",
    });

    expect(result).toMatchObject({
      error: { code: "INPUT_INVALID" },
      layer: "CUTOVER_ACTIVATION_MARKER",
      ok: false,
    });
  });

  const invalidMoments = Object.freeze([
    ["negative", -1],
    ["fractional", 1.5],
    ["not finite", Number.POSITIVE_INFINITY],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
  ] as const);

  it("generates four distinct invalid-moment cases", () => {
    expect(invalidMoments).toHaveLength(4);
    expect(new Set(invalidMoments.map(([label]) => label)).size).toBe(4);
  });

  it.each(invalidMoments)(
    "refuses a %s activation moment with CUTOVER_STATE_INVALID at the marker layer",
    async (_label, activatedAtEpochMs) => {
      const { composeCutoverActivationMarker } = await markerModule();
      const result = composeCutoverActivationMarker({
        activatedAtEpochMs,
        generations: GENERATIONS,
        sourceCommit: SOURCE_COMMIT,
        sourceState: "ACTIVATE_APPROVED",
      });

      expect(result).toMatchObject({
        error: {
          code: "CUTOVER_STATE_INVALID",
          details: { sourceState: "ACTIVATE_APPROVED" },
        },
        layer: "CUTOVER_ACTIVATION_MARKER",
        ok: false,
      });
    },
  );

  it("never silently degrades a marker refusal to UNKNOWN_ERROR", async () => {
    const { composeCutoverActivationMarker } = await markerModule();
    const refusals = [
      composeCutoverActivationMarker({
        activatedAtEpochMs: ACTIVATED_AT,
        generations: GENERATIONS,
        sourceCommit: SOURCE_COMMIT,
        sourceState: "IMPORT_VERIFIED",
      }),
      composeCutoverActivationMarker({
        activatedAtEpochMs: ACTIVATED_AT,
        generations: GENERATIONS,
        sourceCommit: SOURCE_COMMIT,
        sourceState: "TELEPORTED" as "ACTIVATE_APPROVED",
      }),
      ...invalidMoments.map(([, activatedAtEpochMs]) => composeCutoverActivationMarker({
        activatedAtEpochMs,
        generations: GENERATIONS,
        sourceCommit: SOURCE_COMMIT,
        sourceState: "ACTIVATE_APPROVED" as const,
      })),
    ];

    expect(refusals).toHaveLength(6);
    for (const result of refusals) {
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a marker refusal");
      expect(result.error.code).not.toBe("UNKNOWN_ERROR");
      expect(result.layer).toBe("CUTOVER_ACTIVATION_MARKER");
    }
  });
});

describe("cutover activation marker bytes", () => {
  it("derives its aggregate id from the project alone, distinct from the attempt's", async () => {
    const marker = await markerModule();
    const attempt = await import("./cutover-attempt-contracts.js");

    const first = marker.deriveCutoverActivationMarkerAggregateId("project-1");
    // Server-derived, so the caller cannot nominate where its own marker lands, and DISTINCT
    // from the attempt aggregate: the attempt fold refuses any foreign event type, so a marker
    // written there would make the attempt permanently unreadable.
    expect(marker.deriveCutoverActivationMarkerAggregateId("project-1")).toBe(first);
    expect(marker.deriveCutoverActivationMarkerAggregateId("project-2")).not.toBe(first);
    expect(first).not.toBe(attempt.deriveCutoverAttemptAggregateId("project-1"));
    // Long project ids stay inside the store's identifier bound rather than being truncated.
    expect(marker.deriveCutoverActivationMarkerAggregateId("p".repeat(4096)).length)
      .toBeLessThanOrEqual(512);
  });

  it("round-trips a composed marker through durable bytes, key order fixed", async () => {
    const marker = await markerModule();
    const composed = marker.composeCutoverActivationMarker({
      activatedAtEpochMs: ACTIVATED_AT,
      generations: GENERATIONS,
      sourceCommit: SOURCE_COMMIT,
      sourceState: "ACTIVATE_APPROVED",
    });
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;

    const bytes = marker.encodeCutoverActivationMarker(composed.marker);
    const decoded = marker.decodeCutoverActivationMarker(bytes);

    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.marker).toEqual(composed.marker);
    // Byte-stable: re-encoding the decoded marker reproduces the same bytes, so a replay
    // comparison over durable bytes cannot fail on key order alone.
    expect(marker.encodeCutoverActivationMarker(decoded.marker)).toEqual(bytes);
  });

  it("refuses INPUT_INVALID for every malformed durable record, naming its own layer", async () => {
    const marker = await markerModule();
    const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
    const wellFormed = {
      activatedAtEpochMs: ACTIVATED_AT,
      generations: { ...GENERATIONS },
      schemaVersion: "moe-cutover-activation-marker/1",
      sourceCommit: SOURCE_COMMIT,
    };
    // A single defect per case, so exactly one reason can answer each.
    const cases: readonly (readonly [string, unknown])[] = [
      ["not-json", new TextEncoder().encode("{")],
      ["extra key", encode({ ...wellFormed, extra: 1 })],
      ["missing key", encode({ ...wellFormed, sourceCommit: undefined })],
      ["wrong schema version", encode({ ...wellFormed, schemaVersion: "moe-marker/2" })],
      ["negative moment", encode({ ...wellFormed, activatedAtEpochMs: -1 })],
      ["fractional moment", encode({ ...wellFormed, activatedAtEpochMs: 1.5 })],
      ["generation not a string", encode({
        ...wellFormed, generations: { ...GENERATIONS, importGenerationSha256: 7 },
      })],
      ["extra generation", encode({
        ...wellFormed, generations: { ...GENERATIONS, spare: "e".repeat(64) },
      })],
    ];

    expect(cases).toHaveLength(8);
    for (const [label, bytes] of cases) {
      const decoded = marker.decodeCutoverActivationMarker(bytes);
      expect(decoded.ok, label).toBe(false);
      if (decoded.ok) throw new Error(`expected ${label} to refuse`);
      expect(decoded.error.code, label).toBe("INPUT_INVALID");
      // The silent-degradation guard: a code the registry does not admit for this source would
      // still refuse, and every "it refused" assertion above would stay green.
      expect(decoded.error.code, label).not.toBe("UNKNOWN_ERROR");
      expect(decoded.layer, label).toBe("CUTOVER_ACTIVATION_MARKER");
    }
  });
});
