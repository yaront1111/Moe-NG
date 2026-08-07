import type { BoundedJsonErrorCode } from "./bounded-json-model.js";
import { MAX_JSON_STRING_UTF8_BYTES } from "./input-limits.js";

type JsonStringErrorCode = Extract<
  BoundedJsonErrorCode,
  "JSON_STRING_LIMIT_EXCEEDED" | "JSON_SYNTAX_INVALID" | "JSON_UNICODE_INVALID"
>;

interface JsonStringScanOk {
  readonly ok: true;
  readonly value: string;
  readonly nextIndex: number;
}

interface JsonStringScanError {
  readonly ok: false;
  readonly code: JsonStringErrorCode;
}

export type JsonStringScanResult = JsonStringScanOk | JsonStringScanError;

interface EscapeOk {
  readonly ok: true;
  readonly value: string;
  readonly byteLength: number;
  readonly nextIndex: number;
}

type EscapeResult = EscapeOk | JsonStringScanError;

const OUTPUT_CHUNK_CODE_UNITS = 4096;

function error(code: JsonStringErrorCode): JsonStringScanError {
  return { ok: false, code };
}

function isHexDigit(codeUnit: number): boolean {
  return (
    (codeUnit >= 0x30 && codeUnit <= 0x39) ||
    (codeUnit >= 0x41 && codeUnit <= 0x46) ||
    (codeUnit >= 0x61 && codeUnit <= 0x66)
  );
}

function readHexCodeUnit(text: string, index: number): number | undefined {
  if (index + 4 > text.length) return undefined;
  for (let offset = 0; offset < 4; offset += 1) {
    if (!isHexDigit(text.charCodeAt(index + offset))) return undefined;
  }
  return Number.parseInt(text.slice(index, index + 4), 16);
}

function utf8ByteLength(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function simpleEscape(codeUnit: number): string | undefined {
  if (codeUnit === 0x22) return '"';
  if (codeUnit === 0x5c) return "\\";
  if (codeUnit === 0x2f) return "/";
  if (codeUnit === 0x62) return "\b";
  if (codeUnit === 0x66) return "\f";
  if (codeUnit === 0x6e) return "\n";
  if (codeUnit === 0x72) return "\r";
  if (codeUnit === 0x74) return "\t";
  return undefined;
}

function scanEscape(text: string, index: number): EscapeResult {
  if (index >= text.length) return error("JSON_SYNTAX_INVALID");
  const codeUnit = text.charCodeAt(index);
  const simple = simpleEscape(codeUnit);
  if (simple !== undefined) {
    return { ok: true, value: simple, byteLength: 1, nextIndex: index + 1 };
  }
  if (codeUnit !== 0x75) return error("JSON_SYNTAX_INVALID");

  const high = readHexCodeUnit(text, index + 1);
  if (high === undefined) return error("JSON_SYNTAX_INVALID");
  let nextIndex = index + 5;
  if (high >= 0xdc00 && high <= 0xdfff) return error("JSON_UNICODE_INVALID");
  if (high < 0xd800 || high > 0xdbff) {
    return {
      ok: true,
      value: String.fromCharCode(high),
      byteLength: utf8ByteLength(high),
      nextIndex,
    };
  }

  if (text.charCodeAt(nextIndex) !== 0x5c || text.charCodeAt(nextIndex + 1) !== 0x75) {
    return error("JSON_UNICODE_INVALID");
  }
  const low = readHexCodeUnit(text, nextIndex + 2);
  if (low === undefined) return error("JSON_SYNTAX_INVALID");
  if (low < 0xdc00 || low > 0xdfff) return error("JSON_UNICODE_INVALID");
  nextIndex += 6;
  const codePoint = 0x10000 + ((high - 0xd800) << 10) + (low - 0xdc00);
  return {
    ok: true,
    value: String.fromCodePoint(codePoint),
    byteLength: 4,
    nextIndex,
  };
}

export function scanBoundedJsonString(text: string, openingQuoteIndex: number): JsonStringScanResult {
  if (text.charCodeAt(openingQuoteIndex) !== 0x22) return error("JSON_SYNTAX_INVALID");
  let index = openingQuoteIndex + 1;
  let segmentStart = index;
  let decodedBytes = 0;
  let outputChunk = "";
  const outputChunks: string[] = [];

  const appendOutput = (value: string): void => {
    if (value.length === 0) return;
    outputChunk += value;
    if (outputChunk.length >= OUTPUT_CHUNK_CODE_UNITS) {
      outputChunks.push(outputChunk);
      outputChunk = "";
    }
  };
  const addBytes = (byteLength: number): boolean => {
    decodedBytes += byteLength;
    return decodedBytes <= MAX_JSON_STRING_UTF8_BYTES;
  };

  while (index < text.length) {
    const codeUnit = text.charCodeAt(index);
    if (codeUnit === 0x22) {
      appendOutput(text.slice(segmentStart, index));
      if (outputChunk.length > 0) outputChunks.push(outputChunk);
      return { ok: true, value: outputChunks.join(""), nextIndex: index + 1 };
    }
    if (codeUnit === 0x5c) {
      appendOutput(text.slice(segmentStart, index));
      const escaped = scanEscape(text, index + 1);
      if (!escaped.ok) return escaped;
      if (!addBytes(escaped.byteLength)) return error("JSON_STRING_LIMIT_EXCEEDED");
      appendOutput(escaped.value);
      index = escaped.nextIndex;
      segmentStart = index;
      continue;
    }
    if (codeUnit < 0x20) return error("JSON_SYNTAX_INVALID");
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const low = text.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) return error("JSON_UNICODE_INVALID");
      if (!addBytes(4)) return error("JSON_STRING_LIMIT_EXCEEDED");
      index += 2;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return error("JSON_UNICODE_INVALID");
    if (!addBytes(utf8ByteLength(codeUnit))) return error("JSON_STRING_LIMIT_EXCEEDED");
    index += 1;
  }
  return error("JSON_SYNTAX_INVALID");
}
