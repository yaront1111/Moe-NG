import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";

import "./live-board.css";
import type { FixtureAffordanceSnapshot } from "../fixtures.js";
import { Fact } from "../kernel.js";
import { DocumentDossier } from "../preview/document-dossier.js";
import type { DocumentDossierState } from "../preview/document-dossier-state.js";
import { ShellFrame } from "../shell/frame.js";
import { LiveBoard } from "./live-board.js";
import { createBoardFeed } from "./live-board-feed.js";
import type { SurfaceFrame } from "./live-board-feed.js";
import { createLiveEventFeed } from "./live-event-feed.js";
import type { LiveFrame } from "./live-event-feed.js";
import {
  LIVE_DOCUMENT_DOSSIER_LOADING,
  createLiveDocumentDossierFeed,
} from "./live-document-dossier.js";
import { resolveLiveSetup } from "./live-config.js";
import type { LiveSetupResult } from "./live-config.js";

/**
 * DEVELOPMENT-ONLY live attachment: the shell rendered over what the daemon
 * actually says, and nothing else.
 *
 * The affordance snapshot is derived from the round trip alone: commands stay
 * EMPTY because the daemon serves no affordance surface yet, so every action
 * renders disabled — the fail-closed truth, not a limitation to paper over.
 * Event rows carry no wire truth class and therefore render UNKNOWN chips with
 * the kernel's ABSENT provenance note.
 */

const POLL_INTERVAL_MS = 2_000;

export function liveAffordance(frame: LiveFrame | null): FixtureAffordanceSnapshot {
  const connected = frame !== null && frame.connection === "CONNECTED";
  return Object.freeze({
    connection: connected ? "CONNECTED" : "DISCONNECTED",
    mutationsEnabled: false,
    nextAllowedCommands: [],
    requiresAffordanceRefresh: false,
    statusLabel: connected
      ? "Live event relay attached; the daemon serves no command affordances yet."
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
  const feed = useMemo(() => (setup.ok
    ? createLiveEventFeed({
      intervalMs: POLL_INTERVAL_MS,
      onFrame: setFrame,
      projection: setup.projection,
      subscriberId: setup.subscriberId,
      transport: setup.transport,
    })
    : null), [setup]);
  const boardFeed = useMemo(() => (setup.ok
    ? createBoardFeed({
      headers: setup.headers,
      intervalMs: POLL_INTERVAL_MS,
      onFrame: setSurface,
    })
    : null), [setup]);
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
      affordance={liveAffordance(frame)}
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
      navigationUnavailableReason="The live attachment is a single daemon workspace."
      projectionEnabled={false}
    >
      <div className="cr-workspace" data-testid="cr.live.workspace">
        <header className="cr-surface-lead">
          <p>Development live attachment</p>
          <h1>What the daemon says, as it says it.</h1>
          <span>
            The board is the daemon&apos;s own offer surface: dispatch or drag a
            ready card onto Committed to hand its affordance back. Cards move
            only when the ledger does.
          </span>
        </header>
        <LiveBoard
          client={setup.client}
          frame={surface}
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
