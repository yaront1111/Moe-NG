import { createHash } from "node:crypto";

import {
  CANONICAL_JSON_VERSION,
  EVIDENCE_IDENTITY_VERSION,
  PHASE0_EVIDENCE_MANIFEST_VERSION,
  PHASE0_GIT_STATUS_COMMAND,
  PHASE0_MAX_DOCUMENT_BYTES,
  PHASE0_ROLE_METADATA,
  PHASE0_SOURCE_REPOSITORY,
  PHASE0_TARGET_REPOSITORY,
  type Phase0EvidenceRole,
} from "@moe/contracts";
import { beforeAll, describe, expect, it } from "vitest";

import { canonicalize } from "./canonical-json.js";
import { identifyEvidence } from "./evidence-digest.js";
import {
  verifyPhase0EvidenceManifest,
  type Phase0FreezeObjectReader,
  type VerifiedPhase0EvidenceManifest,
} from "./phase0-evidence-manifest-verifier.js";

type JsonRecord = Record<string, unknown>;
type Mutate = (manifest: JsonRecord, entries: JsonRecord[]) => void;

const BLOB = "PHASE0_MANIFEST_GIT_BLOB_MISMATCH";
const ENTRY = "PHASE0_MANIFEST_ENTRY_INVALID";
const LIMIT = "PHASE0_MANIFEST_DOCUMENT_LIMIT_EXCEEDED";
const OBJECT = "PHASE0_EVIDENCE_OBJECT";
const OBSERVED = "PHASE0_MANIFEST_OBSERVATION_INVALID";
const SHAPE = "PHASE0_MANIFEST_SHAPE_INVALID";

const encoder = new TextEncoder();
const HEAD = "3f".repeat(20);
const STATUS_BYTES = encoder.encode("1 .M N... 100644 100644 100644 . . AGENTS.md\0");
const STATUS = identifyEvidence(STATUS_BYTES);

function documentBytes(index: number): Uint8Array {
  return encoder.encode(`# phase0 characterization document ${index}\nbody\n`);
}

const DOC0 = identifyEvidence(documentBytes(0));
const at = (record: JsonRecord, key: string): JsonRecord => record[key] as JsonRecord;

function gitBlobOid(bytes: Uint8Array): string {
  return createHash("sha1")
    .update(encoder.encode(`blob ${bytes.byteLength}\0`))
    .update(bytes)
    .digest("hex");
}

function buildEntries(): JsonRecord[] {
  return PHASE0_ROLE_METADATA.map((metadata, index) => {
    const bytes = documentBytes(index);
    const identity = identifyEvidence(bytes);
    return {
      byteLength: identity.byteLength,
      lineCount: 2,
      objectPath: identity.objectPath,
      owner: metadata.owner,
      relativePath: metadata.relativePath,
      role: metadata.role,
      sha256: identity.digest,
      sourceState:
        index === 0
          ? { blobOid: gitBlobOid(bytes), state: "IDENTICAL_TO_HEAD", verifiedAtHead: true }
          : { blobOid: null, state: "ABSENT_AT_HEAD" },
    };
  });
}

function buildManifest(entries: readonly JsonRecord[]): JsonRecord {
  const snapshot = { head: HEAD, statusObjectPath: STATUS.objectPath, statusSha256: STATUS.digest };
  return {
    canonicalizerVersion: CANONICAL_JSON_VERSION,
    captureStatus: "VERIFIED",
    capturedAt: "2026-08-07T00:00:00.000Z",
    entries,
    evidenceIdentityVersion: EVIDENCE_IDENTITY_VERSION,
    gitObjectFormat: "sha1",
    schemaVersion: PHASE0_EVIDENCE_MANIFEST_VERSION,
    sourceAfter: { ...snapshot },
    sourceBefore: { ...snapshot },
    sourceRepository: PHASE0_SOURCE_REPOSITORY,
    statusCommand: PHASE0_GIT_STATUS_COMMAND,
    targetRepository: PHASE0_TARGET_REPOSITORY,
  };
}

