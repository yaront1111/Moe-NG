/**
 * GATE 3 CLOSING WITHOUT A HUMAN: `release.decide` auto-approved on a gap-free criterion-bound
 * dossier, under a recorded standing opt-in, with a human still able to intervene and win.
 *
 * WHY NO ARM ASSERTS MERELY "IT REFUSED". Six conditions can decline an automatic approval and two
 * different surfaces answer them, so "no release happened" is one added layer away from vacuous: a
 * candidate-selection regression would decline every case and every arm would stay green while
 * nothing about policy was being tested. Every negative below asserts the CODE together with the
 * LAYER its map pairs it with, and the engine's own reason code where core answered.
 *
 * WHY THE POSITIVE ARMS ASSERT PROVENANCE VALUES, NOT THE VERDICT. A RELEASED receipt assertion
 * passes identically against a human approval, so on its own it would not test this row's subject.
 * What makes an automatic approval distinguishable is that the persisted receipt NAMES what it
 * acted under, so the positive arms assert `provenance.action` and `provenance.tier` AND that no
 * second `release.decide` decision exists in the journal.
 *
 * WHERE THE TIER COMES FROM, AND HOW THE NEGATIVES DRIVE IT. The subject tier is the goal's
 * planning-run tier, read through `readRunPolicyEvaluation` -- the journey's run evaluates to R1.
 * A tier is not spelled into these arms: the R2 and R3 negatives RAISE it through the installed
 * slice's own `riskClassifications`, which is the operator-facing mechanism and the same fold
 * `assessRisk` applies in production. Nothing here re-derives, ranks or compares a tier.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";

import { derivePolicySliceDigest, POLICY_AUTO_APPROVAL_TIERS } from "@moe/core";
import type { PolicyRiskTier } from "@moe/core";
import { afterEach, describe, expect, it } from "vitest";

import { GOAL_ID, PROJECT_ID, envelope, send } from "../bootstrap/bootstrap-test-fixtures.js";
import { readDurableLedger, versionOf } from "../bootstrap/bootstrap-ledger.js";
import { DomainRefusal } from "../daemon-command-dispatch.js";
import { OPERATOR_PRINCIPAL_KINDS, PAYLOAD_KEYS, agentCapabilitiesFor }
  from "../daemon-command-vocabulary.js";
import { createStoreDependencies } from "../daemon-store-dependencies.js";
import { MCP_EXCLUDED_COMMAND_KINDS, wiredMcpToolKinds } from "../mcp-tool-allowlist.js";
import {
  BASE, PR_URL, closeStores, decideRelease, journeyWorld, readPreviewDecision,
} from "../gates-journey-fixtures.js";
import type { JourneyWorld } from "../gates-journey-fixtures.js";
import { readRunGoalPublication } from "../http/run-goal-publication.js";
import { OPERATOR } from "../planning/plan-reject-test-fixtures.js";
import { readPublishLedger, recordPublishReceipt } from "../repository/publish-ledger.js";
import {
  RELEASE_AUTO_DECIDE_JOB_ID, releaseAutoCommandId, releaseAutoDecideOnce,
  registerReleaseAutoDecide,
} from "./release-auto-decide.js";
import type { ReleaseAutoDecideDeps, ReleaseAutoOutcome } from "./release-auto-decide.js";
import type { ReleaseDossierFactsPort } from "./release-decide-service.js";
import { releaseDossierAggregateId, releaseDossierId } from "./release-dossier-contracts.js";
import { OTHER_SHA } from "./release-dossier-fixtures.js";
import { readReleaseDossier, recordReleaseDossier } from "./release-dossier-ledger.js";
import { releaseDossierGaps, renderReleaseDossier } from "./release-dossier.js";
import { readReleaseDossierInput } from "./release-durable-facts.js";
import {
  RELEASE_AUTO_CODES, RELEASE_AUTO_CODE_LAYER_MAP, evaluateReleaseAutoApproval,
} from "./release-auto-approval.js";
import type { ReleaseAutoApproval } from "./release-auto-approval.js";
import {
  RELEASE_AUTO_APPROVAL_COMMAND_KIND, RELEASE_AUTO_APPROVAL_PRINCIPAL_ID,
  RELEASE_AUTO_APPROVAL_VERSION, decodeReleaseAutoApprovalBytes, readReleaseAutoApproval,
  recordReleaseAutoApproval, releaseAutoAggregateId,
} from "./release-auto-approval-record.js";
import { RELEASE_DECIDE_COMMAND_KIND } from "./release-decide-contracts.js";
import { decodeReleaseReceiptBytes, releaseReceiptId } from "./release-receipt-contracts.js";
import { readReleaseReceipt, recordReleaseReceipt } from "./release-receipt-ledger.js";

const AT = "2026-09-10T09:00:00.000Z";
const ENCODER = new TextEncoder();
let installs = 0;

afterEach(() => { closeStores(); });

interface OptIn { readonly action: string; readonly tier: "R0" | "R1" }
interface Classification { readonly factId: string; readonly tier: PolicyRiskTier }

/**
 * Installs an EVALUATION slice through the PRODUCTION `policy.install` command. The digest is
 * DERIVED, never spelled, so the ref genuinely addresses the bytes.
 *
 * IT MUST BE INSTALLED LAST TO GOVERN, and that is the point of the arm below that installs a
 * second one: `foldSlices` returns the LAST slice's opt-ins and this module selects the newest
 * installed EVALUATION slice, so a later opt-in-less policy turns automatic release OFF.
 */
function installSlice(
  world: JourneyWorld,
  optIns: readonly OptIn[],
  riskClassifications: readonly Classification[] = [],
): string {
  const body = {
    autoApprovalOptIns: optIns, riskClassifications, rules: [],
    sliceRef: `pending-release-auto-${String(installs += 1)}`,
  };
  const digest = derivePolicySliceDigest(body);
  if (!digest.ok) throw new Error(`opt-in slice fixture is invalid: ${digest.code}`);
  const slice = { ...body, sliceRef: digest.digest };
  const version = versionOf(readDurableLedger(world.store, PROJECT_ID), `${PROJECT_ID}-policy`);
  const outcome = send(world.store, envelope(
    "policy.install", version, { slice }, `cmd-install-release-auto-${String(installs)}`,
  ));
  if (!outcome.ok) throw new Error(`opt-in policy install refused: ${outcome.code}`);
  return digest.digest;
}

/** The tier-bearing fact this module composes, so a classification can address it by id. */
const RUN_FACT_ID = "release.run_policy_tier:run-1";

const RELEASE_OPT_IN: OptIn = { action: RELEASE_DECIDE_COMMAND_KIND, tier: "R1" };

function evaluate(world: JourneyWorld): ReleaseAutoApproval {
  return evaluateReleaseAutoApproval(world.store, {
    decidedAt: AT, goalId: GOAL_ID, operatorPrincipalId: OPERATOR, projectId: PROJECT_ID,
  });
}

