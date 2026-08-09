import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  COMMAND_STILL_WORKING_COPY,
  ClockProvider,
  CommandLatency,
  STILL_WORKING_THRESHOLD_MS,
} from "./command-latency.js";
import type { CommandLatencyFeedback } from "./command-latency.js";
import { evaluateTiming } from "./timing.js";
import type { Clock, TimingInput } from "./timing.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

/** Spec §11.4 line 711 verbatim, hand-written so the module cannot reword it. */
const STILL_WORKING = "still working — the daemon accepted the command (event pending)";

const PREFIX = "cr.recovery.feedback";
const COMMAND_ID = "cmd-recovery-complete";

/** Advances only when a test says so: no timer, no waiting, no real clock. */
function testClock(startAt: number): Clock & { advance: (ms: number) => void } {
  let current = startAt;
  return {
    advance(ms: number): void {
      current += ms;
    },
    now(): number {
      return current;
    },
  };
}

const PENDING: CommandLatencyFeedback = {
  commandId: COMMAND_ID,
  message: "Recovery completion sent.",
  startedAt: 1_000,
  state: "PENDING",
};

function container(prefix = PREFIX): HTMLElement {
  return screen.getByTestId(`${prefix}.${COMMAND_ID}`);
}

describe("the shared latency feedback carries the section 11.4 contract", () => {
  it("renders a pending command immediately with role status and no still-working line", () => {
    render(<CommandLatency clock={testClock(1_000)} feedback={PENDING} testIdPrefix={PREFIX} />);
    const shown = container();
    expect(shown.getAttribute("role")).toBe("status");
    expect(shown.dataset["state"]).toBe("PENDING");
    expect(within(shown).getByTestId(`${PREFIX}.message`).textContent)
      .toBe("Recovery completion sent.");
    expect(within(shown).queryByTestId(`${PREFIX}.stillworking`)).toBeNull();
  });

  it("renders a confirmed command with role status", () => {
    render(
      <CommandLatency clock={testClock(1_000)} feedback={{ ...PENDING, state: "CONFIRMED" }}
        testIdPrefix={PREFIX} />,
    );
    expect(container().getAttribute("role")).toBe("status");
    expect(container().dataset["state"]).toBe("CONFIRMED");
  });

  it("renders a refusal with role alert, the stable code, and the refusing layer", () => {
    render(
      <CommandLatency clock={testClock(1_000)}
        feedback={{
          ...PENDING,
          message: "The daemon refused recovery completion.",
          reason: { layer: "daemon.recovery", phrase: "Quiesce is not complete.",
            reasonCode: "RECOVERY_NOT_QUIESCED" },
          state: "REFUSED",
        }}
        testIdPrefix={PREFIX} />,
    );
    const shown = container();
    expect(shown.getAttribute("role")).toBe("alert");
    expect(within(shown).getByTestId(`${PREFIX}.code`).textContent).toBe("RECOVERY_NOT_QUIESCED");
    expect(within(shown).getByTestId(`${PREFIX}.layer`).textContent).toBe("daemon.recovery");
  });
});

describe("the still-working line is measured, never asserted by the caller", () => {
  it("publishes the spec sentence and a two-second threshold", () => {
    expect(COMMAND_STILL_WORKING_COPY).toBe(STILL_WORKING);
    expect(STILL_WORKING_THRESHOLD_MS).toBe(2_000);
  });

  it("stays absent at exactly the threshold and appears one millisecond past it", () => {
    const clock = testClock(1_000);
    const view = render(
      <CommandLatency clock={clock} feedback={PENDING} testIdPrefix={PREFIX} />,
    );

    clock.advance(STILL_WORKING_THRESHOLD_MS);
    view.rerender(<CommandLatency clock={clock} feedback={PENDING} testIdPrefix={PREFIX} />);
    expect(container().dataset["elapsedMs"]).toBe("2000");
    expect(within(container()).queryByTestId(`${PREFIX}.stillworking`), "2000ms is not > 2 s")
      .toBeNull();

    clock.advance(1);
    view.rerender(<CommandLatency clock={clock} feedback={PENDING} testIdPrefix={PREFIX} />);
    expect(within(container()).getByTestId(`${PREFIX}.stillworking`).textContent)
      .toBe(STILL_WORKING);
  });

  it("labels the elapsed value as the control room's own observation", () => {
    const clock = testClock(1_000);
    clock.advance(3_000);
    render(<CommandLatency clock={clock} feedback={PENDING} testIdPrefix={PREFIX} />);
    expect(container().dataset["observedBy"]).toBe("CONTROL_ROOM");
  });

  it("never shows the still-working line for a settled command, however long it took", () => {
    const clock = testClock(1_000);
    clock.advance(60_000);
    render(
      <CommandLatency clock={clock} feedback={{ ...PENDING, state: "CONFIRMED" }}
        testIdPrefix={PREFIX} />,
    );
    expect(within(container()).queryByTestId(`${PREFIX}.stillworking`)).toBeNull();
  });

  it("reports TIMING_CLOCK_UNAVAILABLE rather than assuming no time passed", () => {
    render(<CommandLatency feedback={PENDING} testIdPrefix={PREFIX} />);
    const shown = container();
    expect(shown.dataset["state"]).toBe("PENDING");
    expect(shown.dataset["elapsedUnknown"]).toBe("TIMING_CLOCK_UNAVAILABLE");
    expect(shown.dataset["elapsedMs"]).toBeUndefined();
    expect(within(shown).queryByTestId(`${PREFIX}.stillworking`)).toBeNull();
  });

  it("reports TIMING_SOURCE_ABSENT when the caller supplied no start", () => {
    const withoutStart: CommandLatencyFeedback = {
      commandId: COMMAND_ID, message: PENDING.message, state: "PENDING",
    };
    render(
      <CommandLatency clock={testClock(9_000)} feedback={withoutStart} testIdPrefix={PREFIX} />,
    );
    expect(container().dataset["elapsedUnknown"]).toBe("TIMING_SOURCE_ABSENT");
  });
});

