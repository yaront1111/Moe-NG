const DECIMAL_PATTERN = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

function normalizeDecimal(source: string): string | undefined {
  const match = DECIMAL_PATTERN.exec(source);
  if (!match) return undefined;
  const negative = match[1] === "-";
  const integer = match[2] as string;
  const fraction = match[3] ?? "";
  const digits = `${integer}${fraction}`;
  let firstNonzero = 0;
  while (firstNonzero < digits.length && digits.charCodeAt(firstNonzero) === 0x30) {
    firstNonzero += 1;
  }
  if (firstNonzero === digits.length) return "0";

  let coefficient = digits.slice(firstNonzero);
  let exponent = Number(match[4] ?? "0") - fraction.length;
  if (!Number.isSafeInteger(exponent)) return undefined;
  while (coefficient.charCodeAt(coefficient.length - 1) === 0x30) {
    coefficient = coefficient.slice(0, -1);
    exponent += 1;
  }
  return `${negative ? "-" : ""}${coefficient}e${exponent}`;
}

/**
 * Applies the command plane's interoperable-number policy. Decimal spelling
 * must round-trip without changing its mathematical value, underflow is
 * refused, and integer results stay inside JavaScript's exact safe range.
 */
export function parseInteroperableJsonNumber(source: string): number | undefined {
  const value = Number(source);
  if (!Number.isFinite(value)) return undefined;
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) return undefined;

  const sourceDecimal = normalizeDecimal(source);
  const decodedDecimal = normalizeDecimal(value.toString());
  if (sourceDecimal === undefined || sourceDecimal !== decodedDecimal) return undefined;
  return value;
}
