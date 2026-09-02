import { createHash } from "node:crypto";

import type { V2CompiledMaterialDigest, V2CompiledRecipeBinding } from "./contracts.js";
import type { AdmittedCapabilityBinding } from "./resolution.js";

const DOMAIN = "moe-v2-qualified-identity/1";
const encoder = new TextEncoder();
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

function frame(value: string): string {
  return `${encoder.encode(value).byteLength}:${value}`;
}

/** ASCII identity whose digest preimage is namespace-separated and UTF-8 length-framed. */
export function qualifiedIdentity(namespace: string, parts: readonly string[]): string {
  const digest = createHash("sha256")
    .update(`${DOMAIN}\n${frame(namespace)}${parts.map(frame).join("")}`, "utf8")
    .digest("hex");
  return `moe.v2.${namespace}.sha256:${digest}`;
}

export function materialIdentity(
  kind: V2CompiledMaterialDigest["kind"], parts: readonly string[],
): string {
  return qualifiedIdentity(`material.${kind.toLowerCase()}`, parts);
}

export function schedulerRecipeIdentities(
  binding: AdmittedCapabilityBinding,
): readonly string[] {
  return Object.freeze(binding.verificationRecipes.map((recipe) => qualifiedIdentity(
    "verification-recipe", [recipe.recipeId, recipe.revisionId, recipe.revisionDigest],
  )).sort(compare));
}

export function schedulerResourceIdentities(
  binding: AdmittedCapabilityBinding, buildRecipe: V2CompiledRecipeBinding | null,
): readonly string[] {
  const rows = [
    ...binding.resourceScopes.map((resource) => qualifiedIdentity(
      "catalog-resource", [resource.kind, resource.ref],
    )),
    ...binding.roles.map((role) => qualifiedIdentity("catalog-role", [role])),
    ...binding.requiredImageDigests.map((digest) => qualifiedIdentity("required-image", [digest])),
    ...binding.requiredToolDigests.map((digest) => qualifiedIdentity("required-tool", [digest])),
    ...(buildRecipe === null ? [] : [qualifiedIdentity("build-recipe", [
      buildRecipe.recipeRef, buildRecipe.recipeDigest, buildRecipe.toolRef, ...buildRecipe.argv,
    ])]),
  ];
  return Object.freeze([...new Set(rows)].sort(compare));
}
