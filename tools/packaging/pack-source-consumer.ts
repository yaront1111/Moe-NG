/** Detect thenables without allowing a rejected callback result to become unhandled. */
export function isAsyncPackConsumerResult(value: unknown): boolean {
  let then: unknown;
  try {
    then = (typeof value === "object" && value !== null) || typeof value === "function"
      ? (value as { readonly then?: unknown }).then : undefined;
  } catch {
    return true;
  }
  if (typeof then !== "function") return false;
  try { void Promise.resolve(value).catch(() => undefined); } catch { /* closed result below */ }
  return true;
}
