import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ENTRYPOINT_PROBE = `
const report = (value) => process.stdout.write(JSON.stringify(value));
try {
  const namespace = await import("@moe/review");
  report({
    buildReviewPackage: typeof namespace.buildReviewPackage,
    outcome: "IMPORTED",
  });
} catch (error) {
  report({ outcome: "FAILED", code: error.code ?? "NO_CODE" });
}
`;

const runProbe = async (): Promise<unknown> => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", ENTRYPOINT_PROBE],
    { cwd: PACKAGE_ROOT },
  );
  return JSON.parse(stdout) as unknown;
};

it("loads @moe/review with its buildReviewPackage export defined in Node", async () => {
  expect(await runProbe()).toEqual({
    buildReviewPackage: "function",
    outcome: "IMPORTED",
  });
});
