/** Bound serialized query answers, including metadata, escaping and multibyte text. */
export const JSON_READ_PAGE_MAX_BYTES = 8192;
export const JSON_READ_PAGE_MAX_CHARS = 4096;
const encoder = new TextEncoder();

/** Offsets count UTF-16 code units. JSON escapes a split surrogate losslessly, so
 * concatenating decoded text fragments restores the exact original JSON document. */
export function jsonReadPage(text: string, offset: number, limit: number,
  metadata: Readonly<Record<string, unknown>>): Uint8Array | null {
  const page = (end: number): Uint8Array => encoder.encode(JSON.stringify({
    ...metadata, offset, limit, nextOffset: end < text.length ? end : null,
    totalLength: text.length, text: text.slice(offset, end),
  }));
  let low = offset, high = Math.min(text.length, offset + limit);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (page(middle).length <= JSON_READ_PAGE_MAX_BYTES) low = middle;
    else high = middle - 1;
  }
  const result = page(low);
  return result.length > JSON_READ_PAGE_MAX_BYTES || (low === offset && low < text.length) ? null : result;
}
