import { useCallback, useEffect, useRef, useState } from "react";
import type { RunsOutcome } from "../../live/live-runs.js";
import type { EscalationPort } from "./escalation-port.js";
import type { NeedsYouItem } from "./needs-you-model.js";
import { resultKeyOf } from "./needs-you.js";
import type { OfferOutcome } from "./offer-wire.js";
import type { PreparedReplanSuccessor, ReplanSuccessorPort } from "./replan-successor-port.js";

export interface PendingReplanSuccessor {
  readonly key: string;
  readonly item: NeedsYouItem;
  readonly prepared: PreparedReplanSuccessor;
  readonly busy: boolean;
  readonly outcome: OfferOutcome | null;
  readonly committed: boolean;
}
const failed = (code: string): OfferOutcome => ({ code, layer: "CONTROL_ROOM_REPLAN", ok: false });

/** Restored requests are visible proposals; only an explicit click can resume them. */
export function useReplanSuccessor(port: ReplanSuccessorPort, escalation: EscalationPort): {
  readonly pending: readonly PendingReplanSuccessor[];
  readonly journalError: string | null;
  readonly start: (item: NeedsYouItem, runs: RunsOutcome | null) => Promise<OfferOutcome>;
} {
  const [restored] = useState(() => port.restore?.() ?? { records: [], error: null });
  const records = useRef(new Map<string, PendingReplanSuccessor>(restored.records.map((row) => {
    const key = resultKeyOf(row.item);
    return [key, { ...row, key, busy: false, committed: false, outcome: null }];
  })));
  const active = useRef(new Map<string, Promise<OfferOutcome>>());
  const mounted = useRef(true);
  const [pending, setPending] = useState<readonly PendingReplanSuccessor[]>(() => [...records.current.values()]);
  useEffect(() => { mounted.current = true; return (): void => { mounted.current = false; }; }, []);
  const publish = useCallback(() => { if (mounted.current) setPending([...records.current.values()]); }, []);
  const create = useCallback(async (record: PendingReplanSuccessor): Promise<OfferOutcome> => {
    records.current.set(record.key, { ...record, busy: true, outcome: null });
    publish();
    let outcome: OfferOutcome;
    let committed = record.committed;
    try {
      if (port.resume !== undefined) {
        const progress = await port.resume(record.prepared);
        outcome = progress.outcome; committed = progress.committed;
      } else {
        if (!committed) {
          const offer = record.item.escalation!;
          const decided = await escalation.submit(offer.affordance, offer.nodeKey, "REPLAN");
          if (!decided.ok) {
            records.current.set(record.key, { ...record, busy: false, outcome: decided }); publish(); return decided;
          }
          committed = true;
        }
        outcome = await port.createPrepared(record.prepared);
      }
    } catch { outcome = failed("REPLAN_COMMAND_OUTCOME_UNCERTAIN"); }
    if (outcome.ok) records.current.delete(record.key);
    else records.current.set(record.key, { ...record, committed, busy: false, outcome });
    publish();
    return outcome;
  }, [escalation, port, publish]);

  const start = useCallback((item: NeedsYouItem, runs: RunsOutcome | null): Promise<OfferOutcome> => {
    const key = resultKeyOf(item);
    const existing = active.current.get(key);
    if (existing !== undefined) return existing;
    const operation = Promise.resolve().then(async (): Promise<OfferOutcome> => {
      const saved = records.current.get(key);
      if (saved !== undefined) return create(saved);
      if (item.escalation === undefined) return failed("REPLAN_CONTEXT_UNAVAILABLE");
      const preparation = await port.prepare(item, runs);
      if (!preparation.ok) return preparation;
      if (!mounted.current) return failed("REPLAN_CANCELLED_BEFORE_DECISION");
      const remembered = port.remember?.(preparation.prepared);
      if (remembered !== undefined && !remembered.ok) return remembered;
      // Retain the proposal BEFORE sending REPLAN: losing its reply cannot erase recovery.
      return create({ key, item, prepared: preparation.prepared, committed: false, busy: true, outcome: null });
    }).catch(() => failed("REPLAN_PREPARATION_OR_DECISION_FAILED"));
    active.current.set(key, operation);
    void operation.then(() => { active.current.delete(key); });
    return operation;
  }, [create, escalation, port]);
  return { pending, start, journalError: restored.error };
}