class StubReader implements Phase0FreezeObjectReader {
  public readonly objects = new Map<string, Uint8Array>();
  public readonly reads: string[] = [];
  public failOn: string | null = null;
  public lieAboutPath: string | null = null;
  public lieAboutTarget = false;

  public constructor() {
    this.objects.set(STATUS.objectPath, STATUS_BYTES);
    PHASE0_ROLE_METADATA.forEach((_metadata, index) => {
      const bytes = documentBytes(index);
      this.objects.set(identifyEvidence(bytes).objectPath, bytes);
    });
  }

  public async readEvidenceObject(targetRepository: string, objectPath: string) {
    this.reads.push(objectPath);
    const bytes = this.objects.get(objectPath);
    if (this.failOn === objectPath || bytes === undefined) {
      throw new Error(`unavailable ${objectPath}`);
    }
    return {
      bytes: bytes.slice(),
      objectPath: this.lieAboutPath === objectPath ? `${objectPath}-moved` : objectPath,
      targetRepository: this.lieAboutTarget ? "D:\\elsewhere" : targetRepository,
    };
  }
}

async function verifyFixture(
  mutate: Mutate = () => undefined,
  reader: StubReader = new StubReader(),
): Promise<VerifiedPhase0EvidenceManifest> {
  const entries = buildEntries();
  const manifest = buildManifest(entries);
  mutate(manifest, entries);
  return verifyPhase0EvidenceManifest(encoder.encode(canonicalize(manifest)), reader);
}

describe("verifyPhase0EvidenceManifest result", () => {
  let manifestJson: string;
  let reader: StubReader;
  let verified: VerifiedPhase0EvidenceManifest;

  beforeAll(async () => {
    reader = new StubReader();
    manifestJson = canonicalize(buildManifest(buildEntries()));
    verified = await verifyPhase0EvidenceManifest(encoder.encode(manifestJson), reader);
  });

  it("pins the canonical manifest JSON, identity, and role order", () => {
    expect(verified.manifestJson).toBe(manifestJson);
    expect(verified.identity).toEqual(identifyEvidence(encoder.encode(manifestJson)));
    expect(verified.manifest.entries.map((entry) => entry.role)).toEqual(
      PHASE0_ROLE_METADATA.map((metadata) => metadata.role),
    );
  });

  it("reads the status object first, then entries in metadata order", () => {
    const entryPaths = PHASE0_ROLE_METADATA.map((_metadata, index) =>
      identifyEvidence(documentBytes(index)).objectPath,
    );
    expect(reader.reads).toEqual([STATUS.objectPath, ...entryPaths]);
  });

  it("freezes the whole result graph", () => {
    const entry = verified.manifest.entries[0]!;
    const graph = [verified, verified.identity, verified.manifest, verified.manifest.entries,
      entry, entry.sourceState, verified.manifest.sourceBefore, verified.manifest.sourceAfter];
    expect(graph.map((value) => Object.isFrozen(value))).toEqual(graph.map(() => true));
  });

  it("returns a fresh readEvidence copy per call and rejects unknown roles", () => {
    verified.readEvidence("rebuild-design").fill(0);
    expect(verified.readEvidence("rebuild-design")).toEqual(documentBytes(0));
    expect(() => verified.readEvidence("nope" as Phase0EvidenceRole)).toThrowError(
      new Error("PHASE0_MANIFEST_ROLE_SET_INVALID: nope"),
    );
  });
});

