import { createHash } from "node:crypto";

export const DELIVERY_PROFILE_RECIPE_DIGEST_DOMAIN =
  "moe-delivery-profile-recipe-digest/1" as const;

/** Identity of the exact executable reference and argument vector; recipeRef is only a label. */
export function computeDeliveryProfileRecipeDigest(
  toolRef: string,
  argv: readonly string[],
  executionMode: "DIRECT_ARGV" = "DIRECT_ARGV",
): string {
  const material = JSON.stringify({ argv, executionMode, toolRef });
  return createHash("sha256")
    .update(DELIVERY_PROFILE_RECIPE_DIGEST_DOMAIN, "utf8")
    .update(Uint8Array.of(0))
    .update(material, "utf8")
    .digest("hex");
}
