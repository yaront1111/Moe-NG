import type { ScheduleDefinition } from "./schedule-model.js";
import {
  ABSTRACT_EDGE,
  CORE_FAULT_BOUNDARIES,
  EDGE,
  FAULT,
  RACE,
  defineSchedule,
} from "./schedule-universe-invariants.js";

/**
 * Canonical CORE schedule universe, scenario half (design 20.2 #CORE-S1..#CORE-S14).
 *
 * These definitions are the Phase-1 deliverable: they pin each scenario's canonical
 * schedule shape and stratum. Execution evidence does not exist yet, so the checker
 * reports UNKNOWN for them; that is the designed verdict, not a gap to paper over.
 */

const two = "TWO_EVENT" as const;
const multi = "MULTI_EVENT" as const;

export const CORE_SCENARIO_SCHEDULES: readonly ScheduleDefinition[] = Object.freeze([
  defineSchedule("CORE-S1-PAIR", ["CORE-S1"], two,
    [EDGE.gCreate, EDGE.gActivate], [RACE.dActivateCancel], [FAULT.commit]),
  defineSchedule("CORE-S2-PAIR", ["CORE-S2"], two,
    [EDGE.gActivate, EDGE.gClose], [RACE.eClosePause], [FAULT.outbox]),
  defineSchedule("CORE-S3-PAIR", ["CORE-S3"], two,
    [EDGE.gActivate, EDGE.gCancelDraft], [RACE.dActivateResume], [FAULT.lock]),
  defineSchedule("CORE-S4-PAIR", ["CORE-S4"], two,
    [EDGE.gCloseAtomic, EDGE.gCancelClosing], [RACE.cCancelClose], CORE_FAULT_BOUNDARIES),
  defineSchedule("CORE-S4-PARTIAL-ORDER", ["CORE-S4"], multi,
    [EDGE.gClose, EDGE.gComplete, EDGE.gCancelClosing],
    [RACE.cCancelInvalidate, RACE.cCloseInvalidate], CORE_FAULT_BOUNDARIES),
  defineSchedule("CORE-S5-PAIR", ["CORE-S5"], two,
    [EDGE.gCreate, EDGE.gReopenCompleted], [RACE.dCancelResume], [FAULT.registration]),
  defineSchedule("CORE-S6-PAIR", ["CORE-S6"], two,
    [EDGE.gPauseExecuting, EDGE.gCancelExecuting], [RACE.eCancelPause], [FAULT.lock]),
  defineSchedule("CORE-S7-PAIR", ["CORE-S7"], two,
    [EDGE.pQuiesceReady, EDGE.pRecover], [RACE.pActivateBind], [FAULT.registration]),
  defineSchedule("CORE-S8-PAIR", ["CORE-S8"], two,
    [EDGE.gActivate, EDGE.gReopenCompleted], [RACE.dActivatePause], [FAULT.begin]),
  defineSchedule("CORE-S9-PAIR", ["CORE-S9"], two,
    [EDGE.gActivate, ABSTRACT_EDGE.planClaim], [RACE.dCancelPause], [FAULT.effect]),
  defineSchedule("CORE-S9-PARTIAL-ORDER", ["CORE-S9"], multi,
    [EDGE.gActivate, EDGE.gCancelDraft, ABSTRACT_EDGE.planClaim, ABSTRACT_EDGE.planSubmit],
    [RACE.dActivateCancel], [FAULT.effect, FAULT.lock]),
  defineSchedule("CORE-S10-PAIR", ["CORE-S10"], two,
    [EDGE.gInvalidate, EDGE.gReopenCompleted], [RACE.cCloseInvalidate], [FAULT.outbox]),
  defineSchedule("CORE-S11-PAIR", ["CORE-S11"], two,
    [EDGE.gReopenCompleted, ABSTRACT_EDGE.graphSupersede], [RACE.eCancelResume], [FAULT.effect]),
  defineSchedule("CORE-S11-PARTIAL-ORDER", ["CORE-S11"], multi,
    [EDGE.gReopenCompleted, ABSTRACT_EDGE.graphSupersede, ABSTRACT_EDGE.graphActivate,
      ABSTRACT_EDGE.planClaim],
    [RACE.eCloseResume], [FAULT.effect, FAULT.registration]),
  defineSchedule("CORE-S12-PAIR", ["CORE-S12"], two,
    [EDGE.gCloseAtomic, EDGE.gResumeExecuting], [RACE.ePauseResume], [FAULT.outbox, FAULT.ack]),
  defineSchedule("CORE-S12-PARTIAL-ORDER", ["CORE-S12"], multi,
    [EDGE.gCloseAtomic, EDGE.gResumeExecuting, EDGE.gPauseExecuting], [RACE.eCancelClose],
    [FAULT.outbox, FAULT.ack, FAULT.commit]),
  defineSchedule("CORE-S13-PAIR", ["CORE-S13"], two,
    [EDGE.gActivate, EDGE.gClose], [RACE.dPauseResume], [FAULT.begin]),
  defineSchedule("CORE-S13-PARTIAL-ORDER", ["CORE-S13"], multi,
    [EDGE.gActivate, EDGE.gClose, EDGE.gComplete, EDGE.gPauseExecuting],
    [RACE.dActivateResume, RACE.dCancelResume, RACE.dPauseResume, RACE.eCloseResume],
    [FAULT.begin, FAULT.commit]),
  defineSchedule("CORE-S14-PAIR", ["CORE-S14"], two,
    [EDGE.pRegister, EDGE.pQuiesceBootstrap], [RACE.pBindQuiesce],
    [FAULT.restore, FAULT.checkpoint]),
  defineSchedule("CORE-S14-PARTIAL-ORDER", ["CORE-S14"], multi,
    [EDGE.pRegister, EDGE.pQuiesceReady, EDGE.pRecover], [RACE.pActivateQuiesce],
    [FAULT.restore, FAULT.checkpoint, FAULT.ack]),
]);
