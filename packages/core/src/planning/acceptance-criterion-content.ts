import { createHash } from "node:crypto";

import {
  ACCEPTANCE_CONTRACT_LIMITS, ACCEPTANCE_CONTRACT_VERSION, acceptanceContractRefusal,
  readAcceptanceNodeKind, readAcceptanceObligations,
} from "./acceptance-contract.js";
import { planningContentHostility } from "./planning-content-hostile.js";
import { deepFreeze, exact, snapshotData } from "./planning-snapshot.js";
import type {
  AcceptanceContractNodeKind, AcceptanceContractRefusal, AcceptanceCriterionObligation,
} from "./acceptance-contract.js";

export const ACCEPTANCE_CRITERION_CONTENT_DOMAIN =
  "@moe/core.acceptance-criterion-content/1" as const;
export interface AcceptanceCriterionContent {
  readonly contentDigest: string;
  readonly criterionId: string;
}
export interface AcceptanceCriterionContentDraft {
  readonly nodeKind: AcceptanceContractNodeKind;
  readonly obligations: readonly AcceptanceCriterionObligation[];
}
export interface AcceptanceCriteriaContent extends AcceptanceCriterionContentDraft {
  readonly version: typeof ACCEPTANCE_CONTRACT_VERSION;
}
export type AcceptanceCriterionContentCreateResult =
  | Readonly<{ content: AcceptanceCriteriaContent;
    criteria: readonly AcceptanceCriterionContent[]; ok: true }>
  | AcceptanceContractRefusal;

const DRAFT_KEYS = Object.freeze(["nodeKind", "obligations"]);
const CONTENT_KEYS = Object.freeze([...DRAFT_KEYS, "version"]);
const encoder = new TextEncoder();

function canonicalText(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalText).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalText(record[key])}`,
    ).join(",")}}`;
  }
  throw new TypeError("acceptance criterion content received an unadmitted value");
}

const malformed = (): AcceptanceContractRefusal => acceptanceContractRefusal(
  "ACCEPTANCE_CONTRACT_MALFORMED", "ACCEPTANCE_CONTRACT_ADMISSION",
);
const exceeded = (): AcceptanceContractRefusal => acceptanceContractRefusal(
  "ACCEPTANCE_CONTRACT_LIMIT_EXCEEDED", "ACCEPTANCE_CONTRACT_LIMITS",
);
function criterionDigestOf(
  content: AcceptanceCriteriaContent, obligation: AcceptanceCriterionObligation,
): string {
  const source = Object.freeze({
    evidenceRequirements: obligation.evidenceRequirements, nodeKind: content.nodeKind,
    statement: obligation.statement, verificationRecipeRefs: obligation.verificationRecipeRefs,
    version: content.version,
  });
  return createHash("sha256")
    .update(ACCEPTANCE_CRITERION_CONTENT_DOMAIN, "utf8")
    .update(Uint8Array.of(0))
    .update(encoder.encode(canonicalText(source)))
    .digest("hex");
}
const byCriterionId = (left: AcceptanceCriterionContent, right: AcceptanceCriterionContent) =>
  left.criterionId < right.criterionId ? -1 : left.criterionId > right.criterionId ? 1 : 0;

/** Admits only criterion semantics; graph, author, contract and node applicability do not exist. */
export function createAcceptanceCriterionContent(
  input: unknown,
): AcceptanceCriterionContentCreateResult {
  const hostile = planningContentHostility(input, ACCEPTANCE_CONTRACT_LIMITS.maxAggregateEntries);
  if (hostile !== null) return hostile === "LIMIT_EXCEEDED" ? exceeded() : malformed();
  const snapshot = snapshotData(input);
  if (!snapshot.ok) return malformed();
  const full = exact(snapshot.value, CONTENT_KEYS);
  if (!full && !exact(snapshot.value, DRAFT_KEYS)) return malformed();
  if (full && snapshot.value["version"] !== ACCEPTANCE_CONTRACT_VERSION) {
    return acceptanceContractRefusal(
      "ACCEPTANCE_CONTRACT_VERSION_UNSUPPORTED", "ACCEPTANCE_CONTRACT_VERSION",
    );
  }
  const nodeKind = readAcceptanceNodeKind(snapshot.value["nodeKind"]);
  const obligations = readAcceptanceObligations(snapshot.value["obligations"]);
  if (!nodeKind.ok) return nodeKind; if (!obligations.ok) return obligations;
  const entries = obligations.value.reduce((sum, obligation) => sum + 1
    + obligation.evidenceRequirements.length + obligation.verificationRecipeRefs.length, 0);
  if (entries > ACCEPTANCE_CONTRACT_LIMITS.maxAggregateEntries) return exceeded();
  const content = deepFreeze<AcceptanceCriteriaContent>({
    nodeKind: nodeKind.value, obligations: obligations.value,
    version: ACCEPTANCE_CONTRACT_VERSION,
  });
  if (encoder.encode(canonicalText(content)).byteLength > ACCEPTANCE_CONTRACT_LIMITS.maxBytes) {
    return exceeded();
  }
  const criteria = content.obligations.map((obligation) => Object.freeze({
    contentDigest: criterionDigestOf(content, obligation), criterionId: obligation.criterionId,
  })).sort(byCriterionId);
  return Object.freeze({ content, criteria: Object.freeze(criteria), ok: true as const });
}
