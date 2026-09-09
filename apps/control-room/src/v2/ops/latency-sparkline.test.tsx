import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { EnvironmentLatencySeriesView } from "../../live/live-deployments-health.js";
import { LatencySparkline } from "./latency-sparkline.js";

/**
 * THE LATENCY SPARKLINE, at its own seam.
 *
 * Every arm here reads ATTRIBUTE VALUES rather than mere element presence. A NaN in a `points`
 * attribute renders as nothing at all, so an arm that only asserted the SVG existed would pass
 * for a chart that draws no line - which is precisely the failure the three degenerate inputs
 * produce and the reason they are asserted SEPARATELY: one combined arm cannot say which broke.
 *
 * PATHS ARE RESOLVED THROUGH `fileURLToPath`, never `new URL(relative, import.meta.url)`: under
 * jsdom the global `URL` resolves a relative specifier against the DOCUMENT base and yields
 * `http://localhost:3000/...`, which `readFileSync` rejects with "The URL must be of scheme
 * file". The same note is on `a11y/motion-inventory.test.ts`.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const TEST_ID = "cr.spark";

/**
 * Takes an ARRAY, not rest args. `seriesOf(...manyThousands)` spreads the array into the call
 * and throws `RangeError: Maximum call stack size exceeded` in the FIXTURE - which is the same
 * defect the large-series arm below exists to prove the COMPONENT does not have, and would have
 * been misread as the component failing.
 */
function seriesOf(latencies: readonly number[]): EnvironmentLatencySeriesView {
  const base = Date.parse("2026-09-07T09:00:00.000Z");
  return Object.freeze({
    points: latencies.map((latencyMs, index) =>
      Object.freeze({ at: new Date(base + (index * 60_000)).toISOString(), latencyMs })),
    windowMinutes: 60,
  });
}

const svg = (): SVGElement => screen.getByTestId(`${TEST_ID}.svg`) as unknown as SVGElement;
const line = (): SVGElement => screen.getByTestId(`${TEST_ID}.line`) as unknown as SVGElement;

/** Every attribute of every rendered element, so a NaN cannot hide in one nobody named. */
function allAttributeValues(root: Element): readonly string[] {
  const values: string[] = [];
  const walk = (node: Element): void => {
    for (const attribute of Array.from(node.attributes)) values.push(attribute.value);
    for (const child of Array.from(node.children)) walk(child);
  };
  walk(root);
  return values;
}

describe("the latency sparkline draws the series the frame carries", () => {
  it("plots one coordinate pair per point, in the order the frame states", () => {
    render(<LatencySparkline environment="production" series={seriesOf([10, 20, 30, 40])} testId={TEST_ID} />);
    const points = line().getAttribute("points") ?? "";
    expect(points.trim().split(/\s+/)).toHaveLength(4);
    expect(svg().getAttribute("data-point-count")).toBe("4");
  });

  it("keeps the latency values reachable as text, not only as path geometry", () => {
    render(<LatencySparkline environment="production" series={seriesOf([10, 20, 30])} testId={TEST_ID} />);
    expect(svg().getAttribute("data-latencies")).toBe("10,20,30");
    expect(screen.getByTestId(`${TEST_ID}.values`).textContent).toContain("30 ms");
    expect(screen.getByTestId(`${TEST_ID}.values`).textContent).toContain("10 ms");
  });

  it("gives the chart an accessible name that says what it plots and over what window", () => {
    render(<LatencySparkline environment="staging" series={seriesOf([5, 6])} testId={TEST_ID} />);
    const named = screen.getByRole("img", { name: /staging/i });
    expect(named.getAttribute("aria-label")).toContain("60 minutes");
    expect(screen.getByTestId(`${TEST_ID}.title`).textContent).toContain("staging");
  });

  it("states the window the FRAME carries rather than a constant of its own", () => {
    render(<LatencySparkline
      environment="production"
      series={{ points: seriesOf([1, 2]).points, windowMinutes: 15 }}
      testId={TEST_ID}
    />);
    expect(svg().getAttribute("aria-label")).toContain("15 minutes");
  });
});

