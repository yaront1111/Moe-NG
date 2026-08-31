export { admitByWireProtocol, createCompatGate } from "./client-compat.js";
export {
  CONTROL_ROOM_TRANSPORT_LAYER,
  TRANSPORT_REFUSAL_CODES,
  createControlRoomTransport,
} from "./client-transport.js";
export type {
  CommandAuthorityPlane,
  ControlRoomTransport,
  DaemonAnswer,
  EventAcknowledgeRequest,
  EventPageRequest,
  FetchLike,
  SendResult,
  TransportOptions,
  TransportRefusalCode,
  TransportRefused,
} from "./client-transport.js";
export type {
  ApiCompatibilityRange,
  CompatGateResult,
  CompatRefusalError,
  ControlRoomClientSurface,
  DistributionCompatibilityReport,
} from "./client-compat.js";
export type {
  CommandAffordance,
  CommandBuildResult,
  CommandBuilder,
  CommandCallerInput,
  GeneratedCommandBuilders,
  GeneratedContractPins,
  GeneratedErrorTable,
  GeneratedQueryBuilders,
  QueryBuilder,
  QueryCallerInput,
  QueryEnvelopeFor,
} from "./generated/generated-client.js";
export { buildGoalBriefCommand } from "./goal-brief-command.js";
export type {
  GoalBriefCommandInput,
  GoalBriefCommandResult,
} from "./goal-brief-command.js";
export { buildGoalWithSourceCommand } from "./goal-with-source-command.js";
export type {
  GoalWithSourceCommandInput,
  GoalWithSourceCommandResult,
} from "./goal-with-source-command.js";
export {
  SESSION_KEY_LAYER, SESSION_KEY_REFUSAL_CODES, generateSessionKey,
  openSessionRequestDigest, signSessionChallenge,
} from "./session-key.js";
export type {
  SessionCryptoKey, SessionKeyGenerated, SessionKeyRefusalCode, SessionKeyRefused,
  SessionKeyResult,
} from "./session-key.js";
