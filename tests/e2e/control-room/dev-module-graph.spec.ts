import { expect, test, type Locator, type Page } from "@playwright/test";

import { withDevGraphControlRoom } from "./dev-graph-ports.js";

// Deliberate duplicate: this pattern serves only the fast-failure race signal.
const MODULE_GRAPH_RACE_SIGNAL = /node:crypto|externalized for browser compatibility/u;
// Deliberate duplicate: this pattern serves only the final completeness assertion.
const NODE_BUILTIN_LEAK = /node:crypto|externalized for browser compatibility/u;
// Deliberate duplicate: this pattern serves only the dev-server transcript check.
const DEV_SERVER_NODE_BUILTIN_LEAK = /node:crypto|externalized for browser compatibility/u;
// Bound hydration diagnostics without turning the browser arm into an open-ended wait.
const MESSAGE_SETTLE_MS = 1_000;
// The dev server learns of a client error over its own channel, so it reports
// slightly after the browser does. Bounded, and only ever spent on a failing run.
const SERVER_SETTLE_MS = 2_500;
// A vite client report is an error line plus its source frame; the frame is what
// names the importing module, so quote the window rather than the line alone.
const SERVER_REPORT_FRAME_LINES = 4;
const BENIGN_WARNING = "benign console listener proof";
const LATE_NODE_BUILTIN_WARNING = "node:crypto externalized for browser compatibility";
const RACED_NODE_BUILTIN_WARNING = "node:crypto raced externalized for browser compatibility";

interface BrowserMessageObservation {
  readonly browserErrors: string[];
  readonly moduleGraphError: Promise<string>;
}

function observeBrowserMessages(page: Page): BrowserMessageObservation {
  const browserErrors: string[] = [];
  let signalModuleGraphError: (message: string) => void = () => undefined;
  const moduleGraphError = new Promise<string>((resolve) => {
    signalModuleGraphError = resolve;
  });
  const captureBrowserError = (message: string): void => {
    browserErrors.push(message);
    if (MODULE_GRAPH_RACE_SIGNAL.test(message)) {
      signalModuleGraphError(message);
    }
  };

  page.on("pageerror", (error) => captureBrowserError(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    captureBrowserError(`console.${message.type()}: ${message.text()}`);
  });
  return { browserErrors, moduleGraphError };
}

async function awaitShellOrModuleGraphError(
  shellRoot: Locator,
  moduleGraphError: Promise<string>,
): Promise<void> {
  const racedFailure = moduleGraphError.then((message): never => {
    throw new Error(message);
  });
  try {
    await Promise.race([
      expect(shellRoot).toHaveCount(1, { timeout: 15_000 }),
      racedFailure,
    ]);
  } finally {
    // The race has answered; retain a handler for a rejection that arrives later.
    void racedFailure.catch(() => undefined);
  }
}

async function settleAndAssertNoBuiltinLeak(browserErrors: readonly string[]): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, MESSAGE_SETTLE_MS));
  const leaks = browserErrors.filter((message) => NODE_BUILTIN_LEAK.test(message));
  expect(leaks, `node builtin leak after settle: ${leaks.join(" | ")}`).toEqual([]);
}

/**
 * Names the module that leaked, using the dev server's own report.
 *
 * A browser signal says only that something touched a Node builtin; the server
 * report carries the source frame, so a run that fails here fails BY NAMING the
 * importing file rather than by the clock.
 */
async function settleAndAssertNoServerBuiltinLeak(serverTranscript: () => string): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, SERVER_SETTLE_MS));
  const lines = serverTranscript().split(/\r?\n/u);
  const reports: string[] = [];
  // A source frame repeats the offending specifier, so windows would overlap and
  // report the same leak several times. Skip past a window once it is quoted.
  let nextEligible = 0;
  for (const [index, line] of lines.entries()) {
    if (index < nextEligible || !DEV_SERVER_NODE_BUILTIN_LEAK.test(line)) continue;
    reports.push(lines.slice(index, index + SERVER_REPORT_FRAME_LINES).join(" / "));
    nextEligible = index + SERVER_REPORT_FRAME_LINES;
  }
  expect(reports, `dev server reported a node builtin leak: ${reports.join(" || ")}`).toEqual([]);
}

test("task-8aae7ea8 loads the Cordum v2 shell through the Vite dev graph", async ({ page }) => {
  const { browserErrors, moduleGraphError } = observeBrowserMessages(page);

  const outcome = await withDevGraphControlRoom(async (baseUrl, serverTranscript) => {
    await page.goto(baseUrl);
    const shellRoot = page.getByTestId("cr2.shell.root");
    try {
      await awaitShellOrModuleGraphError(shellRoot, moduleGraphError);
    } catch (error: unknown) {
      // Neither browser mechanism names the importing module, and a bare shell
      // timeout names nothing at all. Let the server report answer first.
      await settleAndAssertNoServerBuiltinLeak(serverTranscript);
      throw error;
    }
    await settleAndAssertNoBuiltinLeak(browserErrors);
    await settleAndAssertNoServerBuiltinLeak(serverTranscript);
    return await shellRoot.count();
  });

  expect(outcome).toEqual({ ok: true, value: 1 });
});

test("captures console warnings with their Playwright type", async ({ page }) => {
  const { browserErrors } = observeBrowserMessages(page);
  await page.setContent("<main>warning fixture</main>");
  await page.evaluate((message) => console.warn(message), BENIGN_WARNING);

  await expect.poll(() => browserErrors).toContain(`console.warning: ${BENIGN_WARNING}`);
});

test("the final assertion rejects a node builtin leak emitted after the shell race", async ({
  page,
}) => {
  const { browserErrors, moduleGraphError } = observeBrowserMessages(page);
  await page.setContent('<main data-testid="fixture.shell.root">ready</main>');
  await awaitShellOrModuleGraphError(page.getByTestId("fixture.shell.root"), moduleGraphError);

  const assertion = settleAndAssertNoBuiltinLeak(browserErrors);
  await page.evaluate((message) => console.warn(message), LATE_NODE_BUILTIN_WARNING);

  await expect(assertion).rejects.toThrow(
    `node builtin leak after settle: console.warning: ${LATE_NODE_BUILTIN_WARNING}`,
  );
});

test("the shell race refuses on a node builtin signal instead of waiting out the shell budget", async ({
  page,
}) => {
  const { moduleGraphError } = observeBrowserMessages(page);
  // No element carries this id, so the shell leg cannot answer: the race signal
  // is the only mechanism that can refuse, and no dev server is involved.
  await page.setContent("<main>race fixture without a shell</main>");
  // Settle to a value before emitting: the race answers in milliseconds, and a
  // rejection attached later surfaces as an unhandled rejection instead.
  const settled = awaitShellOrModuleGraphError(
    page.getByTestId("fixture.race.root"),
    moduleGraphError,
  ).then(() => "the shell leg answered", (error: unknown) => String(error));
  await page.evaluate((message) => console.warn(message), RACED_NODE_BUILTIN_WARNING);

  expect(await settled).toContain(`console.warning: ${RACED_NODE_BUILTIN_WARNING}`);
});
