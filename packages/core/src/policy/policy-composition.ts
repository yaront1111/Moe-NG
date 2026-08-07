/**
 * Ordered root-to-node policy slice composition (design 699: "children may tighten but never
 * relax parent policy"). Kept separate from `policy-evaluation.ts` so neither module approaches
 * the size ceiling; this file owns the dominance lattice helper and the relaxation detector.
 */
import {
  POLICY_OUTCOMES,
  POLICY_RULE_EFFECTS,
} from "./policy-contract.js";
import type {
  PolicyAutoApprovalOptIn,
  PolicyEvaluationInput,
  PolicyObligationKind,
  PolicyOutcome,
  PolicyRule,
  PolicyWaiver,
} from "./policy-contract.js";
import { tierRank } from "./policy-validation.js";

export function dominant(left: PolicyOutcome, right: PolicyOutcome): PolicyOutcome {
  return POLICY_OUTCOMES.indexOf(left) >= POLICY_OUTCOMES.indexOf(right) ? left : right;
}

function effectRank(effect: PolicyRule["effect"]): number {
  return POLICY_RULE_EFFECTS.indexOf(effect);
}

function kindRank(kind: PolicyObligationKind): number {
  return kind === "HARD" ? 1 : 0;
}

export interface SliceFold {
  readonly optIns: readonly PolicyAutoApprovalOptIn[];
  readonly relaxed: boolean;
  readonly rules: readonly PolicyRule[];
  readonly waiverInvalid: boolean;
}

/** A waiver only covers a drop when it is scoped, unexpired, and names that exact obligation. */
function waiverCovers(
  waiver: PolicyWaiver,
  obligationId: string,
  input: PolicyEvaluationInput,
): boolean {
  return waiver.namedObligationId === obligationId
    && waiver.expiresAtEpochMs > input.evaluatedAtEpochMs
    && waiver.scope.every((ref) => input.scope.includes(ref));
}

/**
 * Compares a child redeclaration against its ancestor. A weakened effect and any loss of a HARD
 * obligation are unconditional relaxations; only a dropped SOFT obligation is waivable.
 */
function ruleRelaxation(
  ancestor: PolicyRule,
  child: PolicyRule,
  input: PolicyEvaluationInput,
): { readonly relaxed: boolean; readonly waiverInvalid: boolean } {
  let relaxed = effectRank(child.effect) < effectRank(ancestor.effect);
  let waiverInvalid = false;
  const childKinds = new Map(child.obligations.map((entry) => [entry.obligationId, entry.kind]));
  for (const { kind, obligationId } of ancestor.obligations) {
    const childKind = childKinds.get(obligationId);
    if (childKind !== undefined && kindRank(childKind) >= kindRank(kind)) continue;
    if (kind === "HARD") {
      relaxed = true;
      continue;
    }
    const offered = input.waivers.filter((entry) => entry.namedObligationId === obligationId);
    if (offered.length === 0) {
      relaxed = true;
      continue;
    }
    if (!offered.some((entry) => waiverCovers(entry, obligationId, input))) {
      relaxed = true;
      waiverInvalid = true;
    }
  }
  return { relaxed, waiverInvalid };
}

function optInCovered(
  child: PolicyAutoApprovalOptIn,
  ancestors: readonly PolicyAutoApprovalOptIn[],
): boolean {
  return ancestors.some((entry) => entry.action === child.action
    && tierRank(entry.tier) >= tierRank(child.tier));
}

/**
 * Folds the ordered root-to-node chain. A later slice may redeclare a rule only at equal or
 * greater strength, and may declare an auto-approval opt-in only if an ancestor already covers
 * it. The effective opt-in set is the LAST slice's declaration, so omitting one is a tightening.
 */
export function foldSlices(input: PolicyEvaluationInput): SliceFold {
  const rules = new Map<string, PolicyRule>();
  const seenOptIns: PolicyAutoApprovalOptIn[] = [];
  let relaxed = false;
  let waiverInvalid = false;
  let index = 0;
  for (const slice of input.sliceChain) {
    for (const optIn of slice.autoApprovalOptIns) {
      if (index > 0 && !optInCovered(optIn, seenOptIns)) relaxed = true;
    }
    seenOptIns.push(...slice.autoApprovalOptIns);
    for (const rule of slice.rules) {
      const ancestor = rules.get(rule.ruleId);
      if (ancestor !== undefined) {
        const verdict = ruleRelaxation(ancestor, rule, input);
        relaxed = relaxed || verdict.relaxed;
        waiverInvalid = waiverInvalid || verdict.waiverInvalid;
      }
      rules.set(rule.ruleId, rule);
    }
    index += 1;
  }
  const last = input.sliceChain[input.sliceChain.length - 1];
  return {
    optIns: last === undefined ? [] : last.autoApprovalOptIns,
    relaxed,
    rules: [...rules.values()],
    waiverInvalid,
  };
}
