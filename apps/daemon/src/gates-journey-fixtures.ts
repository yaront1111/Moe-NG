/**
 * THE WORLD THE THREE HUMAN GATES COMPOSE IN -- the fixture half of `gates-compose-journey`.
 *
 * A fixture module carries no line cap and needs no test of its own (same standing as
 * `planning/plan-reject-test-fixtures.ts`): every arm in the journey file smokes it, so a builder
 * that stopped reaching a gate would red the whole suite rather than pass quietly.
 *
 * MOCK NOTHING THAT DECIDES. Gate 1 is the production `product_contract.approve_gate_1` driven
 * through a REAL paired session; the design step is `design.submit` through the production HTTP
 * seam on a seat whose capabilities are read from `agentCapabilitiesFor` AT RUN TIME; Gate 2 is
 * `preview.decide` through the production registry over a production-written receipt, gated by
 * the production landing reader; Gate 3 is `release.decide` through the production ASYNC entry,
 * with its principal fence, remote check, `releaseDossierGaps`, dossier read, replay fence and
 * receipt write all production.
 *
 * WHAT IS DOUBLED, AND WHY NONE OF IT DECIDES -- exactly six seams, all outside the decision
 * path. (1) The CLOCK. (2) The preview PORT's process stop: there is no child dev server in this
 * lane to kill, and the DECISION is `runPreviewDecideEdge`'s. (3) and (4) Gate 3's two PROCESS
 * LAUNCHERS, the git publisher and the `gh` pull-request port -- the publisher double still writes
 * its PUSHED receipt through the PRODUCTION `recordPublishReceipt`, so `pushedBranchOf` reads a
 * real durable receipt and a double that LIED about pushing would be caught by production code.
 * (5) The git ANCESTRY MEASUREMENT, because this lane has no git object database and `ancestryAt`
 * shells out to `git cat-file`; the substitute answers ANCESTOR only for the sha under release,
 * never unconditionally, so the evidence gate is passed THROUGH rather than disarmed. (6) The git
 * CRITERION-ARTIFACT measurement, for exactly that reason -- `readCriterionArtifact` shells out to
 * `git rev-parse` and `git status` -- while `currentCriterionReceipts` still applies every one of
 * its own rules to records the production approval command, queue and receipt writer wrote. The
 * dossier FACTS themselves come from the production `readReleaseDossierInput` over this store.
 */
import { createHash } from "node:crypto";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import { expect } from "vitest";
import type { SqliteEventStore } from "@moe/store";

import { FIXTURE_PUBLICATION_APPROVAL, GOAL_ID, PROJECT_ID, closeStores, envelope, send }
  from "./bootstrap/bootstrap-test-fixtures.js";
import { OPERATOR_CAPABILITIES, agentCapabilitiesFor } from "./daemon-command-vocabulary.js";
import { createDaemonCommandPorts } from "./daemon-command-registry.js";
import { designRevisionFixture, designSkipFixture } from "./design/design-test-fixtures.js";
import { readDesignRevision } from "./design/design-store.js";
import { designAggregateId } from "./design/design-contracts.js";
import { seedPassedCriterionReceipts } from "./criterion-evidence/criterion-test-fixtures.js";
import { createSessionAuthenticator } from "./identity/session-authenticator.js";
import { handleAsyncCommandRequest, handleCommandRequest } from "./http/http-adapter.js";
import { WIRE_PROTOCOL_VERSION } from "./http/http-contract.js";
import type { CommandAdapterDeps } from "./http/http-contract.js";
import { compiledExecutionRef } from "./orchestrator/compiled-execution-ref.js";
import { activeCompiledGraphs } from "./orchestrator/compiled-node-source.js";
import { seedLandingReceipt } from "./goals/goal-closure-test-fixtures.js";
import { NODE_VERIFIER_PRINCIPAL_ID } from "./review/verifier-receipt-contracts.js";
import { recordVerifierReceipt } from "./review/verifier-receipt-ledger.js";
import { readReviewLedger } from "./review/review-read-model.js";
import { runReviewCommand } from "./review/review-services.js";
import { calibration, packageItems, policyInput, submitPayload }
  from "./review/review-test-fixtures.js";
