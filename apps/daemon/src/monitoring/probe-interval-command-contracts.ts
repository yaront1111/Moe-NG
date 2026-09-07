import type { RuntimeCommandKind } from "@moe/contracts";

/**
 * THE COMMAND KIND THAT WRITES THE PER-ENVIRONMENT PROBE INTERVAL, named here rather than in
 * `daemon-command-vocabulary.ts` for the same reason every other slice names its own kind in its
 * own contracts module: the vocabulary is a MAPPING of kinds to families, and a kind whose
 * spelling lived there would have its literal and its handler in two packages that can drift.
 *
 * `satisfies RuntimeCommandKind` is the whole point of the annotation: the shared runtime roster
 * (`@moe/contracts`, published by task-749e585afc) is what a browser and the generated client
 * dispatch against, so a kind the daemon serves under a spelling that roster does not carry is a
 * handler nothing can reach. A typo here is a COMPILE error, not a silent dead wire.
 */
export const PROBE_INTERVAL_COMMAND_KIND = "monitoring.set_probe_interval" satisfies RuntimeCommandKind;

/**
 * THE EXACT PAYLOAD ROSTER, owned here and re-exported into `PAYLOAD_KEYS` so the seam's
 * allow-list and this edge's decoder can never name different fields.
 *
 * `projectId` is ABSENT BY CONSTRUCTION, exactly as it is for `repository.bootstrap` and
 * `deployment.migrate_down`: it comes from the AUTHENTICATED PRINCIPAL, so a caller naming it is
 * INPUT_INVALID at PAYLOAD_SHAPE. A caller-supplied projectId would rewrite another project's
 * probe schedule. No bound, default or unit belongs here either -- those are the interval
 * record's (`probe-interval-record.ts`), and a second copy would drift from the scheduler's.
 */
export const PROBE_INTERVAL_PAYLOAD_KEYS: readonly string[] = Object.freeze([
  "environment", "intervalMs",
]);