function declined(result: ReleaseAutoApproval): {
  readonly code: string; readonly layer: string; readonly reasonCodes: readonly string[];
} {
  if (result.ok) throw new Error("expected a declined automatic approval, got an approval");
  return { code: result.code, layer: result.layer, reasonCodes: result.reasonCodes };
}

describe("evaluateReleaseAutoApproval names the opt-in it acted under", () => {
  it("approves the journey's R1 subject under an R1 opt-in and NAMES action and tier", () => {
    const world = journeyWorld("SUBMITTED");
    const ref = installSlice(world, [RELEASE_OPT_IN]);
    const result = evaluate(world);
    if (!result.ok) throw new Error(`expected an approval, got ${result.code}`);
    expect(result.optIn).toEqual({ action: RELEASE_DECIDE_COMMAND_KIND, tier: "R1" });
    expect(result.subjectTier).toBe("R1");
    expect(result.sliceRef).toBe(ref);
  });

  it("declines an R1 subject whose only release opt-in is capped at R0, with the engine's code", () => {
    const world = journeyWorld("SUBMITTED");
    installSlice(world, [{ action: RELEASE_DECIDE_COMMAND_KIND, tier: "R0" }]);
    const result = declined(evaluate(world));
    expect(result.code).toBe("RELEASE_AUTO_NOT_ALLOWED");
    expect(result.layer).toBe("CORE_REDUCER");
    expect(result.reasonCodes).toContain("AUTO_APPROVAL_NOT_OPTED_IN");
  });

  it("declines when the only opt-in is for preview.decide: the action match is EXACT", () => {
    const world = journeyWorld("SUBMITTED");
    installSlice(world, [{ action: "preview.decide", tier: "R1" }]);
    const result = declined(evaluate(world));
    expect(result.code).toBe("RELEASE_AUTO_NOT_ALLOWED");
    expect(result.layer).toBe("CORE_REDUCER");
    expect(result.reasonCodes).toContain("AUTO_APPROVAL_NOT_OPTED_IN");
  });

  it("declines when the NEWEST installed slice drops the opt-in, though an older one carries it", () => {
    const world = journeyWorld("SUBMITTED");
    installSlice(world, [RELEASE_OPT_IN]);
    expect(evaluate(world).ok).toBe(true);
    // The operator installs a fresh policy with no standing opt-in. That is a RESET, and the
    // newest slice governs -- exactly what `foldSlices` does with the last slice's opt-ins.
    // The classification names a factId no fact carries: it changes only the slice's DIGEST, so
    // this install cannot collide with the seed's own opt-in-less slice at the same content.
    installSlice(world, [], [{ factId: "release-auto-unrelated-fact", tier: "R0" }]);
    const result = declined(evaluate(world));
    expect(result.code).toBe("RELEASE_AUTO_NOT_ALLOWED");
    expect(result.layer).toBe("CORE_REDUCER");
    expect(result.reasonCodes).toContain("AUTO_APPROVAL_NOT_OPTED_IN");
  });

  it("declines the stock journey: both seeded EVALUATION slices carry no opt-in at all", () => {
    const world = journeyWorld("SUBMITTED");
    const result = declined(evaluate(world));
    expect(result.code).toBe("RELEASE_AUTO_NOT_ALLOWED");
    expect(result.reasonCodes).toContain("AUTO_APPROVAL_NOT_OPTED_IN");
  });
});

describe("R2 and R3 subjects are human-only, and the engine says so", () => {
  it("declines an R2 subject with HUMAN_ONLY_TIER even under a valid release opt-in", () => {
    const world = journeyWorld("SUBMITTED");
    installSlice(world, [RELEASE_OPT_IN], [{ factId: RUN_FACT_ID, tier: "R2" }]);
    const result = declined(evaluate(world));
    expect(result.code).toBe("RELEASE_AUTO_NOT_ALLOWED");
    expect(result.layer).toBe("CORE_REDUCER");
    expect(result.reasonCodes).toContain("HUMAN_ONLY_TIER");
  });

  it("declines an R3 subject with HUMAN_ONLY_TIER even under a valid release opt-in", () => {
    const world = journeyWorld("SUBMITTED");
    installSlice(world, [RELEASE_OPT_IN], [{ factId: RUN_FACT_ID, tier: "R3" }]);
    const result = declined(evaluate(world));
    expect(result.code).toBe("RELEASE_AUTO_NOT_ALLOWED");
    expect(result.layer).toBe("CORE_REDUCER");
    expect(result.reasonCodes).toContain("HUMAN_ONLY_TIER");
  });

  it("keeps the auto-approval ceiling at exactly R0 and R1", () => {
    expect([...POLICY_AUTO_APPROVAL_TIERS]).toEqual(["R0", "R1"]);
  });
});

describe("the code roster and its layer map stay closed and correlated", () => {
  it("derives the roster from the map's keys, with both surfaces represented", () => {
    expect([...RELEASE_AUTO_CODES].sort())
      .toEqual(Object.keys(RELEASE_AUTO_CODE_LAYER_MAP).sort());
    expect(new Set(Object.values(RELEASE_AUTO_CODE_LAYER_MAP)))
      .toEqual(new Set(["CORE_REDUCER", "RELEASE_AUTO_DECISION"]));
  });

  it("declares no constant the security lane's layer scanners would demand a roster row for", () => {
    // Both scanners require the declared NAME to end LAYER/LAYERS/BOUNDARIES immediately before
    // the `=`. This pins the `_MAP` tail rather than trusting the convention held.
    const pattern = /^(?:export )?const ([A-Z0-9_]+(?:LAYERS|LAYER|BOUNDARIES))\s*(?::[^=]+)?=/gmu;
    for (const path of ["release-auto-approval.ts", "release-auto-approval-record.ts"]) {
      const source = readSource(path);
      expect([...source.matchAll(pattern)].map((match) => match[1])).toEqual([]);
    }
  });
});

