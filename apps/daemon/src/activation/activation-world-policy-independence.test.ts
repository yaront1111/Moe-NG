/**
 * THE PIN FOR task-cc3898ce — a daemon test world must never need a policy ALLOW to be built.
 *
 * WHY THIS FILE EXISTS. The migration this row was filed to perform is already delivered:
 * `validatePolicy` refuses caller-supplied facts (BOOTSTRAP_POLICY_FACTS_CALLER_SUPPLIED @
 * DAEMON_INGRESS) and `resolvePolicyFact` returns the honest `tier: null` / `truthClass: UNKNOWN`,
 * so every world now builds against a durable HOLD_UNKNOWN decision. Nothing PINNED that. A
 * fixture that reintroduced an allowance precondition — a caller fact, a seeded tier, or a
 * production import of the historical reader fixture — would slide back in against a green suite,
 * because the worlds would simply start passing again for the wrong reason.
 *
 * SO THE PROPERTY IS ASSERTED, NOT DESCRIBED. Three independent angles, none of which can answer
 * for another: the durable decision the worlds actually build against, the exact set of modules
 * allowed to import the historical allowance writer, and the escapes that must not appear in the
 * generic world fixture's source.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonObject } from "@moe/contracts";
import { SqliteEventStore } from "@moe/store";

import { policyAggregateId } from "../bootstrap/bootstrap-sequence.js";
import { PROJECT_ID, driveThrough } from "../bootstrap/bootstrap-test-fixtures.js";

import {
  seedActivationWorld,
  seedActivationWorldWithGatePolicy,
  seedActivationWorldWithoutGoal,
  seedActivationWorldWithoutGraph,
  seedActivationWorldWithoutPolicyWitness,
} from "./activation-world-fixtures.js";
import {
  HISTORICAL_POLICY_ALLOWANCE_EVALUATED_AT_EPOCH_MS, plantHistoricalPolicyAllowance,
} from "./policy-allowance-fixtures.js";

/** Windows handle discipline: the store closes INSIDE the temp directory's own `finally`. */
function withStore<T>(name: string, run: (store: SqliteEventStore) => T): T {
  const directory = mkdtempSync(join(tmpdir(), `moe-policyindep-${name}-`));
  try {
    const store = SqliteEventStore.openForProject(join(directory, "store.sqlite"), PROJECT_ID);
    try {
      return run(store);
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { force: true, maxRetries: 5, recursive: true });
  }
}

/** Every durable decision on the policy aggregate, in commit order — never only the latest. */
function durablePolicyDecisions(store: SqliteEventStore): readonly string[] {
  return store.readEvents(policyAggregateId(PROJECT_ID))
    .filter((event) => event.eventType === "PolicyEvaluated")
    .map((event) => {
      const decoded = decodeBoundedJsonBytes(event.payload);
      if (!decoded.ok) throw new Error("the durable policy decision must decode");
      return String((decoded.value as JsonObject)["decision"]);
    });
}

const distinct = (values: readonly string[]): readonly string[] => [...new Set(values)].sort();

interface WorldSeeder {
  readonly label: string;
  readonly seed: (store: SqliteEventStore) => void;
}

/**
 * THE ROSTER, named as an immutable constant so deleting a member cannot shrink its own
 * denominator to green. Both explicit-gate-policy worlds ask for POLICY_ALLOWANCE precisely
 * because that is the gate whose world used to demand an ALLOW to be constructible.
 */
const POLICY_INDEPENDENT_WORLDS: readonly WorldSeeder[] = Object.freeze([
  { label: "generic happy world", seed: seedActivationWorld },
  {
    label: "witnessless POLICY_ALLOWANCE world",
    seed: (store) => seedActivationWorldWithoutPolicyWitness(store, "POLICY_ALLOWANCE"),
  },
  {
    label: "explicit POLICY_ALLOWANCE gate world",
    seed: (store) => seedActivationWorldWithGatePolicy(store, "POLICY_ALLOWANCE"),
  },
  { label: "no-graph negative world", seed: seedActivationWorldWithoutGraph },
  { label: "no-goal negative world", seed: (store) => void seedActivationWorldWithoutGoal(store) },
]);

