import { describe, expect, it } from "vitest";

import { ARTIFACT_ADDRESS_PATTERN, type ArtifactRef } from "../artifacts/artifact-contract.js";
import {
  MAX_EVIDENCE_ARGV_ENTRIES,
  MAX_EVIDENCE_DECLARED_ENTRIES,
  VERIFICATION_RECIPE_VERSION,
  type BuildVerificationRecipeInput,
  type DeclaredInput,
  type VerificationRecipe,
} from "./evidence-contract.js";
import { buildVerificationRecipe } from "./verification-recipe.js";

const digestOf = (marker: string): string => marker.repeat(64).slice(0, 64);
const DIGEST_A = digestOf("a");
const DIGEST_B = digestOf("b");
const SCHEMA_DIGEST = digestOf("c");

const refFor = (sha256: string, byteLength = 3): ArtifactRef => ({ sha256, byteLength });

function recipeInput(
  overrides: Partial<BuildVerificationRecipeInput> = {},
): BuildVerificationRecipeInput {
  return {
    argv: ["node", "verify.mjs", "--strict"],
    declaredInputs: [{ path: "src/a.ts", ref: refFor(DIGEST_A) }],
    declaredOutputPaths: ["out/report.json"],
    verifierIdentity: {
      verifierId: "moe-verifier",
      verifierVersion: "1.0.0",
      capabilitySchemaDigest: SCHEMA_DIGEST,
    },
    ...overrides,
  };
}

function buildOrThrow(overrides: Partial<BuildVerificationRecipeInput> = {}): VerificationRecipe {
  const result = buildVerificationRecipe(recipeInput(overrides));
  if (!result.ok) {
    throw new Error(`recipe fixture refused: ${result.code} ${result.message}`);
  }
  return result.recipe;
}

