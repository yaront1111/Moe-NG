import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { ProductContractRevisionRef } from "@moe/core";

import {
  DESIGN_PROFILE,
  DESIGN_REVISION_VERSION,
  decodeDesignRevision,
  designRefusal,
  exactDesignRecord,
  type DesignRefusal,
  type DesignRevisionOrSkip,
} from "./design-contracts.js";

/**
 * The DURABLE record one design revision is stored as, and its codec.
 *
 * A VERSION IS A STORED FACT, NOT A DERIVED ONE. The record carries the version it was appended
 * at, so a reader that walked the events out of order, or a projection that lost the aggregate
 * sequence, cannot silently renumber history. `design-store.ts` still fences the append on the
 * aggregate's observed version — the stored number is what the operator is later shown, and the
 * fence is what makes it true.
 *
 * THE CONTRACT REF TRAVELS WITH THE DESIGN. A design is only meaningful against the product
 * contract it was drawn for; storing the approved Gate 1 triple beside it is what lets child 3
 * tell the operator WHICH contract revision the design — and therefore the plan — was built on.
 *
 * The PROFILE is a server constant, not a caller member: this board designs one profile
 * (TypeScript web app: React, Node, PostgreSQL), so a seat must not be able to present another.
 */

export const DESIGN_RECORD_KEYS = Object.freeze([
  "contractRef", "goalRef", "profile", "projectId", "revision", "schemaVersion", "submittedAt",
  "version",
] as const);

export const DESIGN_CONTRACT_REF_KEYS = Object.freeze([
  "contractId", "revisionDigest", "revisionId",
] as const);

export interface DesignRecord {
  readonly contractRef: ProductContractRevisionRef;
  readonly goalRef: string;
  readonly profile: typeof DESIGN_PROFILE;
  readonly projectId: string;
  /** A real design OR a declared skip. `DESIGN_RECORD_KEYS` is unchanged: this is ONE key. */
  readonly revision: DesignRevisionOrSkip;
  readonly schemaVersion: typeof DESIGN_REVISION_VERSION;
  readonly submittedAt: string;
  readonly version: number;
}

export type DesignRecordResult =
  | { readonly ok: true; readonly record: DesignRecord }
  | DesignRefusal;

const encoder = new TextEncoder();

/** Built member by member in roster order, so two encodes of one record are byte-identical. */
export function encodeDesignRecord(record: DesignRecord): Uint8Array {
  return encoder.encode(JSON.stringify({
    contractRef: {
      contractId: record.contractRef.contractId,
      revisionDigest: record.contractRef.revisionDigest,
      revisionId: record.contractRef.revisionId,
    },
    goalRef: record.goalRef,
    profile: record.profile,
    projectId: record.projectId,
    revision: record.revision,
    schemaVersion: record.schemaVersion,
    submittedAt: record.submittedAt,
    version: record.version,
  }));
}

function contractRefOf(value: unknown): ProductContractRevisionRef | null {
  const item = exactDesignRecord(value, DESIGN_CONTRACT_REF_KEYS);
  if (item === null) return null;
  const contractId = item["contractId"];
  const revisionDigest = item["revisionDigest"];
  const revisionId = item["revisionId"];
  if (typeof contractId !== "string" || typeof revisionDigest !== "string"
    || typeof revisionId !== "string") return null;
  return Object.freeze({ contractId, revisionDigest, revisionId });
}

/** Refuses anything this module did not write, including a record of the wrong schema. */
export function decodeDesignRecordBytes(bytes: unknown): DesignRecordResult {
  const json = decodeBoundedJsonBytes(bytes);
  if (!json.ok) return designRefusal("DESIGN_RECORD_MALFORMED", json.code, "BOUNDED_JSON");
  const item = exactDesignRecord(json.value, DESIGN_RECORD_KEYS);
  if (item === null) return designRefusal("DESIGN_RECORD_MALFORMED");
  const contractRef = contractRefOf(item["contractRef"]);
  const goalRef = item["goalRef"];
  const projectId = item["projectId"];
  const submittedAt = item["submittedAt"];
  const version = item["version"];
  if (contractRef === null || typeof goalRef !== "string" || typeof projectId !== "string"
    || typeof submittedAt !== "string" || typeof version !== "number"
    || !Number.isSafeInteger(version) || version < 1
    || item["profile"] !== DESIGN_PROFILE || item["schemaVersion"] !== DESIGN_REVISION_VERSION) {
    return designRefusal("DESIGN_RECORD_MALFORMED");
  }
  const revision = decodeDesignRevision(item["revision"]);
  if (!revision.ok) return designRefusal("DESIGN_RECORD_MALFORMED", revision.code, revision.layer);
  return Object.freeze({
    ok: true as const,
    record: Object.freeze({
      contractRef,
      goalRef,
      profile: DESIGN_PROFILE,
      projectId,
      revision: revision.revision,
      schemaVersion: DESIGN_REVISION_VERSION,
      submittedAt,
      version,
    }),
  });
}
