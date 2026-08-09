import { useState } from "react";
import type { DragEvent, JSX } from "react";

import type { ControlRoomClientSurface, ControlRoomTransport } from "@moe/control-room-client";

import { dispatchAffordance } from "./live-dispatch.js";
import type { SurfaceFrame, SurfaceStep } from "./live-board-feed.js";

/**
 * The chain board: what the daemon offers, blocks, and has committed — and the
 * one interaction the truth model allows: handing a daemon-minted affordance
 * back to the daemon. Dragging a READY card onto Committed dispatches exactly
 * that; the card itself only moves when the next surface poll says the ledger
 * moved. Any other drop refuses visibly with the reason.
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
}

const COLUMNS = [
  { key: "READY", title: "Ready now" },
  { key: "BLOCKED", title: "Waiting on prerequisites" },
  { key: "COMMITTED", title: "Committed" },
] as const;

function offerFor(
  frame: SurfaceFrame, step: SurfaceStep,
): Record<string, unknown> | null {
  return frame.offers.find((offer) =>
    offer["commandKind"] === step.kind
    && (step.aggregateId === null || offer["targetAggregateId"] === step.aggregateId)) ?? null;
}

export function LiveBoard(props: LiveBoardProps): JSX.Element {
  const { client, frame, sessionCredential, transport } = props;
  const [reports, setReports] = useState<Readonly<Record<string, CardReport>>>({});
  const [dropNote, setDropNote] = useState("");

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
      <div className="cr-empty-state" data-testid="cr.liveboard.refused">
        <span aria-hidden="true">§</span>
        <p><code>{frame.detail === "" ? frame.outcome : frame.detail}</code></p>
      </div>
    );
  }

  const cardKey = (step: SurfaceStep): string => `${step.kind}@${step.aggregateId ?? "-"}`;

  const dispatch = async (step: SurfaceStep): Promise<void> => {
    const affordance = offerFor(frame, step);
    const key = cardKey(step);
    if (affordance === null) {
      setReports((prior) => ({
        ...prior, [key]: { detail: "the daemon offers no command for this move", ok: false },
      }));
      return;
    }
    setReports((prior) => ({ ...prior, [key]: { detail: "dispatching…", ok: true } }));
    const report = await dispatchAffordance({
      affordance, aggregateId: step.aggregateId, client,
      kind: step.kind, sessionCredential, transport,
    });
    setReports((prior) => ({
      ...prior, [key]: { detail: `${report.stage}: ${report.detail}`, ok: report.ok },
    }));
  };

  const onDropCommitted = (event: DragEvent): void => {
    event.preventDefault();
    const kind = event.dataTransfer.getData("text/moe-kind");
    const step = frame.steps.find(
      (entry) => entry.status === "READY" && entry.kind === kind,
    );
    if (step === undefined) {
      setDropNote("the daemon offers no command for this move");
      return;
    }
    setDropNote("");
    void dispatch(step);
  };

  const refuseDrop = (event: DragEvent): void => {
    event.preventDefault();
    setDropNote("the daemon offers no command for this move");
  };

  return (
    <div data-testid="cr.liveboard">
      {dropNote === "" ? null : (
        <p data-testid="cr.liveboard.dropnote" role="status">{dropNote}</p>
      )}
      <div className="cr-liveboard-columns" data-testid="cr.liveboard.columns">
        {COLUMNS.map((column) => (
          <section
            aria-label={column.title}
            className="cr-liveboard-column"
            data-column={column.key}
            data-testid={`cr.liveboard.column.${column.key.toLowerCase()}`}
            key={column.key}
            onDragOver={(event) => { event.preventDefault(); }}
            onDrop={column.key === "COMMITTED" ? onDropCommitted : refuseDrop}
          >
            <h2>{column.title}</h2>
            {frame.steps.filter((step) => step.status === column.key).map((step) => {
              const key = cardKey(step);
              const report = reports[key];
              return (
                <article
                  className="cr-liveboard-card"
                  data-status={step.status}
                  data-testid={`cr.liveboard.card.${key}`}
                  draggable={step.status === "READY"}
                  key={key}
                  onDragStart={(event) => {
                    event.dataTransfer.setData("text/moe-kind", step.kind);
                  }}
                >
                  <header>
                    <span>{step.kind}</span>
                    {step.aggregateId === null ? null : <code>{step.aggregateId}</code>}
                  </header>
                  {step.version === null ? null : <small>version {step.version}</small>}
                  {step.status === "BLOCKED" ? (
                    <small data-testid={`cr.liveboard.missing.${step.kind}`}>
                      needs {step.missing.join(", ")}
                    </small>
                  ) : null}
                  {step.status === "READY" ? (
                    <button
                      data-testid={`cr.liveboard.dispatch.${step.kind}`}
                      onClick={() => { void dispatch(step); }}
                      type="button"
                    >
                      Dispatch
                    </button>
                  ) : null}
                  {report === undefined ? null : (
                    <p
                      data-ok={String(report.ok)}
                      data-testid={`cr.liveboard.report.${key}`}
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
