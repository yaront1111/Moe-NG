import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeCommandEnvelope } from "@moe/contracts";

import { PROJECT_ID, closeStores, openStore } from "../review/review-test-fixtures.js";
import type { CommandHandlerInput } from "../http/http-contract.js";
import { DomainRefusal } from "../daemon-command-dispatch.js";
import {
  REMOTE_BOUND_EVENT_TYPE, REPOSITORY_PUBLISH_COMMAND_KIND, publishAggregateId, remoteAggregateId,
} from "../repository/publish-receipt-contracts.js";
import { recordPublishReceipt } from "../repository/publish-ledger.js";
import { RELEASE_DECIDE_CODE_LAYER_MAP } from "./release-decide-contracts.js";
import { createReleaseDecideHandler } from "./release-decide-service.js";
import type { ReleaseDossierFacts, ReleasePublisher } from "./release-decide-service.js";
import { releaseDossierAggregateId, releaseDossierId } from "./release-dossier-contracts.js";
import type { DossierInput } from "./release-dossier-contracts.js";
import { GOAL_ID, HEAD_SHA, ancestryOf, dossierInput } from "./release-dossier-fixtures.js";
import { readReleaseDossier, recordReleaseDossier } from "./release-dossier-ledger.js";
import { releaseDossierGaps, renderReleaseDossier } from "./release-dossier.js";
import type { ReleasePrPort, ReleasePrRequest, ReleasePrResult } from "./release-pr-port.js";
import { decodeReleaseReceiptBytes } from "./release-receipt-contracts.js";

afterEach(closeStores);

const OPERATOR = "human:operator";
const REMOTE_URL = "https://github.com/acme/widget.git";
const BRANCH = "moe/goal-release-1";
const BASE = "main";
const PR_URL = "https://github.com/acme/widget/pull/7";
const DECIDED_AT = "2026-09-06T15:00:00.000Z";

type Store = ReturnType<typeof openStore>;

/** Only the two criteria whose evidence is complete: the default fixture carries a gap. */
function completeInput(): DossierInput {
  const base = dossierInput({ projectId: PROJECT_ID });
  return {
    ...base,
    criteria: base.criteria.filter((criterion) => criterion.criterionId !== "crit-charlie"),
  };
}

function bindRemote(store: Store): void {
  const aggregateId = remoteAggregateId(PROJECT_ID);
  store.commitExpectedVersionDecision({
    commandKind: "repository.publish",
    committedResultBytes: new TextEncoder().encode("{}"),
    correlationId: "test-bind-remote",
    decidedAt: DECIDED_AT,
    events: [{
      eventId: "test-remote-bound",
      eventType: REMOTE_BOUND_EVENT_TYPE,
      payload: new TextEncoder().encode(JSON.stringify({
        boundAt: DECIDED_AT, boundBy: OPERATOR, remoteUrl: REMOTE_URL,
      })),
    }],
    expectedVersion: store.getAggregateVersion(aggregateId),
    key: { commandId: "test-bind-remote", principalId: OPERATOR, projectId: PROJECT_ID },
    requestBytes: new TextEncoder().encode("{}"),
    targetAggregateId: aggregateId,
  });
}

/**
 * A PUSHED publish, request AND receipt.
 *
 * The request is not decoration: `readPublishLedger` builds its per-goal state by walking
 * REQUESTS and attaching receipts to them, so a goal with a receipt and no request is
 * absent from the map entirely. In production a receipt only exists because a request
 * drove the publisher, so recording the receipt alone was a fixture that could not occur
 * — measured the hard way when the happy-path arm refused RELEASE_PR_FAILED.
 */
