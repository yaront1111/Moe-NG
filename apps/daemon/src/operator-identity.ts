/**
 * The local operator identity used when a launcher supplies no explicit
 * `MOE_PRINCIPAL_ID`. Daemon authentication and shipped operator-side tooling
 * must share this byte-for-byte: approval actors are checked against the
 * authenticated envelope principal and are never rewritten at ingress.
 */
export const DEFAULT_OPERATOR_PRINCIPAL_ID = "operator-local" as const;
