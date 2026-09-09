/** Public repository ownership facts from /health/read; no authority or recovery control. */
export type RepositoryReservationView =
  | { readonly code: null; readonly owner: { readonly nodeRef: string; readonly projectId: string }; readonly phase: string; readonly status: "HELD" }
  | { readonly code: null; readonly owner: null; readonly phase: null; readonly status: "IDLE" }
  | { readonly code: string; readonly owner: null; readonly phase: null; readonly status: "UNKNOWN" };

function exact(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length || own.some((key) => typeof key !== "string" || !keys.includes(key))) return null;
    const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
      copy[key] = descriptor.value;
    }
    return Object.freeze(copy);
  } catch { return null; }
}

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** Reject contradictory states, absent facts and extra authority-bearing members. */
export function repositoryReservationOf(value: unknown): RepositoryReservationView | null {
  const row = exact(value, ["code", "owner", "phase", "status"]);
  if (row === null) return null;
  if (row.status === "UNKNOWN") {
    return text(row.code) && row.owner === null && row.phase === null
      ? Object.freeze({ code: row.code, owner: null, phase: null, status: "UNKNOWN" }) : null;
  }
  if (row.status === "IDLE") {
    return row.code === null && row.owner === null && row.phase === null
      ? Object.freeze({ code: null, owner: null, phase: null, status: "IDLE" }) : null;
  }
  if (row.status !== "HELD" || row.code !== null || !text(row.phase)) return null;
  const owner = exact(row.owner, ["nodeRef", "projectId"]);
  if (owner === null || !text(owner.nodeRef) || !text(owner.projectId)) return null;
  return Object.freeze({
    code: null, owner: Object.freeze({ nodeRef: owner.nodeRef, projectId: owner.projectId }), phase: row.phase, status: "HELD",
  });
}
