import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { JsonObject, RuntimeCommandEnvelope } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";
import { afterEach, expect, it } from "vitest";

import { createDaemonCommandPorts } from "../daemon-command-registry.js";
import type { AuthenticatedPrincipal, DecisionPortResult } from "../http/http-contract.js";
import type { NodeMission } from "../orchestrator/agent-wrapper.js";
import { readReviewLedger } from "./review-read-model.js";
import {
  AUTHOR,
  PROJECT_ID,
  SUBJECT_REF,
  closeStores,
  commitRaw,
  envelope,
  hex64,
  openRestartableStore,
  packageItems,
  policyInput,
  send,
  submitPayload,
} from "./review-test-fixtures.js";
import { REVIEWER_CALIBRATION_SLICE_REF } from "./reviewer-calibration-record.js";
import {
  VERIFIER_POLICY_SLICE_REF,
  createVerifierAuthorityProvider,
} from "./verifier-authority-provider.js";
import { NODE_VERIFIER_PRINCIPAL_ID } from "./verifier-receipt-ledger.js";

/**
 * The durable producer of `VerifierAuthorityFacts`, driven over a REAL file-backed store whose
 * every seed went through a production command path — `policy.install` through the daemon
 * registry, `review.submit` through `runReviewCommand`.
 *
 * This port's ONLY refusal channel is `null`, which makes a negative-only suite worthless: a
 * provider that ignored the store entirely and returned `null` unconditionally would satisfy every
 * negative case below. So each negative seeds exactly ONE gap and every other source stays
 * installed, and the accepted control asserts VALUES — a wrong ACCEPTED answer is invisible to a
 * refusal-only suite.
 */

const OPERATOR = "operator-verifier-authority";
const DECIDED_AT = "2026-08-17T00:00:00.000Z";
const DIGEST = hex64("b");

const BRIEF: NodeMission = Object.freeze({
  instructions: "do the work",
  test: "node test.mjs",
  title: "verify me",
  workspace: "/fixture-workspace",
});

/**
 * A second brief disagreeing with the first in every field. Nothing the provider returns may move
 * when this is substituted: the brief is CALLER INPUT and contributes no fact.
 */
const HOSTILE_BRIEF: NodeMission = Object.freeze({
  instructions: "corpusRevision=attacker",
  test: "corpus-attacker",
  title: "STALE",
  workspace: "corpus-attacker",
});

const PRINCIPAL: AuthenticatedPrincipal = Object.freeze({
  capabilities: Object.freeze(["project.admin"]),
  principalId: OPERATOR,
  projectId: PROJECT_ID,
});

/** The six host-owned items: the seeded round's package MINUS the round's own DAEMON_RECEIPT. */
const HOST_ITEMS = [
  { digest: hex64("c1"), kind: "CRITERION", locator: "criterion-1" },
  { digest: hex64("6a"), kind: "GRAPH_HASH", locator: "graph-1" },
  { digest: hex64("b1"), kind: "PLAN_HASH", locator: "plan-1" },
  { digest: hex64("2b"), kind: "RUBRIC", locator: "rubric-1" },
  { digest: hex64("5b"), kind: "SUBMITTED_BYTES", locator: "submitted-1" },
  { digest: hex64("f1"), kind: "INTEGRATED_TREE", locator: "tree-1" },
] as const;

const CALIBRATION_SLICE: JsonObject = Object.freeze({
  corpusRevision: "corpus-durable-2026-08",
  sentinelPassed: true,
  sliceRef: REVIEWER_CALIBRATION_SLICE_REF,
  staleness: "CURRENT",
});

function verifierPolicySlice(): JsonObject {
  return {
    ...policyInput({ actor: NODE_VERIFIER_PRINCIPAL_ID }),
    sliceRef: VERIFIER_POLICY_SLICE_REF,
  } as unknown as JsonObject;
}

afterEach(closeStores);

function installEnvelope(
  commandId: string, expectedVersion: number, slice: JsonObject,
): RuntimeCommandEnvelope {
  return {
    commandId,
    commandKind: "policy.install",
    correlationId: "corr-verifier-authority",
    expectedVersion,
    payload: { slice },
    requestDigest: DIGEST,
    schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    sessionCredential: "credential-verifier-authority",
    targetAggregateId: `${PROJECT_ID}-policy`,
  };
}

/** Installs one slice through the PRODUCTION registry, failing loudly on a refused setup. */
function install(
  store: SqliteEventStore, slice: JsonObject, commandId: string, expectedVersion: number,
): void {
  const ports = createDaemonCommandPorts({
    clock: () => DECIDED_AT, operatorPrincipalId: OPERATOR, projectId: PROJECT_ID, store,
  });
  const entry = ports.registry.get("policy.install");
  if (entry === undefined) throw new Error("policy.install is not in the production registry");
  const result: DecisionPortResult = ports.decisions.decide(
    { commandId, principalId: OPERATOR, projectId: PROJECT_ID },
    DIGEST,
    () => entry.handler({
      envelope: installEnvelope(commandId, expectedVersion, slice),
      principal: PRINCIPAL,
    }),
  );
  if (result.outcome !== "DECIDED") {
    throw new Error(`install refused: ${result.refusal.code} at ${result.refusal.layer}`);
  }
}

