import { appendFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createStoreDependencies, readStoreDependencyEnv }
  from "../../../apps/daemon/src/daemon-store-dependencies.js";
import { ghPrArgv } from "../../../apps/daemon/src/release/release-pr-port.js";
import type { ReleasePrPort, ReleasePrRequest, ReleasePrResult }
  from "../../../apps/daemon/src/release/release-pr-port.js";
import { FAKE_GH_MODES, FAKE_GH_STDERR, FAKE_PR_URL } from "./fake-gh-contract.js";

/**
 * THE RELEASE LANE'S ONE DOUBLE: the `gh pr create` SPAWN, and nothing else.
 *
 * WHAT STAYS REAL: the daemon process, the operator fence, the dossier facts, the release
 * evidence read, the publisher that pushes the goal's branch, the durable release receipt and
 * every refusal code. `createProductionReleaseSeams` builds all of them; only `prPort` is
 * replaced, through the `releasePrPort` config seam that mirrors `deploymentDeploy`.
 *
 * WHY THE SPAWN AND NOT THE SEAM ABOVE IT. Spawning the real `gh` on every lane run would open
 * a pull request on a real repository each time the suite runs, which is not a test - it is a
 * side effect wearing a test's clothes. Replacing the whole release edge instead would prove
 * only that this file answers. The line is drawn at the process boundary: everything the
 * daemon decides is the daemon's, and the only thing faked is the subprocess it would have
 * launched. A consumer inheriting this lane inherits exactly that split.
 *
 * THE ARGV IS RECORDED AND ASSERTED. `ghPrArgv` is the PRODUCTION recipe, imported rather
 * than restated, so the spec can prove the daemon asked for the pull request it says it did.
 */

const mode = process.env["MOE_E2E_RELEASE_MODE"] ?? "SUCCESS";
if (!(FAKE_GH_MODES as readonly string[]).includes(mode)) throw new Error("E2E_RELEASE_MODE_INVALID");

const config = readStoreDependencyEnv(process.env);
const callsPath = join(dirname(config.storePath), "release-pr-calls.jsonl");
writeFileSync(callsPath, "", "utf8");

const prPort: ReleasePrPort = {
  open: (request: ReleasePrRequest): Promise<ReleasePrResult> => {
    appendFileSync(callsPath, `${JSON.stringify({
      argv: ghPrArgv(request, "<body-file>"), base: request.base, head: request.head, sha: request.sha,
    })}\n`, "utf8");
    return Promise.resolve(mode === "SUCCESS"
      ? { ok: true, prUrl: FAKE_PR_URL }
      : { ok: false, spawnErrorCode: null, stderrLastLine: FAKE_GH_STDERR });
  },
};

export default createStoreDependencies({ ...config, releasePrPort: prPort });
