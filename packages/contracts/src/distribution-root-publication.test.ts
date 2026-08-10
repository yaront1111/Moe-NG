import { describe, expect, it } from "vitest";

import * as contracts from "@moe/contracts";
import {
  DISTRIBUTION_COMPONENT_KINDS,
  DISTRIBUTION_CONTAINER_VERSION,
  DISTRIBUTION_MANIFEST_VERSION,
  DISTRIBUTION_REFUSAL_LAYERS,
  DISTRIBUTION_REFUSAL_REASONS,
  DISTRIBUTION_SIGNATURE_ALGORITHM,
  distributionRefusal,
} from "@moe/contracts";
import type {
  DistributionApiRange,
  DistributionAsset,
  DistributionComponentKind,
  DistributionManifest,
  DistributionManifestResult,
  DistributionRefusal,
  DistributionRefusalLayer,
  DistributionRefusalReason,
  DistributionSkillEntry,
  DistributionSource,
  DistributionTemplateEntry,
} from "@moe/contracts";
// IDENTITY CONTROL ONLY, never the subject of an assertion. Everything under test is
// imported above from the bare specifier; this relative handle exists so the test can
// prove the published tuples ARE the defining module's objects rather than lookalikes.
import * as source from "./distribution/distribution-contract.js";

/**
 * Every import under test uses the BARE specifier `@moe/contracts`, never a relative
 * path into ./distribution/. A relative import already worked before this task and would
 * certify nothing; only the bare specifier travels through the package `exports` map
 * (`{ ".": "./src/index.ts" }`), which is the route a consuming workspace package gets.
 */

/** Hand-written, NOT derived from the barrel: a derived list cannot police its own source. */
const PUBLISHED_VALUE_EXPORTS = [
  "DISTRIBUTION_COMPONENT_KINDS",
  "DISTRIBUTION_CONTAINER_VERSION",
  "DISTRIBUTION_MANIFEST_VERSION",
  "DISTRIBUTION_REFUSAL_LAYERS",
  "DISTRIBUTION_REFUSAL_REASONS",
  "DISTRIBUTION_SIGNATURE_ALGORITHM",
  "distributionRefusal",
] as const;

/** Pre-existing root exports, one per source module, to catch a block that breaks a neighbour. */
const PRE_EXISTING_SAMPLE = [
  "PHASE0_EVIDENCE_MANIFEST_VERSION",
  "PHASE0_FREEZE_VERDICT",
  "decodeBoundedJsonBytes",
  "BOUNDED_JSON_ERROR_CODES",
  "MAX_JSON_DEPTH",
  "createRuntimeError",
  "decodeRuntimeCommandEnvelopeBytes",
  "DOCUMENT_WORK_PROPOSAL_LAYERS",
  "decodeDocumentWorkProposalBytes",
] as const;

describe("distribution vocabulary published from the @moe/contracts root", () => {
  it("resolves every published value through the exports map", () => {
    expect(PUBLISHED_VALUE_EXPORTS).toHaveLength(7);

    for (const name of PUBLISHED_VALUE_EXPORTS) {
      expect(contracts[name], `${name} is not reachable from "@moe/contracts"`).toBeDefined();
    }
  });

  it("publishes the pinned version vocabulary by value, not merely by name", () => {
    expect(DISTRIBUTION_MANIFEST_VERSION).toBe("moe-distribution-manifest/1");
    expect(DISTRIBUTION_CONTAINER_VERSION).toBe("moe-distribution-container/1");
    expect(DISTRIBUTION_SIGNATURE_ALGORITHM).toBe("ed25519");
  });

  it("publishes distributionRefusal as a callable that fails closed with code and layer", () => {
    expect(typeof distributionRefusal).toBe("function");

    const refusal: DistributionRefusal = distributionRefusal(
      "API_RANGE_MISMATCH",
      "DISTRIBUTION_STARTUP",
    );

    expect(refusal.ok).toBe(false);
    expect(refusal.code).toBe("DISTRIBUTION_MISMATCH");
    expect(refusal.reason).toBe("API_RANGE_MISMATCH");
    expect(refusal.refusedBy).toBe("DISTRIBUTION_STARTUP");
    expect(Object.isFrozen(refusal)).toBe(true);
  });

  it("publishes the closed vocabularies as the source module's own frozen tuples", () => {
    const tuples = [
      ["DISTRIBUTION_COMPONENT_KINDS", DISTRIBUTION_COMPONENT_KINDS, source.DISTRIBUTION_COMPONENT_KINDS],
      ["DISTRIBUTION_REFUSAL_LAYERS", DISTRIBUTION_REFUSAL_LAYERS, source.DISTRIBUTION_REFUSAL_LAYERS],
      ["DISTRIBUTION_REFUSAL_REASONS", DISTRIBUTION_REFUSAL_REASONS, source.DISTRIBUTION_REFUSAL_REASONS],
    ] as const;

    expect(tuples).toHaveLength(3);

    for (const [name, published, defined] of tuples) {
      expect(Array.isArray(published), `${name} must publish an array`).toBe(true);
      expect(published.length, `${name} published an empty vocabulary`).toBeGreaterThan(0);
      expect(Object.isFrozen(published), `${name} arrived unfrozen`).toBe(true);
      expect(published, `${name} is a copy, not the defining module's export`).toBe(defined);
    }

    // Arity is NOT pinned here on purpose: distribution-manifest.test.ts owns the vocabulary
    // and deliberately asserts only `length > 0` for the reasons. A stricter mirror would
    // redden this publication test every time that vocabulary legitimately grows.
  });

  it("publishes members of the closed vocabularies, not lookalike strings", () => {
    expect(DISTRIBUTION_COMPONENT_KINDS).toContain("IDE_ADAPTER");
    expect(DISTRIBUTION_COMPONENT_KINDS).toContain("DAEMON");
    expect(DISTRIBUTION_COMPONENT_KINDS).toContain("CONTROL_ROOM");
    expect(DISTRIBUTION_REFUSAL_LAYERS).toContain("DISTRIBUTION_STARTUP");
    expect(DISTRIBUTION_REFUSAL_REASONS).toContain("API_RANGE_MISMATCH");
    expect(DISTRIBUTION_REFUSAL_REASONS).toContain("MANIFEST_VERSION_UNSUPPORTED");
  });

  it("keeps the pre-existing root exports reachable from the same specifier", () => {
    expect(PRE_EXISTING_SAMPLE).toHaveLength(9);

    for (const name of PRE_EXISTING_SAMPLE) {
      expect(contracts[name], `${name} stopped resolving after the block was added`).toBeDefined();
    }
  });
});

