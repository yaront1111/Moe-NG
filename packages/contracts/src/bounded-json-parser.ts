import type { BoundedJsonErrorCode, JsonObject, JsonValue } from "./bounded-json-model.js";
import { parseInteroperableJsonNumber } from "./bounded-json-number.js";
import { scanBoundedJsonString } from "./bounded-json-string.js";
import { MAX_JSON_DEPTH } from "./input-limits.js";

export class BoundedJsonParseError extends Error {
  readonly code: BoundedJsonErrorCode;

  constructor(code: BoundedJsonErrorCode, message: string) {
    super(message);
    this.name = "BoundedJsonParseError";
    this.code = code;
  }
}

function fail(code: BoundedJsonErrorCode, message: string): never {
  throw new BoundedJsonParseError(code, message);
}

function isDigit(codeUnit: number): boolean {
  return codeUnit >= 0x30 && codeUnit <= 0x39;
}

class Parser {
  readonly #text: string;
  #index = 0;
  #duplicateFound = false;

  constructor(text: string) {
    this.#text = text;
  }

  parse(): JsonValue {
    this.#skipWhitespace();
    const value = this.#parseValue(0);
    this.#skipWhitespace();
    if (this.#index !== this.#text.length) {
      return fail("JSON_SYNTAX_INVALID", "JSON text is not syntactically valid.");
    }
    if (this.#duplicateFound) {
      return fail("JSON_DUPLICATE_KEY", "JSON object contains a duplicate decoded key.");
    }
    return value;
  }

