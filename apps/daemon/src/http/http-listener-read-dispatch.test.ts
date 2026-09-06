import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CAPABILITIES, PAYLOAD_KEYS } from "../daemon-command-vocabulary.js";
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
 * silently. A route absent from the proxy works in production and fails only under the dev
 * server, which is where the e2e lane runs.
 *
 * The census is now EMPTY, and both entries it once held were retired the same way: a row
 * landed the daemon route alone, recorded the gap here, and the row that later landed the
 * control-room half (exact-key decoder plus the proxy pin in
 * apps/control-room/src/live/dev-proxy-paths.ts) deleted the census entry in the same edit.
 *
 * - `/repository/remote/read`: recorded by task-9d553419, retired by task-e6000b57.
 * - `/product-contract/gate-1/read`: recorded by task-0a5d7212 (commit 6c0986ea), which owned
 *   neither half; retired by task-1c9587ed1b2b4e1abd6b51396ee672f8, which landed
 *   live/live-product-contract-gate-1.ts and the pin at dev-proxy-paths.ts:27.
 *
 * An empty census is not a dead arm: the assertion below still reds the moment any served
 * JSON route is added without its proxy pin. It is also the arm that reds when a pin is
 * added and this list is not updated with it, which is exactly how both retirements were
 * caught. Keep the pair edited together; nothing imports this file from the control-room,
 * so only `grep -rn DEV_PROXY_PATHS apps packages tools` finds this asserter.
 *
 * `/design/read` is now proxied and consumed by the opened-goal Design card.
 *
 * - `/environments/read`: recorded by task-ef76a7f4523d46f48a2f9eb19595e801, which owns the
 *   daemon half ONLY. Its task rail 4 forbids it touching apps/control-room at all, because the
 *   Environments screen -- exact-key client decoder plus the proxy pin -- is
 *   task-ba83b202265d40d1885d3091f009b0a2, which declares dependsOn against it. That row
 *   retires this entry in the same edit that adds the pin, exactly as task-e6000b57 and
 *   task-1c9587ed retired the two above.
 */
const UNPROXIED_SERVED_PATHS: readonly string[] = Object.freeze(["/environments/read"]);

/**
 * JSON_ROUTES the browser production tree does not fetch. Frozen census, not a
 * subset: a newly served route with no consumer reds, and deleting a consumer
 * of a previously-consumed route reds. An entry with no reason is a hiding
 * place; the positive-control arm pins every member named in THIS comment.
 *
 * /events/resume: client-transport.ts declares EVENT_PAGE_PATH (/events/read)
 * and EVENT_ACKNOWLEDGE_PATH (/events/ack) and not resume; generated-client.ts:28
 * states Cursor/resume semantics are TBD.
 * /v2/product-contract/current: the browser consumes
 * /v2/product-contract/pending/read (gate1-approval.ts), not current.
 * /session/challenge-operands/read: only named in dev-proxy-paths.ts, despite
 * that file commenting that the browser reads the operands.
 * /preview/read: task-4a6e7bdbef9a4344829a7ce49c6fb378 lands the daemon receipt read and the
 * capture-bytes route; task-33ceae56edc348e9864bc592430fa1d0 supplies the preview card that
 * consumes them and retires this entry.
 *
 * /documents/ingest: apps/control-room/src/live/live-document-ingest.ts declares
 * the route and decodes its three answers, but NOTHING IMPORTS THAT MODULE - the
 * only two hits for its name are prose in live-planning-run.ts:8,115 saying the
 * discipline was copied from it. It is a dead module, so the ingest route has no
 * reachable call site. Named here rather than special-cased; building the ingest
 * control is a screen row, not this proof row (task rail 1).
 * /budget/commitment/read: consumed ONLY by the retired v1 shell, which main.tsx
 * reaches through `await import("./development-legacy-root.js")` inside the
 * `DEVELOPMENT_BUILD` branch that main.tsx:28,47 documents as folded to `false`
 * and eliminated from a production build. Reachable in a dev build, absent from
 * the shipped artifact; the walk below measures the shipped one.
 *
 * /graph/get was retired from this census by live-graph-get.ts, whose readGraphGet
 * is CALLED from the production entry's graph: cordum-app.tsx composes
 * useAdvancedFrames (v2/shell/advanced-frames.ts), which fetches it and feeds the
 * decoded frame to the Advanced panel. A `import type` referent would not count -
 * that is exactly the hole the reachability walk closed.
 */
