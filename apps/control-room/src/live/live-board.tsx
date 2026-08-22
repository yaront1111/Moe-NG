import { useRef, useState } from "react";
import type { JSX } from "react";

import type { ControlRoomClientSurface, ControlRoomTransport } from "@moe/control-room-client";

import { dispatchAffordance, payloadFor } from "./live-dispatch.js";
import type { SurfaceFrame, SurfaceStep } from "./live-board-feed.js";

/**
 * The chain board: what the daemon offers, blocks, and has committed — and the
 * OPERATING SURFACE for all of it.
 *
 * Every step the daemon's own affordance surface marks READY, and this module's
 * dispatch companion can build a payload for, renders a Dispatch control: the
 * whole bootstrap chain is drivable from here, card by card, in the exact order
 * the daemon's prerequisite table admits — the runbook's "driving the chain by
 * hand — the live board" made literal. A step with no buildable payload (the
 * wrapper's `node.deliver`, whose author is a staffed agent, never a click)
 * renders as the fact it is and nothing more.
 *
 * Two things did NOT come back with the controls. There is still no drag
 * surface: dispatch is a button, its refusal renders under the card verbatim,
 * and nothing on this board moves a card — only the next surface poll does,
 * because only the ledger moves cards. And the board still decides nothing:
 * every click is answered by the daemon's own gates (authority, prerequisites,
 * versions), and a refusal IS the answer, rendered as such.
 */

export interface LiveBoardProps {
  readonly client: ControlRoomClientSurface;
  readonly frame: SurfaceFrame | null;
  readonly sessionCredential: string;
  readonly transport: Pick<ControlRoomTransport, "sendCommand">;
}

interface CardReport {
  readonly detail: string;
  readonly ok: boolean;
  readonly pending: boolean;
}

const COLUMNS = [
  { key: "READY", title: "Ready now" },
  { key: "BLOCKED", title: "Waiting on prerequisites" },
  { key: "COMMITTED", title: "Committed" },
] as const;

/**
 * The whole dispatch rule, in one place, exported so it can be swept over every
 * command kind rather than inferred from whichever fixture a test happened to
 * render. The board renders its control through this function and calls
 * `dispatchAffordance` from nowhere else, so a kind this refuses has no path out.
 *
 * READY is required as well as a buildable payload: a step the ledger has
 * already committed, or one still waiting on prerequisites, is a fact to read,
 * not an offer to hand back — and a kind the dispatch module cannot author
 * (`node.deliver`) gets no control at all.
 */
export function boardMayDispatch(step: SurfaceStep): boolean {
  return step.status === "READY" && payloadFor(step.kind, step.aggregateId, step.version) !== null;
}

function stepIdentity(step: SurfaceStep): string {
  return JSON.stringify([step.kind, step.aggregateId, step.version]);
}

function dispatchLabel(step: SurfaceStep): string {
  const target = step.aggregateId ?? "unscoped target";
  const version = step.version ?? "unknown";
  return `Dispatch ${step.kind} for ${target}, version ${version}`;
}

function offerFor(
  frame: SurfaceFrame, step: SurfaceStep,
): Record<string, unknown> | null {
  return frame.offers.find((offer) =>
    offer["commandKind"] === step.kind
    && offer["targetAggregateId"] === step.aggregateId
    && offer["expectedVersion"] === step.version) ?? null;
}

export function LiveBoard(props: LiveBoardProps): JSX.Element {
  const { client, frame, sessionCredential, transport } = props;
  const [reports, setReports] = useState<Readonly<Record<string, CardReport>>>({});
  const pendingDispatches = useRef(new Set<string>());

  if (frame === null) {
    return (
      <div className="cr-empty-state" data-testid="cr.liveboard.waiting">
        <span aria-hidden="true">●</span>
        <p>Waiting for the daemon&apos;s first affordance surface…</p>
      </div>
    );
  }
  if (frame.outcome !== "SURFACE") {
    return (
      <div
        aria-atomic="true"
        aria-live="polite"
        className="cr-empty-state"
        data-testid="cr.liveboard.refused"
        role="status"
      >
        <span aria-hidden="true">§</span>
        <p><code>{frame.detail === "" ? frame.outcome : frame.detail}</code></p>
      </div>
    );
  }

  const cardKey = (step: SurfaceStep): string => `${step.kind}@${step.aggregateId ?? "-"}`;

  const dispatch = async (step: SurfaceStep): Promise<void> => {
    const affordance = offerFor(frame, step);
    const key = stepIdentity(step);
    if (pendingDispatches.current.has(key)) return;
    if (affordance === null) {
      setReports((prior) => ({
        ...prior,
        [key]: { detail: "the daemon offers no command for this move", ok: false, pending: false },
      }));
      return;
    }
    pendingDispatches.current.add(key);
    setReports((prior) => ({
      ...prior, [key]: { detail: "dispatching…", ok: true, pending: true },
    }));
    const report = await dispatchAffordance({
      affordance, aggregateId: step.aggregateId, client, kind: step.kind,
      sessionCredential, transport, version: step.version,
    }).catch(() => ({
      detail: "TRANSPORT_REQUEST_FAILED", ok: false as const, stage: "UNDELIVERED" as const,
    }));
    pendingDispatches.current.delete(key);
    setReports((prior) => ({
      ...prior,
      [key]: {
        detail: `${report.stage}: ${report.detail}`, ok: report.ok, pending: false,
      },
    }));
  };

  return (
    <div data-testid="cr.liveboard">
      <div className="cr-liveboard-columns" data-testid="cr.liveboard.columns">
        {COLUMNS.map((column) => (
          <section
            aria-label={column.title}
            className="cr-liveboard-column"
            data-column={column.key}
            data-testid={`cr.liveboard.column.${column.key.toLowerCase()}`}
            key={column.key}
          >
            <h2>{column.title}</h2>
            {frame.steps.filter((step) => step.status === column.key).map((step) => {
              const key = cardKey(step);
              const identity = stepIdentity(step);
              const report = reports[identity];
              const dispatchPending = report?.pending === true;
              return (
                <article
                  className="cr-liveboard-card"
                  data-status={step.status}
                  data-testid={`cr.liveboard.card.${key}`}
                  key={identity}
                >
                  <header>
                    <span>{step.kind}</span>
                    {step.aggregateId === null ? null : <code>{step.aggregateId}</code>}
                  </header>
                  {step.version === null ? null : <small>version {step.version}</small>}
                  {step.claim === null ? null : (
                    // A live holder is a FACT about this step, stated where the
                    // dispatch decision is made: clicking races this claimant.
                    <small
                      className="cr-liveboard-claim"
                      data-testid={`cr.liveboard.claim.${key}`}
                    >
                      claimed by {step.claim.claimedBy} · until {step.claim.expiresAt}
                    </small>
                  )}
                  {step.status === "BLOCKED" ? (
                    <small data-testid={`cr.liveboard.missing.${step.kind}`}>
                      needs {step.missing.join(", ")}
                    </small>
                  ) : null}
                  {boardMayDispatch(step) ? (
                    <button
                      aria-label={dispatchLabel(step)}
                      data-testid={`cr.liveboard.dispatch.${step.kind}`}
                      disabled={dispatchPending}
                      onClick={() => { void dispatch(step); }}
                      type="button"
                    >
                      Dispatch
                    </button>
                  ) : null}
                  {report === undefined ? null : (
                    <p
                      aria-atomic="true"
                      aria-live="polite"
                      data-ok={String(report.ok)}
                      data-testid={`cr.liveboard.report.${key}`}
                      role="status"
                    >
                      {report.detail}
                    </p>
                  )}
                </article>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}
