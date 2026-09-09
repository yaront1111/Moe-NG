import type { RuntimeCommandKind } from "@moe/contracts";

/**
 * THE COMMAND KIND THAT RETIRES AN ENVIRONMENT FROM MONITORING, named here rather than in
 * `daemon-command-vocabulary.ts` for the reason its sibling `probe-interval-command-contracts.ts`
 * gives: the vocabulary is a MAPPING of kinds to families, and a kind whose spelling lived there
 * would have its literal and its handler in two packages that can drift.
 *
 * `satisfies RuntimeCommandKind` is the whole point of the annotation. The shared runtime roster
 * (`@moe/contracts`) is what a browser and the generated client dispatch against, so a kind the
 * daemon serves under a spelling that roster does not carry is a handler nothing can reach. A
 * typo here is a COMPILE error, not a silent dead wire.
 */
export const ENVIRONMENT_RETIREMENT_COMMAND_KIND =
  "monitoring.retire_environment" satisfies RuntimeCommandKind;

/**
 * THE EXACT PAYLOAD ROSTER, owned here and re-exported into `PAYLOAD_KEYS` so the seam's
 * allow-list and this edge's decoder can never name different fields.
 *
 * ONE FIELD, and the arity is the fence. `projectId` is ABSENT BY CONSTRUCTION, exactly as it is
 * for `monitoring.set_probe_interval` and `repository.bootstrap`: it comes from the AUTHENTICATED
 * PRINCIPAL, so a caller naming it is INPUT_INVALID at PAYLOAD_SHAPE. A caller-supplied projectId
 * would silence another project's monitoring.
 *
 * NO CUTOFF FIELD EITHER, and that is a load-bearing absence rather than an omission. Retirement
 * is scoped to the deployment generation the daemon OBSERVES at write time -- the record reads
 * `latestSuccessful` off the deploy ledger itself (`environment-retirement-record.ts`) -- so a
 * caller that could name a receipt id could retire an environment through a generation that is
 * no longer live, and the sweep would keep probing while the operator believed it had stopped.
 * The name's grammar is not restated here either: `admitEnvironmentName` owns it, and a second
 * copy would drift from the one the record and the deploy ledger already share.
 */
export const ENVIRONMENT_RETIREMENT_PAYLOAD_KEYS: readonly string[] = Object.freeze([
  "environment",
]);