const UNCONSUMED_SERVED_ROUTES: readonly string[] = Object.freeze([
  "/budget/commitment/read",
  "/documents/ingest",
  // Same pair as the proxy census above and retired by the same row: the daemon half landed
  // here, the Environments screen that fetches it is task-ba83b202265d40d1885d3091f009b0a2.
  "/environments/read",
  "/events/resume",
  // The preview receipt read. This row (task-4a6e7bdbef9a4344829a7ce49c6fb378) lands the
  // DAEMON half only — the JSON receipt read and the capture-bytes route beneath it. The
  // Needs-you preview card that fetches them, renders the loopback url as a link and the
  // captures inline, is task-33ceae56edc348e9864bc592430fa1d0, which declares dependsOn
  // against this row and RETIRES THIS ENTRY in the same edit that adds its consumer — exactly
  // as task-e6000b57, task-1c9587ed and task-80322112 retired the three entries above it.
  // The capture route is not listed here because it is not a JSON_ROUTES member; it is
  // proxied-but-not-rostered, and the arm below names it there instead.
  "/preview/read",
  "/session/challenge-operands/read",
  "/v2/product-contract/current",
]);

/**
 * Pairing/bootstrap paths the browser DOES fetch that live outside JSON_ROUTES.
 * The proxy list at the arm below also names `/session/pair`; no production
 * module fetches that tombstone, so consumption equality uses the four that
 * live-handshake.ts and live-keyed-session.ts actually call.
 */
const PERMITTED_CONSUMED_NON_JSON_ROUTES: readonly string[] = Object.freeze([
  "/bootstrap", "/session/pair/claim", "/session/pair/open", "/session/pair/request",
]);

/**
 * CONSUMPTION IS MEASURED FROM THE PRODUCTION ENTRY'S MODULE GRAPH, not from a
 * directory sweep. A sweep counts a route literal that sits in a module nothing
 * loads, which is how `/graph/get` once left the census below on the strength of
 * a constant in a file whose only referents were `import type` (erased by
 * TypeScript, absent from the bundle). Reachability from `main.tsx` over VALUE
 * edges is the seam that cannot be fooled that way.
 */
const CONTROL_ROOM_ENTRY = fileURLToPath(
  new URL("../../../control-room/src/main.tsx", import.meta.url),
);
/** The one bare specifier this graph crosses; everything else in it is relative. */
const CLIENT_PACKAGE = "@moe/control-room-client";
const CLIENT_BARREL = fileURLToPath(
  new URL("../../../../packages/control-room-client/src/index.ts", import.meta.url),
);
const DEV_PROXY_MODULE = "dev-proxy-paths.ts";

