/**
 * Public seam for the coordination area.
 *
 * This package moves typed, addressed, durably sequenced envelopes between authenticated
 * sessions. It is deliberately NOT a chat: nothing here dispatches a command, mutates a
 * lifecycle, forwards a credential, or grants authority. Advisory text is data.
 *
 * Store internals, raw SQL, the hostile-input codec, identity material, and any
 * envelope-to-command executor are intentionally absent from this surface.
 */

export {
  COORDINATION_CODES, COORDINATION_CONTROL_KINDS, COORDINATION_ENDPOINTS,
  COORDINATION_ENDPOINT_VERSION, COORDINATION_ENVELOPE_KINDS, COORDINATION_ENVELOPE_VERSION,
  COORDINATION_FORBIDDEN_FIELDS, COORDINATION_LAYERS, COORDINATION_LIMITS, COORDINATION_ROLES,
  COORDINATION_SCOPE, coordinationCapability,
} from "./coordination-contracts.js";
export type {
  CoordinationAccepted, CoordinationAckResult, CoordinationAcknowledged, CoordinationAddress,
  CoordinationAdvisory, CoordinationCode, CoordinationControlEnvelope, CoordinationControlKind,
  CoordinationCursorGap, CoordinationDelivery, CoordinationEndpoint, CoordinationEnvelope,
  CoordinationEnvelopeFields, CoordinationEnvelopeKind, CoordinationEventEnvelope,
  CoordinationHandoff, CoordinationHandoffEnvelope, CoordinationLayer, CoordinationPage,
  CoordinationReadResult, CoordinationRefused, CoordinationRequestEnvelope,
  CoordinationResponseEnvelope, CoordinationRole, CoordinationSendResult,
} from "./coordination-contracts.js";

export { createDurableMailbox } from "./coordination-mailbox.js";
export type {
  CoordinationEventStore, DurableMailbox, MailboxAckInput, MailboxLookupInput, MailboxReadInput,
  MailboxReplayInput, MailboxSendInput,
} from "./coordination-mailbox.js";

export { createCoordinationService } from "./coordination-service.js";
export type {
  CoordinationAcknowledgeRequest, CoordinationAuthRequest, CoordinationAuthenticator,
  CoordinationBinding, CoordinationDependencies, CoordinationEffectBindingPort,
  CoordinationEffectQuery, CoordinationMailboxRequest, CoordinationRecipientRegistry,
  CoordinationReplayRequest, CoordinationSendRequest, CoordinationService,
} from "./coordination-service.js";
