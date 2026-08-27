/// <reference types="vite/client" />

/**
 * The one hostname the project manager is served on. It is a FIXED loopback
 * address, distinct from the `127.0.0.1:<port>` a project daemon serves, so the
 * plain origin — nothing inside the URL — is what selects the manager route.
 * It must stay equal to the host in `PROJECT_MANAGER_HOME`
 * (`v2/projects/project-boundary.tsx`), which is the link operators follow here.
 */
export const PROJECT_MANAGER_HOSTNAME = "127.0.0.2" as const;

/** The development-only query switch; it carries no authority, only a route. */
const PROJECT_MANAGER_QUERY_KEY = "projects";

/**
 * Decides whether this document is the project manager.
 *
 * Two selectors, deliberately asymmetric:
 * - The fixed manager HOST always selects it. A production build is reached only
 *   by being served on that origin, so the route needs no flag.
 * - `?projects=1` selects it ONLY while `development` is true. A production build
 *   must not let a query string move the operator onto the manager surface: the
 *   manager's authority is a same-origin cookie session established by
 *   `connectProjectManager`, so a query that reached the manager on a project
 *   origin would render a surface that can never legitimately connect.
 *
 * `search` is the query alone. The fragment is never consulted — it is not sent
 * to a server and `main.tsx` scrubs it before anything renders.
 */
export function isProjectManagerLocation(
  hostname: string,
  search: string,
  development: boolean,
): boolean {
  if (hostname === PROJECT_MANAGER_HOSTNAME) return true;
  return development && new URLSearchParams(search).get(PROJECT_MANAGER_QUERY_KEY) === "1";
}

/**
 * The production binding: the same decision against this build's development
 * flag. `import.meta.env.DEV` is a build-time constant, so the query branch is
 * eliminated outright from a production bundle rather than merely skipped.
 */
export function resolveProjectManagerMode(hostname: string, search: string): boolean {
  return isProjectManagerLocation(hostname, search, import.meta.env.DEV);
}
