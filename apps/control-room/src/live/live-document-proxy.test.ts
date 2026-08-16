import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, it } from "vitest";

it("proxies every authenticated read and acknowledgement through the same-origin dev seam", () => {
  const config = readFileSync(resolve(process.cwd(), "vite.config.ts"), "utf8");
  expect(config).toContain('"/documents/dossier/read"');
  expect(config).toContain('"/events/ack"');
});