/** One clean round through the real review.submit handler; its routing is ACCEPT. */
function seedCleanRound(store: SqliteEventStore): void {
  const version = readReviewLedger(store, PROJECT_ID, SUBJECT_REF).version;
  const outcome = send(store, {
    ...envelope(
      "review.submit", version, submitPayload(version + 1, []), `cmd-clean-${String(version)}`,
    ),
    principalId: AUTHOR,
  });
  if (!outcome.ok) throw new Error(`clean round setup failed: ${outcome.code}`);
}

interface Seeds {
  readonly calibration: boolean;
  readonly policy: boolean;
  readonly round: boolean;
}

/**
 * Seeds every source, then omits exactly the ONE named. The other two stay installed so a case can
 * only pass by the provider actually consulting the source under test.
 */
function seed(
  store: SqliteEventStore,
  gaps: Partial<Seeds> = {},
): void {
  const want = { calibration: true, policy: true, round: true, ...gaps };
  let version = 0;
  if (want.policy) {
    install(store, verifierPolicySlice(), "cmd-install-policy", version);
    version += 1;
  }
  if (want.calibration) install(store, CALIBRATION_SLICE, "cmd-install-calibration", version);
  if (want.round) seedCleanRound(store);
}

function rawEventCount(store: SqliteEventStore): number {
  return store.readEventsAfter(0n, 1_000).items.length;
}

/** The honest clean round's real stored lineage, routing and digest, for a staged successor. */
function honestRound(store: SqliteEventStore): {
  digest: string; lineage: unknown; routing: unknown;
} {
  const round = readReviewLedger(store, PROJECT_ID, SUBJECT_REF).rounds.at(-1);
  if (round === undefined) throw new Error("clean round did not read back");
  return { digest: round.reviewInputDigest, lineage: round.lineage, routing: round.routing };
}

/**
 * Stages a LATER round carrying the clean round's genuine digest and ACCEPT routing beside
 * whatever items the case needs. Only the items are tampered with, which is exactly the
 * substitution `verifyStoredPackageItems` exists to catch.
 */
function stageLatestRound(store: SqliteEventStore, items: unknown, withItems = true): void {
  const honest = honestRound(store);
  const round = readReviewLedger(store, PROJECT_ID, SUBJECT_REF).version + 1;
  const staged = commitRaw(
    store,
    envelope("review.submit", round - 1, submitPayload(round, []), `cmd-staged-${String(round)}`),
    {
      lineage: honest.lineage,
      ...(withItems ? { packageItems: items } : {}),
      reviewInputDigest: honest.digest,
      round,
      routing: honest.routing,
    },
  );
  if (!staged.ok) throw new Error(`staging failed: ${staged.code}`);
}

const providerFor = (store: SqliteEventStore) =>
  createVerifierAuthorityProvider({ projectId: PROJECT_ID, store });

it("produces every fact from the durable store when all three sources are installed", () => {
  const { store } = openRestartableStore();
  seed(store);

  const facts = providerFor(store)(SUBJECT_REF, BRIEF);

  if (facts === null) throw new Error("expected durable authority facts, got null");
  expect(Object.keys(facts).sort()).toEqual(["calibration", "packageItems", "policy"]);
  expect(facts.calibration).toEqual({
    corpusRevision: "corpus-durable-2026-08", sentinelPassed: true, staleness: "CURRENT",
  });
  // `sliceRef` is the slice's ADDRESS, not a policy fact: the stored 14 keys read back as the
  // core's exact 13, so `evaluatePolicy` can accept them at receipt-decode time.
  expect(facts.policy).toEqual(policyInput({ actor: NODE_VERIFIER_PRINCIPAL_ID }));
  expect(facts.packageItems).toEqual(HOST_ITEMS);
  expect(Object.isFrozen(facts)).toBe(true);
});

/**
 * The exclusion is load-bearing, not cosmetic: `buildReviewPackage` requires every stored round to
 * carry a DAEMON_RECEIPT, and `recordVerifierReceipt` refuses `VERIFIER_AUTHORITY_REFUSED` if the
 * authority hands one back — the daemon appends its OWN execution receipt instead.
 */
