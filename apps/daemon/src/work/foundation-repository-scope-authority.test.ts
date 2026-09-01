/**
 * The daemon-startup repository/scope catalog authority.
 *
 * TWO LAYERS, AND THE TESTS SAY WHICH ONE ANSWERED. The catalog codec refuses
 * operator configuration under `DAEMON_REPOSITORY_SCOPE_CATALOG`; resolution
 * refuses durable-state facts under `DAEMON_REPOSITORY_SCOPE_RESOLUTION`. With
 * one layer the `layer` field would be a constant and asserting it would prove
 * nothing; the two are asserted separately on every arm so a refusal that
 * migrates between layers reddens rather than passes.
 *
 * NO PATH IS ASSERTED BY REIMPLEMENTING ITS RULE. Every verdict below is the
 * production result, unread and unrederived: the hostile rosters supply INPUT
 * and the expected code/layer tuple, never a recomputed answer.
 */

import { createHash } from "node:crypto";

import type { JsonValue } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { decodeBootstrapRequestBytes } from "../bootstrap/bootstrap-contracts.js";
import { commitAccepted, readDurableLedger, versionOf } from "../bootstrap/bootstrap-ledger.js";
import {
  OBSERVATION, PROJECT_ID, closeStores, envelope, openStore, send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import {
  decodeFoundationRepositoryScopeCatalog, readCurrentFoundationRepositoryScopeRequest,
  resolveFoundationRepositoryScope,
} from "./foundation-repository-scope-authority.js";
import {
  FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION, FOUNDATION_REPOSITORY_SCOPE_CODES,
  FOUNDATION_REPOSITORY_SCOPE_DIGEST_DOMAIN, FOUNDATION_REPOSITORY_SCOPE_LAYERS,
  FOUNDATION_REPOSITORY_SCOPE_LIMITS, digestOf,
} from "./foundation-repository-scope-contracts.js";
import type {
  FoundationRepositoryScopeCatalog, FoundationRepositoryScopeCatalogEntry,
  FoundationRepositoryScopeCatalogResult,
  FoundationRepositoryScopeCode, FoundationRepositoryScopeLayer,
  FoundationRepositoryScopeRequest, FoundationRepositoryScopeResult,
} from "./foundation-repository-scope-contracts.js";

/**
 * Read OUT of the declared vocabulary rather than typed as a literal: a literal
 * stays green when the constant is renamed or a member is dropped, which is the
 * exact drift the layer drill has to catch.
 */
function memberOf<T extends string>(declared: readonly T[], wanted: string): T {
  const found = declared.find((entry) => entry === wanted);
  if (found === undefined) throw new Error(`${wanted} is not declared in the closed vocabulary`);
  return found;
}

const code = (wanted: string): FoundationRepositoryScopeCode =>
  memberOf(FOUNDATION_REPOSITORY_SCOPE_CODES, wanted);
const layer = (wanted: string): FoundationRepositoryScopeLayer =>
  memberOf(FOUNDATION_REPOSITORY_SCOPE_LAYERS, wanted);

const CATALOG_LAYER = layer("DAEMON_REPOSITORY_SCOPE_CATALOG");
const RESOLUTION_LAYER = layer("DAEMON_REPOSITORY_SCOPE_RESOLUTION");

const WINDOWS_ROOT = "D:\\projexts\\moe-next";
const WINDOWS_PARENT = "D:\\projexts\\moe-worktrees";
const POSIX_ROOT = "/srv/moe/moe-next";

function catalogEntry(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    declaredPaths: ["apps/daemon/src", "packages/core/src"],
    projectId: PROJECT_ID,
    repositoryRef: "repo-1",
    scopeRef: "scope-1",
    sourceRepositoryRoot: WINDOWS_ROOT,
    worktreeParent: WINDOWS_PARENT,
    ...overrides,
  };
}

function catalogInput(
  entries: readonly Record<string, unknown>[] = [catalogEntry()],
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return { catalogVersion: FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION, entries, ...overrides };
}

function decodedCatalog(
  entries: readonly Record<string, unknown>[] = [catalogEntry()],
): FoundationRepositoryScopeCatalog {
  const result = decodeFoundationRepositoryScopeCatalog(catalogInput(entries));
  if (!result.ok) throw new Error(`catalog refused: ${result.code}@${result.layer}`);
  return result.catalog;
}

const refusalOf = (result: FoundationRepositoryScopeCatalogResult): readonly string[] =>
  result.ok ? ["ACCEPTED", "ACCEPTED"] : [result.code, result.layer];

const refuses = (input: unknown, expected: string, expectedLayer = CATALOG_LAYER): void => {
  expect(refusalOf(decodeFoundationRepositoryScopeCatalog(input)))
    .toEqual([code(expected), expectedLayer]);
};

