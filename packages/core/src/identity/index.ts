/**
 * Public seam for the identity area.
 *
 * Authentication answers "who is this, and is this command inside their exact
 * granted scope". It never confers presence, lease, approval, evidence, or
 * TruthClass authority.
 */

export {
  createCredential,
  createPrincipal,
  createSession,
  isCurrentGeneration,
  isSessionUsableAt,
  PRINCIPAL_KINDS,
  rotateCredential,
  SESSION_STATUSES,
} from "./identity-session.js";
export type {
  Credential,
  CredentialRotation,
  Principal,
  PrincipalKind,
  Session,
  SessionStatus,
} from "./identity-session.js";

export { canonicalizeCapabilities, matchCapability } from "./identity-capability.js";
export type { CapabilityGrant, CapabilityQuery } from "./identity-capability.js";

export { authenticateSession, SESSION_AUTH_LAYERS } from "./authenticate-session.js";
export type {
  AuthenticatedSessionFacts,
  SessionAuthCode,
  SessionAuthLayer,
  SessionAuthenticationInput,
  SessionAuthenticationResult,
} from "./authenticate-session.js";

export { authenticateCommand } from "./authenticate-command.js";
export type {
  AuthenticateCommandInput,
  AuthenticateCommandResult,
  AuthorizationContext,
  PresentedProof,
  ProofChallenge,
  ReplayOutcome,
} from "./authenticate-command.js";
