export const PAIRING_APPROVAL_LAYER = "CONTROL_ROOM_PAIRING_APPROVAL" as const;
export const PAIRING_APPROVAL_TTL_MS = 60_000;
export const PAIRING_APPROVAL_MAX_LIVE_REQUESTS = 8;
export const PAIRING_APPROVAL_COLLISION_ATTEMPTS = 4;
export const PAIRING_APPROVAL_REFUSAL_CODES = Object.freeze([
  "PAIRING_APPROVAL_CAPACITY_EXHAUSTED",
  "PAIRING_APPROVAL_CLOCK_UNAVAILABLE",
  "PAIRING_APPROVAL_ENTROPY_UNAVAILABLE",
  "PAIRING_APPROVAL_IDENTITY_EXHAUSTED",
  "PAIRING_APPROVAL_REQUIRED",
  "PAIRING_APPROVAL_UNAVAILABLE",
  "PAIRING_CLAIM_CHALLENGE_UNAVAILABLE",
  "PAIRING_CLAIM_REQUEST_INVALID",
  "PAIRING_CONFIRMATION_INVALID",
  "PAIRING_CONFIRMATION_UNKNOWN",
  "PAIRING_CREATE_REQUEST_INVALID",
  "PAIRING_REQUEST_ALREADY_CLAIMED",
  "PAIRING_REQUEST_BUSY",
  "PAIRING_REQUEST_EXPIRED",
  "PAIRING_REQUEST_INVALID",
  "PAIRING_REQUEST_UNKNOWN",
  "PAIRING_SESSION_MINT_FAILED",
  "PAIRING_SESSION_MINT_OUTCOME_UNKNOWN",
] as const);

export type PairingApprovalRefusalCode = typeof PAIRING_APPROVAL_REFUSAL_CODES[number];
export type PairingRandomBytesSource = (size: number) => Uint8Array;

export interface PairingApprovalRefusal {
  readonly cause?: Readonly<{ readonly code: string; readonly layer: string }>;
  readonly code: PairingApprovalRefusalCode;
  readonly layer: typeof PAIRING_APPROVAL_LAYER;
  readonly ok: false;
}

export interface PairingRequestCreated {
  readonly confirmationLabel: string;
  readonly ok: true;
  readonly requestId: string;
}

export interface PairingClaimReservation {
  commit(): void;
  release(): void;
}

export interface PairingClaimReserved {
  readonly ok: true;
  readonly reservation: PairingClaimReservation;
  readonly state: "CLAIMING";
}

export interface PairingApprovalGranted {
  readonly ok: true;
  readonly state: "APPROVED";
}

export interface PairingRequestPort {
  create(): PairingRequestCreated | PairingApprovalRefusal;
  reserve(requestId: unknown): PairingClaimReserved | PairingApprovalRefusal;
}

export interface PairingOperatorPort {
  approve(confirmationLabel: unknown): PairingApprovalGranted | PairingApprovalRefusal;
}

export interface PairingApprovalWindow {
  close(): void;
  readonly operator: PairingOperatorPort;
  readonly requests: PairingRequestPort;
}

export interface PairingApprovalWindowOptions {
  readonly now?: () => number;
  readonly randomBytes?: PairingRandomBytesSource;
}

export function refusePairingApproval(
  code: PairingApprovalRefusalCode,
  cause?: Readonly<{ readonly code: string; readonly layer: string }>,
): PairingApprovalRefusal {
  // `cause` arrives already normalized to exactly code+layer by its single
  // construction site; it is attached as-is rather than re-spread, so that one
  // site stays the only thing a mutation to cause hygiene has to defeat.
  return cause === undefined
    ? Object.freeze({ code, layer: PAIRING_APPROVAL_LAYER, ok: false as const })
    : Object.freeze({ cause, code, layer: PAIRING_APPROVAL_LAYER, ok: false as const });
}