describe("the catalog codec admits exactly one versioned field set", () => {
  it("accepts one entry, sorts its declared paths and seals a digest over them", () => {
    const catalog = decodedCatalog([catalogEntry({
      declaredPaths: ["packages/core/src", "apps/daemon/src", "tools"],
    })]);
    const [entry] = catalog.entries;
    expect(entry?.declaredPaths).toEqual(["apps/daemon/src", "packages/core/src", "tools"]);
    expect([catalog.catalogVersion, catalog.digest]).toEqual([
      FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION, expect.stringMatching(/^[0-9a-f]{64}$/u),
    ]);
    expect([Object.isFrozen(catalog), Object.isFrozen(catalog.entries),
      Object.isFrozen(entry), Object.isFrozen(entry?.declaredPaths)])
      .toEqual([true, true, true, true]);
  });

  it("accepts a POSIX host root as readily as a Windows one", () => {
    const catalog = decodedCatalog([catalogEntry({
      sourceRepositoryRoot: POSIX_ROOT, worktreeParent: "/srv/moe/worktrees",
    })]);
    expect(catalog.entries[0]?.sourceRepositoryRoot).toBe(POSIX_ROOT);
  });

  it("is order-insensitive over entries but not over their content", () => {
    const first = catalogEntry({ scopeRef: "scope-a" });
    const second = catalogEntry({ scopeRef: "scope-b" });
    expect(decodedCatalog([first, second]).digest).toBe(decodedCatalog([second, first]).digest);
    expect(decodedCatalog([first]).digest).not.toBe(decodedCatalog([second]).digest);
  });

  it("derives its digest under a domain tag over the whole admitted field set", () => {
    const catalog = decodedCatalog();
    const entry = catalog.entries[0];
    if (entry === undefined) throw new Error("the accepted control lost its entry");
    const preimage = JSON.stringify([
      FOUNDATION_REPOSITORY_SCOPE_DIGEST_DOMAIN, FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION,
      [[entry.projectId, entry.repositoryRef, entry.scopeRef, entry.sourceRepositoryRoot,
        entry.worktreeParent, [...entry.declaredPaths]]],
    ]);
    expect(catalog.digest).toBe(createHash("sha256").update(preimage, "utf8").digest("hex"));
  });

  /**
   * The field-coverage proof for "a digest over EVERY admitted field". Each row
   * varies exactly ONE field of the accepted control, so a digest preimage that
   * dropped that field would leave the two digests equal and redden BY NAME.
   */
  const DIGEST_FIELDS: readonly (readonly [string, unknown])[] = Object.freeze([
    ["projectId", "project-2"], ["repositoryRef", "repo-2"], ["scopeRef", "scope-2"],
    ["sourceRepositoryRoot", "D:\\projexts\\other"], ["worktreeParent", "D:\\projexts\\other-wt"],
    ["declaredPaths", ["apps/daemon/src", "packages/core/src", "tools"]],
  ]);

  it("moves its digest when any single admitted field moves", () => {
    expect(DIGEST_FIELDS.length).toBe(6);
    const baseline = decodedCatalog().digest;
    expect(DIGEST_FIELDS.map(([field, value]) =>
      `${field}:${decodedCatalog([catalogEntry({ [field]: value })]).digest === baseline}`))
      .toEqual(DIGEST_FIELDS.map(([field]) => `${field}:false`));
  });
});

