/**
 * The production call site for `sealRecipe`, graded on wiring rather than on
 * export existence. Every accepted case drives the real
 * `project.register` -> `provider.probe` path so the runtime observation the
 * seal consumes is a PROVEN durable one, never a shape built by this test.
 */

import {
  mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { PROJECT_ID, closeStores, send } from "../bootstrap/bootstrap-test-fixtures.js";
import {
  REVISION_ID, closeForeignStores, probeFor, registeredStore,
} from "../provider-profile/provider-runtime-observation-test-fixtures.js";
import {
  DAEMON_VERIFICATION_CATALOG, VERIFICATION_CATALOG_ENV_KEY, VERIFICATION_CATALOG_VERSION,
} from "./verification-catalog-contracts.js";
import { createVerificationCatalogReader, readVerificationCatalogConfig }
  from "./verification-catalog-reader.js";
import {
  DAEMON_RECIPE_SEAL, createRecipeSealComposition, derivedRecipeAggregateId,
} from "./recipe-seal-composition.js";
import {
  deriveRecipeAggregateId, eventsOf, storedRecipe, typed,
} from "./foundation-verification-store.js";

const CAPABILITY = "daemon-verification";
const ARGV = ["pnpm", "--filter", "@moe/daemon", "test"];
const OTHER_ARGV = ["pnpm", "--filter", "@moe/core", "test"];
const HEX_64 = /^[0-9a-f]{64}$/u;

const roots: string[] = [];

afterAll(() => {
  closeForeignStores();
  closeStores();
  for (const root of roots) rmSync(root, { force: true, recursive: true });
});

function catalogPath(
  label: string, argv: readonly string[], revision: string = REVISION_ID,
): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `moe-seal-${label}-`)));
  roots.push(root);
  const path = join(root, "verification-catalog.json");
  writeFile(path, argv, revision);
  return path;
}

function writeFile(
  path: string, argv: readonly string[], revision: string = REVISION_ID,
): void {
  writeFileSync(path, JSON.stringify({
    catalogVersion: VERIFICATION_CATALOG_VERSION,
    entries: [{
      argv: [...argv], capability: CAPABILITY, profileRevisionId: revision,
      projectId: PROJECT_ID,
    }],
  }), "utf8");
}

type Store = ReturnType<typeof registeredStore>;

/** A store carrying a real registration and a real probe: the observation the
 *  seal reads is the one the production writer persisted. */
function provenStore(): Store {
  const store = registeredStore();
  const probe = send(store, probeFor());
  if (!probe.ok) throw new Error(`probe refused: ${probe.code}`);
  return store;
}

function compositionOver(store: Store, path: string | undefined): ReturnType<
  typeof createRecipeSealComposition
> {
  return createRecipeSealComposition({
    catalog: createVerificationCatalogReader({
      catalogSource: readVerificationCatalogConfig(
        path === undefined ? {} : { [VERIFICATION_CATALOG_ENV_KEY]: path }),
    }),
    principalId: "operator-local",
    projectId: PROJECT_ID,
    store,
  });
}

const refusalOf = (value: { readonly ok: boolean }): readonly [string, string] => {
  if (value.ok) throw new Error("expected a refusal, got an admission");
  const refused = value as unknown as { readonly code: string; readonly layer: string };
  return [refused.code, refused.layer];
};

/** The argv the DURABLE seal actually holds. Read back from the store rather
 *  than echoed from the call, because the point of the assertion is that the
 *  bytes on disk came from the catalog and from nowhere else. */
const durableArgv = (store: Store, recipeAggregateId: string): readonly string[] => {
  const sealed = storedRecipe(store as never, recipeAggregateId);
  if (sealed === null || "ok" in sealed) throw new Error("no usable sealed recipe on record");
  return sealed.recipe.argv;
};

const sealedRows = (store: Store, recipeAggregateId: string): number => {
  const read = eventsOf(store as never, deriveRecipeAggregateId(recipeAggregateId));
  if (!read.ok) throw new Error(`store refused the read: ${read.code}`);
  return typed(read.events, "RECIPE_SEALED").length;
};

