import {
  RUNTIME_COMMAND_ENVELOPE_VERSION,
  RUNTIME_ERROR_REGISTRY_VERSION,
  RUNTIME_QUERY_ENVELOPE_VERSION,
} from "@moe/contracts";
import { describe, expect, it } from "vitest";

import {
  MAX_V2_MUTATION_COMMAND_KINDS,
  V2_MUTATION_COMMAND_KINDS,
  V2_SURFACE_MANIFEST,
  V2_SURFACE_MANIFEST_SHA256,
  decodeV2SurfaceManifest,
  encodeV2SurfaceManifest,
} from "./v2-surface-manifest.js";

const EXPECTED_MUTATIONS = Object.freeze([
  "planning.submit_decomposition",
  "product_contract.answer_clarification",
  "product_contract.approve_gate_1",
  "product_contract.ask_clarification",
  "product_contract.propose_revision",
] as const);

const bytes = (value: unknown): Uint8Array =>
  new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));

const rawSurface = (mutationCommandKinds: readonly unknown[]): Record<string, unknown> => ({
  commandEnvelopeVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
  errorRegistryVersion: RUNTIME_ERROR_REGISTRY_VERSION,
  mutationCommandKinds,
  queryEnvelopeVersion: RUNTIME_QUERY_ENVELOPE_VERSION,
  schemaVersion: "moe-v2-surface-manifest/1",
});

describe("v2 surface manifest", () => {
  it("pins the exact nonempty v2 mutation roster instead of the global runtime vocabulary", () => {
    expect(V2_MUTATION_COMMAND_KINDS).toEqual(EXPECTED_MUTATIONS);
    expect(V2_MUTATION_COMMAND_KINDS).toHaveLength(5);
    expect(Object.isFrozen(V2_MUTATION_COMMAND_KINDS)).toBe(true);
    expect(V2_MUTATION_COMMAND_KINDS).not.toContain("goal.create");
    expect(V2_MUTATION_COMMAND_KINDS).not.toContain("cutover.activate");
  });

  it("publishes one frozen manifest over the runtime envelope pins", () => {
    expect(V2_SURFACE_MANIFEST).toEqual({
      commandEnvelopeVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      errorRegistryVersion: RUNTIME_ERROR_REGISTRY_VERSION,
      mutationCommandKinds: EXPECTED_MUTATIONS,
      queryEnvelopeVersion: RUNTIME_QUERY_ENVELOPE_VERSION,
      schemaVersion: "moe-v2-surface-manifest/1",
    });
    expect(Object.isFrozen(V2_SURFACE_MANIFEST)).toBe(true);
    expect(Object.isFrozen(V2_SURFACE_MANIFEST.mutationCommandKinds)).toBe(true);
    expect(V2_SURFACE_MANIFEST_SHA256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("round-trips only its canonical bytes", () => {
    const encoded = encodeV2SurfaceManifest(V2_SURFACE_MANIFEST);
    const decoded = decodeV2SurfaceManifest(encoded);

    expect(new TextDecoder().decode(encoded)).toBe(JSON.stringify(rawSurface(EXPECTED_MUTATIONS)));
    expect(decoded).toEqual({ manifest: V2_SURFACE_MANIFEST, ok: true });
    if (!decoded.ok) return;
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.manifest)).toBe(true);
    expect(Object.isFrozen(decoded.manifest.mutationCommandKinds)).toBe(true);

    const noncanonical = decodeV2SurfaceManifest(bytes(JSON.stringify(rawSurface(EXPECTED_MUTATIONS), null, 2)));
    expect(noncanonical).toEqual({
      code: "V2_SURFACE_MANIFEST_NONCANONICAL",
      layer: "DAEMON_V2_SURFACE_MANIFEST",
      ok: false,
    });
  });

  const hostileRosters: readonly (readonly [string, readonly unknown[]])[] = Object.freeze([
    ["empty", []],
    ["duplicate", [...EXPECTED_MUTATIONS, EXPECTED_MUTATIONS[0]]],
    ["unknown", [...EXPECTED_MUTATIONS.slice(0, -1), "product_contract.teleport"]],
    ["oversized", Array.from({ length: MAX_V2_MUTATION_COMMAND_KINDS + 1 }, (_, index) => `x.${index}`)],
    ["mismatched known runtime command", [...EXPECTED_MUTATIONS.slice(0, -1), "goal.create"]],
  ]);

  it("generates five distinct hostile-roster controls", () => {
    expect(hostileRosters).toHaveLength(5);
    expect(new Set(hostileRosters.map(([label]) => label)).size).toBe(5);
  });

  it.each(hostileRosters)("refuses the %s roster at the surface layer", (_label, roster) => {
    expect(decodeV2SurfaceManifest(bytes(rawSurface(roster)))).toEqual({
      code: "V2_SURFACE_MANIFEST_ROSTER_INVALID",
      layer: "DAEMON_V2_SURFACE_MANIFEST",
      ok: false,
    });
  });

  it("refuses missing, extra and malformed surface fields without repairing them", () => {
    const missing = rawSurface(EXPECTED_MUTATIONS);
    delete missing["queryEnvelopeVersion"];
    const extra = { ...rawSurface(EXPECTED_MUTATIONS), legacy: true };
    const malformed = { ...rawSurface(EXPECTED_MUTATIONS), commandEnvelopeVersion: 7 };

    for (const candidate of [missing, extra, malformed]) {
      expect(decodeV2SurfaceManifest(bytes(candidate))).toEqual({
        code: "V2_SURFACE_MANIFEST_INVALID",
        layer: "DAEMON_V2_SURFACE_MANIFEST",
        ok: false,
      });
    }
  });
});
