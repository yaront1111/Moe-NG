import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The DEVELOPMENT payload-hint table, loaded leniently for the wrapper's missions: a table
 * that cannot be had just means missions carry no hint, and the daemon's decoder stays the
 * sole payload authority either way. What CANNOT happen is a silent null: one cost a live run
 * 2026-08-20, when live-dispatch.ts grew a `.js`-suffixed import with no bridge file, every
 * mission shipped hintless, and agents guessed payload shapes at steps whose exact input the
 * hint already knew.
 *
 * Three outcomes, each said by name, because they are different facts:
 *  - ABSENT: the module file is not there. That is the installed artifact's DESIGNED state,
 *    not a fault: the pack stages the daemon's `pnpm deploy` output and the built control-room
 *    bundle (tools/packaging/pack-windows.ts), never `apps/control-room/src`, so the wrapper's
 *    `../../../control-room/src/live/live-dispatch.ts` resolves to a path that exists only in
 *    a repository checkout. Before this module every artifact wrapper.log opened with
 *    `[wrapper] payload hints unavailable: Error [ERR_MODULE_NOT_FOUND]: ...`, a designed
 *    absence reported as a load failure. Decided by an existence check BEFORE any import, so
 *    no module-not-found error is minted for a file nobody expected to be there.
 *  - UNAVAILABLE: the file is present and does not load, or loads without a `payloadFor`
 *    function. That is the 2026-08-20 shape, and it is disclosed with the loader's own error.
 *  - LOADED: `payloadFor` is returned as the table.
 */
export interface PayloadHintTable {
  readonly payloadFor: (kind: string, target: string | null) => object | null;
}

export interface PayloadHintLoad {
  /** Injectable for tests; production imports the URL's href. */
  readonly importModule?: ((href: string) => Promise<unknown>) | undefined;
  readonly log: (line: string) => void;
  /** The table's module; the binary names the control room's dev table by URL. */
  readonly moduleUrl: URL;
}

export const PAYLOAD_HINTS_ABSENT = "[wrapper] payload hints absent:";
export const PAYLOAD_HINTS_UNAVAILABLE = "[wrapper] payload hints unavailable:";

export async function loadPayloadHints(input: PayloadHintLoad): Promise<PayloadHintTable | null> {
  const path = fileURLToPath(input.moduleUrl);
  if (!existsSync(path)) {
    input.log(`${PAYLOAD_HINTS_ABSENT} ${path} is not present (a development table the `
      + "installed artifact does not stage); missions carry no hint");
    return null;
  }
  const importModule = input.importModule ?? ((href: string) => import(href));
  let loaded: unknown;
  try {
    loaded = await importModule(input.moduleUrl.href);
  } catch (error: unknown) {
    input.log(`${PAYLOAD_HINTS_UNAVAILABLE} ${String(error)}`);
    return null;
  }
  const payloadFor = typeof loaded === "object" && loaded !== null
    ? (loaded as { payloadFor?: unknown }).payloadFor : undefined;
  if (typeof payloadFor !== "function") {
    input.log(`${PAYLOAD_HINTS_UNAVAILABLE} ${path} exports no payloadFor function`);
    return null;
  }
  return Object.freeze({ payloadFor: payloadFor as PayloadHintTable["payloadFor"] });
}
