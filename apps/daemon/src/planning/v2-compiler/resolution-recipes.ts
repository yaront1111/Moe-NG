import { createHash } from "node:crypto";
import {
  admitVerificationRecipeForExecutionProfile, encodeVerificationRecipeRevision,
} from "@moe/core";

import type {
  V2CompiledRecipeBinding, V2CompiledVerificationRecipeBinding,
} from "./contracts.js";
import { materialDigest, record, text } from "./snapshot.js";

export function readBuildRecipe(value: unknown): V2CompiledRecipeBinding | undefined {
  const item = record(value); const argvValue = item?.["argv"];
  const argv = Array.isArray(argvValue) && argvValue.length > 0
    && argvValue.every((argument) => text(argument))
    ? Object.freeze([...(argvValue as string[])]) : undefined;
  if (item === undefined || argv === undefined || item["executionMode"] !== "DIRECT_ARGV"
    || !text(item["recipeRef"]) || !text(item["toolRef"])
    || !materialDigest(item["recipeDigest"])) return undefined;
  const expected = createHash("sha256")
    .update("moe-delivery-profile-recipe-digest/1", "utf8")
    .update(Uint8Array.of(0))
    .update(JSON.stringify({ argv: argvValue, executionMode: "DIRECT_ARGV",
      toolRef: item["toolRef"] }), "utf8")
    .digest("hex");
  return expected === item["recipeDigest"] ? Object.freeze({ argv,
    recipeDigest: expected, recipeRef: item["recipeRef"], toolRef: item["toolRef"] }) : undefined;
}

export function readVerificationRecipes(value: unknown,
  execution: Readonly<Record<string, unknown>>):
readonly V2CompiledVerificationRecipeBinding[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const recipes: V2CompiledVerificationRecipeBinding[] = [];
  for (const candidate of value) {
    const item = record(candidate);
    if (item === undefined || !text(item["recipeId"]) || !text(item["revisionId"])
      || !materialDigest(item["revisionDigest"])
      || item["executionProfileRevisionDigest"] !== execution["revisionDigest"]
      || item["sourceSnapshotDigest"] !== execution["sourceSnapshotDigest"]
      || !encodeVerificationRecipeRevision(candidate).ok
      || !admitVerificationRecipeForExecutionProfile(candidate, execution).ok) return undefined;
    recipes.push(Object.freeze({ recipeId: item["recipeId"],
      revisionDigest: item["revisionDigest"], revisionId: item["revisionId"] }));
  }
  recipes.sort((left, right) => left.revisionId < right.revisionId ? -1
    : left.revisionId > right.revisionId ? 1 : 0);
  return new Set(recipes.map((item) => item.revisionId)).size === recipes.length
    ? Object.freeze(recipes) : undefined;
}
