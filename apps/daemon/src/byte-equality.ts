/**
 * Byte equality for durable payloads: the comparison every codec, reader and reconciler makes
 * when it has to prove that two byte strings are the SAME evidence rather than merely similar.
 *
 * TWO FUNCTIONS, ON PURPOSE, AND THE DIFFERENCE IS THE GUARD. `sameBytes` trusts the declared
 * type: both arguments really are byte views, so the length check and the element walk are all
 * the answer needs. `sameBinaryBytes` does not trust it, because its callers compare payloads a
 * STORE handed back: a contract-breaking row whose payload is a string or a plain array reports
 * an `undefined` byteLength, two of those compare equal, and `.every` then throws where the
 * reader has to refuse. The `instanceof` pair turns that crash into a clean `false`.
 *
 * `length` AND `byteLength` NAME THE SAME NUMBER on a `Uint8Array` — one byte per element — so
 * the copies that spelled the guard either way were one function, and are one function here.
 * Both forms compare through the view, so a `subarray` of a larger buffer is compared as the
 * window it names and never as the bytes behind it.
 *
 * ONE IMPLEMENTATION, TWO DOORS, AND THE SECOND IS A RE-EXPORT. `work/foundation-attempt-codec.ts`
 * declared this same function — same signature, same length check, same element walk, only the
 * comparator's operands swapped — and is the specifier activation/, evidence/, journal/ and work/
 * already import it by. Rather than leave two live copies, that module now re-exports `sameBytes`
 * from here (and `work/foundation-attempt-contracts.ts` re-exports it onward), so both specifiers
 * resolve to this body and neither can drift from the other.
 *
 * `documents/document-work-safe-value.ts` keeps its own loop-form `sameBytes` on purpose: that
 * module reads hostile, store-supplied values without touching prototype methods, so its index
 * loop is a different body serving a different threat model, not a stray copy of this one.
 */

/** Byte-for-byte equality of two byte views. Callers must hold real `Uint8Array`s. */
export function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

/**
 * Byte-for-byte equality that first proves both sides ARE byte views. Anything else — a string,
 * a plain array, null, undefined — answers `false` instead of throwing or comparing lengths that
 * are both `undefined`.
 */
export function sameBinaryBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left instanceof Uint8Array && right instanceof Uint8Array && sameBytes(left, right);
}