describe("recipe seal composition (task-143cad76)", () => {
  it("seals a recipe whose argv came from the catalog, under a derived identity", () => {
    const store = provenStore();
    const composition = compositionOver(store, catalogPath("sealed", ARGV));
    const sealed = composition.sealForCapability(CAPABILITY);
    if (!sealed.ok) throw new Error(`expected a seal, got ${sealed.code}`);
    expect(sealed.sha256).toMatch(HEX_64);
    expect(sealed.recipeAggregateId).toBe(derivedRecipeAggregateId(PROJECT_ID, CAPABILITY));
    expect(sealedRows(store, sealed.recipeAggregateId)).toBe(1);
    // THE SERVER-DERIVED ASSERTION, and it has to read the durable bytes: a
    // seal that ignored the catalog and used some other argv still produces a
    // real sha256 under the right identity, so shape and identity alone cannot
    // tell a catalog-derived command from any other one.
    expect([...durableArgv(store, sealed.recipeAggregateId)]).toEqual([...ARGV]);
  });

  it("derives the identity from the pair alone, never from the argv", () => {
    // If argv fed the identity, changing it would mint a new aggregate and the
    // conflict arm below could never fire.
    expect(derivedRecipeAggregateId(PROJECT_ID, CAPABILITY))
      .toBe(derivedRecipeAggregateId(PROJECT_ID, CAPABILITY));
    expect(derivedRecipeAggregateId(PROJECT_ID, "other"))
      .not.toBe(derivedRecipeAggregateId(PROJECT_ID, CAPABILITY));
    expect(derivedRecipeAggregateId("proj-other", CAPABILITY))
      .not.toBe(derivedRecipeAggregateId(PROJECT_ID, CAPABILITY));
  });

  it("replays identical bytes: same sha256, and no second durable row", () => {
    const store = provenStore();
    const composition = compositionOver(store, catalogPath("replay", ARGV));
    const first = composition.sealForCapability(CAPABILITY);
    const second = composition.sealForCapability(CAPABILITY);
    if (!first.ok || !second.ok) throw new Error("expected both seals to answer");
    expect(second.sha256).toBe(first.sha256);
    expect(sealedRows(store, first.recipeAggregateId)).toBe(1);
  });

  it("refuses CONFLICT when the same identity is asked to seal different argv", () => {
    const store = provenStore();
    const path = catalogPath("conflict", ARGV);
    const composition = compositionOver(store, path);
    const first = composition.sealForCapability(CAPABILITY);
    if (!first.ok) throw new Error(`expected a seal, got ${first.code}`);
    writeFile(path, OTHER_ARGV);
    expect(refusalOf(composition.sealForCapability(CAPABILITY)))
      .toEqual(["FOUNDATION_VERIFICATION_RECIPE_CONFLICT", "DAEMON_VERIFICATION_IDENTITY"]);
    // The first seal's bytes stayed exactly where they were.
    expect(sealedRows(store, first.recipeAggregateId)).toBe(1);
  });

  it("forwards the catalog's own refusal, code and layer unrestamped", () => {
    const store = provenStore();
    const composition = compositionOver(store, catalogPath("entry", ARGV));
    expect(refusalOf(composition.sealForCapability("uncovered-capability")))
      .toEqual(["VERIFICATION_CATALOG_ENTRY_ABSENT", DAEMON_VERIFICATION_CATALOG]);
    const unconfigured = compositionOver(store, undefined);
    expect(refusalOf(unconfigured.sealForCapability(CAPABILITY)))
      .toEqual(["VERIFICATION_CATALOG_ABSENT", DAEMON_VERIFICATION_CATALOG]);
  });

  it("forwards the observation reader's refusal, code and layer unrestamped", () => {
    // Registered but never probed: the runtime observation the seal needs is
    // genuinely absent, and that answer belongs to the reader's layer.
    const store = registeredStore("proj-unprobed");
    const composition = createRecipeSealComposition({
      catalog: createVerificationCatalogReader({
        catalogSource: readVerificationCatalogConfig(
          { [VERIFICATION_CATALOG_ENV_KEY]: catalogPath("unprobed", ARGV) }),
      }),
      principalId: "operator-local",
      projectId: PROJECT_ID,
      store,
    });
    expect(refusalOf(composition.sealForCapability(CAPABILITY)))
      .toEqual(["PROVIDER_RUNTIME_OBSERVATION_ABSENT", "PROVIDER_RUNTIME_OBSERVATION_READER"]);
  });

  it("resolves a server-derived identity back to its entry, taking no value from it", () => {
    const store = provenStore();
    const composition = compositionOver(store, catalogPath("named", ARGV));
    const named = composition.sealNamed(derivedRecipeAggregateId(PROJECT_ID, CAPABILITY));
    if (!named.ok) throw new Error(`expected a seal, got ${named.code}`);
    expect(named.sha256).toMatch(HEX_64);
    // An identity no configured pair derives to is an absent ENTRY, not a seal.
    expect(refusalOf(composition.sealNamed("recipe-someone-made-up")))
      .toEqual(["VERIFICATION_CATALOG_ENTRY_ABSENT", DAEMON_VERIFICATION_CATALOG]);
  });

  it("refuses when the catalog names a revision the durable probe does not carry", () => {
    // The operator's profileRevisionId is a FENCE, not a label: the observation
    // is read by that identity, so a catalog pointing at a revision the probe on
    // record was never taken under must refuse rather than seal over the gap.
    const store = provenStore();
    const composition = compositionOver(
      store, catalogPath("drifted", ARGV, "profile-revision-nobody-probed"));
    expect(refusalOf(composition.sealForCapability(CAPABILITY))).toEqual([
      "PROVIDER_RUNTIME_OBSERVATION_IDENTITY_MISMATCH", "PROVIDER_RUNTIME_OBSERVATION_READER",
    ]);
  });

  it("names its own layer for the one refusal it authors", () => {
    expect(DAEMON_RECIPE_SEAL).toBe("DAEMON_RECIPE_SEAL");
  });
});

