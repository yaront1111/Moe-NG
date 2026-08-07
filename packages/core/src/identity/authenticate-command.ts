import { createRuntimeError } from "@moe/contracts";
import type { RuntimeCommandEnvelope, RuntimeError } from "@moe/contracts";

import { matchCapability } from "./identity-capability.js";
import type { CapabilityGrant } from "./identity-capability.js";
import { isCurrentGeneration, isSessionUsableAt } from "./identity-session.js";
import type { Credential, Principal, Session } from "./identity-session.js";

/** Proof of possession presented alongside the command. */
export interface PresentedProof {
  readonly credentialId: string;
  readonly commandId: string;
  readonly requestDigest: string;
  readonly clientKeyId: string;
}

/** What the injected verifier is asked to attest. Never self-asserted. */
export interface ProofChallenge {
  readonly commandId: string;
  readonly requestDigest: string;
  readonly credentialId: string;
  readonly clientKeyId: string;
}

export type ReplayOutcome = "FRESH" | "REPLAYED";

export interface AuthenticateCommandInput {
  readonly envelope: RuntimeCommandEnvelope;
  readonly principal: Principal | null;
  readonly session: Session | null;
  readonly credential: Credential | null;
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

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * True when every structural and cross-record binding holds.
 *
 * Runs before any freshness or scope check so a forged record that merely
 * looks stale cannot select a softer, more specific error.
 */
function bindingsHold(input: AuthenticateCommandInput): boolean {
  const { envelope, principal, session, credential, proof } = input;
  if (principal === null || session === null || credential === null) return false;
  if (proof === null || typeof proof !== "object") return false;
  if (input.capabilities === null) return false;
  if (!Number.isSafeInteger(input.now)) return false;
  if (!isNonEmpty(input.projectId) || !isNonEmpty(input.transportId)) return false;
  if (credential.sessionId !== session.sessionId) return false;
  if (principal.principalId !== session.principalId) return false;
  if (principal.profileRevisionId !== session.profileRevisionId) return false;
  if (envelope.sessionCredential !== credential.credentialId) return false;
  if (proof.credentialId !== credential.credentialId) return false;
  if (proof.commandId !== envelope.commandId) return false;
  if (proof.requestDigest !== envelope.requestDigest) return false;
  if (proof.clientKeyId !== session.clientKeyId) return false;
  return true;
}

/**
 * Authenticates a decoded command envelope against daemon-owned records.
 *
 * Failure precedence is total and deliberate:
 * AUTHENTICATION_FAILED -> SESSION_REPLAYED -> SESSION_EXPIRED ->
 * CAPABILITY_DENIED. Nothing partial is ever returned, and an unknown or
 * throwing seam always fails closed.
 */
export function authenticateCommand(
  input: AuthenticateCommandInput,
): AuthenticateCommandResult {
  const correlationId = input.envelope?.correlationId ?? "";
  if (!bindingsHold(input)) {
    return deny("AUTHENTICATION_FAILED", correlationId);
  }
  // Non-null after bindingsHold.
  const principal = input.principal!;
  const session = input.session!;
  const credential = input.credential!;
  const capabilities = input.capabilities!;

  // `input.proof` is deliberately NOT read past bindingsHold: the challenge is
  // rebuilt from the envelope and daemon records, so any extra field a caller
  // attaches to the proof (such as `verified: true`) cannot reach the verifier.
  const challenge: ProofChallenge = Object.freeze({
    commandId: input.envelope.commandId,
    requestDigest: input.envelope.requestDigest,
    credentialId: credential.credentialId,
    clientKeyId: session.clientKeyId,
  });

  // The verifier's answer is the only proof authority. A caller-supplied
  // `verified` flag on the proof object is ignored by construction, since it
  // is never read.
  let verified: unknown;
  try {
    verified = input.verifyProof(challenge);
  } catch {
    return deny("AUTHENTICATION_FAILED", correlationId);
  }
  if (verified !== true) {
    return deny("AUTHENTICATION_FAILED", correlationId);
  }

  let replay: unknown;
  try {
    replay = input.checkReplay(challenge);
  } catch {
    return deny("AUTHENTICATION_FAILED", correlationId);
  }
  if (replay !== "FRESH" && replay !== "REPLAYED") {
    // UNKNOWN never authorizes.
    return deny("AUTHENTICATION_FAILED", correlationId);
  }

  if (replay === "REPLAYED" || !isCurrentGeneration(session, credential)) {
    return deny("SESSION_REPLAYED", correlationId);
  }
  if (session.status !== "ACTIVE") {
    return deny("SESSION_REPLAYED", correlationId);
  }
  if (!isSessionUsableAt(session, input.now)) {
    return deny("SESSION_EXPIRED", correlationId);
  }
  if (!session.transportIds.includes(input.transportId)) {
    return deny("CAPABILITY_DENIED", correlationId);
  }

  const grant = matchCapability(capabilities, {
    principalId: principal.principalId,
    projectId: input.projectId,
    commandKind: input.envelope.commandKind,
    targetAggregateId: input.envelope.targetAggregateId,
    transportId: input.transportId,
  });
  if (grant === null) {
    return deny("CAPABILITY_DENIED", correlationId);
  }
  if (grant.requiresRecentStepUp) {
    const at = input.recentStepUpAt;
    if (at === null || !Number.isSafeInteger(at) || at <= input.now - STEP_UP_WINDOW) {
      return deny("CAPABILITY_DENIED", correlationId);
    }
  }

  return Object.freeze({
    ok: true as const,
    context: Object.freeze({
      principalId: principal.principalId,
      principalKind: principal.kind,
      profileRevisionId: principal.profileRevisionId,
      sessionId: session.sessionId,
      projectId: input.projectId,
      commandKind: input.envelope.commandKind,
      targetAggregateId: input.envelope.targetAggregateId,
      transportId: input.transportId,
      capabilityId: grant.capabilityId,
    }),
  });
}
