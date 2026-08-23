/**
 * WHO MAY FREEZE AND SEAL THE CONFIRMATORY BENCHMARK CORPUS: NOBODY, YET.
 *
 * This module is the durable record of a decision that was MADE, not of a feature that
 * was forgotten. Measured on committed bytes before it was written: no independent
 * corpus author, no custodian, no signing key, no trusted-key distribution, and no
 * public campaign registry exists anywhere in this repository. The one nearby surface —
 * the Phase-0 freeze verifier in `packages/testkit` — declares itself non-authoritative
 * in its own plan and carries CLAIMED actor bytes only. A claimed actor is not a
 * custodian, so nothing on disk could have been promoted into this role.
 *
 * Under governor ruling `comment-b308bf89a6d24978a928eadc5bade7b1` no custodian, signer,
 * key, delegated signing, or corpus creation is authorized. The ruling withholds an
 * authority; it does not grant one. So the only honest thing this reader can return is
 * the refusal below, and it returns it unconditionally.
 *
 * WHY UNCONDITIONAL, AND WHY THAT WORD IS LOAD-BEARING. This module takes no parameter,
 * reads no environment variable, opens no file, imports nothing, and consults no config
 * key or fixture. If any input could flip it, it would be a DISABLED authority check
 * rather than an ABSENT authority — and a disabled check is worse than the gap it
 * replaces, because a caller could satisfy it by supplying its own answer and would then
 * hold an entitlement nobody granted. There is no success arm anywhere in this file, and
 * the refusal type has no variant that could carry one.
 *
 * WHY THE CODE AND THE LAYER ARE NOT COSMETIC. `CONFIRMATORY_FREEZE_AUTHORITY_UNASSIGNED`
 * at `CONFIRMATORY_FREEZE_AUTHORITY` is the evidence a later reader has that this
 * question was asked and answered in the negative. Relabelling it, collapsing it into a
 * generic failure, or letting a broader catch swallow it would erase the decision while
 * leaving the behaviour intact. Downstream freeze-manifest admission must PRESERVE this
 * code and this layer rather than re-wrap them, so the refusal keeps naming its origin.
 *
 * WHAT WOULD SUPERSEDE THIS, stated here rather than only in a plan, because this is
 * where whoever lands real authority will be standing. Two things must both be true, and
 * neither may be inferred:
 *   1. An explicit, human-approved, source-controlled authority record exists naming the
 *      independent corpus author and custodian, the allowed viewers, the restricted
 *      artifact boundary, their separation from Moe implementers, one canonical signature
 *      algorithm and encoding, the signer key id with trusted public-key distribution and
 *      rotation semantics, the exact canonical bytes covered, the timestamp and public
 *      registry semantics, and the redaction rules.
 *   2. A strict reader replaces this one and refuses — still with a stable code and layer
 *      — whenever that record is missing, malformed, ambiguous, or conflicting.
 * Until both hold, no placeholder path, key id, signer name, registry endpoint, or
 * unsigned fallback belongs in this file. A placeholder is an invented authority wearing
 * a name that looks temporary.
 */

/** The one code this decision may ever be observed as. */
export const CONFIRMATORY_FREEZE_AUTHORITY_CODE = "CONFIRMATORY_FREEZE_AUTHORITY_UNASSIGNED";

/** The layer that answered. Downstream admission preserves it instead of re-labelling. */
export const CONFIRMATORY_FREEZE_AUTHORITY_LAYER = "CONFIRMATORY_FREEZE_AUTHORITY";

/**
 * A refusal, and only a refusal. There is deliberately no union with a granted variant:
 * a type that could describe an assigned authority is one edit away from a reader that
 * returns one, and `ok` is typed to the literal `false` so no widening can smuggle a
 * grant through this shape.
 *
 * It carries no custodian, signer, key id, registry entry, seal, manifest digest, or
 * corpus byte — nothing a consumer could read an entitlement out of. Every member is a
 * primitive literal, so there is no nested container for one to hide in either.
 */
export type ConfirmatoryFreezeAuthorityRefusal = {
  readonly authority: "NONE";
  readonly code: typeof CONFIRMATORY_FREEZE_AUTHORITY_CODE;
  readonly layer: typeof CONFIRMATORY_FREEZE_AUTHORITY_LAYER;
  readonly ok: false;
};

/**
 * Reads the confirmatory benchmark freeze authority. Always refuses, under governor
 * ruling `comment-b308bf89a6d24978a928eadc5bade7b1`; only the explicit human-approved
 * durable authority record plus strict reader described above may supersede it.
 *
 * Zero parameters by construction: there is no input that could change the answer, so
 * there is no input to take. A fresh frozen object is allocated per call rather than one
 * shared constant handed out repeatedly, so a caller that tries to edit the refusal it
 * received throws instead of silently poisoning the next caller's copy.
 */
export const readConfirmatoryFreezeAuthority = (): ConfirmatoryFreezeAuthorityRefusal =>
  Object.freeze({
    authority: "NONE",
    code: CONFIRMATORY_FREEZE_AUTHORITY_CODE,
    layer: CONFIRMATORY_FREEZE_AUTHORITY_LAYER,
    ok: false,
  } as const);