describe("the automatic approval record is durable, exact and store-only", () => {
  it("records an approval on its OWN aggregate and reads it back by commandId", () => {
    const world = journeyWorld("SUBMITTED");
    installSlice(world, [RELEASE_OPT_IN]);
    const before = world.store.getAggregateVersion(`release:${GOAL_ID}`);
    const written = recordReleaseAutoApproval(world.store, {
      commandId: "release-auto-fixture-1", decidedAt: AT, goalId: GOAL_ID,
      optIn: { action: RELEASE_DECIDE_COMMAND_KIND, tier: "R1" }, projectId: PROJECT_ID,
      reasonCodes: ["ALLOWED_BY_POLICY"], sha: world.sha, sliceRef: "a".repeat(64),
      subjectTier: "R1",
    });
    if (!written.ok) throw new Error(`record refused: ${written.code}`);
    expect(written.record.optIn).toEqual({ action: RELEASE_DECIDE_COMMAND_KIND, tier: "R1" });
    expect(readReleaseAutoApproval(world.store, PROJECT_ID, "release-auto-fixture-1"))
      .toEqual(written.record);
    // The release aggregate a human's Decide card is minted against MUST NOT have moved.
    expect(world.store.getAggregateVersion(`release:${GOAL_ID}`)).toBe(before);
    expect(world.store.getAggregateVersion(releaseAutoAggregateId(GOAL_ID)))
      .toBeGreaterThan(0);
  });

  it("replays the same commandId instead of appending a second claim", () => {
    const world = journeyWorld("SUBMITTED");
    const input = {
      commandId: "release-auto-fixture-2", decidedAt: AT, goalId: GOAL_ID,
      optIn: { action: RELEASE_DECIDE_COMMAND_KIND, tier: "R1" as const }, projectId: PROJECT_ID,
      reasonCodes: ["ALLOWED_BY_POLICY"] as const, sha: world.sha, sliceRef: "b".repeat(64),
      subjectTier: "R1" as const,
    };
    expect(recordReleaseAutoApproval(world.store, input).ok).toBe(true);
    const version = world.store.getAggregateVersion(releaseAutoAggregateId(GOAL_ID));
    expect(recordReleaseAutoApproval(world.store, input).ok).toBe(true);
    expect(world.store.getAggregateVersion(releaseAutoAggregateId(GOAL_ID))).toBe(version);
  });

  it("refuses an extra key, an unknown tier and an unknown reason code", () => {
    const base = {
      commandId: "c", goalId: GOAL_ID, optIn: { action: RELEASE_DECIDE_COMMAND_KIND, tier: "R1" },
      reasonCodes: ["ALLOWED_BY_POLICY"], sha: "s", sliceRef: "r",
      subjectTier: "R1", version: RELEASE_AUTO_APPROVAL_VERSION,
    };
    expect(decodeReleaseAutoApprovalBytes(bytes(base))).not.toBeNull();
    expect(decodeReleaseAutoApprovalBytes(bytes({ ...base, extra: 1 }))).toBeNull();
    expect(decodeReleaseAutoApprovalBytes(bytes({ ...base, subjectTier: "R9" }))).toBeNull();
    expect(decodeReleaseAutoApprovalBytes(bytes({ ...base, reasonCodes: ["NOT_A_CODE"] })))
      .toBeNull();
    expect(decodeReleaseAutoApprovalBytes(bytes({
      ...base, optIn: { action: RELEASE_DECIDE_COMMAND_KIND, tier: "R1", extra: 1 },
    }))).toBeNull();
    expect(decodeReleaseAutoApprovalBytes(bytes({
      ...base, version: "moe-release-auto-approval/2",
    }))).toBeNull();
  });

  it("is NOT a runtime command kind, so no generated contract digest can rotate for it", async () => {
    const { RUNTIME_COMMAND_KINDS } = await import("@moe/contracts");
    expect([...RUNTIME_COMMAND_KINDS as readonly string[]])
      .not.toContain(RELEASE_AUTO_APPROVAL_COMMAND_KIND);
    expect(RELEASE_AUTO_APPROVAL_PRINCIPAL_ID).toBe("daemon:release-auto-approval");
  });
});

describe("the release receipt carries provenance without rotating a single receipt id", () => {
  const RECEIPT_SHA = "0123456789abcdef0123456789abcdef01234567";
  const DOSSIER = "a".repeat(64);
  const PR = "https://github.com/fixture/repo/pull/9";

  /** A body whose id always re-derives, so any refusal below comes from the shape, not the id. */
  function receiptBody(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      dossierSha256: DOSSIER, goalId: GOAL_ID, outcome: "RELEASED", prUrl: PR,
      projectId: PROJECT_ID,
      receiptId: releaseReceiptId(PROJECT_ID, GOAL_ID, RECEIPT_SHA, "RELEASED", null),
      refusalCode: null, sha: RECEIPT_SHA, version: "moe-release-receipt/1", ...over,
    };
  }

  it("decodes bytes written before provenance existed, with provenance NULL", () => {
    const decoded = decodeReleaseReceiptBytes(bytes(receiptBody()));
    if (!decoded.ok) throw new Error(`expected a decode, got ${decoded.code}`);
    expect(decoded.receipt.provenance).toBeNull();
    expect(Object.keys(receiptBody())).toHaveLength(9);
  });

  it("decodes a receipt carrying provenance and returns the ACTION and TIER values", () => {
    const decoded = decodeReleaseReceiptBytes(bytes(receiptBody({
      provenance: { action: RELEASE_DECIDE_COMMAND_KIND, tier: "R1" },
    })));
    if (!decoded.ok) throw new Error(`expected a decode, got ${decoded.code}`);
    expect(decoded.receipt.provenance).toEqual({
      action: RELEASE_DECIDE_COMMAND_KIND, tier: "R1",
    });
  });

  it("refuses every provenance shape that is not one this codec would have written", () => {
    const cases: readonly (readonly [string, Record<string, unknown>])[] = [
      ["a tier outside the auto-approval ceiling",
        receiptBody({ provenance: { action: RELEASE_DECIDE_COMMAND_KIND, tier: "R2" } })],
      ["an unknown tier word",
        receiptBody({ provenance: { action: RELEASE_DECIDE_COMMAND_KIND, tier: "R9" } })],
      ["an empty action", receiptBody({ provenance: { action: "", tier: "R1" } })],
      ["an extra key inside provenance",
        receiptBody({ provenance: { action: RELEASE_DECIDE_COMMAND_KIND, tier: "R1", why: 1 } })],
      ["a missing key inside provenance", receiptBody({ provenance: { tier: "R1" } })],
      ["an EXPLICIT null: absence is the one encoding of a human decision",
        receiptBody({ provenance: null })],
      ["provenance PLUS a key outside the closed roster",
        receiptBody({ extra: 1, provenance: { action: RELEASE_DECIDE_COMMAND_KIND, tier: "R1" } })],
      ["a still-closed roster: an extra key without provenance", receiptBody({ extra: 1 })],
    ];
    for (const [label, forged] of cases) {
      const decoded = decodeReleaseReceiptBytes(bytes(forged));
      expect(decoded.ok, label).toBe(false);
      if (decoded.ok) throw new Error(`expected a refusal: ${label}`);
      expect(decoded.code, label).toBe("RELEASE_RECEIPT_INVALID");
    }
  });

  /**
   * THE HAZARD THIS ROW DID NOT SHIP. `releaseReceiptId` hashes the receipt VERSION, so bumping
   * that literal rotates every id and every stored receipt stops resolving. This pins the id
   * derivation to the LITERAL rather than to the constant, so a future bump reddens here instead
   * of silently making `deploy-command.ts` and `goal-deployment-read.ts` miss every RELEASED
   * receipt they look up by id.
   */
  it("derives the receipt id from the pinned domain literal, provenance-independent", () => {
    const expected = createHash("sha256").update(JSON.stringify([
      "moe-release-receipt/1", "receipt-id", PROJECT_ID, GOAL_ID, RECEIPT_SHA, "RELEASED", null,
    ]), "utf8").digest("hex");
    expect(releaseReceiptId(PROJECT_ID, GOAL_ID, RECEIPT_SHA, "RELEASED", null)).toBe(expected);
    const withProvenance = decodeReleaseReceiptBytes(bytes(receiptBody({
      provenance: { action: RELEASE_DECIDE_COMMAND_KIND, tier: "R0" },
    })));
    const without = decodeReleaseReceiptBytes(bytes(receiptBody()));
    if (!withProvenance.ok || !without.ok) throw new Error("expected both vintages to decode");
    expect(withProvenance.receipt.receiptId).toBe(without.receipt.receiptId);
  });

  it("writes a human receipt with the key OMITTED, so its bytes never moved", () => {
    const world = journeyWorld("SUBMITTED");
    const written = recordReleaseReceipt(world.store, {
      decidedAt: AT, dossierSha256: DOSSIER, goalId: GOAL_ID, outcome: "RELEASED", prUrl: PR,
      projectId: PROJECT_ID, refusalCode: null, sha: RECEIPT_SHA,
    });
    if (!written.ok) throw new Error(`record refused: ${written.code}`);
    expect(written.receipt.provenance).toBeNull();
    const read = readReleaseReceipt(world.store, PROJECT_ID, written.receipt.receiptId);
    if (!read.ok) throw new Error(`read refused: ${read.code}`);
    expect(Object.keys(JSON.parse(
      new TextDecoder().decode(read.decision.resultBytes),
    ) as object)).not.toContain("provenance");
  });

  it("writes an AUTOMATIC receipt whose stored bytes NAME the opt-in", () => {
    const world = journeyWorld("SUBMITTED");
    const written = recordReleaseReceipt(world.store, {
      decidedAt: AT, dossierSha256: DOSSIER, goalId: GOAL_ID, outcome: "RELEASED",
      provenance: { action: RELEASE_DECIDE_COMMAND_KIND, tier: "R1" }, prUrl: PR,
      projectId: PROJECT_ID, refusalCode: null, sha: RECEIPT_SHA,
    });
    if (!written.ok) throw new Error(`record refused: ${written.code}`);
    expect(written.receipt.provenance)
      .toEqual({ action: RELEASE_DECIDE_COMMAND_KIND, tier: "R1" });
    const read = readReleaseReceipt(world.store, PROJECT_ID, written.receipt.receiptId);
    if (!read.ok) throw new Error(`read refused: ${read.code}`);
    expect(read.receipt.provenance)
      .toEqual({ action: RELEASE_DECIDE_COMMAND_KIND, tier: "R1" });
  });
});

