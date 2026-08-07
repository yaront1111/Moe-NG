import type { Phase0EvidenceManifest, Phase0EvidenceRole } from "@moe/contracts";

import { identifyEvidence, type EvidenceIdentity } from "./evidence-digest.js";
import { decodeManifest } from "./phase0-evidence-manifest-codec.js";
import {
  readVerifiedEntryObject,
  readVerifiedStatusObject,
  type Phase0FreezeObjectReader,
} from "./phase0-evidence-object-verifier.js";
import { freezeError } from "./phase0-freeze-codec.js";

export type { Phase0FreezeObjectReader } from "./phase0-evidence-object-verifier.js";

export interface VerifiedPhase0EvidenceManifest {
  readonly identity: EvidenceIdentity;
  readonly manifest: Phase0EvidenceManifest;
  readonly manifestJson: string;
  readEvidence(role: Phase0EvidenceRole): Uint8Array;
}

export async function verifyPhase0EvidenceManifest(
  manifestInput: Uint8Array,
  reader: Phase0FreezeObjectReader,
): Promise<VerifiedPhase0EvidenceManifest> {
  const decoded = decodeManifest(manifestInput);
  const manifestIdentity = identifyEvidence(decoded.manifestBytes);
  await readVerifiedStatusObject(reader, decoded.manifest.sourceBefore);

  const evidenceByRole = new Map<Phase0EvidenceRole, Uint8Array>();
  for (const entry of decoded.manifest.entries) {
    const bytes = await readVerifiedEntryObject(
      reader,
      entry,
      decoded.manifest.gitObjectFormat,
    );
    evidenceByRole.set(entry.role, bytes);
  }

  return Object.freeze({
    identity: Object.freeze({ ...manifestIdentity }),
    manifest: decoded.manifest,
    manifestJson: new TextDecoder().decode(decoded.manifestBytes),
    readEvidence(role: Phase0EvidenceRole): Uint8Array {
      const bytes = evidenceByRole.get(role);
      if (bytes === undefined) {
        return freezeError("PHASE0_MANIFEST_ROLE_SET_INVALID", role);
      }
      return bytes.slice();
    },
  });
}
