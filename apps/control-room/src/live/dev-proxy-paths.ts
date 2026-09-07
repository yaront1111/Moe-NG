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
  "/deployments/read",
  // The deployment-environment health read. Its consumer is the Environments section on the
  // Health screen (task-df972c274f2a43eda3a9f57d2780c6f9); without the pin the dev server
  // answers it itself and the section renders against Vite instead of against a daemon.
  "/deployments/health/read",
  "/health/read",
  "/graph/get",
  "/planning/run/read",
  "/policy/read",
  // The preview receipt read, and the capture-bytes route beneath it. The second is a PREFIX:
  // Vite matches proxy keys by prefix, so one entry covers every
  // `/preview/capture/<goalId>/<sha>/<file>.png`. Without both the dev server answers them
  // itself and the preview card renders against Vite instead of against a daemon.
  "/preview/read",
  "/preview/capture",
  "/product-contract/gate-1/read",
  "/product-contract/pending/read",
  "/repository/remote/read",
  "/criteria/read",
  "/repository/recovery/read",
  "/repository/bootstrap/read",
  // The release evidence read. Its consumer is the Release card
  // (task-817d893fa1254a4d82d2888af1f87a47); without the pin the dev lane cannot reach the
  // route and the card renders against Vite instead of against a daemon.
  "/release/read",
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
