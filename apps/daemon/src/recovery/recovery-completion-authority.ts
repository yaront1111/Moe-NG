import { grantHumanAuthority } from "@moe/core";

import type { SessionAuthorityService } from "../identity/session-authority-contracts.js";
import {
  readPresentedAuthentication,
  readSessionProof,
  sessionAuthorityRequestDigest,
  sessionReplayDigest,
} from "../identity/session-authority-protocol.js";
import type { PresentedAuthentication } from "../identity/session-authority-protocol.js";
import {
  RECOVERY_COMPLETION_SCHEMA_VERSION,
  recoveryCompletionRefusal,
} from "./recovery-completion-digest.js";
import type { RecoveryCompletionRefused } from "./recovery-completion-digest.js";

export const RECOVERY_COMPLETION_HUMAN_GATE_ID = "recovery.complete:r3" as const;
export const RECOVERY_COMPLETION_APPROVAL_DOMAIN =
  "moe-recovery-completion-approval/1" as const;

export interface RecoveryCompletionApprovalSubject {
  readonly approvalRef: string;
  readonly commandId: string;
  readonly decisionReason: string;
  readonly incarnationRef: string;
  readonly keyEpochRef: string;
  readonly policyRevisionRef: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly recoveryDigest: string;
  readonly stepUpAuthRef: string;
}

export interface RecoveryCompletionAuthorityInput
  extends Omit<RecoveryCompletionApprovalSubject, "stepUpAuthRef"> {
  readonly authentication: unknown;
}

export interface RecoveryCompletionAuthorityGrant {
  readonly ok: true;
  readonly principalId: string;
  readonly stepUpAuthRef: string;
  readonly subjectDigest: string;
}

export type RecoveryCompletionAuthorityOutcome =
  | RecoveryCompletionAuthorityGrant
  | RecoveryCompletionRefused;

export interface RecoveryCompletionAuthority {
  readonly authorize: (
    input: RecoveryCompletionAuthorityInput,
  ) => RecoveryCompletionAuthorityOutcome;
}

export interface RecoveryCompletionAuthorityOptions {
  readonly clock: () => number;
  readonly projectId: string;
  readonly sessions: SessionAuthorityService;
}

/** Canonical command-scoped subject signed by the fresh session proof. */
export function recoveryCompletionApprovalDigest(
  subject: RecoveryCompletionApprovalSubject,
): string {
  return sessionAuthorityRequestDigest({
    ...subject,
    decision: "APPROVE",
    domain: RECOVERY_COMPLETION_APPROVAL_DOMAIN,
    riskTier: "R3",
    schemaVersion: RECOVERY_COMPLETION_SCHEMA_VERSION,
  });
}

function authRefusal(code: string, layer: string): RecoveryCompletionRefused {
  return recoveryCompletionRefusal({
    code,
    reason: "The recovery approval lacks a fresh proof bound to its exact subject.",
    refusedBy: layer,
  });
}

const bindingRefusal = (): RecoveryCompletionRefused =>
  authRefusal("AUTHENTICATION_FAILED", "BINDING");

interface PreparedPresentation {
  readonly presented: PresentedAuthentication;
  readonly stepUpAuthRef: string;
}

function preparePresentation(
  authentication: unknown,
  projectId: string,
  now: number,
): PreparedPresentation | RecoveryCompletionRefused {
  const presented = readPresentedAuthentication(authentication, projectId);
  if (presented === null) return bindingRefusal();
  const proof = readSessionProof(presented.proof, now);
  if (proof === null) return authRefusal("AUTHENTICATION_FAILED", "PROOF");
  return {
    presented,
    stepUpAuthRef: sessionReplayDigest({
      clientKeyId: presented.clientKeyId,
      generation: presented.generation,
      nonce: proof.nonce,
      sessionId: presented.sessionId,
    }),
  };
}

function factsMatch(
  input: RecoveryCompletionAuthorityInput,
  authenticated: Extract<ReturnType<SessionAuthorityService["authenticate"]>, { ok: true }>,
  stepUpAuthRef: string,
): boolean {
  const facts = authenticated.facts;
  return facts.principalId === input.principalId
    && facts.projectId === input.projectId
    && facts.recoveryIncarnationRef === input.incarnationRef
    && facts.keyEpochRef === input.keyEpochRef
    && authenticated.replayReceipt.replayDigest === stepUpAuthRef;
}

/**
 * Recovery explicitly treats one fresh, signed, single-use session proof as
 * its R3 step-up. This is a command-specific composition decision, not a claim
 * that the repository has a generic StepUp record: the durable replay receipt
 * is the step-up reference, and its digest is part of the signed subject.
 */
export function createRecoveryCompletionAuthority(
  options: RecoveryCompletionAuthorityOptions,
): RecoveryCompletionAuthority {
  const { clock, projectId, sessions } = options;

  function authorize(
    input: RecoveryCompletionAuthorityInput,
  ): RecoveryCompletionAuthorityOutcome {
    let now: number;
    try {
      now = clock();
    } catch {
      return authRefusal("AUTHENTICATION_FAILED", "PROOF");
    }
    const prepared = preparePresentation(input.authentication, projectId, now);
    if ("ok" in prepared) return prepared;
    const { presented, stepUpAuthRef } = prepared;
    if (presented.requestId !== input.commandId || presented.principalId !== input.principalId
      || input.projectId !== projectId) {
      return bindingRefusal();
    }
    const subjectDigest = recoveryCompletionApprovalDigest({
      approvalRef: input.approvalRef,
      commandId: input.commandId,
      decisionReason: input.decisionReason,
      incarnationRef: input.incarnationRef,
      keyEpochRef: input.keyEpochRef,
      policyRevisionRef: input.policyRevisionRef,
      principalId: input.principalId,
      projectId,
      recoveryDigest: input.recoveryDigest,
      stepUpAuthRef,
    });
    if (presented.requestDigest !== subjectDigest) return bindingRefusal();
    const authenticated = sessions.authenticate(input.authentication);
    if (!authenticated.ok) return authRefusal(authenticated.code, authenticated.layer);
    if (!factsMatch(input, authenticated, stepUpAuthRef)) return bindingRefusal();
    const facts = authenticated.facts;
    const human = grantHumanAuthority(
      { gateId: RECOVERY_COMPLETION_HUMAN_GATE_ID, grant: null, workRef: subjectDigest },
      { kind: facts.principalKind, principalId: facts.principalId },
      now,
    );
    if (!human.ok) return authRefusal(human.code, human.layer);
    const grant = human.gate.grant;
    if (grant === null) return bindingRefusal();
    return Object.freeze({
      ok: true as const,
      principalId: grant.principalId,
      stepUpAuthRef,
      subjectDigest,
    });
  }

  return Object.freeze({ authorize });
}
