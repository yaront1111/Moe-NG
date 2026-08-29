/**
 * Hostile runner for the platform and runtime-closure slice.
 *
 * Every executable case is declared in PLATFORM_RUNTIME_HOSTILE_CASES. This file only registers
 * those rows with Vitest and then applies the whole-slice ledger invariants.
 */

import { describe, it } from "vitest";

import {
  PLATFORM_RUNTIME_HOSTILE_CASES,
} from "./runtime-provider-platform-cases.js";
import {
  RUNTIME_PROVIDER_PARTITION,
  createLedger,
  describeSliceInvariants,
} from "./runtime-provider-ledger.js";
import { PLATFORM_SECRETS } from "./runtime-provider-platform-fixtures.js";

const OWNED = RUNTIME_PROVIDER_PARTITION.PLATFORM;
const ledger = createLedger();
const CASE_BOUNDARIES = Object.freeze([
  ...new Set(PLATFORM_RUNTIME_HOSTILE_CASES.map((entry) => entry.boundary)),
]);

for (const boundary of CASE_BOUNDARIES) {
  describe(boundary, () => {
    for (const hostileCase of PLATFORM_RUNTIME_HOSTILE_CASES.filter(
      (entry) => entry.boundary === boundary,
    )) {
      it(hostileCase.arm + " — " + hostileCase.name, async () => {
        await hostileCase.run(ledger);
      });
    }
  });
}

describeSliceInvariants("platform group", ledger, OWNED, PLATFORM_SECRETS, 12);
