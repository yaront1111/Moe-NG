import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { mapDeploymentsHealthAnswer } from "../../live/live-deployments-health.js";
import { MIDDOT } from "../glyphs.js";
import { EnvironmentsSection } from "./environments-section.js";

/**
 * THE DAEMON FRAME, THE DECODER AND THE CARD, LINKED DURABLY.
 *
 * Every other arm on this surface hands the decoder a body a HUMAN wrote to match the route. That
 * proves the decoder reads what the test author believed, which is exactly the belief a daemon
 * change invalidates: rename a member on the route and the hand-built body still decodes, still
 * renders, and the surface breaks only in front of an operator.
 *
 * So the served roster is READ OFF THE ROUTE'S OWN DECLARATION at
 * `apps/daemon/src/http/deployments-health-read.ts` and the frame below is BUILT FROM IT. The
 * link is bidirectional and both directions red:
 *   - the daemon ADDS or RENAMES a member -> the roster grows a name this file has no value for,
 *     and frame assembly throws naming it;
 *   - the daemon REMOVES a member -> this file still offers a value the route no longer serves,
 *     and the set-equality arm reds;
 *   - the decoder stops matching the route -> the render arm and the per-key drop arms red.
 *
 * The roster is read as TEXT rather than imported: `@moe/daemon` is not a dependency of this
 * package, and a deep relative import across the workspace fails with TS6059. Every extraction
 * below therefore carries a CONTROL that it found something - a regex that silently stopped
 * matching would otherwise make this whole file a sweep over zero cases.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const DAEMON_ROUTE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../daemon/src/http/deployments-health-read.ts",
);
const SOURCE = readFileSync(DAEMON_ROUTE, "utf8");

/** The text between a declaration header and its closer, or a throw naming what went missing. */
function blockOf(source: string, header: string, closer: string): string {
  const start = source.indexOf(header);
  if (start < 0) throw new Error(`the daemon route no longer declares: ${header}`);
  const body = source.slice(start + header.length);
  const end = body.indexOf(closer);
  if (end < 0) throw new Error(`declaration never closes: ${header}`);
  return body.slice(0, end);
}

function membersOf(block: string, pattern: RegExp): readonly string[] {
  return [...block.matchAll(pattern)].map((match) => match[1] ?? "").sort();
}

const VIEW_BLOCK = blockOf(SOURCE, "export interface DeploymentsHealthView {", "\n}");
/** Own members at exactly two spaces: the nested ones sit deeper and are read separately below. */
const VIEW_KEYS = membersOf(VIEW_BLOCK, /^ {2}readonly ([A-Za-z][A-Za-z0-9]*)\??:/gmu);
const SERIES_KEYS = membersOf(
  blockOf(VIEW_BLOCK, "readonly latencySeries: {", "\n  };"),
  /^ {4}readonly ([A-Za-z][A-Za-z0-9]*)\??:/gmu,
);
/**
 * `lastProbe` is a union written INLINE, so its members are read to the start of the next
 * top-level member rather than to the first semicolon - the semicolons inside the inline object
 * would otherwise close the block after its first member and leave a one-name roster.
 */
const PROBE_KEYS = membersOf(
  blockOf(VIEW_BLOCK, "readonly lastProbe:", "\n  readonly "),
  /readonly ([A-Za-z][A-Za-z0-9]*)\??:/gu,
);
const POINT_KEYS = membersOf(
  blockOf(SOURCE, "export interface DeploymentsHealthSeriesPoint {", "\n}"),
  /^ {2}readonly ([A-Za-z][A-Za-z0-9]*)\??:/gmu,
);

/** The last-hour window is the ROUTE's constant, not a number this surface chose. */
const WINDOW_MINUTES = Number(
  /export const DEPLOYMENTS_HEALTH_SERIES_WINDOW_MINUTES = (\d+);/u.exec(SOURCE)?.[1] ?? "",
);

const AT = "2026-09-07T09:55:00.000Z";
const NOW = Date.parse("2026-09-07T10:00:00.000Z");

/**
 * One value per member the ROUTE declares, keyed by the route's own names. It is never spread
 * into the frame wholesale: the frame is assembled by walking the extracted roster, so a member
 * this table does not answer for is a loud throw rather than a quietly absent key.
 */