// ---------------------------------------------------------------------------------------------
// THE RECONCILER'S WORLD. Everything below drives the PRODUCTION reconciler over the production
// journey store: the publish receipt, the human decisions and the release itself all go through
// production writers. Only the two git measurements the journey already substitutes are absent.
// ---------------------------------------------------------------------------------------------

/** The integrated criterion artifact a real `readCriterionArtifact` would measure. Mirrors the
 *  journey fixture's sixth substituted seam, for the reason it gives: this lane has no git object
 *  database. It decides nothing -- `currentCriterionReceipts` still applies every one of its rules. */
const criterionArtifactAt = (sha: string) => Object.freeze({
  root: "D:/fixture-workspace", sha, treeSha: "1".repeat(40),
});

/**
 * The evidence facts, read by the PRODUCTION reader over the journey's own store, with the same
 * two substituted git measurements the journey fixture uses. Structurally identical to the
 * fixture's own port; production composes ONE instance and hands it to both the reconciler and the
 * service, and the two instances here agree because they read the same store through the same code.
 */
function dossierFactsOver(store: JourneyWorld["store"]): ReleaseDossierFactsPort {
  return (goalId, sha) => {
    const input = readReleaseDossierInput(
      store, PROJECT_ID, goalId, () => criterionArtifactAt(sha),
    );
    if (input === null || input.criteria.length === 0) return null;
    const ancestry = (commit: string): "ANCESTOR" | "NOT_ANCESTOR" =>
      commit === sha ? "ANCESTOR" : "NOT_ANCESTOR";
    if (releaseDossierGaps(input, sha, ancestry).length === 0
      && !readReleaseDossier(store, PROJECT_ID, releaseDossierId(PROJECT_ID, goalId, sha)).ok) {
      recordReleaseDossier(store, {
        decidedAt: AT, goalId, markdown: renderReleaseDossier(input, sha, ancestry),
        projectId: PROJECT_ID, sha,
      });
    }
    return { ancestry, input };
  };
}

/**
 * Marks the journey's publish request PUSHED, through the production `recordPublishReceipt`.
 *
 * MEASURED, NOT ASSUMED: `journeyWorld` leaves the publication at PENDING with zero receipts --
 * its own publisher only writes one INSIDE a `release.decide` dispatch -- and
 * `readRunGoalPublication` looks the receipt up by the LAST request's decisionId, so a receipt
 * under any other id would be invisible and the reconciler would see no candidate at all.
 */
function markPushed(world: JourneyWorld, sha: string = world.sha): void {
  const state = readPublishLedger(world.store, PROJECT_ID).get(GOAL_ID);
  const request = state?.requests.at(-1);
  if (request === undefined) throw new Error("the journey recorded no publish request to push");
  const recorded = recordPublishReceipt(world.store, {
    branch: BASE, decidedAt: AT, decisionId: request.decisionId, goalId: GOAL_ID,
    projectId: PROJECT_ID, refusal: null, remoteUrl: request.remoteUrl, sha,
    url: `${request.remoteUrl}/tree/${BASE}`,
  });
  if (!recorded.ok) throw new Error(`publish receipt fixture refused: ${recorded.code}`);
  const publication = readRunGoalPublication(
    world.store, PROJECT_ID, readPublishLedger(world.store, PROJECT_ID).get(GOAL_ID),
  );
  // Asserted, not assumed: every reconciler arm below is vacuous without a PUSHED candidate.
  expect(publication?.outcome).toBe("PUSHED");
}

function depsOver(world: JourneyWorld, over: Partial<ReleaseAutoDecideDeps> = {}) {
  return {
    base: BASE, clock: () => AT, dossierFacts: dossierFactsOver(world.store),
    operatorPrincipalId: OPERATOR, projectId: PROJECT_ID, registry: world.deps.registry,
    store: world.store, ...over,
  };
}

function only(answers: readonly ReleaseAutoOutcome[]): ReleaseAutoOutcome {
  if (answers.length !== 1) {
    throw new Error(`expected exactly one candidate, got ${String(answers.length)}`);
  }
  return answers[0] as ReleaseAutoOutcome;
}

const releaseVersion = (world: JourneyWorld): number =>
  world.store.getAggregateVersion(releaseDossierAggregateId(GOAL_ID));

const admittedCount = (world: JourneyWorld): number =>
  world.store.readEvents(releaseDossierAggregateId(GOAL_ID))
    .filter((event) => event.eventType === "ReleaseCommandAdmitted").length;

const decidedCount = (world: JourneyWorld): number =>
  world.store.readEvents(releaseDossierAggregateId(GOAL_ID))
    .filter((event) => event.eventType === "ReleaseCommandDecided").length;

