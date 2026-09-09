import { describe, expect, it } from "vitest";
import { decodePublicationApproval, decodePublicationCandidate, publicationRepositoryId } from "./publication-approval-contracts.js";

const identity = { gitDirectory: "D:/product/.git", root: "D:/product" };
const approval = { branch: "delivery", remoteUrl: "https://github.com/example/product.git",
  repositoryId: publicationRepositoryId(identity), sha: "a".repeat(40) };

describe("publication approval binds the exact artifact and repository", () => {
  it("decodes the exact public tuple and private canonical identity", () => {
    expect(decodePublicationApproval(approval)).toEqual(approval);
    expect(decodePublicationCandidate({ approval, identity })).toEqual({ approval, identity });
    expect(publicationRepositoryId({ ...identity, root: "D:/other" })).not.toBe(approval.repositoryId);
  });

  it("refuses missing, unknown, malformed and contradictory identity fields", () => {
    for (const input of [
      { ...approval, sha: "short" }, { ...approval, branch: "--delete" },
      { ...approval, branch: "other..branch" }, { ...approval, remoteUrl: "https://secret@github.com/o/r" },
      { ...approval, repositoryId: undefined }, { ...approval, force: true },
    ]) expect(decodePublicationApproval(input)).toBeNull();
    expect(decodePublicationCandidate({ approval, identity: { ...identity, root: "D:/other" } })).toBeNull();
    expect(decodePublicationCandidate({ approval, identity: { root: "relative", gitDirectory: ".git" } })).toBeNull();
    expect(decodePublicationCandidate({ approval, identity, token: "extra" })).toBeNull();
  });

  it("does not execute an approval accessor", () => {
    let reads = 0;
    const input = { ...approval };
    Object.defineProperty(input, "sha", { enumerable: true, get: () => { reads += 1; return approval.sha; } });
    expect(decodePublicationApproval(input)).toBeNull();
    expect(reads).toBe(0);
  });
});
