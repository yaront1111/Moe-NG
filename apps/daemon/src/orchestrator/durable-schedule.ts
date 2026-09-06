import { randomUUID } from "node:crypto";
import type { SqliteEventStore } from "@moe/store";
export const DEFAULT_SCHEDULE_INTERVAL_MS = 60_000;
export type ScheduleCallback = (signal: AbortSignal) => void | Promise<void>;
export interface ScheduleTimer {
  set(tick: () => void, intervalMs: number): unknown;
  clear(handle: unknown): void;
}
export interface ScheduleConfig {
  readonly store: Pick<SqliteEventStore, "commit" | "readEvents">;
  readonly projectId: string;
  readonly now?: () => number;
  readonly timer?: ScheduleTimer;
  readonly resolve?: (id: string) => ScheduleCallback | null;
}
type ScheduleCode = "SCHEDULE_INPUT_INVALID" | "SCHEDULE_RELEASED" | "SCHEDULE_CALLBACK_FAILED"
  | "SCHEDULE_TARGET_UNRESOLVED" | "SCHEDULE_RECORD_INVALID" | "SCHEDULE_TIMER_FAILED"
  | "SCHEDULE_STORE_FAILED";
export interface ScheduleRefusal {
  readonly ok: false;
  readonly id: string | null;
  readonly code: ScheduleCode;
  readonly layer: "DAEMON_INGRESS";
}
type ScheduleResult = { readonly ok: true } | ScheduleRefusal;
const OK = Object.freeze({ ok: true } as const);
const nodeTimer: ScheduleTimer = {
  set: (tick, interval) => setInterval(tick, interval),
  clear: (handle) => clearInterval(handle as NodeJS.Timeout),
};
const validInterval = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 2_147_483_647;
const validId = (value: unknown): value is string => typeof value === "string" && /^[\w./:-]{1,200}$/.test(value);
const EVENT = "moe.durable-schedule.registered";

/** One process owns these timers. This is not a distributed lease or an exactly-once effect runner.
 * release clears timers and aborts running callbacks; the consumer owns its effect's teardown.
 * Re-registration at the same interval retains the callback and phase. No unref substitutes for release.
 */
export class DurableSchedule {
  private readonly arms = new Map<string, { handle: unknown; intervalMs: number; callback: ScheduleCallback }>();
  private readonly running = new Map<string, AbortController>();
  private readonly notices = new Map<string | null, ScheduleRefusal>();
  private readonly timer: ScheduleTimer;
  private released = false;
  private version = 0;
  private readonly aggregateId: string;
  private readonly config: ScheduleConfig;
  constructor(config: ScheduleConfig) {
    this.config = config;
    this.timer = config.timer ?? nodeTimer;
    this.aggregateId = `durable-schedule/${config.projectId}`;
    this.rebuild(config.resolve ?? (() => null));
  }

  private refuse(id: string | null, code: ScheduleCode): ScheduleRefusal {
    // Never retain callback exceptions, output, credentials or consumer payloads.
    const result = Object.freeze({ ok: false, id, code, layer: "DAEMON_INGRESS" } as const);
    this.notices.set(id, result);
    return result;
  }
  refusals(): readonly ScheduleRefusal[] { return Object.freeze([...this.notices.values()]); }

  private async tick(id: string): Promise<void> {
    const arm = this.arms.get(id);
    if (this.released || arm === undefined || this.running.has(id)) return;
    const controller = new AbortController();
    this.running.set(id, controller);
    try { await arm.callback(controller.signal); }
    catch { this.refuse(id, "SCHEDULE_CALLBACK_FAILED"); }
    finally { this.running.delete(id); }
  }