describe("a PUSHED goal is the only candidate, and a human always outranks the daemon", () => {
  it("sees NO candidate while the publication is still PENDING", async () => {
    const world = journeyWorld("SUBMITTED");
    installSlice(world, [RELEASE_OPT_IN]);
    expect(await releaseAutoDecideOnce(depsOver(world))).toEqual([]);
  });

  it("A RECORDED HUMAN REJECT WINS: the automatic path refuses and writes nothing", async () => {
    const world = journeyWorld("SUBMITTED");
    installSlice(world, [RELEASE_OPT_IN]);
    markPushed(world);
    const rejected = await decideRelease(world, {
      base: BASE, decision: "REJECT", goalId: GOAL_ID, sha: world.sha,
    });
    expect(rejected.answer).toMatchObject({ outcome: "ACCEPTED" });
    const before = releaseVersion(world);
    const answer = only(await releaseAutoDecideOnce(depsOver(world)));
    expect(answer.code).toBe("HUMAN_REJECTED");
    expect(answer.refusal)
      .toEqual({ code: "RELEASE_COMMAND_ID_REQUIRED", layer: "DAEMON_COMMAND_SEAM" });
    expect(answer.detail).toContain(OPERATOR);
    // Nothing was written: no auto-approval record, and the human's aggregate did not move.
    expect(readReleaseAutoApproval(
      world.store, PROJECT_ID, releaseAutoCommandId(PROJECT_ID, GOAL_ID, world.sha),
    )).toBeNull();
    expect(releaseVersion(world)).toBe(before);
  });

  it("refuses a sha a HUMAN already released, with the service's own code and layer", async () => {
    const world = journeyWorld("SUBMITTED");
    installSlice(world, [RELEASE_OPT_IN]);
    markPushed(world);
    const released = await decideRelease(world, {
      base: BASE, decision: "APPROVE", goalId: GOAL_ID, sha: world.sha,
    });
    expect(released.answer).toMatchObject({ outcome: "ACCEPTED" });
    const answer = only(await releaseAutoDecideOnce(depsOver(world)));
    expect(answer.code).toBe("ALREADY_RELEASED");
    expect(answer.refusal)
      .toEqual({ code: "RELEASE_COMMAND_ID_REQUIRED", layer: "DAEMON_COMMAND_SEAM" });
  });
});

describe("nothing is written until every cheap prerequisite has answered", () => {
  it("refuses a CRITERION GAP with the landed gap code and the prerequisite layer", async () => {
    const world = journeyWorld("SUBMITTED");
    installSlice(world, [RELEASE_OPT_IN]);
    // A sha the criterion receipts do not bind to: the criterion evidence `goal.close` demands is
    // not present AT THIS SHA, which is exactly the gap task-b8ec9a63 landed (commit b7a18b06).
    markPushed(world, OTHER_SHA);
    const answer = only(await releaseAutoDecideOnce(depsOver(world)));
    expect(answer.sha).toBe(OTHER_SHA);
    expect(answer.code).toBe("EVIDENCE_INCOMPLETE");
    expect(answer.refusal)
      .toEqual({ code: "RELEASE_EVIDENCE_INCOMPLETE", layer: "DAEMON_PREREQUISITE" });
    expect(answer.detail.split(", ")).toContain("CRITERION_NOT_VERIFIED_AT_SHA");
    expect(readReleaseAutoApproval(
      world.store, PROJECT_ID, releaseAutoCommandId(PROJECT_ID, GOAL_ID, OTHER_SHA),
    )).toBeNull();
  });

  /**
   * THE JOURNAL-CHURN DEFECT THIS ORDER PREVENTS. A reconciler that dispatched first and let the
   * service refuse would write two decision records and two events on `release:<goalId>` every
   * tick, bumping the version a human's Decide card was minted against -- so that card would 409
   * once a minute for as long as the goal stayed stuck.
   */
  it("leaves the release aggregate UNTOUCHED across three ticks on a gap-bearing goal", async () => {
    const world = journeyWorld("SUBMITTED");
    installSlice(world, [RELEASE_OPT_IN]);
    markPushed(world, OTHER_SHA);
    const before = releaseVersion(world);
    for (let tick = 0; tick < 3; tick += 1) {
      expect(only(await releaseAutoDecideOnce(depsOver(world))).code).toBe("EVIDENCE_INCOMPLETE");
    }
    expect(releaseVersion(world)).toBe(before);
    expect(admittedCount(world)).toBe(0);
  });

  it("refuses when no opt-in is in force, BEFORE any base branch is consulted", async () => {
    const world = journeyWorld("SUBMITTED");
    markPushed(world);
    const answer = only(await releaseAutoDecideOnce(depsOver(world, { base: null })));
    expect(answer.code).toBe("NOT_ALLOWED");
    expect(answer.refusal?.code).toBe("RELEASE_AUTO_NOT_ALLOWED");
    expect(answer.refusal?.layer).toBe("CORE_REDUCER");
    expect(answer.detail).toContain("AUTO_APPROVAL_NOT_OPTED_IN");
  });

  it("FAILS CLOSED with no configured base branch, even when policy allows the release", async () => {
    const world = journeyWorld("SUBMITTED");
    installSlice(world, [RELEASE_OPT_IN]);
    markPushed(world);
    const answer = only(await releaseAutoDecideOnce(depsOver(world, { base: null })));
    expect(answer.code).toBe("BASE_UNCONFIGURED");
    expect(releaseVersion(world)).toBe(releaseVersion(world));
    expect(admittedCount(world)).toBe(0);
  });

  it("refuses rather than throwing when release.decide is not served at all", async () => {
    const world = journeyWorld("SUBMITTED");
    installSlice(world, [RELEASE_OPT_IN]);
    markPushed(world);
    const answer = only(await releaseAutoDecideOnce(depsOver(world, { registry: new Map() })));
    expect(answer.code).toBe("UNSERVED");
  });

  /**
   * `DurableSchedule` flattens any throw to SCHEDULE_CALLBACK_FAILED and DISCARDS the reason, so a
   * refusal that escaped as an exception would be an invisible refusal. This is the arm that pins
   * a `DomainRefusal` from the dispatch becoming a per-candidate OUTCOME instead.
   */
  it("turns a DomainRefusal from the dispatch into an OUTCOME, never a throw", async () => {
    const world = journeyWorld("SUBMITTED");
    installSlice(world, [RELEASE_OPT_IN]);
    markPushed(world);
    const entry = world.deps.registry.get(RELEASE_DECIDE_COMMAND_KIND);
    if (entry === undefined) throw new Error("the journey registry does not serve release.decide");
    const refusing = new Map(world.deps.registry);
    refusing.set(RELEASE_DECIDE_COMMAND_KIND, {
      ...entry,
      asyncHandler: () => {
        throw new DomainRefusal(
          "EXPECTED_VERSION_CONFLICT", "DAEMON_COMMAND_SEAM", "a human got there first", 409,
        );
      },
    });
    const answer = only(await releaseAutoDecideOnce(depsOver(world, { registry: refusing })));
    expect(answer.code).toBe("DISPATCH_REFUSED");
    expect(answer.refusal)
      .toEqual({ code: "EXPECTED_VERSION_CONFLICT", layer: "DAEMON_COMMAND_SEAM" });
  });
});

