import type { JsonObject, JsonValue } from "@moe/contracts";

import { DomainRefusal, domainRefusalOf } from "../daemon-command-dispatch.js";
import type { AsyncCommandHandler } from "../http/http-async-contract.js";
import type { CommandHandlerInput, DurableDecision } from "../http/http-contract.js";
import { readPublishLedger, readProjectRemote } from "../repository/publish-ledger.js";
import { releaseRefusal } from "./release-decide-contracts.js";
import type { ReleaseDecideCode } from "./release-decide-contracts.js";
import { releaseDossierId } from "./release-dossier-contracts.js";
import type { AncestryPredicate, DossierInput } from "./release-dossier-contracts.js";
import { readReleaseDossier } from "./release-dossier-ledger.js";
import { releaseDossierGaps } from "./release-dossier.js";
import { dossierSha256, releaseReceiptId } from "./release-receipt-contracts.js";
import { readReleaseReceipt, recordReleaseReceipt } from "./release-receipt-ledger.js";
import type { ReleasePrPort } from "./release-pr-port.js";
import type { SqliteEventStore } from "@moe/store";
import { createReleaseDecideCommand } from "./release-decide-command.js";

/**
 * `release.decide`: push the goal's branch through the EXISTING publisher, then open a
 * pull request whose body is the STORED dossier bytes.
 *
 * ORDER IS LOAD-BEARING and is the whole design. Nothing is pushed and no receipt is
 * written until the cheap, local prerequisites have answered, because the expensive steps
 * are the irreversible ones: an unbound remote is discovered before a push, not after.
 */

export interface ReleaseDossierFacts {
  readonly ancestry: AncestryPredicate;
  readonly input: DossierInput;
}

/** The ledger fold this row consumes, injected so the service stays offline-testable. */
export type ReleaseDossierFactsPort = (goalId: string, sha: string) => ReleaseDossierFacts | null;

/** Exactly `createNodePublisher(...)`'s return shape. REUSE, never a second push path. */
export interface ReleasePublisher {
  publishOnce(): Promise<readonly { readonly detail: string; readonly goalId: string;
    readonly outcome: string; }[]>;
}

export interface ReleaseDecideOptions {
  readonly clock?: () => string;
  readonly dossierFacts: ReleaseDossierFactsPort;
  readonly operatorPrincipalId: string;
  readonly prPort: ReleasePrPort;
  readonly projectId: string;
  readonly publisher: ReleasePublisher;
  readonly store: SqliteEventStore;
}

/** Caller INTENT ONLY. projectId, principalId, correlationId and decidedAt are SERVER facts. */
interface ReleaseIntent {
  readonly base: string;
  readonly decision: "APPROVE" | "REJECT";
  readonly goalId: string;
  readonly sha: string;
}

const INTENT_KEYS = ["base", "decision", "goalId", "sha"] as const;

