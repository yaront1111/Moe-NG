import { BUDGET_COMMITMENT_READ_PATH } from "../http/budget-commitment-read.js";
import { WIRE_PROTOCOL_VERSION } from "../http/http-contract.js";
import type { SeedConfig } from "./demo-seed-env.js";
import { formatDaemonRefusal, readDaemonRefusal } from "./demo-seed-refusal.js";

/**
 * The seed's transport: one header set, one frame reader, one refusal echo.
 *
 * Split out of `demo-seed-main.ts` to keep both files under the per-file target.
 * It decides nothing about the seed's order — it only speaks HTTP and reports what
 * the daemon said.
 */

export type FetchLike = (url: string, init: {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: "POST";
}) => Promise<{ json(): Promise<unknown>; readonly status: number; text(): Promise<string> }>;

export type SeedOutcome =
  | { readonly commandIds: readonly string[]; readonly nodeRef: string; readonly ok: true }
  | { readonly code: string; readonly line: string; readonly ok: false };

export const MOE_SEED_TRANSPORT_FAILED = "MOE_SEED_TRANSPORT_FAILED" as const;
export const MOE_SEED_FRAME_UNREADABLE = "MOE_SEED_FRAME_UNREADABLE" as const;

export const failure = (code: string, line: string): SeedOutcome =>
  Object.freeze({ code, line, ok: false });

export const asObject = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export interface Wire {
  post(path: string, body: unknown): Promise<Record<string, unknown> | SeedOutcome>;
}

/** One transport, one header set: the three the listener guards demand plus Origin. */
export function wireFor(config: SeedConfig, fetchImpl: FetchLike): Wire {
  const headers = Object.freeze({
    "content-type": "application/json",
    origin: config.origin,
    "x-moe-csrf": config.csrfToken,
    "x-moe-protocol-version": WIRE_PROTOCOL_VERSION,
    "x-moe-session-credential": config.credential,
  });
  return {
    async post(path, body) {
      let raw: unknown;
      try {
        const response = await fetchImpl(`${config.origin}${path}`, {
          body: JSON.stringify(body),
          headers,
          method: "POST",
        });
        raw = await response.json();
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        return failure(MOE_SEED_TRANSPORT_FAILED, `${path} did not answer: ${detail}`);
      }
      const frame = asObject(raw);
      if (frame === null) {
        return failure(MOE_SEED_FRAME_UNREADABLE, `${path} answered with a non-object frame`);
      }
      return frame;
    },
  };
}

export const isOutcome = (value: Record<string, unknown> | SeedOutcome): value is SeedOutcome =>
  typeof (value as { ok?: unknown }).ok === "boolean" && "code" in value;

const BUDGET_COMMITMENT_STEP = "budget commitment read" as const;

export type SeedFailure = Extract<SeedOutcome, { readonly ok: false }>;

export type BudgetCommitmentOutcome = SeedFailure | { readonly ok: true; readonly ref: string };

/** `failure` narrowed to its refusal arm, so this seam needs no casts to stay total. */
const failed = (code: string, line: string): SeedFailure =>
  Object.freeze({ code, line, ok: false as const });

/**
 * The STORELESS half of this row: how a client with no `SqliteEventStore` obtains
 * the shared-builder commitment for a finalized run.
 *
 * It derives nothing and re-implements no refusal handling — the transport, the
 * frame reader and the refusal echo are all the ones already landed above. The
 * `COMMITMENT` outcome is checked BEFORE `refusalOutcome`, because that helper's
 * success roster is a closed list this route is not on; routing a successful
 * frame through it would read the commitment as a refusal with no code.
 */
export async function fetchBudgetCommitment(
  wire: Wire, runId: string,
): Promise<BudgetCommitmentOutcome> {
  const answered = await wire.post(BUDGET_COMMITMENT_READ_PATH, { runId });
  if (isOutcome(answered)) {
    // `post` only ever produces the REFUSAL arm (transport fault, unreadable frame). The
    // union permits a seed `ok:true` it cannot construct here, and that arm carries no
    // `ref` — so it is reported unreadable rather than given an invented commitment.
    return answered.ok
      ? failed(
        MOE_SEED_FRAME_UNREADABLE,
        `${BUDGET_COMMITMENT_STEP}: the transport answered a seed outcome, not a frame`,
      )
      : answered;
  }
  if (answered["outcome"] === "COMMITMENT") {
    const ref = answered["ref"];
    return typeof ref === "string"
      ? Object.freeze({ ok: true as const, ref })
      : failed(
        MOE_SEED_FRAME_UNREADABLE,
        `${BUDGET_COMMITMENT_STEP}: the commitment frame states no ref`,
      );
  }
  const refused = refusalOutcome(BUDGET_COMMITMENT_STEP, answered);
  if (refused !== null && !refused.ok) return refused;
  return failed(
    MOE_SEED_FRAME_UNREADABLE,
    `${BUDGET_COMMITMENT_STEP}: the daemon's frame states no code`,
  );
}

/** A refusal frame is the daemon's answer: echo its code and layer, add nothing. */
export function refusalOutcome(step: string, frame: Record<string, unknown>): SeedOutcome | null {
  if (frame["outcome"] === "ACCEPTED" || frame["outcome"] === "PAGE"
    || frame["outcome"] === "SURFACE" || frame["outcome"] === "ACKNOWLEDGED") {
    return null;
  }
  const echo = readDaemonRefusal(frame);
  if (echo === null) {
    return failure(MOE_SEED_FRAME_UNREADABLE, `${step}: the daemon's frame states no code`);
  }
  return failure(echo.code, formatDaemonRefusal(step, echo));
}