import {
  OPERATOR, approveGate1, approvePlan, boundWorld, committedRevision, submit,
} from "./planning/plan-reject-test-fixtures.js";
import { readPreviewDecision } from "./preview/preview-daemon-edge.js";
import { previewAggregateId } from "./preview/preview-receipt-contracts.js";
import type { PreviewDaemonPort } from "./preview/preview-daemon-edge.js";
import { recordPreviewReceipt } from "./preview/preview-ledger.js";
import { readReleaseDossierInput } from "./release/release-durable-facts.js";
import { releaseDossierGaps, renderReleaseDossier } from "./release/release-dossier.js";
import { releaseDossierAggregateId, releaseDossierId }
  from "./release/release-dossier-contracts.js";
import { readReleaseDossier, recordReleaseDossier } from "./release/release-dossier-ledger.js";
import { readReleaseReceipt } from "./release/release-receipt-ledger.js";
import { releaseReceiptId } from "./release/release-receipt-contracts.js";
import { recordPublishReceipt } from "./repository/publish-ledger.js";

const BASE = "main";
const CREDENTIAL = "journey-operator-credential";
const DECIDED_AT = "2026-09-08T15:00:00.000Z";
const NODE_KEY = "node-slice";
const PR_URL = "https://github.com/fixture/repo/pull/1";
const REMOTE_URL = "https://github.com/fixture/repo.git";
/** The sha `goals/goal-closure-test-fixtures.seedLandingReceipt` commits. Not exported there, so
 *  it is named once here and then RE-MEASURED off the production release-facts reader below --
 *  a mismatch would surface as "journey landing recorded no sha", never as a silent pass. */
const LANDED_SHA = "0123456789abcdef0123456789abcdef01234567";
const encoder = new TextEncoder();

let minted = 0;
const nextId = (prefix: string): string => `${prefix}-${(minted += 1)}`;

interface Journey {
  readonly deps: CommandAdapterDeps;
  readonly ref: ReturnType<typeof committedRevision>;
  readonly store: SqliteEventStore;
}

/** Records the push through the PRODUCTION receipt writer, so `pushedBranchOf` reads a real
 *  durable receipt. Only the git subprocess is absent. */
function pushPublisher(store: SqliteEventStore, branch: string, sha: string | null) {
  return {
    publishOnce: async (): Promise<readonly {
      readonly detail: string; readonly goalId: string; readonly outcome: string;
    }[]> => {
      if (sha === null) {
        return [{ detail: "no landed sha to push", goalId: GOAL_ID, outcome: "REFUSED" }];
      }
      recordPublishReceipt(store, {
        branch, decidedAt: DECIDED_AT, decisionId: nextId("decision-push"), goalId: GOAL_ID,
        projectId: PROJECT_ID, refusal: null, remoteUrl: REMOTE_URL, sha,
        url: `${REMOTE_URL}/tree/${branch}`,
      });
      return [{ detail: "pushed", goalId: GOAL_ID, outcome: "PUSHED" }];
    },
  };
}

/** The integrated criterion artifact a real `readCriterionArtifact` would measure off the
 *  workspace. SIXTH substituted seam, and the same reason as the fifth: `readCriterionArtifact`
 *  shells out to `git rev-parse` and `git status`, and this lane has no git object database. It
 *  decides nothing -- `currentCriterionReceipts` still applies every one of its own rules (latest
 *  run COMPLETED, receipt PASSED, approved check and criterion digest matching) to the records the
 *  production writers wrote. An artifact naming a DIFFERENT sha would leave the criteria
 *  unverified, so this is passed THROUGH the gate rather than disarming it. */
