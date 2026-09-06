/**
 * WHICH ENVIRONMENT VARIABLES A CONTRACT REQUIRES, AND WHICH OF THEM AN ENVIRONMENT LACKS.
 *
 * NAMES ONLY, AND THERE IS NO SLOT FOR A VALUE. Both halves of the difference are name-shaped by
 * construction: the required side reads `environmentVariableNames` off the contract, which is
 * contract TEXT that gets displayed, stored and published; the set side reads `name` off
 * `EnvironmentVariableRead`, whose four keys carry a fingerprint and no plaintext. Nothing here
 * opens a seal, calls the store, logs, or stringifies a variable. The plaintext delivery path is
 * a different row's, and it does not pass through this module.
 *
 * IT LIVES BESIDE THE STORE, NOT BESIDE THE DEPLOYMENT GENERATOR. The half that is hard to get
 * right is the difference against `readEnvironmentVariables`' projection, and that projection's
 * type, its name grammar and its "only set variables are returned" invariant are all defined in
 * this directory. `repository/deployment/` decides which infrastructure FILES to emit and takes
 * requirement ids, not variable names. The `.env.example` extension consumes this module's output
 * as a plain sorted `string[]`, so nothing there imports back into the environment area.
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

import type { EnvironmentVariableRead } from "./environment-contracts.js";

/**
 * The CONTRACT's own environment-variable name grammar, mirrored from
 * `product-contract-v2-admission.ts` (`ENVIRONMENT_VARIABLE_NAME`). No `/g` flag, so `.test()`
 * holds no cursor between calls.
 *
 * DELIBERATELY NOT the store's `isEnvironmentVariableName`, which is NARROWER: the store requires
 * `/^[A-Z][A-Z0-9_]*$/u` while the contract admits a LEADING UNDERSCORE. Filtering with the
 * store's pattern would silently delete `_INTERNAL_TOKEN` from both the unset report and
 * `.env.example`, so an operator would never learn a required variable existed. A name the
 * contract admits is reported; if the store cannot hold it, it reports as permanently unset,
 * which is the truth rather than a disappearance.
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

/**
 * The required names an environment does NOT hold: `required` MINUS the names the store reported.
 *
 * A PURE FUNCTION OVER ITS TWO ARGUMENTS, deliberately. The store read stays the single seam that
 * touches durable bytes, and the difference is testable without opening a store or holding a
 * credential.
 *
 * `readEnvironmentVariables` returns ONLY variables that are set (`isSet: true` is the type's
 * sole inhabitant), so membership in `read` IS "set" — there is no `isSet` branch to get wrong,
 * and a future optional-false member would have to change the type here first. A set variable the
 * contract does not require is not reported: the difference is one-directional on purpose, since
 * an environment may legitimately hold more than the contract names.
 */
export function unsetVariableNames(
  required: readonly string[],
  read: readonly EnvironmentVariableRead[],
): readonly string[] {
  const set = new Set(read.map((variable) => variable.name));
  return ordered([...required].filter((name) => !set.has(name)));
}
