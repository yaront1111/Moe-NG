import { win32 } from "node:path";

import {
  PHASE0_AUTHORIZATION_ASSURANCE,
  PHASE0_AUTHORIZATION_CLAIM_VERSION,
  PHASE0_FREEZE_SUBJECT,
  PHASE0_GIT_STATUS_COMMAND,
  PHASE0_REVIEW_RECEIPT_PREFIX,
  PHASE0_REVIEW_RECEIPT_VERSION,
  PHASE0_ROLE_METADATA,
  PHASE0_SOURCE_REPOSITORY,
  PHASE0_TARGET_REPOSITORY,
  type Phase0FreezeAuthorizationClaim,
} from "@moe/contracts";
import { expect, it } from "vitest";

import { canonicalize } from "./canonical-json.js";
import {
  capturePhase0Evidence,
  type Phase0EvidenceCapturePort,
} from "./phase0-evidence-capture.js";
import { identifyEvidence } from "./evidence-digest.js";
import { verifyPhase0EvidenceManifest } from "./phase0-evidence-manifest-verifier.js";
import { evaluatePhase0FreezeCandidate } from "./phase0-freeze-verifier.js";

const encoder = new TextEncoder();
const HEAD = "454a6012e955e5d9d37f050330c4a58111be23f4";

class CompositionPort implements Phase0EvidenceCapturePort {
  public readonly files = new Map<string, Uint8Array>();
  public readonly objects = new Map<string, Uint8Array>();
  readonly #statusBytes = encoder.encode("? docs/plans/phase0-inputs\0");

  public constructor() {
    const reviewedDigests = new Map<string, string>();
    for (const metadata of PHASE0_ROLE_METADATA.slice(0, 5)) {
      const bytes = encoder.encode(`# ${metadata.role}\nexact reviewed bytes\n`);
      this.files.set(metadata.relativePath, bytes);
      reviewedDigests.set(metadata.role, identifyEvidence(bytes).digest);
    }
    const receipt = {
      inputSha256: {
        "benchmark-spec": reviewedDigests.get("benchmark-spec")!,
        "control-room-spec": reviewedDigests.get("control-room-spec")!,
        "fable-review": reviewedDigests.get("fable-review")!,
        "rebuild-charter": reviewedDigests.get("rebuild-charter")!,
        "rebuild-design": reviewedDigests.get("rebuild-design")!,
      },
      schemaVersion: PHASE0_REVIEW_RECEIPT_VERSION,
      verdict: "FREEZE_READY",
    } as const;
    this.files.set(
      "docs/plans/2026-08-05-moe-rebuild-moe-review.md",
      encoder.encode(
        `# Independent review\n${PHASE0_REVIEW_RECEIPT_PREFIX}${canonicalize(receipt)}\nFREEZE_READY\n`,
      ),
    );
  }

  public async lookupPathAtCommit(
    sourceRepository: string,
    commit: string,
    relativePath: string,
  ) {
    return { commit, identity: null, relativePath, sourceRepository };
  }

  public now(): string {
    return "2026-08-06T09:00:00.000Z";
  }

  public async readEvidenceObject(targetRepository: string, objectPath: string) {
    const bytes = this.objects.get(objectPath);
    if (bytes === undefined) {
      throw new Error(`missing ${objectPath}`);
    }
    return { bytes: bytes.slice(), objectPath, targetRepository };
  }

  public async readRepositorySnapshot(sourceRepository: string, statusCommand: string) {
    return {
      head: HEAD,
      objectFormat: "sha1" as const,
      sourceRepository,
      statusBytes: this.#statusBytes.slice(),
      statusCommand,
    };
  }

  public async readSourceFile(sourceRepository: string, relativePath: string) {
    const bytes = this.files.get(relativePath);
    if (bytes === undefined) {
      throw new Error(`missing ${relativePath}`);
    }
    return {
      bytes: bytes.slice(),
      relativePath,
      resolvedPath: win32.join(sourceRepository, relativePath),
      sourceRepository,
    };
  }

  public async writeEvidenceObject(
    targetRepository: string,
    objectPath: string,
    bytes: Uint8Array,
  ) {
    this.objects.set(objectPath, bytes.slice());
    return { objectPath, targetRepository };
  }
}

it("composes real capture bytes into a non-authoritative evidence candidate", async () => {
  const port = new CompositionPort();
  const manifest = await capturePhase0Evidence(port);
  expect(manifest.sourceRepository).toBe(PHASE0_SOURCE_REPOSITORY);
  expect(manifest.targetRepository).toBe(PHASE0_TARGET_REPOSITORY);
  expect(manifest.statusCommand).toBe(PHASE0_GIT_STATUS_COMMAND);

  const manifestBytes = encoder.encode(canonicalize(manifest));
  const verifiedManifest = await verifyPhase0EvidenceManifest(manifestBytes, port);
  const firstDesignRead = verifiedManifest.readEvidence("rebuild-design");
  firstDesignRead.fill(0);
  expect(identifyEvidence(verifiedManifest.readEvidence("rebuild-design")).digest).toBe(
    manifest.entries[0]!.sha256,
  );
  const byRole = new Map(manifest.entries.map((entry) => [entry.role, entry]));
  const authorization: Phase0FreezeAuthorizationClaim = {
    assurance: PHASE0_AUTHORIZATION_ASSURANCE,
    claimedAt: "2026-08-06T09:01:00.000Z",
    benchmarkSha256: byRole.get("benchmark-spec")!.sha256,
    claimedActor: "yaron",
    claimedDecision: "GO",
    designSha256: byRole.get("rebuild-design")!.sha256,
    manifestSha256: identifyEvidence(manifestBytes).digest,
    reviewSha256: byRole.get("moe-review")!.sha256,
    schemaVersion: PHASE0_AUTHORIZATION_CLAIM_VERSION,
    subject: PHASE0_FREEZE_SUBJECT,
    targetRepository: PHASE0_TARGET_REPOSITORY,
  };
  const authorizationClaimBytes = encoder.encode(canonicalize(authorization));
  const evaluated = await evaluatePhase0FreezeCandidate({
    authorizationClaimBytes,
    manifestBytes,
    now: () => "2026-08-06T09:02:00.000Z",
    readEvidenceObject: (targetRepository, objectPath) =>
      port.readEvidenceObject(targetRepository, objectPath),
  });

  expect(evaluated.candidate).toMatchObject({
    authorizationClaim: {
      assurance: "UNAUTHENTICATED_EXTERNAL_RECORD",
      claimedActor: "yaron",
      claimedDecision: "GO",
    },
    evaluation: "EVIDENCE_CONSISTENT",
    requiredAction: "REQUIRE_TRUSTED_ATTESTATIONS",
    reviewClaim: {
      assurance: "CONTENT_BOUND_UNAUTHENTICATED_REVIEW",
      claimedVerdict: "FREEZE_READY",
    },
    sourceHead: HEAD,
  });
  expect(evaluated.candidate).not.toHaveProperty("decision");
  expect(evaluated.candidate).not.toHaveProperty("status");
  expect(evaluated.candidateJson).not.toContain('"decision":"GO"');
  expect(evaluated.candidateJson).not.toContain('"status":"VERIFIED"');
  expect(evaluated.candidateJson).not.toContain("moe-phase0-freeze-decision/");
});
