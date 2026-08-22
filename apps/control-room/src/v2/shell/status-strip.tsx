import type { CSSProperties, JSX } from "react";

import { StatusChip } from "../components/primitives.js";
import { CONNECTION_STATES, describeConnection } from "./shell-model.js";
import type { ConnectionDescriptor, ConnectionState } from "./shell-model.js";

/**
 * The bottom status strip: the EVENT RELAY label, a sparkline whose liveness
 * reflects both the connection state and whether the app has a time source, the
 * connection chip, a stale marker, and - in fixtures mode only - a SIMULATE
 * control for cycling the relay states.
 *
 * The sparkline animates only when the relay is live AND a clock is present: with
 * no time source the app cannot claim a heartbeat, so the bars sit still rather
 * than implying motion the shell cannot measure.
 */

/** Deterministic bar heights (px) - no clock, no randomness. */
const SPINE_HEIGHTS = Object.freeze(
  Array.from({ length: 11 }, (_, index) => 5 + ((index * 5) % 8)),
);

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
  const style = { "--relay-tone": `var(${descriptor.toneVar})` } as CSSProperties;
  return (
    <footer
      className="cr2-statusstrip"
      data-clock={clockPresent ? "present" : "absent"}
      data-connection={descriptor.key}
      data-testid="cr.shell.statusstrip"
      style={style}
    >
      <span className="cr2-relay-label">EVENT RELAY</span>
      <span aria-hidden="true" className="cr2-spine" data-live={live ? "true" : undefined} data-testid="cr.shell.eventspine">
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