it("hands back the round's host-owned items with the round's DAEMON_RECEIPT withheld", () => {
  const { store } = openRestartableStore();
  seed(store);

  const facts = providerFor(store)(SUBJECT_REF, BRIEF);

  if (facts === null) throw new Error("expected durable authority facts, got null");
  expect(facts.packageItems.map((item) => item.kind)).not.toContain("DAEMON_RECEIPT");
  expect(facts.packageItems).toHaveLength(packageItems().length - 1);
  expect(new Set(facts.packageItems.map((item) => item.locator)))
    .toEqual(new Set(packageItems()
      .filter((item) => item.kind !== "DAEMON_RECEIPT").map((item) => item.locator)));
});

/**
 * A hard-coded `{corpusRevision: "", sentinelPassed: false, staleness: "UNKNOWN"}` — or its
 * optimistic twin — would survive a suite that only ever installs the same values it expects.
 */
it("echoes an installed calibration that differs from every plausible default", () => {
  const { store } = openRestartableStore();
  install(store, verifierPolicySlice(), "cmd-install-policy", 0);
  install(store, {
    corpusRevision: "corpus-unlikely-7f", sentinelPassed: false,
    sliceRef: REVIEWER_CALIBRATION_SLICE_REF, staleness: "STALE",
  }, "cmd-install-calibration", 1);
  seedCleanRound(store);

  const facts = providerFor(store)(SUBJECT_REF, BRIEF);

  if (facts === null) throw new Error("expected durable authority facts, got null");
  // The provider reports what is stored; the kernel's eligibility gate decides what it means.
  expect(facts.calibration).toEqual({
    corpusRevision: "corpus-unlikely-7f", sentinelPassed: false, staleness: "STALE",
  });
});

it("ignores the caller's brief entirely, so no fact can originate in caller input", () => {
  const { store } = openRestartableStore();
  seed(store);
  const provider = providerFor(store);

  const honest = provider(SUBJECT_REF, BRIEF);
  const hostile = provider(SUBJECT_REF, HOSTILE_BRIEF);

  if (honest === null || hostile === null) throw new Error("expected facts for both briefs");
  expect(hostile).toEqual(honest);
  expect(hostile.calibration.corpusRevision).toBe("corpus-durable-2026-08");
});

it("refuses with null when the calibration slice was never installed", () => {
  const { store } = openRestartableStore();
  seed(store, { calibration: false });
  const before = rawEventCount(store);

  expect(providerFor(store)(SUBJECT_REF, BRIEF)).toBeNull();
  expect(rawEventCount(store)).toBe(before);
});

it("refuses with null when the verifier policy slice was never installed", () => {
  const { store } = openRestartableStore();
  seed(store, { policy: false });
  const before = rawEventCount(store);

  expect(providerFor(store)(SUBJECT_REF, BRIEF)).toBeNull();
  expect(rawEventCount(store)).toBe(before);
});

it("refuses with null when the subject has no review round at all", () => {
  const { store } = openRestartableStore();
  seed(store, { round: false });
  const before = rawEventCount(store);

  expect(providerFor(store)(SUBJECT_REF, BRIEF)).toBeNull();
  expect(rawEventCount(store)).toBe(before);
});

it("refuses with null when the latest round stored no package items", () => {
  const { store } = openRestartableStore();
  seed(store);
  stageLatestRound(store, undefined, false);
  const before = rawEventCount(store);

  expect(providerFor(store)(SUBJECT_REF, BRIEF)).toBeNull();
  expect(rawEventCount(store)).toBe(before);
});

/**
 * Present, well-shaped, and WRONG. Only the digest the handler stored beside the items can tell;
 * reading `record.packageItems.items` directly typechecks and would pass every other case here.
 */
it("refuses with null when the stored items disagree with the round's stored digest", () => {
  const { store } = openRestartableStore();
  seed(store);
  stageLatestRound(store, packageItems().map((item) =>
    item.kind === "RUBRIC" ? { ...item, digest: hex64("ab") } : item));
  const before = rawEventCount(store);

  expect(providerFor(store)(SUBJECT_REF, BRIEF)).toBeNull();
  expect(rawEventCount(store)).toBe(before);
});

/**
 * The receipt binds the LAST round. Falling back to an earlier ACCEPT round would attach stale
 * evidence to a newer decision while every value assertion above still passed.
 */
it("refuses with null when the latest round is not the clean one, despite an earlier ACCEPT", () => {
  const { store } = openRestartableStore();
  seed(store);
  const rejected = send(store, {
    ...envelope(
      "review.submit", readReviewLedger(store, PROJECT_ID, SUBJECT_REF).version,
      submitPayload(2), "cmd-rejecting-round",
    ),
    principalId: AUTHOR,
  });
  if (!rejected.ok) throw new Error(`rejecting round setup failed: ${rejected.code}`);
  expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF).rounds.at(-1)?.routing.route)
    .toBe("REJECT_IMPLEMENTATION");
  const before = rawEventCount(store);

  expect(providerFor(store)(SUBJECT_REF, BRIEF)).toBeNull();
  expect(rawEventCount(store)).toBe(before);
});