describe("the latency sparkline survives the degenerate inputs it meets on day one", () => {
  /** DEGENERATE 1: a brand-new environment has NO probes. This is a day-one input, not an edge. */
  it("renders the empty state and emits NO SVG at all for zero points", () => {
    render(<LatencySparkline environment="production" series={seriesOf([])} testId={TEST_ID} />);
    expect(screen.getByTestId(`${TEST_ID}.empty`).textContent).toContain("No latency recorded yet");
    expect(screen.queryByTestId(`${TEST_ID}.svg`)).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("emits no NaN in any attribute for zero points", () => {
    const { container } = render(
      <LatencySparkline environment="production" series={seriesOf([])} testId={TEST_ID} />,
    );
    for (const value of allAttributeValues(container)) expect(value).not.toContain("NaN");
  });

  /** DEGENERATE 2: ONE point - the x denominator is `length - 1`, which is zero. */
  it("renders a single point without dividing by a zero x range", () => {
    render(<LatencySparkline environment="production" series={seriesOf([42])} testId={TEST_ID} />);
    const points = line().getAttribute("points") ?? "";
    expect(points).not.toContain("NaN");
    expect(points.trim().split(/\s+/)).toHaveLength(1);
    expect(svg().getAttribute("data-latencies")).toBe("42");
  });

  it("emits no NaN in any attribute for a single point", () => {
    const { container } = render(
      <LatencySparkline environment="production" series={seriesOf([42])} testId={TEST_ID} />,
    );
    for (const value of allAttributeValues(container)) expect(value).not.toContain("NaN");
  });

  /** DEGENERATE 3: ALL-IDENTICAL latencies - the y range is zero, the same divide by another route. */
  it("renders all-identical latencies without dividing by a zero y range", () => {
    render(<LatencySparkline environment="production" series={seriesOf([7, 7, 7, 7])} testId={TEST_ID} />);
    const points = line().getAttribute("points") ?? "";
    expect(points).not.toContain("NaN");
    expect(points.trim().split(/\s+/)).toHaveLength(4);
    expect(svg().getAttribute("data-latencies")).toBe("7,7,7,7");
  });

  it("emits no NaN in any attribute for all-identical latencies", () => {
    const { container } = render(
      <LatencySparkline environment="production" series={seriesOf([7, 7, 7, 7])} testId={TEST_ID} />,
    );
    for (const value of allAttributeValues(container)) expect(value).not.toContain("NaN");
  });

  /** All-zero latencies: identical AND zero, so a min-relative scale can divide by zero twice. */
  it("renders all-zero latencies, where the range and the values are both zero", () => {
    render(<LatencySparkline environment="production" series={seriesOf([0, 0])} testId={TEST_ID} />);
    expect(line().getAttribute("points")).not.toContain("NaN");
    expect(svg().getAttribute("data-latencies")).toBe("0,0");
  });

  /**
   * DEFENCE IN DEPTH behind the decoder bound. A spread-based min/max throws
   * `RangeError: Maximum call stack size exceeded` on an array this size (measured: 100000 ok,
   * 200000 throws), which would take the whole render down rather than degrade. This renders.
   */
  it("renders a series far larger than any real ring without exhausting the stack", () => {
    const many = Array.from({ length: 200_000 }, (_, index) => index % 977);
    expect(() => render(
      <LatencySparkline environment="production" series={seriesOf(many)} testId={TEST_ID} />,
    )).not.toThrow();
    expect(svg().getAttribute("data-point-count")).toBe("200000");
    expect(line().getAttribute("points")).not.toContain("NaN");
  });

  it("keeps every plotted coordinate a finite number inside the stated viewBox", () => {
    render(<LatencySparkline environment="production" series={seriesOf([3, 900, 12, 5])} testId={TEST_ID} />);
    const viewBox = (svg().getAttribute("viewBox") ?? "").split(" ").map(Number);
    const width = viewBox[2] ?? 0;
    const height = viewBox[3] ?? 0;
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    for (const pair of (line().getAttribute("points") ?? "").trim().split(/\s+/)) {
      const [x, y] = pair.split(",").map(Number);
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(width);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(height);
    }
  });
});

describe("the latency sparkline derives nothing from the series", () => {
  /**
   * TASK RAIL 1 AT THIS SEAM. The component is handed a series and NO state, so it cannot key a
   * colour, a class or a word off a threshold it invented. This arm reads the rendered source
   * for the state vocabulary rather than trusting the prop list: a component that computed
   * "DEGRADED" from a latency would have to say it somewhere.
   */
  it("names no health state anywhere in its output, however extreme the latencies", () => {
    const { container } = render(
      <LatencySparkline environment="production" series={seriesOf([1, 99_999])} testId={TEST_ID} />,
    );
    const rendered = container.innerHTML;
    for (const word of ["UP", "DOWN", "DEGRADED", "healthy", "unhealthy"]) {
      expect(rendered).not.toContain(word);
    }
  });

  /** DoD 4: no dependency was added for this chart. The manifest is asserted, not assumed. */
  it("adds no charting dependency - the control-room manifest names none", () => {
    const manifest = JSON.parse(
      readFileSync(join(HERE, "..", "..", "..", "package.json"), "utf8"),
    ) as { readonly dependencies?: Record<string, string>; readonly devDependencies?: Record<string, string> };
    const names = [
      ...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {}),
    ].join(" ");
    for (const charting of ["chart", "d3", "recharts", "victory", "nivo", "plotly", "sparkline", "visx"]) {
      expect(names).not.toContain(charting);
    }
  });

  /** The rail is INLINE SVG. A module that imported a renderer would satisfy every arm above. */
  it("imports no module to draw with - the source names only React and the frame type", () => {
    const source = readFileSync(join(HERE, "latency-sparkline.tsx"), "utf8");
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
    expect(imports).toEqual(["react", "../../live/live-deployments-health.js"]);
    expect(source).toContain("<svg");
  });
});
