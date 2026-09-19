import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";
import { createStoreDependencies } from "../daemon-store-dependencies.js";
import { decisionsOf } from "../decision-ledger-memo.js";
import { installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
import { recordLandingReceipt } from "../repository/landing-ledger.js";
import type { RepositoryExecutionPort } from "../repository/repository-execution-contracts.js";
import { REPOSITORY_LANDING_INTENT_KIND, recordRepositoryLandingIntent } from "../repository/repository-landing-intent.js";
import { RECOVERY_FACT_PRINCIPAL } from "../repository/repository-recovery-facts.js";
import { readReviewLedger } from "../review/review-read-model.js";
import {
  calibration, driveEscalatedRounds, envelope, escalationPayload, packageItems, policyInput, PROJECT_ID,
  seedVerifierReceipt, send, SUBJECT_REF,
} from "../review/review-test-fixtures.js";
import { NODE_VERIFIER_PRINCIPAL_ID } from "../review/verifier-receipt-ledger.js";
import {
  createDeliveryWithdrawal, integrationConflictOutput, ownsDirtIn, RECOVERABLE_LANDING_REFUSALS, refusedLandingWorkspace,
  WITHDRAWAL_OUTPUT_MAX_CHARACTERS,
} from "./node-delivery-withdrawal.js";
import type { DeliveryWithdrawalConfig } from "./node-delivery-withdrawal.js";
import type { IntegrationGit } from "./node-integration.js";
import { landingVerificationClass } from "./node-lander-verification.js";
import { NODE_TREES_DIRECTORY, nodeTreeName } from "./node-worktrees.js";

/**
 * A RECORDED MERGE CONFLICT RETURNS ITS NODE TO A SEAT (UnAI 2026-09-19). Every arm runs against
 * a real store through the production ledgers: a real accepted verifier receipt (the fixture path
 * node-landed-branches.test.ts uses), a real landing receipt, and the integrator's own conflict
 * record. Only Git and the reservation read are stood in, so each guard can be held alone; the
 * real-Git journey is repository-delivery-withdrawal.test.ts.
 */
const NODE = SUBJECT_REF, CREDENTIAL = "test-operator", BRANCH = "moe/node-a-1234abcd", SHA = "1".repeat(40);
const NOW = "2026-09-19T10:00:00.000Z";
const RECIPE = "git -c user.name=Moe -c user.email=moe@moe.local -c commit.gpgsign=false merge trunk";
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

const authority = () => ({ calibration: calibration(), packageItems: packageItems().filter((item) => item.kind !== "DAEMON_RECEIPT"),
  policy: policyInput({ actor: NODE_VERIFIER_PRINCIPAL_ID }) });
/** The project's HEAD lacks every node commit, and its branch is `trunk`. */
const unmerged: IntegrationGit = (_cwd, args) => args[0] === "merge-base" ? { code: 1, stdout: "" } : { code: 0, stdout: "trunk\n" };
const free: DeliveryWithdrawalConfig["repository"] = { inspect: () => ({ ok: true, reservation: null }) };

function world(overrides: Partial<Omit<DeliveryWithdrawalConfig, "verifier">> & Partial<DeliveryWithdrawalConfig["verifier"]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "moe-delivery-withdrawal-"));
  const storePath = join(dir, "store.sqlite");
  const provider = createStoreDependencies({ credential: CREDENTIAL, principalId: "operator-local", projectId: PROJECT_ID, storePath });
  const store = SqliteEventStore.openForProject(storePath, PROJECT_ID); installTestRecoveryBinding(store);
  cleanups.push(() => { store.close(); provider.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  const logs: string[] = [];
  const { nodeMission, verificationAuthority, ...scanner } = overrides;
  const withdrawal = createDeliveryWithdrawal({ git: unmerged, log: (line) => logs.push(line), nodes: () => [{ nodeRef: NODE }, { nodeRef: "node-b" }],
    projectWorkspace: "/project", repository: free, ...scanner,
    verifier: { deps: provider.provide(), operatorCredential: CREDENTIAL, projectId: PROJECT_ID, store,
      nodeMission: nodeMission ?? (() => ({ instructions: "build", test: "pnpm test", title: "Node", workspace: "/project/.moe-next/trees/a" })),
      verificationAuthority: verificationAuthority ?? authority } });
  return { ledger: (nodeRef = NODE) => readReviewLedger(store, PROJECT_ID, nodeRef), logs, store, withdrawal,
    writes: () => decisionsOf(store, 200).length };
}
type World = ReturnType<typeof world>;

/** A clean round, its verifier receipt, and the acceptance naming it. */
function accept(w: World, nodeRef: string): string {
  const receipt = seedVerifierReceipt(w.store, nodeRef, PROJECT_ID);
  expect(send(w.store, { ...envelope("integration.accept_output", receipt.currentVersion,
    { receiptId: receipt.receiptId, subjectRef: nodeRef }, `cmd-accept-${nodeRef}-${String(receipt.currentVersion)}`), projectId: PROJECT_ID }).ok).toBe(true);
  return receipt.receiptId;
}

/** Accepted, and landed on the node's own branch. */
function acceptedAndLanded(w: World, nodeRef = NODE, branch = BRANCH, sha = SHA): string {
  const receiptId = accept(w, nodeRef);
  expect(recordLandingReceipt(w.store, { commit: { branch, files: ["product.ts"], message: "Land product", parentSha: "b".repeat(40), sha },
    decidedAt: NOW, projectId: PROJECT_ID, refusal: null, subjectRef: nodeRef, verifierReceiptId: receiptId,
    workspace: "/project/.moe-next/trees/a" }).ok).toBe(true);
  return receiptId;
}

/** Accepted, and its landing REFUSED with `code` in `workspace`: the lander's own terminal receipt. */
function acceptedAndRefused(w: World, code: string, workspace = "/project", detail = "refused for the fixture"): string {
  const receiptId = accept(w, NODE);
  expect(recordLandingReceipt(w.store, { commit: null, decidedAt: NOW, projectId: PROJECT_ID, refusal: { code, detail },
    subjectRef: NODE, verifierReceiptId: receiptId, workspace }).ok).toBe(true);
  return receiptId;
}

/** A landing intent for this acceptance, through the production writer (repository-recovery-test-fixtures.ts keeps the same handle). */
function journalIntent(w: World, verifierReceiptId: string): void {
  const binding = { version: "moe-verified-workspace/1", root: "D:/repository", branchRef: "refs/heads/trunk",
    headSha: "1".repeat(40), treeSha: "2".repeat(40), dirtySha256: "3".repeat(64) } as const;
  expect(recordRepositoryLandingIntent(w.store, { binding, message: "land\n", paths: ["owned.txt"], verifierReceiptId, handle: {
    owner: { projectId: PROJECT_ID, nodeRef: NODE, ownershipToken: "b".repeat(64), storeId: "D:/store.sqlite" },
    reservation: { projectId: PROJECT_ID, nodeRef: NODE, storeId: "D:/store.sqlite", controllerId: "controller", controllerPid: 23,
      revision: 7, phase: "LANDING", baselineId: "baseline-1", sessionId: "session", pid: 31,
      identity: { root: binding.root, gitDirectory: `${binding.root}/.git` } } } }).ok).toBe(true);
}

/** An intent decision whose body does not decode, which turns the walk's `landingIntents` to null (review-read-model.test.ts). */
function plantUnreadableIntent(w: World): void {
  const bytes = new TextEncoder().encode(JSON.stringify({ version: "not-an-intent" }));
  const targetAggregateId = "repository-landing:planted";
  expect(w.store.commitExpectedVersionDecision({ commandKind: REPOSITORY_LANDING_INTENT_KIND, committedResultBytes: bytes,
    correlationId: "planted-intent", decidedAt: NOW, requestBytes: bytes, targetAggregateId,
    events: [{ eventId: "planted-intent-recorded", eventType: "RepositoryRecoveryEvidenceRecorded", payload: bytes }],
    expectedVersion: w.store.getAggregateVersion(targetAggregateId),
    key: { commandId: "planted-intent", principalId: RECOVERY_FACT_PRINCIPAL, projectId: PROJECT_ID } }).decision.effectDisposition).toBe("EFFECTS_COMMITTED");
}

/** A project directory whose node tree is on disk the way `ownNodeTree` looks for one. No Git is run in it. */
function projectWithTree(): { readonly project: string; readonly tree: string } {
  const project = realpathSync.native(mkdtempSync(join(tmpdir(), "moe-delivered-nothing-")));
  cleanups.push(() => rmSync(project, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const tree = join(project, NODE_TREES_DIRECTORY, nodeTreeName(NODE)!);
  mkdirSync(tree, { recursive: true });
  writeFileSync(join(tree, ".git"), "gitdir: elsewhere\n");
  return { project, tree };
}

const TREE_BRANCH = "refs/heads/moe/node-run-1-tree";
/** The node's own tree as Git would describe it: what is dirty in it, and whether the project's HEAD contains its HEAD. */
const treeGit = (status: string, merged: boolean, asked: string[][] = []): IntegrationGit => (cwd, args) => {
  asked.push([cwd, ...args]);
  return args[0] === "status" ? { code: 0, stdout: status }
    : args[0] === "symbolic-ref" ? { code: 0, stdout: `${TREE_BRANCH}\n` }
      : args[0] === "rev-parse" ? { code: 0, stdout: `${SHA}\n` }
        : args[0] === "merge-base" ? { code: merged ? 0 : 1, stdout: "" }
          : args[0] === "diff" ? { code: 0, stdout: "src/seat.ts\0" } : { code: 1, stdout: "" };
};
const noGit: IntegrationGit = () => { throw new Error("no rule here asks Git anything"); };
const findingOf = (w: World): string => w.ledger().rounds.at(-1)?.lineage.records.at(-1)?.finding.detail ?? "";

/** The integrator's own record, in its own shape (node-integration.test.ts keeps the same fixture). */
function conflicted(w: World, paths: readonly string[], nodeRef = NODE, branch = BRANCH, sha = SHA): void {
  const aggregateId = `repository-integration/${createHash("sha256").update(PROJECT_ID, "utf8").digest("hex")}`;
  const commandId = `rin-fixture-${randomUUID()}`;
  w.store.commit({ aggregateId, commandBytes: new TextEncoder().encode(JSON.stringify({ eventType: "NodeBranchConflicted" })), commandId,
    committedAt: NOW, expectedVersion: w.store.getAggregateVersion(aggregateId),
    events: [{ eventId: `${commandId}-e1`, eventType: "NodeBranchConflicted", payload: new TextEncoder().encode(JSON.stringify({
      at: NOW, branch, nodeRef, paths, projectId: PROJECT_ID, sha, version: "moe-repository-integration/1" })) }] });
}

const untouched = (w: World, receiptId: string, writes: number): void => {
  expect(w.ledger().accepted?.verifierReceiptId).toBe(receiptId);
  expect(w.writes()).toBe(writes);
};

describe("withdrawing an acceptance whose branch could not be merged", () => {
  it("withdraws a recorded conflict exactly once, as one failed round that carries the finding", () => {
    const w = world(); const receiptId = acceptedAndLanded(w);
    conflicted(w, ["src/shared.ts", "docs/readme.md"]);
    const before = w.ledger(); const writes = w.writes();

    w.withdrawal.scanOnce();

    const after = w.ledger();
    expect(after).toMatchObject({ accepted: undefined, unreadable: false, version: before.version + 1 });
    expect(after.rounds).toHaveLength(before.rounds.length + 1);
    // MAJOR and unattributed on purpose: a MINOR or attributed finding routes ACCEPT, and the fold
    // reads a withdrawal that routed ACCEPT as unreadable.
    expect(after.rounds.at(-1)?.routing.route).not.toBe("ACCEPT");
    const detail = after.rounds.at(-1)?.lineage.records.at(-1)?.finding.detail ?? "";
    expect(detail).toContain(`Your accepted work is safe on ${BRANCH} at ${SHA}`);
    expect(detail).toContain("src/shared.ts\ndocs/readme.md");
    expect(detail).toContain(RECIPE);
    const decision = decisionsOf(w.store, 200).at(-1)!;
    expect(decision).toMatchObject({ commandKind: "review.submit", key: { commandId: `delivery-withdrawn-${before.rounds.at(-1)!.decisionId}` } });
    expect((JSON.parse(new TextDecoder().decode(decision.resultBytes)) as Record<string, unknown>)["withdrawsAcceptance"]).toBe(receiptId);
    expect(w.logs).toEqual([expect.stringMatching(/^\[withdrawal\] node-run-1: INTEGRATION_CONFLICT \(moe\/node-a-1234abcd 1111111111 conflicts with the project branch in 2 path\(s\)/u)]);

    w.withdrawal.scanOnce();

    expect(w.writes()).toBe(writes + 1);
    expect(w.logs).toHaveLength(1);
  });

  it("does not fire for a conflict recorded with no paths: it names nothing a node could answer", () => {
    const w = world(); const receiptId = acceptedAndLanded(w);
    conflicted(w, []);
    const writes = w.writes();

    w.withdrawal.scanOnce();

    untouched(w, receiptId, writes);
    expect(w.logs).toEqual([]);
  });

  it("does not fire for a commit the project's HEAD already contains", () => {
    const asked: string[][] = [];
    const w = world({ git: (cwd, args) => { asked.push([cwd, ...args]); return { code: 0, stdout: "" }; } });
    const receiptId = acceptedAndLanded(w);
    conflicted(w, ["src/shared.ts"]);
    const writes = w.writes();

    w.withdrawal.scanOnce();

    untouched(w, receiptId, writes);
    // Asked in the PROJECT's checkout, the way the integrator asks.
    expect(asked).toEqual([["/project", "merge-base", "--is-ancestor", SHA, "HEAD"]]);
    expect(w.logs).toEqual([]);
  });

  it("does not fire for a node that landed on the project's own branch, or without a project checkout", () => {
    const onProject = world(); const first = acceptedAndLanded(onProject, NODE, "master");
    conflicted(onProject, ["src/shared.ts"], NODE, "master");
    const none = world({ projectWorkspace: null }); const second = acceptedAndLanded(none);
    conflicted(none, ["src/shared.ts"]);
    const writes = [onProject.writes(), none.writes()];

    onProject.withdrawal.scanOnce(); none.withdrawal.scanOnce();

    untouched(onProject, first, writes[0]!); untouched(none, second, writes[1]!);
  });

  it("does not fire over an unreadable ledger", () => {
    const w = world(); acceptedAndLanded(w);
    conflicted(w, ["src/shared.ts"]);
    const bytes = new TextEncoder().encode(JSON.stringify({ lineage: "unreadable" }));
    w.store.commitExpectedVersionDecision({ commandKind: "review.submit", targetAggregateId: NODE,
      expectedVersion: w.store.getAggregateVersion(NODE), correlationId: "corrupt-review-test",
      key: { projectId: PROJECT_ID, principalId: "reviewer-test", commandId: randomUUID() }, decidedAt: NOW,
      requestBytes: bytes, committedResultBytes: bytes, events: [{ eventId: randomUUID(), eventType: "CorruptFixture", payload: bytes }] });
    expect(w.ledger().unreadable).toBe(true);
    const writes = w.writes();

    w.withdrawal.scanOnce();

    expect(w.writes()).toBe(writes);
    expect(w.logs).toEqual([]);
  });

  // The withdrawal is one round and the seat's answer is another: both have to fit under the ceiling.
  it.each([[21, true], [22, false]])("after %i failed rounds and the accepted one, withdraws: %s", (failed, withdraws) => {
    const w = world();
    driveEscalatedRounds(w.store, failed);
    expect(send(w.store, envelope("escalation.decide", w.ledger().version, escalationPayload(), "cmd-allow-accepted-round")).ok).toBe(true);
    const receiptId = acceptedAndLanded(w);
    conflicted(w, ["src/shared.ts"]);
    expect(w.ledger().rounds).toHaveLength(failed + 1);
    const writes = w.writes();

    w.withdrawal.scanOnce(); w.withdrawal.scanOnce();

    if (withdraws) {
      expect(w.ledger()).toMatchObject({ accepted: undefined, unreadable: false });
      expect(w.ledger().rounds).toHaveLength(23);
    } else {
      untouched(w, receiptId, writes);
      // Said once, not on every pass of the wrapper's timer.
      expect(w.logs).toEqual([expect.stringMatching(/^\[withdrawal\] node-run-1: WITHDRAWAL_ROUND_CEILING \(23 review rounds/u)]);
    }
  }, 120_000);

  it("waits while the node still holds its landed workspace, and withdraws once it is released", () => {
    let holder: string | null = NODE;
    const inspected: string[] = [];
    const w = world({ repository: { inspect: (workspace) => { inspected.push(workspace);
      return { ok: true, reservation: holder === null ? null : { nodeRef: holder, phase: "BLOCKED", projectId: PROJECT_ID } } as
        ReturnType<RepositoryExecutionPort["inspect"]>; } } });
    const receiptId = acceptedAndLanded(w);
    conflicted(w, ["src/shared.ts"]);
    const writes = w.writes();

    w.withdrawal.scanOnce(); w.withdrawal.scanOnce();

    untouched(w, receiptId, writes);
    expect(inspected[0]).toBe("/project/.moe-next/trees/a");
    expect(w.logs).toEqual([expect.stringMatching(/^\[withdrawal\] node-run-1: WITHDRAWAL_WORKSPACE_HELD \(the node still holds its landed workspace \(BLOCKED\)/u)]);

    // Another node holding that path is not this node's hold.
    holder = "node-b";
    w.withdrawal.scanOnce();
    expect(w.ledger().accepted).toBeUndefined();
  });

  it("logs and retries while verifier authority is unavailable, then withdraws", () => {
    let available = false;
    const w = world({ verificationAuthority: () => available ? authority() : null });
    const receiptId = acceptedAndLanded(w);
    conflicted(w, ["src/shared.ts"]);
    const writes = w.writes();

    w.withdrawal.scanOnce(); w.withdrawal.scanOnce();

    untouched(w, receiptId, writes);
    expect(w.logs).toEqual([expect.stringMatching(/^\[withdrawal\] node-run-1: VERIFICATION_AUTHORITY_UNAVAILABLE /u)]);

    available = true;
    w.withdrawal.scanOnce();
    expect(w.ledger().accepted).toBeUndefined();
    expect(w.logs.at(-1)).toContain("node-run-1: INTEGRATION_CONFLICT");
  });

  it("never lets one node's throw cost another its withdrawal", () => {
    const w = world({ nodeMission: (nodeRef) => {
      if (nodeRef === NODE) throw new Error("brief unreadable");
      return { instructions: "build", test: "pnpm test", title: "Node", workspace: "/project/.moe-next/trees/b" };
    } });
    const receiptId = acceptedAndLanded(w);
    acceptedAndLanded(w, "node-b", "moe/node-b-5678", "2".repeat(40));
    conflicted(w, ["src/shared.ts"]);
    conflicted(w, ["src/other.ts"], "node-b", "moe/node-b-5678", "2".repeat(40));

    w.withdrawal.scanOnce();

    expect(w.ledger().accepted?.verifierReceiptId).toBe(receiptId);
    expect(w.ledger("node-b").accepted).toBeUndefined();
    expect(w.logs).toEqual([expect.stringContaining("node-run-1: WITHDRAWAL_FAILED (brief unreadable"),
      expect.stringContaining("node-b: INTEGRATION_CONFLICT")]);
  });
});

// UnAI 2026-09-19: a tracked .moe-next/start.ps1 edited under a seat refused the landing for good,
// and the accepted files sat uncommitted in the project's checkout with no seat ever sent back.
describe("withdrawing an acceptance whose landing was refused before any intent", () => {
  it.each(RECOVERABLE_LANDING_REFUSALS)("withdraws %s exactly once and tells the seat where its work still is", (code) => {
    const w = world({ git: noGit }); const receiptId = acceptedAndRefused(w, code);
    const before = w.ledger(); const writes = w.writes();

    w.withdrawal.scanOnce(); w.withdrawal.scanOnce();

    expect(w.ledger()).toMatchObject({ accepted: undefined, unreadable: false, version: before.version + 1 });
    expect(w.ledger().rounds.at(-1)?.routing.route).not.toBe("ACCEPT");
    expect(w.writes()).toBe(writes + 1);
    expect(findingOf(w)).toContain(`LANDING_REFUSED: nothing was tested. Your accepted work was not committed: the landing was refused ${code}.\nrefused for the fixture\n`);
    expect(findingOf(w)).toContain("your changes are still uncommitted in /project, and you are staffed there again.");
    expect(findingOf(w).endsWith("3. Re-run the test, then submit the review again.")).toBe(true);
    expect((JSON.parse(new TextDecoder().decode(decisionsOf(w.store, 200).at(-1)!.resultBytes)) as Record<string, unknown>)["withdrawsAcceptance"]).toBe(receiptId);
    expect(w.logs).toEqual([`[withdrawal] node-run-1: LANDING_REFUSED (${code} in /project, before any landing intent; the acceptance was withdrawn and the node returns to a seat)`]);
  });

  it("keeps the steps whole however long the refusal's own words are", () => {
    const w = world({ git: noGit });
    acceptedAndRefused(w, RECOVERABLE_LANDING_REFUSALS[0]!, `/project/${"w".repeat(900)}`, "d".repeat(5_000));

    w.withdrawal.scanOnce();

    // The finding is the text behind the verifier's own one-line preamble; the brief keeps its first 4000 characters.
    const text = findingOf(w).slice(findingOf(w).indexOf("LANDING_REFUSED: nothing was tested."));
    expect(text.length).toBeLessThanOrEqual(WITHDRAWAL_OUTPUT_MAX_CHARACTERS);
    expect(findingOf(w).length).toBeLessThanOrEqual(4_000);
    expect(text).toContain(`${"d".repeat(599)}…\n`);
    expect(text.endsWith("3. Re-run the test, then submit the review again.")).toBe(true);
  });

  it("does not fire once a landing intent was journaled: that refusal may have had a Git effect", () => {
    const w = world({ git: noGit }); const receiptId = acceptedAndRefused(w, RECOVERABLE_LANDING_REFUSALS[0]!);
    journalIntent(w, receiptId);
    const writes = w.writes();

    w.withdrawal.scanOnce();

    untouched(w, receiptId, writes);
    expect(w.logs).toEqual([]);
  });

  it("does not fire while the landing intents cannot be read, and says so once", () => {
    const w = world({ git: noGit }); const receiptId = acceptedAndRefused(w, RECOVERABLE_LANDING_REFUSALS[0]!);
    plantUnreadableIntent(w);
    const writes = w.writes();

    w.withdrawal.scanOnce(); w.withdrawal.scanOnce();

    untouched(w, receiptId, writes);
    expect(w.logs).toEqual([expect.stringMatching(/^\[withdrawal\] node-run-1: LANDING_INTENTS_UNREADABLE \(.+; LANDING_REFUSED is not withdrawn yet/u)]);
  });

  it("does not fire for a refusal outside the closed table", () => {
    const w = world({ git: noGit }); const receiptId = acceptedAndRefused(w, "LANDING_BASELINE_MISSING");
    const writes = w.writes();

    w.withdrawal.scanOnce();

    untouched(w, receiptId, writes);
    expect(w.logs).toEqual([]);
  });

  // HAND-MIRRORED. A code joins the table only when a new round answers it; a code the lander can
  // never record would be a rule that never fires, and a TRANSIENT one is retried, never recorded.
  it("names only refusals the lander records durably", () => {
    expect(RECOVERABLE_LANDING_REFUSALS).toEqual(["TRACKED_RUNTIME_METADATA_DIRTY", "LANDING_VERIFIED_WORKSPACE_CHANGED"]);
    const lander = readFileSync(new URL("./node-lander.ts", import.meta.url), "utf8");
    for (const code of RECOVERABLE_LANDING_REFUSALS) {
      const observeRefusal = new RegExp(`observed\\.code === ${code}\\) \\{\\r?\\n\\s+return refuse\\(`, "u");
      expect(landingVerificationClass(code) === "STRUCTURAL" || observeRefusal.test(lander), code).toBe(true);
    }
  });
});

// UnAI 2026-09-19: a restart without MOE_NODE_TREES landed a node from the shared checkout, which
// held nothing of it, while 34 changed files sat in the node's own tree. NOTHING_TO_COMMIT is
// credited as "owed no bytes", so the node read as delivered.
describe("withdrawing an acceptance credited with nothing while the node's own tree holds its work", () => {
  it("fires for a dirty own tree the landing never looked in, and names both workspaces", () => {
    const { project, tree } = projectWithTree();
    const w = world({ git: treeGit("?? src/new.ts\0 M src/old.ts\0 M .moe-next/start.ps1\0", true), projectWorkspace: project });
    acceptedAndRefused(w, "NOTHING_TO_COMMIT", project);

    w.withdrawal.scanOnce(); w.withdrawal.scanOnce();

    expect(w.ledger()).toMatchObject({ accepted: undefined, unreadable: false });
    expect(findingOf(w)).toContain(`DELIVERED_NOTHING: nothing was tested. Your review was accepted, but the landing looked in ${project} and found nothing to commit there.`);
    // Moe's own runtime file is not the node's work and is not counted.
    expect(findingOf(w)).toContain(`Your work is in your own working tree ${tree}, which holds 2 uncommitted path(s). Nothing is lost.`);
    expect(findingOf(w).endsWith("2. Re-run the test, then submit the review again.")).toBe(true);
    expect(w.logs).toEqual([`[withdrawal] node-run-1: DELIVERED_NOTHING (the landing found nothing in ${project} while ${tree} holds 2 uncommitted path(s); the acceptance was withdrawn and the node returns to a seat)`]);
  });

  it("fires for a clean tree whose HEAD holds seat commits the project lacks, wherever the landing looked", () => {
    const { project, tree } = projectWithTree();
    // Dirt where the landing itself looked was there at its baseline, so that tree is not asked for it.
    const asked: string[][] = [];
    const w = world({ git: treeGit("?? never-read.ts\0", false, asked), projectWorkspace: project });
    acceptedAndRefused(w, "NOTHING_TO_COMMIT", tree);

    w.withdrawal.scanOnce();

    expect(w.ledger().accepted).toBeUndefined();
    expect(findingOf(w)).toContain(`which holds commits on ${TREE_BRANCH} at ${SHA} that the project's branch does not contain. Nothing is lost.`);
    expect(asked.some(([, verb]) => verb === "status")).toBe(false);
    // The lander's own adoption test, asked in the PROJECT's checkout.
    expect(asked).toContainEqual([project, "merge-base", "--is-ancestor", SHA, "HEAD"]);
  });

  it("keeps the credit of a node with no tree of its own, and asks Git nothing", () => {
    const project = realpathSync.native(mkdtempSync(join(tmpdir(), "moe-delivered-nothing-")));
    cleanups.push(() => rmSync(project, { recursive: true, force: true }));
    const w = world({ git: noGit, projectWorkspace: project });
    const receiptId = acceptedAndRefused(w, "NOTHING_TO_COMMIT", project);
    const writes = w.writes();

    w.withdrawal.scanOnce();

    untouched(w, receiptId, writes);
    expect(w.logs).toEqual([]);
  });

  it("keeps the credit of a clean tree the project already contains, and asks once per runtime", () => {
    const { project } = projectWithTree();
    const asked: string[][] = [];
    const w = world({ git: treeGit(" M .moe-next/start.ps1\0", true, asked), projectWorkspace: project });
    const receiptId = acceptedAndRefused(w, "NOTHING_TO_COMMIT", project);
    const writes = w.writes();

    w.withdrawal.scanOnce();
    const first = asked.length;
    w.withdrawal.scanOnce();

    untouched(w, receiptId, writes);
    expect(first).toBeGreaterThan(0);
    expect(asked).toHaveLength(first);
    expect(w.logs).toEqual([]);
  });

  it("says so and tries again when the node's own tree cannot be read", () => {
    const { project } = projectWithTree();
    const w = world({ git: () => ({ code: 128, stdout: "" }), projectWorkspace: project });
    const receiptId = acceptedAndRefused(w, "NOTHING_TO_COMMIT", project);
    const writes = w.writes();

    w.withdrawal.scanOnce(); w.withdrawal.scanOnce();

    untouched(w, receiptId, writes);
    expect(w.logs).toEqual([expect.stringMatching(/^\[withdrawal\] node-run-1: WITHDRAWAL_FAILED \(the node's own tree could not be read \(git status\); DELIVERED_NOTHING is not withdrawn yet/u)]);
  });
});

describe("where a withdrawn node is staffed again, and whose dirt it finds there", () => {
  it.each(RECOVERABLE_LANDING_REFUSALS)("pins a node refused %s to the workspace its landing looked in", (code) => {
    const { project } = projectWithTree();
    const w = world({ git: noGit, projectWorkspace: project }); const receiptId = acceptedAndRefused(w, code, project);

    // Pinned from the refusal on: the mission must not move while the withdrawal is still to come.
    expect(refusedLandingWorkspace(w.store, PROJECT_ID, NODE)).toBe(project);
    // Accepted, the dirt is not admitted yet: nothing has returned the node to a seat.
    expect(ownsDirtIn(w.store, PROJECT_ID, NODE, project)).toBe(false);

    w.withdrawal.scanOnce();

    expect(refusedLandingWorkspace(w.store, PROJECT_ID, NODE)).toBe(project);
    expect(ownsDirtIn(w.store, PROJECT_ID, NODE, project)).toBe(true);
    expect(ownsDirtIn(w.store, PROJECT_ID, "node-b", project)).toBe(false);
    expect(ownsDirtIn(w.store, PROJECT_ID, NODE, join(project, "elsewhere"))).toBe(false);
    // A journaled intent ends both: that landing may have had a Git effect.
    journalIntent(w, receiptId);
    expect(refusedLandingWorkspace(w.store, PROJECT_ID, NODE)).toBeNull();
    expect(ownsDirtIn(w.store, PROJECT_ID, NODE, project)).toBe(false);
  });

  it("pins nothing for NOTHING_TO_COMMIT, and admits that node's dirt in its own tree only", () => {
    const { project, tree } = projectWithTree();
    const w = world({ git: treeGit("?? src/new.ts\0", true), projectWorkspace: project });
    acceptedAndRefused(w, "NOTHING_TO_COMMIT", project);
    expect(ownsDirtIn(w.store, PROJECT_ID, NODE, tree)).toBe(false);

    w.withdrawal.scanOnce();

    expect(w.ledger().accepted).toBeUndefined();
    expect(refusedLandingWorkspace(w.store, PROJECT_ID, NODE)).toBeNull();
    expect(ownsDirtIn(w.store, PROJECT_ID, NODE, tree)).toBe(true);
    // The shared checkout's dirt is somebody else's: this landing looked there and found nothing.
    expect(ownsDirtIn(w.store, PROJECT_ID, NODE, project)).toBe(false);
    // Another node's tree is not this node's.
    expect(ownsDirtIn(w.store, PROJECT_ID, "node-b", tree)).toBe(false);
  });

  it("pins nothing to a workspace that is no longer there, or for a node that landed", () => {
    const gone = world(); acceptedAndRefused(gone, RECOVERABLE_LANDING_REFUSALS[0]!, join(tmpdir(), `moe-gone-${randomUUID()}`));
    const landed = world(); acceptedAndLanded(landed);

    expect(refusedLandingWorkspace(gone.store, PROJECT_ID, NODE)).toBeNull();
    expect(refusedLandingWorkspace(landed.store, PROJECT_ID, NODE)).toBeNull();
    expect(refusedLandingWorkspace(landed.store, PROJECT_ID, "node-b")).toBeNull();
    expect(ownsDirtIn(landed.store, PROJECT_ID, NODE, "/project/.moe-next/trees/a")).toBe(false);
  });
});

describe("the conflict text a seat is handed", () => {
  const facts = { branch: BRANCH, projectBranch: "trunk", sha: SHA };

  it("lists twenty paths whole and keeps the recipe", () => {
    const paths = Array.from({ length: 20 }, (_unused, index) => `src/file-${String(index)}.ts`);
    const text = integrationConflictOutput({ ...facts, paths });
    for (const path of paths) expect(text).toContain(`\n${path}\n`);
    expect(text).not.toContain("more not shown");
    expect(text).toContain(`1. Run: ${RECIPE}\n`);
    expect(text).toContain("3. COMMIT the merge. Leave no merge in progress and nothing uncommitted.");
  });

  // The payload keeps the TAIL and the brief keeps the HEAD: only a bounded text keeps both ends.
  it("stays under the bound for the integrator's worst record: 64 paths, each cut to 120 characters", () => {
    const paths = Array.from({ length: 64 }, (_unused, index) => `${String(index).padStart(2, "0")}-${"p".repeat(300)}`);
    const text = integrationConflictOutput({ ...facts, paths });
    expect(text.length).toBeLessThanOrEqual(WITHDRAWAL_OUTPUT_MAX_CHARACTERS);
    expect(text).toContain(`\n19-${"p".repeat(117)}\n`);
    expect(text).not.toContain("20-p");
    expect(text).toContain("Git could not join 64 path(s):");
    expect(text).toContain("[44 more not shown; Git names every one when you merge]");
    expect(text.startsWith("INTEGRATION_CONFLICT: nothing was tested.")).toBe(true);
    expect(text.endsWith("4. Re-run the test, then submit the review again.")).toBe(true);
  });

  it("gives up paths before it gives up the recipe when the names around them are long", () => {
    const paths = Array.from({ length: 20 }, (_unused, index) => `${String(index).padStart(2, "0")}-${"p".repeat(300)}`);
    const text = integrationConflictOutput({ branch: `moe/${"b".repeat(250)}`, paths, projectBranch: "t".repeat(250), sha: SHA });
    expect(text.length).toBeLessThanOrEqual(WITHDRAWAL_OUTPUT_MAX_CHARACTERS);
    expect(text).toContain(`merge ${"t".repeat(250)}\n`);
    expect(text).toContain("more not shown");
  });
});