function recordPush(store: Store): void {
  const aggregateId = publishAggregateId(GOAL_ID);
  store.commitExpectedVersionDecision({
    commandKind: REPOSITORY_PUBLISH_COMMAND_KIND,
    committedResultBytes: new TextEncoder().encode(JSON.stringify({
      goalId: GOAL_ID, remoteUrl: REMOTE_URL,
    })),
    correlationId: "test-publish-request",
    decidedAt: DECIDED_AT,
    // At least one event: the store refuses an empty `events` with STORE_INPUT_INVALID.
    events: [{
      eventId: "test-publish-requested",
      eventType: "RepositoryPublishRequested",
      payload: new TextEncoder().encode(JSON.stringify({ goalId: GOAL_ID })),
    }],
    expectedVersion: store.getAggregateVersion(aggregateId),
    key: { commandId: "decision-push-1", principalId: OPERATOR, projectId: PROJECT_ID },
    requestBytes: new TextEncoder().encode("{}"),
    targetAggregateId: aggregateId,
  });
  recordPublishReceipt(store, {
    branch: BRANCH, decidedAt: DECIDED_AT, decisionId: "decision-push-1", goalId: GOAL_ID,
    projectId: PROJECT_ID, refusal: null, remoteUrl: REMOTE_URL, sha: HEAD_SHA,
    url: `${REMOTE_URL}/tree/${BRANCH}`,
  });
}

/** A SECOND publish decision + receipt, so the goal holds two PUSHED receipts in order. */
function recordPushAgain(store: Store, branch: string | null, decisionId: string): void {
  const aggregateId = publishAggregateId(GOAL_ID);
  store.commitExpectedVersionDecision({
    commandKind: REPOSITORY_PUBLISH_COMMAND_KIND,
    committedResultBytes: new TextEncoder().encode(JSON.stringify({
      goalId: GOAL_ID, remoteUrl: REMOTE_URL,
    })),
    correlationId: "test-publish-request-2",
    decidedAt: DECIDED_AT,
    events: [{
      eventId: `${decisionId}-requested`,
      eventType: "RepositoryPublishRequested",
      payload: new TextEncoder().encode(JSON.stringify({ goalId: GOAL_ID })),
    }],
    expectedVersion: store.getAggregateVersion(aggregateId),
    key: { commandId: decisionId, principalId: OPERATOR, projectId: PROJECT_ID },
    requestBytes: new TextEncoder().encode("{}"),
    targetAggregateId: aggregateId,
  });
  recordPublishReceipt(store, {
    branch, decidedAt: DECIDED_AT, decisionId, goalId: GOAL_ID, projectId: PROJECT_ID,
    refusal: null, remoteUrl: REMOTE_URL, sha: HEAD_SHA,
    url: branch === null ? null : `${REMOTE_URL}/tree/${branch}`,
  });
}

function storeDossier(store: Store, input: DossierInput): string {
  const markdown = renderReleaseDossier(input, HEAD_SHA, ancestryOf().predicate);
  const recorded = recordReleaseDossier(store, {
    decidedAt: DECIDED_AT, goalId: GOAL_ID, markdown, projectId: PROJECT_ID, sha: HEAD_SHA,
  });
  if (!recorded.ok) throw new Error(recorded.code);
  return markdown;
}

function fakePublisher(outcome = "PUSHED"): ReleasePublisher & { readonly calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    async publishOnce() {
      calls.push(1);
      return [{ detail: outcome === "PUSHED" ? "pushed" : "PUBLISH_APPROVAL_REQUIRED",
        goalId: GOAL_ID, outcome }];
    },
  };
}

function fakePrPort(result: ReleasePrResult): ReleasePrPort & {
  readonly requests: ReleasePrRequest[];
} {
  const requests: ReleasePrRequest[] = [];
  return {
    requests,
    async open(request: ReleasePrRequest) {
      requests.push(request);
      return result;
    },
  };
}

function inputOf(decision: "APPROVE" | "REJECT" = "APPROVE"): CommandHandlerInput {
  return {
    envelope: {
      commandId: "cmd-release-1",
      payload: { base: BASE, decision, goalId: GOAL_ID, sha: HEAD_SHA },
    } as unknown as RuntimeCommandEnvelope,
    principal: { principalId: OPERATOR },
  } as unknown as CommandHandlerInput;
}

function facts(input: DossierInput): () => ReleaseDossierFacts {
  return () => ({ ancestry: ancestryOf().predicate, input });
}

interface HandlerParts {
  readonly handler: ReturnType<typeof createReleaseDecideHandler>;
  readonly prPort: ReturnType<typeof fakePrPort>;
  readonly publisher: ReturnType<typeof fakePublisher>;
}

