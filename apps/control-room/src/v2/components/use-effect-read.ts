import { useCallback, useEffect, useRef, useState } from "react";
/** Reader identity is the authority scope; old data disappears on credential/goal changes. */
export function useEffectRead<T>(read: () => Promise<T>, failure: T, pollMs = 5_000) {
  const [frame, setFrame] = useState<{ read: () => Promise<T>; value: T } | null>(null);
  const tick = useRef<() => void>(() => undefined);
  useEffect(() => {
    let live = true, busy = false, queued = false;
    const refresh = (): void => {
      if (!live) return;
      if (busy) { queued = true; return; }
      busy = true;
      void Promise.resolve().then(read).catch(() => failure).then((value) => {
        if (!live) return;
        setFrame({ read, value }); busy = false;
        if (queued) { queued = false; refresh(); }
      });
    };
    tick.current = refresh; refresh();
    const timer = setInterval(refresh, pollMs);
    return () => { live = false; tick.current = () => undefined; clearInterval(timer); };
  }, [read, failure, pollMs]);
  const refresh = useCallback(() => { tick.current(); }, []);
  return { outcome: frame?.read === read ? frame.value : null, refresh };
}
