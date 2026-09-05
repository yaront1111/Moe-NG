import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
 * `/design/read`: recorded by task-7ca9dca3. Browser consumer / proxy pin is task-e9cb2442.
 */
const UNPROXIED_SERVED_PATHS: readonly string[] = Object.freeze(["/design/read"]);

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
 *
 * /graph/get was retired from this census by live-graph-get.ts: POST {}, CSRF
 * and the paired session already held, so no daemon bytes were added.
 * /design/read: no browser consumer yet; that is task-e9cb2442 (Design tab /
 * live decoder / proxy pin).
 */
const UNCONSUMED_SERVED_ROUTES: readonly string[] = Object.freeze([
  "/design/read",
  "/events/resume",
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

const CONTROL_ROOM_SRC = fileURLToPath(new URL("../../../control-room/src", import.meta.url));
const CLIENT_SRC = fileURLToPath(
  new URL("../../../../packages/control-room-client/src", import.meta.url),
);

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

function walkConsumerFiles(root: string): readonly string[] {
  const names = readdirSync(root, { encoding: "utf8", recursive: true });
  const files: string[] = [];
  for (const name of names) {
    const rel = name.replaceAll("\\", "/");
    if (rel.includes(".test.")) continue;
    if (rel.endsWith("dev-proxy-paths.ts")) continue;
    if (!rel.endsWith(".ts") && !rel.endsWith(".tsx")) continue;
    files.push(join(root, name));
  }
  return files;
}

type ConsumerScan = {
  readonly filesWalked: number;
  readonly paths: ReadonlySet<string>;
};

function scanConsumers(): ConsumerScan {
  const files = [...walkConsumerFiles(CONTROL_ROOM_SRC), ...walkConsumerFiles(CLIENT_SRC)];
  const paths = new Set<string>();
  for (const file of files) {
    const stripped = stripComments(readFileSync(file, "utf8"));
    for (const hit of stripped.matchAll(/"(\/[^"]*)"/gu)) {
      const path = hit[1];
      if (path !== undefined) paths.add(path);
    }
  }
  return { filesWalked: files.length, paths };
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
    expect(roster.size).toBe(27);
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