describe("two ticks cannot release the same sha twice", () => {
  it("admits exactly ONE release command when two ticks run concurrently", async () => {
    const world = journeyWorld("SUBMITTED");
    installSlice(world, [RELEASE_OPT_IN]);
    markPushed(world);
    const deps = depsOver(world);
    const [first, second] = await Promise.all([
      releaseAutoDecideOnce(deps), releaseAutoDecideOnce(deps),
    ]);
    // The SCHEDULE gives single-flight per job id in one process; this arm proves the DURABLE
    // mechanism underneath it, which is what a second daemon would run into: the deterministic
    // commandId means the loser is answered from the STORED terminal rather than opening a second
    // pull request. Both ticks therefore report RELEASED -- MEASURED, and the reason the assertion
    // is on the journal rather than on the pair of codes, which would have read as two releases.
    expect(admittedCount(world)).toBe(1);
    expect(decidedCount(world)).toBe(1);
    expect(readReleaseReceipt(
      world.store, PROJECT_ID,
      releaseReceiptId(PROJECT_ID, GOAL_ID, world.sha, "RELEASED", null),
    ).ok).toBe(true);
    // EXACTLY ONE tick reports a release, and the loser is answered by a NAMED fail-closed branch.
    // Which branch depends on where the await boundary falls relative to the first tick's dispatch
    // -- MEASURED: both `RELEASE_IN_FLIGHT` (the walk saw the admission) and `ALREADY_ATTEMPTED`
    // (the store already held the decision) are reachable, and a `RELEASED` detail may read either
    // DECIDED or REPLAYED. Pinning one interleaving would be pinning the scheduler, so the
    // assertion pins the journal above and the ROSTER of admissible loser codes here.
    const codes = [only(first).code, only(second).code];
    expect(codes.filter((code) => code === "RELEASED")).toHaveLength(1);
    const loser = codes.find((code) => code !== "RELEASED");
    expect(["ALREADY_ATTEMPTED", "RELEASE_IN_FLIGHT"]).toContain(loser);
  });

  it("skips a sha it has already attempted, on the very next tick", async () => {
    const world = journeyWorld("SUBMITTED");
    installSlice(world, [RELEASE_OPT_IN]);
    markPushed(world);
    const deps = depsOver(world);
    expect(only(await releaseAutoDecideOnce(deps)).code).toBe("RELEASED");
    const after = releaseVersion(world);
    expect(only(await releaseAutoDecideOnce(deps)).code).toBe("ALREADY_ATTEMPTED");
    expect(only(await releaseAutoDecideOnce(deps)).code).toBe("ALREADY_ATTEMPTED");
    expect(releaseVersion(world)).toBe(after);
    expect(admittedCount(world)).toBe(1);
  });
});

describe("the reconciler arms itself as one named job on the daemon's existing schedule", () => {
  it("registers under release/auto-decide and its callback drives a real tick", async () => {
    const world = journeyWorld("SUBMITTED");
    installSlice(world, [RELEASE_OPT_IN]);
    markPushed(world);
    const armed: { id: string; run: () => Promise<void> }[] = [];
    const armedResult = registerReleaseAutoDecide({
      register: (id, callback) => {
        armed.push({ id, run: async () => { await callback(new AbortController().signal); } });
        return { ok: true as const };
      },
    }, depsOver(world));
    expect(armedResult.ok).toBe(true);
    expect(armed.map((job) => job.id)).toEqual([RELEASE_AUTO_DECIDE_JOB_ID]);
    // The callback must SWALLOW nothing and THROW nothing: the schedule would flatten a throw to
    // SCHEDULE_CALLBACK_FAILED and discard the reason, so this tick releasing is the proof it ran.
    await armed[0]?.run();
    expect(readReleaseAutoApproval(
      world.store, PROJECT_ID, releaseAutoCommandId(PROJECT_ID, GOAL_ID, world.sha),
    )).not.toBeNull();
  });

  it("forwards a registration refusal instead of swallowing it", () => {
    const world = journeyWorld("SUBMITTED");
    const refused = registerReleaseAutoDecide({
      register: () => ({ code: "SCHEDULE_RELEASED", layer: "DAEMON_INGRESS", ok: false as const }),
    }, depsOver(world));
    expect(refused).toEqual({ code: "SCHEDULE_RELEASED", layer: "DAEMON_INGRESS", ok: false });
  });
});

