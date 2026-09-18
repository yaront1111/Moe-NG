import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

/**
 * The capture-fault observer crosses five composition hops, each a conditional spread under
 * `exactOptionalPropertyTypes` — and a dropped spread type-checks, because the option is
 * optional at every hop. No unit can drive a real Foundation capture without a provider
 * runtime on the host, so the thread is pinned by SOURCE: every hop must both declare the
 * option and pass it on. A count is the assertion, not the text around it.
 */
const HOPS: readonly { readonly file: string; readonly mentions: number }[] = [
  // the composition builds the reporter from `config.diagnostics`
  { file: "daemon-store-foundation-composition.ts", mentions: 1 },
  // option declared + spread into the async entries
  { file: "daemon-command-registry.ts", mentions: 3 },
  // option declared + spread into the foundation dispatch handler
  { file: "daemon-command-async-entries.ts", mentions: 3 },
  // option declared + spread into the attempt service
  { file: "daemon-foundation-command.ts", mentions: 3 },
  // the deps field, read by the settlement
  { file: "work/foundation-attempt-service.ts", mentions: 1 },
  { file: "work/foundation-attempt-settlement.ts", mentions: 1 },
];

it("threads onCaptureFault through every composition hop between the store config and the settlement", () => {
  for (const hop of HOPS) {
    const source = readFileSync(new URL(`../${hop.file}`, import.meta.url), "utf8");
    const count = source.match(/\bonCaptureFault\b/gu)?.length ?? 0;
    expect(count, hop.file).toBeGreaterThanOrEqual(hop.mentions);
  }
});
