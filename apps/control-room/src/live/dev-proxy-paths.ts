/**
 * Every project-daemon route the default v2 browser may proxy in development.
 * Manager routes deliberately use a separate origin and cookie authority.
 */
export const DEV_PROXY_PATHS = Object.freeze([
  "/affordances/read",
  "/bootstrap",
  "/budget/commitment/read",
  "/command",
  "/documents/dossier/read",
  "/documents/ingest",
  "/events/ack",
  "/events/read",
  "/events/resume",
  "/goals/read",
  "/graph/get",
  "/planning/run/read",
  "/session/pair",
  "/session/pair/claim",
  "/session/pair/request",
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
