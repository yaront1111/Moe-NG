/**
 * Every project-daemon route the default v2 browser may proxy in development.
 * Manager routes deliberately use a separate origin and cookie authority.
 */
export const DEV_PROXY_PATHS = Object.freeze([
  "/activation/read",
  "/activity/read",
  "/affordances/read",
  "/bootstrap",
  "/budget/commitment/read",
  "/command",
  "/v2/command",
  "/v2/product-contract/current",
  "/v2/product-contract/pending/read",
  "/documents/coverage/read",
  "/documents/dossier/read",
  "/documents/ingest",
  "/events/ack",
  "/events/read",
  "/events/resume",
  "/goals/read",
  "/goals/source/read",
  "/design/read",
  "/health/read",
  "/graph/get",
  "/planning/run/read",
  "/policy/read",
  "/product-contract/gate-1/read",
  "/product-contract/pending/read",
  "/repository/remote/read",
  "/criteria/read",
  "/repository/recovery/read",
  "/runs/read",
  // The browser reads the three OPEN_SESSION operands and completes the signed open on
  // the daemon's own origin; without these two the dev server answers them itself and the
  // page pairs against Vite instead of against a daemon.
  "/session/challenge-operands/read",
  "/session/pair",
  "/session/pair/claim",
  "/session/pair/open",
  "/session/pair/request",
  "/sessions/read",
] as const);

export interface DevProxyEntry {
  readonly changeOrigin: true;
  readonly headers: Readonly<{ origin: string }>;
  readonly target: string;
}

/** Build the one project-daemon proxy map consumed by Vite. */
export function buildDevProxy(origin: string): Record<string, DevProxyEntry> {
  return Object.fromEntries(DEV_PROXY_PATHS.map((path) => [path, {
    changeOrigin: true,
    headers: { origin },
    target: origin,
  }]));
}
