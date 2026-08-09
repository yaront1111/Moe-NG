import type { DocumentWorkProposal } from "@moe/contracts";
import { describe, expect, it } from "vitest";

import * as stateModule from "./document-dossier-state.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function proposal(): DocumentWorkProposal {
  return {
    advisoryOnly: true,
    authority: "NONE",
    candidates: [{
      candidateRef: "candidate-1",
      objective: "Prove recovery without duplicating the accepted effect.",
      sourceRefs: ["source-1"],
      title: "Prove retry recovery",
    }],
    contextManifestDigest: HASH_B,
    projectId: "retry-recovery",
    repositoryBaseHash: HASH_A,
    schemaVersion: "moe-document-work-proposal/1",
    sources: [{
      byteLength: 412,
      contentSha256: HASH_C,
      displayPath: "docs/acceptance/retry.md",
      sourceRef: "source-1",
    }],
    submissionState: "NOT_SUBMITTED",
    truthClass: "AGENT_REPORTED",
  };
}

describe("document dossier proposal state", () => {
  it("adapts a public proposal into the only READY fields and deeply freezes it", () => {
    const candidate = Reflect.get(stateModule, "documentDossierStateFromProposal");
    expect(candidate).toBeTypeOf("function");
    if (typeof candidate !== "function") return;

    const input = proposal();
    const state = candidate({
      dossierIdentity: "retry-recovery@a",
      origin: "DAEMON",
      proposal: input,
    }) as Record<string, unknown>;

    expect(Object.keys(state).sort()).toEqual([
      "dossierIdentity", "origin", "proposal", "status",
    ]);
    expect(state).toMatchObject({
      dossierIdentity: "retry-recovery@a",
      origin: "DAEMON",
      status: "READY",
    });
    expect(state["proposal"]).toEqual(input);
    const frozen = state["proposal"] as DocumentWorkProposal;
    expect([
      Object.isFrozen(state),
      Object.isFrozen(frozen),
      Object.isFrozen(frozen.sources),
      Object.isFrozen(frozen.sources[0]),
      Object.isFrozen(frozen.candidates),
      Object.isFrozen(frozen.candidates[0]),
      Object.isFrozen(frozen.candidates[0]?.sourceRefs),
    ]).toEqual([true, true, true, true, true, true, true]);
  });

  it.each([
    ["duplicate source refs", () => {
      const input = proposal();
      return { ...input, sources: [input.sources[0]!, { ...input.sources[0]! }] };
    }],
    ["duplicate candidate refs", () => {
      const input = proposal();
      return { ...input, candidates: [input.candidates[0]!, { ...input.candidates[0]! }] };
    }],
    ["duplicate citations", () => {
      const input = proposal();
      return {
        ...input,
        candidates: [{ ...input.candidates[0]!, sourceRefs: ["source-1", "source-1"] }],
      };
    }],
    ["unbound citations", () => {
      const input = proposal();
      return {
        ...input,
        candidates: [{ ...input.candidates[0]!, sourceRefs: ["source-missing"] }],
      };
    }],
  ] as const)("refuses %s before READY with the stable presentation error", (_case, build) => {
    const state = stateModule.documentDossierStateFromProposal({
      dossierIdentity: "invalid-proposal",
      origin: "DAEMON",
      proposal: build(),
    });

    expect(state).toEqual({
      advisoryOnly: true,
      authority: "NONE",
      code: "DOCUMENT_DOSSIER_STATE_INVALID",
      layer: "CONTROL_ROOM_PRESENTATION",
      status: "ERROR",
    });
  });
});
