/**
 * The committed contract pin, for release tooling that must refuse a stale generated client
 * (apps/daemon/src/cutover/v2-readiness-evidence-producers.ts). A SUBPATH on purpose: the
 * package root exports nothing generated, and this module is hand-written source that names
 * exactly one generated value.
 */
export { GENERATED_CONTRACT_DIGEST } from "./generated/generated-client.js";
