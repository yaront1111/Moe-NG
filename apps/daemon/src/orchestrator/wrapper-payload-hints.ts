/**
 * DEVELOPMENT payload suggestions from the control room's dev table, loaded leniently: a
 * missing module just means missions carry no hint. The failure is DISCLOSED, never swallowed —
 * a silent null here cost a live run 2026-08-20: live-dispatch.ts grew a `.js`-suffixed import
 * with no bridge file, every mission shipped hintless, and agents guessed payload shapes at
 * steps whose exact input the hint already knew.
 *
 * Split out of agent-wrapper-main.ts, which stood at 397 lines against the split-before-400
 * rail when the loop's pass containment landed. This file sits in the binary's own directory,
 * so the module URL below resolves exactly as it did from there.
 */
export type PayloadHintModule =
  { readonly payloadFor?: (kind: string, target: string | null) => object | null } | null;

export async function loadPayloadHints(log: (line: string) => void): Promise<PayloadHintModule> {
  return await import(
    new URL("../../../control-room/src/live/live-dispatch.ts", import.meta.url).href
  ).catch((error: unknown) => {
    log(`[wrapper] payload hints unavailable: ${String(error)}`);
    return null;
  }) as PayloadHintModule;
}