const criterionArtifactAt = (sha: string) => Object.freeze({
  root: "D:/fixture-workspace", sha, treeSha: "1".repeat(40),
});

/** The evidence facts, read by the PRODUCTION reader over this journey's own store. Only the git
 *  ancestry and criterion-artifact measurements are substituted: this lane holds no git object
 *  database. */
function dossierFacts(store: SqliteEventStore) {
  return (goalId: string, sha: string) => {
    const input = readReleaseDossierInput(store, PROJECT_ID, goalId, () => criterionArtifactAt(sha));
    if (input === null || input.criteria.length === 0) return null;
    // The honest stand-in for `git merge-base --is-ancestor` in a lane with no git object
    // database: a cited landing commit is an ancestor of the release sha exactly when it IS that
    // sha. A predicate that answered ANCESTOR unconditionally would make every sha releasable and
    // silently disarm the evidence gate this journey is meant to pass THROUGH.
    const ancestry = (commit: string): "ANCESTOR" | "NOT_ANCESTOR" =>
      commit === sha ? "ANCESTOR" : "NOT_ANCESTOR";
    // The production wiring records the dossier on the same read; mirrored here so the service's
    // own `readReleaseDossier` gate is exercised against a real stored document.
    if (releaseDossierGaps(input, sha, ancestry).length === 0
      && !readReleaseDossier(store, PROJECT_ID, releaseDossierId(PROJECT_ID, goalId, sha)).ok) {
      recordReleaseDossier(store, {
        decidedAt: DECIDED_AT, goalId, markdown: renderReleaseDossier(input, sha, ancestry),
        projectId: PROJECT_ID, sha,
      });
    }
    return { ancestry, input };
  };
}

/** The verified-workspace binding a real verifier captures. Its `headSha` is what
 *  `release-durable-facts.ts:52` reads as the receipt's measured source commit -- WITHOUT it the
 *  release refuses RECEIPT_SOURCE_UNPROVEN, which is the fixture gap that makes a "released"
 *  journey impossible to reach honestly. Only the git measurement is substituted; every gate that
 *  READS this fact is production. */
const bindingAt = (headSha: string) => Object.freeze({
  branchRef: "refs/heads/main", dirtySha256: "0".repeat(64), headSha, root: "D:/fixture-workspace",
  treeSha: "1".repeat(40), version: "moe-verified-workspace/1" as const,
});

/**
 * A review round, a VERIFIER RECEIPT CARRYING A WORKSPACE BINDING, and the acceptance -- each
 * through its production writer. `goal-closure-test-fixtures.seedReviewAcceptance` is the same
 * shape without the binding, so it is not reused here: its receipt proves no source commit and
 * Gate 3 would refuse RECEIPT_SOURCE_UNPROVEN on evidence that is in fact complete.
 */
function acceptWithBoundWorkspace(
  store: SqliteEventStore, nodeRef: string, headSha: string,
): void {
  const review = (
    kind: string, expectedVersion: number, payload: unknown, commandId: string,
  ): void => {
    const answer = runReviewCommand(store, encoder.encode(JSON.stringify({
      commandId, correlationId: "corr-journey-review", decidedAt: DECIDED_AT, expectedVersion,
      kind, payload, principalId: "author-1", projectId: PROJECT_ID,
      schemaVersion: "moe-review-command/1",
    })));
    if (!answer.ok) throw new Error(`journey review refused: ${answer.code}`);
  };
  review("review.submit", 0, submitPayload(1, [], { subjectRef: nodeRef }), "cmd-journey-review");
  const source = readReviewLedger(store, PROJECT_ID, nodeRef).rounds.at(-1);
  if (source === undefined) throw new Error("journey review left no round to attest");
  const verified = recordVerifierReceipt(store, {
    authority: {
      calibration: calibration(),
      packageItems: packageItems().filter((item) => item.kind !== "DAEMON_RECEIPT"),
      policy: policyInput({ actor: NODE_VERIFIER_PRINCIPAL_ID }),
    },
    decidedAt: DECIDED_AT,
    execution: {
      byteCount: 2, outputSha256: "a".repeat(64), test: "pnpm test",
      workspace: "D:/fixture-workspace", workspaceBinding: bindingAt(headSha),
    },
    projectId: PROJECT_ID,
    source: {
      aggregateVersion: source.aggregateVersion, decisionId: source.decisionId,
      resultSha256: source.resultSha256,
    },
    subjectRef: nodeRef,
  });
  if (!verified.ok) throw new Error(`journey verifier receipt refused: ${verified.code}`);
  review("integration.accept_output", verified.decision.currentVersion,
    { receiptId: verified.receipt.receiptId, subjectRef: nodeRef }, "cmd-journey-accept");
}

