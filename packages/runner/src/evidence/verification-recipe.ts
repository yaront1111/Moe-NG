import { canonicalDigest, deepFreeze, isHex64 } from "../canonical.js";
import {
  evidenceFailure,
  evidencePathRejection,
  evidenceRefRejection,
  isBoundedEvidenceText,
  isEvidenceFailure,
  MAX_EVIDENCE_ARGV_ENTRIES,
  MAX_EVIDENCE_DECLARED_ENTRIES,
  recipeDigestInput,
  VERIFICATION_RECIPE_VERSION,
  type BuildVerificationRecipeInput,
  type BuildVerificationRecipeResult,
  type DeclaredInput,
  type EvidenceFailure,
  type VerificationRecipe,
  type VerifierIdentity,
} from "./evidence-contract.js";

const LAYER = "RECIPE_SHAPE" as const;

const isBoundedText = isBoundedEvidenceText;

/**
 * argv is the command. It is never sorted, deduplicated, or normalized past a
 * text check: order and repetition are facts about what was run, and folding
 * either would let two different commands share one recipe digest.
 */
function canonicalArgv(argv: readonly string[]): readonly string[] | EvidenceFailure {
  if (!Array.isArray(argv) || argv.length === 0) {
    return evidenceFailure(
      "RUNNER_EVIDENCE_ARGV_INVALID",
      LAYER,
      "argv must be a non-empty list of bounded normalized strings",
    );
  }
  if (argv.length > MAX_EVIDENCE_ARGV_ENTRIES) {
    return evidenceFailure(
      "RUNNER_EVIDENCE_ARGV_LIMIT",
      LAYER,
      `argv holds ${argv.length} entries, limit is ${MAX_EVIDENCE_ARGV_ENTRIES}`,
    );
  }
  for (const entry of argv) {
    if (!isBoundedText(entry)) {
      return evidenceFailure(
        "RUNNER_EVIDENCE_ARGV_INVALID",
        LAYER,
        `argv entry ${JSON.stringify(entry)} is not bounded normalized text`,
      );
    }
  }
  return [...argv];
}

/** Case folding is checked too: two paths one filesystem could merge are one path. */
class DeclaredPathSet {
  private readonly folded = new Set<string>();

  add(path: string): EvidenceFailure | null {
    const lowered = path.toLowerCase();
    if (this.folded.has(lowered)) {
      return evidenceFailure(
        "RUNNER_EVIDENCE_DECLARATION_DUPLICATE",
        LAYER,
        `path ${JSON.stringify(path)} is declared more than once`,
        path,
      );
    }
    this.folded.add(lowered);
    return null;
  }
}

const byPath = (left: { path: string }, right: { path: string }): number =>
  left.path < right.path ? -1 : left.path > right.path ? 1 : 0;

/**
 * The declared closure is sorted by path so two callers who found the same bytes
 * in a different order produce the same digest. Discovery order is not a fact
 * about the closure, unlike argv order, which is a fact about the command.
 */
function canonicalInputs(
  declaredInputs: readonly DeclaredInput[],
  declared: DeclaredPathSet,
): readonly DeclaredInput[] | EvidenceFailure {
  if (!Array.isArray(declaredInputs)) {
    return evidenceFailure(
      "RUNNER_EVIDENCE_ARTIFACT_REF_INVALID",
      LAYER,
      "declared inputs must be a list",
    );
  }
  if (declaredInputs.length > MAX_EVIDENCE_DECLARED_ENTRIES) {
    return evidenceFailure(
      "RUNNER_EVIDENCE_DECLARATION_LIMIT",
      LAYER,
      `declared closure holds ${declaredInputs.length} entries, limit is ${MAX_EVIDENCE_DECLARED_ENTRIES}`,
    );
  }
  const canonical: DeclaredInput[] = [];
  for (const entry of declaredInputs) {
    if (typeof entry !== "object" || entry === null) {
      return evidenceFailure(
        "RUNNER_EVIDENCE_ARTIFACT_REF_INVALID",
        LAYER,
        "every declared input must be a record",
      );
    }
    const pathFailure = evidencePathRejection(entry.path, LAYER);
    if (pathFailure !== null) {
      return pathFailure;
    }
    const refFailure = evidenceRefRejection(entry.ref, LAYER, entry.path);
    if (refFailure !== null) {
      return refFailure;
    }
    const duplicate = declared.add(entry.path);
    if (duplicate !== null) {
      return duplicate;
    }
    canonical.push({
      path: entry.path,
      ref: { sha256: entry.ref.sha256, byteLength: entry.ref.byteLength },
    });
  }
  return canonical.sort(byPath);
}