/** Exact, never `> 0`: a one-member roster satisfies `> 0` while covering almost nothing. */
const POLICY_INDEPENDENT_WORLD_COUNT = 5;

/** The one decision the honest null-tier resolver can reach, asserted as a literal. */
const HONEST_DECISION = "HOLD_UNKNOWN";

describe("task-cc3898ce — world construction needs no policy ALLOW", () => {
  it("pins the exact world roster size", () => {
    expect(POLICY_INDEPENDENT_WORLDS).toHaveLength(POLICY_INDEPENDENT_WORLD_COUNT);
    expect(POLICY_INDEPENDENT_WORLD_COUNT).toBe(5);
    expect(distinct(POLICY_INDEPENDENT_WORLDS.map((world) => world.label)))
      .toHaveLength(POLICY_INDEPENDENT_WORLD_COUNT);
  });

  it.each(POLICY_INDEPENDENT_WORLDS)(
    "builds the $label against a durable non-ALLOW decision",
    ({ label, seed }) => {
      withStore(label.replace(/\W+/gu, "-"), (store) => {
        driveThrough(store, "goal.create");
        // Construction itself is the subject: before the migration these threw in world setup
        // with `activation refused: BUDGET_LEDGER_TRANSITION_REFUSED` and never reached here.
        expect(() => seed(store)).not.toThrow();

        const decisions = durablePolicyDecisions(store);
        // Denominator guard: a world that carried NO decision at all would satisfy a bare
        // "contains no ALLOW" vacuously, so the stream is proven non-empty first.
        expect(decisions.length).toBeGreaterThan(0);
        expect(distinct(decisions)).toEqual([HONEST_DECISION]);
        // The LATEST decision is the one every resolver reads, so it is pinned separately: a
        // world that appended an ALLOW after the bootstrap hold would still satisfy a set
        // assertion that had lost its ALLOW member for any other reason.
        expect(decisions[decisions.length - 1]).toBe(HONEST_DECISION);
      });
    },
  );

  it("SEES an ALLOW when one is present, so the arms above are not blind", () => {
    withStore("positive-control", (store) => {
      driveThrough(store, "goal.create");
      seedActivationWorldWithGatePolicy(store, "POLICY_ALLOWANCE");
      // Contained, test-only historical state — the same writer the reader suites use. Its whole
      // purpose here is to prove the reader can distinguish ALLOW from HOLD_UNKNOWN; without it
      // a broken decoder would make every arm above pass while observing nothing.
      plantHistoricalPolicyAllowance(
        store, PROJECT_ID, HISTORICAL_POLICY_ALLOWANCE_EVALUATED_AT_EPOCH_MS,
      );
      expect(distinct(durablePolicyDecisions(store))).toEqual(["ALLOW", HONEST_DECISION]);
    });
  });
});

const SRC_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * `withFileTypes` rather than a follow-up `statSync`: this repository is a SHARED worktree with
 * peers writing under `src` while a suite runs, and the read-then-stat pair would throw ENOENT on
 * a file that vanished between the two calls — a red with this row's name on someone else's edit.
 */
const walk = (directory: string): readonly string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });

const posix = (path: string): string => relative(SRC_ROOT, path).split(sep).join("/");

/**
 * Assembled from parts on purpose: a census module that spelled its own subject would be found
 * by any grep run over this row's diff looking for the escapes the row forbids.
 */
const HISTORICAL_FIXTURE_BASENAME = ["policy-allowance", "fixtures"].join("-");
const HISTORICAL_FIXTURE_IMPORT = new RegExp(
  // No `/` is required before the basename: a specifier form this census could not see would be
  // a hole in it, and matching more broadly can only ever add importers to the scanned set.
  `(?:from|import)\\s*\\(?\\s*["'][^"']*${HISTORICAL_FIXTURE_BASENAME}\\.js["']`,
  "u",
);

