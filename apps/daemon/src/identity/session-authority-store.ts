/** Curated compatibility surface for session-authority persistence modules. */

export {
  commitAuthorityDecision, commitAuthorityDecisionLegs, receiptOf,
} from "./session-authority-decision.js";
export type {
  AuthorityCommit, AuthorityCommitOutcome,
} from "./session-authority-decision.js";
export {
  principalAggregateId, readPrincipalRecord, readSessionFold, sessionAggregateId,
} from "./session-authority-fold.js";
export type {
  CredentialRecord, PrincipalRead, SessionFold, SessionFoldRead,
} from "./session-authority-fold.js";
export {
  buildReplayMarkerDecisionLeg, observeReplayMarker, replayAggregateId,
} from "./session-authority-replay-marker.js";
export type {
  ReplayMarker, ReplayMarkerDecisionPlan, ReplayObservation,
} from "./session-authority-replay-marker.js";
