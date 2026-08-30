import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";

import "./live-board.css";
import type { FixtureAffordanceSnapshot } from "../fixtures.js";
import { Fact } from "../kernel.js";
import { DocumentDossier } from "../preview/document-dossier.js";
import type { DocumentDossierState } from "../preview/document-dossier-state.js";
import { ShellFrame } from "../shell/frame.js";
import { useClock } from "../performance/command-latency.js";
import { LiveBoard } from "./live-board.js";
import { LiveCommandTiming } from "./live-command-timing.js";
import { createBoardFeed } from "./live-board-feed.js";
import type { SurfaceFrame } from "./live-board-feed.js";
import { createLiveEventFeed } from "./live-event-feed.js";
import type { LiveFrame } from "./live-event-feed.js";
import {
  LIVE_DOCUMENT_DOSSIER_LOADING,
  createLiveDocumentDossierFeed,
} from "./live-document-dossier.js";
import { readBudgetCommitment } from "./live-budget-commitment.js";
import { resolveLiveSetup } from "./live-config.js";
import type { LiveSetupResult } from "./live-config.js";

/**
 * The live attachment: the shell rendered over what the daemon actually says,
 * and nothing else. It is the DEFAULT surface — see `shell-mode.ts`.
 *
 * The shell's affordance snapshot keeps its OWN command set empty: every offer
 * the board hands back is dispatched by the board itself, and no shell action is
 * wired to a daemon command, so every shell action
 * renders disabled — the fail-closed truth, not a limitation to paper over. The status label, however, is a statement about
 * the daemon and must agree with the board rendered under it, so it is derived
 * from the affordance surface as well as the event relay. Event rows carry no
 * wire truth class and therefore render UNKNOWN chips with the kernel's ABSENT
 * provenance note.
 */

const POLL_INTERVAL_MS = 2_000;

function surfaceLabel(surface: SurfaceFrame | null): string {
  if (surface === null || surface.connection !== "CONNECTED") {
    return "the affordance surface has not answered yet.";
  }
  // A refusal or an unreadable answer also carries zero offers, but "serves no
  // affordances" is a statement about the BOARD, not about a failed read.
  if (surface.outcome !== "SURFACE") {
    return `the affordance surface answered ${surface.outcome}.`;
  }
  const count = surface.offers.length;
  if (count === 0) return "the daemon serves no command affordances right now.";
  return `the daemon offers ${String(count)} command affordance${count === 1 ? "" : "s"} on the board.`;
}

export function liveAffordance(
  frame: LiveFrame | null,
  surface: SurfaceFrame | null = null,
): FixtureAffordanceSnapshot {
  const connected = frame !== null && frame.connection === "CONNECTED";
  return Object.freeze({
    connection: connected ? "CONNECTED" : "DISCONNECTED",
    mutationsEnabled: false,
    nextAllowedCommands: [],
    requiresAffordanceRefresh: false,
    statusLabel: connected
      ? `Live event relay attached; ${surfaceLabel(surface)}`
      : "Live mode: the daemon has not answered yet. Actions stay visible and disabled.",
  });
}

