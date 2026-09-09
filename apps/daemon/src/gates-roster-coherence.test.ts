/**
 * THE SHARED ROSTER IS WHOLE, at the delivered tree, for the gates epic-af14d735 published.
 *
 * Four band rows (`preview.decide`, `preview.start`, `release.decide`, `design.submit` /
 * `design.read`) moved the SAME roster files in sequence. Each proved its own slice; nothing
 * proved they agree with each other afterwards. That is what this file is for, and it is why
 * every expectation here is DERIVED from a production surface rather than transcribed:
 * epic rail 3 forbids freezing a roster count, because a concurrent kind-publishing row moves
 * the literal first and reds the arm for a reason that is not a defect.
 *
 * THE SERVED SET IS ENUMERATED FROM THE DISPATCH SEAM (`createDaemonCommandPorts(...).registry`),
 * never from a roster constant. Global rail 9: a test that iterates the roster shrinks its own
 * iteration when an entry is deleted and stays green while a served capability vanishes from the
 * advertised surface.
 *
 * WHAT IS ASSERTED AS EQUALITY AND WHAT IS ASSERTED AS CONTAINMENT, and why the difference is
 * production's and not this file's convenience:
 *   - advertised (RUNTIME_COMMAND_KINDS) vs the GENERATED CLIENT: EXACT SET EQUALITY, both
 *     directions. The client is generated from the shared contract, so a kind on either side
 *     alone is drift by construction.
 *   - advertised vs SERVED: CONTAINMENT (served ⊆ advertised). Equality is FALSE BY PRODUCTION
 *     DESIGN -- `daemon-command-vocabulary.ts:220` and `goals/goal-create-with-source.ts:35` both
 *     record kinds advertised in the shared contract and deliberately not served by this daemon's
 *     command registry, and `design.read` is one of them. Asserting equality here would be a
 *     fabricated gate that reds on a documented intermediate state.
 * The direction that MATTERS is the one asserted as equality-shaped: nothing the daemon SERVES
 * may be missing from what it ADVERTISES.
 *
 * `daemon-store-dependencies.test.ts:238` already holds `[...v2.registry.keys()]` against
 * `Object.keys(PAYLOAD_KEYS)`; that pair is tautological on THIS registry
 * (`daemon-command-registry.ts:614` builds it by mapping `Object.keys(PAYLOAD_KEYS)`), so it is
 * cited rather than duplicated with a second exclusion list that could drift.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { RUNTIME_COMMAND_KINDS } from "@moe/contracts";
import { describe, expect, it } from "vitest";

import { PROJECT_ID, closeStores, openStore } from "./bootstrap/bootstrap-test-fixtures.js";
import { createDaemonCommandPorts } from "./daemon-command-registry.js";
import { MCP_SERVED_QUERY_KINDS } from "./mcp-tool-allowlist.js";
import { servedMcpQueryKinds } from "./mcp-dispatch-port.js";

/** The epic's bands, as PREFIXES. A fifth `preview.*` kind enters every arm below with no edit
 *  here; a hand list of kinds would not see it, which is the enumeration defect global rail 9
 *  names. */
const BAND = /^(?:design|preview|release)\./u;

const repoFile = (relative: string): string =>
  fileURLToPath(new URL(`../../../${relative}`, import.meta.url));

const GENERATED_CLIENT = repoFile("packages/control-room-client/src/generated/generated-client.ts");

/** Every kind this daemon SERVES, read off a real composed registry. */
function servedCommandKinds(): readonly string[] {
  const store = openStore();
  try {
    const ports = createDaemonCommandPorts({
      clock: () => "2026-09-08T00:00:00.000Z",
      operatorPrincipalId: "operator-roster", projectId: PROJECT_ID, store,
    });
    return [...ports.registry.keys()].sort();
  } finally {
    closeStores();
  }
}

const matches = (source: string, pattern: RegExp): readonly string[] =>
  [...source.matchAll(pattern)].map((hit) => hit[1] ?? "").sort();

