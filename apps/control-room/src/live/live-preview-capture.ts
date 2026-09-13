/**
 * THE CAPTURE BYTES, fetched with the session headers.
 *
 * WHY THE CARD CANNOT USE A BARE `<img src>`. The capture route is credential-gated: it demands
 * the CSRF token and the session credential, both custom request headers, and an image element
 * can carry neither. Measured on the route's own listener with the header set a same-origin
 * `<img>` sends: 403, so every screenshot on every preview card rendered as a broken image.
 * The bytes are fetched here with the SAME header bundle every other read sends - a same-origin
 * GET, which carries no Origin and which the route's fence admits - and the element is given
 * the object URL of the result (`preview-capture-image.tsx`).
 *
 * NULL IS THE ONLY FAILURE. A refusal body, a wrong media type, a transport fault and a timeout
 * all answer null: the card then says the capture could not be loaded rather than showing a
 * broken image, and never learns or renders anything a refusal body might carry.
 */

/** Fetches ONE capture by its route path; null means it was refused or could not be read. */
export type CaptureLoader = (url: string) => Promise<Blob | null>;

const CAPTURE_TIMEOUT_MS = 15_000;
/** The one media type the route publishes; anything else is a refusal body, never a picture. */
const CAPTURE_CONTENT_TYPE = "image/png";

/** The session bundle minus the JSON content-type, which a GET without a body has no use for. */
export function captureHeadersOf(
  headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() !== "content-type"),
  ));
}

export function createCaptureLoader(
  headers: Readonly<Record<string, string>>,
  fetchImpl: typeof fetch = fetch,
): CaptureLoader {
  const sent = captureHeadersOf(headers);
  return async (url: string): Promise<Blob | null> => {
    try {
      const response = await fetchImpl(url, {
        headers: sent, method: "GET", signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
      });
      const type = response.headers.get("content-type") ?? "";
      if (response.status !== 200 || !type.startsWith(CAPTURE_CONTENT_TYPE)) return null;
      return await response.blob();
    } catch {
      return null;
    }
  };
}