function build(store: Store, over: {
  input?: DossierInput; prResult?: ReleasePrResult; pushOutcome?: string;
} = {}): HandlerParts {
  const prPort = fakePrPort(over.prResult ?? { ok: true, prUrl: PR_URL });
  const publisher = fakePublisher(over.pushOutcome ?? "PUSHED");
  const handler = createReleaseDecideHandler({
    clock: () => DECIDED_AT,
    dossierFacts: facts(over.input ?? completeInput()),
    operatorPrincipalId: OPERATOR,
    prPort,
    projectId: PROJECT_ID,
    publisher,
    store,
  });
  return { handler, prPort, publisher };
}

/** Every refusal is asserted by CODE AND LAYER, resolved from the closed map itself. */
async function refusalOf(promise: Promise<unknown>): Promise<DomainRefusal> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainRefusal) return error;
    throw error;
  }
  throw new Error("expected a refusal, got success");
}

/** Positive absence: no RELEASED receipt exists for the goal, whatever the call returned. */
function releasedReceiptCount(store: Store): number {
  let count = 0;
  let cursor = 0n;
  for (;;) {
    const page = store.readCommandDecisionsAfter(cursor, 200);
    for (const decision of page.items) {
      if (decision.targetAggregateId !== releaseDossierAggregateId(GOAL_ID)) continue;
      const decoded = decodeReleaseReceiptBytes(decision.resultBytes);
      if (decoded.ok && decoded.receipt.outcome === "RELEASED") count += 1;
    }
    if (!page.hasMore || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return count;
}

describe("release.decide service", () => {
  it("refuses an unbound remote BEFORE anything is pushed or opened", async () => {
    const store = openStore();
    storeDossier(store, completeInput());
    const { handler, prPort, publisher } = build(store);

    const refusal = await refusalOf(handler(inputOf()));
    expect(refusal.code).toBe("RELEASE_REMOTE_MISSING");
    expect(refusal.layer).toBe(RELEASE_DECIDE_CODE_LAYER_MAP.RELEASE_REMOTE_MISSING);
    expect(refusal.layer).toBe("PROJECT_REDUCER");
    // The order IS the assertion: nothing was pushed and no PR was attempted.
    expect(publisher.calls).toHaveLength(0);
    expect(prPort.requests).toHaveLength(0);
    expect(releasedReceiptCount(store)).toBe(0);
  });

  it("names the missing criterion ids when the evidence is incomplete", async () => {
    const store = openStore();
    bindRemote(store);
    // The default fixture carries crit-charlie, which no node covers.
    const gappy = dossierInput({ projectId: PROJECT_ID });
    const { handler, prPort, publisher } = build(store, { input: gappy });

    const refusal = await refusalOf(handler(inputOf()));
    expect(refusal.code).toBe("RELEASE_EVIDENCE_INCOMPLETE");
    expect(refusal.layer).toBe(RELEASE_DECIDE_CODE_LAYER_MAP.RELEASE_EVIDENCE_INCOMPLETE);
    expect(refusal.layer).toBe("DAEMON_PREREQUISITE");
    // The IDS, not the sentence: "evidence incomplete" alone sends the operator hunting.
    const expected = releaseDossierGaps(gappy, HEAD_SHA, ancestryOf().predicate);
    expect(expected.length).toBeGreaterThan(0);
    for (const gap of expected) expect(refusal.detail).toContain(gap.criterionId);
    expect(refusal.detail).toContain("crit-charlie");
    expect(publisher.calls).toHaveLength(0);
    expect(prPort.requests).toHaveLength(0);
  });

  it("hands gh the STORED dossier bytes, identical to what the store reads back", async () => {
    const store = openStore();
    bindRemote(store);
    recordPush(store);
    const stored = completeInput();
    // Precondition, asserted rather than assumed: this input has no gaps to refuse on.
    expect(releaseDossierGaps(stored, HEAD_SHA, ancestryOf().predicate)).toHaveLength(0);
    storeDossier(store, stored);

    // THE FACTS MOVE AFTER THE DOSSIER IS RECORDED. Without this the arm is VACUOUS:
    // a fresh render of unchanged facts is byte-identical to the stored bytes, so
    // "body === the store read" passes whether the service reads the record or re-renders.
    // Measured, not theorised — the step-9 mutation drill that substitutes a fresh render
    // stayed GREEN until this drift was introduced.
    const drifted: DossierInput = { ...stored, goalTitle: "Retitled after the release record" };
    expect(releaseDossierGaps(drifted, HEAD_SHA, ancestryOf().predicate)).toHaveLength(0);
    expect(renderReleaseDossier(drifted, HEAD_SHA, ancestryOf().predicate))
      .not.toBe(renderReleaseDossier(stored, HEAD_SHA, ancestryOf().predicate));

    const { handler, prPort, publisher } = build(store, { input: drifted });

    const decision = await handler(inputOf());
    expect(decision.resultCode).toBe("RELEASED");
    expect(decision.disposition).toBe("DECIDED");

    expect(prPort.requests).toHaveLength(1);
    const request = prPort.requests[0]!;
    // Asserted against the STORE READ, never against a literal or a fresh render.
    const readBack = readReleaseDossier(store, PROJECT_ID, releaseDossierId(PROJECT_ID, GOAL_ID, HEAD_SHA));
    if (!readBack.ok) throw new Error(readBack.code);
    expect(request.body).toBe(readBack.dossier.markdown);
    expect(Buffer.from(request.body, "utf8").equals(
      Buffer.from(readBack.dossier.markdown, "utf8"),
    )).toBe(true);
    // ...and POSITIVELY NOT a fresh render of the facts the handler was just given.
    expect(request.body)
      .not.toBe(renderReleaseDossier(drifted, HEAD_SHA, ancestryOf().predicate));
    expect(request.body).toContain("Ship the release dossier");
    expect(request.body).not.toContain("Retitled after the release record");
    // The whole request, byte for byte.
    expect(request).toEqual({
      base: BASE,
      body: readBack.dossier.markdown,
      head: BRANCH,
      title: `Release ${GOAL_ID} at ${HEAD_SHA}`,
    });
    // Exactly one push on the approve path.
    expect(publisher.calls).toHaveLength(1);
    expect(releasedReceiptCount(store)).toBe(1);
  });

  it("refuses RELEASE_PR_FAILED with the stderr line and records NO released receipt",
    async () => {
      for (const prResult of [
        { ok: false, spawnErrorCode: "ENOENT", stderrLastLine: "" } as const,
        { ok: false, spawnErrorCode: null, stderrLastLine: "gh auth login required" } as const,
        { ok: false, spawnErrorCode: null, stderrLastLine: "pull request already exists" } as const,
      ]) {
        const store = openStore();
        bindRemote(store);
        recordPush(store);
        const input = completeInput();
        storeDossier(store, input);
        const { handler, prPort } = build(store, { input, prResult });

        const refusal = await refusalOf(handler(inputOf()));
        expect(refusal.code).toBe("RELEASE_PR_FAILED");
        expect(refusal.layer).toBe(RELEASE_DECIDE_CODE_LAYER_MAP.RELEASE_PR_FAILED);
        expect(refusal.layer).toBe("RUNNER_WORKSPACE");
        if (prResult.stderrLastLine.length > 0) {
          expect(refusal.detail).toBe(prResult.stderrLastLine);
        } else {
          expect(refusal.detail).toContain("ENOENT");
        }
        expect(prPort.requests).toHaveLength(1);
        // POSITIVE ABSENCE, read back out of the store: a refused release that recorded
        // success is the worst outcome here, so trusting the return value is not enough.
        expect(releasedReceiptCount(store)).toBe(0);
      }
    });

  it("refuses when the head was never pushed, and never opens a pull request", async () => {
    const store = openStore();
    bindRemote(store);
    // No publish receipt recorded: publishOnce reports REFUSED and the ledger has no PUSHED.
    const input = completeInput();
    storeDossier(store, input);
    const { handler, prPort, publisher } = build(store, { input, pushOutcome: "REFUSED" });

    const refusal = await refusalOf(handler(inputOf()));
    expect(refusal.code).toBe("RELEASE_PR_FAILED");
    expect(refusal.layer).toBe("RUNNER_WORKSPACE");
    expect(refusal.detail).toContain("PUBLISH_APPROVAL_REQUIRED");
    expect(publisher.calls).toHaveLength(1);
    expect(prPort.requests).toHaveLength(0);
    expect(releasedReceiptCount(store)).toBe(0);
  });

  it("opens the PR from the LATEST pushed branch, not the first one recorded", async () => {
    // ADVERSARIAL: a goal pushed twice holds two PUSHED receipts. Taking the first opens the
    // pull request from a branch the operator has already moved away from.
    const store = openStore();
    bindRemote(store);
    recordPush(store);
    recordPushAgain(store, "moe/goal-release-1-v2", "decision-push-2");
    const input = completeInput();
    storeDossier(store, input);
    const { handler, prPort } = build(store, { input });

    await handler(inputOf());
    expect(prPort.requests[0]!.head).toBe("moe/goal-release-1-v2");
  });

  it("refuses rather than opening a PR when the only PUSHED receipt has a null branch",
    async () => {
      // ADVERSARIAL: `PublishReceiptV1.branch` is `string | null`. A null head has nothing
      // for gh to open from, so it must refuse, never spawn `gh --head ""`.
      const store = openStore();
      bindRemote(store);
      recordPushAgain(store, null, "decision-push-null");
      const input = completeInput();
      storeDossier(store, input);
      const { handler, prPort } = build(store, { input });

      const refusal = await refusalOf(handler(inputOf()));
      expect(refusal.code).toBe("RELEASE_PR_FAILED");
      expect(prPort.requests).toHaveLength(0);
    });

  it("replays an already-RELEASED sha instead of opening a SECOND pull request", async () => {
    // ADVERSARIAL: two dispatches for one goal and sha. The derived receipt id makes the
    // ledger refuse the duplicate RECORD, but that happens AFTER gh has run — so without a
    // check in front of the irreversible step the second dispatch opens a second PR.
    const store = openStore();
    bindRemote(store);
    recordPush(store);
    const input = completeInput();
    storeDossier(store, input);
    const { handler, prPort, publisher } = build(store, { input });

    const first = await handler(inputOf());
    expect(first.resultCode).toBe("RELEASED");
    expect(first.disposition).toBe("DECIDED");

    const second = await handler(inputOf());
    expect(second.resultCode).toBe("RELEASED");
    expect(second.disposition).toBe("REPLAYED");
    expect(second.effectId).toBe(first.effectId);
    // The whole point: gh ran ONCE and the branch was pushed ONCE.
    expect(prPort.requests).toHaveLength(1);
    expect(publisher.calls).toHaveLength(1);
    expect(releasedReceiptCount(store)).toBe(1);
  });

  it("REJECT pushes nothing and opens nothing", async () => {
    const store = openStore();
    bindRemote(store);
    const input = completeInput();
    storeDossier(store, input);
    const { handler, prPort, publisher } = build(store, { input });

    const decision = await handler(inputOf("REJECT"));
    expect(decision.resultCode).toBe("REJECTED");
    expect(publisher.calls).toHaveLength(0);
    expect(prPort.requests).toHaveLength(0);
    expect(releasedReceiptCount(store)).toBe(0);
  });

  it("fences on the operator principal before any effect", async () => {
    const store = openStore();
    const { handler, prPort, publisher } = build(store);
    const agent = {
      envelope: inputOf().envelope,
      principal: { principalId: "agent:worker-1" },
    } as unknown as CommandHandlerInput;

    const refusal = await refusalOf(handler(agent));
    expect(refusal.code).toBe("OPERATOR_PRINCIPAL_REQUIRED");
    expect(refusal.layer).toBe("DAEMON_AUTHORIZATION");
    expect(publisher.calls).toHaveLength(0);
    expect(prPort.requests).toHaveLength(0);
  });

  it("imports no git port: the only push in this module is the publisher's", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./release-decide-service.ts", import.meta.url)), "utf8",
    );
    const code = source
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/(^|[^:])\/\/.*$/gmu, "$1");
    expect(code).toContain("publisher.publishOnce");
    // Comments stripped first: this module's prose discusses the push path it does not take.
    expect(code).not.toContain("PublicationGitPort");
    expect(code).not.toContain("node-publisher.js");
    expect(code).not.toContain("git.push");
  });
});
