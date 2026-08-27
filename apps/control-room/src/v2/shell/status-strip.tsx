import type { CSSProperties, JSX } from "react";

import { StatusChip } from "../components/primitives.js";
import { CONNECTION_STATES, describeConnection } from "./shell-model.js";
import type { ConnectionDescriptor, ConnectionState } from "./shell-model.js";
import "../styles/cordum-status-strip.css";

/**
 * The bottom status strip: the DAEMON LINK label, a sparkline, the connection
 * chip, a stale marker, and - in fixtures mode only - a SIMULATE control for
 * cycling the relay states.
 *
 * It reports the link it has, not a relay it does not, and it credits whatever
 * actually set the state it shows: the daemon's last answer where one exists, the
 * SIMULATE buttons in fixtures, and nothing at all on the not-yet-attached
 * surface. The strip never calls any of that an event relay.
 *
 * The bars light with the connection (and a clock, since a heartbeat needs a time
 * source) but they only ANIMATE when a caller states an event stream is attached.
 * Nothing in this build attaches one, so motion that would imply arriving frames
 * stays off by default.
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

/**
 * What the sparkline is doing, and why. `moving` is claimed only when the bars
 * really animate; `held` keeps a caller's stated stream intact on a link that is
 * not live, instead of denying the attachment the caller stated.
 */
const STREAM_TITLES = Object.freeze({
  moving: "A live event stream is attached: the bars move with its frames.",
  held: "A live event stream is attached; the bars hold still while the link is not live.",
  none: "No live event stream is attached to this surface.",
});

function sourceTitle(key: ConnectionDescriptor["key"], simulatable: boolean): string {
  if (key === "OFFLINE") return SOURCE_TITLES.offline;
  return simulatable ? SOURCE_TITLES.simulated : SOURCE_TITLES.daemon;
}

function streamTitle(streamAttached: boolean, streaming: boolean): string {
  if (!streamAttached) return STREAM_TITLES.none;
  return streaming ? STREAM_TITLES.moving : STREAM_TITLES.held;
}

export interface StatusStripProps {
  readonly descriptor: ConnectionDescriptor;
  readonly clockPresent: boolean;
  readonly simulatable?: boolean;
  readonly onSimulate?: ((state: ConnectionState) => void) | undefined;
  /** A caller that really has an event stream says so; nothing here assumes one. */
  readonly streamAttached?: boolean;
}

export function StatusStrip({
  descriptor,
  clockPresent,
  simulatable = false,
  onSimulate,
  streamAttached = false,
}: StatusStripProps): JSX.Element {
  const live = descriptor.live && clockPresent;
  const streaming = live && streamAttached;
  const title = `${sourceTitle(descriptor.key, simulatable)} ${streamTitle(streamAttached, streaming)}`;
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
        data-testid="cr.shell.relay.label"
        title={title}
      >
        DAEMON LINK
      </span>
      <span
        aria-hidden="true"
        className="cr2-spine"
        data-live={live ? "true" : undefined}
        data-stream={streaming ? "true" : undefined}
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
                title={`Simulate a ${state} relay`}
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
 * it can never disagree.
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