const previewPort: PreviewDaemonPort = Object.freeze({
  close: async (): Promise<void> => undefined,
  release: (): void => undefined,
});

function portsOver(
  store: SqliteEventStore, branch: string, sha: string | null,
): CommandAdapterDeps {
  const composed = createDaemonCommandPorts({
    clock: () => DECIDED_AT,
    operatorPrincipalId: OPERATOR,
    preview: previewPort,
    projectId: PROJECT_ID,
    releaseDecide: {
      clock: () => DECIDED_AT,
      dossierFacts: dossierFacts(store),
      prPort: { open: async () => ({ ok: true as const, prUrl: PR_URL }) },
      publisher: pushPublisher(store, branch, sha),
      workspace: "D:/fixture-workspace",
    },
    store,
  });
  const authenticator = createSessionAuthenticator(store, {
    clock: () => Date.parse(DECIDED_AT),
    operatorCapabilities: OPERATOR_CAPABILITIES,
    operatorCredential: CREDENTIAL,
    operatorPrincipalId: OPERATOR,
    projectId: PROJECT_ID,
  });
  return Object.freeze({
    authenticator, decisions: composed.decisions, registry: composed.registry,
  });
}

function request(
  commandId: string, commandKind: string, payload: Readonly<Record<string, unknown>>,
  credential: string, targetAggregateId: string, expectedVersion = 0,
): Parameters<typeof handleCommandRequest>[1] {
  return {
    body: encoder.encode(JSON.stringify({
      commandId, commandKind, correlationId: `corr-${commandId}`, expectedVersion, payload,
      requestDigest: "d".repeat(64), schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: credential, targetAggregateId,
    })),
    credential,
    protocolVersion: WIRE_PROTOCOL_VERSION,
  };
}

/** A SEAT session whose capabilities come from PRODUCTION. This is the drill hook the design row
 *  built: make `agentCapabilitiesFor("design.submit")` answer null and this throws. */
function seatSession(deps: CommandAdapterDeps, kind: string, sessionId: string): string {
  const capabilities = agentCapabilitiesFor(kind);
  if (capabilities === null) throw new Error(`${kind} is unstaffable: no agent capabilities`);
  const secret = `secret-${sessionId}`;
  expect(handleCommandRequest(deps, request(`cmd-open-${sessionId}`, "session.open", {
    capabilities: [...capabilities],
    credentialSha256: createHash("sha256").update(secret, "utf8").digest("hex"),
    expiresAt: "2027-01-01T00:00:00.000Z",
    sessionId,
  }, CREDENTIAL, `session:${sessionId}`), "HTTP_LISTENER")).toMatchObject({ outcome: "ACCEPTED" });
  return secret;
}

/** The OPERATOR's own session: the configured operator principal, holding operator capabilities. */
export function operatorSession(): string { return CREDENTIAL; }

export interface GateOutcome {
  readonly answer: unknown;
  readonly commandId: string;
}

