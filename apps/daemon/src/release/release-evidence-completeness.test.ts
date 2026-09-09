import { expect, it } from "vitest";
import { releaseDossierGaps } from "./release-dossier.js";
import { HEAD_SHA, ancestryOf, dossierInput } from "./release-dossier-fixtures.js";

it("keeps a verifier receipt without a measured source SHA unverified", () => {
  const input = dossierInput();
  const gaps = releaseDossierGaps({ ...input,
    criteria: input.criteria.filter((criterion) => criterion.criterionId !== "crit-charlie"),
    nodes: input.nodes.map((node) => ({ ...node,
      receipt: node.receipt === null ? null : { ...node.receipt, sha: null },
    })),
  }, HEAD_SHA, ancestryOf().predicate);
  expect(gaps.map(({ criterionId, code }) => ({ criterionId, code }))).toEqual([
    { criterionId: "crit-alpha", code: "RECEIPT_SOURCE_UNPROVEN" },
    { criterionId: "crit-bravo", code: "RECEIPT_SOURCE_UNPROVEN" },
  ]);
});
