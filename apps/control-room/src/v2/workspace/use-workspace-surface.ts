import { useEffect, useState } from "react";
import { createBoardFeed } from "../../live/live-board-feed.js";
import type { SurfaceFrame } from "../../live/live-board-feed.js";

/** The product owns its live authority feed; mounting inspection never starts another. */
export function useWorkspaceSurface(
  headers: Readonly<Record<string, string>>, subject: string,
  onConnection?: ((connection: SurfaceFrame["connection"]) => void) | undefined,
): SurfaceFrame | null {
  const [held, setHeld] = useState<{
    headers: Readonly<Record<string, string>>; subject: string; frame: SurfaceFrame;
  } | null>(null);
  useEffect(() => {
    let active = true;
    const feed = createBoardFeed({ headers, intervalMs: 2_000, onFrame: (frame) => {
      if (!active) return;
      setHeld({ headers, subject, frame }); onConnection?.(frame.connection);
    } });
    feed.start();
    return () => { active = false; feed.stop(); };
  }, [headers, subject, onConnection]);
  return held?.headers === headers && held.subject === subject ? held.frame : null;
}
