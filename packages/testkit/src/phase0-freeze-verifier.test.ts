import { describe, expect, it } from "vitest";

import {
  CANONICAL_JSON_VERSION,
  EVIDENCE_IDENTITY_VERSION,
  PHASE0_AUTHORIZATION_ASSURANCE,
  PHASE0_AUTHORIZATION_CLAIM_VERSION,
  PHASE0_EVIDENCE_MANIFEST_VERSION,
  PHASE0_FREEZE_CANDIDATE_VERSION,
  PHASE0_FREEZE_REQUIRED_ACTION,
  PHASE0_FREEZE_SUBJECT,
  PHASE0_REVIEW_RECEIPT_PREFIX,
  PHASE0_REVIEW_RECEIPT_VERSION,
  PHASE0_GIT_STATUS_COMMAND,
  PHASE0_ROLE_METADATA,
  PHASE0_SOURCE_REPOSITORY,
  PHASE0_TARGET_REPOSITORY,
  type Phase0EvidenceManifest,
  type Phase0FreezeAuthorizationClaim,
} from "@moe/contracts";

import { canonicalize } from "./canonical-json.js";
import { identifyEvidence } from "./evidence-digest.js";
import { evaluatePhase0FreezeCandidate } from "./phase0-freeze-verifier.js";

const encoder = new TextEncoder();
const HEAD = "454a6012e955e5d9d37f050330c4a58111be23f4";
const STATUS_BYTES = encoder.encode("? docs/plans/freeze-inputs\0");

interface Fixture {
  authorization: Phase0FreezeAuthorizationClaim;
  authorizationClaimBytes: Uint8Array;
  manifest: Phase0EvidenceManifest;
  manifestBytes: Uint8Array;
  objects: Map<string, Uint8Array>;
}

function canonicalBytes(value: unknown): Uint8Array {
  return encoder.encode(canonicalize(value));
}

function countLines(bytes: Uint8Array): number {
  if (bytes.byteLength === 0) {
    return 0;
  }
  let feeds = 0;
  for (const byte of bytes) {
    if (byte === 0x0a) {
      feeds += 1;
    }
  }
  return bytes[bytes.byteLength - 1] === 0x0a ? feeds : feeds + 1;
}

