import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { createAcceptanceContract } from "@moe/core";
import { decodeBoundedJsonBytes, MAX_JSON_BODY_BYTES, MAX_JSON_STRING_UTF8_BYTES } from "@moe/contracts";
import type { JsonObject } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";
import { prepareReviewSubmissionPackage } from "./review-submission-package.js";
import { readSubmittedReviewWorkspace } from "./review-submission-read.js";
import { readReviewLedger } from "./review-read-model.js";
import { runReviewCommand } from "./review-services.js";
import { closeStores, envelope, openStore, PROJECT_ID, SUBJECT_REF } from "./review-test-fixtures.js";

afterEach(closeStores);
const encoder = new TextEncoder();
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function prepared(count: number, statement = "s".repeat(30_000)) {
  const admitted = createAcceptanceContract({
    applicability: { graphContentHash: "a".repeat(64), graphRevisionRef: "graph-revision",
      nodeIds: ["node-large"], nodeKind: "LEAF" }, authorRef: "author", contractId: "contract",
    obligations: Array.from({ length: count }, (_, i) => ({ criterionId: `crit-${String(i).padStart(2, "0")}`, statement,
      evidenceRequirements: [{ requirementId: `req-${i}`, kind: "ARTIFACT", evidenceRef: `evidence-${i}` }],
      verificationRecipeRefs: [`recipe-${i}`] })),
  });
  expect(admitted.ok).toBe(true);
  if (!admitted.ok) throw new Error(admitted.code);
  const binding = { version: "moe-verified-workspace/1" as const, root: tmpdir(), headSha: "a".repeat(40),
    branchRef: "refs/heads/main", treeSha: "b".repeat(40), dirtySha256: "c".repeat(64) };
  const submission = prepareReviewSubmissionPackage({ projectId: PROJECT_ID, subjectRef: SUBJECT_REF, binding,
    source: { authorityRef: "authority", criteria: admitted.contract.obligations, goalRef: "goal",
      graphContentHash: "a".repeat(64), graphRevisionRef: "graph-revision", nodeKey: "node-large",
      planHash: "b".repeat(64), runId: "run" } });
  return { binding, submission };
}

const request = () => encoder.encode(JSON.stringify(envelope("review.submit", 0,
  { findings: [], packageItems: [], round: 1, subjectRef: SUBJECT_REF })));

describe("host review artifact persistence limits", () => {
  it.each(["s".repeat(30_000), "😀".repeat(7_500)])(
    "keeps a legal large criterion package readable with exact artifact bytes (%#)", (statement) => {
      const store = openStore();
      const { binding, submission } = prepared(9, statement);
      const outcome = runReviewCommand(store, request(), undefined, submission);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error(outcome.code);
      expect(outcome.decision.resultBytes.byteLength).toBeLessThan(MAX_JSON_BODY_BYTES);
      expect(decodeBoundedJsonBytes(outcome.decision.resultBytes)).toMatchObject({ ok: true });
      const ledger = readReviewLedger(store, PROJECT_ID, SUBJECT_REF);
      expect(ledger.unreadable).toBe(false);
      const round = ledger.rounds[0];
      if (round === undefined) throw new Error("missing round");
      expect(readSubmittedReviewWorkspace(store, PROJECT_ID, SUBJECT_REF, round)).toEqual({ status: "PRESENT", binding });
      const artifacts = submission.evidence["artifacts"] as JsonObject[];
      expect(artifacts.some((artifact) => Array.isArray(artifact["textParts"]))).toBe(true);
      for (const artifact of artifacts) {
        const text = typeof artifact["text"] === "string" ? artifact["text"]
          : (artifact["textParts"] as string[]).join("");
        expect(sha(text)).toBe(artifact["digest"]);
        for (const part of (artifact["textParts"] as string[] | undefined) ?? []) {
          expect(encoder.encode(part).byteLength).toBeLessThanOrEqual(65_536);
          expect(new TextDecoder("utf-8", { fatal: true }).decode(encoder.encode(part))).toBe(part);
        }
      }
      expect(ledger.accepted).toBeUndefined();
    },
  );

  it("refuses a result exceeding the total reader limit without a durable effect", () => {
    const store = openStore();
    const horizon = store.readEventHorizon();
    const outcome = runReviewCommand(store, request(), undefined, prepared(16).submission);
    expect(outcome).toMatchObject({ ok: false, code: "REVIEW_RESULT_TOO_LARGE" });
    expect(store.readEventHorizon()).toBe(horizon);
    expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF)).toMatchObject({ unreadable: false, rounds: [] });
  });

  it("checks every reader bound before committing, even when total bytes fit", () => {
    const store = openStore();
    const horizon = store.readEventHorizon();
    const small = prepared(1).submission;
    const malformed = { ...small, evidence: { ...small.evidence, unexpected: "s".repeat(MAX_JSON_STRING_UTF8_BYTES + 1) } };
    const outcome = runReviewCommand(store, request(), undefined, malformed);
    expect(outcome).toMatchObject({ ok: false, code: "REVIEW_RESULT_TOO_LARGE" });
    expect(store.readEventHorizon()).toBe(horizon);
    expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF)).toMatchObject({ unreadable: false, rounds: [] });
  });

  it.each(["altered", "missing", "ambiguous", "oversized"])(
    "refuses %s persisted text parts without a legacy fallback", (mode) => {
      const store = openStore();
      expect(runReviewCommand(store, request(), undefined, prepared(9).submission).ok).toBe(true);
      const round = readReviewLedger(store, PROJECT_ID, SUBJECT_REF).rounds[0];
      if (round === undefined) throw new Error("missing round");
      expect(readSubmittedReviewWorkspace(store, PROJECT_ID, SUBJECT_REF, round).status).toBe("PRESENT");
      const read = store.readCommandDecisionsAfter.bind(store);
      // The real store checks decision digests. This facade probes the additional artifact
      // resolver cutoff independently, without weakening that store boundary or editing bytes.
      const faultyStore = { readCommandDecisionsAfter: (...args: Parameters<typeof read>) => {
        const page = read(...args);
        return { ...page, items: page.items.map((decision) => {
          if (decision.decisionId !== round.decisionId) return decision;
          const result = JSON.parse(new TextDecoder().decode(decision.resultBytes));
          const artifact = result.submissionEvidence.artifacts.find((value: JsonObject) => Array.isArray(value["textParts"]));
          if (artifact === undefined) throw new Error("missing large artifact");
          if (mode === "altered") artifact.textParts[0] += "substituted bytes";
          if (mode === "missing") artifact.textParts.pop();
          if (mode === "ambiguous") artifact.text = "";
          if (mode === "oversized") artifact.textParts = [artifact.textParts.slice(0, 5).join(""), ...artifact.textParts.slice(5)];
          return { ...decision, resultBytes: encoder.encode(JSON.stringify(result)) };
        }) };
      } } as unknown as SqliteEventStore;
      expect(readSubmittedReviewWorkspace(faultyStore, PROJECT_ID, SUBJECT_REF, round)).toEqual({ status: "INVALID" });
    },
  );
});
