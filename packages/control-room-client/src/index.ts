export { createCompatGate } from "./client-compat.js";
export {
  CONTROL_ROOM_TRANSPORT_LAYER,
  TRANSPORT_REFUSAL_CODES,
  createControlRoomTransport,
} from "./client-transport.js";
export type {
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
