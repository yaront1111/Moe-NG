/**
 * The closed refusal vocabulary for the PRE-FREEZE AUDIT, and nothing else.
 *
 * WHAT THE AUDIT IS. The pinned benchmark spec requires, at Section 12.1, an automated
 * namespace-and-reference audit that must pass before a campaign is frozen: "a failing
 * audit blocks freeze; it is not a judgment call". This package's audit implements that
 * section over the pinned bytes and publishes the refusals below. It reads documents; it
 * creates no corpus, no freeze manifest, no campaign result, no score and no claim.
 *
 * WHY EVERY CODE NAMES A DIFFERENT REPAIR. A freeze-blocking audit is only useful if the
 * person it blocks can tell what to fix. Twelve codes, twelve edits:
 *   SPEC_BYTES_UNPINNED ....... the bytes handed in are not the pinned document; re-fetch
 *                               them. This fires BEFORE any parse, so no downstream code
 *                               is a judgment about unpinned bytes.
 *   SPEC_UNPARSEABLE .......... the pinned document lacks a structure the audit must read
 *                               (a ladder table, an inventory block, a gate-results block).
 *   REFERENCE_UNRESOLVED ...... a scenario/invariant/gate/section pointer names no member.
 *   REFERENCE_DUPLICATE ....... one ID is defined twice, so a pointer is not single-valued.
 *   REFERENCE_AMBIGUOUS ....... a bare `S{n}` / `I{n}` token: the same bare number means a
 *                               different thing in the CORE and BENCH namespaces, which is
 *                               exactly what spec 0.1 forbids "anywhere".
 *   TOKEN_SET_MISMATCH ........ definition and use of a token family are not equal sets.
 *   GATE_INVENTORY_MISMATCH ... the Section 1 ladder and the Section 12 inventory do not
 *                               list the identical gate set for some rung.
 *   TRIVALENT_INCOMPLETE ...... PASS/FAIL/UNKNOWN handling is not exhaustive, or its
 *                               FAIL-dominates precedence is missing.
 *   CONSTANT_UNRESOLVED ....... a load-bearing threshold is not a Frozen Constants Table
 *                               symbol, or resolves to the wrong one.
 *   COMPARATOR_INDEX_MISSING .. a comparator-indexed gate has no verdict for some cohort
 *                               member, or the cohort is empty.
 *   CI_TAIL_DIRECTION_WRONG ... a non-inferiority gate bounds the tail that cannot detect
 *                               its endpoint getting worse.
 *   SWEEP_ZERO_CASES .......... a check generated no cases. Reported as a REFUSAL rather
 *                               than passed over, because a sweep that silently produced
 *                               nothing is indistinguishable from one that found nothing
 *                               wrong, and the second is the answer a freeze gate wants.
 *
 * FROZEN ARRAY, NOT A UNION TYPE. A test cannot iterate a type. The audit's own tests
 * need every member at runtime to prove a case was generated for each.
 *
 * THE LAYER IS NOT COSMETIC. `PRE_FREEZE_AUDIT` records WHICH authority refused. More
 * than one layer can refuse a freeze — the confirmatory freeze-authority reader refuses
 * at `CONFIRMATORY_FREEZE_AUTHORITY`, and downstream manifest admission will refuse at
 * its own layer. A caller that saw only "blocked" could not tell which question was
 * answered, and would fix the wrong thing.
 */

/** The one layer this audit may ever be observed as. Never re-labelled by a consumer. */
export const PRE_FREEZE_AUDIT_LAYER = "PRE_FREEZE_AUDIT";

/** The closed set. Sorted by the order the audit runs its checks, not alphabetically. */
export const PRE_FREEZE_AUDIT_CODES = Object.freeze([
  "SPEC_BYTES_UNPINNED",
  "SPEC_UNPARSEABLE",
  "REFERENCE_UNRESOLVED",
  "REFERENCE_DUPLICATE",
  "REFERENCE_AMBIGUOUS",
  "TOKEN_SET_MISMATCH",
  "GATE_INVENTORY_MISMATCH",
  "TRIVALENT_INCOMPLETE",
  "CONSTANT_UNRESOLVED",
  "COMPARATOR_INDEX_MISSING",
  "CI_TAIL_DIRECTION_WRONG",
  "SWEEP_ZERO_CASES",
] as const);

export type PreFreezeAuditCode = (typeof PRE_FREEZE_AUDIT_CODES)[number];

/**
 * A refusal, and only a refusal — `ok` is the literal `false`, so no widening can smuggle
 * an audit PASS through this shape.
 *
 * IT CARRIES AN EXACT SOURCE LOCATION because a freeze-blocking audit that says only
 * "something is wrong" hands its reader the whole 523-line document to re-derive. `line`
 * is 1-based within the document as read; `token` is the offending text verbatim. A
 * whole-document condition (unpinned bytes, a zero-case sweep) reports line 0 and an
 * empty token rather than inventing a position it did not observe.
 */
export type PreFreezeAuditRefusal = {
  readonly code: PreFreezeAuditCode;
  readonly layer: typeof PRE_FREEZE_AUDIT_LAYER;
  readonly line: number;
  readonly ok: false;
  readonly token: string;
};

/**
 * Mints one refusal. A fresh frozen object per call rather than a shared constant handed
 * out repeatedly, so a caller that edits the refusal it received throws instead of
 * silently poisoning the next caller's copy.
 */
export const preFreezeAuditRefusal = (
  code: PreFreezeAuditCode,
  line: number,
  token: string,
): PreFreezeAuditRefusal =>
  Object.freeze({ code, layer: PRE_FREEZE_AUDIT_LAYER, line, ok: false, token } as const);

/** Every audit answers with a verdict plus the refusals it observed, never a bare boolean. */
export type PreFreezeAuditVerdict = {
  readonly generatedCases: number;
  readonly ok: boolean;
  readonly refusals: readonly PreFreezeAuditRefusal[];
};

/**
 * Seals a verdict. A check that generated no cases is refused with SWEEP_ZERO_CASES and
 * can never report `ok`, which is the whole defence against a vacuous green audit.
 */
export const preFreezeAuditVerdict = (
  generatedCases: number,
  refusals: readonly PreFreezeAuditRefusal[],
): PreFreezeAuditVerdict => {
  const sealed = generatedCases > 0
    ? refusals
    : [...refusals, preFreezeAuditRefusal("SWEEP_ZERO_CASES", 0, "")];
  return Object.freeze({
    generatedCases,
    ok: sealed.length === 0,
    refusals: Object.freeze([...sealed]),
  });
};