describe("buildVerificationRecipe", () => {
  it("binds argv, the declared closure, outputs, and the verifier under the pinned version", () => {
    const recipe = buildOrThrow();

    expect(recipe.recipeVersion).toBe(VERIFICATION_RECIPE_VERSION);
    expect(recipe.argv).toEqual(["node", "verify.mjs", "--strict"]);
    expect(recipe.declaredInputs).toEqual([{ path: "src/a.ts", ref: refFor(DIGEST_A) }]);
    expect(recipe.declaredOutputPaths).toEqual(["out/report.json"]);
    expect(recipe.verifierIdentity.verifierId).toBe("moe-verifier");
    expect(ARTIFACT_ADDRESS_PATTERN.test(recipe.sha256)).toBe(true);
  });

  it("is immutable, so a caller holding a reference cannot mutate what the digest attested", () => {
    const recipe = buildOrThrow();

    expect(Object.isFrozen(recipe)).toBe(true);
    expect(() => {
      (recipe.argv as string[]).push("--extra");
    }).toThrow(TypeError);
    expect(() => {
      (recipe.declaredInputs[0] as { path: string }).path = "src/b.ts";
    }).toThrow(TypeError);
  });

  it("digests the same content identically when the caller supplies it in a different key order", () => {
    const ordered = buildOrThrow();
    const shuffled = buildVerificationRecipe({
      verifierIdentity: {
        capabilitySchemaDigest: SCHEMA_DIGEST,
        verifierVersion: "1.0.0",
        verifierId: "moe-verifier",
      },
      declaredOutputPaths: ["out/report.json"],
      declaredInputs: [{ ref: refFor(DIGEST_A), path: "src/a.ts" }],
      argv: ["node", "verify.mjs", "--strict"],
    });

    expect(shuffled.ok).toBe(true);
    expect(shuffled.ok && shuffled.recipe.sha256).toBe(ordered.sha256);
  });

  it("digests the same closure identically when the declared inputs arrive in a different order", () => {
    const forward = buildOrThrow({
      declaredInputs: [
        { path: "src/a.ts", ref: refFor(DIGEST_A) },
        { path: "src/b.ts", ref: refFor(DIGEST_B) },
      ],
    });
    const reversed = buildOrThrow({
      declaredInputs: [
        { path: "src/b.ts", ref: refFor(DIGEST_B) },
        { path: "src/a.ts", ref: refFor(DIGEST_A) },
      ],
    });

    expect(reversed.sha256).toBe(forward.sha256);
    expect(reversed.declaredInputs.map((entry) => entry.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("digests differently when argv order changes, because argv order is the command", () => {
    const forward = buildOrThrow({ argv: ["node", "verify.mjs", "--strict"] });
    const swapped = buildOrThrow({ argv: ["node", "--strict", "verify.mjs"] });

    expect(swapped.sha256).not.toBe(forward.sha256);
  });

  // A naive same-in/same-out digest test passes against a hash with no field
  // framing at all. These pairs hold total content constant and move a single
  // character across a field boundary, which is the only shape that can see it.
  it("digests differently when a character shifts between two adjacent argv entries", () => {
    const left = buildOrThrow({ argv: ["ab", "cd"] });
    const right = buildOrThrow({ argv: ["a", "bcd"] });

    expect(right.sha256).not.toBe(left.sha256);
  });

  it("digests differently when a character shifts between two adjacent verifier fields", () => {
    const left = buildOrThrow({
      verifierIdentity: {
        verifierId: "ab",
        verifierVersion: "cd",
        capabilitySchemaDigest: SCHEMA_DIGEST,
      },
    });
    const right = buildOrThrow({
      verifierIdentity: {
        verifierId: "a",
        verifierVersion: "bcd",
        capabilitySchemaDigest: SCHEMA_DIGEST,
      },
    });

    expect(right.sha256).not.toBe(left.sha256);
  });

  it("refuses a malformed argv entry with RUNNER_EVIDENCE_ARGV_INVALID", () => {
    const result = buildVerificationRecipe(
      recipeInput({ argv: ["node", 7 as unknown as string] }),
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("RUNNER_EVIDENCE_ARGV_INVALID");
    expect(result.ok === false && result.layer).toBe("RECIPE_SHAPE");
  });

  it("refuses an empty argv with RUNNER_EVIDENCE_ARGV_INVALID", () => {
    const result = buildVerificationRecipe(recipeInput({ argv: [] }));

    expect(result.ok === false && result.code).toBe("RUNNER_EVIDENCE_ARGV_INVALID");
  });

  it("refuses an over-limit argv with RUNNER_EVIDENCE_ARGV_LIMIT", () => {
    const argv = Array.from({ length: MAX_EVIDENCE_ARGV_ENTRIES + 1 }, (_, index) => `arg-${index}`);
    expect(argv.length).toBe(MAX_EVIDENCE_ARGV_ENTRIES + 1);

    const result = buildVerificationRecipe(recipeInput({ argv }));

    expect(result.ok === false && result.code).toBe("RUNNER_EVIDENCE_ARGV_LIMIT");
  });

  it("refuses an ArtifactRef that fails ARTIFACT_ADDRESS_PATTERN with RUNNER_EVIDENCE_ARTIFACT_REF_INVALID", () => {
    const hostile = "Z".repeat(64);
    expect(ARTIFACT_ADDRESS_PATTERN.test(hostile)).toBe(false);

    const result = buildVerificationRecipe(
      recipeInput({ declaredInputs: [{ path: "src/a.ts", ref: refFor(hostile) }] }),
    );

    expect(result.ok === false && result.code).toBe("RUNNER_EVIDENCE_ARTIFACT_REF_INVALID");
    expect(result.ok === false && result.layer).toBe("RECIPE_SHAPE");
    expect(result.ok === false && result.path).toBe("src/a.ts");
  });

  it("refuses an over-limit declared closure with RUNNER_EVIDENCE_DECLARATION_LIMIT", () => {
    const declaredInputs: DeclaredInput[] = Array.from(
      { length: MAX_EVIDENCE_DECLARED_ENTRIES + 1 },
      (_, index) => ({ path: `src/f-${index}.ts`, ref: refFor(DIGEST_A) }),
    );
    expect(declaredInputs.length).toBe(MAX_EVIDENCE_DECLARED_ENTRIES + 1);

    const result = buildVerificationRecipe(recipeInput({ declaredInputs }));

    expect(result.ok === false && result.code).toBe("RUNNER_EVIDENCE_DECLARATION_LIMIT");
  });

  it("refuses a duplicated declared path with RUNNER_EVIDENCE_DECLARATION_DUPLICATE", () => {
    const result = buildVerificationRecipe(
      recipeInput({
        declaredInputs: [
          { path: "src/a.ts", ref: refFor(DIGEST_A) },
          { path: "src/a.ts", ref: refFor(DIGEST_B) },
        ],
      }),
    );

    expect(result.ok === false && result.code).toBe("RUNNER_EVIDENCE_DECLARATION_DUPLICATE");
  });

  it("refuses an output path that collides with a declared input path", () => {
    const result = buildVerificationRecipe(
      recipeInput({ declaredOutputPaths: ["src/a.ts"] }),
    );

    expect(result.ok === false && result.code).toBe("RUNNER_EVIDENCE_DECLARATION_DUPLICATE");
  });

  it("refuses a non-canonical declared path with RUNNER_EVIDENCE_PATH_NOT_CANONICAL", () => {
    const result = buildVerificationRecipe(
      recipeInput({ declaredInputs: [{ path: "../escape.ts", ref: refFor(DIGEST_A) }] }),
    );

    expect(result.ok === false && result.code).toBe("RUNNER_EVIDENCE_PATH_NOT_CANONICAL");
    expect(result.ok === false && result.layer).toBe("RECIPE_SHAPE");
  });

  it("refuses a verifier identity whose capability digest is not a sha256", () => {
    const result = buildVerificationRecipe(
      recipeInput({
        verifierIdentity: {
          verifierId: "moe-verifier",
          verifierVersion: "1.0.0",
          capabilitySchemaDigest: "not-a-digest",
        },
      }),
    );

    expect(result.ok === false && result.code).toBe("RUNNER_EVIDENCE_VERIFIER_IDENTITY_INVALID");
  });

  it("exposes no recipe on the refusal arm, so a digest cannot be read off an unnarrowed failure", () => {
    const result = buildVerificationRecipe(recipeInput({ argv: [] }));

    expect(result.ok).toBe(false);
    expect(Object.hasOwn(result, "recipe")).toBe(false);
  });
});
