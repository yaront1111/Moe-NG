import { RELEASE_HANDOFF_VERSION } from "./context-contract.js";
import { canonicalSha256, deepFreeze } from "./canonical-digest.js";

export const RELEASE_HANDOFF_REFERENCE_FIELDS = Object.freeze([
  "contextManifestDigest",
  "journalDigest",
  "graphReference",
  "leaseReference",
  "evidenceReceiptReference",
] as const);

export type ReleaseHandoffReferenceField =
  (typeof RELEASE_HANDOFF_REFERENCE_FIELDS)[number];

export interface ReleaseHandoffInput {
  readonly contextManifestDigest: string;
  readonly journalDigest: string;
  readonly graphReference: string;
  readonly leaseReference: string;
  readonly evidenceReceiptReference: string;
}

export interface ReleaseHandoff extends ReleaseHandoffInput {
  readonly version: typeof RELEASE_HANDOFF_VERSION;
  readonly digest: string;
}

export type ReleaseHandoffResult =
  | Readonly<{ kind: "CREATED"; handoff: ReleaseHandoff }>
  | Readonly<{
      kind: "REFUSED";
      code: "INVALID_CONTENT_REFERENCE";
      layer: "RELEASE_HANDOFF";
      field: ReleaseHandoffReferenceField;
    }>;

function isContentReference(value: string): boolean {
  return value.length === 64 && /^[0-9a-f]+$/iu.test(value);
}

function normalizedInput(input: ReleaseHandoffInput): ReleaseHandoffInput {
  return {
    contextManifestDigest: input.contextManifestDigest.toLowerCase(),
    journalDigest: input.journalDigest.toLowerCase(),
    graphReference: input.graphReference.toLowerCase(),
    leaseReference: input.leaseReference.toLowerCase(),
    evidenceReceiptReference: input.evidenceReceiptReference.toLowerCase(),
  };
}

export function createReleaseHandoff(
  input: ReleaseHandoffInput,
): ReleaseHandoffResult {
  for (const field of RELEASE_HANDOFF_REFERENCE_FIELDS) {
    if (!isContentReference(input[field])) {
      return deepFreeze({
        kind: "REFUSED",
        code: "INVALID_CONTENT_REFERENCE",
        layer: "RELEASE_HANDOFF",
        field,
      });
    }
  }

  const content = {
    version: RELEASE_HANDOFF_VERSION,
    ...normalizedInput(input),
  } as const;
  const handoff = { ...content, digest: canonicalSha256(content) };
  return deepFreeze({ kind: "CREATED", handoff });
}
