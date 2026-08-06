import { describe, expect, it } from "vitest";

import * as evidenceContract from "./phase0-evidence-contract.js";

interface EvidenceContractModule {
  readonly CANONICAL_JSON_VERSION: string;
  readonly EVIDENCE_IDENTITY_VERSION: string;
  readonly PHASE0_EVIDENCE_MANIFEST_VERSION: string;
  readonly PHASE0_ROLE_METADATA: readonly {
    readonly owner: string;
    readonly relativePath: string;
    readonly role: string;
  }[];
  readonly PHASE0_SOURCE_REPOSITORY: string;
  readonly PHASE0_TARGET_REPOSITORY: string;
}

async function loadContract(): Promise<EvidenceContractModule> {
  return evidenceContract;
}

describe("Phase 0 evidence contract", () => {
  it("binds exact algorithm versions and repository roots", async () => {
    const contract = await loadContract();

    expect({
      canonicalizer: contract.CANONICAL_JSON_VERSION,
      identity: contract.EVIDENCE_IDENTITY_VERSION,
      manifest: contract.PHASE0_EVIDENCE_MANIFEST_VERSION,
      source: contract.PHASE0_SOURCE_REPOSITORY,
      target: contract.PHASE0_TARGET_REPOSITORY,
    }).toEqual({
      canonicalizer: "moe-canonical-json/1",
      identity: "moe-evidence-identity/1",
      manifest: "moe-phase0-evidence-manifest/1",
      source: "D:\\projexts\\moes",
      target: "D:\\projexts\\moe-next",
    });
  });

  it("binds each role to one owner and canonical repository-relative path", async () => {
    const contract = await loadContract();

    expect(contract.PHASE0_ROLE_METADATA).toEqual([
      {
        role: "rebuild-design",
        owner: "codex",
        relativePath: "docs/plans/2026-08-05-moe-rebuild-design.md",
      },
      {
        role: "rebuild-charter",
        owner: "codex",
        relativePath: "docs/plans/2026-08-05-moe-rebuild-charter.md",
      },
      {
        role: "fable-review",
        owner: "fable",
        relativePath: "docs/plans/2026-08-05-moe-rebuild-fable-review.md",
      },
      {
        role: "control-room-spec",
        owner: "fable",
        relativePath: "docs/plans/2026-08-05-moe-v1-control-room-spec.md",
      },
      {
        role: "benchmark-spec",
        owner: "fable",
        relativePath: "docs/plans/2026-08-05-moe-best-tool-benchmark-spec.md",
      },
      {
        role: "moe-review",
        owner: "moe-reviewer",
        relativePath: "docs/plans/2026-08-05-moe-rebuild-moe-review.md",
      },
    ]);
  });

  it("freezes the role universe and keeps paths unique", async () => {
    const contract = await loadContract();
    const paths = contract.PHASE0_ROLE_METADATA.map(({ relativePath }) => relativePath);

    expect(Object.isFrozen(contract.PHASE0_ROLE_METADATA)).toBe(true);
    expect(contract.PHASE0_ROLE_METADATA.map(Object.isFrozen)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(new Set(paths).size).toBe(6);
  });
});
