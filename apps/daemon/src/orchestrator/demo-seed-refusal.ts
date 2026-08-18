/**
 * The wire-refusal half of the demo seed: read what the daemon said, echo it
 * verbatim, invent nothing.
 *
 * Split out of `demo-seed-plan.ts` to keep both files under the per-file target.
 * Pure over its input; the client module owns the transport.
 */

/** Where the refusal was stated, so the echo can say which shape it read. */
export type DaemonRefusalSource = "ERROR" | "LISTENER" | "PORT";

export interface DaemonRefusalEcho {
  readonly code: string;
  readonly detail: string | null;
  /** Null when the daemon named no layer — a plausible one is never invented. */
  readonly layer: string | null;
  readonly source: DaemonRefusalSource;
  readonly stage: string | null;
}

const stringOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const objectOrNull = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function echo(
  source: DaemonRefusalSource,
  body: Record<string, unknown>,
  stage: string | null,
): DaemonRefusalEcho | null {
  const code = stringOrNull(body["code"]);
  if (code === null) return null;
  return Object.freeze({
    code,
    detail: stringOrNull(body["detail"]),
    layer: stringOrNull(body["layer"]),
    source,
    stage,
  });
}

/**
 * Reads the three refusal shapes this daemon actually serves — a flat listener
 * `{code, layer}`, a `PORT_REFUSED` frame carrying the port's own code and layer,
 * and a `REFUSED` frame whose `RuntimeError` states a code and a stage but no
 * layer. Anything else is unreadable, and unreadable is NOT a refusal code.
 */
export function readDaemonRefusal(body: unknown): DaemonRefusalEcho | null {
  const frame = objectOrNull(body);
  if (frame === null) return null;
  const stage = stringOrNull(frame["stage"]);
  const refusal = objectOrNull(frame["refusal"]);
  if (refusal !== null) return echo("PORT", refusal, stage);
  const error = objectOrNull(frame["error"]);
  if (error !== null) return echo("ERROR", error, stage);
  return echo("LISTENER", frame, stage);
}

/** One line an operator can paste into a bug report; both daemon fields verbatim. */
export function formatDaemonRefusal(step: string, refusal: DaemonRefusalEcho): string {
  const parts = [
    `refused at ${step}:`,
    `code=${refusal.code}`,
    `layer=${refusal.layer ?? "(none stated)"}`,
    `stage=${refusal.stage ?? "(none stated)"}`,
    `source=${refusal.source}`,
  ];
  if (refusal.detail !== null) parts.push(`detail=${refusal.detail}`);
  return parts.join(" ");
}
