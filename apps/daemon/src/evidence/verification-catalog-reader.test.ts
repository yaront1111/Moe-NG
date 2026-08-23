import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The ordering probe. `statSync` before `readFileSync` is a MEMORY property, not
 * an answer property: a reader that reads first and measures second returns the
 * identical TOO_LARGE code, so no assertion over the reader's output can see the
 * difference. Measured directly, by recording the real calls in order and then
 * delegating to the real implementations, so the module under test is observed
 * rather than reimplemented.
 */
const { fsCalls } = vi.hoisted(() => ({ fsCalls: [] as string[] }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      fsCalls.push(`read:${String(args[0])}`);
      return actual.readFileSync(...args);
    },
    statSync: (...args: Parameters<typeof actual.statSync>) => {
      fsCalls.push(`stat:${String(args[0])}`);
      return actual.statSync(...args);
    },
  };
});

import {
  DAEMON_VERIFICATION_CATALOG, VERIFICATION_CATALOG_ENV_KEY, VERIFICATION_CATALOG_VERSION,
} from "./verification-catalog-contracts.js";
import {
  createVerificationCatalogReader, readVerificationCatalogConfig,
} from "./verification-catalog-reader.js";

const ARGV = ["pnpm", "--filter", "@moe/daemon", "test"] as const;
const PROJECT = "proj-dd087108";
const CAPABILITY = "daemon-verification";
const REVISION = "profile-revision-1";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { force: true, recursive: true });
  }
});

function tempRoot(label: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `moe-verify-catalog-${label}-`)));
  roots.push(root);
  return root;
}

function catalogFile(label: string, body: string | Buffer): string {
  const path = join(tempRoot(label), "verification-catalog.json");
  writeFileSync(path, body);
  return path;
}

const wellFormed = JSON.stringify({
  catalogVersion: VERIFICATION_CATALOG_VERSION,
  entries: [{
    argv: [...ARGV], capability: CAPABILITY, profileRevisionId: REVISION, projectId: PROJECT,
  }],
});

/** The reader under test, over an explicit env — never over the ambient process env. */
const readerFor = (path: string | undefined): ReturnType<typeof createVerificationCatalogReader> =>
  createVerificationCatalogReader({
    catalogSource: readVerificationCatalogConfig(
      path === undefined ? {} : { [VERIFICATION_CATALOG_ENV_KEY]: path }),
  });

const refusalOf = (value: { readonly ok: boolean }): readonly [string, string] => {
  if (value.ok) throw new Error("expected a refusal, got an admission");
  const refused = value as unknown as { readonly code: string; readonly layer: string };
  return [refused.code, refused.layer];
};

