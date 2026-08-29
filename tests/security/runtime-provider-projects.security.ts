/** Hostile coverage for project filesystem, launch and process-lifecycle boundaries. */

import { describe, it } from "vitest";

import { PROJECT_RUNTIME_HOSTILE_CASES } from "./runtime-provider-project-cases.js";
import {
  RUNTIME_PROVIDER_PARTITION,
  createLedger,
  describeSliceInvariants,
} from "./runtime-provider-ledger.js";

const OWNED = RUNTIME_PROVIDER_PARTITION.PROJECTS;
const ledger = createLedger();

for (const boundary of OWNED) {
  describe(boundary, () => {
    for (const hostileCase of PROJECT_RUNTIME_HOSTILE_CASES.filter(
      (entry) => entry.boundary === boundary,
    )) {
      it(`${hostileCase.arm} - ${hostileCase.name}`, async () => {
        await hostileCase.run(ledger);
      });
    }
  });
}

describeSliceInvariants("project runtime", ledger, OWNED, [], 0);