describe("ONE TICK RELEASES A GAP-FREE GOAL, AND THE RECEIPT SAYS WHO DECIDED", () => {
  /**
   * DoD 2, END TO END, through the production journey: PRD -> contract -> Gate 1 -> design ->
   * plan -> landed node -> criterion checks PASSED at the landing sha -> remote bound -> preview
   * receipt -> publisher PUSHED. One tick of the reconciler, and nothing else.
   *
   * THE VERDICT IS NOT THE ASSERTION. A RELEASED receipt reads identically whether a human or the
   * daemon decided, so this arm asserts the things only an automatic release can produce: the
   * receipt's provenance VALUES, and that the ONE decision on the release aggregate was taken under
   * the reconciler's DETERMINISTIC commandId rather than any human's.
   */
  it("releases under the opt-in, and the receipt NAMES the action and tier it acted at", async () => {
    const world = journeyWorld("SUBMITTED");
    const sliceRef = installSlice(world, [RELEASE_OPT_IN]);
    markPushed(world);
    // THE PRECONDITION, ASSERTED: the evidence is gap-free at the sha under release. Without this
    // the arm could pass on a gap-free-by-accident world and prove nothing about the gate.
    const facts = dossierFactsOver(world.store)(GOAL_ID, world.sha);
    if (facts === null) throw new Error("the journey world carries no readable release evidence");
    expect(releaseDossierGaps(facts.input, world.sha, facts.ancestry)).toEqual([]);
    // And no human has decided this gate: the preview gate's own record is absent.
    expect(readPreviewDecision(
      world.store, PROJECT_ID, OPERATOR, releaseAutoCommandId(PROJECT_ID, GOAL_ID, world.sha),
    )).toBeNull();

    const answer = only(await releaseAutoDecideOnce(depsOver(world)));
    expect(answer.code).toBe("RELEASED");
    expect(answer.detail).toBe("DECIDED RELEASED");

    const receipt = readReleaseReceipt(
      world.store, PROJECT_ID,
      releaseReceiptId(PROJECT_ID, GOAL_ID, world.sha, "RELEASED", null),
    );
    if (!receipt.ok) throw new Error(`expected a RELEASED receipt, got ${receipt.code}`);
    expect(receipt.receipt.provenance)
      .toEqual({ action: RELEASE_DECIDE_COMMAND_KIND, tier: "R1" });
    expect(receipt.receipt.prUrl).toBe(PR_URL);

    // NO HUMAN DECIDED. Exactly one decision on the release aggregate, and its command identity is
    // the reconciler's own deterministic id. A human dispatch carries a minted id instead.
    const commandId = releaseAutoCommandId(PROJECT_ID, GOAL_ID, world.sha);
    const decided = world.store.readEvents(releaseDossierAggregateId(GOAL_ID))
      .filter((event) => event.eventType === "ReleaseCommandDecided");
    expect(decided).toHaveLength(1);
    expect(decided.map((event) => event.decisionTrace?.commandId)).toEqual([commandId]);

    // And the approval record carries the chain it acted on, so a reviewer can re-derive it.
    const record = readReleaseAutoApproval(world.store, PROJECT_ID, commandId);
    expect(record).toMatchObject({
      goalId: GOAL_ID, optIn: { action: RELEASE_DECIDE_COMMAND_KIND, tier: "R1" },
      sha: world.sha, sliceRef, subjectTier: "R1",
    });
  });

  /**
   * ATTACK A4, AND THE FIXTURE TRAP THAT HIDES IT. `bootstrap-test-fixtures`'s policy slice and the
   * demo seed both carry `autoApprovalOptIns: []`, and `foldSlices` takes the LAST slice's opt-ins.
   * An operator who installs a policy AFTER declaring the opt-in has silently turned automatic
   * release off -- which is the behaviour this row wants, and an arm that installed the slices in
   * the other order would have "proved" auto-release while testing the seed.
   */
  it("stops releasing the moment an opt-in-less policy is installed AFTER the opt-in", async () => {
    const world = journeyWorld("SUBMITTED");
    installSlice(world, [RELEASE_OPT_IN]);
    markPushed(world);
    expect(evaluate(world).ok).toBe(true);
    installSlice(world, [], [{ factId: "release-auto-reset-marker", tier: "R0" }]);
    const answer = only(await releaseAutoDecideOnce(depsOver(world)));
    expect(answer.code).toBe("NOT_ALLOWED");
    expect(answer.refusal)
      .toEqual({ code: "RELEASE_AUTO_NOT_ALLOWED", layer: "CORE_REDUCER" });
    expect(answer.detail).toContain("AUTO_APPROVAL_NOT_OPTED_IN");
    expect(admittedCount(world)).toBe(0);
    expect(readReleaseReceipt(
      world.store, PROJECT_ID,
      releaseReceiptId(PROJECT_ID, GOAL_ID, world.sha, "RELEASED", null),
    ).ok).toBe(false);
  });

  /**
   * DoD 4's second half, as far as a committed arm can reach it: the ceiling is the IMPORTED frozen
   * constant from @moe/core, so a widening there reddens here. That this row CHANGED no file under
   * packages/core/src/policy/ is a claim about code it does not own and is discharged by a command
   * recorded with the completion: `git diff --name-only 4161ad48..HEAD -- packages/core/src/policy/`.
   */
  it("holds the auto-approval ceiling at exactly R0 and R1, from @moe/core's own constant", () => {
    expect([...POLICY_AUTO_APPROVAL_TIERS]).toEqual(["R0", "R1"]);
    expect(Object.isFrozen(POLICY_AUTO_APPROVAL_TIERS)).toBe(true);
  });
});

describe("the human-only fence binds the daemon's own call too", () => {
  /**
   * ATTACK A7. The obvious way to write this reconciler is to give it a reserved `daemon:*`
   * principal, the way every other internal writer has one. `assertReleasePrincipal` refuses that
   * with OPERATOR_PRINCIPAL_REQUIRED 403, and because a refusal here is an outcome rather than a
   * throw, every goal would park SILENTLY forever. This arm is the reason the composition passes
   * `config.principalId` -- the same id boot reconciliation acts under -- and NOT a new roster entry.
   */
  it("refuses the dispatch under a daemon:* principal, naming the authorization layer", async () => {
    const world = journeyWorld("SUBMITTED");
    installSlice(world, [RELEASE_OPT_IN]);
    markPushed(world);
    const answer = only(await releaseAutoDecideOnce(depsOver(world, {
      operatorPrincipalId: "daemon:release-auto-decide",
    })));
    expect(answer.code).toBe("DISPATCH_REFUSED");
    expect(answer.refusal)
      .toEqual({ code: "OPERATOR_PRINCIPAL_REQUIRED", layer: "DAEMON_AUTHORIZATION" });
    // Nothing released, and the operator's own path is untouched: the admission never happened.
    expect(admittedCount(world)).toBe(0);
    expect(readReleaseReceipt(
      world.store, PROJECT_ID,
      releaseReceiptId(PROJECT_ID, GOAL_ID, world.sha, "RELEASED", null),
    ).ok).toBe(false);
  });

  it("composes the reconciler under the configured operator id, never a reserved one", () => {
    const source = readFileSync(
      new URL("../daemon-store-foundation-composition.ts", import.meta.url), "utf8",
    );
    const call = /registerReleaseAutoDecide\(schedules, \{[\s\S]*?\}\);/u.exec(source)?.[0];
    if (call === undefined) throw new Error("the composition no longer registers the reconciler");
    expect(call).toContain("operatorPrincipalId: config.principalId");
    expect(call).toContain("process.env[RELEASE_BASE_ENV_KEY] ?? null");
    // The SAME registry and the SAME dossier facts the release command itself holds. A second
    // composition would mint a second pull-request port.
    expect(call).toContain("registry,");
    expect(call).toContain("dossierFacts: releaseDecide.dossierFacts");
    expect(call).not.toMatch(/principalId: "daemon:/u);
  });
});

/** One LIVE production composition over a throwaway store, torn down when `body` returns. */
function withLiveDaemon(body: (deps: ReturnType<typeof createStoreDependencies>,
  storePath: string, project: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "moe-release-auto-decide-"));
  const storePath = join(root, "store.db");
  const project = "release-auto-composition";
  let deps: ReturnType<typeof createStoreDependencies> | null = null;
  try {
    deps = createStoreDependencies({
      credential: "release-auto-operator-credential", principalId: "operator-local",
      projectId: project, storePath,
    });
    body(deps, storePath, project);
  } finally {
    deps?.close();
    rmSync(root, { force: true, recursive: true });
  }
}