describe("the catalog codec refuses hostile configuration with an exact code and layer", () => {
  it("refuses a shape that is not the one versioned field set", () => {
    refuses(null, "FOUNDATION_REPOSITORY_SCOPE_CATALOG_MALFORMED");
    refuses([], "FOUNDATION_REPOSITORY_SCOPE_CATALOG_MALFORMED");
    refuses(catalogInput([], { extra: 1 }), "FOUNDATION_REPOSITORY_SCOPE_CATALOG_MALFORMED");
    refuses({ catalogVersion: FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION },
      "FOUNDATION_REPOSITORY_SCOPE_CATALOG_MALFORMED");
    refuses(catalogInput([catalogEntry()], { catalogVersion: "moe-repository-scope-catalog/2" }),
      "FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION_UNSUPPORTED");
    refuses(catalogInput([]), "FOUNDATION_REPOSITORY_SCOPE_CATALOG_MALFORMED");
  });

  it("refuses an entry whose own field set is wrong", () => {
    refuses(catalogInput([{ ...catalogEntry(), extra: 1 }]),
      "FOUNDATION_REPOSITORY_SCOPE_ENTRY_MALFORMED");
    refuses(catalogInput([catalogEntry({ projectId: "" })]),
      "FOUNDATION_REPOSITORY_SCOPE_ENTRY_MALFORMED");
    refuses(catalogInput([catalogEntry({ repositoryRef: 7 })]),
      "FOUNDATION_REPOSITORY_SCOPE_ENTRY_MALFORMED");
    refuses(catalogInput([catalogEntry({ declaredPaths: "apps/daemon/src" })]),
      "FOUNDATION_REPOSITORY_SCOPE_ENTRY_MALFORMED");
    refuses(catalogInput([catalogEntry({ declaredPaths: [] })]),
      "FOUNDATION_REPOSITORY_SCOPE_ENTRY_MALFORMED");
  });

  it("refuses a second entry under an identical (project, repository, scope) key", () => {
    refuses(catalogInput([catalogEntry(), catalogEntry({ sourceRepositoryRoot: POSIX_ROOT })]),
      "FOUNDATION_REPOSITORY_SCOPE_ENTRY_DUPLICATE");
  });

  it("admits neighbours of the duplicate key, so the key is the WHOLE triple", () => {
    expect(decodedCatalog([
      catalogEntry(), catalogEntry({ scopeRef: "scope-2" }),
      catalogEntry({ repositoryRef: "repo-2" }), catalogEntry({ projectId: "project-2" }),
    ]).entries.length).toBe(4);
  });

  it("refuses input past each published ceiling", () => {
    const entries = Array.from({ length: FOUNDATION_REPOSITORY_SCOPE_LIMITS.entries + 1 },
      (_unused, index) => catalogEntry({ scopeRef: `scope-${index}` }));
    refuses(catalogInput(entries), "FOUNDATION_REPOSITORY_SCOPE_LIMIT_EXCEEDED");
    const paths = Array.from({ length: FOUNDATION_REPOSITORY_SCOPE_LIMITS.declaredPaths + 1 },
      (_unused, index) => `apps/daemon/src/f${index}`);
    refuses(catalogInput([catalogEntry({ declaredPaths: paths })]),
      "FOUNDATION_REPOSITORY_SCOPE_LIMIT_EXCEEDED");
    refuses(catalogInput([catalogEntry({
      repositoryRef: "r".repeat(FOUNDATION_REPOSITORY_SCOPE_LIMITS.refChars + 1),
    })]), "FOUNDATION_REPOSITORY_SCOPE_ENTRY_MALFORMED");
    expect(entries.length).toBeGreaterThan(1);
  });

  it("refuses two declared paths that a case-folding filesystem cannot tell apart", () => {
    refuses(catalogInput([catalogEntry({ declaredPaths: ["apps/Daemon/src", "apps/daemon/src"] })]),
      "FOUNDATION_REPOSITORY_SCOPE_PATH_CASE_COLLISION");
    refuses(catalogInput([catalogEntry({ declaredPaths: ["tools", "tools"] })]),
      "FOUNDATION_REPOSITORY_SCOPE_PATH_CASE_COLLISION");
  });

  it("reads its own data descriptors once, so an accessor cannot answer twice", () => {
    const entry = catalogEntry();
    let reads = 0;
    Object.defineProperty(entry, "sourceRepositoryRoot", {
      configurable: true, enumerable: true,
      get: () => (reads += 1) === 1 ? WINDOWS_ROOT : "D:\\projexts\\swapped",
    });
    refuses(catalogInput([entry]), "FOUNDATION_REPOSITORY_SCOPE_CATALOG_ACCESSOR");
    const outer: Record<string, unknown> = { entries: [catalogEntry()] };
    Object.defineProperty(outer, "catalogVersion", {
      configurable: true, enumerable: true,
      get: () => FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION,
    });
    refuses(outer, "FOUNDATION_REPOSITORY_SCOPE_CATALOG_ACCESSOR");
  });

  it("never invokes hostile nested array reads and returns the exact frozen refusal", () => {
    let reads = 0;
    const throwingGet = {
      get(): never {
        reads += 1;
        throw new Error("nested array value was read");
      },
    };
    const proxyEntries = new Proxy([catalogEntry()], throwingGet);
    const accessorEntries = [catalogEntry()];
    Object.defineProperty(accessorEntries, "0", {
      configurable: true,
      enumerable: true,
      get: throwingGet.get,
    });
    const proxyPaths = new Proxy(["apps/daemon/src"], throwingGet);
    const accessorPaths = ["apps/daemon/src"];
    Object.defineProperty(accessorPaths, "0", {
      configurable: true,
      enumerable: true,
      get: throwingGet.get,
    });

    const results = [
      decodeFoundationRepositoryScopeCatalog(catalogInput(proxyEntries)),
      decodeFoundationRepositoryScopeCatalog(catalogInput(accessorEntries)),
      decodeFoundationRepositoryScopeCatalog(catalogInput([
        catalogEntry({ declaredPaths: proxyPaths }),
      ])),
      decodeFoundationRepositoryScopeCatalog(catalogInput([
        catalogEntry({ declaredPaths: accessorPaths }),
      ])),
    ];

    expect(results.map(refusalOf)).toStrictEqual(Array.from({ length: 4 }, () => [
      code("FOUNDATION_REPOSITORY_SCOPE_CATALOG_ACCESSOR"), CATALOG_LAYER,
    ]));
    expect(results.every(Object.isFrozen)).toBe(true);
    expect(reads).toBe(0);
  });

  it("contains revoked proxies at every nested catalog boundary", () => {
    const revoked = <T extends object>(target: T): T => {
      const handle = Proxy.revocable(target, {});
      handle.revoke();
      return handle.proxy;
    };
    const results = [
      decodeFoundationRepositoryScopeCatalog(revoked(catalogInput())),
      decodeFoundationRepositoryScopeCatalog(catalogInput([
        revoked(catalogEntry()),
      ])),
      decodeFoundationRepositoryScopeCatalog(catalogInput(
        revoked([catalogEntry()]),
      )),
      decodeFoundationRepositoryScopeCatalog(catalogInput([
        catalogEntry({ declaredPaths: revoked(["apps/daemon/src"]) }),
      ])),
    ];

    expect(results.map(refusalOf)).toStrictEqual(Array.from({ length: 4 }, () => [
      code("FOUNDATION_REPOSITORY_SCOPE_CATALOG_ACCESSOR"), CATALOG_LAYER,
    ]));
    expect(results.every(Object.isFrozen)).toBe(true);
  });
});