const VALUE_BY_KEY: Readonly<Record<string, unknown>> = Object.freeze({
  environment: "production",
  incident: { id: 7, openedAt: "2026-09-07T09:40:00.000Z" },
  lastError: null,
  lastProbe: { at: AT, latencyMs: 91, status: "SUCCESS" },
  latencySeries: {
    points: [
      { at: "2026-09-07T09:53:00.000Z", latencyMs: 80 },
      { at: "2026-09-07T09:54:00.000Z", latencyMs: 85 },
      { at: AT, latencyMs: 91 },
    ],
    windowMinutes: WINDOW_MINUTES,
  },
  ok: true,
  probeIntervalMs: 60_000,
  probeRefusal: null,
  rollbackSha: null,
  state: "UP",
});

/** The served body, assembled FROM the route's roster rather than written out beside it. */
function servedFrame(omit?: string): Record<string, unknown> {
  const frame: Record<string, unknown> = {};
  for (const key of VIEW_KEYS) {
    if (!(key in VALUE_BY_KEY)) {
      throw new Error(`the daemon route serves a member this test has no value for: ${key}`);
    }
    if (key !== omit) frame[key] = VALUE_BY_KEY[key];
  }
  return frame;
}

describe("the roster this surface renders is the roster the daemon route declares", () => {
  it("reads a non-empty roster off the route, so every arm below sweeps real names", () => {
    // CONTROLS. Each extraction is a regex over source text; one that stopped matching would
    // return an empty list and make its arms pass without testing anything.
    expect(VIEW_KEYS.length).toBeGreaterThan(0);
    expect(VIEW_KEYS).toContain("state");
    expect(SERIES_KEYS).toEqual(["points", "windowMinutes"]);
    expect(PROBE_KEYS).toEqual(["at", "latencyMs", "status"]);
    expect(POINT_KEYS).toEqual(["at", "latencyMs"]);
    expect(WINDOW_MINUTES).toBeGreaterThan(0);
  });

  it("offers a value for every served member and serves every member it offers", () => {
    // BOTH DIRECTIONS. Subset either way would let a removed member linger here, or a new one
    // arrive unnoticed; only set-equality catches both.
    expect(Object.keys(VALUE_BY_KEY).sort()).toEqual([...VIEW_KEYS]);
  });

  it.each(VIEW_KEYS)("refuses the frame when the route member %s is missing", (key) => {
    const answer = mapDeploymentsHealthAnswer(200, servedFrame(key));
    expect(answer.status).toBe("ERROR");
    if (answer.status === "ERROR") {
      expect(answer.code).toBe("DEPLOYMENTS_HEALTH_RESPONSE_INVALID");
      expect(answer.layer).toBe("CONTROL_ROOM_DEPLOYMENTS_HEALTH");
    }
  });

  it("refuses a frame carrying a member the route does not serve", () => {
    const answer = mapDeploymentsHealthAnswer(200, { ...servedFrame(), probeBudgetMs: 5_000 });
    expect(answer.status).toBe("ERROR");
    if (answer.status === "ERROR") expect(answer.code).toBe("DEPLOYMENTS_HEALTH_RESPONSE_INVALID");
  });
});

describe("the route frame reaches the card without a hand-written body in between", () => {
  it("renders the state, the probe time and the route window from the served frame", () => {
    const answer = mapDeploymentsHealthAnswer(200, servedFrame());
    if (answer.status !== "DEPLOYMENTS_HEALTH") {
      throw new Error(`the route frame did not decode: ${answer.code} @ ${answer.layer}`);
    }
    render(<EnvironmentsSection
      environments={[{ environment: answer.environment, outcome: answer }]}
      nowMs={NOW}
    />);

    const card = screen.getByTestId("cr.environments.card.production");
    // The DAEMON's state verbatim - the frame says UP and nothing here recomputes it.
    expect(card.getAttribute("data-status")).toBe(VALUE_BY_KEY["state"]);
    expect(screen.getByTestId("cr.environments.card.production.state").textContent)
      .toBe(`Up ${MIDDOT} the last probe answered 5 min ago ${MIDDOT} 91 ms`);
    const svg = screen.getByTestId("cr.environments.card.production.latency.svg");
    // The window comes from the ROUTE constant: a route that rewindowed its series reds here.
    expect(svg.getAttribute("data-window-minutes")).toBe(String(WINDOW_MINUTES));
    expect(svg.getAttribute("data-latencies")).toBe("80,85,91");
    expect(screen.getByTestId("cr.environments.card.production.incident").textContent)
      .toContain("Incident 7");
  });
});
