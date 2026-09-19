import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";
import { createStoreDependencies } from "../daemon-store-dependencies.js";
import { decisionsOf } from "../decision-ledger-memo.js";
import { installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
import { recordLandingReceipt } from "../repository/landing-ledger.js";
import type { RepositoryExecutionPort } from "../repository/repository-execution-contracts.js";
import { readReviewLedger } from "../review/review-read-model.js";
import {
  calibration, driveEscalatedRounds, envelope, escalationPayload, packageItems, policyInput, PROJECT_ID,
  seedVerifierReceipt, send, SUBJECT_REF,
} from "../review/review-test-fixtures.js";
import { NODE_VERIFIER_PRINCIPAL_ID } from "../review/verifier-receipt-ledger.js";
import { createDeliveryWithdrawal, integrationConflictOutput, WITHDRAWAL_OUTPUT_MAX_CHARACTERS } from "./node-delivery-withdrawal.js";
import type { DeliveryWithdrawalConfig } from "./node-delivery-withdrawal.js";
import type { IntegrationGit } from "./node-integration.js";

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

/** A clean round, its verifier receipt, the acceptance naming it, and its landing on the node's own branch. */
function acceptedAndLanded(w: World, nodeRef = NODE, branch = BRANCH, sha = SHA): string {
  const receipt = seedVerifierReceipt(w.store, nodeRef, PROJECT_ID);
  expect(send(w.store, { ...envelope("integration.accept_output", receipt.currentVersion,
    { receiptId: receipt.receiptId, subjectRef: nodeRef }, `cmd-accept-${nodeRef}-${String(receipt.currentVersion)}`), projectId: PROJECT_ID }).ok).toBe(true);
  expect(recordLandingReceipt(w.store, { commit: { branch, files: ["product.ts"], message: "Land product", parentSha: "b".repeat(40), sha },
    decidedAt: NOW, projectId: PROJECT_ID, refusal: null, subjectRef: nodeRef, verifierReceiptId: receipt.receiptId,
    workspace: "/project/.moe-next/trees/a" }).ok).toBe(true);
  return receipt.receiptId;
}

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
