import { RUNTIME_COMMAND_KINDS } from "@moe/contracts";
import { REVIEW_REASON_CODES, findingFingerprint } from "@moe/review";
import type { ReviewPackageBoundItem, ReviewPackageItemInput } from "@moe/review";
import { afterEach, describe, expect, it } from "vitest";

import { DomainRefusal, decisionOf } from "../daemon-command-dispatch.js";
import { REVIEW_COMMAND_KINDS, REVIEW_SCHEMA_VERSION, decodeReviewRequestBytes } from "./review-contracts.js";
import { commitAccepted, readReviewLedger } from "./review-ledger.js";
import type { StoredPackageItems } from "./review-round-items.js";
import { runReviewCommand } from "./review-services.js";
import {
  PROJECT_ID,
  SUBJECT_REF,
  closeStores,
  decisionCount,
  envelope,
  finding,
  hex64,
  openRestartableStore,
  openStore,
  oversizeRoundEnvelope,
  packageItems,
  reopen,
  seedLineageNearReadBound,
  send,
  submit,
  submitPayload,
} from "./review-test-fixtures.js";

/**
 * Durable review rounds (DoD 1) and the refusal taxonomy. Lineage survival lives in
 * review-lineage.test.ts.
 *
 * Four layers can refuse a review command — the ingress shape gate, the daemon's durable
 * prerequisite gate, `@moe/review`'s own validators, and the store — so every refusal case here
 * pins the stable code AND the layer that produced it. Asserting only "it refused" would go
 * vacuous the moment an earlier layer starts answering first, which is the exact defect epic
 * rail 6 names.
 */

afterEach(closeStores);

/**
 * The four kinds this task owns, restated as a literal rather than derived from production: set
 * equality against a derived list is vacuous, because a fifth kind added to production would
 * appear on both sides of the comparison and the case would stay green.
 */
const OWNED_KINDS = [
  "escalation.decide",
  "integration.accept_output",
  "qualification.replan",
  "review.submit",
] as const;

const encoder = new TextEncoder();

/**
 * The seven fixture items in the order `buildReviewPackage` BINDS them — criteria, the two
 * hashes, receipts, rubric, submitted bytes, tree — which is not the order they are submitted in.
 * Hand-written, so an eighth fixture item cannot appear on both sides and stay green.
 */
const BOUND_ITEMS = [
  { digest: hex64("c1"), kind: "CRITERION", locator: "criterion-1" },
  { digest: hex64("6a"), kind: "GRAPH_HASH", locator: "graph-1" },
  { digest: hex64("b1"), kind: "PLAN_HASH", locator: "plan-1" },
  { digest: hex64("d1"), kind: "DAEMON_RECEIPT", locator: "receipt-1" },
  { digest: hex64("2b"), kind: "RUBRIC", locator: "rubric-1" },
  { digest: hex64("5b"), kind: "SUBMITTED_BYTES", locator: "submitted-1" },
  { digest: hex64("f1"), kind: "INTEGRATED_TREE", locator: "tree-1" },
] as const;

const itemKey = (item: ReviewPackageItemInput): string =>
  `${item.kind}|${item.locator}|${item.digest}`;

/** Throws rather than returning `[]` on an absent marker: a silent empty set proves nothing. */
function itemsOf(stored: StoredPackageItems | undefined): readonly ReviewPackageBoundItem[] {
  if (stored?.status !== "PRESENT") throw new Error(`expected PRESENT items, got ${stored?.status}`);
  return stored.items;
}

describe("review command vocabulary", () => {
  it("covers exactly the four command kinds this task owns", () => {
    expect(new Set<string>(REVIEW_COMMAND_KINDS)).toEqual(new Set<string>(OWNED_KINDS));
    expect(REVIEW_COMMAND_KINDS).toHaveLength(4);
    expect(OWNED_KINDS).toHaveLength(4);
  });

  it("names only kinds the runtime command vocabulary already declares", () => {
    const vocabulary = new Set<string>(RUNTIME_COMMAND_KINDS);
    expect(REVIEW_COMMAND_KINDS.filter((kind) => !vocabulary.has(kind))).toEqual([]);
  });

  it("does not claim any bootstrap or J1 command kind", () => {
    const foreign = ["approval.decide", "goal.close", "goal.create", "plan.propose"];
    expect(REVIEW_COMMAND_KINDS.filter((kind) => foreign.includes(kind))).toEqual([]);
  });
});

