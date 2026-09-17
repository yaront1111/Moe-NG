/**
 * WHICH ENVIRONMENT VARIABLES A CONTRACT REQUIRES.
 *
 * NAMES ONLY, AND THERE IS NO SLOT FOR A VALUE. The read is name-shaped by construction: it reads
 * `environmentVariableNames` off the contract, which is contract TEXT that gets displayed, stored
 * and published. Nothing here opens a seal, calls the store, logs, or stringifies a variable. The
 * plaintext delivery path is a different row's, and it does not pass through this module. The
 * required-minus-set difference is NOT computed here: the control room's
 * `environment-variables-model.ts` merges these names with the `POST /environments/read` table,
 * which is the one place both sides are already in hand.
 *
 * IT LIVES BESIDE THE STORE, NOT BESIDE THE DEPLOYMENT GENERATOR. The store's name grammar, which
 * this module's grammar deliberately widens (see below), is defined in this directory.
 * `repository/deployment/` decides which infrastructure FILES to emit and takes requirement ids,
 * not variable names. The `.env.example` extension consumes this module's output
 * as a plain sorted `string[]`, and it imports exactly ONE symbol back from here:
 * `isContractVariableName`, at controlled-profile-root-templates.ts:24. That import is deliberate
 * rather than a leak of this area into the generator: the grammar that filters names on their way
 * into PUBLISHED bytes must be this module's copy, because a restated second copy could drift and
 * the generator's is the copy whose drift would publish.
 *
 * WHY THE READ IS NOT A ONE-LINER OVER A FLATTENED REQUIREMENT LIST. Two helpers in this repo
 * spread all six requirement sections into a single array and return the BASE
 * `ProductContractV2Requirement` type: `gate1Requirements()` in the control room and
 * `allRequirements()` in `planning/v2-compiler/requirement-order.ts`. Both erase the section of
 * origin, and both erase the carrier at the type level while the runtime objects keep it — so a
 * read routed through either compiles cleanly and silently collects names that a technology or
 * security requirement happened to declare. `revision.deploymentRequirements` is read DIRECTLY,
 * and a test arm pins that scope.
 */
import type { ProductContractRevisionV2 } from "@moe/core";

/**
 * The CONTRACT's own environment-variable name grammar, mirrored from
 * `product-contract-v2-admission.ts` (`ENVIRONMENT_VARIABLE_NAME`). No `/g` flag, so `.test()`
 * holds no cursor between calls.
 *
 * DELIBERATELY NOT the store's `isEnvironmentVariableName`, which is NARROWER: the store requires
 * `/^[A-Z][A-Z0-9_]*$/u` while the contract admits a LEADING UNDERSCORE. Filtering with the
 * store's pattern would silently delete `_INTERNAL_TOKEN` from `.env.example`, so an operator
 * would never learn a required variable existed. A name the contract admits is reported; if the
 * store cannot hold it, the control room shows it as permanently unset, which is the truth rather
 * than a disappearance.
 */
const CONTRACT_VARIABLE_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** Mirrors `PRODUCT_CONTRACT_V2_LIMITS.maxEnvironmentVariableNameBytes`. */
const MAX_NAME_LENGTH = 128;

/**
 * Admission already enforces this grammar, so on the approved path the check never fires. It is
 * kept because these bytes are interpolated into `.env.example`, which is committed and pushed
 * into the product's repository: a name carrying a newline or an `=` would inject a LINE, and a
 * line is where a value would come from. A revision reaching this module from an unvalidated
 * decode is the case that matters, and dropping is the fail-closed answer — an unusable name is
 * not published, and a published file cannot be un-pushed.
 *
 * EXPORTED so the profile's `.env.example` template can re-check at the byte-emitting boundary
 * without owning a SECOND copy of the grammar. Two copies would drift, and the one in the
 * template is the one whose drift publishes bytes.
 */
export function isContractVariableName(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_NAME_LENGTH
    && CONTRACT_VARIABLE_NAME.test(value);
}

/**
 * UTF-16 code-unit order, NOT `localeCompare`: these names are emitted into a file pinned by
 * SHA256, and a locale-dependent sort would move that hash between hosts.
 */
function ordered(names: Iterable<string>): readonly string[] {
  return [...new Set(names)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * The environment variables the APPROVED contract requires, deduped and sorted.
 *
 * Sorted is load-bearing, not tidiness: the result feeds `.env.example`, whose bytes are pinned by
 * a golden SHA256, so an order that tracked the contract's requirement order would move that hash
 * on an edit that changed no name.
 *
 * A requirement whose carrier is absent, or is an empty list, contributes nothing — that is the
 * common case and the reason the carrier is optional. A contract that names nothing yields `[]`
 * rather than throwing, so a project that does not use this feature is simply unaffected.
 */
export function requiredVariableNames(revision: ProductContractRevisionV2): readonly string[] {
  const names: string[] = [];
  for (const requirement of revision.deploymentRequirements) {
    const declared = requirement.environmentVariableNames;
    if (declared === undefined || !Array.isArray(declared)) continue;
    for (const name of declared) {
      if (isContractVariableName(name)) names.push(name);
    }
  }
  return ordered(names);
}