/** Gate 2 through the production registry, as whichever principal the caller names. */
export function decidePreview(
  world: Journey, payload: Readonly<Record<string, unknown>>,
  credential: string = CREDENTIAL,
): GateOutcome {
  const { deps, store } = world;
  const commandId = nextId("cmd-preview-decide");
  return {
    // The preview aggregate already carries the RECEIPT the runner wrote, so a hard-coded 0
    // would refuse on the store's version fence and never reach the gate under test.
    answer: handleCommandRequest(deps, request(
      commandId, "preview.decide", payload, credential, previewAggregateId(GOAL_ID),
      store.getAggregateVersion(previewAggregateId(GOAL_ID)),
    ), "HTTP_LISTENER"),
    commandId,
  };
}

/** Gate 3 through the production ASYNC entry -- the only entry that serves it. */
export async function decideRelease(
  world: Journey, payload: Readonly<Record<string, unknown>>,
  credential: string = CREDENTIAL,
): Promise<GateOutcome> {
  const commandId = nextId("cmd-release-decide");
  // The PRODUCTION aggregate id, never a hand-spelled one: release-decide-command.ts:103 refuses
  // RELEASE_TARGET_INVALID on any other target, so a transcribed string would rot silently.
  const target = releaseDossierAggregateId(GOAL_ID);
  return {
    // The version is READ, never assumed: a hard-coded 0 makes the store's own
    // EXPECTED_VERSION_CONFLICT answer first and hides whichever release gate is under test.
    answer: await handleAsyncCommandRequest(world.deps, request(
      commandId, "release.decide", payload, credential, target,
      world.store.getAggregateVersion(target),
    ), "HTTP_LISTENER"),
    commandId,
  };
}

/** The design step through the production command seam, on a real seat session. `revision` is the
 *  authored design, the DECLARED SKIP, or any hostile shape an arm wants production to decode. */
export function submitDesign(
  deps: CommandAdapterDeps, contractRef: unknown, revision: unknown,
  sessionId = "sess-journey-design",
): unknown {
  const seat = seatSession(deps, "design.submit", sessionId);
  return handleCommandRequest(deps, request(
    nextId("cmd-design-submit"), "design.submit",
    { contractRef, goalRef: GOAL_ID, revision }, seat, designAggregateId(GOAL_ID),
  ), "HTTP_LISTENER");
}

/** The two shapes the design step admits, plus the third a journey can take: never asked. */
export type DesignStep = "OMITTED" | "SKIPPED" | "SUBMITTED";

export interface JourneyWorld extends Journey {
  readonly previewRef: string;
  readonly sha: string;
}

/**
 * ONE GOAL, carried by the PRODUCTION journey to the point where all three human gates are
 * reachable: bound PRD -> product-contract revision -> Gate 1 approved -> (design, by the
 * caller) -> decomposition -> plan approved -> the goal's one node LANDED -> remote bound ->
 * a preview receipt written by the production writer.
 *
 * `design` decides whether the design was AUTHORED, declared SKIPPED, or never asked for at all.
 * Nothing else differs between the variants, so a difference observed later is the design step's
 * and not the fixture's.
 */