describe("the composition root's clock reaches a surface that threads none", () => {
  it("measures through the provider when no clock prop is passed", () => {
    const clock = testClock(1_000);
    clock.advance(2_001);
    render(
      <ClockProvider clock={clock}>
        <CommandLatency feedback={PENDING} testIdPrefix={PREFIX} />
      </ClockProvider>,
    );
    expect(container().dataset["elapsedMs"]).toBe("2001");
    expect(within(container()).getByTestId(`${PREFIX}.stillworking`).textContent)
      .toBe(STILL_WORKING);
  });

  it("still fails closed under a tree with no provider at all", () => {
    render(<CommandLatency feedback={PENDING} testIdPrefix={PREFIX} />);
    expect(container().dataset["elapsedUnknown"]).toBe("TIMING_CLOCK_UNAVAILABLE");
  });

  it("lets an explicit prop override the provided clock", () => {
    render(
      <ClockProvider clock={testClock(99_000)}>
        <CommandLatency clock={testClock(1_500)} feedback={PENDING} testIdPrefix={PREFIX} />
      </ClockProvider>,
    );
    expect(container().dataset["elapsedMs"]).toBe("500");
  });
});

describe("the component belongs to no single surface", () => {
  it("takes its test ids from the caller's prefix and leaks no recovery namespace", () => {
    render(
      <CommandLatency clock={testClock(1_000)} feedback={PENDING}
        testIdPrefix="cr.approval.feedback" />,
    );
    expect(container("cr.approval.feedback")).toBeTruthy();
    expect(screen.queryByTestId(`${PREFIX}.${COMMAND_ID}`)).toBeNull();
    expect(document.body.innerHTML).not.toContain("cr.recovery.");
  });
});

/**
 * DoD 2, asserted against what the operator actually sees. The fold preserves the total
 * span, so a component that rendered one summed number could not tell the two apart.
 */
const FOUR_PHASES: TimingInput = {
  human: { end: 4_040, start: 4_000 },
  render: { end: 3_030, start: 3_000 },
  server: { end: 1_010, start: 1_000 },
  stream: { end: 2_020, start: 2_000 },
};
const COLLAPSED: TimingInput = {
  human: { end: 4_040, start: 4_000 },
  render: { end: 3_030, start: 3_000 },
  server: { end: 1_030, start: 1_000 },
};

function timingMarkup(input: TimingInput): string {
  const view = render(
    <CommandLatency clock={testClock(1_000)} feedback={PENDING}
      receipt={evaluateTiming(input)} testIdPrefix={PREFIX} />,
  );
  const markup = container().innerHTML;
  view.unmount();
  return markup;
}

describe("the rendered receipt keeps the four phases apart", () => {
  it("renders one line per phase, each naming its own phase", () => {
    render(
      <CommandLatency clock={testClock(1_000)} feedback={PENDING}
        receipt={evaluateTiming(FOUR_PHASES)} testIdPrefix={PREFIX} />,
    );
    const lines = container().querySelectorAll(`[data-testid^='${PREFIX}.phase.']`);
    expect(lines).toHaveLength(4);
    expect(within(container()).getByTestId(`${PREFIX}.phase.server`).dataset["durationMs"])
      .toBe("10");
    expect(within(container()).getByTestId(`${PREFIX}.phase.stream`).dataset["durationMs"])
      .toBe("20");
  });

  it("renders different markup when two phases are collapsed into one", () => {
    expect(timingMarkup(COLLAPSED)).not.toBe(timingMarkup(FOUR_PHASES));
  });

  it("renders an unmeasurable phase as its code, never as a zero duration", () => {
    render(
      <CommandLatency clock={testClock(1_000)} feedback={PENDING}
        receipt={evaluateTiming(COLLAPSED)} testIdPrefix={PREFIX} />,
    );
    const stream = within(container()).getByTestId(`${PREFIX}.phase.stream`);
    expect(stream.dataset["unknownCode"]).toBe("TIMING_SOURCE_ABSENT");
    expect(stream.dataset["durationMs"]).toBeUndefined();
  });
});
