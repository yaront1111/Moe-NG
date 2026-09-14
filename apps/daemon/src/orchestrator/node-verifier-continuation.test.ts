import { spawnSync, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteEventStore } from "@moe/store";
import { expect, it } from "vitest";
import { createStoreDependencies } from "../daemon-store-dependencies.js";
import { installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
import { createVerifiedWorkspacePort } from "../repository/git-verified-workspace-port.js";
import { calibration, envelope, escalationPayload, finding, packageItems, policyInput, send, submitPayload } from "../review/review-test-fixtures.js";
import { readReviewLedger } from "../review/review-read-model.js";
import { NODE_VERIFIER_PRINCIPAL_ID } from "../review/verifier-receipt-ledger.js";
import { createNodeVerifier } from "./node-verifier.js";

it.each([3, 23])("records actual verifier failure after %i failed attempts without granting another coding attempt", async (priorFailures) => {
  const dir = mkdtempSync(join(tmpdir(), "moe-continued-verifier-"));
  const workspace = join(dir, "repo"); mkdirSync(workspace);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: workspace, windowsHide: true, encoding: "utf8" });
  git("init", "--quiet", "-b", "main");
  writeFileSync(join(workspace, "test.cjs"), "process.stderr.write('actual continued attempt failed'); process.exit(1);\n");
  git("add", "--", "test.cjs");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "test");
  const projectId = "continued-verifier", nodeRef = "node-a", credential = "test-operator";
  const storePath = join(dir, "store.sqlite");
  const provider = createStoreDependencies({ credential, principalId: "operator-local", projectId, storePath });
  const store = SqliteEventStore.openForProject(storePath, projectId); installTestRecoveryBinding(store);
  try {
    const review = (kind: string, payload: Record<string, unknown>) => send(store, {
      ...envelope(kind, readReviewLedger(store, projectId, nodeRef).version, payload, randomUUID()), projectId,
    });
    const freshRound = () => readReviewLedger(store, projectId, nodeRef).lineage.highestRound + 1;
    for (let round = 1; round <= priorFailures; round += 1) {
      if (round > 3) expect(review("escalation.decide", escalationPayload({ subjectRef: nodeRef })).ok).toBe(true);
      expect(review("review.submit", submitPayload(round,
        [finding({ ruleId: `missing-${round}` })], { subjectRef: nodeRef })).ok).toBe(true);
    }
    expect(review("escalation.decide", escalationPayload({ subjectRef: nodeRef })).ok).toBe(true);
    expect(review("review.submit", submitPayload(freshRound(), [], { subjectRef: nodeRef })).ok).toBe(true);
    const clean = readReviewLedger(store, projectId, nodeRef).rounds.at(-1)!;
    let runs = 0;
    const verifier = createNodeVerifier({ deps: provider.provide(), mintId: randomUUID,
      nodeMission: () => ({ instructions: "repair", test: "node test.cjs", title: "test", workspace }),
      nodes: () => [{ nodeRef }], operatorCredential: credential, projectId, store,
      verificationAuthority: () => ({ calibration: calibration(), packageItems: packageItems().filter((item) => item.kind !== "DAEMON_RECEIPT"),
        policy: policyInput({ actor: NODE_VERIFIER_PRINCIPAL_ID }) }), verifiedWorkspace: createVerifiedWorkspacePort(),
      runTest: async () => {
        runs += 1;
        const child = spawnSync(process.execPath, ["test.cjs"], { cwd: workspace, windowsHide: true, encoding: "utf8" });
        const output = child.stdout + child.stderr;
        return { byteCount: Buffer.byteLength(output), exitCode: child.status, output,
          sha256: createHash("sha256").update(output).digest("hex") };
      },
    });
    expect(await verifier.verifyOnce()).toEqual([{ detail: "exit 1", nodeRef, outcome: "FAILED_ROUND_RECORDED" }]);
    const failed = readReviewLedger(store, projectId, nodeRef);
    expect(failed).toMatchObject({ unreadable: false, accepted: undefined, lineage: { unsuccessfulRounds: priorFailures + 1 } });
    expect(failed.rounds).toHaveLength(priorFailures + 2);
    expect(failed.rounds.at(-1)?.lineage.records.at(-1)?.finding.detail).toContain("actual continued attempt failed");
    expect(failed.rounds.at(-1)?.routing.route).toBe("ESCALATE");
    expect(failed.rounds.at(-1)?.aggregateVersion).toBe(clean.aggregateVersion + 1);
    expect(await verifier.verifyOnce()).toEqual([]); expect(runs).toBe(1);
    expect(review("review.submit", submitPayload(freshRound(), [], { subjectRef: nodeRef }))).toMatchObject({ ok: false,
      code: priorFailures === 23 ? "REVIEW_ROUND_CEILING_REACHED" : "REVIEW_ESCALATION_REQUIRED" });
    if (priorFailures === 23) {
      expect(review("escalation.decide", escalationPayload({ subjectRef: nodeRef })))
        .toMatchObject({ ok: false, code: "REVIEW_ROUND_CEILING_REACHED" });
      expect(readReviewLedger(store, projectId, nodeRef).version).toBe(failed.version);
      expect(review("escalation.decide", escalationPayload({ subjectRef: nodeRef, decision: "REPLAN" })).ok).toBe(true);
      return;
    }
    expect(review("escalation.decide", escalationPayload({ subjectRef: nodeRef })).ok).toBe(true);
    expect(review("review.submit", submitPayload(freshRound(), [finding({ ruleId: "still-missing" })], { subjectRef: nodeRef })).ok).toBe(true);
    expect(review("review.submit", submitPayload(freshRound(), [], { subjectRef: nodeRef }))).toMatchObject({ ok: false, code: "REVIEW_ESCALATION_REQUIRED" });
  } finally { store.close(); provider.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
}, 60_000);
