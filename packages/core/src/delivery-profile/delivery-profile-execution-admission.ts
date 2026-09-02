import {
  DELIVERY_PROFILE_LIMITS, DELIVERY_PROFILE_RECIPE_KINDS, DELIVERY_PROFILE_STACK_ROLES,
  type DeliveryProfileRecipeRef, type DeliveryProfileRecipes,
  type DeliveryProfileStackComponent, type DeliveryProfileStackEdge,
  type DeliveryProfileStackGrammar,
} from "./delivery-profile-contract.js";
import {
  badReference, exact, exceeded, malformed, readSortedItems, readText, shellExecution,
  recipeDigestMismatch, success, validHex64, type ReadResult,
} from "./delivery-profile-admission-primitives.js";
import { computeDeliveryProfileRecipeDigest } from "./delivery-profile-recipe-digest.js";

const STACK_KEYS = Object.freeze(["components", "dependencyEdges"]);
const COMPONENT_KEYS = Object.freeze([
  "artifactDigest", "componentId", "role", "technology", "version",
]);
const EDGE_KEYS = Object.freeze(["consumerComponentId", "providerComponentId"]);
const RECIPE_KEYS = Object.freeze([
  "argv", "executionMode", "recipeDigest", "recipeRef", "toolRef",
]);
const RECIPES_KEYS = Object.freeze(DELIVERY_PROFILE_RECIPE_KINDS.map(
  (kind) => kind.toLowerCase(),
));
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const SHELL_TOOL_TOKEN = /(?:^|[^a-z0-9])(?:sh|bash|dash|ash|zsh|csh|tcsh|ksh|fish|xonsh|cmd|powershell|pwsh)(?:\.exe)?(?:$|[^a-z0-9])/iu;
const SHELL_ESCAPE = /(?:&&|\|\||[|;<>`]|\$\(|\r|\n)/u;

function pinnedSemanticVersion(value: string): boolean {
  const match = SEMVER.exec(value); if (match === null) return false;
  const prerelease = match[4];
  return prerelease === undefined || prerelease.split(".").every(
    (identifier) => !/^[0-9]+$/u.test(identifier)
      || identifier === "0" || !identifier.startsWith("0"),
  );
}

function readComponent(value: unknown): ReadResult<DeliveryProfileStackComponent> {
  if (!exact(value, COMPONENT_KEYS) || !validHex64(value["artifactDigest"])) return malformed();
  const componentId = readText(value["componentId"]);
  const technology = readText(value["technology"]); const version = readText(value["version"]);
  const role = value["role"];
  if (!componentId.ok) return componentId; if (!technology.ok) return technology;
  if (!version.ok) return version;
  if (!pinnedSemanticVersion(version.value)
    || !DELIVERY_PROFILE_STACK_ROLES.some((candidate) => candidate === role)) return malformed();
  return success(Object.freeze({
    artifactDigest: value["artifactDigest"], componentId: componentId.value,
    role, technology: technology.value, version: version.value,
  } as DeliveryProfileStackComponent));
}

function readEdge(value: unknown): ReadResult<DeliveryProfileStackEdge> {
  if (!exact(value, EDGE_KEYS)) return malformed();
  const consumer = readText(value["consumerComponentId"]);
  const provider = readText(value["providerComponentId"]);
  if (!consumer.ok) return consumer; if (!provider.ok) return provider;
  if (consumer.value === provider.value) return badReference();
  return success(Object.freeze({
    consumerComponentId: consumer.value, providerComponentId: provider.value,
  }));
}

export function readStack(value: unknown): ReadResult<DeliveryProfileStackGrammar> {
  if (!exact(value, STACK_KEYS)) return malformed();
  const components = readSortedItems(
    value["components"], DELIVERY_PROFILE_LIMITS.maxComponents, false, readComponent,
    (item) => item.componentId,
  );
  const edges = readSortedItems(
    value["dependencyEdges"], DELIVERY_PROFILE_LIMITS.maxEdges, true, readEdge,
    (item) => `${item.consumerComponentId}\0${item.providerComponentId}`,
  );
  if (!components.ok) return components; if (!edges.ok) return edges;
  return success(Object.freeze({ components: components.value, dependencyEdges: edges.value }));
}

function readArgv(value: unknown): ReadResult<readonly string[]> {
  if (!Array.isArray(value) || value.length === 0) return malformed();
  if (value.length > DELIVERY_PROFILE_LIMITS.maxArgsPerRecipe) return exceeded();
  const argv: string[] = [];
  for (const candidate of value) {
    const argument = readText(candidate, DELIVERY_PROFILE_LIMITS.maxArgBytes);
    if (!argument.ok) return argument;
    argv.push(argument.value);
  }
  return success(Object.freeze(argv));
}

function shellLikeRecipe(toolRef: string, argv: readonly string[]): boolean {
  if (SHELL_TOOL_TOKEN.test(toolRef)) return true;
  return argv.some((argument) => {
    const lower = argument.toLowerCase();
    return SHELL_TOOL_TOKEN.test(argument) || SHELL_ESCAPE.test(argument)
      || lower === "-c" || lower === "/c" || lower === "-command"
      || lower === "--command" || lower === "-encodedcommand"
      || lower === "-e" || lower === "--eval";
  });
}

function readRecipe(value: unknown): ReadResult<DeliveryProfileRecipeRef> {
  if (!exact(value, RECIPE_KEYS) || !validHex64(value["recipeDigest"])) return malformed();
  const argv = readArgv(value["argv"]); const recipeRef = readText(value["recipeRef"]);
  const toolRef = readText(value["toolRef"]);
  if (!argv.ok) return argv; if (!recipeRef.ok) return recipeRef; if (!toolRef.ok) return toolRef;
  if (value["executionMode"] !== "DIRECT_ARGV"
    || shellLikeRecipe(toolRef.value, argv.value)) return shellExecution();
  if (value["recipeDigest"] !== computeDeliveryProfileRecipeDigest(
    toolRef.value, argv.value, "DIRECT_ARGV",
  )) return recipeDigestMismatch();
  return success(Object.freeze({
    argv: argv.value, executionMode: "DIRECT_ARGV" as const,
    recipeDigest: value["recipeDigest"], recipeRef: recipeRef.value, toolRef: toolRef.value,
  }));
}

export function readRecipes(value: unknown): ReadResult<DeliveryProfileRecipes> {
  if (!exact(value, RECIPES_KEYS)) return malformed();
  const activation = readRecipe(value["activation"]); const backup = readRecipe(value["backup"]);
  const browser = readRecipe(value["browser"]); const build = readRecipe(value["build"]);
  const health = readRecipe(value["health"]); const migration = readRecipe(value["migration"]);
  const restore = readRecipe(value["restore"]); const rollback = readRecipe(value["rollback"]);
  const test = readRecipe(value["test"]);
  if (!activation.ok) return activation; if (!backup.ok) return backup;
  if (!browser.ok) return browser; if (!build.ok) return build;
  if (!health.ok) return health; if (!migration.ok) return migration;
  if (!restore.ok) return restore; if (!rollback.ok) return rollback; if (!test.ok) return test;
  return success(Object.freeze({
    activation: activation.value, backup: backup.value, browser: browser.value,
    build: build.value, health: health.value, migration: migration.value,
    restore: restore.value, rollback: rollback.value, test: test.value,
  }));
}
