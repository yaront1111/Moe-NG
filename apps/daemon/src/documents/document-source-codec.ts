import { createHash } from "node:crypto";

import { decodeBoundedJsonBytes } from "@moe/contracts";

import {
  DOCUMENT_INGEST_MEDIA_TYPES,
  DOCUMENT_SOURCE_EXCERPT_MAX_CODE_UNITS,
  DOCUMENT_SOURCE_SCHEMA_VERSION,
  MAX_DOCUMENT_INGEST_TEXT_UTF8_BYTES,
} from "./document-source-contract.js";
import type {
  DocumentIngestMediaType,
  DocumentSourceRecord,
  DocumentSourceView,
} from "./document-source-contract.js";
import { exactDataRecord, sha256String } from "./document-work-safe-value.js";

const encoder = new TextEncoder();
const RECORD_KEYS = Object.freeze([
  "byteLength", "contentSha256", "displayPath", "mediaType", "schemaVersion", "text",
]);
const FALLBACK_TITLE = "Untitled document";

/** A control code the single-line surfaces refuse and the title extractor strips: C0 controls
 *  and DEL. Named as a predicate rather than a regex so no escape survives a tool round-trip. */
function isControlCode(code: number): boolean {
  return code <= 0x1f || code === 0x7f;
}

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(encoder.encode(value)).digest("hex");
}

/** Canonical text: a non-empty, well-formed, NFC string with no NUL. Multi-line text (the
 *  document body) keeps its newlines; a single-line field additionally rejects every control
 *  code, so a display path can never smuggle a newline or an escape. */
export function isCanonicalText(value: unknown, singleLine: boolean): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (!value.isWellFormed() || value.normalize("NFC") !== value) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0) return false;
    if (singleLine && isControlCode(code)) return false;
  }
  return true;
}

export function isIngestMediaType(value: unknown): value is DocumentIngestMediaType {
  return typeof value === "string"
    && (DOCUMENT_INGEST_MEDIA_TYPES as readonly string[]).includes(value);
}

/** Slice at a code-unit bound without splitting a surrogate pair: a lone trailing high
 *  surrogate would make the result not well-formed, so it is dropped. */
function boundCodeUnits(value: string, maximum: number): { text: string; truncated: boolean } {
  if (value.length <= maximum) return { text: value, truncated: false };
  let end = maximum;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: value.slice(0, end), truncated: true };
}

/** Deterministic canonical bytes: a fixed key order, so the same record always encodes to the
 *  same bytes and the store recognises a re-ingest as a replay. */
export function encodeDocumentSourceRecord(record: DocumentSourceRecord): Uint8Array {
  return encoder.encode(JSON.stringify({
    byteLength: record.byteLength,
    contentSha256: record.contentSha256,
    displayPath: record.displayPath,
    mediaType: record.mediaType,
    schemaVersion: record.schemaVersion,
    text: record.text,
  }));
}

/**
 * Decodes stored text bytes and proves content addressing: the record's declared sha and byte
 * length must be exactly the sha and length of the stored text, and the media type must be in
 * the roster. Any mismatch returns null - the read model treats that as tampering and refuses.
 */
export function decodeDocumentSourceRecord(input: unknown): DocumentSourceRecord | null {
  const decoded = decodeBoundedJsonBytes(input);
  if (!decoded.ok) return null;
  const record = exactDataRecord(decoded.value, RECORD_KEYS);
  if (record === null) return null;
  const { byteLength, contentSha256, displayPath, mediaType, schemaVersion, text } = record;
  if (
    schemaVersion !== DOCUMENT_SOURCE_SCHEMA_VERSION
    || !isIngestMediaType(mediaType)
    || !isCanonicalText(displayPath, true)
    || (displayPath as string).length > 256
    || !isCanonicalText(text, false)
    || utf8ByteLength(text as string) > MAX_DOCUMENT_INGEST_TEXT_UTF8_BYTES
    || !Number.isSafeInteger(byteLength)
    || (byteLength as number) !== utf8ByteLength(text as string)
    || !sha256String(contentSha256)
    || (contentSha256 as string) !== sha256Hex(text as string)
  ) return null;
  return Object.freeze({
    byteLength: byteLength as number,
    contentSha256: contentSha256 as string,
    displayPath: displayPath as string,
    mediaType,
    schemaVersion: DOCUMENT_SOURCE_SCHEMA_VERSION,
    text: text as string,
  });
}

/** The bounded projection a read hands the page: excerpt truncated at the excerpt cap, with the
 *  FULL byte length beside it so the caller is never misled about the document's size. */
export function documentSourceView(record: DocumentSourceRecord): DocumentSourceView {
  const excerpt = boundCodeUnits(record.text, DOCUMENT_SOURCE_EXCERPT_MAX_CODE_UNITS);
  return Object.freeze({
    byteLength: record.byteLength,
    contentSha256: record.contentSha256,
    displayPath: record.displayPath,
    excerpt: excerpt.text,
    excerptTruncated: excerpt.truncated,
    mediaType: record.mediaType,
  });
}

/** Collapses runs of ASCII space, dropping control codes, and NFC-normalises. */
function normalizeTitle(line: string): string {
  let out = "";
  let pendingSpace = false;
  for (let index = 0; index < line.length; index += 1) {
    const code = line.charCodeAt(index);
    if (code === 0x20 || isControlCode(code)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) {
      out += " ";
      pendingSpace = false;
    }
    out += line[index];
  }
  return out.normalize("NFC");
}

/**
 * The provisional candidate title: the first Markdown heading (leading `#` run stripped) or the
 * first non-empty line, sanitised to a single bounded line. Real candidate authoring is a later
 * milestone; this is a placeholder so the proposal carries one well-formed candidate.
 */
export function provisionalTitle(text: string, markdown: boolean): string {
  for (const rawLine of text.split("\n")) {
    let line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (markdown) {
      let cut = 0;
      while (cut < line.length && line.charCodeAt(cut) === 0x23) cut += 1;
      if (cut > 0) line = line.slice(cut);
    }
    const normalized = normalizeTitle(line).trim();
    if (normalized.length === 0) continue;
    const bounded = boundCodeUnits(normalized, 256).text;
    const title = bounded.isWellFormed() ? bounded : bounded.slice(0, bounded.length - 1);
    if (isCanonicalText(title, true)) return title;
  }
  return FALLBACK_TITLE;
}
