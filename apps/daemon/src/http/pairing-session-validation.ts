import { decodeBoundedJsonBytes } from "@moe/contracts";
import { isBoundedId, isSessionDigest, readExactRecord } from "../identity/session-authority-protocol.js";
import { OPERATOR_PROFILE_REVISION_ID } from "../identity/session-handshake.js";
import { authenticateHttpRequest } from "./http-command-ingress.js";
import type { Authenticator, HttpPortRefused, HttpRefused } from "./http-contract.js";
import type { PairingOpenSessionPort } from "./pairing-open-completion.js";
import type { SessionChallengeOperandsReadPort } from "./session-challenge-operands-read.js";

export const PAIRING_SESSION_VALIDATION_PATH = "/session/validate";
const PAIRING_SESSION_LAYER = "CONTROL_ROOM_PAIRING_SESSION" as const;
export interface PairingSessionBinding {
  readonly sessionId: string;
  readonly credentialId: string;
  readonly clientKeyId: string;
  readonly generation: number;
}
export type PairingSessionValidationBody =
  | { readonly ok: true; readonly projectId: string }
  | { readonly ok: false; readonly code: string; readonly layer: typeof PAIRING_SESSION_LAYER }
  | HttpPortRefused | HttpRefused;
type Dispatch = { readonly body: PairingSessionValidationBody; readonly httpStatus: number };
type RefusalCode = "PAIRING_SESSION_INVALID" | "PAIRING_SESSION_UNAVAILABLE"
  | "PAIRING_SESSION_REQUEST_INVALID" | "PAIRING_SESSION_CAPABILITY_DENIED";

function refuse(code: RefusalCode, httpStatus: number): Dispatch {
  return { body: { ok: false, code, layer: PAIRING_SESSION_LAYER }, httpStatus };
}
function readBinding(body: unknown): PairingSessionBinding | null {
  const decoded = decodeBoundedJsonBytes(body);
  if (!decoded.ok) return null;
  const value = readExactRecord(decoded.value, ["sessionId", "credentialId", "clientKeyId", "generation"]);
  if (value === null || !isBoundedId(value.sessionId) || !isBoundedId(value.credentialId)
    || !isSessionDigest(value.clientKeyId) || !Number.isSafeInteger(value.generation)
    || typeof value.generation !== "number" || value.generation < 1) return null;
  return { sessionId: value.sessionId, credentialId: value.credentialId,
    clientKeyId: value.clientKeyId, generation: value.generation };
}

/** The bearer authenticates the caller; only a linked, active signed open proves completed pairing.
 * Public selectors from browser storage never supply authority. This read neither renews nor mints. */
export function handlePairingSessionValidation(
  dependencies: { readonly authenticator: Authenticator; readonly pairingOpenSessions?: PairingOpenSessionPort | undefined;
    readonly sessionChallengeOperands?: SessionChallengeOperandsReadPort | undefined },
  request: { readonly body: unknown; readonly credential: string | null; readonly protocolVersion: unknown },
): Dispatch {
  const access = authenticateHttpRequest(dependencies.authenticator, request.credential, request.protocolVersion);
  if (!access.ok) return { body: access, httpStatus: access.httpStatus };
  if (!access.principal.capabilities.includes("goal.write")) return refuse("PAIRING_SESSION_CAPABILITY_DENIED", 403);
  const binding = readBinding(request.body);
  if (binding === null) return refuse("PAIRING_SESSION_REQUEST_INVALID", 400);
  const sessions = dependencies.pairingOpenSessions, operands = dependencies.sessionChallengeOperands;
  if (sessions?.readActiveSession === undefined || operands === undefined) return refuse("PAIRING_SESSION_UNAVAILABLE", 503);
  if (access.principal.projectId !== operands.boundProjectId) return refuse("PAIRING_SESSION_INVALID", 401);
  try {
    const held = sessions.readActiveSession(binding.sessionId);
    if (held.status === "UNKNOWN") return refuse("PAIRING_SESSION_UNAVAILABLE", 503);
    if (held.status !== "FOUND") return refuse("PAIRING_SESSION_INVALID", 401);
    const { authority } = held;
    const { principal, session, credential, publicKey } = authority;
    if (authority.projectId !== operands.boundProjectId || principal.principalId !== access.principal.principalId
      || session.principalId !== principal.principalId || principal.kind !== "HUMAN"
      || principal.profileRevisionId !== OPERATOR_PROFILE_REVISION_ID
      || session.profileRevisionId !== principal.profileRevisionId
      || session.sessionId !== binding.sessionId || credential.sessionId !== binding.sessionId
      || credential.credentialId !== binding.credentialId || credential.generation !== binding.generation
      || session.generation !== binding.generation || session.clientKeyId !== binding.clientKeyId
      || publicKey.clientKeyId !== binding.clientKeyId || !session.transportIds.includes("control-room.v1")) {
      return refuse("PAIRING_SESSION_INVALID", 401);
    }
    const current = operands.readOperands(access.principal.principalId);
    if (current.outcome !== "OPERANDS") return refuse("PAIRING_SESSION_UNAVAILABLE", 503);
    if (current.operands.profileRevisionId !== principal.profileRevisionId
      || current.operands.recoveryIncarnationRef !== session.recoveryIncarnationRef
      || current.operands.keyEpochRef !== session.keyEpochRef
      || current.operands.recoveryIncarnationRef !== credential.recoveryIncarnationRef
      || current.operands.keyEpochRef !== credential.keyEpochRef) return refuse("PAIRING_SESSION_INVALID", 401);
    return { body: { ok: true, projectId: operands.boundProjectId }, httpStatus: 200 };
  } catch { return refuse("PAIRING_SESSION_UNAVAILABLE", 503); }
}