/**
 * Repository-relative declared paths. The rules are transcribed daemon-side from
 * the runner's canonical fence rather than deep-imported, and every row is a
 * form a filesystem could reinterpret into a different file than the one named.
 */
const HOSTILE_PATHS: readonly (readonly [string, string])[] = Object.freeze([
  ["empty", ""],
  ["over-length", `apps/${"a".repeat(FOUNDATION_REPOSITORY_SCOPE_LIMITS.pathChars)}`],
  ["backslash separator", "apps\\daemon"],
  ["drive qualified", "C:/apps/daemon"],
  ["rooted", "/apps/daemon"],
  ["empty segment", "apps//daemon"],
  ["dot segment", "apps/./daemon"],
  ["parent segment", "apps/../daemon"],
  ["trailing dot", "apps/daemon."],
  ["trailing space", "apps/daemon "],
  ["reserved device", "apps/con"],
  ["reserved device with suffix", "apps/nul.txt"],
  ["decomposed rather than NFC", "apps/cafe\u0301"],
  ["lone surrogate", "apps/\uD800"],
]);

/**
 * Host roots. `worktreeParent` is swept with the same roster as
 * `sourceRepositoryRoot`: two fields validated by one rule drift apart the day
 * only one of them is swept.
 */
const HOSTILE_HOST_ROOTS: readonly (readonly [string, string])[] = Object.freeze([
  ["empty", ""],
  ["relative", "projexts/moe-next"],
  ["bare drive", "C:"],
  ["drive relative", "C:projexts"],
  ["device namespace", "\\\\?\\D:\\projexts"],
  ["device dot namespace", "\\\\.\\pipe\\moe"],
  ["UNC share", "\\\\server\\share\\moe"],
  ["mixed separators", "D:/projexts/moe-next"],
  ["trailing separator", "D:\\projexts\\moe-next\\"],
  ["parent segment", "D:\\projexts\\..\\moe-next"],
  ["reserved device segment", "D:\\projexts\\con"],
  ["trailing space segment", "D:\\projexts\\moe "],
  ["POSIX parent segment", "/srv/moe/../etc"],
  ["POSIX trailing separator", "/srv/moe/"],
  ["over-length", `D:\\${"a".repeat(FOUNDATION_REPOSITORY_SCOPE_LIMITS.hostRootChars)}`],
  ["decomposed rather than NFC", "D:\\projexts\\cafe\u0301"],
]);

describe("the catalog codec fences every host path form without shell normalization", () => {
  it("refuses every hostile declared path under one stable code", () => {
    expect(HOSTILE_PATHS.length).toBeGreaterThan(0);
    expect(HOSTILE_PATHS.map(([name, path]) => [name, ...refusalOf(
      decodeFoundationRepositoryScopeCatalog(catalogInput([catalogEntry({
        declaredPaths: [path],
      })])),
    )])).toEqual(HOSTILE_PATHS.map(([name]) =>
      [name, code("FOUNDATION_REPOSITORY_SCOPE_PATH_NONCANONICAL"), CATALOG_LAYER]));
  });

  it("refuses every hostile host root on BOTH root fields", () => {
    expect(HOSTILE_HOST_ROOTS.length).toBeGreaterThan(0);
    const sweep = (field: string): readonly unknown[] =>
      HOSTILE_HOST_ROOTS.map(([name, root]) => [name, ...refusalOf(
        decodeFoundationRepositoryScopeCatalog(catalogInput([catalogEntry({ [field]: root })])),
      )]);
    const expected = HOSTILE_HOST_ROOTS.map(([name]) =>
      [name, code("FOUNDATION_REPOSITORY_SCOPE_HOST_ROOT_INVALID"), CATALOG_LAYER]);
    expect(sweep("sourceRepositoryRoot")).toEqual(expected);
    expect(sweep("worktreeParent")).toEqual(expected);
  });
});