const DECODE_CASES: readonly (readonly [string, Mutate])[] = [
  [`${SHAPE}: keys`, (m) => void (m.extra = 1)],
  [`${SHAPE}: fixed fields`, (m) => void (m.captureStatus = "UNVERIFIED")],
  [`${SHAPE}: gitObjectFormat`, (m) => void (m.gitObjectFormat = "sha384")],
  ["PHASE0_TARGET_REPOSITORY_MISMATCH: manifest", (m) => void (m.targetRepository = "D:\\rogue")],
  [`${OBSERVED}: sourceBefore.head`, (m) => void (at(m, "sourceBefore").head = "not-an-oid")],
  [`${OBSERVED}: sourceBefore.statusObjectPath`, (m) => void (at(m, "sourceBefore").statusObjectPath = "unbound")],
  ["PHASE0_MANIFEST_REPOSITORY_CHANGED: before/after", (m) => void (at(m, "sourceAfter").head = "a".repeat(40))],
  ["PHASE0_MANIFEST_CAPTURE_TIME_INVALID: capturedAt", (m) => void (m.capturedAt = "2026-08-07T00:00:00Z")],
  ["PHASE0_MANIFEST_ROLE_SET_INVALID: entry count", (_m, l) => void l.pop()],
  ["PHASE0_MANIFEST_ROLE_SET_INVALID: entry 0", (_m, l) => void l.splice(0, 2, l[1]!, l[0]!)],
  [`${LIMIT}: rebuild-design`, (_m, l) => void (l[0]!.byteLength = PHASE0_MAX_DOCUMENT_BYTES + 1)],
  [`${ENTRY}: rebuild-charter.objectPath`, (_m, l) => void (l[1]!.objectPath = DOC0.objectPath)],
  [
    "PHASE0_MANIFEST_DUPLICATE_DOCUMENT_BYTES: rebuild-charter",
    (_m, l) => {
      l[1]!.objectPath = DOC0.objectPath;
      l[1]!.sha256 = DOC0.digest;
    },
  ],
  [`${ENTRY}: rebuild-design.sourceState`, (_m, l) => void (at(l[0]!, "sourceState").verifiedAtHead = false)],
  [`${ENTRY}: rebuild-charter.blobOid`, (_m, l) => void (at(l[1]!, "sourceState").blobOid = "a".repeat(40))],
  [
    "PHASE0_MANIFEST_ENTRY_LINE_COUNT_MISMATCH: rebuild-design",
    (_m, l) => {
      l[0]!.lineCount = 99;
      at(l[0]!, "sourceState").blobOid = "b".repeat(40);
    },
  ],
  [`${BLOB}: rebuild-design`, (_m, l) => void (at(l[0]!, "sourceState").blobOid = "b".repeat(40))],
];

const READER_CASES: readonly (readonly [string, (reader: StubReader) => void])[] = [
  [`${OBJECT}_LOCATION_MISMATCH: repository-status`, (r) => void (r.lieAboutTarget = true)],
  [`${OBJECT}_READ_FAILED: rebuild-design`, (r) => void (r.failOn = DOC0.objectPath)],
  [
    `${OBJECT}_LOCATION_MISMATCH: rebuild-design`,
    (r) => {
      r.lieAboutPath = DOC0.objectPath;
      r.objects.set(DOC0.objectPath, encoder.encode("tampered"));
    },
  ],
  [`${OBJECT}_MISMATCH: rebuild-design`, (r) => void r.objects.set(DOC0.objectPath, encoder.encode("tamper"))],
  [`${OBJECT}_MISMATCH: rebuild-design`, (r) => void r.objects.set(DOC0.objectPath, new Uint8Array(4096))],
];

describe("verifyPhase0EvidenceManifest failures", () => {
  it.each(DECODE_CASES)("rejects a manifest with %s", async (message, mutate) => {
    await expect(verifyFixture(mutate)).rejects.toThrowError(new Error(message));
  });

  it.each(READER_CASES)("rejects a reader with %s", async (message, arrange) => {
    const reader = new StubReader();
    arrange(reader);
    await expect(verifyFixture(undefined, reader)).rejects.toThrowError(new Error(message));
  });

  it("rejects manifest bytes that are not canonical", async () => {
    const bytes = encoder.encode(`${JSON.stringify(buildManifest(buildEntries()))} `);
    await expect(verifyPhase0EvidenceManifest(bytes, new StubReader())).rejects.toThrowError(
      new Error("PHASE0_MANIFEST_NOT_CANONICAL: manifest"),
    );
  });

  it("fails on the status object before reading any entry", async () => {
    const reader = new StubReader();
    reader.failOn = STATUS.objectPath;
    await expect(verifyFixture(undefined, reader)).rejects.toThrowError(
      new Error(`${OBJECT}_READ_FAILED: repository-status`),
    );
    expect(reader.reads).toEqual([STATUS.objectPath]);
  });
});