/**
 * TYPE PUBLICATION. Type-only exports are erased at runtime, so no assertion above can see
 * them. Each published type is used in an annotation here, which makes
 * `pnpm --filter @moe/contracts typecheck` the assertion: drop any one of the eleven from
 * the barrel and tsc fails on the annotation that names it.
 */
describe("distribution types published from the @moe/contracts root", () => {
  it("annotates a manifest and a result with the published types", () => {
    const apiCompatibilityRange: DistributionApiRange = {
      commandEnvelopeVersion: "moe-runtime-command/1",
      errorRegistryVersion: "moe-runtime-errors/1",
      queryEnvelopeVersion: "moe-runtime-query/1",
    };
    const asset: DistributionAsset = { byteLength: 1, path: "bin/moe", sha256: "a".repeat(64) };
    const skill: DistributionSkillEntry = { digest: "b".repeat(64), skillId: "moe", version: "1" };
    const template: DistributionTemplateEntry = {
      digest: "c".repeat(64),
      templateId: "worker",
      version: "1",
    };
    const source: DistributionSource = { objectFormat: "sha256", sourceSha: "d".repeat(64) };
    const componentKind: DistributionComponentKind = "IDE_ADAPTER";

    const manifest: DistributionManifest = {
      aggregateDigest: "e".repeat(64),
      apiCompatibilityRange,
      assets: [asset],
      buildToolVersions: { pnpm: "10" },
      builtInSkills: [skill],
      componentId: "jetbrains",
      componentKind,
      contractSchemaHash: "f".repeat(64),
      instructionTemplates: [template],
      manifestVersion: DISTRIBUTION_MANIFEST_VERSION,
      signatureAlgorithm: DISTRIBUTION_SIGNATURE_ALGORITHM,
      signingKeyId: "key-1",
      source,
    };

    const accepted: DistributionManifestResult = { manifest, ok: true };
    const refused: DistributionManifestResult = distributionRefusal(
      "COMPONENT_KIND_MISMATCH",
      "DISTRIBUTION_PACKAGER",
    );

    expect(accepted.ok).toBe(true);
    expect(refused.ok).toBe(false);
    if (refused.ok) {
      throw new Error("unreachable: a refusal narrows to ok:false");
    }
    expect(refused.reason).toBe("COMPONENT_KIND_MISMATCH");
    expect(refused.refusedBy).toBe("DISTRIBUTION_PACKAGER");
  });

  it("narrows the refusal union to its published member types", () => {
    const reason: DistributionRefusalReason = "SIGNATURE_INVALID";
    const layer: DistributionRefusalLayer = "DISTRIBUTION_PACKAGER";

    expect(DISTRIBUTION_REFUSAL_REASONS).toContain(reason);
    expect(DISTRIBUTION_REFUSAL_LAYERS).toContain(layer);
  });
});