/**
 * Resolution, driven against a REAL `SqliteEventStore` carrying real durable
 * decisions from the production bootstrap command path — never a stubbed reader.
 *
 * TWO CONDITIONS ARE REACHED THROUGH `commitAccepted`, the same seam every
 * bootstrap handler commits through. That is deliberate and it is not a raw
 * database write: a committed result the project validator refuses, and one
 * whose own `projectId` disagrees with the aggregate it was filed under, are
 * exactly what a drifted or mis-keyed handler produces — and `bindRepository`
 * casts its observation unchecked today, so neither is hypothetical. Every other
 * arm below is driven by ordinary commands.
 */

function registered(): SqliteEventStore {
  const store = openStore();
  const accepted = send(store, envelope("project.register", 0, { owner: "owner-1" }));
  if (!accepted.ok) throw new Error(`fixture register refused: ${accepted.code}`);
  return store;
}

function bindOnto(
  store: SqliteEventStore, observation: Readonly<Record<string, unknown>>, commandId: string,
): void {
  const version = versionOf(readDurableLedger(store, PROJECT_ID), PROJECT_ID);
  const accepted = send(store,
    envelope("project.bind_repository", version, { observation }, commandId));
  if (!accepted.ok) throw new Error(`fixture bind refused: ${accepted.code}`);
}

function bound(): SqliteEventStore {
  const store = registered();
  bindOnto(store, OBSERVATION, "cmd-bind-1");
  return store;
}

/** Commits `result` for the project aggregate through the production seam. */
function plant(store: SqliteEventStore, result: unknown, tag: string): void {
  const expectedVersion = versionOf(readDurableLedger(store, PROJECT_ID), PROJECT_ID);
  const decoded = decodeBootstrapRequestBytes(new TextEncoder().encode(JSON.stringify(
    envelope("project.bind_repository", expectedVersion, { observation: OBSERVATION },
      `cmd-plant-${tag}`),
  )));
  if (!decoded.ok) throw new Error(`fixture envelope refused: ${decoded.code}`);
  const outcome = commitAccepted(store, decoded.request, {
    aggregateId: PROJECT_ID, eventPayload: null, eventType: "RepositoryBound",
    expectedVersion, result: result as JsonValue,
  });
  if (!outcome.ok) throw new Error(`fixture plant refused: ${outcome.code}`);
}

const projectStateWith = (
  observations: readonly unknown[], projectId: string = PROJECT_ID,
): Record<string, unknown> => ({
  lifecycle: "BOOTSTRAPPING", owner: "owner-1", projectId, recoveryRequired: false,
  repositoryObservations: observations, version: 9,
});

