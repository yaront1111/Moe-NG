import { MAX_JSON_BODY_BYTES, MAX_JSON_STRING_UTF8_BYTES } from "@moe/contracts";
import type { JsonObject } from "@moe/contracts";

const encoder = new TextEncoder();
const PART_CODE_UNITS = 16_384;
const PART_UTF8_BYTES = 65_536;

/** The digest always covers joined canonical UTF-8 bytes; splitting changes only storage. */
export function reviewArtifactTextFields(text: string): JsonObject {
  if (encoder.encode(text).byteLength <= MAX_JSON_STRING_UTF8_BYTES) return Object.freeze({ text });
  const textParts: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + PART_CODE_UNITS, text.length);
    // Never split a surrogate pair: each persisted JSON string must remain valid Unicode.
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    textParts.push(text.slice(start, end));
    start = end;
  }
  return Object.freeze({ textParts: Object.freeze(textParts) });
}

/** Exact shape, with bounded reconstruction. The caller verifies the full artifact digest. */
export function readReviewArtifactText(artifact: JsonObject): string | null {
  const keys = Object.keys(artifact).sort().join(",");
  if (keys === "digest,locator,text") {
    const text = artifact["text"];
    return typeof text === "string" && encoder.encode(text).byteLength <= MAX_JSON_STRING_UTF8_BYTES ? text : null;
  }
  const parts = artifact["textParts"];
  if (keys !== "digest,locator,textParts" || !Array.isArray(parts) || parts.length === 0) return null;
  let bytes = 0;
  for (const part of parts) {
    if (typeof part !== "string" || part.length === 0) return null;
    const size = encoder.encode(part).byteLength;
    bytes += size;
    if (size > PART_UTF8_BYTES || bytes > MAX_JSON_BODY_BYTES) return null;
  }
  return parts.join("");
}
