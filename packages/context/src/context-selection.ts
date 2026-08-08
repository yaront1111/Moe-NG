import { Buffer } from "node:buffer";

import {
  type MandatoryContextItem,
  type OptionalContextItem,
} from "./context-contract.js";
import {
  compareCodeUnits,
  deepFreeze,
  encodeCanonical,
} from "./canonical-digest.js";

export const CONTEXT_SELECTION_OUTCOME_KINDS = Object.freeze([
  "ADMITTED",
  "REFUSED",
] as const);

export const CONTEXT_ORDERING =
  "MANDATORY_ID_SECTION_CONTENT_ASC_OPTIONAL_PRIORITY_DESC_ID_SECTION_CONTENT_ASC" as const;

export interface ContextExclusion {
  readonly itemId: string;
  readonly reason: string;
}

export interface ContextSelectionInput {
  readonly mandatory: readonly MandatoryContextItem[];
  readonly optional: readonly OptionalContextItem[];
  readonly exclusions: readonly ContextExclusion[];
  readonly byteBudget: number;
}

export interface AdmittedContextSelection {
  readonly ordering: typeof CONTEXT_ORDERING;
  readonly mandatory: readonly MandatoryContextItem[];
  readonly optional: readonly OptionalContextItem[];
  readonly exclusions: readonly ContextExclusion[];
  readonly byteBudget: number;
  readonly selectedBytes: number;
}

export type ContextSelectionResult =
  | Readonly<{ kind: "ADMITTED"; selection: AdmittedContextSelection }>
  | Readonly<{
      kind: "REFUSED";
      code: "CONTEXT_TOO_LARGE";
      layer: "CONTEXT_SELECTION";
      mandatoryBytes: number;
      byteBudget: number;
    }>;

function compareItemIdentity(
  left: MandatoryContextItem | OptionalContextItem,
  right: MandatoryContextItem | OptionalContextItem,
): number {
  for (const field of ["id", "section", "content"] as const) {
    const order = compareCodeUnits(left[field], right[field]);
    if (order !== 0) return order;
  }
  return 0;
}

function compareOptional(
  left: OptionalContextItem,
  right: OptionalContextItem,
): number {
  if (left.priority > right.priority) return -1;
  if (left.priority < right.priority) return 1;
  const identityOrder = compareItemIdentity(left, right);
  if (identityOrder !== 0) return identityOrder;
  return compareCodeUnits(
    encodeCanonical(left.priority),
    encodeCanonical(right.priority),
  );
}

function compareExclusions(
  left: ContextExclusion,
  right: ContextExclusion,
): number {
  const itemOrder = compareCodeUnits(left.itemId, right.itemId);
  return itemOrder || compareCodeUnits(left.reason, right.reason);
}

function cloneMandatory(item: MandatoryContextItem): MandatoryContextItem {
  return { ...item };
}

function cloneOptional(item: OptionalContextItem): OptionalContextItem {
  return { ...item };
}

function contentBytes(item: MandatoryContextItem | OptionalContextItem): number {
  return Buffer.byteLength(item.content, "utf8");
}

function sumContentBytes(
  items: readonly (MandatoryContextItem | OptionalContextItem)[],
): number {
  return items.reduce((total, item) => total + contentBytes(item), 0);
}

export function selectContext(input: ContextSelectionInput): ContextSelectionResult {
  const mandatory = input.mandatory.map(cloneMandatory).sort(compareItemIdentity);
  const mandatoryBytes = sumContentBytes(mandatory);
  if (mandatoryBytes > input.byteBudget) {
    return deepFreeze({
      kind: "REFUSED",
      code: "CONTEXT_TOO_LARGE",
      layer: "CONTEXT_SELECTION",
      mandatoryBytes,
      byteBudget: input.byteBudget,
    });
  }

  const exclusions = input.exclusions.map((item) => ({ ...item })).sort(compareExclusions);
  const excludedIds = new Set(exclusions.map(({ itemId }) => itemId));
  const candidates = input.optional.map(cloneOptional).sort(compareOptional);
  const selected: OptionalContextItem[] = [];
  let selectedBytes = mandatoryBytes;
  for (const candidate of candidates) {
    if (excludedIds.has(candidate.id)) continue;
    const nextBytes = selectedBytes + contentBytes(candidate);
    if (nextBytes > input.byteBudget) break;
    selected.push(candidate);
    selectedBytes = nextBytes;
  }

  const selection = {
    ordering: CONTEXT_ORDERING,
    mandatory,
    optional: selected,
    exclusions,
    byteBudget: input.byteBudget,
    selectedBytes,
  } as const;
  return deepFreeze({ kind: "ADMITTED", selection });
}
