import { describe, expect, it } from "vitest";
import { decodeVerifiedWorkspaceBinding, sameVerifiedWorkspace } from "./verified-workspace-contracts.js";
import type { VerifiedWorkspaceBinding } from "./verified-workspace-contracts.js";

const BINDING: VerifiedWorkspaceBinding = {
  branchRef: "refs/heads/main", dirtySha256: "d".repeat(64), headSha: "1".repeat(40), root: "/workspace",
  treeSha: "2".repeat(40), version: "moe-verified-workspace/1",
};
describe("verified workspace binding", () => {
  it("decodes only an absolute repository and a valid branch reference", () => {
    expect(decodeVerifiedWorkspaceBinding(BINDING)).toEqual(BINDING);
    expect(decodeVerifiedWorkspaceBinding({ ...BINDING, root: "relative" })).toBeNull();
    for (const branchRef of ["main", "refs/heads/", "refs/heads/bad\nref", "refs/heads/a..b", "refs/heads/a.lock", "refs/heads/.hidden", "refs/heads/a@{b", "refs/heads/a b"]) {
      expect(decodeVerifiedWorkspaceBinding({ ...BINDING, branchRef })).toBeNull();
    }
  });

  it("rejects missing, extra and mixed-object-format identity facts", () => {
    for (const value of [null, {}, { ...BINDING, extra: 1 }, { ...BINDING, headSha: undefined },
      { ...BINDING, treeSha: "2".repeat(64) }, { ...BINDING, dirtySha256: "d".repeat(40) }]) {
      expect(decodeVerifiedWorkspaceBinding(value)).toBeNull();
    }
    expect(decodeVerifiedWorkspaceBinding({ ...BINDING, headSha: null })?.headSha).toBeNull();
  });

  it("compares every provenance field, including branch and dirty-path identity", () => {
    expect(sameVerifiedWorkspace(BINDING, { ...BINDING })).toBe(true);
    for (const update of [{ root: "/other" }, { branchRef: "refs/heads/other" }, { headSha: null },
      { treeSha: "3".repeat(40) }, { dirtySha256: "e".repeat(64) }]) {
      expect(sameVerifiedWorkspace(BINDING, { ...BINDING, ...update })).toBe(false);
    }
  });
});
