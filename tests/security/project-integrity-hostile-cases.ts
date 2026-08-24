/** Hostile cases for the Product Contract and decision-leg canonical integrity codecs. */

import {
  PRODUCT_CONTRACT_LAYERS,
  createProductContractRevision,
  decodeProductContractRevisionBytes,
  encodeProductContractRevision,
} from "../../packages/core/src/product-contract/product-contract-codec.js";
import { validateProductContractAmendment } from "../../packages/core/src/product-contract/product-contract-lineage.js";
import type { ProductContractRevision } from "../../packages/core/src/product-contract/product-contract-contract.js";
import {
  DECISION_LEDGER_LAYER,
  DECISION_LEG_ROSTER_VERSION,
  decodeDecisionLegRoster,
  encodeDecisionLegRoster,
  identifyDecisionLegRoster,
  snapshotDecisionLegRoster,
} from "../../packages/store/src/decision-leg-roster.js";
import type { DecisionLegRoster } from "../../packages/store/src/decision-leg-roster.js";
import { probeRacing } from "./hostile-harness.js";
import type { HostileCase } from "./integrity-hostile-cases.js";

const BOUND = Object.freeze({ label: "project-integrity", timeoutMs: 2_000 });
const encoder = new TextEncoder();
const DECISION_ID = "ab".repeat(32);

function productLayer(wanted: string): string {
  const found = PRODUCT_CONTRACT_LAYERS.find((layer) => layer === wanted);
  if (found === undefined) throw new Error(`${wanted} is not declared by PRODUCT_CONTRACT_LAYERS`);
  return found;
}

function productDraft() {
  return {
    authorRef: "principal-security",
    contractId: "product-contract-security",
    criteria: [{
      criterionId: "criterion-authentication",
      requirementId: "requirement-authentication",
      statement: "A registered user signs in with valid credentials.",
      supersedesCriterionId: null,
    }],
    lineage: null,
    requirements: [{
      requirementId: "requirement-authentication",
      statement: "Registered users can sign in.",
      supersedesRequirementId: null,
    }],
    retiredCriterionIds: [] as string[],
    retiredRequirementIds: [] as string[],
    revisionId: "product-revision-1",
    sourceDocumentDigests: ["a".repeat(64)],
  };
}

function productRevision(draft: unknown): ProductContractRevision {
  const created = createProductContractRevision(draft);
  if (!created.ok) throw new Error(`${created.code}@${created.layer}`);
  return created.revision;
}

const CURRENT_PRODUCT = productRevision(productDraft());
const FORGED_PRODUCT = productRevision({
  ...productDraft(),
  lineage: {
    parentRevisionDigest: CURRENT_PRODUCT.revisionDigest,
    parentRevisionId: CURRENT_PRODUCT.revisionId,
  },
  requirements: [{
    ...productDraft().requirements[0],
    statement: "Registered users can sign in without declaring a supersession.",
  }],
  revisionId: "product-revision-2",
});

function decisionRoster(): DecisionLegRoster {
  return snapshotDecisionLegRoster({
    count: 1,
    decisionId: DECISION_ID,
    legs: [{
      aggregateId: "aggregate-security",
      expectedVersion: 0,
      index: 0,
      receiptCommandId: null,
      receiptEffectSha256: null,
      receiptRequestSha256: null,
    }],
    version: DECISION_LEG_ROSTER_VERSION,
  });
}

function captureDecisionFailure(run: () => unknown): unknown {
  try {
    run();
    return Object.freeze({ admitted: true });
  } catch (error) {
    return error;
  }
}

const productBytesInvalid = Object.freeze({
  code: "PRODUCT_CONTRACT_BYTES_INVALID",
  layer: productLayer("PROVENANCE"),
});
const productIdentityReused = Object.freeze({
  code: "PRODUCT_CONTRACT_LINEAGE_ID_REUSED",
  layer: productLayer("LINEAGE"),
});
const productDuplicateKey = Object.freeze({
  code: "PRODUCT_CONTRACT_DUPLICATE_KEY",
  layer: productLayer("PROVENANCE"),
});
const productNoncanonical = Object.freeze({
  code: "PRODUCT_CONTRACT_NONCANONICAL",
  layer: productLayer("PROVENANCE"),
});
const decisionCorrupt = Object.freeze({ code: "STORE_CORRUPT", layer: DECISION_LEDGER_LAYER });

