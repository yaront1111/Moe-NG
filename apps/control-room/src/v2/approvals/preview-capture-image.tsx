import { useEffect, useState } from "react";
import type { JSX } from "react";

import type { CaptureLoader } from "../../live/live-preview-capture.js";

/**
 * ONE SCREENSHOT, shown through an object URL of bytes the loader fetched with the session
 * headers. The route path is NEVER put on an element: the capture route is credential-gated and
 * an `<img src>` can carry no header, so a bare src rendered every screenshot as a broken image
 * (measured: 403 on the route's own listener for the header set a same-origin image sends).
 *
 * THREE STATES, EACH SAID. Until the bytes arrive nothing pretends to be a picture; a refused
 * or failed load keeps the alt text and says the capture could not be loaded; only real bytes
 * become an `<img>`. The object URL is revoked when the element unmounts or its url changes,
 * and a load that settles after either is dropped rather than written to a gone element.
 */

export interface CaptureImageProps {
  readonly alt: string;
  readonly load: CaptureLoader;
  /** The capture route path `previewCaptureUrl` built. It is fetched, never set as a src. */
  readonly url: string;
}

type CaptureState =
  | Readonly<{ readonly kind: "LOADED"; readonly src: string }>
  | Readonly<{ readonly kind: "PENDING" }>
  | Readonly<{ readonly kind: "UNAVAILABLE" }>;

const PENDING: CaptureState = Object.freeze({ kind: "PENDING" });
const UNAVAILABLE: CaptureState = Object.freeze({ kind: "UNAVAILABLE" });

export function CaptureImage({ alt, load, url }: CaptureImageProps): JSX.Element {
  const [state, setState] = useState<CaptureState>(PENDING);
  useEffect(() => {
    let live = true;
    let objectUrl: string | null = null;
    setState(PENDING);
    void load(url).then((blob) => {
      if (!live) return;
      if (blob === null) { setState(UNAVAILABLE); return; }
      objectUrl = URL.createObjectURL(blob);
      setState(Object.freeze({ kind: "LOADED" as const, src: objectUrl }));
    }, () => { if (live) setState(UNAVAILABLE); });
    return (): void => {
      live = false;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [load, url]);
  if (state.kind === "LOADED") {
    return (
      <img alt={alt} className="cr2-preview-image" data-testid="cr.needsyou.preview.shot" src={state.src} />
    );
  }
  return (
    <span
      aria-label={alt}
      className="cr2-preview-image"
      data-state={state.kind}
      data-testid="cr.needsyou.preview.shot"
      role="img"
    >
      {state.kind === "PENDING" ? `${alt} is loading.` : `${alt} could not be loaded.`}
    </span>
  );
}
