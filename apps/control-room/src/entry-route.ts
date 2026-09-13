/**
 * Discard the retired interface selector on every build. Fixtures remain
 * development-only; non-secret product and manager query state stays intact.
 */
export function gateDevelopmentQuery(search: string, development: boolean): string {
  const params = new URLSearchParams(search);
  if (development && !params.has("v1")) return search;
  params.delete("v1");
  if (!development) params.delete("fixtures");
  const encoded = params.toString();
  if (encoded.length === 0) return "";
  return `${search.startsWith("?") ? "?" : ""}${encoded}`;
}
