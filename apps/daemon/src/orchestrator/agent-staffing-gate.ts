import type {
  AgentLiveChildRecord,
  AgentSessionFence,
  AgentStaffingRefusal,
} from "./agent-session-fence.js";

/**
 * The wrapper's side of the durable staffing fence.
 *
 * Split out of agent-wrapper.ts because composing the fence pushed that file
 * past the 400-line split threshold. This is a boundary, not a trim: no refusal
 * branch was dropped to make room, which is the one thing the size rail must
 * never buy.
 *
 * It exists to keep the optionality of the port in ONE place. The wrapper asks
 * three plain questions — may I staff, remember this child, forget this child —
 * and an unwired fence answers "no opinion" uniformly instead of scattering
 * `?.` and `?? []` across the staffing path, where a missing one reads as
 * "admitted" and would silently reopen the defect.
 */

export interface StaffingGate {
  /** The refusal to report, or null when staffing may proceed. */
  admit(workItemId: string, nowMs: number): AgentStaffingRefusal | null;
  record(input: AgentLiveChildRecord): readonly Error[];
  retire(workItemId: string): readonly Error[];
}

export function createStaffingGate(fence: AgentSessionFence | undefined): StaffingGate {
  return Object.freeze({
    admit: (workItemId: string, nowMs: number): AgentStaffingRefusal | null => {
      if (fence === undefined) return null;
      const decision = fence.admit(workItemId, new Date(nowMs).toISOString());
      return decision.ok ? null : decision;
    },
    record: (input: AgentLiveChildRecord): readonly Error[] =>
      fence?.recordLiveChild(input) ?? [],
    retire: (workItemId: string): readonly Error[] =>
      fence?.retireLiveChild(workItemId) ?? [],
  });
}
