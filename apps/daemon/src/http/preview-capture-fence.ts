/**
 * THE CAPTURE ROUTE'S HEADER FENCE, and why it is not `checkHeaders`.
 *
 * `checkHeaders` demands an `Origin` equal to the listener's own, which is right for the JSON
 * surface: every route there is a POST, and a browser appends `Origin` to every request whose
 * method is not GET or HEAD. The capture route is GET-only, and the Fetch standard appends
 * `Origin` to a GET only when the request is cross-origin. The hosted control room loads a
 * capture from the very origin that served it, so its request carries NO Origin whatever
 * element or API issues it - and behind that fence every screenshot on every preview card
 * answered 403 LISTENER_ORIGIN_INVALID (measured on the route's own listener with the header
 * set a same-origin fetch and a same-origin `<img>` send). `serveBootstrap` records the same
 * reasoning for the one other GET this listener answers to a browser.
 *
 * WHAT STAYS. Host must match. An Origin that IS presented must match, so a cross-origin fetch,
 * which does carry one, is refused exactly as before. `Sec-Fetch-Site`, which every current
 * browser attaches, must say same-origin when present, so a cross-site document is refused
 * even if it somehow attached the custom headers. The CSRF token is still required, and the
 * handler behind this fence still requires the session credential: both are custom headers,
 * which no cross-origin document can attach without a preflight this listener never grants,
 * and which no bare `<img src>` can carry at all - the control room FETCHES the bytes with its
 * session headers and shows them through an object URL. Nothing here is weaker for a
 * non-browser caller, which could already forge every header this fence reads.
 */
import type { IncomingMessage } from "node:http";

import { CSRF_HEADER } from "./http-listener-guards.js";
import type { ListenerRefusalCode } from "./http-listener-guards.js";

/** The one `Sec-Fetch-Site` value a browser gives a request from the page this daemon hosts. */
const SAME_ORIGIN_SITE = "same-origin";

export function checkPreviewCaptureHeaders(
  request: IncomingMessage,
  expectedAuthority: string,
  origin: string,
  csrfToken: string,
): ListenerRefusalCode | null {
  if (request.headers.host !== expectedAuthority) return "LISTENER_HOST_INVALID";
  // Absent is the same-origin GET shape; present and foreign is a cross-origin caller.
  const presented = request.headers.origin;
  if (presented !== undefined && presented !== origin) return "LISTENER_ORIGIN_INVALID";
  // A repeated header arrives as an array and compares unequal, which refuses it.
  const site = request.headers["sec-fetch-site"];
  if (site !== undefined && site !== SAME_ORIGIN_SITE) return "LISTENER_ORIGIN_INVALID";
  // An empty configured token satisfies NO request, the same rule `checkHeaders` states.
  if (csrfToken === "" || request.headers[CSRF_HEADER] !== csrfToken) {
    return "LISTENER_CSRF_INVALID";
  }
  return null;
}
