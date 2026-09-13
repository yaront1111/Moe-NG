import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createStoreDependencies, readStoreDependencyEnv }
  from "../../../apps/daemon/src/daemon-store-dependencies.js";

// Selected explicitly by this browser fixture's --dependencies argument. Every
// production port remains real; only the existing composition clock is injected.
const config = readStoreDependencyEnv(process.env);
const clockPath = join(dirname(config.storePath), "pairing-clock-offset.txt");
export default createStoreDependencies({
  ...config,
  clock: () => {
    const offset = Number(readFileSync(clockPath, "utf8"));
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 60 * 60_000) {
      throw new Error("E2E_PAIRING_CLOCK_INVALID");
    }
    return new Date(Date.now() + offset).toISOString();
  },
});