function makeFixture(): Fixture {
  const objects = new Map<string, Uint8Array>();
  const statusIdentity = identifyEvidence(STATUS_BYTES);
  objects.set(statusIdentity.objectPath, STATUS_BYTES.slice());

  const entries = PHASE0_ROLE_METADATA.slice(0, 5).map((metadata) => {
    const text = `# ${metadata.role}\n\nfrozen ${metadata.role} bytes\n`;
    const bytes = encoder.encode(text);
    const identity = identifyEvidence(bytes);
    objects.set(identity.objectPath, bytes);
    return {
      byteLength: identity.byteLength,
      lineCount: countLines(bytes),
      objectPath: identity.objectPath,
      owner: metadata.owner,
      relativePath: metadata.relativePath,
      role: metadata.role,
      sha256: identity.digest,
      sourceState: {
        blobOid: null,
        state: "ABSENT_AT_HEAD" as const,
      },
    };
  });
  const byReviewedRole = new Map(entries.map((entry) => [entry.role, entry]));
  const reviewReceipt = {
    inputSha256: {
      "benchmark-spec": byReviewedRole.get("benchmark-spec")!.sha256,
      "control-room-spec": byReviewedRole.get("control-room-spec")!.sha256,
      "fable-review": byReviewedRole.get("fable-review")!.sha256,
      "rebuild-charter": byReviewedRole.get("rebuild-charter")!.sha256,
      "rebuild-design": byReviewedRole.get("rebuild-design")!.sha256,
    },
    schemaVersion: PHASE0_REVIEW_RECEIPT_VERSION,
    verdict: "FREEZE_READY",
  } as const;
  const reviewMetadata = PHASE0_ROLE_METADATA[5]!;
  const reviewBytes = encoder.encode(
    `# Independent review\n\nNo blocking findings remain.\n\n${PHASE0_REVIEW_RECEIPT_PREFIX}${canonicalize(reviewReceipt)}\nFREEZE_READY\n`,
  );
  const reviewIdentity = identifyEvidence(reviewBytes);
  objects.set(reviewIdentity.objectPath, reviewBytes);
  entries.push({
    byteLength: reviewIdentity.byteLength,
    lineCount: countLines(reviewBytes),
    objectPath: reviewIdentity.objectPath,
    owner: reviewMetadata.owner,
    relativePath: reviewMetadata.relativePath,
    role: reviewMetadata.role,
    sha256: reviewIdentity.digest,
    sourceState: { blobOid: null, state: "ABSENT_AT_HEAD" },
  });

  const observation = {
    head: HEAD,
    statusObjectPath: statusIdentity.objectPath,
    statusSha256: statusIdentity.digest,
  };
  const manifest: Phase0EvidenceManifest = {
    canonicalizerVersion: CANONICAL_JSON_VERSION,
    captureStatus: "VERIFIED",
    capturedAt: "2026-08-06T08:00:00.000Z",
    entries,
    evidenceIdentityVersion: EVIDENCE_IDENTITY_VERSION,
    gitObjectFormat: "sha1",
    schemaVersion: PHASE0_EVIDENCE_MANIFEST_VERSION,
    sourceAfter: observation,
    sourceBefore: observation,
    sourceRepository: PHASE0_SOURCE_REPOSITORY,
    statusCommand: PHASE0_GIT_STATUS_COMMAND,
    targetRepository: PHASE0_TARGET_REPOSITORY,
  };
  const manifestBytes = canonicalBytes(manifest);
  const manifestIdentity = identifyEvidence(manifestBytes);
  const byRole = new Map(entries.map((entry) => [entry.role, entry]));
  const authorization: Phase0FreezeAuthorizationClaim = {
    assurance: PHASE0_AUTHORIZATION_ASSURANCE,
    claimedAt: "2026-08-06T08:01:00.000Z",
    benchmarkSha256: byRole.get("benchmark-spec")!.sha256,
    claimedActor: "yaron",
    claimedDecision: "GO",
    designSha256: byRole.get("rebuild-design")!.sha256,
    manifestSha256: manifestIdentity.digest,
    reviewSha256: byRole.get("moe-review")!.sha256,
    schemaVersion: PHASE0_AUTHORIZATION_CLAIM_VERSION,
    subject: PHASE0_FREEZE_SUBJECT,
    targetRepository: PHASE0_TARGET_REPOSITORY,
  };
  const authorizationClaimBytes = canonicalBytes(authorization);

  return {
    authorization,
    authorizationClaimBytes,
    manifest,
    manifestBytes,
    objects,
  };
}

async function verify(fixture: Fixture) {
  return evaluatePhase0FreezeCandidate({
    authorizationClaimBytes: fixture.authorizationClaimBytes,
    manifestBytes: fixture.manifestBytes,
    now: () => "2026-08-06T08:02:00.000Z",
    readEvidenceObject: async (targetRepository, objectPath) => {
      const bytes = fixture.objects.get(objectPath);
      if (bytes === undefined) {
        throw new Error(`missing object ${objectPath}`);
      }
      return { bytes: bytes.slice(), objectPath, targetRepository };
    },
  });
}

function replaceManifest(fixture: Fixture, update: (value: Record<string, unknown>) => void): void {
  const value = JSON.parse(new TextDecoder().decode(fixture.manifestBytes)) as Record<string, unknown>;
  update(value);
  fixture.manifestBytes = canonicalBytes(value);
  fixture.authorization = {
    ...fixture.authorization,
    manifestSha256: identifyEvidence(fixture.manifestBytes).digest,
  };
  fixture.authorizationClaimBytes = canonicalBytes(fixture.authorization);
}

function replaceAuthorization(
  fixture: Fixture,
  update: (value: Record<string, unknown>) => void,
): void {
  const value = JSON.parse(new TextDecoder().decode(fixture.authorizationClaimBytes)) as Record<string, unknown>;
  update(value);
  fixture.authorizationClaimBytes = canonicalBytes(value);
}

