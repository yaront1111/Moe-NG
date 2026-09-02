import { MAX_JSON_BODY_BYTES } from "@moe/contracts";
import type { ProductContractRevisionV2 } from "@moe/core";

const DOMAIN = "moe-product-contract-revision-digest/2";
const encoder = new TextEncoder();
interface CanonicalParts { bytes: number; readonly chunks: Uint8Array[] }

function emit(parts: CanonicalParts, text: string): boolean {
  const chunk = encoder.encode(text);
  parts.bytes += chunk.byteLength;
  if (parts.bytes > MAX_JSON_BODY_BYTES) return false;
  parts.chunks.push(chunk);
  return true;
}

function appendCanonical(value: unknown, parts: CanonicalParts): boolean {
  if (value === null) return emit(parts, "null");
  if (typeof value === "string" || typeof value === "boolean") {
    return emit(parts, JSON.stringify(value));
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return emit(parts, String(value));
  }
  if (Array.isArray(value)) {
    if (!emit(parts, "[")) return false;
    for (let index = 0; index < value.length; index += 1) {
      if ((index > 0 && !emit(parts, ",")) || !appendCanonical(value[index], parts)) return false;
    }
    return emit(parts, "]");
  }
  if (typeof value === "object") {
    if (!emit(parts, "{")) return false;
    const row = value as Readonly<Record<string, unknown>>;
    const keys = Object.keys(row).sort();
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index]!;
      if ((index > 0 && !emit(parts, ","))
        || !emit(parts, `${JSON.stringify(key)}:`)
        || !appendCanonical(row[key], parts)) return false;
    }
    return emit(parts, "}");
  }
  return false;
}

function canonicalBytes(value: unknown): Uint8Array | null {
  const parts: CanonicalParts = { bytes: 0, chunks: [] };
  if (!appendCanonical(value, parts)) return null;
  const result = new Uint8Array(parts.bytes);
  let offset = 0;
  for (const chunk of parts.chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function digestSource(revision: ProductContractRevisionV2): Readonly<Record<string, unknown>> {
  const source = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(revision)) {
    if (key !== "revisionDigest") source[key] = (revision as unknown as Record<string, unknown>)[key];
  }
  return Object.freeze(source);
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Browser-safe verification of the exact core v2 canonical digest domain. */
export async function validGate1RevisionDigest(
  revision: ProductContractRevisionV2,
): Promise<boolean> {
  try {
    if (canonicalBytes(revision) === null) return false;
    const domain = encoder.encode(DOMAIN);
    const body = canonicalBytes(digestSource(revision));
    if (body === null) return false;
    const input = new Uint8Array(domain.byteLength + 1 + body.byteLength);
    input.set(domain, 0);
    input.set(body, domain.byteLength + 1);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", input);
    return hex(digest) === revision.revisionDigest;
  } catch {
    return false;
  }
}
