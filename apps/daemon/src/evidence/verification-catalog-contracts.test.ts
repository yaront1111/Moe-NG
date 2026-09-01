import { describe, expect, it } from "vitest";

import {
  DAEMON_VERIFICATION_CATALOG, MAX_VERIFICATION_CATALOG_BYTES, VERIFICATION_CATALOG_CODES,
  VERIFICATION_CATALOG_ENV_KEY, VERIFICATION_CATALOG_VERSION, decodeVerificationCatalog,
  lookupCatalogArgv, verificationTestField,
} from "./verification-catalog-contracts.js";

/** The shape an operator writes. Built fresh per case so no test mutates another's input. */
const catalog = (entries: readonly unknown[]): unknown =>
  ({ catalogVersion: VERIFICATION_CATALOG_VERSION, entries });

const entry = (over: Readonly<Record<string, unknown>> = {}): unknown => ({
  argv: ["pnpm", "--filter", "@moe/daemon", "test"],
  capability: "daemon-verification",
  profileRevisionId: "profile-revision-1",
  projectId: "proj-dd087108",
  ...over,
});

const refusalOf = (value: { readonly ok: boolean }): readonly [string, string] => {
  if (value.ok) throw new Error("expected a refusal, got an admission");
  const refused = value as unknown as { readonly code: string; readonly layer: string };
  return [refused.code, refused.layer];
};

describe("verification catalog contracts (task-143cad76)", () => {
  it("names the seven distinctions the DoD requires, and nothing else", () => {
    expect([...VERIFICATION_CATALOG_CODES]).toEqual([
      "VERIFICATION_CATALOG_ABSENT", "VERIFICATION_CATALOG_ARGV_INVALID",
      "VERIFICATION_CATALOG_ENTRY_ABSENT", "VERIFICATION_CATALOG_MALFORMED",
      "VERIFICATION_CATALOG_PROJECT_ABSENT", "VERIFICATION_CATALOG_TOO_LARGE",
      "VERIFICATION_CATALOG_UNREADABLE",
    ]);
  });

  it("publishes the env key and the byte ceiling the reader is bounded by", () => {
    expect(VERIFICATION_CATALOG_ENV_KEY).toBe("MOE_VERIFICATION_CATALOG");
    expect(MAX_VERIFICATION_CATALOG_BYTES).toBe(1_048_576);
  });

  it("admits a well-formed catalog and freezes what it hands back", () => {
    const decoded = decodeVerificationCatalog(catalog([entry()]));
    if (!decoded.ok) throw new Error(`expected admission, got ${decoded.code}`);
    expect(decoded.catalog.entries).toHaveLength(1);
    expect([...(decoded.catalog.entries[0]?.argv ?? [])])
      .toEqual(["pnpm", "--filter", "@moe/daemon", "test"]);
    expect(Object.isFrozen(decoded.catalog.entries)).toBe(true);
    expect(Object.isFrozen(decoded.catalog.entries[0])).toBe(true);
  });

  it("refuses a non-object, a wrong key set and an unsupported version as MALFORMED", () => {
    for (const input of [
      null, 42, "catalog", [], {},
      { catalogVersion: VERIFICATION_CATALOG_VERSION },
      { catalogVersion: "moe-verification-catalog/0", entries: [entry()] },
      catalog([]),
      catalog([{ argv: ["pnpm"], capability: "c" }]),
      catalog([entry({ profileRevisionId: "" })]),
    ]) {
      expect(refusalOf(decodeVerificationCatalog(input)))
        .toEqual(["VERIFICATION_CATALOG_MALFORMED", DAEMON_VERIFICATION_CATALOG]);
    }
  });

  it("refuses an accessor rather than invoking it", () => {
    const hostile = { catalogVersion: VERIFICATION_CATALOG_VERSION };
    Object.defineProperty(hostile, "entries", { enumerable: true, get: () => [entry()] });
    expect(refusalOf(decodeVerificationCatalog(hostile)))
      .toEqual(["VERIFICATION_CATALOG_UNREADABLE", DAEMON_VERIFICATION_CATALOG]);
  });

  it("refuses every argv a join could not round-trip, with its own code", () => {
    for (const argv of [
      [], "pnpm test", ["pnpm", ""], ["pnpm", 7], ["pnpm test"], ["pnpm\ttest"],
      ["pnpm", "--filter=a b"], ["pnpm", "\"quoted\""], ["pnpm", "back\\slash"],
    ]) {
      expect(refusalOf(decodeVerificationCatalog(catalog([entry({ argv })]))))
        .toEqual(["VERIFICATION_CATALOG_ARGV_INVALID", DAEMON_VERIFICATION_CATALOG]);
    }
  });

  it("refuses a duplicate (projectId, capability) pair as MALFORMED", () => {
    expect(refusalOf(decodeVerificationCatalog(catalog([entry(), entry()]))))
      .toEqual(["VERIFICATION_CATALOG_MALFORMED", DAEMON_VERIFICATION_CATALOG]);
  });

  it("separates an absent project from an absent entry within a present project", () => {
    const decoded = decodeVerificationCatalog(catalog([entry()]));
    if (!decoded.ok) throw new Error(`expected admission, got ${decoded.code}`);
    expect(refusalOf(lookupCatalogArgv(decoded.catalog, "proj-other", "daemon-verification")))
      .toEqual(["VERIFICATION_CATALOG_PROJECT_ABSENT", DAEMON_VERIFICATION_CATALOG]);
    expect(refusalOf(lookupCatalogArgv(decoded.catalog, "proj-dd087108", "other-capability")))
      .toEqual(["VERIFICATION_CATALOG_ENTRY_ABSENT", DAEMON_VERIFICATION_CATALOG]);
    const found = lookupCatalogArgv(decoded.catalog, "proj-dd087108", "daemon-verification");
    if (!found.ok) throw new Error(`expected a hit, got ${found.code}`);
    expect([...found.argv]).toEqual(["pnpm", "--filter", "@moe/daemon", "test"]);
  });

  it("maps the vector onto the brief's single `test` string losslessly", () => {
    const argv = ["pnpm", "--filter", "@moe/daemon", "test"];
    expect(verificationTestField(argv)).toBe("pnpm --filter @moe/daemon test");
    expect(verificationTestField(argv).split(" ")).toEqual(argv);
  });

  it("touches no filesystem and no spec-file authority", async () => {
    const source = await import("node:fs/promises")
      .then(async (fs) => fs.readFile(
        new URL("./verification-catalog-contracts.ts", import.meta.url), "utf8"));
    expect(source).not.toMatch(/node:fs|readFile/u);
    expect(source).not.toMatch(/nodeSpecsDir|NodeMission/u);
  });
});
