import { createRuntimeError } from "@moe/contracts";
import type { RuntimeCommandEnvelope, RuntimeError } from "@moe/contracts";

import { authenticateSession } from "./authenticate-session.js";
import type {
  AuthenticatedSessionFacts,
  PresentedProof,
  ProofChallenge,
  ReplayOutcome,
  SessionAuthLayer,
} from "./authenticate-session.js";
import {
  canonicalizeCapabilities,
  matchCapability,
  matchingCapabilityRecoveryBindings,
} from "./identity-capability.js";
import type { CapabilityGrant } from "./identity-capability.js";
import type { RecoveryAuthenticationBinding } from "./recovery-authentication-binding.js";

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
  readonly currentRecoveryBinding: RecoveryAuthenticationBinding | null;
  readonly verifyProof: (challenge: ProofChallenge) => boolean;
  readonly checkReplay: (challenge: ProofChallenge) => ReplayOutcome;
  readonly recentStepUpAt: number | null;
}

/** Derived identity and scope facts only. Confers no business authority. */
export interface AuthorizationContext extends RecoveryAuthenticationBinding {
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
  | {
      readonly ok: false;
      readonly error: RuntimeError;
      readonly layer: SessionAuthLayer | "CAPABILITY";
    };

/** Step-up must be strictly newer than this window before `now`. */
const STEP_UP_WINDOW = 300;

function deny(
  code: string,
  correlationId: string,
  layer: SessionAuthLayer | "CAPABILITY",
): AuthenticateCommandResult {
  return Object.freeze({
    ok: false as const,
    error: createRuntimeError({ code, correlationId }),
    layer,
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
    recoveryIncarnationRef: facts.recoveryIncarnationRef,
    keyEpochRef: facts.keyEpochRef,
  });
  if (grant === null) return deny("CAPABILITY_DENIED", correlationId, "CAPABILITY");
  if (grant.requiresRecentStepUp) {
    const at = input.recentStepUpAt;
    if (at === null || !Number.isSafeInteger(at) || at <= input.now - STEP_UP_WINDOW) {
      return deny("CAPABILITY_DENIED", correlationId, "CAPABILITY");
    }
  }
  return Object.freeze({
    ok: true as const,
    context: Object.freeze({
      recoveryIncarnationRef: facts.recoveryIncarnationRef,
      keyEpochRef: facts.keyEpochRef,
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
  let correlationId = "";
  try {
    const envelope = input.envelope;
    correlationId = envelope?.correlationId ?? "";
    const capabilities = canonicalizeCapabilities(input.capabilities);
    if (typeof envelope !== "object" || envelope === null || capabilities === null) {
      return deny("AUTHENTICATION_FAILED", correlationId, "BINDING");
    }
    const candidates = matchingCapabilityRecoveryBindings(capabilities, {
      principalId: input.principal?.principalId ?? "",
      projectId: input.projectId,
      commandKind: envelope.commandKind,
      targetAggregateId: envelope.targetAggregateId,
      transportId: input.transportId,
    });
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
      currentRecoveryBinding: input.currentRecoveryBinding,
      capabilityRecoveryCandidates: candidates,
      verifyProof: input.verifyProof,
      checkReplay: input.checkReplay,
    });
    if (!authentication.ok) {
      return deny(authentication.code, correlationId, authentication.layer);
    }
    return authorizeCapability(input, authentication.facts, capabilities, correlationId);
  } catch {
    return deny("AUTHENTICATION_FAILED", correlationId, "BINDING");
  }
}