const band = (kinds: Iterable<string>): readonly string[] =>
  [...kinds].filter((kind) => BAND.test(kind)).sort();

const clientSource = (): string => readFileSync(GENERATED_CLIENT, "utf8");

describe("the shared command roster is coherent across every surface the epic touched", () => {
  it("advertises every kind it serves, and serves nothing it does not advertise", () => {
    const served = servedCommandKinds();
    const advertised = new Set<string>(RUNTIME_COMMAND_KINDS);
    // Not a subset SPELLED as a subset check over the advertised roster: the served set is
    // enumerated first, so deleting a kind from the advertised side reds even though the
    // advertised roster is the one that shrank.
    expect(served.filter((kind) => !advertised.has(kind))).toEqual([]);
    expect(served.length).toBeGreaterThan(0);
  });

  it("agrees with the generated control-room client in BOTH directions", () => {
    const generated = matches(clientSource(), /\["([a-z_]+\.[a-z_0-9]+)"\]: commandBuilderFor\(/gu);
    expect(generated.length).toBeGreaterThan(0);
    // Set equality, not containment: the client is GENERATED from this roster, so a kind on
    // either side alone is drift. Deleting one from either file reds this line.
    expect(generated).toEqual([...RUNTIME_COMMAND_KINDS].sort());
  });

  it("carries every band gate kind on the served, advertised and generated surfaces at once", () => {
    const served = band(servedCommandKinds());
    // The sweep must be proven to have GENERATED cases: a band that silently matched nothing
    // would make every assertion below vacuously true.
    expect(served.length).toBeGreaterThan(0);
    const advertised = new Set<string>(RUNTIME_COMMAND_KINDS);
    const generated = new Set(matches(
      clientSource(), /\["([a-z_]+\.[a-z_0-9]+)"\]: commandBuilderFor\(/gu,
    ));
    for (const kind of served) {
      expect({ advertised: advertised.has(kind), generated: generated.has(kind), kind })
        .toEqual({ advertised: true, generated: true, kind });
    }
  });

  it("serves every band QUERY kind it advertises over MCP, and advertises every one it serves", () => {
    const advertisedQueries = band(MCP_SERVED_QUERY_KINDS);
    const servedQueries = band(servedMcpQueryKinds());
    // Both directions over the band, against the port's own handler table rather than the
    // roster constant. `mcp-tool-allowlist.test.ts` arm Q1 holds the WHOLE-roster equality;
    // this narrows to the band so a band regression names itself.
    expect(advertisedQueries.length).toBeGreaterThan(0);
    expect(servedQueries).toEqual(advertisedQueries);
  });
});

/**
 * THE GENERATED_CONTRACT_DIGEST MIRROR CENSUS, as a COMMITTED ARM rather than a one-time grep.
 *
 * CENSUS BY THE HEX, NEVER BY THE SYMBOL. Five of the six mirrors do not mention
 * `GENERATED_CONTRACT_DIGEST` at all -- they hard-code the value under `contractSchemaHash:` or
 * a local `CONTRACT_DIGEST` -- and three of those are `.tsx`, invisible to a `*.ts`-only grep.
 * The mirrors are DISCOVERED by walking the roots below, so a regeneration that leaves a NEW
 * mirror behind reds here instead of shipping behind three green gates.
 *
 * TWO POPULATIONS, and only one of them is a hazard. The SYMBOL IMPORTERS (contract-pins.ts,
 * contract-digest.test.ts, cutover/v2-readiness-evidence-{collector,producers}) follow a
 * regeneration automatically and are not asserted here. The TRANSCRIBED mirrors do not follow;
 * they are hand edits, and four of them live under `apps/control-room`, which is in NONE of
 * `pnpm test` (the root vitest include has no apps/**), `pnpm typecheck`, or the daemon leg. So
 * `pnpm --filter @moe/control-room test` is the only leg that can catch a stale one -- this arm
 * catches it in the daemon leg too, which is the point of committing it here.
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIGEST_ROOTS = Object.freeze([
  "apps/control-room/src", "apps/daemon/src", "packages/control-room-client/src",
]);
const SOURCE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx)$/u;
/** The two shapes a TRANSCRIBED mirror takes, each capturing the hex it pins. */
const MIRROR_SHAPES: readonly RegExp[] = Object.freeze([
  /contractSchemaHash:\s*\n?\s*"([0-9a-f]{64})"/gu,
  /\bCONTRACT_DIGEST\b[^\n]*?=\s*"([0-9a-f]{64})"/gu,
]);

function sourceFilesUnder(root: string): readonly string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (SOURCE_FILE.test(entry.name)) found.push(path);
    }
  };
  walk(root);
  return found;
}

