import { parentPort } from "node:worker_threads";

import * as storeModule from "./index.ts";

if (parentPort === null) {
  throw new Error("recovery install entrypoint worker requires a parent port");
}

const encoded = storeModule.encodeRecoveryBinding({
  bindingCodecVersion: storeModule.RECOVERY_BINDING_CODEC_VERSION,
  incarnationRef: "7a".repeat(32),
  installedAt: "2026-08-11T10:00:00.000Z",
  keyEpochRef: "6b".repeat(32),
  payload: new TextEncoder().encode("entrypoint-binding"),
  slot: "PENDING",
});
const decoded = encoded.ok
  ? storeModule.decodeRecoveryBinding(encoded.bytes, encoded.digest)
  : { ok: false };

parentPort.postMessage({
  codecVersion: storeModule.RECOVERY_BINDING_CODEC_VERSION,
  decodeType: typeof storeModule.decodeRecoveryBinding,
  decodedSlot: decoded.ok ? decoded.binding.slot : null,
  encodeType: typeof storeModule.encodeRecoveryBinding,
  installType: typeof storeModule.SqliteEventStore.prototype.installRecoveryBinding,
  layers: [...storeModule.RECOVERY_INSTALL_LAYERS],
  outcome: "IMPORTED",
  readType: typeof storeModule.SqliteEventStore.prototype.readRecoveryBinding,
  reasonCodeCount: storeModule.RECOVERY_INSTALL_REASON_CODES.length,
  slots: [...storeModule.RECOVERY_BINDING_SLOTS],
});