export function journeyWorld(design: DesignStep): JourneyWorld {
  const store = boundWorld();
  const ref = committedRevision(store);
  approveGate1(store, ref);
  const branch = `moe/${GOAL_ID}`;
  const designDeps = portsOver(store, branch, null);
  if (design !== "OMITTED") {
    // A DECLARED SKIP is a RECORD, not an absence: it travels the same production command, the
    // same decoder and the same aggregate an authored design does.
    expect(submitDesign(designDeps, ref,
      design === "SKIPPED" ? designSkipFixture() : designRevisionFixture()))
      .toMatchObject({ outcome: "ACCEPTED" });
  }
  const sealed = submit(store, ref);
  if (!sealed.ok) throw new Error(`journey submit refused: ${sealed.code}`);
  approvePlan(store, sealed.runId);
  const graph = activeCompiledGraphs(store, PROJECT_ID).find((plan) => plan.goalRef === GOAL_ID);
  if (graph === undefined) throw new Error("journey plan approval left no active graph");
  const nodeRef = compiledExecutionRef(PROJECT_ID, graph, NODE_KEY);
  // LANDING_SHA is the sha `seedLandingReceipt` commits; the verifier receipt must name the SAME
  // commit as its measured source or Gate 3 refuses evidence that is genuinely complete.
  acceptWithBoundWorkspace(store, nodeRef, LANDED_SHA);
  seedLandingReceipt(store, nodeRef, "COMMITTED");
  const published = send(store, envelope("repository.publish", 0, {
    approval: FIXTURE_PUBLICATION_APPROVAL, goalId: GOAL_ID, remoteUrl: REMOTE_URL,
  }, nextId("cmd-publish-journey")));
  if (!published.ok) throw new Error(`journey publish refused: ${published.code}`);
  // MEASURED, never transcribed: the sha the production landing writer actually recorded, read
  // back through the production release-facts reader. A fixture that hard-coded it would keep
  // agreeing with itself after the writer changed.
  const facts = readReleaseDossierInput(store, PROJECT_ID, GOAL_ID);
  const sha = facts?.nodes.find((node) => node.landingSha !== null)?.landingSha ?? null;
  if (sha === null) throw new Error("journey landing recorded no sha to release");
  // AND THE ONE TRANSCRIBED VALUE IN THIS MODULE CHECKS ITSELF. `LANDED_SHA` mirrors a constant
  // that `goal-closure-test-fixtures.ts` keeps private, and the verifier receipt above was bound
  // to it. If the landing writer ever commits a different sha the two stop agreeing, and Gate 3
  // would refuse RECEIPT_SOURCE_UNPROVEN on evidence that is genuinely complete -- a confusing
  // failure a long way from its cause. Name it here instead.
  if (sha !== LANDED_SHA) {
    throw new Error(`journey landing sha ${sha} no longer matches LANDED_SHA ${LANDED_SHA}: `
      + "rebind the verifier receipt's workspaceBinding.headSha to the landing writer's commit");
  }
  // THE APPROVED CRITERION CHECKS, PASSED AT THE SHA UNDER RELEASE. Gate 3 now demands the same
  // criterion evidence `goal.close` demands (GOAL_CLOSE_CRITERIA_UNVERIFIED), so a journey without
  // it would refuse RELEASE_EVIDENCE_INCOMPLETE on a goal whose product IS built -- and every
  // release arm would be testing the absence of criterion evidence instead of the sequence.
  // CRITERION_APPROVE is still a human ADMIN command, so this is the OPERATOR's work, in the same
  // human's sequence as the three gates.
  const criteria = seedPassedCriterionReceipts(store, {
    artifact: criterionArtifactAt(sha), decidedAt: DECIDED_AT, goalRef: GOAL_ID,
    projectId: PROJECT_ID,
  });
  if (criteria.length === 0) throw new Error("the journey goal carries no criteria to verify");
  const receipt = recordPreviewReceipt(store, {
    code: null, decidedAt: DECIDED_AT, goalId: GOAL_ID, pid: 4242, projectId: PROJECT_ID,
    screenshots: [], sha, url: "http://127.0.0.1:5199/",
  });
  if (!receipt.ok) throw new Error(`journey preview receipt refused: ${receipt.code}`);
  return {
    deps: portsOver(store, branch, sha), previewRef: receipt.receipt.receiptId, ref, sha, store,
  };
}

export {
  BASE, CREDENTIAL, DECIDED_AT, GOAL_ID, PROJECT_ID, PR_URL, REMOTE_URL, closeStores,
  dossierFacts, nextId,
  readDesignRevision, readPreviewDecision, readReleaseReceipt, releaseReceiptId, seatSession,
};
export type { CommandAdapterDeps, Journey };
