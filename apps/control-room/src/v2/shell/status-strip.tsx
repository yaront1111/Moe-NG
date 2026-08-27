import type { CSSProperties, JSX } from "react";

import { StatusChip } from "../components/primitives.js";
import { CONNECTION_STATES, describeConnection } from "./shell-model.js";
import type { ConnectionDescriptor, ConnectionState } from "./shell-model.js";
import "../styles/cordum-status-strip.css";

/**
 * The bottom status strip: the DAEMON LINK label, a sparkline, the connection
 * chip, a stale marker, and - in fixtures mode only - a SIMULATE control for
 * cycling the connection states.
 *
 * It reports the link it has, and it credits whatever actually set the state it
 * shows: the daemon's last answer where one exists, the SIMULATE buttons in
 * fixtures, and nothing at all on the not-yet-attached surface. Every word this
 * file owns - the label, its tooltip, the SIMULATE titles - names the daemon
 * link. The vocabulary is still split elsewhere, out of this file's reach: the
 * OFFLINE banner sentence (`ConnectionBanner` below renders it verbatim) comes
 * from shell-model.ts and still says "event relay", and the label's class name
 * `cr2-relay-label` is styled by cordum-shell.css. Both are follow-ups for the
 * owners of those files, not claims this strip makes.
 *
 * The bars light with the connection (and a clock, since a heartbeat needs a time
 * source) but they never animate: no caller in this build has an event stream to
 * attach, so there is no flag to say one is, and motion that would imply arriving
 * frames stays off. The tooltip says so in words.
 */

/** Deterministic bar heights (px) - no clock, no randomness. */
const SPINE_HEIGHTS = Object.freeze(
  Array.from({ length: 11 }, (_, index) => 5 + ((index * 5) % 8)),
);

/**
 * Where the state on this strip came from - one sentence per source, never one
 * sentence for all of them. Crediting the daemon for a state no daemon answered
 * (OFFLINE, or a fixtures value the SIMULATE buttons set) is the same fabrication
 * the strip deleted when it retired the "EVENT RELAY" label.
 */
const SOURCE_TITLES = Object.freeze({
  offline: "Not attached to the daemon yet - nothing on this strip has been answered.",
  simulated: "Simulated connection state - the SIMULATE buttons set it, not the daemon.",
  daemon: "Connection state from the daemon's last answer.",
});

/** Why the lit bars hold still. True of every surface this build renders. */
const NO_STREAM_TITLE = "No live event stream is attached to this surface.";

function sourceTitle(key: ConnectionDescriptor["key"], simulatable: boolean): string {
  if (key === "OFFLINE") return SOURCE_TITLES.offline;
  return simulatable ? SOURCE_TITLES.simulated : SOURCE_TITLES.daemon;
}

export interface StatusStripProps {
  readonly descriptor: ConnectionDescriptor;
  readonly clockPresent: boolean;
  readonly simulatable?: boolean;
  readonly onSimulate?: ((state: ConnectionState) => void) | undefined;
}

export function StatusStrip({
  descriptor,
  clockPresent,
  simulatable = false,
  onSimulate,
}: StatusStripProps): JSX.Element {
  const live = descriptor.live && clockPresent;
  const title = `${sourceTitle(descriptor.key, simulatable)} ${NO_STREAM_TITLE}`;
  const style = { "--relay-tone": `var(${descriptor.toneVar})` } as CSSProperties;
  return (
    <footer
      className="cr2-statusstrip"
      data-clock={clockPresent ? "present" : "absent"}
      data-connection={descriptor.key}
      data-testid="cr.shell.statusstrip"
      style={style}
    >
      <span
        className="cr2-relay-label"
        data-testid="cr.shell.link.label"
        title={title}
      >
        DAEMON LINK
      </span>
      <span
        aria-hidden="true"
        className="cr2-spine"
        data-live={live ? "true" : undefined}
        data-testid="cr.shell.eventspine"
      >
        {SPINE_HEIGHTS.map((height, index) => (
          <i
            key={height + index * 100}
            style={{ height: `${height}px`, animationDelay: `${index * 0.14}s` } as CSSProperties}
          />
        ))}
      </span>
      <StatusChip label={descriptor.label} testId="cr.shell.connection" toneVar={descriptor.toneVar} />
      {descriptor.staleLabel === "" ? null : (
        <span className="cr2-stale" data-testid="cr.shell.stale">{descriptor.staleLabel}</span>
      )}

      {simulatable ? (
        <div className="cr2-simulate" data-testid="cr.shell.simulate">
          <span className="cr2-simulate-label">SIMULATE</span>
          {CONNECTION_STATES.map((state) => {
            const active = state === descriptor.key;
            return (
              <button
                aria-pressed={active}
                className="cr2-simulate-btn"
                data-active={active ? "true" : undefined}
                data-testid={`cr.shell.simulate.${state.toLowerCase()}`}
                key={state}
                onClick={() => onSimulate?.(state)}
                title={`Simulate a ${state} daemon link`}
                type="button"
              >
                {state.slice(0, 4)}
              </button>
            );
          })}
        </div>
      ) : null}
    </footer>
  );
}

/**
 * The banner beneath the context bar. CONNECTED renders nothing; every other
 * state (including the not-yet-attached OFFLINE) renders its own sentence in its
 * own tone. Sourced from the connection model, so the banner and the chip below
 * it can never disagree - which also means its wording is the model's, not this
 * file's (see the note above on the OFFLINE sentence).
 */
export function ConnectionBanner({ state }: { readonly state: ConnectionState | null }): JSX.Element | null {
  const descriptor = describeConnection(state);
  if (descriptor.banner === "") return null;
  const style = { "--chip-tone": `var(${descriptor.toneVar})` } as CSSProperties;
  return (
    <div
      className="cr2-banner"
      data-connection={descriptor.key}
      data-testid={`cr.banner.${descriptor.key.toLowerCase()}`}
      role="status"
      style={style}
    >
      <span className="cr2-banner-tag">{descriptor.label}</span>
      <span>{descriptor.banner}</span>
    </div>
  );
}