  #parseValue(depth: number): JsonValue {
    const codeUnit = this.#text.charCodeAt(this.#index);
    if (codeUnit === 0x22) return this.#parseString();
    if (codeUnit === 0x5b) return this.#parseArray(depth);
    if (codeUnit === 0x7b) return this.#parseObject(depth);
    if (codeUnit === 0x74) return this.#parseLiteral("true", true);
    if (codeUnit === 0x66) return this.#parseLiteral("false", false);
    if (codeUnit === 0x6e) return this.#parseLiteral("null", null);
    if (codeUnit === 0x2d || isDigit(codeUnit)) return this.#parseNumber();
    return fail("JSON_SYNTAX_INVALID", "JSON text is not syntactically valid.");
  }

  #parseLiteral<T extends boolean | null>(source: string, value: T): T {
    if (!this.#text.startsWith(source, this.#index)) {
      return fail("JSON_SYNTAX_INVALID", "JSON text is not syntactically valid.");
    }
    this.#index += source.length;
    return value;
  }

  #parseArray(depth: number): readonly JsonValue[] {
    this.#assertContainerDepth(depth);
    this.#index += 1;
    const values: JsonValue[] = [];
    this.#skipWhitespace();
    if (this.#consume(0x5d)) return values;

    while (true) {
      this.#skipWhitespace();
      values.push(this.#parseValue(depth + 1));
      this.#skipWhitespace();
      if (this.#consume(0x5d)) return values;
      if (!this.#consume(0x2c)) {
        return fail("JSON_SYNTAX_INVALID", "JSON text is not syntactically valid.");
      }
    }
  }

  #parseObject(depth: number): JsonObject {
    this.#assertContainerDepth(depth);
    this.#index += 1;
    const value = Object.create(null) as Record<string, JsonValue>;
    const keys = new Set<string>();
    this.#skipWhitespace();
    if (this.#consume(0x7d)) return value;

    while (true) {
      this.#skipWhitespace();
      if (this.#text.charCodeAt(this.#index) !== 0x22) {
        return fail("JSON_SYNTAX_INVALID", "JSON text is not syntactically valid.");
      }
      const key = this.#parseString();
      const duplicate = keys.has(key);
      this.#duplicateFound ||= duplicate;
      if (!duplicate) keys.add(key);
      this.#skipWhitespace();
      if (!this.#consume(0x3a)) {
        return fail("JSON_SYNTAX_INVALID", "JSON text is not syntactically valid.");
      }
      this.#skipWhitespace();
      const memberValue = this.#parseValue(depth + 1);
      if (!duplicate) {
        Object.defineProperty(value, key, {
          configurable: true,
          enumerable: true,
          value: memberValue,
          writable: true,
        });
      }
      this.#skipWhitespace();
      if (this.#consume(0x7d)) return value;
      if (!this.#consume(0x2c)) {
        return fail("JSON_SYNTAX_INVALID", "JSON text is not syntactically valid.");
      }
    }
  }

  #parseString(): string {
    const result = scanBoundedJsonString(this.#text, this.#index);
    if (!result.ok) {
      return fail(result.code, "JSON string could not be decoded within its contract.");
    }
    this.#index = result.nextIndex;
    return result.value;
  }

  #parseNumber(): number {
    const start = this.#index;
    if (this.#consume(0x2d) && !isDigit(this.#text.charCodeAt(this.#index))) {
      return fail("JSON_SYNTAX_INVALID", "JSON text is not syntactically valid.");
    }
    if (this.#consume(0x30)) {
      if (isDigit(this.#text.charCodeAt(this.#index))) {
        return fail("JSON_SYNTAX_INVALID", "JSON text is not syntactically valid.");
      }
    } else {
      if (!this.#consumeDigit(0x31, 0x39)) {
        return fail("JSON_SYNTAX_INVALID", "JSON text is not syntactically valid.");
      }
      while (this.#consumeDigit(0x30, 0x39)) {
        // Consume the integer tail.
      }
    }
    if (this.#consume(0x2e)) {
      if (!this.#consumeDigit(0x30, 0x39)) {
        return fail("JSON_SYNTAX_INVALID", "JSON text is not syntactically valid.");
      }
      while (this.#consumeDigit(0x30, 0x39)) {
        // Consume the fractional tail.
      }
    }
    const exponent = this.#text.charCodeAt(this.#index);
    if (exponent === 0x45 || exponent === 0x65) {
      this.#index += 1;
      const sign = this.#text.charCodeAt(this.#index);
      if (sign === 0x2b || sign === 0x2d) this.#index += 1;
      if (!this.#consumeDigit(0x30, 0x39)) {
        return fail("JSON_SYNTAX_INVALID", "JSON text is not syntactically valid.");
      }
      while (this.#consumeDigit(0x30, 0x39)) {
        // Consume the exponent tail.
      }
    }
    const value = parseInteroperableJsonNumber(this.#text.slice(start, this.#index));
    if (value === undefined) {
      return fail(
        "JSON_NUMBER_RANGE_INVALID",
        "JSON number is outside the supported finite precision range.",
      );
    }
    return value;
  }

  #assertContainerDepth(depth: number): void {
    if (depth >= MAX_JSON_DEPTH) {
      fail("JSON_DEPTH_LIMIT_EXCEEDED", `JSON nesting exceeds ${MAX_JSON_DEPTH} containers.`);
    }
  }

  #skipWhitespace(): void {
    while (true) {
      const codeUnit = this.#text.charCodeAt(this.#index);
      if (codeUnit !== 0x20 && codeUnit !== 0x09 && codeUnit !== 0x0a && codeUnit !== 0x0d) return;
      this.#index += 1;
    }
  }

  #consume(codeUnit: number): boolean {
    if (this.#text.charCodeAt(this.#index) !== codeUnit) return false;
    this.#index += 1;
    return true;
  }

  #consumeDigit(minimum: number, maximum: number): boolean {
    if (this.#index >= this.#text.length) return false;
    const codeUnit = this.#text.charCodeAt(this.#index);
    if (codeUnit < minimum || codeUnit > maximum) return false;
    this.#index += 1;
    return true;
  }
}

export function parseBoundedJsonText(text: string): JsonValue {
  return new Parser(text).parse();
}