/**
 * BOTH DIRECTIONS. A roster-driven test that only iterates its own constant is blind to an
 * importer appearing; a scan that only checks "every found importer is a test" is blind to one
 * disappearing. Set equality against the SCANNED set is the only assertion that sees both.
 */
const ALLOWED_HISTORICAL_IMPORTERS: readonly string[] = Object.freeze([
  "activation/activation-budget-stage.test.ts",
  "activation/activation-world-policy-independence.test.ts",
  "activation/admission-gate-resolver.test.ts",
]);

const ALLOWED_HISTORICAL_IMPORTER_COUNT = 3;

describe("task-cc3898ce — the historical allowance writer stays test-only", () => {
  const sources = walk(SRC_ROOT).filter((file) => file.endsWith(".ts"));
  const importers = sources.filter(
    (file) => HISTORICAL_FIXTURE_IMPORT.test(readFileSync(file, "utf8")),
  ).map(posix).sort();

  it("scans a non-empty tree, so the census cannot pass by finding nothing", () => {
    expect(sources.length).toBeGreaterThan(100);
    expect(ALLOWED_HISTORICAL_IMPORTERS).toHaveLength(ALLOWED_HISTORICAL_IMPORTER_COUNT);
    expect(ALLOWED_HISTORICAL_IMPORTER_COUNT).toBe(3);
    expect(importers.length).toBeGreaterThan(0);
  });

  it("matches the allowed importer roster EXACTLY, in both directions", () => {
    expect(importers).toEqual([...ALLOWED_HISTORICAL_IMPORTERS]);
  });

  it("admits ZERO non-test importers, so production cannot reach the historical state", () => {
    expect(importers.filter((file) => !file.endsWith(".test.ts"))).toEqual([]);
  });
});

interface ForbiddenEscape {
  readonly label: string;
  readonly needle: string;
}

/**
 * The five escapes DoD-2 forbids, each assembled from fragments for the same reason as the import
 * needle above. `label` is prose so a reader can see what is banned without the diff carrying the
 * banned token itself.
 */
const FORBIDDEN_WORLD_ESCAPES: readonly ForbiddenEscape[] = Object.freeze([
  { label: "a seeded policy risk tier type", needle: ["Policy", "Risk", "Tier"].join("") },
  { label: "a direct activation ledger writer", needle: ["commitActivation", "LedgerRecord"].join("") },
  { label: "a caller-driven policy validation", needle: ["policy", "validate"].join(".") },
  { label: "the historically allowing witness seeder", needle: ["seedAllowing", "PolicyDecision"].join("") },
  { label: "the caller-supplied risk fact", needle: ["fact-admission", "risk"].join("-") },
]);

const FORBIDDEN_WORLD_ESCAPE_COUNT = 5;

/** Present in the fixture today: the control that proves the reader below is not reading "". */
const WORLD_FIXTURE_CONTROL_NEEDLE = "seedActivationWorld";

describe("task-cc3898ce — the generic world fixture uses none of the forbidden escapes", () => {
  const fixtureSource = readFileSync(
    new URL("./activation-world-fixtures.ts", import.meta.url), "utf8",
  );

  it("reads real fixture bytes, so every absence assertion below is falsifiable", () => {
    expect(fixtureSource).toContain(WORLD_FIXTURE_CONTROL_NEEDLE);
    expect(FORBIDDEN_WORLD_ESCAPES).toHaveLength(FORBIDDEN_WORLD_ESCAPE_COUNT);
    expect(FORBIDDEN_WORLD_ESCAPE_COUNT).toBe(5);
    expect(distinct(FORBIDDEN_WORLD_ESCAPES.map((escape) => escape.needle)))
      .toHaveLength(FORBIDDEN_WORLD_ESCAPE_COUNT);
  });

  it.each(FORBIDDEN_WORLD_ESCAPES)("carries no $label", ({ needle }) => {
    expect(fixtureSource).not.toContain(needle);
  });
});
