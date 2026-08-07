import { PHASE0_TARGET_REPOSITORY } from "@moe/contracts";

import { identifyEvidence, snapshotEvidenceBytes } from "./evidence-digest.js";
import {
  captureError,
  equalBytes,
  type Phase0EvidenceCapturePort,
  type Phase0EvidenceObjectLocation,
  type Phase0RawEvidenceObject,
} from "./phase0-evidence-capture-port.js";

export interface ExpectedEvidenceObject {
  readonly bytes: Uint8Array;
  readonly detail: string;
}

export function validateEvidenceObjectLocation(
  location: Phase0EvidenceObjectLocation,
  expectedObjectPath: string,
  errorDetail: string,
): void {
  const targetRepository: unknown = location.targetRepository;
  const objectPath: unknown = location.objectPath;
  if (targetRepository !== PHASE0_TARGET_REPOSITORY) {
    captureError("PHASE0_TARGET_REPOSITORY_MISMATCH", errorDetail);
  }
  if (objectPath !== expectedObjectPath) {
    captureError("PHASE0_OBJECT_STORE_PATH_MISMATCH", errorDetail);
  }
}

export async function readAndValidateEvidenceObject(
  port: Phase0EvidenceCapturePort,
  objectPath: string,
  errorDetail: string,
  maxByteLength: number,
): Promise<Uint8Array> {
  let raw: Phase0RawEvidenceObject;
  try {
    raw = await port.readEvidenceObject(PHASE0_TARGET_REPOSITORY, objectPath);
  } catch {
    return captureError("PHASE0_OBJECT_STORE_VERIFY_FAILED", errorDetail);
  }

  const targetRepository: unknown = raw.targetRepository;
  const reportedObjectPath: unknown = raw.objectPath;
  const rawBytes: unknown = raw.bytes;
  validateEvidenceObjectLocation(
    { targetRepository: targetRepository as string, objectPath: reportedObjectPath as string },
    objectPath,
    errorDetail,
  );
  try {
    return snapshotEvidenceBytes(rawBytes as Uint8Array, maxByteLength);
  } catch {
    return captureError("PHASE0_OBJECT_STORE_VERIFY_FAILED", errorDetail);
  }
}

export async function persistAndVerifyObject(
  port: Phase0EvidenceCapturePort,
  objectPath: string,
  bytes: Uint8Array,
  errorDetail: string,
): Promise<void> {
  let receipt: Phase0EvidenceObjectLocation;
  try {
    receipt = await port.writeEvidenceObject(
      PHASE0_TARGET_REPOSITORY,
      objectPath,
      bytes.slice(),
    );
  } catch {
    return captureError("PHASE0_OBJECT_STORE_VERIFY_FAILED", errorDetail);
  }
  validateEvidenceObjectLocation(receipt, objectPath, errorDetail);
  const stored = await readAndValidateEvidenceObject(
    port,
    objectPath,
    errorDetail,
    bytes.byteLength,
  );
  if (!equalBytes(bytes, stored)) {
    captureError("PHASE0_OBJECT_STORE_VERIFY_FAILED", errorDetail);
  }
  const storedIdentity = identifyEvidence(stored);
  if (storedIdentity.objectPath !== objectPath) {
    captureError("PHASE0_OBJECT_STORE_VERIFY_FAILED", errorDetail);
  }
}

export async function verifyCompleteObjectSet(
  port: Phase0EvidenceCapturePort,
  expectedObjects: ReadonlyMap<string, ExpectedEvidenceObject>,
): Promise<void> {
  for (const [objectPath, expected] of expectedObjects) {
    const stored = await readAndValidateEvidenceObject(
      port,
      objectPath,
      `final-${expected.detail}`,
      expected.bytes.byteLength,
    );
    if (!equalBytes(expected.bytes, stored)) {
      captureError("PHASE0_OBJECT_STORE_VERIFY_FAILED", `final-${expected.detail}`);
    }
    const storedIdentity = identifyEvidence(stored);
    if (storedIdentity.objectPath !== objectPath) {
      captureError("PHASE0_OBJECT_STORE_VERIFY_FAILED", `final-${expected.detail}`);
    }
  }
}