const request = (overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> => ({
  baseRevisionHash: OBSERVATION.baseRevisionHash, projectId: PROJECT_ID,
  repositoryRef: OBSERVATION.repositoryRef, scopeRef: OBSERVATION.scopeRef, ...overrides,
});

const resolutionOf = (result: FoundationRepositoryScopeResult): readonly string[] =>
  result.ok ? ["ACCEPTED", "ACCEPTED"] : [result.code, result.layer];

const currentRequestOf = (
  result: ReturnType<typeof readCurrentFoundationRepositoryScopeRequest>,
): readonly string[] => result.ok ? ["ACCEPTED", "ACCEPTED"] : [result.code, result.layer];

afterEach(() => { closeStores(); });

describe("current repository-scope request derivation", () => {
  it("returns only the final durable repository identity, deeply frozen", () => {
    const store = bound();
    const current = Object.freeze({
      ...OBSERVATION,
      baseRevisionHash: "f".repeat(64),
      repositoryRef: "repo-current",
      scopeRef: "scope-current",
    });
    bindOnto(store, current, "cmd-bind-current");

    const result = readCurrentFoundationRepositoryScopeRequest(store, PROJECT_ID);
    if (!result.ok) throw new Error(`unexpected refusal ${result.code}@${result.layer}`);
    expect(result.request).toStrictEqual({
      baseRevisionHash: current.baseRevisionHash,
      projectId: PROJECT_ID,
      repositoryRef: current.repositoryRef,
      scopeRef: current.scopeRef,
    });
    expect([Object.isFrozen(result), Object.isFrozen(result.request)])
      .toStrictEqual([true, true]);
    expect(Object.keys(result.request).sort()).toStrictEqual([
      "baseRevisionHash", "projectId", "repositoryRef", "scopeRef",
    ]);
  });

  it("refuses malformed, absent, unreadable, invalid, misfiled, and unbound state exactly", () => {
    const unreadable = bound();
    unreadable.close();
    const invalid = bound();
    plant(invalid, { lifecycle: "BOOTSTRAPPING", repositoryObservations: [OBSERVATION] },
      "current-invalid");
    const misfiled = bound();
    plant(misfiled, projectStateWith([OBSERVATION], "project-2"), "current-misfiled");
    const cases = [
      ["malformed", readCurrentFoundationRepositoryScopeRequest(openStore(), ""),
        "FOUNDATION_REPOSITORY_SCOPE_REQUEST_MALFORMED"],
      ["absent", readCurrentFoundationRepositoryScopeRequest(openStore(), PROJECT_ID),
        "FOUNDATION_REPOSITORY_SCOPE_PROJECT_STATE_ABSENT"],
      ["unreadable", readCurrentFoundationRepositoryScopeRequest(unreadable, PROJECT_ID),
        "FOUNDATION_REPOSITORY_SCOPE_PROJECT_STATE_UNREADABLE"],
      ["invalid", readCurrentFoundationRepositoryScopeRequest(invalid, PROJECT_ID),
        "FOUNDATION_REPOSITORY_SCOPE_PROJECT_STATE_INVALID"],
      ["misfiled", readCurrentFoundationRepositoryScopeRequest(misfiled, PROJECT_ID),
        "FOUNDATION_REPOSITORY_SCOPE_PROJECT_MISMATCH"],
      ["unbound", readCurrentFoundationRepositoryScopeRequest(registered(), PROJECT_ID),
        "FOUNDATION_REPOSITORY_SCOPE_OBSERVATION_ABSENT"],
    ] as const;
    expect(cases.map(([name, result]) => [name, ...currentRequestOf(result)]))
      .toStrictEqual(cases.map(([name, , expected]) => [name, code(expected), RESOLUTION_LAYER]));
  });
});

describe("resolution reads durable project state and refuses distinctly", () => {
  it("returns catalog-owned host facts beside durable identities, deep-frozen", () => {
    const catalog = decodedCatalog();
    const result = resolveFoundationRepositoryScope(bound(), catalog, request());
    if (!result.ok) throw new Error(`unexpected refusal ${result.code}@${result.layer}`);
    expect(result.authority).toEqual({
      baseRevisionHash: OBSERVATION.baseRevisionHash,
      catalogDigest: catalog.digest,
      declaredPaths: ["apps/daemon/src", "packages/core/src"],
      projectId: PROJECT_ID, repositoryRef: "repo-1", scopeRef: "scope-1",
      sourceRepositoryRoot: WINDOWS_ROOT, worktreeParent: WINDOWS_PARENT,
    });
    expect([Object.isFrozen(result), Object.isFrozen(result.authority),
      Object.isFrozen(result.authority.declaredPaths)]).toEqual([true, true, true]);
  });

  it("selects the FINAL repository observation as current, never an earlier match", () => {
    const store = bound();
    bindOnto(store, { ...OBSERVATION, repositoryRef: "repo-2", scopeRef: "scope-2" }, "cmd-bind-2");
    const catalog = decodedCatalog([
      catalogEntry(), catalogEntry({ repositoryRef: "repo-2", scopeRef: "scope-2" }),
    ]);
    expect(resolutionOf(resolveFoundationRepositoryScope(store, catalog,
      request({ repositoryRef: "repo-2", scopeRef: "scope-2" }))))
      .toEqual(["ACCEPTED", "ACCEPTED"]);
    // The SUPERSEDED first bind is still in the durable array and still carries
    // its own catalog entry, so only the current-rule can refuse it.
    expect(resolutionOf(resolveFoundationRepositoryScope(store, catalog, request())))
      .toEqual([code("FOUNDATION_REPOSITORY_SCOPE_REPOSITORY_MISMATCH"), RESOLUTION_LAYER]);
  });

  it("is deterministic over identical store bytes and catalog", () => {
    const store = bound();
    const catalog = decodedCatalog();
    expect(JSON.stringify(resolveFoundationRepositoryScope(store, catalog, request())))
      .toBe(JSON.stringify(resolveFoundationRepositoryScope(store, catalog, request())));
  });

  it("reads a thousand-observation history without losing the current entry", () => {
    const store = bound();
    plant(store, projectStateWith([
      ...Array.from({ length: 1_200 }, (_unused, index) => ({
        ...OBSERVATION, repositoryRef: `repo-old-${index}`, scopeRef: `scope-old-${index}`,
      })),
      { ...OBSERVATION },
    ]), "bulk");
    expect(resolutionOf(resolveFoundationRepositoryScope(store, decodedCatalog(), request())))
      .toEqual(["ACCEPTED", "ACCEPTED"]);
  });

  it("refuses when the project has no durable state at all", () => {
    expect(resolutionOf(resolveFoundationRepositoryScope(openStore(), decodedCatalog(), request())))
      .toEqual([code("FOUNDATION_REPOSITORY_SCOPE_PROJECT_STATE_ABSENT"), RESOLUTION_LAYER]);
  });

  it("refuses an unreadable store as UNKNOWN rather than as an absent project", () => {
    const store = bound();
    store.close();
    expect(resolutionOf(resolveFoundationRepositoryScope(store, decodedCatalog(), request())))
      .toEqual([code("FOUNDATION_REPOSITORY_SCOPE_PROJECT_STATE_UNREADABLE"), RESOLUTION_LAYER]);
  });

  it("refuses committed bytes the project validator rejects, with no fallback", () => {
    const store = bound();
    plant(store, { lifecycle: "BOOTSTRAPPING", repositoryObservations: [OBSERVATION] }, "corrupt");
    expect(resolutionOf(resolveFoundationRepositoryScope(store, decodedCatalog(), request())))
      .toEqual([code("FOUNDATION_REPOSITORY_SCOPE_PROJECT_STATE_INVALID"), RESOLUTION_LAYER]);
  });

  it("refuses a registered project that was never bound", () => {
    expect(resolutionOf(resolveFoundationRepositoryScope(registered(), decodedCatalog(), request())))
      .toEqual([code("FOUNDATION_REPOSITORY_SCOPE_OBSERVATION_ABSENT"), RESOLUTION_LAYER]);
  });

  it("refuses state filed under one project that names another", () => {
    const store = bound();
    plant(store, projectStateWith([OBSERVATION], "project-2"), "misfiled");
    expect(resolutionOf(resolveFoundationRepositoryScope(store, decodedCatalog(), request())))
      .toEqual([code("FOUNDATION_REPOSITORY_SCOPE_PROJECT_MISMATCH"), RESOLUTION_LAYER]);
  });
});

/**
 * One field varies per row. A case that moved two at once could be answered by
 * either guard and would keep passing after one of them was deleted.
 */
const IDENTITY_MISMATCHES: readonly (readonly [string, Record<string, unknown>, string])[] =
  Object.freeze([
    ["repositoryRef", { repositoryRef: "repo-9" },
      "FOUNDATION_REPOSITORY_SCOPE_REPOSITORY_MISMATCH"],
    ["scopeRef", { scopeRef: "scope-9" }, "FOUNDATION_REPOSITORY_SCOPE_SCOPE_MISMATCH"],
    ["baseRevisionHash", { baseRevisionHash: "f".repeat(64) },
      "FOUNDATION_REPOSITORY_SCOPE_BASE_REVISION_MISMATCH"],
  ]);

/** Every physical fact a caller might try to smuggle in. All are extra keys. */
const FORBIDDEN_REQUEST_FIELDS: readonly string[] = Object.freeze([
  "changedPaths", "cwd", "declaredPaths", "launchTemplate", "sourceRepositoryRoot",
  "workspace", "worktreeParent", "worktreeRoot",
]);

describe("resolution refuses every identity drift and every smuggled host fact", () => {
  it("names the drifted field, one field at a time", () => {
    expect(IDENTITY_MISMATCHES.length).toBe(3);
    const store = bound();
    // Each varied ref also has its own catalog entry, so an absent entry can
    // never be what answers here.
    const catalog = decodedCatalog([
      catalogEntry(), catalogEntry({ repositoryRef: "repo-9" }),
      catalogEntry({ scopeRef: "scope-9" }),
    ]);
    expect(IDENTITY_MISMATCHES.map(([field, override]) => [field, ...resolutionOf(
      resolveFoundationRepositoryScope(store, catalog, request(override)),
    )])).toEqual(IDENTITY_MISMATCHES.map(([field, , expected]) =>
      [field, code(expected), RESOLUTION_LAYER]));
  });

  it("refuses when the durable identity is current but the catalog does not carry it", () => {
    const catalog = decodedCatalog([catalogEntry({ scopeRef: "scope-elsewhere" })]);
    expect(resolutionOf(resolveFoundationRepositoryScope(bound(), catalog, request())))
      .toEqual([code("FOUNDATION_REPOSITORY_SCOPE_ENTRY_ABSENT"), RESOLUTION_LAYER]);
  });

  it("refuses a catalog whose sealed digest no longer covers its entries", () => {
    const sealed = decodedCatalog();
    const tampered: FoundationRepositoryScopeCatalog = {
      ...sealed,
      entries: sealed.entries.map((entry) => ({
        ...entry, sourceRepositoryRoot: "D:\\projexts\\swapped",
      })),
    };
    expect(resolutionOf(resolveFoundationRepositoryScope(bound(), tampered, request())))
      .toEqual([code("FOUNDATION_REPOSITORY_SCOPE_CATALOG_DIGEST_MISMATCH"), RESOLUTION_LAYER]);
  });

  it("refuses every host fact a caller might attach to the request", () => {
    expect(FORBIDDEN_REQUEST_FIELDS.length).toBeGreaterThan(0);
    const store = bound();
    const catalog = decodedCatalog();
    expect(FORBIDDEN_REQUEST_FIELDS.map((field) => [field, ...resolutionOf(
      resolveFoundationRepositoryScope(store, catalog,
        request({ [field]: "D:\\projexts\\moe-next" })),
    )])).toEqual(FORBIDDEN_REQUEST_FIELDS.map((field) =>
      [field, code("FOUNDATION_REPOSITORY_SCOPE_REQUEST_MALFORMED"), RESOLUTION_LAYER]));
  });

  it("refuses a request that is not the exact four-ref identity", () => {
    const store = bound();
    const catalog = decodedCatalog();
    const refused = [code("FOUNDATION_REPOSITORY_SCOPE_REQUEST_MALFORMED"), RESOLUTION_LAYER];
    const { scopeRef: _dropped, ...missing } = request();
    expect([
      resolutionOf(resolveFoundationRepositoryScope(store, catalog, null)),
      resolutionOf(resolveFoundationRepositoryScope(store, catalog, missing)),
      resolutionOf(resolveFoundationRepositoryScope(store, catalog, request({ scopeRef: 7 }))),
    ]).toEqual([refused, refused, refused]);
  });

  /**
   * A catalog that never went through the codec, RESEALED through the published
   * `digestOf` so its seal is genuine. The digest proves internal consistency,
   * never canonicality, so each row below is answered by a guard at the point of
   * RETURN rather than by the seal — which is exactly what these three assert.
   */
  const resealed = (
    entries: readonly FoundationRepositoryScopeCatalogEntry[],
  ): FoundationRepositoryScopeCatalog => {
    const catalogVersion = FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION;
    return { catalogVersion, digest: digestOf({ catalogVersion, entries }), entries };
  };

  const soleEntry = (): FoundationRepositoryScopeCatalogEntry => {
    const entry = decodedCatalog().entries[0];
    if (entry === undefined) throw new Error("the accepted control lost its entry");
    return entry;
  };

  it("refuses an uncodec'd catalog that carries the requested triple twice", () => {
    const catalog = resealed([soleEntry(), { ...soleEntry(), worktreeParent: POSIX_ROOT }]);
    // The seal is genuine, so only an ambiguity guard at selection can answer.
    expect(digestOf(catalog)).toBe(catalog.digest);
    expect(resolutionOf(resolveFoundationRepositoryScope(bound(), catalog, request())))
      .toEqual([code("FOUNDATION_REPOSITORY_SCOPE_ENTRY_DUPLICATE"), RESOLUTION_LAYER]);
  });

  it("refuses to hand back a host root the codec would never have admitted", () => {
    const catalog = resealed([{ ...soleEntry(), worktreeParent: "\\\\server\\share\\moe" }]);
    expect(digestOf(catalog)).toBe(catalog.digest);
    expect(resolutionOf(resolveFoundationRepositoryScope(bound(), catalog, request())))
      .toEqual([code("FOUNDATION_REPOSITORY_SCOPE_HOST_ROOT_INVALID"), RESOLUTION_LAYER]);
  });

  it("refuses to hand back a declared path the codec would never have admitted", () => {
    const catalog = resealed([{ ...soleEntry(), declaredPaths: ["apps/../etc"] }]);
    expect(digestOf(catalog)).toBe(catalog.digest);
    expect(resolutionOf(resolveFoundationRepositoryScope(bound(), catalog, request())))
      .toEqual([code("FOUNDATION_REPOSITORY_SCOPE_PATH_NONCANONICAL"), RESOLUTION_LAYER]);
  });

  /**
   * The type-level half of "unrepresentable as inputs". `@ts-expect-error` fails
   * the DAEMON TYPECHECK if the excess property ever becomes legal, which is the
   * only guard that can see a field being ADDED to the request contract.
   */
  it("cannot even name a host root in a typed request", () => {
    const unrepresentable: FoundationRepositoryScopeRequest = {
      baseRevisionHash: OBSERVATION.baseRevisionHash, projectId: PROJECT_ID,
      repositoryRef: "repo-1", scopeRef: "scope-1",
      // @ts-expect-error the request contract has no host-path field to supply
      worktreeRoot: WINDOWS_ROOT,
    };
    expect(Object.keys(unrepresentable)).toContain("worktreeRoot");
  });
});