/**
 * ARM A - THE WIRED-WRITER ASSERTION. `typeof sealRecipe === "function"` would
 * have passed every day this defect existed: the symbol was exported and called
 * by nobody. This enumerates CALL SITES in production sources instead.
 *
 * Three exclusions, each load-bearing. The DEFINITION module is excluded because
 * its own interface line, its `function` line and its self-export in the
 * returned object are not call sites and would keep this arm green forever.
 * `*.test.ts` is excluded because a test calling the writer is not wiring.
 * `*-fixtures.ts` is excluded for the same reason and is NOT hypothetical:
 * goals/goal-closure-test-fixtures.ts really does call `service.sealRecipe`, is
 * imported only by test files, and a plain `:!*.test.ts` exclusion counts it -
 * which would let this arm read as wired with the production call site deleted.
 */
const DEFINITION_MODULE = "foundation-verification-service.ts";
const PRODUCTION_SOURCE = /(?<!\.test)\.ts$/u;
const CALL_SITE = /\bsealRecipe\s*\(/u;

function productionSources(directory: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...productionSources(full));
      continue;
    }
    if (!PRODUCTION_SOURCE.test(entry.name)) continue;
    if (entry.name.endsWith("-fixtures.ts") || entry.name === DEFINITION_MODULE) continue;
    found.push(full);
  }
  return found;
}

const DAEMON_SRC = fileURLToPath(new URL("..", import.meta.url));

describe("sealRecipe is wired, not merely exported (task-143cad76)", () => {
  it("finds at least one production call site, and names this row's module", () => {
    const callers = productionSources(DAEMON_SRC)
      .filter((path) => CALL_SITE.test(readFileSync(path, "utf8")))
      .map((path) => path.slice(DAEMON_SRC.length).replaceAll("\\", "/"))
      .sort();
    expect(callers.length).toBeGreaterThan(0);
    expect(callers).toContain("evidence/recipe-seal-composition.ts");
  });

  it("proves the scan can see a call site at all", () => {
    // POSITIVE CONTROL. An empty enumeration and a broken enumeration look
    // identical, and this arm's whole job is to notice an empty one.
    const sources = productionSources(DAEMON_SRC);
    expect(sources.length).toBeGreaterThan(50);
    expect(CALL_SITE.test("  const sealed = service.sealRecipe({")).toBe(true);
    expect(CALL_SITE.test("  sealRecipe(input: FoundationRecipeRegistration): Outcome;")).toBe(true);
    // ...and that the exclusions really exclude, so a green above is not the
    // fixture and not the definition answering for the production wiring.
    const names = sources.map((path) => path.slice(DAEMON_SRC.length).replaceAll("\\", "/"));
    expect(names).not.toContain("goals/goal-closure-test-fixtures.ts");
    expect(names).not.toContain(`evidence/${DEFINITION_MODULE}`);
    expect(names).toContain("evidence/recipe-seal-composition.ts");
  });
});

/**
 * ARM B - THE SOURCE-GREP BAN, DoD item 1 as amended by
 * comment-80620701d58846e9a6aa2217f9e85069.
 *
 * Scoped, in both directions, because both blanket forms are wrong: a blanket fs
 * ban would fail the catalog reader that legitimately opens the configured file,
 * and a blanket exemption would let any module in this family start reading the
 * worktree. So the reader is the SINGLE named exception to the fs half, and the
 * shared-tree half is never relaxed for anyone - the ruling admits host-scoped
 * process config, which is a different class from a shared-tree-writable source,
 * so rail 2 stands exactly as written.
 */
const OWNED_MODULES = [
  "verification-catalog-contracts.ts", "recipe-seal-composition.ts",
  "verification-catalog-reader.ts",
] as const;
const FS_EXEMPT = "verification-catalog-reader.ts";
const SHARED_TREE = /nodeSpecsDir|NodeMission/u;
const FILESYSTEM = /node:fs|readFile/u;

describe("this row's modules read no disqualified authority (task-143cad76)", () => {
  const sourceOf = (name: string): string =>
    readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");

  it("never reads a shared-tree-writable source, in any module, with no exception", () => {
    for (const name of OWNED_MODULES) {
      expect(sourceOf(name), `${name} names a shared-tree source`).not.toMatch(SHARED_TREE);
    }
  });

  it("touches the filesystem only in the catalog reader", () => {
    for (const name of OWNED_MODULES) {
      if (name === FS_EXEMPT) continue;
      expect(sourceOf(name), `${name} reads the filesystem`).not.toMatch(FILESYSTEM);
    }
  });

  it("proves the exemption is needed and the patterns are live", () => {
    // POSITIVE CONTROL for both halves: an assertion that can never fire is not
    // a guard. The exempt reader MUST match the fs pattern - if it stopped
    // matching, the exemption would be silently protecting nothing and the
    // scoping this arm exists for would have become meaningless.
    expect(sourceOf(FS_EXEMPT)).toMatch(FILESYSTEM);
    expect(SHARED_TREE.test("const dir = env.MOE_NODE_SPECS_DIR; nodeSpecsDir")).toBe(true);
  });
});
