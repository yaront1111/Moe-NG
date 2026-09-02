import { exact, materialDigest, record, text } from "./snapshot.js";

const BINDING_KEYS = Object.freeze([
  "capability", "executionIsolationProfileRevision", "verificationRecipeRevisions",
]);

/** Distinguishes a present-but-drifted material binding from a malformed capability claim. */
export function resolutionBindingMaterialMismatch(
  value: unknown,
  profile: Readonly<Record<string, unknown>>,
): boolean {
  if (!exact(value, BINDING_KEYS)) return false;
  const capability = record(value["capability"]);
  const execution = record(value["executionIsolationProfileRevision"]);
  if (capability === undefined || execution === undefined) return false;
  return !text(execution["revisionId"]) || !materialDigest(execution["revisionDigest"])
    || !materialDigest(execution["sourceSnapshotDigest"])
    || capability["deliveryProfileRevisionDigest"] !== profile["revisionDigest"]
    || capability["deliveryProfileRevisionId"] !== profile["revisionId"]
    || capability["deliveryProfileFamilyId"] !== profile["profileFamilyId"]
    || capability["executionIsolationProfileRevisionDigest"] !== execution["revisionDigest"]
    || capability["executionIsolationProfileRevisionId"] !== execution["revisionId"]
    || execution["deliveryProfileRevisionDigest"] !== profile["revisionDigest"];
}
