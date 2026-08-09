import { useEffect, useState } from "react";

export type ViewportMode = "COMFORTABLE" | "FUNCTIONAL" | "NARROW";
export type ViewportRefusalReason = "INVALID_VIEWPORT_WIDTH";

export type ViewportResolution =
  | Readonly<{ readonly mode: ViewportMode; readonly ok: true }>
  | Readonly<{ readonly ok: false; readonly reason: ViewportRefusalReason }>;

export interface ViewportRung {
  readonly minimumWidth: number;
  readonly mode: ViewportMode;
}

function rung(mode: ViewportMode, minimumWidth: number): ViewportRung {
  return Object.freeze({ minimumWidth, mode });
}

export const VIEWPORT_WIDTH_LADDER: readonly ViewportRung[] = Object.freeze([
  rung("COMFORTABLE", 1_200),
  rung("FUNCTIONAL", 960),
  rung("NARROW", 0),
]);

const INVALID_WIDTH: ViewportResolution = Object.freeze({
  ok: false,
  reason: "INVALID_VIEWPORT_WIDTH",
});

export function classifyViewportWidth(width: number): ViewportResolution {
  if (!Number.isFinite(width) || width < 0) return INVALID_WIDTH;
  const matched = VIEWPORT_WIDTH_LADDER.find((candidate) => width >= candidate.minimumWidth);
  if (matched === undefined) return INVALID_WIDTH;
  return Object.freeze({ mode: matched.mode, ok: true });
}

function currentViewport(): ViewportResolution {
  return typeof window === "undefined"
    ? INVALID_WIDTH
    : classifyViewportWidth(window.innerWidth);
}

export function useViewportMode(): ViewportResolution {
  const [resolution, setResolution] = useState(currentViewport);
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const handleResize = (): void => setResolution(currentViewport());
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);
  return resolution;
}
