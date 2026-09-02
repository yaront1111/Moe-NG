/**
 * HOSTILE COVERAGE — the INTEGRITY axis of the declared-boundary roster.
 *
 * Satisfies the `integrity` axis of the coverage ratchet owned by
 * task-3b1cbdf9bd39405bb32230552d3ab242, which will later assert that every roster entry
 * resolves to a real BEFORE/AFTER/RACE case. Completeness is this slice's obligation, not
 * the ratchet's to discover, so the sweep below compares its covered set against the roster
 * in BOTH directions rather than against a hand-kept list.
 *
 * THE SUBSET COMES FROM THE ROSTER, NOT FROM THE TASK DESCRIPTION. The description named
 * eighteen constants; the roster tags thirteen onto this axis and re-tagged members in both
 * directions — SESSION_AUTH_LAYERS and SESSION_AUTHORITY_DAEMON_LAYERS moved here from
 * transport, while the expansion, supersession, goal, import and graph-revision constants
 * the description listed belong to sibling slices. Reconciling the two lists would have
 * produced a gap and an overlap at once, so only the roster counts.
 *
 * THE ROSTER IS READ FROM ITS COMMITTED BYTES. `BOUNDARY_ROSTER` is not exported, so this
 * file parses the artifact rather than importing a copy — the stronger of the two: it
 * reddens if the roster re-tags a member, and it cannot drift. The parse asserts its own
 * yield, so a regex that silently matched nothing reddens instead of passing vacuously.
 *
 * FORGERY IS THE CENTRAL MOVE ON THIS AXIS, and it is asserted in TWO HALVES. Every boundary
 * here guards a digest, a codec or an authority record, so a probe that mutated a field and
 * left the seal stale would test the seal and nothing else — it would pass against an
 * implementation with no subject binding whatsoever. Each forgery case therefore re-seals
 * through the production path and carries an `integrity` thunk; the suite asserts that thunk
 * resolves `ok: true` BEFORE asserting the refusal, so a case that quietly stopped resealing
 * reddens on the first half rather than passing as a digest mismatch in disguise.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { assertRefusedWith, cleanupHostileRoots } from "./hostile-harness.js";
import type { LegOutcome } from "./hostile-harness.js";
import {
  INTEGRITY_HOSTILE_CASES, cleanupRestoreHarnesses, openedStores,
} from "./integrity-hostile-cases.js";
import type { HostileArm, HostileCase } from "./integrity-hostile-cases.js";
import {
  PROJECT_INTEGRITY_HOSTILE_CASES,
  projectIntegrityControls,
} from "./project-integrity-hostile-cases.js";
import {
  POLICY_SLICE_HOSTILE_CASES,
  policySliceDigestPositiveControl,
} from "./policy-slice-hostile-cases.js";
import { RECENT_INTEGRITY_HOSTILE_CASES } from "./recent-integrity-hostile-cases.js";
import { RECENT_CORE_CONTRACT_HOSTILE_CASES } from "./recent-core-contract-hostile-cases.js";

const LANE_ROOT = dirname(fileURLToPath(import.meta.url));
const ROSTER_FILE = join(LANE_ROOT, "boundary-roster.security.ts");

/** Matches one single-line roster entry tagged onto this axis. */
const INTEGRITY_ENTRY =
  /\{\s*constant:\s*"([A-Za-z0-9_]+)",\s*file:\s*"[^"]+",\s*axis:\s*"integrity"\s*\}/gu;

function rosterIntegrityConstants(): readonly string[] {
  const source = readFileSync(ROSTER_FILE, "utf8");
  return Object.freeze([...source.matchAll(INTEGRITY_ENTRY)].map((match) => match[1] ?? ""));
}

const ROSTER_INTEGRITY = rosterIntegrityConstants();
const HOSTILE_CASES: readonly HostileCase[] = Object.freeze([
  ...INTEGRITY_HOSTILE_CASES,
  ...PROJECT_INTEGRITY_HOSTILE_CASES,
  ...POLICY_SLICE_HOSTILE_CASES,
  ...RECENT_INTEGRITY_HOSTILE_CASES,
  ...RECENT_CORE_CONTRACT_HOSTILE_CASES,
]);
const COVERED = [...new Set(HOSTILE_CASES.map((entry) => entry.constant))];

const armsFor = (constant: string): readonly HostileArm[] =>
  HOSTILE_CASES.filter((entry) => entry.constant === constant).map((entry) => entry.arm);

