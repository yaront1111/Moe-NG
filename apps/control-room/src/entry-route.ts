/** Query selectors that expose development fixtures or the legacy demo shell. */
const DEVELOPMENT_ONLY_QUERY_KEYS = Object.freeze(["fixtures", "v1"] as const);

/**
 * Remove development-only selectors before production routing. Other query
 * state, including the project-manager route, remains intact.
 */
export function gateDevelopmentQuery(search: string, development: boolean): string {
  if (development) return search;
  const params = new URLSearchParams(search);
  for (const key of DEVELOPMENT_ONLY_QUERY_KEYS) params.delete(key);
  const encoded = params.toString();
  if (encoded.length === 0) return "";
  return `${search.startsWith("?") ? "?" : ""}${encoded}`;
}
