import { expect, test } from "@playwright/test";

import { withDevGraphControlRoom } from "./dev-graph-ports.js";

const NODE_BUILTIN_BROWSER_ERROR = /node:crypto|externalized for browser compatibility/u;

test("task-8aae7ea8 loads the Cordum v2 shell through the Vite dev graph", async ({ page }) => {
  const browserErrors: string[] = [];
  let signalModuleGraphError: (message: string) => void = () => undefined;
  const moduleGraphError = new Promise<string>((resolve) => {
    signalModuleGraphError = resolve;
  });

  const captureBrowserError = (message: string): void => {
    browserErrors.push(message);
    if (NODE_BUILTIN_BROWSER_ERROR.test(message)) {
      signalModuleGraphError(message);
    }
  };

  page.on("pageerror", (error) => captureBrowserError(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      captureBrowserError(message.text());
    }
  });

  const outcome = await withDevGraphControlRoom(async (baseUrl) => {
    await page.goto(baseUrl);
    const shellRoot = page.getByTestId("cr2.shell.root");
    await Promise.race([
      expect(shellRoot).toHaveCount(1, { timeout: 15_000 }),
      moduleGraphError.then((message) => Promise.reject(new Error(message))),
    ]);

    expect(browserErrors.filter((message) => NODE_BUILTIN_BROWSER_ERROR.test(message))).toEqual([]);
    return await shellRoot.count();
  });

  expect(outcome).toEqual({ ok: true, value: 1 });
});