function ref(value: JsonValue | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function decodeIntent(payload: JsonObject): ReleaseIntent {
  const keys = Object.keys(payload);
  const decision = payload["decision"];
  if (keys.length !== INTENT_KEYS.length
    || !keys.every((key) => (INTENT_KEYS as readonly string[]).includes(key))
    || !ref(payload["base"]) || !ref(payload["goalId"]) || !ref(payload["sha"])
    || (decision !== "APPROVE" && decision !== "REJECT")) {
    throw new DomainRefusal("INPUT_INVALID", "DAEMON_COMMAND_SEAM",
      "release.decide takes exactly {base, decision, goalId, sha}", 422);
  }
  return { base: payload["base"], decision, goalId: payload["goalId"], sha: payload["sha"] };
}

function decisionOf(commandId: string, effectId: string | null, resultCode: string,
  replayed: boolean): DurableDecision {
  return { commandId, disposition: replayed ? "REPLAYED" : "DECIDED", effectId, resultCode };
}

/**
 * The head this release opens the PR from: the publisher's own MOST RECENT PUSHED receipt.
 *
 * LAST, not first. `readPublishLedger` walks the decision ledger in order and its own doc
 * says "the last one is the current one", so a goal pushed to one branch and later to
 * another holds two PUSHED receipts. Taking the first would open the pull request from a
 * STALE branch that the operator has already moved away from — the same failure
 * `readProjectRemote` documents for a superseded remote, one level down.
 *
 * A PUSHED receipt whose `branch` is null is SKIPPED rather than trusted: `branch` is
 * `string | null` on the receipt, and a null head has nothing for `gh` to open from, so
 * this answers null and the caller refuses instead of spawning `gh --head ""`.
 */
function pushedBranchOf(
  store: SqliteEventStore, projectId: string, goalId: string, sha: string, remoteUrl: string,
): string | null {
  const state = readPublishLedger(store, projectId).get(goalId);
  if (state === undefined) return null;
  let branch: string | null = null;
  for (const receipt of state.receipts.values()) {
    if (receipt.outcome === "PUSHED" && ref(receipt.branch)) {
      branch = receipt.sha === sha && receipt.remoteUrl === remoteUrl ? receipt.branch : null;
    }
  }
  return branch;
}

export function createReleaseDecideHandler(options: ReleaseDecideOptions): AsyncCommandHandler {
  const { dossierFacts, operatorPrincipalId, prPort, projectId, publisher, store } = options;
  const clock = options.clock ?? ((): string => new Date().toISOString());

  const execute = async ({ envelope, principal }: CommandHandlerInput): Promise<DurableDecision> => {
    // FENCED AT ENTRY. Async entries bypass the registry's synchronous fence, so this is
    // the only operator check that will ever run for this kind.
    if (principal.principalId !== operatorPrincipalId) {
      throw new DomainRefusal("OPERATOR_PRINCIPAL_REQUIRED", "DAEMON_AUTHORIZATION",
        "this command requires the configured operator principal", 403);
    }
    const intent = decodeIntent(envelope.payload);
    const { base, goalId, sha } = intent;
    const decidedAt = clock();

    const record = (
      outcome: "RELEASED" | "REFUSED",
      prUrl: string | null,
      refusalCode: ReleaseDecideCode | null,
      markdown: string,
    ): { readonly receiptId: string; readonly replayed: boolean } => {
      const written = recordReleaseReceipt(store, {
        decidedAt, dossierSha256: dossierSha256(markdown), goalId, outcome, prUrl, projectId,
        refusalCode, sha,
      });
      if (!written.ok) {
        throw domainRefusalOf(releaseRefusal("RELEASE_PR_FAILED",
          `the release receipt could not be recorded: ${written.code}`));
      }
      return { receiptId: written.receipt.receiptId, replayed: written.replayed };
    };

    // (1) UNBOUND REMOTE, before anything is pushed and before any receipt is written.
    const remote = readProjectRemote(store, projectId);
    if (remote === null) {
      throw domainRefusalOf(releaseRefusal("RELEASE_REMOTE_MISSING",
        `no repository remote is bound for project ${projectId}`));
    }

    // (2) EVIDENCE GAPS, naming the criterion ids. "Evidence incomplete" without saying
    // WHAT is missing sends the operator hunting through a document by hand.
    const facts = dossierFacts(goalId, sha);
    if (facts === null) {
      throw domainRefusalOf(releaseRefusal("RELEASE_EVIDENCE_INCOMPLETE",
        `no release evidence is readable for goal ${goalId}`));
    }
    const gaps = releaseDossierGaps(facts.input, sha, facts.ancestry);
    if (gaps.length > 0) {
      const criteria = [...new Set(gaps.map((gap) => gap.criterionId))].sort().join(", ");
      throw domainRefusalOf(releaseRefusal("RELEASE_EVIDENCE_INCOMPLETE",
        `unverified evidence for: ${criteria}`));
    }

    // (3) THE STORED DOSSIER. Its bytes become the PR body; a missing record means there
    // is no evidence document to carry, however complete the facts look.
    const dossier = readReleaseDossier(store, projectId, releaseDossierId(projectId, goalId, sha));
    if (!dossier.ok) {
      throw domainRefusalOf(releaseRefusal("RELEASE_EVIDENCE_INCOMPLETE",
        `no release dossier is recorded for goal ${goalId} at ${sha}: ${dossier.code}`));
    }
    const markdown = dossier.dossier.markdown;

    // A REJECT is the operator declining to release. It records its decision and stops:
    // nothing is pushed and no pull request is opened.
    if (intent.decision === "REJECT") {
      return decisionOf(envelope.commandId, null, "REJECTED", false);
    }

    // Command replay is answered by the admission journal. A receipt alone cannot prove
    // this new command's base or decision, so it cannot authorize another release command.
    const alreadyReleased = readReleaseReceipt(
      store, projectId, releaseReceiptId(projectId, goalId, sha, "RELEASED", null),
    );
    if (alreadyReleased.ok) {
      throw new DomainRefusal("RELEASE_COMMAND_ID_REQUIRED", "DAEMON_COMMAND_SEAM",
        "this SHA was already released; replay the exact original command", 409);
    }

    // (4) PUSH THROUGH THE EXISTING PUBLISHER, then read ITS receipt. A head that was
    // never pushed has nothing for `gh` to open a PR from, so this stays inside the closed
    // three-code set rather than minting a fourth.
    const reports = await publisher.publishOnce();
    const head = pushedBranchOf(store, projectId, goalId, sha, remote.remoteUrl);
    if (head === null) {
      const mine = reports.find((entry) => entry.goalId === goalId);
      const detail = mine === undefined ? "the goal's branch was not pushed" : mine.detail;
      const receipt = record("REFUSED", null, "RELEASE_PR_FAILED", markdown);
      throw domainRefusalOf(releaseRefusal("RELEASE_PR_FAILED",
        `${detail} [receipt ${receipt.receiptId}]`));
    }

    // (5) THE BODY IS THE STORED BYTES, never a fresh render. A second rendering is how a
    // pull request and the durable record come to disagree about what was proven.
    //
    // The TITLE is a server fact, derived here rather than taken from the payload: the
    // payload roster is exactly {base, decision, goalId, sha} and `decodeIntent` refuses
    // any key outside it, so a caller-supplied title could never arrive anyway.
    const opened = await prPort.open({
      base, body: markdown, head, remoteUrl: remote.remoteUrl, sha,
      title: `Release ${goalId} at ${sha}`,
    });

    // (6) Record the outcome either way. A refused release that recorded success is the
    // worst thing this module could do, so the REFUSED receipt is written before the throw.
    if (!opened.ok) {
      const detail = opened.stderrLastLine.length > 0
        ? opened.stderrLastLine
        : `gh did not start (${opened.spawnErrorCode ?? "unknown"})`;
      record("REFUSED", null, "RELEASE_PR_FAILED", markdown);
      throw domainRefusalOf(releaseRefusal("RELEASE_PR_FAILED", detail));
    }
    const written = record("RELEASED", opened.prUrl, null, markdown);
    return decisionOf(envelope.commandId, written.receiptId, "RELEASED", written.replayed);
  };
  return createReleaseDecideCommand(options, execute);
}
