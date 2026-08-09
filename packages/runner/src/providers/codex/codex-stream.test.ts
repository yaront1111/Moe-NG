import { existsSync } from "node:fs";

import { expect, it } from "vitest";

it("publishes the Codex stream recorder", () => {
  expect(existsSync(new URL("./codex-stream.ts", import.meta.url))).toBe(true);
});
