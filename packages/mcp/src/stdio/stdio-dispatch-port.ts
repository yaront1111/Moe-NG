import type { RuntimeError } from "@moe/contracts";

/**
 * Outcome of a credential check. A refusal carries the full stable `RuntimeError` so the
 * transport can route its registry-bound code, retryability, and recovery commands without
 * inventing any of them.
 */
export type StdioAuthOutcome =
  | { readonly error: RuntimeError; readonly ok: false }
  | { readonly ok: true };

/**
 * The injected boundary between this adapter and the daemon.
 *
 * CALL-SEQUENCE OBLIGATION, which `dispatch-conformance.ts` asserts executably:
 *   1. bounded decode of the assembled envelope bytes;
 *   2. `authenticate`, with the VERBATIM dotted runtime kind, never the transport label;
 *   3. `dispatchCommandBytes` or `dispatchQueryBytes`, exactly once, on the matching surface.
 * A decode refusal performs zero port calls. An authentication refusal short-circuits with
 * zero dispatch calls.
 *
 * Both directions are RAW BYTES on purpose. Parsing and re-stringifying JSON normalises
 * escape sequences, number formatting, and key order, which would corrupt digest-bound
 * fields and opaque cursors. Implementations must treat the bytes as opaque.
 */
export interface StdioDispatchPort {
  authenticate(credential: string, toolKind: string): StdioAuthOutcome;
  dispatchCommandBytes(bytes: Uint8Array): Uint8Array;
  dispatchQueryBytes(bytes: Uint8Array): Uint8Array;
}
