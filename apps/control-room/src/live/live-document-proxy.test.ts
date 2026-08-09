import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, it } from "vitest";

it("proxies the authenticated dossier read through the same-origin dev seam", () => {
  const config = readFileSync(resolve(process.cwd(), "vite.config.ts"), "utf8");
  expect(config).toContain('"/documents/dossier/read"');
});
