import { derivePolicySliceDigest } from "@moe/core";
import type { JsonValue } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import { readDurableLedger, stateOf } from "./bootstrap-ledger.js";
import { installedSlices } from "./bootstrap-policy-services.js";
import { policyAggregateId } from "./bootstrap-sequence.js";
import { sliceKindOf } from "../http/policy-read.js";

/**
 * WHICH INSTALLED POLICY IS EFFECTIVE FOR AUTOMATIC APPROVAL. ONE RULE, ONE PLACE, BOTH GATES.
 *
 * THE DEFECT THIS MODULE EXISTS TO CLOSE. Gate 2 (`preview-auto-composition.ts`) used to narrow
 * the WHOLE historical installed set to EVALUATION slices declaring its own action and accept the
 * single survivor; Gate 3 (`release-auto-approval.ts`) used to take the newest EVALUATION slice.
 * Two gates, two answers to one question — and the preview reading meant an operator who
 * installed a newer policy declaring NO opt-ins did not turn automatic approval off, because the
 * older declaring slice was still the only survivor of that filter and still governed.
 *
 * THE RULE, ruled directly by the owner on 2026-09-11: NEWEST INSTALL RESETS, THEN AMBIGUITY
 * STILL REFUSES.
 *
 *   install A declaring opt-ins        -> automatic approval ON,  A is effective
 *   install B declaring NO opt-ins     -> automatic approval OFF; B RESETS and clears A
 *   install C declaring opt-ins        -> automatic approval ON,  C is effective
 *   C and D both declared after a reset -> NOTHING is effective; the gates refuse fail-closed
 *
 * An opt-in-free install is HOW an operator turns automatic approval off, and it CLEARS older
 * declarations rather than sitting beside them. Only declarations made after the MOST RECENT reset
 * compete. Plain latest-wins was offered and declined, because it deletes the fail-closed refusal
 * the two-declaring case needs: with two declarations live, which one governs would depend on key
 * order, and no reading of that is fail-closed. An explicit active-policy pointer (a new command,
 * event and schema field) was also offered and declined, so the rule is DERIVED from the existing
 * immutable install history and `policy.install` keeps recording immutable slices untouched.
 *
 * WHY A RESET SLICE IS RETURNED RATHER THAN `null`. A reset is a policy the operator installed, so
 * the gate composes against it and the ENGINE refuses with its own AUTO_APPROVAL_NOT_OPTED_IN
 * under a named `policyRevisionRef`. Answering `null` would refuse at the selection layer instead
 * and throw away the ref the refusal acted under. `null` is reserved for "no policy answers this
 * question": nothing installed, nothing declared, or an ambiguity/validity refusal.
 *
 * WHERE INSTALL ORDER COMES FROM, AND WHY THE SCAN IS REVERSE-INSERTION AND NEVER SORTED.
 * `installPolicy` folds one install at a time as `{ ...current, [sliceRef]: slice }` under a
 * hex64 ref and refuses a repeat ref with BOOTSTRAP_POLICY_SLICE_ALREADY_INSTALLED, so the slice
 * map's INSERTION order is install order; `commitAccepted`'s JSON round trip preserves it, because
 * these keys are hex strings and not array indices. `PolicyInstalled` carries the same chronology
 * as the ordered durable record. A sorted scan would order by content DIGEST, which is
 * lexicographic and carries no chronology at all — the bug the old preview selector's `.sort()`
 * was one step away from. `release-auto-decide.test.ts` pins that: one arm builds a world whose
 * digests sort differently from their install order, and one reopens a file-backed store.
 *
 * NOTHING HERE JUDGES. A declaration is a NONEMPTY `autoApprovalOptIns` array and nothing more:
 * no action is matched, no tier is read, ranked or compared. Filtering by the CALLER's action
 * would recreate two effective policies — the very defect — so a slice declaring only the other
 * gate's action still competes here, and the action match stays entirely `@moe/core`'s.
 *
 * IT WRITES NOTHING, THROWS NOTHING AND CACHES NOTHING. Every refusal is a returned `null`, and
 * the installed set is re-read on every call, so a policy installed between two calls is seen.
 */

