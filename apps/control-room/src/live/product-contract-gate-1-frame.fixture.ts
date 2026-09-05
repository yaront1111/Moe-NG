/**
 * A REAL /product-contract/gate-1/read frame, built by the PRODUCTION code that serves it.
 *
 * Nothing here is author-invented. `createProductContractRevision` computes the revision and
 * its content digest, `grantHumanAuthority` mints the human grant, and
 * `validateProductContractGate1` derives the verdict - the same three core entry points the
 * daemon reaches through `resolveProductContractGate1`
 * (apps/daemon/src/product-contract/product-contract-gate-1-resolver.ts:57-64). The route then
 * wraps that verdict in exactly one object, `{ gate: resolved, outcome: "GATE" }`
 * (apps/daemon/src/http/product-contract-gate-1-read.ts:111-113), which is what this module
 * re-creates. A test built on it is asserting against the daemon's own bytes.
 *
 * EVERY STEP THROWS ON REFUSAL. If core ever refuses this draft, this fixture cannot silently
 * degrade into a hand-shaped object: it throws and every arm that consumes it goes red.
 */
import {
  createProductContractRevision, grantHumanAuthority, productContractGate1Authority,
  validateProductContractGate1,
} from "@moe/core";
import type { ProductContractRevisionRef } from "@moe/core";

const DRAFT = Object.freeze({
  authorRef: "operator-ada",
  contractId: "contract-sign-in",
  criteria: Object.freeze([
    Object.freeze({
      criterionId: "crit-sso-1",
      requirementId: "req-sign-in",
      statement: "A returning operator reaches the board without retyping a password.",
      supersedesCriterionId: null,
    }),
    Object.freeze({
      criterionId: "crit-sso-2",
      requirementId: "req-sign-in",
      statement: "A revoked credential is refused with its own code.",
      supersedesCriterionId: null,
    }),
  ]),
  lineage: null,
  requirements: Object.freeze([
    Object.freeze({
      requirementId: "req-sign-in",
      statement: "Operators sign in once per device.",
      supersedesRequirementId: null,
    }),
  ]),
  retiredCriterionIds: Object.freeze([]),
  retiredRequirementIds: Object.freeze([]),
  revisionId: "rev-sign-in-1",
  sourceDocumentDigests: Object.freeze(["d".repeat(64)]),
});

const GRANTED_AT_EPOCH_MS = 1_756_000_000_000;

function builtVerdict(): {
  readonly ref: ProductContractRevisionRef;
  readonly verdict: Readonly<Record<string, unknown>>;
} {
  const created = createProductContractRevision(DRAFT);
  if (!created.ok) throw new Error(`gate-1 fixture revision refused: ${created.code}`);
  const ref = Object.freeze({
    contractId: created.revision.contractId,
    revisionDigest: created.revision.revisionDigest,
    revisionId: created.revision.revisionId,
  });
  const granted = grantHumanAuthority(
    productContractGate1Authority(ref),
    { kind: "HUMAN", principalId: "operator-ada" },
    GRANTED_AT_EPOCH_MS,
  );
  if (!granted.ok) throw new Error(`gate-1 fixture grant refused: ${granted.code}`);
  const verdict = validateProductContractGate1(created.revision, granted.gate);
  if (!("ok" in verdict) || verdict.ok !== true) {
    throw new Error(`gate-1 fixture gate refused: ${verdict.code}`);
  }
  return { ref, verdict: verdict as unknown as Readonly<Record<string, unknown>> };
}

const built = builtVerdict();

/** The revision triple a caller POSTs; the coverage frame carries the same three fields. */
export const REAL_GATE_1_REF = built.ref;

/** The exact body the daemon replies with on a satisfied Gate 1. */
export const REAL_GATE_1_FRAME: Readonly<Record<string, unknown>> = Object.freeze({
  gate: built.verdict, outcome: "GATE",
});

/** The digest core stamped on the verdict; a decoder must carry it through unchanged. */
export const REAL_GATE_1_REVISION_DIGEST = built.ref.revisionDigest;