function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i] ?? "";
    const n = source[i + 1] ?? "";
    if (c === "\"" || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i += 1;
      while (i < source.length) {
        const ch = source[i] ?? "";
        out += ch;
        i += 1;
        if (ch === "\\" && i < source.length) {
          out += source[i] ?? "";
          i += 1;
          continue;
        }
        if (ch === quote) break;
      }
      continue;
    }
    if (c === "/" && n === "/") {
      i += 2;
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Every module specifier a source LOADS AT RUNTIME, comments already stripped.
 *
 * `import type` and `export type` statements are DELIBERATELY NOT EDGES: TypeScript
 * erases them, so a module whose only referents are type-only is never in the
 * bundle and cannot fetch anything. `import { type X, y }` IS an edge - the module
 * still loads for `y`. Bare side-effect imports are edges.
 *
 * DYNAMIC `import()` IS NOT AN EDGE, and that is a measured choice rather than an
 * oversight: this tree contains exactly ONE (main.tsx's `await import(
 * "./development-legacy-root.js")`), it sits inside the `DEVELOPMENT_BUILD` branch
 * that main.tsx:28,47 documents as folded to `false` and dropped by a production
 * build, and following it certifies `/budget/commitment/read` as consumed by a
 * shell no production artifact contains. The arm below pins that this stays the
 * only one, so a real production dynamic import forces a revisit here.
 */
function importSpecifiers(stripped: string): readonly string[] {
  const specifiers: string[] = [];
  const patterns = [
    /(?:^|[\s;})])(?:import|export)\s+(?!type\s)[^;]*?\sfrom\s*"([^"]+)"/gu,
    /(?:^|[\s;}])import\s*"([^"]+)"/gu,
  ];
  for (const pattern of patterns) {
    for (const hit of stripped.matchAll(pattern)) {
      if (hit[1] !== undefined) specifiers.push(hit[1]);
    }
  }
  return specifiers;
}

/** Relative `.js` specifiers name `.ts`/`.tsx` sources; the one bare specifier is the client barrel. */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  if (specifier === CLIENT_PACKAGE) return CLIENT_BARREL;
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier).replace(/\.js$/u, "");
  const candidates = [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

type ConsumerScan = {
  readonly dynamicImportSites: readonly string[];
  readonly filesWalked: number;
  readonly modules: ReadonlySet<string>;
  readonly paths: ReadonlySet<string>;
};

function scanConsumers(): ConsumerScan {
  const modules = new Set<string>();
  const paths = new Set<string>();
  const dynamicImportSites: string[] = [];
  const pending = [CONTROL_ROOM_ENTRY];
  while (pending.length > 0) {
    const file = pending.pop() ?? "";
    if (modules.has(file)) continue;
    modules.add(file);
    const stripped = stripComments(readFileSync(file, "utf8"));
    if (/import\s*\(/u.test(stripped)) dynamicImportSites.push(file.replaceAll("\\", "/"));
    // The dev proxy is Vite config, not a fetch: a route listed there is proxied,
    // never consumed. It is unreachable from the entry today; the skip keeps that
    // true if a production module ever imports the list for another purpose.
    if (!file.endsWith(DEV_PROXY_MODULE)) {
      for (const hit of stripped.matchAll(/"(\/[^"]*)"/gu)) {
        if (hit[1] !== undefined) paths.add(hit[1]);
      }
    }
    for (const specifier of importSpecifiers(stripped)) {
      const next = resolveSpecifier(file, specifier);
      if (next !== null && !modules.has(next)) pending.push(next);
    }
  }
  return { dynamicImportSites, filesWalked: modules.size, modules, paths };
}

function consumedPaths(): ReadonlySet<string> {
  return scanConsumers().paths;
}

/** Project-daemon HTTP routes, not the manager origin and not a keyboard `/`. */
function isDaemonShaped(path: string): boolean {
  return path.startsWith("/") && path.length > 1 && !path.startsWith("/manager/")
    && /^\/[a-z0-9][a-z0-9./-]*$/.test(path);
}

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
    expect(roster.size).toBe(32);
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

  it("registers the design read in all three seams", () => {
    const source = dispatchSource();
    expect(rosterIdentifiers(source).has("DESIGN_READ_PATH")).toBe(true);
    expect(branchIdentifiers(source).has("DESIGN_READ_PATH")).toBe(true);
    expect(guardIdentifiers(source).has("DESIGN_READ_PATH")).toBe(true);
    expect(JSON_ROUTES).toContain("/design/read");
  });

  it("registers the bootstrap receipt read in all three seams and the dev proxy", () => {
    const source = dispatchSource();
    expect(rosterIdentifiers(source).has("REPOSITORY_BOOTSTRAP_READ_PATH")).toBe(true);
    expect(branchIdentifiers(source).has("REPOSITORY_BOOTSTRAP_READ_PATH")).toBe(true);
    expect(guardIdentifiers(source).has("REPOSITORY_BOOTSTRAP_READ_PATH")).toBe(true);
    expect(JSON_ROUTES).toContain("/repository/bootstrap/read");
    expect(proxiedPaths().has("/repository/bootstrap/read")).toBe(true);
  });

  it("registers the preview receipt read in all three seams and the dev proxy", () => {
    const source = dispatchSource();
    expect(rosterIdentifiers(source).has("PREVIEW_READ_PATH")).toBe(true);
    expect(branchIdentifiers(source).has("PREVIEW_READ_PATH")).toBe(true);
    expect(guardIdentifiers(source).has("PREVIEW_READ_PATH")).toBe(true);
    expect(JSON_ROUTES).toContain("/preview/read");
    expect(proxiedPaths().has("/preview/read")).toBe(true);
  });

  it("serves the capture route ahead of the roster and never through it", () => {
    const source = dispatchSource();

    // The set arms above cannot see this route: it is not a JSON_ROUTES member and it is
    // matched by prefix, so its registration is asserted here by name. All three clauses
    // matter and fail differently — no interception sends `/preview/capture/...` to the
    // ASSET host under the CONTROL-ROOM root (a bundle path, not a capture); an interception
    // placed after the roster check would be dead for a daemon hosting no bundle; and a
    // JSON_ROUTES membership would route image bytes through the dossier handler.
    const intercept = source.indexOf("isPreviewCapturePath(path)");
    const rosterCheck = source.indexOf("if (!JSON_ROUTES.includes(path))");
    expect(intercept).toBeGreaterThan(-1);
    expect(rosterCheck).toBeGreaterThan(-1);
    expect(intercept).toBeLessThan(rosterCheck);
    expect(JSON_ROUTES).not.toContain("/preview/capture");
    expect(proxiedPaths().has("/preview/capture")).toBe(true);
    // It is fenced by the same Host/Origin/CSRF check as the JSON surface, not by the
    // asset host's bare Host check.
    expect(source).toContain("const captureFault = checkHeaders(request, authority, origin,");
    // And it is served through the NARROWED locator, never the bundle-wide one.
    expect(source).toContain("locatePreviewCapture,");
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
    // only permitted proxied-but-not-rostered entries — joined by `/preview/capture`, which
    // is outside the roster for a THIRD reason: it answers image bytes, not JSON, is matched
    // by PREFIX rather than equality, and is intercepted ahead of the roster check in
    // `serveReadDispatch`. A JSON_ROUTES membership for it would send it to the dossier
    // handler; the arm below proves the daemon really does serve it.
    const served = new Set<string>(JSON_ROUTES);
    expect(sorted([...proxied].filter((path) => !served.has(path)))).toStrictEqual([
      "/bootstrap", "/preview/capture", "/session/pair", "/session/pair/claim",
      "/session/pair/open", "/session/pair/request",
    ]);
    expect([...proxied].some((path) => path.startsWith("/manager/"))).toBe(false);
  });

  it("consumes every served JSON route, bar a named census", () => {
    const consumed = consumedPaths();
    const unconsumed = JSON_ROUTES.filter((path) => !consumed.has(path));
    expect(sorted(unconsumed)).toStrictEqual(sorted(UNCONSUMED_SERVED_ROUTES));
  });

  it("fetches no daemon-shaped route this listener does not serve, bar pairing", () => {
    const consumed = consumedPaths();
    const served = new Set<string>(JSON_ROUTES);
    const foreign = [...consumed].filter((path) => isDaemonShaped(path) && !served.has(path));
    expect(sorted(foreign)).toStrictEqual(sorted(PERMITTED_CONSUMED_NON_JSON_ROUTES));
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
    const scan = scanConsumers();
    expect(scan.filesWalked).toBeGreaterThan(100);
    expect(scan.paths.size).toBeGreaterThan(15);
    const comments = [...readFileSync(fileURLToPath(new URL(import.meta.url)), "utf8")
      .matchAll(/\/\*[\s\S]*?\*\/|\/\/.*$/gmu)].map((hit) => hit[0]).join("\n");
    for (const path of UNCONSUMED_SERVED_ROUTES) {
      expect(comments).toContain(path);
    }
    expect(stripComments('const x = "/events/resume";')).toContain('"/events/resume"');
    expect(stripComments('// "/events/resume"\nconst y = 1;')).not.toContain("/events/resume");
    expect(stripComments('/* "/graph/get" */ const z = 1;')).not.toContain("/graph/get");
  });

  it("walks VALUE edges only, so a type-only referent never marks a module consumed", () => {
    // THE CONTROL FOR THE FIX. `/graph/get` was certified consumed while its module's
    // only referents were `import type`, which TypeScript erases: the literal shipped in
    // nothing. These pin the erasure rule at the extractor rather than at the graph, so
    // the arm cannot go quiet the way the sweep it replaced did.
    expect(importSpecifiers('import type { X } from "./a.js";')).toStrictEqual([]);
    expect(importSpecifiers('export type { X } from "./a.js";')).toStrictEqual([]);
    expect(importSpecifiers('import { x } from "./a.js";')).toStrictEqual(["./a.js"]);
    expect(importSpecifiers('import { type X, y } from "./a.js";')).toStrictEqual(["./a.js"]);
    expect(importSpecifiers('export * from "./a.js";')).toStrictEqual(["./a.js"]);
    expect(importSpecifiers('import "./a.js";')).toStrictEqual(["./a.js"]);
    expect(importSpecifiers('import typeOf from "./a.js";')).toStrictEqual(["./a.js"]);

    // Reachability, not a directory sweep: the dev proxy list is Vite config that no
    // production module imports, so it is absent from the graph entirely. Under the old
    // sweep it was present and had to be skipped by filename.
    const scan = scanConsumers();
    expect([...scan.modules].some((file) => file.endsWith(DEV_PROXY_MODULE))).toBe(false);
    expect(scan.modules.has(CLIENT_BARREL)).toBe(true);
    expect([...scan.modules].some((file) => file.includes(".test."))).toBe(false);

    // The single dynamic import this walk deliberately does not follow. If a second
    // one appears, or this one moves out of the development-only branch, the choice
    // documented at importSpecifiers has to be re-made rather than silently inherited.
    expect(scan.dynamicImportSites).toStrictEqual([
      CONTROL_ROOM_ENTRY.replaceAll("\\", "/"),
    ]);
    const entry = readFileSync(CONTROL_ROOM_ENTRY, "utf8");
    expect(entry).toContain('await import("./development-legacy-root.js")');
    expect(entry).toContain("const DEVELOPMENT_BUILD: boolean = import.meta.env.DEV;");
  });
});

const REGISTRY_SOURCE = fileURLToPath(new URL("../daemon-command-registry.ts", import.meta.url));
const GENERATED_CLIENT_SOURCE = fileURLToPath(
  new URL("../../../../packages/control-room-client/src/generated/generated-client.ts", import.meta.url),
);

/**
 * DoD 2 named exclusions. These are KINDS (or, for planning.write, a capability
 * that is not a kind). They travel over /command and /v2/command. Sense is
 * measured, not guessed:
 *
 * planning.write: NOT_A_COMMAND_KIND. CAPABILITIES.PLANNING, not a PAYLOAD_KEYS
 * entry and not a generated command builder.
 * graph.supersede: ADVERTISED_AND_SERVED_HUMAN_ONLY. In PAYLOAD_KEYS and in
 * GENERATED_COMMAND_BUILDERS; OPERATOR_PRINCIPAL_KINDS; no first-class UI
 * affordance that mints it.
 * cutover.abort: ADVERTISED_NOT_SERVED. Builder exists; registry does not.
 * cutover.activate: ADVERTISED_AND_SERVED_UI_GATED. Builder and PAYLOAD_KEYS
 * both carry it. The UI does not choose the kind: approval-detail-confirmation.tsx
 * (apps/control-room/src/approvals, not v2/approvals) takes commandKind from the
 * caller rather than picking between approval.decide and cutover.*.
 * cutover.preview: ADVERTISED_NOT_SERVED.
 * cutover.quiesce: ADVERTISED_NOT_SERVED.
 * work.cancel: ADVERTISED_NOT_SERVED.
 * work.claim: ADVERTISED_AND_SERVED_AGENT_WIRE. Served and advertised; the
 * browser does not offer a human claim control.
 * work.release: ADVERTISED_AND_SERVED_AGENT_WIRE.
 * work.renew: ADVERTISED_AND_SERVED_AGENT_WIRE.
 * work.resume: ADVERTISED_AND_SERVED_AGENT_WIRE. CONTINUATION_COMMAND_KIND.
 */
const KIND_EXCLUSION_SENSE = Object.freeze({
  "cutover.abort": "ADVERTISED_NOT_SERVED",
  "cutover.activate": "ADVERTISED_AND_SERVED_UI_GATED",
  "cutover.preview": "ADVERTISED_NOT_SERVED",
  "cutover.quiesce": "ADVERTISED_NOT_SERVED",
  "graph.supersede": "ADVERTISED_AND_SERVED_HUMAN_ONLY",
  "planning.write": "NOT_A_COMMAND_KIND",
  "work.cancel": "ADVERTISED_NOT_SERVED",
  "work.claim": "ADVERTISED_AND_SERVED_AGENT_WIRE",
  "work.release": "ADVERTISED_AND_SERVED_AGENT_WIRE",
  "work.renew": "ADVERTISED_AND_SERVED_AGENT_WIRE",
  "work.resume": "ADVERTISED_AND_SERVED_AGENT_WIRE",
} as const);

function advertisedCommandKinds(): ReadonlySet<string> {
  const source = readFileSync(GENERATED_CLIENT_SOURCE, "utf8");
  const start = source.indexOf("export const GENERATED_COMMAND_BUILDERS");
  const end = source.indexOf("});", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return new Set(
    [...source.slice(start, end).matchAll(/commandBuilderFor\("([^"]+)"\)/gu)]
      .map((hit) => hit[1] ?? ""),
  );
}

function servedCommandKinds(): ReadonlySet<string> {
  return new Set(Object.keys(PAYLOAD_KEYS));
}

describe("command-kind exclusions are explicit and reasoned, not omitted", () => {
  it("registers every served kind from PAYLOAD_KEYS, the table the registry composes", () => {
    expect(readFileSync(REGISTRY_SOURCE, "utf8")).toContain(
      "(Object.keys(PAYLOAD_KEYS) as readonly WiredCommandKind[]).map(entryOf)",
    );
    expect(servedCommandKinds().size).toBeGreaterThan(20);
    expect(advertisedCommandKinds().size).toBeGreaterThan(50);
  });

  it("states a sense per DoD-named exclusion and pins that sense to the two seams", () => {
    const served = servedCommandKinds();
    const advertised = advertisedCommandKinds();
    const comments = [...readFileSync(fileURLToPath(new URL(import.meta.url)), "utf8")
      .matchAll(/\/\*[\s\S]*?\*\/|\/\/.*$/gmu)].map((hit) => hit[0]).join("\n");
    for (const [kind, sense] of Object.entries(KIND_EXCLUSION_SENSE)) {
      expect(comments).toContain(`${kind}: ${sense}`);
      if (sense === "NOT_A_COMMAND_KIND") {
        expect(served.has(kind)).toBe(false);
        expect(advertised.has(kind)).toBe(false);
        expect(CAPABILITIES.PLANNING).toBe(kind);
        continue;
      }
      expect(advertised.has(kind)).toBe(true);
      expect(served.has(kind)).toBe(sense.startsWith("ADVERTISED_AND_SERVED"));
    }
  });

  it("expands cutover.* and work.* from the advertised seam, not a silent glob", () => {
    const advertised = advertisedCommandKinds();
    const served = servedCommandKinds();
    expect(sorted([...advertised].filter((kind) => kind.startsWith("cutover.")))).toStrictEqual([
      "cutover.abort", "cutover.activate", "cutover.preview", "cutover.quiesce",
    ]);
    expect(sorted([...served].filter((kind) => kind.startsWith("cutover.")))).toStrictEqual([
      "cutover.activate",
    ]);
    expect(sorted([...advertised].filter((kind) => kind.startsWith("work.")))).toStrictEqual([
      "work.cancel", "work.claim", "work.release", "work.renew", "work.resume",
    ]);
    expect(sorted([...served].filter((kind) => kind.startsWith("work.")))).toStrictEqual([
      "work.claim", "work.release", "work.renew", "work.resume",
    ]);
  });
});
