import { createRuntimeError } from "@moe/contracts";
import type { RuntimeCommandEnvelope, RuntimeError } from "@moe/contracts";

import { authenticateSession } from "./authenticate-session.js";
import type {
  AuthenticatedSessionFacts,
  PresentedProof,
  ProofChallenge,
  ReplayOutcome,
} from "./authenticate-session.js";
import { matchCapability } from "./identity-capability.js";
import type { CapabilityGrant } from "./identity-capability.js";

export type {
  PresentedProof,
  ProofChallenge,
  ReplayOutcome,
} from "./authenticate-session.js";

export interface AuthenticateCommandInput {
  readonly envelope: RuntimeCommandEnvelope;
  readonly principal: import("./identity-session.js").Principal | null;
  readonly session: import("./identity-session.js").Session | null;
  readonly credential: import("./identity-session.js").Credential | null;
  readonly capabilities: readonly CapabilityGrant[] | null;
  readonly projectId: string;
  readonly transportId: string;
  readonly now: number;
  readonly proof: PresentedProof | null;
  readonly verifyProof: (challenge: ProofChallenge) => boolean;
  readonly checkReplay: (challenge: ProofChallenge) => ReplayOutcome;
  readonly recentStepUpAt: number | null;
}

/** Derived identity and scope facts only. Confers no business authority. */
export interface AuthorizationContext {
  readonly principalId: string;
  readonly principalKind: string;
  readonly profileRevisionId: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly commandKind: string;
  readonly targetAggregateId: string;
  readonly transportId: string;
  readonly capabilityId: string;
}

export type AuthenticateCommandResult =
  | { readonly ok: true; readonly context: AuthorizationContext }
  | { readonly ok: false; readonly error: RuntimeError };

/** Step-up must be strictly newer than this window before `now`. */
const STEP_UP_WINDOW = 300;

function deny(code: string, correlationId: string): AuthenticateCommandResult {
  return Object.freeze({
    ok: false as const,
    error: createRuntimeError({ code, correlationId }),
  });
}

function authorizeCapability(
  input: AuthenticateCommandInput,
  facts: AuthenticatedSessionFacts,
  capabilities: readonly CapabilityGrant[],
  correlationId: string,
): AuthenticateCommandResult {
  const grant = matchCapability(capabilities, {
    principalId: facts.principalId,
    projectId: facts.projectId,
    commandKind: input.envelope.commandKind,
    targetAggregateId: input.envelope.targetAggregateId,
    transportId: facts.transportId,
  });
  if (grant === null) return deny("CAPABILITY_DENIED", correlationId);
  if (grant.requiresRecentStepUp) {
    const at = input.recentStepUpAt;
    if (at === null || !Number.isSafeInteger(at) || at <= input.now - STEP_UP_WINDOW) {
      return deny("CAPABILITY_DENIED", correlationId);
    }
  }
  return Object.freeze({
    ok: true as const,
    context: Object.freeze({
      principalId: facts.principalId,
      principalKind: facts.principalKind,
      profileRevisionId: facts.profileRevisionId,
      sessionId: facts.sessionId,
      projectId: facts.projectId,
      commandKind: input.envelope.commandKind,
      targetAggregateId: input.envelope.targetAggregateId,
      transportId: facts.transportId,
      capabilityId: grant.capabilityId,
    }),
  });
}

/**
 * Authenticates a decoded command, then applies its exact capability grant.
 * Session authentication never grants command or business authority.
 */
export function authenticateCommand(
  input: AuthenticateCommandInput,
): AuthenticateCommandResult {
  const correlationId = input.envelope?.correlationId ?? "";
  const envelope = input.envelope;
  if (typeof envelope !== "object" || envelope === null || input.capabilities === null) {
    return deny("AUTHENTICATION_FAILED", correlationId);
  }
  const authentication = authenticateSession({
    principal: input.principal,
    session: input.session,
    credential: input.credential,
    projectId: input.projectId,
    transportId: input.transportId,
    now: input.now,
    requestId: envelope.commandId,
    requestDigest: envelope.requestDigest,
    presentedCredentialId: envelope.sessionCredential,
    proof: input.proof,
    verifyProof: input.verifyProof,
    checkReplay: input.checkReplay,
  });
  if (!authentication.ok) return deny(authentication.code, correlationId);
  return authorizeCapability(input, authentication.facts, input.capabilities, correlationId);
}