  private arm(id: string, callback: ScheduleCallback, intervalMs: number): ScheduleResult {
    if (this.released) return this.refuse(id, "SCHEDULE_RELEASED");
    const old = this.arms.get(id);
    if (old?.intervalMs === intervalMs) return OK;
    if (old !== undefined) { this.timer.clear(old.handle); this.arms.delete(id); }
    try {
      const handle = this.timer.set(() => { void this.tick(id); }, intervalMs);
      if (this.released) { this.timer.clear(handle); return this.refuse(id, "SCHEDULE_RELEASED"); }
      this.arms.set(id, { handle, intervalMs, callback });
      this.notices.delete(id);
      return OK;
    } catch { return this.refuse(id, "SCHEDULE_TIMER_FAILED"); }
  }

  register(id: string, callback: ScheduleCallback, intervalMs = DEFAULT_SCHEDULE_INTERVAL_MS): ScheduleResult {
    if (this.released) return this.refuse(id, "SCHEDULE_RELEASED");
    if (!validId(id)
      || typeof callback !== "function" || !validInterval(intervalMs)) return this.refuse(null, "SCHEDULE_INPUT_INVALID");
    try {
      if (this.read().get(id) !== intervalMs) this.persist(id, intervalMs);
    } catch { return this.refuse(id, "SCHEDULE_STORE_FAILED"); }
    return this.arm(id, callback, intervalMs);
  }

  private read(): Map<string, number> {
    const events = this.config.store.readEvents(this.aggregateId);
    this.version = events.at(-1)?.aggregateSequence ?? 0;
    const current = new Map<string, number>();
    for (const event of events) {
      let record: unknown;
      try { record = JSON.parse(new TextDecoder().decode(event.payload)); } catch { record = null; }
      const value = record !== null && typeof record === "object" && !Array.isArray(record)
        ? record as Record<string, unknown> : {};
      const id = value["id"];
      if (!validId(id)) {
        // Without an identity even a prior valid arm is unverifiable. Fail closed for the set.
        current.clear(); this.refuse(null, "SCHEDULE_RECORD_INVALID");
      } else if (event.eventType !== EVENT || !validInterval(value["intervalMs"])) {
        current.delete(id); this.refuse(id, "SCHEDULE_RECORD_INVALID");
      } else { current.set(id, value["intervalMs"]); }
    }
    return current;
  }

  private persist(id: string, intervalMs: number): void {
    const payload = new TextEncoder().encode(JSON.stringify({ id, intervalMs }));
    this.config.store.commit({
      aggregateId: this.aggregateId, commandId: randomUUID(), commandBytes: payload,
      committedAt: new Date((this.config.now ?? Date.now)()).toISOString(),
      // This version belongs to the SAME snapshot read above, not a fresh version over stale state.
      expectedVersion: this.version,
      events: [{ eventId: randomUUID(), eventType: EVENT, payload }],
    });
  }

  /** Rebind from durable IDs. Unresolved jobs remain durable but are not live timers; a consumer
   * may supply its resolver later. Repeated rebuild does not re-phase already resolved jobs. */
  rebuild(resolve: (id: string) => ScheduleCallback | null): readonly ScheduleRefusal[] {
    if (this.released) { this.refuse(null, "SCHEDULE_RELEASED"); return this.refusals(); }
    let current: Map<string, number>;
    try { current = this.read(); }
    catch { current = new Map(); this.refuse(null, "SCHEDULE_STORE_FAILED"); }
    for (const id of this.arms.keys()) if (!current.has(id)) this.drop(id);
    for (const [id, intervalMs] of current) {
      let callback: ScheduleCallback | null;
      try { callback = resolve(id); } catch { callback = null; }
      if (typeof callback !== "function") {
        this.drop(id); this.refuse(id, "SCHEDULE_TARGET_UNRESOLVED");
      } else { this.arm(id, callback, intervalMs); }
    }
    return this.refusals();
  }

  private drop(id: string): void {
    const arm = this.arms.get(id);
    if (arm !== undefined) this.timer.clear(arm.handle);
    this.arms.delete(id);
    this.running.get(id)?.abort();
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    for (const arm of this.arms.values()) this.timer.clear(arm.handle);
    this.arms.clear();
    for (const controller of this.running.values()) controller.abort();
  }
}

export function createDurableSchedule(config: ScheduleConfig): DurableSchedule { return new DurableSchedule(config); }