export function LiveTimeline({ frame }: { readonly frame: LiveFrame | null }): JSX.Element {
  if (frame === null) {
    return (
      <div className="cr-empty-state" data-testid="cr.live.waiting">
        <span aria-hidden="true">●</span>
        <p>Waiting for the first daemon answer…</p>
      </div>
    );
  }
  return (
    <div data-testid="cr.live.timeline">
      <div className="cr-workspace-brief">
        <Fact
          factId="live.connection"
          label="Relay round trip"
          truthClass="OBSERVED"
          value={frame.connection === "CONNECTED"
            ? "Daemon answered"
            : `Undelivered: ${frame.detail}`}
        />
        <Fact
          factId="live.outcome"
          label="Page outcome"
          truthClass="OBSERVED"
          value={frame.detail === "" ? frame.outcome : `${frame.outcome} — ${frame.detail}`}
        />
        {frame.checkpoint !== null ? (
          <Fact
            factId="live.checkpoint" label="Ledger checkpoint"
            truthClass="OBSERVED" value={frame.checkpoint}
          />
        ) : null}
      </div>
      <LiveCommandTiming frame={frame} />
      {frame.events.length > 0 ? (
        <ol className="cr-timeline-preview" data-testid="cr.live.events">
          {frame.events.map((event) => (
            <li key={event.eventId}>
              <Fact
                factId={`live.event.${event.eventId}`}
                label={`#${event.position} ${event.eventType}`}
                value={`${event.aggregateId} at ${event.committedAt}`}
              />
            </li>
          ))}
        </ol>
      ) : null}
      {frame.events.length === 0 && frame.outcome === "PAGE" ? (
        <div className="cr-empty-state" data-testid="cr.live.empty">
          <span aria-hidden="true">│</span>
          <p>
            The relay is seated and current: no events have landed after the
            reader&apos;s cursor yet. Commit one and it appears here.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function LiveRefusedPanel({ result }: { readonly result: LiveSetupResult }): JSX.Element {
  if (result.ok) return <></>;
  return (
    <section data-testid="cr.live.refused">
      <h1>Live mode refused</h1>
      <p>
        <code>{result.code}</code>: {result.detail}
      </p>
    </section>
  );
}

export interface LiveControlRoomProps {
  /** Injectable for tests; production resolves from Vite env + the dev report. */
  readonly setup: LiveSetupResult;
}

export function LiveControlRoom({ setup }: LiveControlRoomProps): JSX.Element {
  const [documentView, setDocumentView] = useState<{
    readonly setup: LiveSetupResult;
    readonly state: DocumentDossierState;
  }>(() => ({ setup, state: LIVE_DOCUMENT_DOSSIER_LOADING }));
  const documentDossier = documentView.setup === setup
    ? documentView.state : LIVE_DOCUMENT_DOSSIER_LOADING;
  const [frame, setFrame] = useState<LiveFrame | null>(null);
  const [surface, setSurface] = useState<SurfaceFrame | null>(null);
  // The composition root's clock, handed to the feed so the arrival reading is taken on
  // the same scale the render reading is. With no provider the feed records
  // TIMING_CLOCK_UNAVAILABLE rather than implying that no time passed.
  const clock = useClock();
  const feed = useMemo(() => (setup.ok
    ? createLiveEventFeed({
      clock,
      intervalMs: POLL_INTERVAL_MS,
      onFrame: setFrame,
      projection: setup.projection,
      subscriberId: setup.subscriberId,
      transport: setup.transport,
    })
    : null), [clock, setup]);
  const boardFeed = useMemo(() => (setup.ok
    ? createBoardFeed({
      headers: setup.headers,
      intervalMs: POLL_INTERVAL_MS,
      onFrame: setSurface,
    })
    : null), [setup]);
  // The board's budget-commitment reader, built HERE because this is where the authenticated
  // header set lives; the board and the dispatch module only carry it. Absent while the setup
  // is refused, which is the same state in which no board renders at all.
  const budgetCommitmentReader = useMemo(() => (setup.ok
    ? (runId: string) => readBudgetCommitment(setup.headers, runId)
    : undefined), [setup]);
  const documentFeed = useMemo(() => (setup.ok
    ? createLiveDocumentDossierFeed({
      intervalMs: POLL_INTERVAL_MS,
      onState: (state) => { setDocumentView({ setup, state }); },
      transport: setup.transport,
    })
    : null), [setup]);

  useEffect(() => {
    feed?.start();
    boardFeed?.start();
    documentFeed?.start();
    return (): void => { feed?.stop(); boardFeed?.stop(); documentFeed?.stop(); };
  }, [feed, boardFeed, documentFeed]);

  if (!setup.ok) return <LiveRefusedPanel result={setup} />;
  return (
    <ShellFrame
      affordance={liveAffordance(frame, surface)}
      contextEyebrow="Event relay"
      contextTitle="Live daemon feed"
      inspector={
        <div>
          <div className="cr-preview-mode" data-testid="cr.live.mode">
            <span>Live attachment</span>
            <strong>Reading the daemon&apos;s own ledger</strong>
            <code>{setup.projection} / {setup.subscriberId}</code>
          </div>
          <p className="cr-inspector-hint">
            Rows carry no wire truth class, so their chips honestly read UNKNOWN
            until the daemon states one.
          </p>
        </div>
      }
      navigationBlockedReason="The live attachment is a single daemon workspace."
      projectionEnabled={false}
    >
      <div className="cr-workspace" data-testid="cr.live.workspace">
        <header className="cr-surface-lead">
          <p>Development live attachment</p>
          <h1>What the daemon says, as it says it.</h1>
          <span>
            The board is the daemon&apos;s own offer surface, and the operating
            one: every step the daemon marks ready dispatches from its card, the
            daemon&apos;s own gates answer every click, and a refusal renders
            verbatim as the answer it is. Cards move only when the ledger does.
          </span>
        </header>
        <LiveBoard
          client={setup.client}
          frame={surface}
          readBudgetCommitment={budgetCommitmentReader}
          sessionCredential={setup.sessionCredential}
          transport={setup.transport}
        />
        <DocumentDossier state={documentDossier} />
        <LiveTimeline frame={frame} />
      </div>
    </ShellFrame>
  );
}

declare global {
  // Injected by vite.config.ts from the generated pins; absent in test builds.
  const __MOE_DEV_COMPAT_REPORT__: unknown;
}

export function resolveLiveSetupFromBuild(): LiveSetupResult {
  const report = typeof __MOE_DEV_COMPAT_REPORT__ === "undefined"
    ? null
    : __MOE_DEV_COMPAT_REPORT__;
  return resolveLiveSetup(
    import.meta.env as unknown as Parameters<typeof resolveLiveSetup>[0],
    report,
  );
}
