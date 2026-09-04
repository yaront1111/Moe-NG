import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ACTIVATION_READ_PATH } from "./activation-read.js";
import { JSON_ROUTES } from "./http-listener-read-dispatch.js";
import { REPOSITORY_REMOTE_READ_PATH } from "./repository-remote-read.js";

/**
 * task-0a5d7212: the read-route roster, asserted BIDIRECTIONALLY (global rail 9).
 *
 * A test that iterates `JSON_ROUTES` alone can only see one direction: deleting an entry
 * shrinks its own iteration and stays green while a served path silently vanishes from the
 * advertised surface. So the SERVED set is enumerated from the DISPATCH SEAM itself — the
 * `path === X` branches and method guards in the dispatcher's source — and compared for set
 * EQUALITY with the declared roster, not for subset.
 *
 * Identifiers, not values: the dispatcher names each path by an imported constant, and the
 * identifier is what the seam actually contains. A value-based scan would have to re-resolve
 * 25 imports and would go blind the moment a constant were renamed.
 */

const DISPATCH_SOURCE = fileURLToPath(new URL("http-listener-read-dispatch.ts", import.meta.url));
const DEV_PROXY_SOURCE = fileURLToPath(
  new URL("../../../control-room/src/live/dev-proxy-paths.ts", import.meta.url),
);

const dispatchSource = (): string => readFileSync(DISPATCH_SOURCE, "utf8");