/**
 * A conservative net for "this hostile input was ADMITTED". It names success shapes only, so
 * a refusal can never satisfy it and an unrecognised shape is not silently counted as a
 * pass. `authority` above NONE and `truth` above UNKNOWN are named explicitly because three
 * boundaries on this axis report their verdict that way rather than through `ok`.
 */
const ADMITTED_OUTCOMES = new Set(["ACCEPTED", "CURRENT", "OPENED", "PROPOSED", "SELECTED"]);

function admitted(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record["ok"] === true) return true;
  if (typeof record["authority"] === "string" && record["authority"] !== "NONE") return true;
  if (typeof record["truth"] === "string" && record["truth"] !== "UNKNOWN") return true;
  return typeof record["outcome"] === "string"
    && ADMITTED_OUTCOMES.has(record["outcome"]);
}

/** Every outcome this slice produced, so the whole-slice invariant sees all of them. */
const collected: unknown[] = [];

const legValue = (leg: LegOutcome<unknown>): unknown =>
  leg.status === "fulfilled" ? leg.value : leg.reason;

afterAll(() => {
  // Handles first: a held SQLite handle kills the vitest worker, and in a
  // `fileParallelism: false` lane that takes every file scheduled after this one with it.
  for (const store of openedStores) {
    try {
      store.close();
    } catch {
      // A store already closed by its own case must not turn teardown into a verdict.
    }
  }
  // Both registries: `hostileRoot` roots and the restore harness's own, which the shared
  // harness cannot see. Neither call throws, so one leak can never suppress the other.
  cleanupHostileRoots();
  cleanupRestoreHarnesses();
});

