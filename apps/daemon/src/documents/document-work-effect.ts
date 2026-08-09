import { createHash } from "node:crypto";

import {
  COMMAND_EFFECT_IDENTITY_VERSION,
  EVENT_RECORD_VERSION,
  OPAQUE_PAYLOAD_CODEC_VERSION,
} from "@moe/store";

const encoder = new TextEncoder();

function updateLengthFramed(
  hash: ReturnType<typeof createHash>,
  value: Uint8Array,
): void {
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(value.byteLength));
  hash.update(length).update(value);
}

function updateString(hash: ReturnType<typeof createHash>, value: string): void {
  updateLengthFramed(hash, encoder.encode(value));
}

function updateUnsigned(hash: ReturnType<typeof createHash>, value: number | bigint): void {
  const encoded = Buffer.allocUnsafe(8);
  encoded.writeBigUInt64BE(BigInt(value));
  updateLengthFramed(hash, encoded);
}

export interface DocumentWorkEffectDigestInput {
  readonly aggregateId: string;
  readonly aggregateSequence: number;
  readonly commandId: string;
  readonly committedAt: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly globalPosition: bigint;
  readonly metadata: Uint8Array;
  readonly payload: Uint8Array;
  readonly requestSha256: string;
}

/** Reconstructs the public one-event/no-outbox effect identity represented by a tail. */
export function documentWorkEffectSha256(input: DocumentWorkEffectDigestInput): string {
  const hash = createHash("sha256");
  updateString(hash, COMMAND_EFFECT_IDENTITY_VERSION);
  updateString(hash, input.aggregateId);
  updateString(hash, input.commandId);
  updateString(hash, input.committedAt);
  updateString(hash, input.requestSha256);
  updateUnsigned(hash, input.aggregateSequence - 1);
  updateUnsigned(hash, input.aggregateSequence);
  updateUnsigned(hash, 1);
  updateUnsigned(hash, input.aggregateSequence);
  updateUnsigned(hash, 0);
  updateUnsigned(hash, input.globalPosition);
  updateString(hash, input.eventId);
  updateString(hash, input.eventType);
  updateString(hash, EVENT_RECORD_VERSION);
  updateString(hash, OPAQUE_PAYLOAD_CODEC_VERSION);
  updateLengthFramed(hash, input.payload);
  updateLengthFramed(hash, input.metadata);
  updateUnsigned(hash, 0);
  return hash.digest("hex");
}