/** The effective policy: the slice a gate composes against, and the ref its decision NAMES. */
export interface EffectiveAutoApprovalPolicy {
  readonly ref: string;
  readonly slice: JsonValue;
}

/**
 * The slice's standing declaration, or `null` when it does not carry a readable one.
 *
 * Only ever called on a candidate whose digest has already been re-derived and matched, and
 * `validSlice` requires `autoApprovalOptIns` to be an array — so `null` here is unreachable in
 * practice and is the fail-closed answer rather than an assumed empty list.
 */
function optInsOf(slice: JsonValue): readonly JsonValue[] | null {
  if (slice === null || typeof slice !== "object" || Array.isArray(slice)) return null;
  const optIns = (slice as Readonly<Record<string, JsonValue>>)["autoApprovalOptIns"];
  return Array.isArray(optIns) ? optIns : null;
}

/**
 * Whether this candidate's bytes may carry auto-approval AUTHORITY.
 *
 * `sliceKindOf` classifies on shape alone — a hex64 ref plus a `rules` array — and
 * `policy.install` deliberately stores non-evaluation policy artifacts too, enforcing the
 * content-address only when the bytes ARE an exact core slice. So a JSON blob that merely
 * RESEMBLES an evaluation slice can be installed at a hex64 ref, and treating one as a reset
 * would hand any writer a way to silently clear an operator's standing declarations. The digest
 * is therefore re-derived and required to equal the ref the slice is installed at.
 */
function authoritative(ref: string, slice: JsonValue): boolean {
  const digest = derivePolicySliceDigest(slice);
  return digest.ok && digest.digest === ref;
}

function selected(ref: string, slice: JsonValue): EffectiveAutoApprovalPolicy {
  return Object.freeze({ ref, slice });
}

/**
 * The installed set in INSTALL ORDER, or `null` when the durable ledger cannot be read.
 *
 * An unreadable store is a REFUSAL, never an older fallback: the alternative is deciding under
 * whatever partial history a failing read happened to return.
 */
function installedInOrder(
  store: SqliteEventStore, projectId: string,
): readonly (readonly [string, JsonValue])[] | null {
  try {
    return Object.entries(installedSlices(
      stateOf(readDurableLedger(store, projectId), policyAggregateId(projectId)),
    ));
  } catch {
    return null;
  }
}

/**
 * THE EFFECTIVE AUTO-APPROVAL POLICY for this project, or nothing. SELECTION, NOT JUDGEMENT.
 *
 * Scans the installed set from the NEWEST install backwards and stops at the most recent reset,
 * so no slice older than it is ever consulted:
 *
 * - a non-EVALUATION artifact is INERT — neither a reset nor a declaration — and is skipped;
 * - an evaluation-shaped candidate whose digest does not address its own ref refuses (`null`),
 *   because it must not be able to pose as a reset;
 * - the first valid EMPTY-opt-ins slice is the RESET BOUNDARY: with no declaration newer than it
 *   the reset itself is effective, with exactly one newer declaration that declaration is
 *   effective, and with two or more the answer is `null` — ambiguity refuses fail-closed;
 * - with no reset anywhere in the history the same 0/1/many rule applies to every declaration.
 */
export function selectEffectiveAutoApprovalPolicy(
  store: SqliteEventStore, projectId: string,
): EffectiveAutoApprovalPolicy | null {
  const entries = installedInOrder(store, projectId);
  if (entries === null) return null;
  let declared: EffectiveAutoApprovalPolicy | null = null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    const [ref, slice] = entry;
    if (slice === undefined || sliceKindOf(ref, slice) !== "EVALUATION") continue;
    if (!authoritative(ref, slice)) return null;
    const optIns = optInsOf(slice);
    if (optIns === null) return null;
    // THE RESET BOUNDARY. Nothing installed before it competes, so the scan ends here.
    if (optIns.length === 0) return declared ?? selected(ref, slice);
    // A SECOND declaration with no reset between them: ambiguous whichever way the history runs.
    if (declared !== null) return null;
    declared = selected(ref, slice);
  }
  return declared;
}
