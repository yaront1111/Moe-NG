import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { JsonObject } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { GOAL_ID, PROJECT_ID, closeStores } from "../bootstrap/bootstrap-test-fixtures.js";
import { createDaemonCommandPorts } from "../daemon-command-registry.js";
import { handleAsyncCommandRequest } from "../http/http-adapter.js";
import { WIRE_PROTOCOL_VERSION } from "../http/http-contract.js";
import type { CommandAdapterDeps } from "../http/http-contract.js";
import { compiledExecutionRef } from "../orchestrator/compiled-execution-ref.js";
import { codeMission } from "../orchestrator/agent-mission-text.js";
import { readGraphBody } from "../planning/graph-body-record.js";
import { approveGate1, approvePlan, boundWorld, committedRevision, submit }
  from "../planning/plan-reject-test-fixtures.js";
import { createVerifierAuthorityProvider } from "./verifier-authority-provider.js";
import { readReviewLedger } from "./review-read-model.js";
import { verifyStoredPackageItems } from "./review-package-restore.js";
import { createVerifiedWorkspacePort } from "../repository/git-verified-workspace-port.js";
import type { VerifiedWorkspacePort } from "../repository/verified-workspace-contracts.js";
import { createNodeVerifier } from "../orchestrator/node-verifier.js";
import { calibration, packageItems, policyInput } from "./review-test-fixtures.js";
import { NODE_VERIFIER_PRINCIPAL_ID, verifierReceiptId } from "./verifier-receipt-contracts.js";
import { readVerifierReceipt, recordVerifierReceipt } from "./verifier-receipt-ledger.js";
import { readSubmittedReviewWorkspace } from "./review-submission-read.js";
import { createSessionAuthenticator } from "../identity/session-authenticator.js";
import { runSessionCommand } from "../identity/session-services.js";
import { SESSION_SCHEMA_VERSION } from "../identity/session-contracts.js";
import { readDurableLedger, stateOf } from "../bootstrap/bootstrap-ledger.js";

