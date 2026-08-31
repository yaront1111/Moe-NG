export const UNSTATED = "UNKNOWN";
/**
 * How many records one read may shape. The daemon is the trust anchor for truth, but an
 * unbounded map over a network payload still lets a single oversized response allocate
 * without limit, so the bound lives on the receiving side too.
 */
export const MAX_VIEW_RECORDS = 1_000;
export const ADVISORY_MESSAGE_KINDS = Object.freeze(["SESSION", "TERMINAL"]);