describe("the human-only fence is unchanged, in BOTH directions, read from the dispatch seam", () => {
  /**
   * DoD 6 and global rail 9. The SERVED set is enumerated from the live dispatch registry, never
   * from the roster constant: a test that iterated `OPERATOR_PRINCIPAL_KINDS` alone would shrink
   * its own iteration when an entry was deleted and stay green while a served capability quietly
   * left the advertised surface.
   */
  it("serves no operator-principal kind over MCP, and partitions the rest by name", () => {
    withLiveDaemon((deps) => {
      const registry = deps.provide().registry;
      const served: readonly string[] = [...registry.keys()];
      // Widened to `string` for the membership tests only: the registry is keyed by the broader
      // `RuntimeCommandKind` while the roster is typed `WiredCommandKind`, and narrowing the
      // SERVED side to the roster's type would be asking the roster about itself.
      const operatorRoster = OPERATOR_PRINCIPAL_KINDS as ReadonlySet<string>;
      const operatorKinds = served.filter((kind) => operatorRoster.has(kind));
      const wired = new Set<string>(wiredMcpToolKinds());

      // (a) release.decide is STILL an operator-principal kind, and STILL MCP-excluded.
      expect(operatorKinds).toContain(RELEASE_DECIDE_COMMAND_KIND);
      expect(MCP_EXCLUDED_COMMAND_KINDS).toContain(RELEASE_DECIDE_COMMAND_KIND);

      // (b) ADVERTISED-then-SERVED. Nothing MCP advertises is an operator-principal kind EXCEPT
      // the one the allowlist's own `MCP_REACHABLE_OPERATOR_KINDS` admits by ruling
      // (comment-4d026de3, task-4c9b1d85: minting a scoped session is the operator's OWN act on
      // the bearer path). MEASURED, and PINNED as a one-member roster so a SECOND exception
      // reddens here instead of quietly widening the fence:
      const wiredOperatorKinds = operatorKinds.filter((kind) => wired.has(kind)).sort();
      expect(wiredOperatorKinds).toEqual(["session.open"]);
      // The derivation holds: the advertised one is the one the excluded roster leaves out, and
      // every other operator kind is BOTH excluded and unadvertised.
      expect(MCP_EXCLUDED_COMMAND_KINDS).not.toContain("session.open");
      expect(operatorKinds.filter((kind) => MCP_EXCLUDED_COMMAND_KINDS.includes(kind))
        .filter((kind) => wired.has(kind))).toEqual([]);

      // (c) SERVED-then-ADVERTISED, the direction a roster-iterating test cannot see: every
      // served kind MCP does not advertise is withheld for a NAMED reason -- it is operator-only,
      // or `agentCapabilitiesFor` refuses to staff it. A kind withheld for no reason at all would
      // be a capability that silently vanished from the advertised surface.
      const unexplained = served.filter((kind) => !wired.has(kind)
        && !operatorRoster.has(kind) && agentCapabilitiesFor(kind) !== null);
      expect(unexplained).toEqual([]);

      // (d) THE FENCE IS THE PRINCIPAL, NOT THE CAPABILITY -- MEASURED, and the reason this arm
      // exists. `agentCapabilitiesFor("release.decide")` answers `["goal.write","work.write"]`,
      // NOT null: the vocabulary calls that REACH only and names OPERATOR_PRINCIPAL_KINDS as the
      // human gate. So a capability check alone would PASS an agent seat here, and the behavioural
      // arm below drives exactly that seat through the production handler to prove it is refused.
      expect(agentCapabilitiesFor(RELEASE_DECIDE_COMMAND_KIND))
        .toEqual(["goal.write", "work.write"]);
      expect(wired.has(RELEASE_DECIDE_COMMAND_KIND)).toBe(false);
    });
  });

  /**
   * The capability gate is NOT the fence here, so this arm hands the gate a seat carrying EXACTLY
   * the capabilities `agentCapabilitiesFor` grants for this kind -- the strongest agent that could
   * ever arrive -- and proves the principal fence refuses it anyway.
   */
  it("refuses a fully capable AGENT SEAT at the principal fence, with its layer", async () => {
    const world = journeyWorld("SUBMITTED");
    installSlice(world, [RELEASE_OPT_IN]);
    markPushed(world);
    const capabilities = agentCapabilitiesFor(RELEASE_DECIDE_COMMAND_KIND);
    if (capabilities === null) throw new Error("release.decide is unstaffable by capability");
    const entry = world.deps.registry.get(RELEASE_DECIDE_COMMAND_KIND);
    const handler = entry?.asyncHandler;
    if (handler === undefined) throw new Error("the journey registry does not serve release.decide");
    await expect(handler({
      envelope: {
        commandId: "cmd-seat-release", commandKind: RELEASE_DECIDE_COMMAND_KIND,
        correlationId: "corr-seat-release", expectedVersion: releaseVersion(world),
        payload: { base: BASE, decision: "APPROVE", goalId: GOAL_ID, sha: world.sha },
        requestDigest: "d".repeat(64), schemaVersion: "moe-runtime-command/1",
        sessionCredential: "seat-credential",
        targetAggregateId: releaseDossierAggregateId(GOAL_ID),
      },
      principal: { capabilities, principalId: "agent-seat-1", projectId: PROJECT_ID },
    } as unknown as Parameters<typeof handler>[0])).rejects.toMatchObject({
      code: "OPERATOR_PRINCIPAL_REQUIRED", httpStatus: 403, layer: "DAEMON_AUTHORIZATION",
    });
    expect(admittedCount(world)).toBe(0);
  });

  it("adds NO runtime command kind, so no generated contract digest can rotate", async () => {
    const { RUNTIME_COMMAND_KINDS } = await import("@moe/contracts");
    const kinds = [...RUNTIME_COMMAND_KINDS as readonly string[]];
    expect(kinds).not.toContain(RELEASE_AUTO_APPROVAL_COMMAND_KIND);
    expect(kinds).toContain(RELEASE_DECIDE_COMMAND_KIND);
    // The store-only kind is not on any payload roster either, so no digest input saw it.
    expect(Object.keys(PAYLOAD_KEYS)).not.toContain(RELEASE_AUTO_APPROVAL_COMMAND_KIND);
  });
});

describe("the live daemon composition arms the reconciler across a restart", () => {
  it("registers release/auto-decide with no surviving refusal, on boot and on reboot", () => {
    const root = mkdtempSync(join(tmpdir(), "moe-release-auto-decide-"));
    const storePath = join(root, "store.db");
    const project = "release-auto-composition";
    const boot = () => createStoreDependencies({
      credential: "release-auto-operator-credential", principalId: "operator-local",
      projectId: project, storePath,
    });
    const refusalsFor = (deps: ReturnType<typeof boot>): readonly unknown[] =>
      deps.schedules().refusals().filter((refusal) => refusal.id === RELEASE_AUTO_DECIDE_JOB_ID);
    try {
      const first = boot();
      expect(refusalsFor(first)).toEqual([]);
      first.close();
      // POSITIVELY OBSERVED, never inferred from an empty refusal list: an absent registration
      // would ALSO produce no refusals, so this arm reads the DURABLE schedule record and asserts
      // the job id is in it. That is what makes the refusal assertions non-vacuous.
      const store = SqliteEventStore.openForProject(storePath, project);
      try {
        const ids = store.readEvents(`durable-schedule/${project}`).map((event) =>
          (JSON.parse(new TextDecoder().decode(event.payload)) as { id?: unknown }).id);
        expect(ids).toContain(RELEASE_AUTO_DECIDE_JOB_ID);
      } finally {
        store.close();
      }
      // THE REBOOT IS THE POINT. The durable record now HOLDS this job, so the constructor's
      // rebuild resolves it -- to null, because the deps do not exist yet -- before `register`
      // re-arms it. `arm()` clears the notice, so a transient SCHEDULE_TARGET_UNRESOLVED must not
      // survive into `refusals()` and alarm an operator reading the health surface.
      const second = boot();
      expect(refusalsFor(second)).toEqual([]);
      second.close();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

function bytes(value: unknown): Uint8Array {
  return ENCODER.encode(JSON.stringify(value));
}

function readSource(name: string): string {
  return readFileSync(new URL(name, import.meta.url), "utf8");
}