const NOW = "2026-08-30T12:05:00.000Z";
const PRINCIPAL = "review-coder";
const folders: string[] = [];
afterEach(() => { closeStores(); for (const folder of folders.splice(0)) rmSync(folder, { force: true, recursive: true }); });
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function world(approved = true, capture?: VerifiedWorkspacePort["capture"]) {
  const store = boundWorld();
  const revision = committedRevision(store);
  approveGate1(store, revision);
  const sealed = submit(store, revision);
  if (!sealed.ok) throw new Error(sealed.code);
  const graph = readGraphBody(store, PROJECT_ID, sealed.graphContentHash);
  if (!graph.ok) throw new Error(graph.code);
  const nodeRef = compiledExecutionRef(PROJECT_ID, {
    content: graph.content, goalRef: GOAL_ID, planningRunRef: sealed.runId,
  }, "node-slice");
  if (approved) approvePlan(store, sealed.runId);
  const session = (kind: "session.open" | "session.close", payload: JsonObject, expectedVersion: number) =>
    runSessionCommand(store, new TextEncoder().encode(JSON.stringify({ kind, payload, expectedVersion,
      commandId: `fixture-${kind}`, correlationId: "review-session", decidedAt: NOW,
      principalId: "operator-local", projectId: PROJECT_ID, schemaVersion: SESSION_SCHEMA_VERSION })));
  const opened = session("session.open", { sessionId: PRINCIPAL, capabilities: ["review.write", "work.write"],
    credentialSha256: sha("test-only"), expiresAt: "2026-08-30T13:00:00.000Z" }, 0);
  if (!opened.ok) throw new Error(opened.code);
  const authenticator = createSessionAuthenticator(store, { clock: () => Date.parse(NOW),
    operatorCapabilities: ["review.write", "work.write"], operatorCredential: "test-operator",
    operatorPrincipalId: "operator-local", projectId: PROJECT_ID });
  const workspace = mkdtempSync(join(tmpdir(), "moe-review-submit-")); folders.push(workspace);
  const git = (...args: string[]) => execFileSync("git", args, {
    cwd: workspace, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(workspace, "app.ts"), "export const answer = 41;\n");
  git("add", "--", "app.ts");
  git("-c", "user.name=Review Test", "-c", "user.email=review@test.invalid", "commit", "-qm", "base");
  writeFileSync(join(workspace, "app.ts"), "export const answer = 42;\n");
  const ports = createDaemonCommandPorts({
    clock: () => NOW, operatorPrincipalId: "operator-local", projectId: PROJECT_ID, store,
    ...{ reviewSubmission: { workspace, authenticate: authenticator.authenticate,
      ...(capture === undefined ? {} : { capture }) } },
  });
  const deps: CommandAdapterDeps = { ...ports, authenticator };
  const dispatch = (kind: string, payload: JsonObject, expectedVersion = 0, commandId = `cmd-${kind}`, target = nodeRef) =>
    handleAsyncCommandRequest(deps, {
      body: new TextEncoder().encode(JSON.stringify({ commandId, commandKind: kind,
        correlationId: "review-handoff", expectedVersion, payload,
        requestDigest: sha(JSON.stringify(payload)), schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
        sessionCredential: "test-only", targetAggregateId: target })),
      credential: "test-only", protocolVersion: WIRE_PROTOCOL_VERSION,
    }, "MCP_HTTP");
  const claim = () => dispatch("work.claim", { expiresAt: "2026-08-30T13:00:00.000Z", workItemId: `node.deliver@${nodeRef}` },
    0, "cmd-claim", `work/node.deliver@${nodeRef}`);
  return { claim, deps, dispatch, git, nodeRef, session, store, workspace };
}

describe("runtime review submission without development payload hints", () => {
  it("prepares real evidence for an approved compiled node through the production registry", async () => {
    const w = world();
    expect(await w.claim()).toMatchObject({ ok: true });
    const payload = { subjectRef: w.nodeRef, findings: [], packageItems: [], round: 1 };
    const beforeHead = w.git("rev-parse", "HEAD");
    const result = await w.dispatch("review.submit", payload);
    expect(result).toMatchObject({ ok: true, decision: { resultCode: "EFFECTS_COMMITTED" } });
    const ledger = readReviewLedger(w.store, PROJECT_ID, w.nodeRef);
    const round = ledger.rounds[0];
    expect(round).toBeDefined();
    if (round === undefined) throw new Error("missing recorded round");
    const restored = verifyStoredPackageItems(round);
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw new Error(restored.code);
    expect(restored.items.filter((item) => item.kind === "CRITERION").map((item) => item.locator))
      .toEqual(["crit-api", "crit-ui"]);
    expect(readSubmittedReviewWorkspace(w.store, PROJECT_ID, w.nodeRef, round)).toMatchObject({ status: "PRESENT" });
    const decision = w.store.getCommandDecision({ projectId: PROJECT_ID, principalId: PRINCIPAL,
      commandId: "cmd-review.submit" });
    if (decision === null) throw new Error("missing decision");
    const stored = JSON.parse(new TextDecoder().decode(decision.resultBytes)) as {
      submissionEvidence: { artifacts: { digest: string; locator: string; text: string }[] };
    };
    for (const artifact of stored.submissionEvidence.artifacts) expect(sha(artifact.text)).toBe(artifact.digest);
    const receipt = restored.items.find((item) => item.kind === "DAEMON_RECEIPT");
    const receiptArtifact = stored.submissionEvidence.artifacts.find((item) => item.digest === receipt?.digest);
    expect(JSON.parse(receiptArtifact?.text ?? "null")).toMatchObject({
      version: "moe-review-submission-observation/1", testsRun: false, proof: "UNKNOWN", truthClass: "OBSERVED",
      binding: { treeSha: expect.stringMatching(/^[a-f0-9]{40}$/u) },
    });
    expect(ledger.accepted).toBeUndefined();
    expect(createVerifierAuthorityProvider({ projectId: PROJECT_ID, store: w.store })(w.nodeRef,
      { workspace: w.workspace, test: "pnpm test", title: "node", instructions: "implement" })).toBeNull();
    expect(w.git("rev-parse", "HEAD")).toBe(beforeHead);
    expect(readFileSync(join(w.workspace, "app.ts"), "utf8")).toBe("export const answer = 42;\n");
    const horizon = w.store.readEventHorizon();
    expect(await w.dispatch("review.submit", payload)).toMatchObject({ ok: true, decision: { disposition: "REPLAYED" } });
    expect(w.store.readEventHorizon()).toBe(horizon);
  });

  it("refuses a sealed but unapproved node before recording any review", async () => {
    const w = world(false); await w.claim();
    expect(await w.dispatch("review.submit", { subjectRef: w.nodeRef, findings: [], packageItems: [], round: 1 }))
      .toMatchObject({ ok: false, refusal: { code: "REVIEW_SUBMISSION_NODE_UNAVAILABLE" } });
    expect(readReviewLedger(w.store, PROJECT_ID, w.nodeRef).rounds).toEqual([]);
  });

  it("requires the submitting principal's live durable claim", async () => {
    const w = world();
    expect(await w.dispatch("review.submit", { subjectRef: w.nodeRef, findings: [], packageItems: [], round: 1 }))
      .toMatchObject({ ok: false, refusal: { code: "REVIEW_SUBMISSION_CLAIM_REQUIRED" } });
    expect(readReviewLedger(w.store, PROJECT_ID, w.nodeRef).rounds).toEqual([]);
  });

  it("rechecks claim ownership after asynchronous workspace capture", async () => {
    let release = async () => {};
    const w = world(true, async (workspace) => {
      const captured = await createVerifiedWorkspacePort().capture(workspace);
      await release();
      return captured;
    });
    await w.claim();
    release = async () => {
      expect(await w.dispatch("work.release", { workItemId: `node.deliver@${w.nodeRef}` },
        1, "cmd-release", `work/node.deliver@${w.nodeRef}`)).toMatchObject({ ok: true });
    };
    expect(await w.dispatch("review.submit", { subjectRef: w.nodeRef, findings: [], packageItems: [], round: 1 }))
      .toMatchObject({ ok: false, refusal: { code: "REVIEW_SUBMISSION_CLAIM_REQUIRED" } });
    expect(readReviewLedger(w.store, PROJECT_ID, w.nodeRef).rounds).toEqual([]);
  });

  it("refuses when another review advances the subject during capture", async () => {
    let advance = async () => {};
    const w = world(true, async (workspace) => {
      const captured = await createVerifiedWorkspacePort().capture(workspace); await advance(); return captured;
    });
    await w.claim();
    advance = async () => {
      expect(await w.dispatch("review.submit", { subjectRef: w.nodeRef, findings: [],
        packageItems: packageItems() as unknown as JsonObject[], round: 1 }, 0, "competing-round"))
        .toMatchObject({ ok: true });
    };
    expect(await w.dispatch("review.submit", { subjectRef: w.nodeRef, findings: [], packageItems: [], round: 1 }))
      .toMatchObject({ ok: false, refusal: { code: "REVIEW_SUBMISSION_VERSION_CHANGED" } });
    expect(readReviewLedger(w.store, PROJECT_ID, w.nodeRef).rounds).toHaveLength(1);
    expect(w.store.getCommandDecision({ projectId: PROJECT_ID, principalId: PRINCIPAL, commandId: "cmd-review.submit" })).toBeNull();
  });

  it("rechecks that the compiled goal remains executable after capture", async () => {
    let retire = () => {};
    const w = world(true, async (workspace) => {
      const captured = await createVerifiedWorkspacePort().capture(workspace); retire(); return captured;
    });
    await w.claim();
    retire = () => {
      const current = stateOf(readDurableLedger(w.store, PROJECT_ID), GOAL_ID) as JsonObject;
      const bytes = new TextEncoder().encode(JSON.stringify({ ...current, lifecycle: "CANCELLED" }));
      // A separate durable source writer retires the goal while the host is observing Git.
      w.store.commitExpectedVersionDecision({ commandKind: "source-retirement.fixture", committedResultBytes: bytes,
        correlationId: "retire-source", decidedAt: NOW, expectedVersion: w.store.getAggregateVersion(GOAL_ID),
        events: [{ eventId: "retire-source", eventType: "SourceRetiredFixture", payload: bytes }],
        key: { commandId: "retire-source", principalId: "operator-local", projectId: PROJECT_ID },
        requestBytes: bytes, targetAggregateId: GOAL_ID });
    };
    expect(await w.dispatch("review.submit", { subjectRef: w.nodeRef, findings: [], packageItems: [], round: 1 }))
      .toMatchObject({ ok: false, refusal: { code: "REVIEW_SUBMISSION_NODE_UNAVAILABLE" } });
    expect(readReviewLedger(w.store, PROJECT_ID, w.nodeRef).rounds).toEqual([]);
  });

  it("preserves structured incomplete findings as rejection without acceptance credit", async () => {
    const w = world(); await w.claim();
    expect(await w.dispatch("review.submit", { subjectRef: w.nodeRef, packageItems: [], round: 1,
      findings: [{ detail: "Criterion still missing", ruleId: "incomplete", severity: "MAJOR",
        subject: { kind: "NODE", locator: w.nodeRef } }] })).toMatchObject({ ok: true });
    const ledger = readReviewLedger(w.store, PROJECT_ID, w.nodeRef);
    expect(ledger.rounds[0]?.routing.route).toBe("REJECT_IMPLEMENTATION");
    expect(ledger.lineage.unsuccessfulRounds).toBe(1);
    expect(ledger.accepted).toBeUndefined();
  });

  it.each([false, true])("refuses changed submitted bytes before verification/acceptance (pending receipt: %s)", async (pending) => {
    const w = world(); await w.claim();
    expect(await w.dispatch("review.submit", { subjectRef: w.nodeRef, findings: [], packageItems: [], round: 1 }))
      .toMatchObject({ ok: true });
    const round = readReviewLedger(w.store, PROJECT_ID, w.nodeRef).rounds[0];
    if (round === undefined) throw new Error("missing round");
    const restored = verifyStoredPackageItems(round);
    if (!restored.ok) throw new Error(restored.code);
    const authority = { calibration: calibration(),
      packageItems: restored.items.filter((item) => item.kind !== "DAEMON_RECEIPT"),
      policy: policyInput({ actor: NODE_VERIFIER_PRINCIPAL_ID }) };
    writeFileSync(join(w.workspace, "app.ts"), "export const answer = 999;\n");
    if (pending) {
      const captured = await createVerifiedWorkspacePort().capture(w.workspace);
      if (!captured.ok) throw new Error(captured.code);
      // Model an old daemon that verified changed bytes against the earlier submission.
      expect(recordVerifierReceipt(w.store, { authority, decidedAt: NOW, projectId: PROJECT_ID,
        subjectRef: w.nodeRef, source: { aggregateVersion: round.aggregateVersion,
          decisionId: round.decisionId, resultSha256: round.resultSha256 },
        execution: { byteCount: 0, outputSha256: sha(""), test: "node test.mjs", workspace: w.workspace,
          workspaceBinding: captured.binding } })).toMatchObject({ ok: true });
    }
    let runs = 0;
    const verifier = createNodeVerifier({ deps: w.deps, mintId: () => "drift-probe",
      nodeMission: () => ({ workspace: w.workspace, test: "node test.mjs", title: "node", instructions: "implement" }),
      nodes: () => [{ nodeRef: w.nodeRef }], operatorCredential: "test-operator", projectId: PROJECT_ID,
      runTest: async () => { runs += 1; return { byteCount: 0, exitCode: 0, output: "", sha256: sha("") }; },
      store: w.store, verifiedWorkspace: createVerifiedWorkspacePort(),
      verificationAuthority: () => authority,
    });
    const reports = await verifier.verifyOnce();
    expect(runs).toBe(0);
    expect(reports).toMatchObject([{ outcome: "VERIFIER_WORKSPACE_CHANGED" }]);
    expect(readVerifierReceipt(w.store, PROJECT_ID, verifierReceiptId(PROJECT_ID, w.nodeRef, round.decisionId)).ok).toBe(pending);
    expect(readReviewLedger(w.store, PROJECT_ID, w.nodeRef).accepted).toBeUndefined();
  });

  it("earns acceptance by testing the exact host-prepared candidate", async () => {
    const w = world(); await w.claim();
    expect(await w.dispatch("review.submit", { subjectRef: w.nodeRef, findings: [], packageItems: [], round: 1 }))
      .toMatchObject({ ok: true });
    const round = readReviewLedger(w.store, PROJECT_ID, w.nodeRef).rounds[0];
    if (round === undefined) throw new Error("missing round");
    const restored = verifyStoredPackageItems(round);
    if (!restored.ok) throw new Error(restored.code);
    let runs = 0;
    const verifier = createNodeVerifier({ deps: w.deps, mintId: () => "positive-probe",
      nodeMission: () => ({ workspace: w.workspace, test: "node app assertion", title: "node", instructions: "implement" }),
      nodes: () => [{ nodeRef: w.nodeRef }], operatorCredential: "test-operator", projectId: PROJECT_ID,
      runTest: async () => {
        runs += 1;
        const output = execFileSync(process.execPath, ["-e",
          "import('./app.ts').then(m => {if(m.answer!==42)process.exit(1); console.log(m.answer);})"],
        { cwd: w.workspace, encoding: "utf8", windowsHide: true });
        return { byteCount: Buffer.byteLength(output), exitCode: 0, output, sha256: sha(output) };
      },
      store: w.store, verifiedWorkspace: createVerifiedWorkspacePort(),
      verificationAuthority: () => ({ calibration: calibration(),
        packageItems: restored.items.filter((item) => item.kind !== "DAEMON_RECEIPT"),
        policy: policyInput({ actor: NODE_VERIFIER_PRINCIPAL_ID }) }),
    });
    expect(await verifier.verifyOnce()).toMatchObject([{ outcome: "ACCEPTED" }]);
    expect(runs).toBe(1);
    expect(readReviewLedger(w.store, PROJECT_ID, w.nodeRef).accepted).toBeDefined();
    expect(readVerifierReceipt(w.store, PROJECT_ID, verifierReceiptId(PROJECT_ID, w.nodeRef, round.decisionId)))
      .toMatchObject({ ok: true, receipt: { proof: "PASSED" } });
  });

  it("retains explicit legacy packages and distinguishes their absent workspace binding", async () => {
    const w = world();
    expect(await w.dispatch("review.submit", { subjectRef: "node-legacy", findings: [],
      packageItems: packageItems() as unknown as JsonObject[], round: 1 }, 0, "cmd-legacy", "node-legacy"))
      .toMatchObject({ ok: true });
    const round = readReviewLedger(w.store, PROJECT_ID, "node-legacy").rounds[0];
    if (round === undefined) throw new Error("missing legacy round");
    expect(readSubmittedReviewWorkspace(w.store, PROJECT_ID, "node-legacy", round)).toEqual({ status: "ABSENT" });
  });

  it.each(["missing", "altered"])("refuses %s persisted submission evidence without legacy fallback", async (mode) => {
    const w = world(); await w.claim();
    expect(await w.dispatch("review.submit", { subjectRef: w.nodeRef, findings: [], packageItems: [], round: 1 }))
      .toMatchObject({ ok: true });
    const round = readReviewLedger(w.store, PROJECT_ID, w.nodeRef).rounds[0];
    if (round === undefined) throw new Error("missing round");
    const read = w.store.readCommandDecisionsAfter.bind(w.store);
    const faultyStore = { readCommandDecisionsAfter: (...args: Parameters<typeof read>) => {
      const page = read(...args);
      return { ...page, items: page.items.map((decision) => {
        if (decision.decisionId !== round.decisionId) return decision;
        const result = JSON.parse(new TextDecoder().decode(decision.resultBytes));
        if (mode === "missing") result.submissionEvidence = null;
        else result.submissionEvidence.artifacts[0].text += "substituted bytes";
        return { ...decision, resultBytes: new TextEncoder().encode(JSON.stringify(result)) };
      }) };
    } } as unknown as SqliteEventStore;
    expect(readSubmittedReviewWorkspace(faultyStore, PROJECT_ID, w.nodeRef, round)).toEqual({ status: "INVALID" });
  });

  it("refuses malformed input before capturing the workspace", async () => {
    let captures = 0;
    const w = world(true, async (workspace) => { captures += 1; return createVerifiedWorkspacePort().capture(workspace); });
    await w.claim();
    expect(await w.dispatch("review.submit", { subjectRef: w.nodeRef, packageItems: [], round: 1 }))
      .toMatchObject({ ok: false, refusal: {
        code: "REVIEW_PAYLOAD_INVALID", detail: "findings must be a JSON array, got absent", layer: "DAEMON_INGRESS",
      } });
    // The live shape (UnAI 2026-09-18): round as a quoted string. The refusal on the wire says so.
    expect(await w.dispatch("review.submit", { subjectRef: w.nodeRef, findings: [], packageItems: [], round: "1" },
      0, "cmd-review-round-as-string"))
      .toMatchObject({ ok: false, refusal: {
        code: "REVIEW_PAYLOAD_INVALID",
        detail: 'round must be a JSON integer >= 1, got string "1"; send the number unquoted',
      } });
    expect(captures).toBe(0);
  });

  it("rechecks the actual session authenticator after capture even while its claim remains open", async () => {
    let revoke = () => {};
    const w = world(true, async (workspace) => {
      const captured = await createVerifiedWorkspacePort().capture(workspace); revoke(); return captured;
    });
    await w.claim();
    revoke = () => { expect(w.session("session.close", { sessionId: PRINCIPAL }, 1)).toMatchObject({ ok: true }); };
    expect(await w.dispatch("review.submit", { subjectRef: w.nodeRef, findings: [], packageItems: [], round: 1 }))
      .toMatchObject({ ok: false, refusal: { code: "REVIEW_SUBMISSION_AUTHENTICATION_CHANGED" } });
    expect(readReviewLedger(w.store, PROJECT_ID, w.nodeRef).rounds).toEqual([]);
  });

  it("briefs the complete host-prepared payload without copying a development fixture", () => {
    const mission = codeMission("node.deliver@node:v1:real", "node:v1:real", NOW,
      { instructions: "implement", test: "pnpm test", title: "real", workspace: "C:/project" },
      { accept: null, submit: { packageItems: [{ kind: "DAEMON_RECEIPT", digest: "fixture-fake" }] } });
    expect(mission).toContain('"subjectRef":"node:v1:real"');
    expect(mission).toContain('"packageItems":[]');
    expect(mission).toContain("proof remains UNKNOWN");
    expect(mission).not.toContain("fixture-fake");
  });
});