function replaceReviewBytes(fixture: Fixture, text: string): void {
  const manifest = JSON.parse(new TextDecoder().decode(fixture.manifestBytes)) as Record<
    string,
    unknown
  >;
  const entries = manifest.entries as Record<string, unknown>[];
  const reviewIndex = entries.findIndex((entry) => entry.role === "moe-review");
  const bytes = encoder.encode(text);
  const identity = identifyEvidence(bytes);
  entries[reviewIndex] = {
    ...entries[reviewIndex],
    byteLength: identity.byteLength,
    lineCount: countLines(bytes),
    objectPath: identity.objectPath,
    sha256: identity.digest,
  };
  fixture.objects.set(identity.objectPath, bytes);
  fixture.manifestBytes = canonicalBytes(manifest);
  fixture.authorization = {
    ...fixture.authorization,
    manifestSha256: identifyEvidence(fixture.manifestBytes).digest,
    reviewSha256: identity.digest,
  };
  fixture.authorizationClaimBytes = canonicalBytes(fixture.authorization);
}

describe("Phase 0 freeze candidate evaluator", () => {
  it("binds exact evidence without emitting an authoritative freeze decision", async () => {
    const fixture = makeFixture();

    const evaluated = await verify(fixture);

    expect(evaluated.candidate).toMatchObject({
      evaluatedAt: "2026-08-06T08:02:00.000Z",
      evaluation: "EVIDENCE_CONSISTENT",
      requiredAction: PHASE0_FREEZE_REQUIRED_ACTION,
      schemaVersion: PHASE0_FREEZE_CANDIDATE_VERSION,
      targetRepository: PHASE0_TARGET_REPOSITORY,
      reviewClaim: {
        assurance: "CONTENT_BOUND_UNAUTHENTICATED_REVIEW",
        claimedVerdict: "FREEZE_READY",
      },
      authorizationClaim: {
        assurance: "UNAUTHENTICATED_EXTERNAL_RECORD",
        claimedActor: "yaron",
        claimedDecision: "GO",
        sha256: identifyEvidence(fixture.authorizationClaimBytes).digest,
      },
    });
    expect(evaluated.candidate).not.toHaveProperty("decision");
    expect(evaluated.candidate).not.toHaveProperty("status");
    expect(evaluated.candidateJson).toBe(canonicalize(evaluated.candidate));
    expect(evaluated.candidateJson).not.toContain('"decision":"GO"');
    expect(evaluated.identity.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(evaluated)).toBe(true);
    expect(Object.isFrozen(evaluated.candidate)).toBe(true);
  });

  it.each([
    ["embedded decoy", "# review\nFREEZE_READY\nmore text\n", "PHASE0_REVIEW_VERDICT_INVALID"],
    ["negative verdict", "# review\nNOT_FREEZE_READY\n", "PHASE0_REVIEW_VERDICT_INVALID"],
    ["suffix trick", "# review\nFREEZE_READY!\n", "PHASE0_REVIEW_VERDICT_INVALID"],
  ])("rejects a %s", async (_label, reviewText, code) => {
    const fixture = makeFixture();
    replaceReviewBytes(fixture, reviewText);

    await expect(verify(fixture)).rejects.toThrow(code);
  });

  it("rejects a stale review whose receipt does not bind every reviewed input", async () => {
    const fixture = makeFixture();
    const staleReceipt = {
      inputSha256: {
        "benchmark-spec": fixture.authorization.benchmarkSha256,
        "control-room-spec": "4".repeat(64),
        "fable-review": "5".repeat(64),
        "rebuild-charter": "6".repeat(64),
        "rebuild-design": fixture.authorization.designSha256,
      },
      schemaVersion: PHASE0_REVIEW_RECEIPT_VERSION,
      verdict: "FREEZE_READY",
    };
    replaceReviewBytes(
      fixture,
      `# stale review\n${PHASE0_REVIEW_RECEIPT_PREFIX}${canonicalize(staleReceipt)}\nFREEZE_READY\n`,
    );

    await expect(verify(fixture)).rejects.toThrow("PHASE0_REVIEW_INPUT_DIGEST_MISMATCH");
  });

  it("requires the receipt immediately before the sole terminal verdict", async () => {
    const missing = makeFixture();
    replaceReviewBytes(missing, "# review\nFREEZE_READY\n");
    await expect(verify(missing)).rejects.toThrow("PHASE0_REVIEW_RECEIPT_INVALID");

    const contradictory = makeFixture();
    replaceReviewBytes(
      contradictory,
      "# review\nNOT_FREEZE_READY\nMOE_PHASE0_REVIEW_RECEIPT:{}\nFREEZE_READY\n",
    );
    await expect(verify(contradictory)).rejects.toThrow("PHASE0_REVIEW_VERDICT_INVALID");
  });

  it("rejects a missing role even when the authorization rebinds the changed manifest", async () => {
    const fixture = makeFixture();
    replaceManifest(fixture, (manifest) => {
      manifest.entries = (manifest.entries as unknown[]).slice(0, 5);
    });

    await expect(verify(fixture)).rejects.toThrow("PHASE0_MANIFEST_ROLE_SET_INVALID");
  });

  it("rejects target, design, benchmark, and review pin mismatches", async () => {
    for (const [field, value, code] of [
      ["targetRepository", "D:\\elsewhere", "PHASE0_TARGET_REPOSITORY_MISMATCH"],
      ["designSha256", "1".repeat(64), "PHASE0_DESIGN_DIGEST_MISMATCH"],
      ["benchmarkSha256", "2".repeat(64), "PHASE0_BENCHMARK_DIGEST_MISMATCH"],
      ["reviewSha256", "3".repeat(64), "PHASE0_REVIEW_DIGEST_MISMATCH"],
    ] as const) {
      const fixture = makeFixture();
      replaceAuthorization(fixture, (authorization) => {
        authorization[field] = value;
      });
      await expect(verify(fixture)).rejects.toThrow(code);
    }
  });

  it("rejects non-canonical JSON, duplicate-key bytes, and unsupported authorization fields", async () => {
    const pretty = makeFixture();
    pretty.manifestBytes = encoder.encode(JSON.stringify(pretty.manifest, null, 2));
    pretty.authorization = {
      ...pretty.authorization,
      manifestSha256: identifyEvidence(pretty.manifestBytes).digest,
    };
    pretty.authorizationClaimBytes = canonicalBytes(pretty.authorization);
    await expect(verify(pretty)).rejects.toThrow("PHASE0_MANIFEST_NOT_CANONICAL");

    const duplicate = makeFixture();
    const authText = new TextDecoder().decode(duplicate.authorizationClaimBytes);
    duplicate.authorizationClaimBytes = encoder.encode(
      authText.replace("{", '{"claimedActor":"mallory",'),
    );
    await expect(verify(duplicate)).rejects.toThrow("PHASE0_AUTHORIZATION_NOT_CANONICAL");

    const extra = makeFixture();
    replaceAuthorization(extra, (authorization) => {
      authorization.unexpected = true;
    });
    await expect(verify(extra)).rejects.toThrow("PHASE0_AUTHORIZATION_SHAPE_INVALID");
  });

  it("rejects changed or missing content-addressed objects", async () => {
    const changed = makeFixture();
    const design = changed.manifest.entries.find((entry) => entry.role === "rebuild-design")!;
    changed.objects.set(design.objectPath, encoder.encode("changed"));
    await expect(verify(changed)).rejects.toThrow("PHASE0_EVIDENCE_OBJECT_MISMATCH");

    const missing = makeFixture();
    const benchmark = missing.manifest.entries.find((entry) => entry.role === "benchmark-spec")!;
    missing.objects.delete(benchmark.objectPath);
    await expect(verify(missing)).rejects.toThrow("PHASE0_EVIDENCE_OBJECT_READ_FAILED");
  });

  it("verifies the repository-status object and tracked Git blob identity", async () => {
    const status = makeFixture();
    const statusPath = status.manifest.sourceBefore.statusObjectPath;
    status.objects.set(statusPath, encoder.encode("forged status"));
    await expect(verify(status)).rejects.toThrow("PHASE0_EVIDENCE_OBJECT_MISMATCH");

    const tracked = makeFixture();
    replaceManifest(tracked, (manifest) => {
      const entries = manifest.entries as Record<string, unknown>[];
      entries[0] = {
        ...entries[0],
        sourceState: {
          blobOid: "a".repeat(40),
          state: "IDENTICAL_TO_HEAD",
          verifiedAtHead: true,
        },
      };
    });
    await expect(verify(tracked)).rejects.toThrow("PHASE0_MANIFEST_GIT_BLOB_MISMATCH");
  });

  it("rejects reordered roles and forged object-reader locations", async () => {
    const reordered = makeFixture();
    replaceManifest(reordered, (manifest) => {
      const entries = manifest.entries as unknown[];
      [entries[0], entries[1]] = [entries[1], entries[0]];
    });
    await expect(verify(reordered)).rejects.toThrow("PHASE0_MANIFEST_ROLE_SET_INVALID");

    const forged = makeFixture();
    const result = evaluatePhase0FreezeCandidate({
      authorizationClaimBytes: forged.authorizationClaimBytes,
      manifestBytes: forged.manifestBytes,
      now: () => "2026-08-06T08:02:00.000Z",
      readEvidenceObject: async (_targetRepository, objectPath) => ({
        bytes: forged.objects.get(objectPath)!.slice(),
        objectPath,
        targetRepository: "D:\\forged",
      }),
    });
    await expect(result).rejects.toThrow("PHASE0_EVIDENCE_OBJECT_LOCATION_MISMATCH");
  });

  it("rejects repository mutation, invalid source state, and time reversal", async () => {
    const changed = makeFixture();
    replaceManifest(changed, (manifest) => {
      manifest.sourceAfter = { ...(manifest.sourceAfter as object), head: "a".repeat(40) };
    });
    await expect(verify(changed)).rejects.toThrow("PHASE0_MANIFEST_REPOSITORY_CHANGED");

    const sourceState = makeFixture();
    replaceManifest(sourceState, (manifest) => {
      const entries = manifest.entries as Record<string, unknown>[];
      entries[0] = { ...entries[0], sourceState: { state: "UNKNOWN" } };
    });
    await expect(verify(sourceState)).rejects.toThrow("PHASE0_MANIFEST_ENTRY_INVALID");

    const reversed = makeFixture();
    const result = evaluatePhase0FreezeCandidate({
      authorizationClaimBytes: reversed.authorizationClaimBytes,
      manifestBytes: reversed.manifestBytes,
      now: () => "2026-08-06T07:59:59.999Z",
      readEvidenceObject: async (targetRepository, objectPath) => ({
        bytes: reversed.objects.get(objectPath)!.slice(),
        objectPath,
        targetRepository,
      }),
    });
    await expect(result).rejects.toThrow("PHASE0_FREEZE_TIME_INVALID");

    const earlyAuthorization = makeFixture();
    replaceAuthorization(earlyAuthorization, (authorization) => {
      authorization.claimedAt = "2026-08-06T07:59:59.999Z";
    });
    await expect(verify(earlyAuthorization)).rejects.toThrow("PHASE0_FREEZE_TIME_INVALID");
  });

  it("bounds canonical authorization bytes before parsing", async () => {
    const fixture = makeFixture();
    fixture.authorizationClaimBytes = encoder.encode(
      `{${'"padding":"' + "x".repeat(70_000) + '",'}` +
        new TextDecoder().decode(fixture.authorizationClaimBytes).slice(1),
    );

    await expect(verify(fixture)).rejects.toThrow("PHASE0_AUTHORIZATION_BYTES_LIMIT_EXCEEDED");
  });

  it("final-rereads the complete object set after the clock interaction", async () => {
    const fixture = makeFixture();
    const result = evaluatePhase0FreezeCandidate({
      authorizationClaimBytes: fixture.authorizationClaimBytes,
      manifestBytes: fixture.manifestBytes,
      now: () => {
        fixture.objects.clear();
        return "2026-08-06T08:02:00.000Z";
      },
      readEvidenceObject: async (targetRepository, objectPath) => {
        const bytes = fixture.objects.get(objectPath);
        if (bytes === undefined) {
          throw new Error(`missing ${objectPath}`);
        }
        return { bytes: bytes.slice(), objectPath, targetRepository };
      },
    });

    await expect(result).rejects.toThrow("PHASE0_EVIDENCE_OBJECT_READ_FAILED");
  });
});