export const PROJECT_INTEGRITY_HOSTILE_CASES: readonly HostileCase[] = Object.freeze([
  {
    arm: "BEFORE",
    constant: "PRODUCT_CONTRACT_LAYERS",
    expect: productBytesInvalid,
    name: "invalid UTF-8 cannot become a Product Contract revision",
    run: async () => decodeProductContractRevisionBytes(Uint8Array.of(0x7b, 0xff, 0x7d)),
  },
  {
    arm: "AFTER",
    constant: "PRODUCT_CONTRACT_LAYERS",
    expect: productIdentityReused,
    integrity: async () => encodeProductContractRevision(FORGED_PRODUCT),
    name: "a re-sealed statement mutation cannot reuse a requirement identity",
    run: async () => validateProductContractAmendment(CURRENT_PRODUCT, FORGED_PRODUCT),
  },
  {
    arm: "RACE",
    constant: "PRODUCT_CONTRACT_LAYERS",
    expectLeft: productDuplicateKey,
    expectRight: productNoncanonical,
    name: "duplicate-key and noncanonical revisions race without borrowing authority",
    run: async () => {
      const encoded = encodeProductContractRevision(CURRENT_PRODUCT);
      if (!encoded.ok) throw new Error(`${encoded.code}@${encoded.layer}`);
      const noncanonical = new Uint8Array(encoded.bytes.byteLength + 1);
      noncanonical.set(encoded.bytes);
      noncanonical[noncanonical.byteLength - 1] = 0x0a;
      return await probeRacing(
        BOUND,
        async () => decodeProductContractRevisionBytes(encoder.encode('{"a":1,"a":2}')),
        async () => decodeProductContractRevisionBytes(noncanonical),
      );
    },
  },
  {
    arm: "BEFORE",
    constant: "DECISION_LEDGER_LAYER",
    expect: decisionCorrupt,
    name: "a non-roster value cannot become decision-leg authority",
    run: async () => captureDecisionFailure(() => snapshotDecisionLegRoster(null)),
  },
  {
    arm: "AFTER",
    constant: "DECISION_LEDGER_LAYER",
    expect: decisionCorrupt,
    name: "canonical roster bytes replayed with trailing data remain corrupt",
    run: async () => {
      const bytes = encodeDecisionLegRoster(decisionRoster());
      const changed = new Uint8Array(bytes.byteLength + 1);
      changed.set(bytes);
      changed[changed.byteLength - 1] = 0x20;
      return captureDecisionFailure(() => decodeDecisionLegRoster(changed));
    },
  },
  {
    arm: "RACE",
    constant: "DECISION_LEDGER_LAYER",
    expectLeft: decisionCorrupt,
    expectRight: decisionCorrupt,
    name: "duplicate aggregates and a forged receipt identity both fail closed",
    run: async () => await probeRacing(
      BOUND,
      async () => captureDecisionFailure(() => snapshotDecisionLegRoster({
        count: 2,
        decisionId: DECISION_ID,
        legs: [
          { ...decisionRoster().legs[0], index: 0 },
          { ...decisionRoster().legs[0], index: 1 },
        ],
        version: DECISION_LEG_ROSTER_VERSION,
      })),
      async () => captureDecisionFailure(() => snapshotDecisionLegRoster({
        count: 1,
        decisionId: DECISION_ID,
        legs: [{
          ...decisionRoster().legs[0],
          receiptCommandId: "moe-internal:decision-effect:forged",
          receiptEffectSha256: "c".repeat(64),
          receiptRequestSha256: "d".repeat(64),
        }],
        version: DECISION_LEG_ROSTER_VERSION,
      })),
    ),
  },
]);

export function projectIntegrityControls(): Readonly<{
  decisionDigest: string;
  decisionRoundTrip: boolean;
  productDigest: string;
  productRoundTrip: boolean;
}> {
  const productEncoded = encodeProductContractRevision(CURRENT_PRODUCT);
  if (!productEncoded.ok) throw new Error(`${productEncoded.code}@${productEncoded.layer}`);
  const productDecoded = decodeProductContractRevisionBytes(productEncoded.bytes);
  const roster = decisionRoster();
  const decisionDecoded = decodeDecisionLegRoster(encodeDecisionLegRoster(roster));
  return Object.freeze({
    decisionDigest: identifyDecisionLegRoster(roster),
    decisionRoundTrip: identifyDecisionLegRoster(decisionDecoded) === identifyDecisionLegRoster(roster),
    productDigest: CURRENT_PRODUCT.revisionDigest,
    productRoundTrip: productDecoded.ok
      && productDecoded.revision.revisionDigest === CURRENT_PRODUCT.revisionDigest,
  });
}
