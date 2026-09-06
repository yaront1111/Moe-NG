import { useEffect, useState } from "react";

import type { CoverageContractView, DocumentCoverageOutcome } from
  "../../live/live-document-coverage.js";
import type {
  ProductContractGate1Outcome, ProductContractRevisionRefInput,
} from "../../live/live-product-contract-gate-1.js";

/**
 * ONE DURABLE GATE 1 VERDICT PER CITED CONTRACT.
 *
 * The coverage read reports `gate1: "APPROVED" | "PENDING"` as a by-product of its join over
 * the ledger. That is a hint, not the gate: the AUTHORITY answer is what
 * /product-contract/gate-1/read derives from the stored human grant, re-checked against the
 * revision it was given for. So the dossier polls it directly for each revision triple,
 * and renders whatever comes back - including a refusal, with the code and layer its owner
 * stamped. A revision whose read has not answered yet is ABSENT from this map; the card says
 * it is still reading rather than showing a verdict nobody gave.
 */

export type ContractGateMap = ReadonlyMap<string, ProductContractGate1Outcome>;
export type Gate1Reader =
  (ref: ProductContractRevisionRefInput) => Promise<ProductContractGate1Outcome>;

/** The three admitted identity fields, in one stable key: a new revision is a new read. */
export function contractGateKey(contract: ProductContractRevisionRefInput): string {
  return JSON.stringify([contract.contractId, contract.revisionId, contract.revisionDigest]);
}

function citedContracts(
  coverage: DocumentCoverageOutcome | null,
): readonly CoverageContractView[] {
  return coverage !== null && coverage.status === "COVERAGE" ? coverage.contracts : [];
}

/**
 * Reads Gate 1 for every contract the coverage frame cites. A read that throws leaves that
 * contract absent rather than inventing an outcome; a read that refuses is kept VERBATIM,
 * because a refusal is the answer the operator has to see.
 */
export function useContractGates(
  coverage: DocumentCoverageOutcome | null,
  readGate: Gate1Reader | undefined,
  pollMs: number = 2_000,
): ContractGateMap {
  const [gates, setGates] = useState<ContractGateMap>(new Map());
  // The triples travel as JSON, never as a delimited string: a delimiter is a guess about
  // what an id cannot contain, and a wrong guess splits one contract into two reads.
  const refsJson = JSON.stringify(citedContracts(coverage).map((contract) => ({
    contractId: contract.contractId,
    revisionDigest: contract.revisionDigest,
    revisionId: contract.revisionId,
  })));
  useEffect(() => {
    const refs = JSON.parse(refsJson) as readonly ProductContractRevisionRefInput[];
    if (readGate === undefined || refs.length === 0) {
      setGates(new Map());
      return undefined;
    }
    let live = true;
    let inFlight = false;
    const tick = (): void => {
      if (inFlight) return;
      inFlight = true;
      void Promise.all(refs.map(async (ref) => {
        try {
          return [contractGateKey(ref), await readGate(ref)] as const;
        } catch {
          return null;
        }
      })).then((rows) => {
        inFlight = false;
        if (!live) return;
        setGates(new Map(rows.flatMap((row) => (row === null ? [] : [row]))));
      });
    };
    tick();
    const timer = setInterval(tick, pollMs);
    return (): void => { live = false; clearInterval(timer); };
  }, [readGate, refsJson, pollMs]);
  return gates;
}