/** The identifiers listed INSIDE the `JSON_ROUTES` array literal, read as source text. */
function rosterIdentifiers(source: string): ReadonlySet<string> {
  const start = source.indexOf("export const JSON_ROUTES");
  const end = source.indexOf("]);", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return new Set(
    [...source.slice(start, end).matchAll(/^ {2}([A-Z][A-Z0-9_]*),$/gmu)].map((hit) => hit[1] ?? ""),
  );
}

/** Every `path === X` in the DISPATCH CHAIN, i.e. after the body is read. */
function branchIdentifiers(source: string): ReadonlySet<string> {
  const chain = source.slice(source.indexOf("const body = await readBoundedBody"));
  return new Set([...chain.matchAll(/path === ([A-Z][A-Z0-9_]*)/gu)].map((hit) => hit[1] ?? ""));
}

/** Every `path === X && request.method !== "POST"` guard, wherever it sits. */
function guardIdentifiers(source: string): ReadonlySet<string> {
  return new Set(
    [...source.matchAll(/path === ([A-Z][A-Z0-9_]*) && request\.method/gu)].map((hit) => hit[1] ?? ""),
  );
}

const sorted = (values: Iterable<string>): readonly string[] => [...values].sort();

/**
 * The ONE roster member with no `path === ` branch of its own: the chain's final
 * `else serveDocumentDossier(...)` IS its branch. Asserted as source text below, so turning
 * that else into a conditional — leaving the roster with a member nothing serves — reds here.
 */
const UNCONDITIONAL_ELSE_MEMBER = "DOCUMENT_DOSSIER_PATH";

/**
 * Roster members with no non-POST guard in THIS file. A frozen census, not a subset check:
 * the command and event-stream routes accept methods this dispatcher does not police, and a
 * NEW read landing without a guard would accept a GET. Adding a read without its guard reds.
 */
const UNGUARDED_MEMBERS: readonly string[] = Object.freeze([
  "AFFORDANCE_PATH", "COMMAND_PATH", "EVENT_ACKNOWLEDGE_PATH", "EVENT_PAGE_PATH",
  "EVENT_RESUME_PATH", "GRAPH_GET_PATH",
]);

/** The string literals inside the control-room's `DEV_PROXY_PATHS`, read as source text. */
function proxiedPaths(): ReadonlySet<string> {
  const source = readFileSync(DEV_PROXY_SOURCE, "utf8");
  const start = source.indexOf("export const DEV_PROXY_PATHS");
  const end = source.indexOf("] as const)", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return new Set(
    [...source.slice(start, end).matchAll(/"(\/[^"]*)"/gu)].map((hit) => hit[1] ?? ""),
  );
}

/**
 * Daemon JSON routes the dev server does NOT proxy. A frozen census so the gap cannot grow
 * silently: `/product-contract/gate-1/read` predates this row and is recorded, not fixed,
 * because this row does not own that route. A route absent from the proxy works in
 * production and fails only under the dev server, which is where the e2e lane runs.
 *
 * `/repository/remote/read` is recorded here by task-9d553419, which lands the daemon route
 * only: the proxy list lives in the control-room package and belongs to task-e6000b57, which
 * lands the decoder and the proxy pins together. Recording it keeps the census exact instead
 * of letting the arm below go subset-shaped, and REMOVING this line is what that row's proxy
 * edit has to do — a census entry that outlives its gap reds here.
 */
const UNPROXIED_SERVED_PATHS: readonly string[] = Object.freeze([
  "/product-contract/gate-1/read", "/repository/remote/read",
]);

describe("the read-route roster and the surface it advertises agree in BOTH directions", () => {
  it("serves exactly what it advertises: dispatch seam == JSON_ROUTES, as sets", () => {
    const source = dispatchSource();
    const roster = rosterIdentifiers(source);
    const branches = branchIdentifiers(source);

    // Enumerated from the SEAM, then unioned with the one member the unconditional else
    // serves. Set EQUALITY, so both failure directions bite: a roster entry with no branch
    // (404-by-fallthrough) and a branch with no roster entry (never reached at all).
    const served = new Set([...branches, UNCONDITIONAL_ELSE_MEMBER]);
    expect(sorted(served)).toStrictEqual(sorted(roster));
    expect(roster.size).toBe(26);
    // The else really is unconditional. If it becomes `else if`, the union above would be a
    // lie and this line is what catches it.
    expect(source).toContain("} else serveDocumentDossier(response, request, options, body);");
    expect(branches.has(UNCONDITIONAL_ELSE_MEMBER)).toBe(false);
  });

  it("guards every rostered path against a non-POST method, bar a named census", () => {
    const source = dispatchSource();
    const roster = rosterIdentifiers(source);
    const guards = guardIdentifiers(source);

    // A guard for a path NOT in the roster is dead code; a rostered path with no guard
    // accepts a GET unless it is one of the six the census names.
    expect(sorted(guards).filter((name) => !roster.has(name))).toStrictEqual([]);
    expect(sorted([...roster].filter((name) => !guards.has(name))))
      .toStrictEqual(sorted(UNGUARDED_MEMBERS));
  });

  it("registers the activation read in all three seams", () => {
    const source = dispatchSource();

    // Named directly rather than left to the set arms: this is the route this row added, and
    // a reader looking for its registration should find it asserted by name.
    expect(rosterIdentifiers(source).has("ACTIVATION_READ_PATH")).toBe(true);
    expect(branchIdentifiers(source).has("ACTIVATION_READ_PATH")).toBe(true);
    expect(guardIdentifiers(source).has("ACTIVATION_READ_PATH")).toBe(true);
    expect(JSON_ROUTES).toContain(ACTIVATION_READ_PATH);
    expect(ACTIVATION_READ_PATH).toBe("/activation/read");
  });

  it("registers the repository-remote read in all three seams", () => {
    const source = dispatchSource();

    // task-9d553419's route, named directly for the same reason as the arm above: the set arms
    // would catch its removal only as an off-by-one naming nothing, and the three seams fail
    // differently — no roster entry sends it to the ASSET host (not a 404), no branch falls
    // through to the unconditional `else`, no guard accepts a GET.
    expect(rosterIdentifiers(source).has("REPOSITORY_REMOTE_READ_PATH")).toBe(true);
    expect(branchIdentifiers(source).has("REPOSITORY_REMOTE_READ_PATH")).toBe(true);
    expect(guardIdentifiers(source).has("REPOSITORY_REMOTE_READ_PATH")).toBe(true);
    expect(JSON_ROUTES).toContain(REPOSITORY_REMOTE_READ_PATH);
    expect(REPOSITORY_REMOTE_READ_PATH).toBe("/repository/remote/read");
  });

  it("proxies every served JSON route in development, bar a named census", () => {
    const proxied = proxiedPaths();

    // The dev proxy is the fifth registration touchpoint and the one that fails SILENTLY:
    // an unproxied route works in production and only breaks under the dev server.
    const unproxied = JSON_ROUTES.filter((path) => !proxied.has(path));
    expect(sorted(unproxied)).toStrictEqual(sorted(UNPROXIED_SERVED_PATHS));
    expect(proxied.has(ACTIVATION_READ_PATH)).toBe(true);
  });

  it("proxies nothing under a foreign authority and nothing this daemon cannot serve", () => {
    const proxied = proxiedPaths();

    // The pairing surface and `/bootstrap` are deliberately OUTSIDE JSON_ROUTES (they are
    // served by http-listener-pairing-routes.ts and the listener itself), so they are the
    // only permitted proxied-but-not-rostered entries.
    const served = new Set<string>(JSON_ROUTES);
    expect(sorted([...proxied].filter((path) => !served.has(path)))).toStrictEqual([
      "/bootstrap", "/session/pair", "/session/pair/claim", "/session/pair/open",
      "/session/pair/request",
    ]);
    expect([...proxied].some((path) => path.startsWith("/manager/"))).toBe(false);
  });

  it("scans a seam that is actually populated — no arm above can pass on an empty set", () => {
    // A POSITIVE CONTROL for the three source scans. Every set arm above compares two derived
    // sets, and two empty sets are equal: if a regex stopped matching, those arms would go
    // green while measuring nothing. These floors are what make them mean something.
    const source = dispatchSource();
    expect(rosterIdentifiers(source).size).toBeGreaterThan(20);
    expect(branchIdentifiers(source).size).toBeGreaterThan(20);
    expect(guardIdentifiers(source).size).toBeGreaterThan(15);
    expect(proxiedPaths().size).toBeGreaterThan(25);
  });
});
