import type { SpawnReport } from "./agent-spawn-contract.js";
import { REPOSITORY_DELIVERY_LAYER } from "./repository-delivery-contracts.js";

export interface RepositoryAdmissionWait {
  readonly code: string;
  readonly retryAt: number;
  readonly workItemId: string;
}
interface Pending extends RepositoryAdmissionWait {
  readonly delayMs: number;
  readonly observedAt: number;
  readonly version: number | null;
}

/** Advisory pacing only. Every retry still passes the durable repository and staffing gates. */
export function createRepositoryAdmissionBackoff() {
  const pending = new Map<string, Pending>();
  return {
    retain(ready: ReadonlySet<string>): void {
      for (const key of pending.keys()) if (!ready.has(key)) pending.delete(key);
    },
    waiting(workItemId: string, version: number | null, now: number): RepositoryAdmissionWait | null {
      const entry = pending.get(workItemId);
      if (entry === undefined) return null;
      if (entry.version !== version || now < entry.observedAt) { pending.delete(workItemId); return null; }
      pending.set(workItemId, { ...entry, observedAt: now });
      return now < entry.retryAt ? { code: entry.code, retryAt: entry.retryAt, workItemId } : null;
    },
    record(report: SpawnReport, version: number | null, now: number): void {
      const { workItemId, refusal } = report;
      if (refusal?.layer !== REPOSITORY_DELIVERY_LAYER) { pending.delete(workItemId); return; }
      const prior = pending.get(workItemId);
      const delayMs = prior?.code === refusal.code && prior.version === version
        ? Math.min(prior.delayMs * 2, 60_000) : 15_000;
      pending.set(workItemId, { code: refusal.code, delayMs, observedAt: now, retryAt: now + delayMs, version, workItemId });
    },
  };
}