describe("a review round is recorded durably through @moe/review (DoD 1)", () => {
  it("commits exactly one decision carrying the pure layer's own verdict", () => {
    const store = openStore();

    const outcome = submit(store, 1);

    expect(outcome.ok, outcome.ok ? "" : outcome.code).toBe(true);
    if (!outcome.ok) throw new Error("expected acceptance");
    expect(outcome.disposition).toBe("DECIDED");
    expect(outcome.authority).toBe("DURABLE_DECISION");
    expect(outcome.advisoryOnly).toBe(false);
    expect(decisionCount(store)).toBe(1);

    const ledger = readReviewLedger(store, PROJECT_ID, SUBJECT_REF);
    expect(ledger.lineage.unsuccessfulRounds).toBe(1);
    expect(ledger.lineage.records).toHaveLength(1);
    // The fingerprint comes from the production surface, not from a local reimplementation.
    expect(ledger.lineage.records[0]?.fingerprint).toBe(findingFingerprint({
      detail: "The completion node ships without the receipt its criterion requires.",
      ruleId: "rule-receipt-required",
      severity: "MAJOR",
      subject: { kind: "NODE", locator: "node-alpha" },
    }));
    expect(ledger.rounds[0]?.routing.route).toBe("REJECT_IMPLEMENTATION");
    expect(ledger.rounds[0]?.routing.layer).toBe("FINDINGS");
  });

  it("binds each recorded round to the evidence package digest it was raised against", () => {
    const store = openStore();

    expect(submit(store, 1).ok).toBe(true);

    const ledger = readReviewLedger(store, PROJECT_ID, SUBJECT_REF);
    expect(ledger.rounds[0]?.reviewInputDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("persists the item set the kernel bound, recoverable through the read model", () => {
    const store = openStore();

    expect(submit(store, 1).ok).toBe(true);

    const round = readReviewLedger(store, PROJECT_ID, SUBJECT_REF).rounds[0];
    expect(round?.packageItems).toEqual({ items: BOUND_ITEMS, status: "PRESENT" });
    // The same seven values that went in, compared as a set: no item dropped, added or edited.
    // A count would pass for a substituted item, which is the failure this exists to see.
    expect(itemsOf(round?.packageItems).map(itemKey).sort())
      .toEqual(packageItems().map(itemKey).sort());
  });

  it("persists the bound set rather than the caller's array, order included", () => {
    const store = openStore();
    // Reversed input. `buildReviewPackage` binds by kind into six slots, so the stored order can
    // only match the caller's if the RAW parsed array was persisted instead of the bound set —
    // which would durably record content the stored digest does not attest.
    const reversed = [...packageItems()].reverse();

    const outcome = send(store, envelope("review.submit", 0, submitPayload(1, [finding()], {
      packageItems: reversed,
    })));

    expect(outcome.ok, outcome.ok ? "" : outcome.code).toBe(true);
    const round = readReviewLedger(store, PROJECT_ID, SUBJECT_REF).rounds[0];
    expect(round?.packageItems).toEqual({ items: BOUND_ITEMS, status: "PRESENT" });
    expect(round?.packageItems).not.toEqual({ items: reversed, status: "PRESENT" });
  });

  it("leaves the durable event payload untouched while the result gains the items", () => {
    const store = openStore();

    expect(submit(store, 1).ok).toBe(true);

    // The event is the public durable shape other readers consume; recoverability is a RESULT
    // concern. A fifth key here would drag every event consumer into a review-only fix.
    const events = store.readEvents(SUBJECT_REF);
    expect(events).toHaveLength(1);
    const payload: unknown = JSON.parse(new TextDecoder().decode(events[0]?.payload));
    expect(Object.keys(payload as Record<string, unknown>).sort())
      .toEqual(["reviewInputDigest", "round", "route", "subjectRef"]);
  });

  it("survives a store restart rather than living in process memory", () => {
    const restartable = openRestartableStore();
    expect(submit(restartable.store, 1).ok).toBe(true);
    const before = readReviewLedger(restartable.store, PROJECT_ID, SUBJECT_REF);

    const reopened = reopen(restartable);

    expect(readReviewLedger(reopened, PROJECT_ID, SUBJECT_REF)).toEqual(before);
    // A second round through the REOPENED handle proves the counter was read from the store:
    // an in-memory lineage would restart at zero and report one unsuccessful round, not two.
    const second = send(
      reopened,
      envelope("review.submit", 1, submitPayload(2, [
        finding({ ruleId: "rule-2", subject: { kind: "NODE", locator: "node-beta" } }),
      ]), "cmd-round-2"),
    );
    expect(second.ok, second.ok ? "" : second.code).toBe(true);
    expect(readReviewLedger(reopened, PROJECT_ID, SUBJECT_REF).lineage.unsuccessfulRounds).toBe(2);
  });

  it("replays an identical command as the same decision and writes no second row", () => {
    const store = openStore();
    const first = submit(store, 1);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected acceptance");

    const replay = submit(store, 1);

    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error("expected replay");
    expect(replay.disposition).toBe("REPLAYED");
    expect(replay.decision.decisionId).toBe(first.decision.decisionId);
    expect(replay.decision.resultSha256).toBe(first.decision.resultSha256);
    // Read the row count back. "The second call did not throw" is exactly what a double write
    // also looks like, so the returned value cannot be the evidence here.
    expect(decisionCount(store)).toBe(1);
    expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF).lineage.unsuccessfulRounds).toBe(1);
  });
});

describe("a refusal names the code AND the layer that produced it", () => {
  it("surfaces @moe/review's own append-only code when a round does not advance", () => {
    const store = openStore();
    expect(submit(store, 1).ok).toBe(true);
    const before = decisionCount(store);

    // A distinct commandId, so the replay short-circuit cannot answer first and the round
    // number itself is what the pure layer judges.
    const outcome = send(
      store,
      envelope("review.submit", 1, submitPayload(1), "cmd-round-1-again"),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("FINDING_LINEAGE_APPEND_ONLY");
    expect(REVIEW_REASON_CODES).toContain(outcome.code);
    expect(outcome.refusedBy).toBe("REVIEW_KERNEL");
    expect(outcome.kernelLayer).toBe("FINDINGS");
    expect(outcome.authority).toBe("NONE");
    expect(decisionCount(store)).toBe(before);
  });

  it("refuses an unbindable evidence package with the pure layer's PACKAGE code", () => {
    const store = openStore();

    // Every item but the daemon receipt: findings with no evidence link cannot be recorded.
    const outcome = send(store, envelope("review.submit", 0, submitPayload(1, [finding()], {
      packageItems: packageItems().filter((item) => item["kind"] !== "DAEMON_RECEIPT"),
    })));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("PACKAGE_BINDING_INCOMPLETE");
    expect(outcome.refusedBy).toBe("REVIEW_KERNEL");
    expect(outcome.kernelLayer).toBe("PACKAGE");
    expect(decisionCount(store)).toBe(0);
  });

  it("writes no round at all when the items fail to bind, so validation precedes storage", () => {
    const store = openStore();

    const outcome = send(store, envelope("review.submit", 0, submitPayload(1, [finding()], {
      packageItems: packageItems().filter((item) => item["kind"] !== "DAEMON_RECEIPT"),
    })));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    // The ORIGINAL code and layer, unchanged by persistence being added downstream of them.
    expect(outcome.code).toBe("PACKAGE_BINDING_INCOMPLETE");
    expect(outcome.kernelLayer).toBe("PACKAGE");
    // Three independent witnesses that nothing was written. A refusal that stored the items
    // anyway would still return this code, so the return value cannot be the evidence.
    expect(decisionCount(store)).toBe(0);
    expect(store.readEvents(SUBJECT_REF)).toHaveLength(0);
    expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF).rounds).toEqual([]);
  });

  it("refuses a forbidden package item with its own code rather than the unknown-kind one", () => {
    const store = openStore();

    const outcome = send(store, envelope("review.submit", 0, submitPayload(1, [finding()], {
      packageItems: [
        ...packageItems(),
        { digest: hex64("ee"), kind: "WORKER_TRANSCRIPT", locator: "transcript-1" },
      ],
    })));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("PACKAGE_ITEM_KIND_FORBIDDEN");
    expect(outcome.kernelLayer).toBe("PACKAGE");
    expect(decisionCount(store)).toBe(0);
  });

  it("refuses undecodable bytes at the ingress layer", () => {
    const store = openStore();

    const outcome = runReviewCommand(store, encoder.encode("{not json"));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("REVIEW_INPUT_REJECTED");
    expect(outcome.refusedBy).toBe("DAEMON_INGRESS");
    expect(outcome.kind).toBeNull();
    expect(decisionCount(store)).toBe(0);
  });

  it("refuses a kind outside this surface under its own code, not as a bad envelope", () => {
    const store = openStore();

    const outcome = send(store, envelope("goal.close", 0, { subjectRef: SUBJECT_REF }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("REVIEW_COMMAND_UNKNOWN");
    expect(outcome.refusedBy).toBe("DAEMON_INGRESS");
    expect(decisionCount(store)).toBe(0);
  });

  it("refuses a wrong schema version as an invalid envelope", () => {
    const store = openStore();
    const request = { ...envelope("review.submit", 0, submitPayload(1)), schemaVersion: "other/1" };

    const outcome = send(store, request);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("REVIEW_REQUEST_INVALID");
    expect(outcome.refusedBy).toBe("DAEMON_INGRESS");
    expect(REVIEW_SCHEMA_VERSION).not.toBe("other/1");
  });

  it("refuses a payload with no findings array at the daemon shape gate", () => {
    const store = openStore();

    const outcome = send(store, envelope("review.submit", 0, {
      packageItems: packageItems(),
      round: 1,
      subjectRef: SUBJECT_REF,
    }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("REVIEW_PAYLOAD_INVALID");
    expect(outcome.refusedBy).toBe("DAEMON_INGRESS");
    expect(outcome.kernelLayer).toBeNull();
    expect(outcome.detail).toBe("findings must be a JSON array, got absent");
    expect(decisionCount(store)).toBe(0);
  });

  /**
   * The live defect (UnAI 2026-09-18): three seats each sent `round` as the JSON string "2",
   * read a bare REVIEW_PAYLOAD_INVALID, and burned a call finding out by trial that the number
   * was wanted. The refusal is UNCHANGED — "4" is still not a round, nothing coerces — and the
   * detail now names the field, the type and what arrived, then travels to the wire verbatim.
   */
  it("refuses round as the string \"4\" and says which field, which type and what arrived", () => {
    const store = openStore();

    const outcome = send(store, envelope("review.submit", 0, submitPayload(1, [finding()], { round: "4" })));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("REVIEW_PAYLOAD_INVALID");
    expect(outcome.refusedBy).toBe("DAEMON_INGRESS");
    expect(outcome.detail).toBe('round must be a JSON integer >= 1, got string "4"; send the number unquoted');
    expect(decisionCount(store)).toBe(0);

    // The dispatch translation keeps the authority's own words: the seat reads them off the
    // HTTP/MCP refusal body as `refusal.detail`, not the code echoed as its own detail.
    let raised: unknown;
    try { decisionOf(outcome); } catch (error) { raised = error; }
    expect(raised).toBeInstanceOf(DomainRefusal);
    expect(raised).toMatchObject({
      code: "REVIEW_PAYLOAD_INVALID", detail: outcome.detail, layer: "DAEMON_INGRESS",
    });
  });

  it.each([
    { detail: "round must be a JSON integer >= 1, got number 0", label: "round 0", round: 0 },
    { detail: "round must be a JSON integer >= 1, got number 1.5", label: "round 1.5", round: 1.5 },
    { detail: "round must be a JSON integer >= 1, got null", label: "round null", round: null },
  ])("names the offending round value for $label", ({ detail, round }) => {
    const store = openStore();
    const outcome = send(store, envelope("review.submit", 0, submitPayload(1, [finding()], { round })));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect({ code: outcome.code, detail: outcome.detail }).toEqual({ code: "REVIEW_PAYLOAD_INVALID", detail });
  });

  it("names an unexpected payload key and the exact roster it must match", () => {
    const store = openStore();

    const outcome = send(store, envelope("review.submit", 0, submitPayload(1, [finding()], { reviewer: "me" })));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("REVIEW_PAYLOAD_INVALID");
    expect(outcome.detail).toBe("payload must have exactly findings, packageItems, round, subjectRef; unexpected: reviewer");
  });

  it("keeps the unexpected-key detail under 1 KiB against 50 keys of 300 chars", () => {
    // The header's rule on the wire: 15 000 bytes of caller keys come back as 8 cut keys and a
    // count, so a hostile payload cannot make its own refusal grow with it.
    const store = openStore();
    const hostile: Record<string, unknown> = {};
    for (let index = 0; index < 50; index += 1) hostile[`k${String(index).padStart(2, "0")}${"x".repeat(297)}`] = index;

    const outcome = send(store, envelope("review.submit", 0, submitPayload(1, [finding()], hostile)));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("REVIEW_PAYLOAD_INVALID");
    expect(Buffer.byteLength(outcome.detail ?? "", "utf8")).toBeLessThan(1024);
    expect(outcome.detail).toContain("+42 more");
    expect(outcome.detail).not.toContain("x".repeat(64));
  });

  it("names the malformed finding by index and member, against the kernel's own vocabulary", () => {
    const store = openStore();

    const outcome = send(store, envelope("review.submit", 0, submitPayload(1, [
      finding(), finding({ severity: "BLOCKER" }),
    ])));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("REVIEW_PAYLOAD_INVALID");
    expect(outcome.detail).toBe('findings[1].severity must be one of CRITICAL, MAJOR, MINOR, got string "BLOCKER"');
    expect(decisionCount(store)).toBe(0);
  });

  it("names a malformed package item by index and member", () => {
    const store = openStore();

    const outcome = send(store, envelope("review.submit", 0, submitPayload(1, [finding()], {
      packageItems: [...packageItems(), { digest: hex64("99"), kind: "RUBRIC", locator: 7 }],
    })));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("REVIEW_PAYLOAD_INVALID");
    expect(outcome.detail).toBe("packageItems[7].locator must be a JSON string, got number 7");
  });

  it("carries no detail on a refusal whose code is the whole answer", () => {
    const store = openStore();
    expect(submit(store, 1).ok).toBe(true);

    const outcome = send(store, envelope("review.submit", 99, submitPayload(2), "cmd-stale-no-detail"));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("REVIEW_EXPECTED_VERSION_STALE");
    expect(outcome.detail).toBeNull();
    let raised: unknown;
    try { decisionOf(outcome); } catch (error) { raised = error; }
    expect(raised).toMatchObject({ code: "REVIEW_EXPECTED_VERSION_STALE", detail: "REVIEW_EXPECTED_VERSION_STALE" });
  });

  it("refuses a stale expected version at the daemon prerequisite gate", () => {
    const store = openStore();
    expect(submit(store, 1).ok).toBe(true);
    const before = decisionCount(store);

    const outcome = send(
      store,
      envelope("review.submit", 99, submitPayload(2), "cmd-stale-version"),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("REVIEW_EXPECTED_VERSION_STALE");
    expect(outcome.refusedBy).toBe("DAEMON_PREREQUISITE");
    expect(decisionCount(store)).toBe(before);
  });

  it("refuses a round whose stored result would exceed the read bound, keeping the subject readable", () => {
    const store = openStore();
    // Round 1 sits near the bound but under it: it commits AND reads back.
    seedLineageNearReadBound(store);
    expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF).unreadable).toBe(false);
    const before = decisionCount(store);

    // Round 2 re-snapshots the full lineage plus two more near-cap findings — past the
    // MAX_JSON_BODY_BYTES bound the result's sole reader enforces. Pre-fix this committed
    // ok:true and every later read of the subject was permanently unreadable, so every
    // handler refused the subject forever; the write side must refuse the round instead.
    const poison = send(store, oversizeRoundEnvelope());

    const after = readReviewLedger(store, PROJECT_ID, SUBJECT_REF);
    // One comparison carrying the whole pre-fix symptom: the poisoning write reads as
    // { ok: true, code: null, unreadable: true } and fails this in a single diff.
    expect({ ok: poison.ok, code: poison.ok ? null : poison.code, unreadable: after.unreadable })
      .toEqual({ ok: false, code: "REVIEW_RESULT_TOO_LARGE", unreadable: false });
    if (poison.ok) throw new Error("expected refusal");
    expect(poison.refusedBy).toBe("DAEMON_PREREQUISITE");
    expect(decisionCount(store)).toBe(before);
    expect(after.rounds).toHaveLength(1);

    // The refusal is per-command, not a poisoned subject: a small round 2 still records.
    // (Intended limit of this rule: once the lineage ITSELF nears the bound, every further
    // submit refuses TOO_LARGE — the subject stays readable and escalation still works.)
    const recovery = send(
      store,
      envelope("review.submit", 1, submitPayload(2), "cmd-small-round-2"),
    );
    expect(recovery.ok, recovery.ok ? "" : recovery.code).toBe(true);
    expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF).rounds).toHaveLength(2);
  });

  it("refuses a commandId reused under a different kind, claiming no authority", () => {
    const store = openStore();
    expect(submit(store, 1).ok).toBe(true);
    const before = decisionCount(store);

    // The decision key is (commandId, principalId, projectId) with NO kind, so without this
    // guard the round's decision would be handed back as an accepted escalation.
    const outcome = send(
      store,
      envelope("escalation.decide", 1, { decision: "ALLOW_MORE_ATTEMPTS", escalationRef: "e-1", subjectRef: SUBJECT_REF },
        "cmd-round-1"),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("REVIEW_COMMAND_ID_REUSED");
    expect(outcome.refusedBy).toBe("DAEMON_PREREQUISITE");
    expect(outcome.authority).toBe("NONE");
    expect(decisionCount(store)).toBe(before);
  });

  it("refuses a commandId reused under the same kind with different bytes, claiming no authority", () => {
    const store = openStore();
    const first = submit(store, 1);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected acceptance");
    const before = decisionCount(store);

    // Same key (commandId, principalId, projectId) and same kind, but another subject, another
    // round and other findings. Without the byte fence the round-1 decision came back as an
    // accepted REPLAYED outcome: durable authority for a command never decided with these bytes.
    const outcome = send(
      store,
      envelope(
        "review.submit", 0,
        submitPayload(7, [finding({ ruleId: "rule-other" })], { subjectRef: "node-run-OTHER" }),
        "cmd-round-1",
      ),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("REVIEW_COMMAND_BYTES_CONFLICT");
    expect(outcome.refusedBy).toBe("DAEMON_PREREQUISITE");
    expect(outcome.authority).toBe("NONE");
    expect(decisionCount(store)).toBe(before);
    // The honest replay still answers: identical bytes under the same key.
    const replay = submit(store, 1);
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error("expected replay");
    expect(replay.disposition).toBe("REPLAYED");
    expect(replay.decision.decisionId).toBe(first.decision.decisionId);
  });
});

/**
 * A refused command id is SPENT. The store folds the presented expectedVersion into the
 * request identity, so a resubmit under the same commandId at the refreshed version carried
 * different request bytes under the same key: `replayOf` declined to answer from the
 * NO_BUSINESS_EFFECT row ("decide it again from scratch"), the handler's own version check
 * passed, `commitAccepted` reached the store, and the store threw IdempotencyConflictError —
 * a bare 409 at the transport. The bootstrap family closed the same hole with
 * BOOTSTRAP_COMMAND_ID_SPENT.
 */
describe("runReviewCommand spends a refused command id", () => {
  it("refuses the resubmit at the refreshed version with a stable code, never a store throw", () => {
    const store = openStore();
    expect(submit(store, 1).ok).toBe(true);
    // The daemon's own version pre-check answers a stale fence before the store, so the
    // NO_BUSINESS_EFFECT row a concurrent commit leaves behind is written here through the
    // PRODUCTION commit seam under a stale fence, not forged.
    const decoded = decodeReviewRequestBytes(new TextEncoder().encode(JSON.stringify(
      envelope("review.submit", 0, submitPayload(2), "cmd-spent"),
    )));
    if (!decoded.ok) throw new Error(decoded.code);
    const refused = commitAccepted(store, decoded.request, {
      aggregateId: SUBJECT_REF, eventPayload: { ignored: true }, eventType: "ReviewRoundRecorded",
      expectedVersion: 0, result: { ignored: true },
    });
    expect(refused).toMatchObject({
      code: "EXPECTED_VERSION_CONFLICT", ok: false, refusedBy: "DURABLE_STORE",
    });
    const before = decisionCount(store);

    const spent = { code: "REVIEW_COMMAND_ID_SPENT", ok: false, refusedBy: "DAEMON_PREREQUISITE" };
    expect(send(store, envelope("review.submit", 1, submitPayload(2), "cmd-spent")))
      .toMatchObject(spent);
    expect(send(store, envelope("review.submit", 0, submitPayload(2), "cmd-spent")))
      .toMatchObject(spent);
    expect(send(store, envelope("review.submit", 1, submitPayload(3), "cmd-spent")))
      .toMatchObject(spent);
    expect(decisionCount(store)).toBe(before);
    expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF).rounds).toHaveLength(1);

    // The retry path is a NEW id at the refreshed version.
    expect(send(store, envelope("review.submit", 1, submitPayload(2), "cmd-spent-2")))
      .toMatchObject({ disposition: "DECIDED", ok: true });
  });
});