describe("integrity axis versus the declared-boundary roster", () => {
  it("reads a positive number of integrity entries off the roster", () => {
    // A silently-zero parse would make every set assertion below pass vacuously.
    expect(ROSTER_INTEGRITY.length).toBeGreaterThan(0);
    // 14 -> 15 for ACCEPTANCE_CONTRACT_LAYERS (task-2ce5411e), whose three arms land with
    // this bump. The pin is the true roster count, never the covered count: raising it
    // without the arms would redden the three-armed assertion instead of hiding anything.
    // 15 -> 16 for PLAN_REVISION_LAYERS (producer task-9fe1a0e0, governor entry), whose
    // three arms land with this bump for the same reason.
    // 16 -> 17 for FOUNDATION_REPOSITORY_SCOPE_LAYERS (producer task-4af0e3dc), the
    // daemon-startup repository/scope catalog, whose three arms land with this bump.
    // 17 -> 19 for NODE_AUTHORITY_LAYERS and NODE_AUTHORITY_RECURSION_LAYERS
    // (task-515d2f90, cashing producer task-210efa47's deferral), the canonical node-body
    // codec and the recursion digest that feed GraphRevisionContent v3. Axis by human REPL
    // ruling, comment-2a7c5a33; both boundaries' three arms land with this bump.
    // 19 -> 20 for CONFIRMATORY_FREEZE_AUTHORITY_LAYER (producer task-22b69ee5, which mints the
    // constant and lands this bump with its three arms). The unusual member of this axis: a
    // WITHHELD custody/signing authority whose reader has no granted arm at all, tagged
    // `integrity` by SUBJECT — it names an authority record, the same reading that put
    // NODE_AUTHORITY_LAYERS here under the human REPL ruling comment-2a7c5a33, and the reading
    // this slice's own `admitted()` net already assumes where it reads `authority !== "NONE"`.
    // 20 -> 21 for PRE_FREEZE_AUDIT_LAYER, the pinned-document integrity audit. Its
    // verdict builder's BEFORE/AFTER/RACE probes land with this bump.
    // 21 -> 23 for PRODUCT_CONTRACT_LAYERS and DECISION_LEDGER_LAYER, two canonical
    // integrity codecs. Product Contract also carries a production re-seal control.
    // 23 -> 24 for POLICY_SLICE_DIGEST_LAYERS, the canonical policy-slice identity
    // derivation. Its public production call supplies the positive control below.
    // 25 -> 31 on 2026-09-02 for the six v2/foundation contract boundaries the ratchet caught
    // unrostered (CAPABILITY_CATALOG_LAYERS, DELIVERY_PROFILE_LAYERS,
    // EXECUTION_ISOLATION_PROFILE_LAYERS, VERIFICATION_RECIPE_LAYERS, SOURCE_SNAPSHOT_LAYERS
    // and the runner's RUNNER_SOURCE_SNAPSHOT_GIT_LAYER): codecs and a revision-binding
    // check, `integrity` by SUBJECT, whose eighteen arms land with this bump in
    // recent-core-contract-hostile-cases.ts.
    expect(ROSTER_INTEGRITY).toHaveLength(31);
  });

  it("covers every integrity boundary the roster declares (roster minus covered is empty)", () => {
    const covered = new Set(COVERED);
    expect(ROSTER_INTEGRITY.filter((constant) => !covered.has(constant))).toEqual([]);
  });

  it("covers no boundary outside the integrity axis (covered minus roster is empty)", () => {
    const rostered = new Set(ROSTER_INTEGRITY);
    expect(COVERED.filter((constant) => !rostered.has(constant))).toEqual([]);
  });

  it.each(ROSTER_INTEGRITY.map((constant) => [constant]))(
    "generates a positive, three-armed case count for %s",
    (constant: string) => {
      const arms = armsFor(constant);
      // The count assertion is what makes a boundary that generated NOTHING redden.
      expect(arms.length).toBeGreaterThan(0);
      expect(arms).toContain("BEFORE");
      expect(arms).toContain("AFTER");
      expect(arms).toContain("RACE");
    },
  );

  it("re-seals at least one forgery per boundary that accepts carried integrity material", () => {
    const resealed = HOSTILE_CASES.filter(
      (entry) => entry.arm !== "RACE" && entry.integrity !== undefined,
    ).map((entry) => entry.constant);
    // Asserted as a set with a positive count, so a forgery quietly dropped from the table
    // reddens here rather than shrinking the slice in silence.
    expect(resealed.length).toBeGreaterThan(0);
    expect([...new Set(resealed)].sort()).toEqual([
      "ACCEPTANCE_CONTRACT_LAYERS",
      "APPROVAL_AUTHORITY_LAYERS",
      // task-3a10eb6b: the authority record has no digest yet, but its AFTER forgery still
      // owes the same two-part production recheck before the exact foreign-scope refusal.
      "CONFIRMATORY_FREEZE_AUTHORITY_LAYER",
      "DISTRIBUTION_REFUSAL_LAYERS",
      "DOCUMENT_WORK_PROPOSAL_LAYERS",
      // Added with the FOUNDATION_REPOSITORY_SCOPE_LAYERS arms (producer task-4af0e3dc):
      // the catalog is digest-sealed over its own admitted fields, so it owes a forgery.
      "FOUNDATION_REPOSITORY_SCOPE_LAYERS",
      // Added by task-66004424 with the GRAPH_CONTENT_LAYERS arms. This literal is TIGHTENED,
      // not loosened: the graph-content codec is digest-bearing, so it owes a forgery here,
      // and omitting it would let the new `forged` arm redden a passing assertion.
      "GRAPH_CONTENT_LAYERS",
      // Added with the NODE_AUTHORITY arms (task-515d2f90). Both are digest-bearing and so
      // owe a forgery: the node-body codec seals a `bodyContentDigest` over the admitted
      // body, and a hard-edge dependency contract is sealed to ONE graph structure by its
      // `graphBindingDigest`. Each forgery re-passes its own production seal before the
      // refusal is asserted, so neither can degrade into a plain stale-digest probe.
      "NODE_AUTHORITY_LAYERS",
      "NODE_AUTHORITY_RECURSION_LAYERS",
      // Added with the PLAN_REVISION_LAYERS arms (producer task-9fe1a0e0, governor entry):
      // the plan-revision codec is digest-bearing (planHash), so it owes a forgery here.
      "PLAN_REVISION_LAYERS",
      // POLICY_SLICE_DIGEST_LAYERS is deliberately absent: it derives and returns a digest,
      // but accepts no caller-carried seal that a hostile case could truthfully re-seal.
      "PRODUCT_CONTRACT_LAYERS",
      "PROJECT_CONFIGURATION_SELECTION_LAYER",
      "RECOVERY_COMPLETION_LAYER",
      "REVIEW_DECISION_LAYERS",
      "SESSION_AUTH_LAYERS",
    ]);
  });

  it("pins both exact refusal tuples on the AcceptanceContract race", () => {
    const races = HOSTILE_CASES.filter(
      (entry): entry is Extract<HostileCase, { arm: "RACE" }> =>
        entry.arm === "RACE" && entry.constant === "ACCEPTANCE_CONTRACT_LAYERS",
    );
    expect(races).toHaveLength(1);
    expect(races.map((entry) => ({ left: entry.expectLeft, right: entry.expectRight }))).toEqual([{
      left: {
        code: "ACCEPTANCE_CONTRACT_NONCANONICAL",
        layer: "ACCEPTANCE_CONTRACT_CANONICALIZATION",
      },
      right: {
        code: "ACCEPTANCE_CONTRACT_DUPLICATE_KEY",
        layer: "ACCEPTANCE_CONTRACT_CODEC",
      },
    }]);
  });
});