/** Every `path:line` that hard-codes a contract digest, with the hex it holds. */
function digestMirrors(
  roots: readonly string[] = DIGEST_ROOTS.map((root) => repoFile(root)),
): readonly { readonly hex: string; readonly where: string }[] {
  const mirrors: { hex: string; where: string }[] = [];
  for (const root of roots) {
    for (const file of sourceFilesUnder(root)) {
      const source = readFileSync(file, "utf8");
      for (const shape of MIRROR_SHAPES) {
        for (const hit of source.matchAll(shape)) {
          const hex = hit[1];
          if (hex === undefined) continue;
          const line = source.slice(0, hit.index).split("\n").length;
          mirrors.push({ hex, where: `${file.replaceAll("\\", "/")}:${line}` });
        }
      }
    }
  }
  return mirrors;
}

describe("every GENERATED_CONTRACT_DIGEST mirror carries the current hex", () => {
  it("finds the digest the generated client publishes", () => {
    const current = /GENERATED_CONTRACT_DIGEST = "([0-9a-f]{64})"/u.exec(clientSource())?.[1];
    expect(current).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("holds every hand-transcribed mirror against it, in both apps and packages", () => {
    const current = /GENERATED_CONTRACT_DIGEST = "([0-9a-f]{64})"/u.exec(clientSource())?.[1];
    if (current === undefined) throw new Error("the generated client publishes no digest");
    const mirrors = digestMirrors();
    // THE SWEEP MUST BE PROVEN TO HAVE RUN. A walk that silently yielded zero files -- a moved
    // root, a renamed extension -- would pass this whole describe while every mirror rotted.
    expect(mirrors.length).toBeGreaterThan(1);
    // Both app and package populations are represented, so a regression that only reaches the
    // `apps/**` half (the half no other daemon-lane gate can see) cannot hide.
    expect(mirrors.some((m) => m.where.includes("/apps/control-room/"))).toBe(true);
    expect(mirrors.some((m) => m.where.includes("/packages/control-room-client/"))).toBe(true);
    expect(mirrors.filter((m) => m.hex !== current)).toEqual([]);
  });

  it("DETECTS a stale mirror -- the negative control this census would be vacuous without", () => {
    // A green census over a healthy tree cannot distinguish "every mirror is current" from "the
    // detector sees nothing at all". A mutation drill cannot settle it either: the census reads
    // FILE BYTES, so a process-local transform never reaches it, and mutating a real mirror on a
    // shared worktree is forbidden mid-delivery. So the detector is run against a corpus built
    // here, holding one current mirror and one stale one, in each of the two shapes it knows.
    const root = mkdtempSync(join(tmpdir(), "moe-digest-census-"));
    try {
      const current = "a".repeat(64);
      const stale = "b".repeat(64);
      writeFileSync(join(root, "current.tsx"), `  contractSchemaHash: "${current}",\n`, "utf8");
      writeFileSync(join(root, "stale.tsx"), `  contractSchemaHash: "${stale}",\n`, "utf8");
      writeFileSync(join(root, "stale-const.ts"), `const CONTRACT_DIGEST = "${stale}";\n`, "utf8");
      const found = digestMirrors([root]);
      expect(found.length).toBe(3);
      expect(found.filter((m) => m.hex !== current).map((m) => m.where.split("/").pop()).sort())
        .toEqual(["stale-const.ts:1", "stale.tsx:1"]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