describe("verification catalog reader (task-143cad76)", () => {
  it("reads nothing at construction: the thunk is lazy", () => {
    const path = join(tempRoot("lazy"), "never-written.json");
    // Constructing over a path that does not exist must NOT throw. The precedent
    // this mirrors refuses the OPERATION at use time rather than failing boot.
    const reader = readerFor(path);
    expect(refusalOf(reader.argvFor(PROJECT, CAPABILITY)))
      .toEqual(["VERIFICATION_CATALOG_UNREADABLE", DAEMON_VERIFICATION_CATALOG]);
  });

  it("treats an absent and an empty env value as ABSENT, not as an empty catalog", () => {
    expect(readVerificationCatalogConfig({})()).toBeUndefined();
    expect(readVerificationCatalogConfig({ [VERIFICATION_CATALOG_ENV_KEY]: "" })()).toBeUndefined();
    for (const reader of [readerFor(undefined), readerFor("")]) {
      expect(refusalOf(reader.argvFor(PROJECT, CAPABILITY)))
        .toEqual(["VERIFICATION_CATALOG_ABSENT", DAEMON_VERIFICATION_CATALOG]);
    }
  });

  it("answers the exact vector the operator configured", () => {
    const reader = readerFor(catalogFile("hit", wellFormed));
    const found = reader.argvFor(PROJECT, CAPABILITY);
    if (!found.ok) throw new Error(`expected a hit, got ${found.code}`);
    expect([...found.argv]).toEqual([...ARGV]);
  });

  it("refuses a file past the byte ceiling as TOO_LARGE, distinct from UNREADABLE", () => {
    const reader = readerFor(catalogFile("huge", Buffer.alloc(1_048_577, 0x20)));
    expect(refusalOf(reader.argvFor(PROJECT, CAPABILITY)))
      .toEqual(["VERIFICATION_CATALOG_TOO_LARGE", DAEMON_VERIFICATION_CATALOG]);
  });

  it("decides the ceiling before parsing, so oversized beats unparseable", () => {
    const reader = readerFor(catalogFile("huge-invalid", Buffer.alloc(1_048_577, 0x7b)));
    // These bytes are also unparseable JSON. TOO_LARGE can only win if the
    // ceiling is decided ahead of the parse.
    expect(refusalOf(reader.argvFor(PROJECT, CAPABILITY)))
      .toEqual(["VERIFICATION_CATALOG_TOO_LARGE", DAEMON_VERIFICATION_CATALOG]);
  });

  it("checks the size BEFORE the read, so the ceiling is not decorative", () => {
    const path = catalogFile("ordering", wellFormed);
    fsCalls.length = 0;
    const answer = readerFor(path).argvFor(PROJECT, CAPABILITY);
    expect(answer.ok).toBe(true);
    const onPath = fsCalls.filter((call) => call.endsWith(path));
    // POSITIVE CONTROL first: an empty recording would make the ordering
    // assertion below vacuously true, which is exactly how this guard dies.
    expect(onPath).toHaveLength(2);
    expect(onPath[0]).toBe(`stat:${path}`);
    expect(onPath[1]).toBe(`read:${path}`);
  });

  it("refuses unparseable bytes as UNREADABLE", () => {
    const reader = readerFor(catalogFile("garbage", "{not json"));
    expect(refusalOf(reader.argvFor(PROJECT, CAPABILITY)))
      .toEqual(["VERIFICATION_CATALOG_UNREADABLE", DAEMON_VERIFICATION_CATALOG]);
  });

  it("forwards the decode's own refusal unrestamped", () => {
    const reader = readerFor(catalogFile("malformed", JSON.stringify({ entries: [] })));
    expect(refusalOf(reader.argvFor(PROJECT, CAPABILITY)))
      .toEqual(["VERIFICATION_CATALOG_MALFORMED", DAEMON_VERIFICATION_CATALOG]);
    const bad = readerFor(catalogFile("argv", JSON.stringify({
      catalogVersion: VERIFICATION_CATALOG_VERSION,
      entries: [{
        argv: ["pnpm test"], capability: CAPABILITY, profileRevisionId: REVISION,
        projectId: PROJECT,
      }],
    })));
    expect(refusalOf(bad.argvFor(PROJECT, CAPABILITY)))
      .toEqual(["VERIFICATION_CATALOG_ARGV_INVALID", DAEMON_VERIFICATION_CATALOG]);
  });

  it("keeps an unmentioned project apart from an uncovered capability", () => {
    const reader = readerFor(catalogFile("lookup", wellFormed));
    expect(refusalOf(reader.argvFor("proj-other", CAPABILITY)))
      .toEqual(["VERIFICATION_CATALOG_PROJECT_ABSENT", DAEMON_VERIFICATION_CATALOG]);
    expect(refusalOf(reader.argvFor(PROJECT, "other-capability")))
      .toEqual(["VERIFICATION_CATALOG_ENTRY_ABSENT", DAEMON_VERIFICATION_CATALOG]);
  });

  it("NEVER defaults: no refusing arm yields an argv of any kind", () => {
    const readers = [
      readerFor(undefined), readerFor(catalogFile("d1", "{not json")),
      readerFor(catalogFile("d2", JSON.stringify({ entries: [] }))),
      readerFor(catalogFile("d3", wellFormed)),
    ];
    const answers = [
      readers[0]?.argvFor(PROJECT, CAPABILITY), readers[1]?.argvFor(PROJECT, CAPABILITY),
      readers[2]?.argvFor(PROJECT, CAPABILITY), readers[3]?.argvFor("proj-other", CAPABILITY),
    ];
    for (const answer of answers) {
      expect(answer?.ok).toBe(false);
      expect(answer).not.toHaveProperty("argv");
    }
  });

  it("refuses a catalog file that impersonates a refusal instead of forwarding it", () => {
    // An operator file shaped like this reader's own answer must be decoded as
    // hostile input, never adopted as a verdict naming a code no layer emitted.
    const reader = readerFor(catalogFile("impersonate", JSON.stringify({
      code: "VERIFICATION_CATALOG_FORGED", layer: "SOMEONE_ELSE", ok: false,
    })));
    expect(refusalOf(reader.argvFor(PROJECT, CAPABILITY)))
      .toEqual(["VERIFICATION_CATALOG_MALFORMED", DAEMON_VERIFICATION_CATALOG]);
  });

  it("re-reads on every call, so a corrected catalog takes effect without a restart", () => {
    const path = catalogFile("reread", JSON.stringify({ entries: [] }));
    const reader = readerFor(path);
    expect(refusalOf(reader.argvFor(PROJECT, CAPABILITY))[0])
      .toBe("VERIFICATION_CATALOG_MALFORMED");
    writeFileSync(path, wellFormed);
    expect(reader.argvFor(PROJECT, CAPABILITY).ok).toBe(true);
  });
});