/**
 * Output paths share the declared path set with the inputs: a path that is both
 * rematerialized and produced has two owners for one byte, which is exactly the
 * ambiguity rematerialization later has to refuse.
 */
function canonicalOutputPaths(
  declaredOutputPaths: readonly string[],
  declared: DeclaredPathSet,
): readonly string[] | EvidenceFailure {
  if (!Array.isArray(declaredOutputPaths)) {
    return evidenceFailure(
      "RUNNER_EVIDENCE_PATH_NOT_CANONICAL",
      LAYER,
      "declared output paths must be a list",
    );
  }
  if (declaredOutputPaths.length > MAX_EVIDENCE_DECLARED_ENTRIES) {
    return evidenceFailure(
      "RUNNER_EVIDENCE_DECLARATION_LIMIT",
      LAYER,
      `output declaration holds ${declaredOutputPaths.length} entries, limit is ${MAX_EVIDENCE_DECLARED_ENTRIES}`,
    );
  }
  const canonical: string[] = [];
  for (const path of declaredOutputPaths) {
    const pathFailure = evidencePathRejection(path, LAYER);
    if (pathFailure !== null) {
      return pathFailure;
    }
    const duplicate = declared.add(path);
    if (duplicate !== null) {
      return duplicate;
    }
    canonical.push(path);
  }
  return canonical.sort();
}

function verifierIdentityRejection(identity: VerifierIdentity): EvidenceFailure | null {
  if (typeof identity !== "object" || identity === null) {
    return evidenceFailure(
      "RUNNER_EVIDENCE_VERIFIER_IDENTITY_INVALID",
      LAYER,
      "verifier identity must be a record",
    );
  }
  if (!isBoundedText(identity.verifierId) || !isBoundedText(identity.verifierVersion)) {
    return evidenceFailure(
      "RUNNER_EVIDENCE_VERIFIER_IDENTITY_INVALID",
      LAYER,
      "verifier identity needs a bounded verifierId and verifierVersion",
    );
  }
  if (!isHex64(identity.capabilitySchemaDigest)) {
    return evidenceFailure(
      "RUNNER_EVIDENCE_VERIFIER_IDENTITY_INVALID",
      LAYER,
      "verifier capability schema digest must be a sha256 hex digest",
    );
  }
  return null;
}

/**
 * Builds the immutable, content-addressed record of what a verifier was asked to
 * do. The returned recipe is deep-frozen and its digest covers exactly the object
 * returned, so a caller holding a reference cannot mutate what the digest
 * attested. Refusals carry a stable code and the refusing layer, and expose no
 * recipe field, so a digest can never be read off an unnarrowed failure.
 */
export function buildVerificationRecipe(
  input: BuildVerificationRecipeInput,
): BuildVerificationRecipeResult {
  const argv = canonicalArgv(input.argv);
  if (isEvidenceFailure(argv)) {
    return argv;
  }
  const declared = new DeclaredPathSet();
  const declaredInputs = canonicalInputs(input.declaredInputs, declared);
  if (isEvidenceFailure(declaredInputs)) {
    return declaredInputs;
  }
  const declaredOutputPaths = canonicalOutputPaths(input.declaredOutputPaths, declared);
  if (isEvidenceFailure(declaredOutputPaths)) {
    return declaredOutputPaths;
  }
  const identityFailure = verifierIdentityRejection(input.verifierIdentity);
  if (identityFailure !== null) {
    return identityFailure;
  }
  const body = {
    recipeVersion: VERIFICATION_RECIPE_VERSION,
    argv,
    declaredInputs,
    declaredOutputPaths,
    verifierIdentity: {
      verifierId: input.verifierIdentity.verifierId,
      verifierVersion: input.verifierIdentity.verifierVersion,
      capabilitySchemaDigest: input.verifierIdentity.capabilitySchemaDigest,
    },
  } as const satisfies Omit<VerificationRecipe, "sha256">;
  const recipe = deepFreeze({ ...body, sha256: canonicalDigest(recipeDigestInput(body)) });
  return Object.freeze({ ok: true as const, recipe });
}

/** Re-derives the digest from the recipe's own fields; a tampered recipe cannot answer true. */
export function recipeSealMatches(recipe: VerificationRecipe): boolean {
  try {
    return canonicalDigest(recipeDigestInput(recipe)) === recipe.sha256;
  } catch {
    return false;
  }
}
