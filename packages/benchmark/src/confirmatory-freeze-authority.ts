import { readFileSync } from "node:fs";

import {
  validateConfirmatoryFreezeAuthorityRecord,
} from "./confirmatory-freeze-authority-contracts.js";
import type {
  ConfirmatoryFreezeAuthorityGrant,
  ConfirmatoryFreezeAuthorityValidationRefusal,
} from "./confirmatory-freeze-authority-contracts.js";

/**
 * CONFIRMATORY BENCHMARK FREEZE AUTHORITY: NO RECORD IS INSTALLED.
 *
 * Governor ruling `comment-b308bf89a6d24978a928eadc5bade7b1` withholds every
 * custodian, signer, key, delegated signing authority, and corpus creation permission.
 * The refusal below is therefore the committed-tree answer until a human supplies the
 * source-controlled record described here. Building this reader does not grant authority.
 *
 * WHY THE FIXED FILE IS NOT CALLER AUTHORITY. The reader remains zero-arity and resolves
 * one module-relative path internally. It accepts no path, environment variable, config
 * key, argument, or fixture hook. A caller therefore cannot supply its own answer. Missing
 * bytes still mean `CONFIRMATORY_FREEZE_AUTHORITY_UNASSIGNED`; unreadable or invalid bytes
 * refuse at this same layer with the validator's more specific stable code.
 *
 * HUMAN INSTALL PROCEDURE — and only a human may perform it. To supersede the withholding,
 * add `packages/benchmark/authority/confirmatory-freeze-authority.json` with schema version
 * 1 and every field in `ConfirmatoryFreezeAuthorityRecord`: confirmatory-corpus scope and
 * reference; independent author and custodian identities; allowed viewers; artifact
 * boundary and separation attestation; signature algorithm and encoding; signer key id,
 * trusted public-key distribution and rotation semantics; canonical bytes covered;
 * issuance/timestamp semantics; public registry reference/semantics; redaction rules; and
 * stale, expiry, and revocation timestamps. The human names the custodian, key material,
 * and algorithm. This repository supplies no default for any of them.
 *
 * WHY THE CODE AND LAYER ARE LOAD-BEARING. The exact no-record tuple proves this question
 * was asked and answered in the negative. Downstream admission preserves it rather than
 * relabelling, collapsing, or swallowing the originating decision.
 */

export const CONFIRMATORY_FREEZE_AUTHORITY_RECORD_PATH =
  "packages/benchmark/authority/confirmatory-freeze-authority.json";

export const CONFIRMATORY_FREEZE_AUTHORITY_CODE =
  "CONFIRMATORY_FREEZE_AUTHORITY_UNASSIGNED";

export const CONFIRMATORY_FREEZE_AUTHORITY_LAYER =
  "CONFIRMATORY_FREEZE_AUTHORITY";

const RECORD_URL = new URL(`../../../${CONFIRMATORY_FREEZE_AUTHORITY_RECORD_PATH}`, import.meta.url);

export type ConfirmatoryFreezeAuthorityRefusal = {
  readonly authority: "NONE";
  readonly code: typeof CONFIRMATORY_FREEZE_AUTHORITY_CODE;
  readonly layer: typeof CONFIRMATORY_FREEZE_AUTHORITY_LAYER;
  readonly ok: false;
};

export type ConfirmatoryFreezeAuthorityReadResult =
  | ConfirmatoryFreezeAuthorityGrant
  | ConfirmatoryFreezeAuthorityValidationRefusal;

function frozenRefusal(
  code: ConfirmatoryFreezeAuthorityValidationRefusal["code"],
): ConfirmatoryFreezeAuthorityValidationRefusal {
  return Object.freeze({
    authority: "NONE",
    code,
    layer: CONFIRMATORY_FREEZE_AUTHORITY_LAYER,
    ok: false,
  });
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as Error & { readonly code?: unknown }).code === "ENOENT";
}

function readAuthorityBytes(): Uint8Array | ConfirmatoryFreezeAuthorityValidationRefusal {
  try {
    return readFileSync(RECORD_URL);
  } catch (error: unknown) {
    return isMissingFile(error)
      ? frozenRefusal(CONFIRMATORY_FREEZE_AUTHORITY_CODE)
      : frozenRefusal("CONFIRMATORY_FREEZE_AUTHORITY_UNREADABLE");
  }
}

/**
 * Reads only the fixed record path documented above. With no installed record, allocates
 * a fresh frozen refusal carrying the original code and layer. Validation occurs outside
 * the file-read catch so no parser or validation refusal can be swallowed as an I/O error.
 */
export const readConfirmatoryFreezeAuthority = (): ConfirmatoryFreezeAuthorityReadResult => {
  const source = readAuthorityBytes();
  return source instanceof Uint8Array
    ? validateConfirmatoryFreezeAuthorityRecord(source)
    : source;
};
