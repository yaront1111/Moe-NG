import { createContext, useContext } from "react";
import type { JSX, ReactNode } from "react";

/**
 * The wiring that lets any truth chip anywhere under the shell open the proof
 * inspector on its own receipt. A chip does not know where the drawer lives; it
 * hands a payload to `openProof` and the shell decides how to surface it.
 *
 * Fail-safe: a chip rendered with no provider (a unit test, a stray mount) gets a
 * no-op opener rather than a crash, so a chip is always safe to render.
 */

/** One row of the receipt table the inspector renders under a claim. */
export interface ProofRow {
  readonly k: string;
  readonly v: string;
}

/**
 * What a truth chip hands the inspector. The value and its class are the claim;
 * the rows are the receipt behind it, the note is the one sentence of context.
 * Nothing here is invented by the shell - a caller supplies exactly what the
 * daemon (or, in fixtures, the frozen literal) stated.
 */
export interface ProofPayload {
  readonly factId: string;
  readonly label: string;
  readonly value: string;
  readonly truthClass?: unknown;
  readonly note?: string | undefined;
  readonly rows?: readonly ProofRow[] | undefined;
}

export interface ProofController {
  /** Open the inspector on a claim, or `null` to open it on its empty state. */
  readonly openProof: (payload: ProofPayload | null) => void;
}

const NO_OP: ProofController = Object.freeze({ openProof: () => undefined });

const ProofContext = createContext<ProofController>(NO_OP);

export function ProofProvider(props: {
  readonly children: ReactNode;
  readonly controller: ProofController;
}): JSX.Element {
  return (
    <ProofContext.Provider value={props.controller}>
      {props.children}
    </ProofContext.Provider>
  );
}

/** The opener a chip calls; the no-op controller when no shell is mounted above. */
export function useProof(): ProofController {
  return useContext(ProofContext);
}
