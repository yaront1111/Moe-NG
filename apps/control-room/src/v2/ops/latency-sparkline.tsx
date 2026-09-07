import type { JSX } from "react";

import type { EnvironmentLatencySeriesView } from "../../live/live-deployments-health.js";

/**
 * THE LATENCY SPARKLINE: the windowed probe series the daemon sent, drawn as INLINE SVG.
 *
 * NO CHARTING DEPENDENCY, deliberately. There is no chart precedent anywhere in this app
 * (`status-strip.tsx` calls its element a sparkline in a doc comment but renders eleven fixed-
 * height div bars), and one sparkline does not justify a bundle and a supply-chain edge.
 *
 * IT DERIVES NOTHING. It is handed a series and an environment name and NOTHING ELSE - no
 * state, no threshold, no colour keyed off a latency. Handing the browser a latency history is
 * exactly the temptation to recompute UP/DEGRADED/DOWN from it; the daemon owns that one
 * opinion, and this component is not given the material to disagree with it.
 *
 * THE WINDOW COMES FROM THE FRAME, never from a constant here. A component that named its own
 * sixty minutes would keep saying so after the daemon changed the window it actually sent.
 *
 * ITS NUMBERS ARE READABLE, not only drawable. A chart whose values exist solely as path
 * geometry can be neither asserted nor read by a screen reader, so the latencies travel as an
 * attribute and as text beside the line, and the SVG carries a real accessible name.
 *
 * DEGENERATE INPUTS ARE DAY-ONE INPUTS. A brand-new environment has ZERO probes; a just-probed
 * one has ONE; a steady one has ALL-IDENTICAL latencies. The first renders no SVG at all rather
 * than one full of NaN coordinates - a NaN in a `points` attribute draws nothing and looks
 * exactly like a working empty chart. The other two would each divide by a zero range, by
 * different routes (the x denominator is the point count, the y denominator is the latency
 * spread), so both are guarded and both are asserted separately.
 */

/** A fixed, unitless drawing box. CSS sizes the rendered element; geometry stays deterministic. */
const VIEWBOX_WIDTH = 120;
const VIEWBOX_HEIGHT = 24;
/** Keeps the stroke from being clipped at the extremes of the box. */
const VERTICAL_PADDING = 2;

/**
 * Min and max WITHOUT the spread operator. `Math.min(...latencies)` throws
 * `RangeError: Maximum call stack size exceeded` somewhere above 100k elements (measured), and
 * this array length arrives over the wire. The decoder already refuses an overlong series, so
 * this is the second of two independent guards rather than the only one.
 */
function extremes(latencies: readonly number[]): { readonly highest: number; readonly lowest: number } {
  let lowest = Number.POSITIVE_INFINITY;
  let highest = Number.NEGATIVE_INFINITY;
  for (const latencyMs of latencies) {
    if (latencyMs < lowest) lowest = latencyMs;
    if (latencyMs > highest) highest = latencyMs;
  }
  return { highest, lowest };
}

function plotted(latencies: readonly number[]): string {
  const { highest, lowest } = extremes(latencies);
  // Both denominators can be zero on real input: ONE point, and ALL-IDENTICAL latencies.
  const spread = highest - lowest;
  const steps = Math.max(1, latencies.length - 1);
  const usableHeight = VIEWBOX_HEIGHT - (VERTICAL_PADDING * 2);
  const midline = VERTICAL_PADDING + (usableHeight / 2);
  return latencies.map((latencyMs, index) => {
    const x = latencies.length === 1 ? VIEWBOX_WIDTH / 2 : (index / steps) * VIEWBOX_WIDTH;
    // A flat series sits on the midline rather than on an arbitrary edge; y grows downward, so
    // the HIGHEST latency is drawn at the TOP.
    const y = spread === 0
      ? midline
      : VERTICAL_PADDING + (usableHeight * (1 - ((latencyMs - lowest) / spread)));
    return `${String(round(x))},${String(round(y))}`;
  }).join(" ");
}

/** Two decimals: enough for a smooth line, short enough to keep the attribute readable. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function LatencySparkline({ environment, series, testId }: {
  readonly environment: string;
  readonly series: EnvironmentLatencySeriesView;
  readonly testId: string;
}): JSX.Element {
  const latencies = series.points.map((point) => point.latencyMs);
  // NOT named `window`: that shadows the global inside a browser component, and the next author
  // to reach for `window.matchMedia` here would get a string.
  const span = `${String(series.windowMinutes)} minutes`;
  if (latencies.length === 0) {
    return (
      <p className="cr2-approve-step-body" data-testid={`${testId}.empty`}>
        {`No latency recorded yet for ${environment} in the last ${span}.`}
      </p>
    );
  }
  const newest = latencies[latencies.length - 1] ?? 0;
  const { highest, lowest } = extremes(latencies);
  const label = `Probe latency for ${environment} over the last ${span}: `
    + `${String(latencies.length)} probes, newest ${String(newest)} ms, `
    + `lowest ${String(lowest)} ms, highest ${String(highest)} ms.`;
  return (
    <div className="cr2-spark" data-testid={`${testId}.root`}>
      <svg
        aria-label={label}
        className="cr2-spark-svg"
        data-latencies={latencies.join(",")}
        data-point-count={String(latencies.length)}
        data-testid={`${testId}.svg`}
        data-window-minutes={String(series.windowMinutes)}
        preserveAspectRatio="none"
        role="img"
        viewBox={`0 0 ${String(VIEWBOX_WIDTH)} ${String(VIEWBOX_HEIGHT)}`}
      >
        <title data-testid={`${testId}.title`}>{label}</title>
        <polyline
          className="cr2-spark-line"
          data-testid={`${testId}.line`}
          fill="none"
          points={plotted(latencies)}
        />
      </svg>
      <p className="cr2-approve-mono" data-testid={`${testId}.values`}>
        {`${String(newest)} ms now ${String(lowest)} ms low ${String(highest)} ms high`}
      </p>
    </div>
  );
}