describe("new canonical integrity boundaries admit their positive controls", () => {
  it("round-trips Product Contract and decision-leg bytes through production", () => {
    const controls = projectIntegrityControls();
    expect(controls.productRoundTrip).toBe(true);
    expect(controls.decisionRoundTrip).toBe(true);
    expect(controls.productDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(controls.decisionDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("derives a policy-slice digest through the public core surface", () => {
    const control = policySliceDigestPositiveControl();
    expect(control.ok).toBe(true);
    if (control.ok) {
      expect(control.digest).toMatch(/^[0-9a-f]{64}$/u);
      expect(Object.isFrozen(control)).toBe(true);
    }
  });
});

const refusalCases = HOSTILE_CASES.filter(
  (entry): entry is Extract<HostileCase, { arm: "AFTER" | "BEFORE" }> => entry.arm !== "RACE",
);
const raceCases = HOSTILE_CASES.filter(
  (entry): entry is Extract<HostileCase, { arm: "RACE" }> => entry.arm === "RACE",
);

describe("hostile before and after arms", () => {
  it.each(refusalCases.map((entry) => [`${entry.constant} ${entry.arm}: ${entry.name}`, entry]))(
    "%s",
    async (_name: string, entry: Extract<HostileCase, { arm: "AFTER" | "BEFORE" }>) => {
      if (entry.integrity !== undefined) {
        // HALF ONE of a forgery: the forged material still passes its own production
        // integrity check. Without this, the case below could be satisfied by a boundary
        // that only ever compares a digest and binds no subject at all.
        const sealed = await entry.integrity();
        expect(sealed.ok, `${entry.constant}: the forgery must pass its own seal`).toBe(true);
      }
      const outcome = await entry.run();
      collected.push(outcome);
      // HALF TWO, and the whole assertion for a non-forgery case. Both code AND layer,
      // through the shared helper: it rejects a code-only call at compile time and again at
      // runtime, so no slice can drift into the weak form.
      assertRefusedWith(outcome, entry.expect);
    },
  );
});

describe("hostile race arms", () => {
  it.each(raceCases.map((entry) => [`${entry.constant} RACE: ${entry.name}`, entry]))(
    "%s",
    async (_name: string, entry: Extract<HostileCase, { arm: "RACE" }>) => {
      // Bounded by the harness at 2s, far below MAX_BOUND_MS: a hang would report NO verdict,
      // and in a `fileParallelism: false` lane it would stall every later file.
      const outcome = await entry.run();
      const left = legValue(outcome.left);
      const right = legValue(outcome.right);
      collected.push(left, right);

      // ORDER-INDEPENDENT by construction: the assertion is on the OUTCOME SHAPE, never on
      // which leg won. A case that only passed when one side won would be a flake, and the
      // usual "fix" — pinning the order — destroys the property under test.
      expect(["left", "right"]).toContain(outcome.firstSettled);
      if (entry.expectLeft !== undefined || entry.expectRight !== undefined) {
        expect(entry.expectLeft).toBeDefined();
        expect(entry.expectRight).toBeDefined();
        assertRefusedWith(left, entry.expectLeft!);
        assertRefusedWith(right, entry.expectRight!);
      }
      // Per side, not on an aggregate: an aggregate can hide a double-admit, which is the one
      // defect a race case exists to find. Both legs here are hostile, so at most one side
      // could ever be admitted and in fact neither may be.
      expect([admitted(left), admitted(right)].filter(Boolean).length).toBeLessThanOrEqual(1);
      expect(admitted(left)).toBe(false);
      expect(admitted(right)).toBe(false);
    },
  );
});

describe("the whole slice", () => {
  it("never admits a manifest, issues a grant, or raises a truth class above UNKNOWN", () => {
    // One assertion over every collected outcome rather than one per case, so a case added
    // later cannot quietly escape the invariant.
    expect(collected.filter((outcome) => admitted(outcome))).toEqual([]);
  });

  it("collected an outcome from every case, so nothing escaped by not running", () => {
    expect(collected).toHaveLength(refusalCases.length + raceCases.length * 2);
  });
});
