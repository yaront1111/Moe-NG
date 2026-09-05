import type { AgentAuthorityCleanup } from "./agent-authority-cleanup.js";
import type { AgentSessionFence, AgentStaffingRefusal } from "./agent-session-fence.js";
import { createStaffingGate } from "./agent-staffing-gate.js";
import type { StaffingGate } from "./agent-staffing-gate.js";
import { AgentProcessFailureError } from "./agent-spawn-contract.js";
import type {
  AgentSpawnStart,
  AgentSpawnStartResult,
  SeatExitReading,
  SeatExitReport,
  SpawnReport,
} from "./agent-spawn-contract.js";
import type { SpawnRequest } from "./agent-wrapper.js";

export interface AgentWrapperStaffingStart {
  readonly claimAggregateVersion: number;
  readonly cleanupAuthority: AgentAuthorityCleanup;
  readonly kind: string;
  /**
   * Reads this seat's exit for attempt reporting and provider pause bookkeeping.
   * Observer failures remain fatal even when the child failure was contained.
   */
  readonly onExit?: ((report: SeatExitReport) => SeatExitReading) | undefined;
  readonly request: SpawnRequest;
  readonly sessionId: string;
  readonly spawnAgent: AgentSpawnStart;
  readonly workItemId: string;
}

export interface AgentWrapperStaffing {
  readonly activeCount: () => number;
  readonly admit: (workItemId: string, nowMs: number) => AgentStaffingRefusal | null;
  readonly failureOutcome: () => string | null;
  readonly has: (workItemId: string) => boolean;
  readonly recordFailures: (...failures: readonly Error[]) => void;
  readonly settle: () => Promise<void>;
  readonly start: (input: AgentWrapperStaffingStart) => Promise<SpawnReport>;
}

function uncoded(input: AgentWrapperStaffingStart, outcome: string): SpawnReport {
  return {
    kind: input.kind,
    outcome,
    refusal: null,
    sessionId: input.sessionId,
    workItemId: input.workItemId,
  };
}

function processFailure(error: unknown): Error {
  return error instanceof Error ? error : new Error("AGENT_PROCESS_FAILED:UNKNOWN");
}

/** What one exit left behind, for a lifetime that settled without a report. */
const CLEAN_EXIT: SeatExitReport = { exitCode: 0, signal: null, tail: [] };

function factsOf(error: unknown): SeatExitReport {
  return error instanceof AgentProcessFailureError
    ? { exitCode: error.exitCode, signal: error.signal, tail: error.tail }
    : { exitCode: null, signal: null, tail: [] };
}

class AgentWrapperStaffingState implements AgentWrapperStaffing {
  private readonly active = new Map<string, Promise<void>>();
  private readonly cleanupFailures: Error[] = [];
  private readonly gate: StaffingGate;

  constructor(fence: AgentSessionFence | undefined) {
    this.gate = createStaffingGate(fence);
  }

  readonly activeCount = (): number => this.active.size;

  readonly admit = (workItemId: string, nowMs: number): AgentStaffingRefusal | null =>
    this.gate.admit(workItemId, nowMs);

  readonly has = (workItemId: string): boolean => this.active.has(workItemId);

  readonly recordFailures = (...failures: readonly Error[]): void => {
    this.cleanupFailures.push(...failures);
  };

  private orderedFailures(): Error[] {
    return [...this.cleanupFailures].sort((a, b) =>
      a.message < b.message ? -1 : a.message > b.message ? 1 : 0);
  }

  readonly failureOutcome = (): string | null => {
    const ordered = this.orderedFailures();
    return ordered.length === 0 ? null : ordered.map((error) => error.message).join("|");
  };

  /**
   * Reports the attempt before cleaning authority, retiring the durable row and
   * releasing the slot once on both paths. Failure to observe remains a wrapper fault.
   */
  private observe(
    input: AgentWrapperStaffingStart, facts: SeatExitReport,
  ): { readonly failures: readonly Error[]; readonly reading: SeatExitReading } {
    try {
      return { failures: [], reading: input.onExit?.(facts) ?? "FAILED" };
    } catch {
      // An observer that cannot read an exit must not change how the exit is handled.
      return {
        failures: [new Error("AGENT_EXIT_OBSERVER_FAILED:UNEXPECTED_ERROR")],
        reading: "FAILED",
      };
    }
  }

  private trackLifetime(
    input: AgentWrapperStaffingStart,
    exit: Promise<SeatExitReport | void>,
    retire: () => readonly Error[],
  ): void {
    const tracked = exit.then(
      (report) => {
        const { failures } = this.observe(input, report ?? CLEAN_EXIT);
        this.recordFailures(...failures, ...input.cleanupAuthority(true), ...retire());
      },
      (error: unknown) => {
        const { failures } = this.observe(input, factsOf(error));
        // A typed process failure is a completed attempt; the wrapper's existing
        // attempt bound controls retry. Unknown errors and containment failures
        // cannot prove completion and remain fatal, regardless of provider reading.
        const process = error instanceof AgentProcessFailureError && failures.length === 0
          ? [] : [processFailure(error)];
        this.recordFailures(
          ...failures, ...process, ...input.cleanupAuthority(true), ...retire(),
        );
      },
    ).finally(() => { this.active.delete(input.workItemId); });
    this.active.set(input.workItemId, tracked);
  }

  /** The pid-less record lands before spawn admission. An accepted start then
   * upgrades that same row before lifetime handlers can observe an instant exit;
   * every non-start path preserves the producer's exact refusal provenance. */
  readonly start = async (input: AgentWrapperStaffingStart): Promise<SpawnReport> => {
    const retire = (): readonly Error[] => this.gate.retire(input.workItemId);
    const provisional = this.gate.record({
      childPid: undefined,
      claimAggregateVersion: input.claimAggregateVersion,
      sessionId: input.sessionId,
      workItemId: input.workItemId,
    });
    if (provisional.length > 0) {
      this.recordFailures(...provisional, ...input.cleanupAuthority(true));
      return uncoded(input, "AGENT_STAFFING_RECORD_FAILED:UNSPAWNED");
    }

    let started: AgentSpawnStartResult;
    try {
      started = await input.spawnAgent(input.request);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error("AGENT_SPAWN_FAILED:UNKNOWN");
      this.recordFailures(failure, ...input.cleanupAuthority(true), ...retire());
      return uncoded(input, "AGENT_SPAWN_FAILED:UNADMITTED");
    }
    if (!started.ok) {
      this.recordFailures(...input.cleanupAuthority(true), ...retire());
      return { ...uncoded(input, started.code), refusal: started };
    }

    this.recordFailures(...this.gate.record({
      childPid: started.pid,
      claimAggregateVersion: input.claimAggregateVersion,
      sessionId: input.sessionId,
      workItemId: input.workItemId,
    }));
    this.trackLifetime(input, started.exit, retire);
    return uncoded(input, "SPAWNED");
  };

  readonly settle = async (): Promise<void> => {
    await Promise.all([...this.active.values()]);
    const ordered = this.orderedFailures();
    if (ordered.length === 1) throw ordered[0];
    if (ordered.length > 1) {
      throw new AggregateError(ordered, ordered.map((error) => error.message).join("|"));
    }
  };
}

export function createAgentWrapperStaffing(
  fence: AgentSessionFence | undefined,
): AgentWrapperStaffing {
  return new AgentWrapperStaffingState(fence);
}
