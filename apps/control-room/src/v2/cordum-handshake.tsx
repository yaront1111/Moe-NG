import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";

import { resolveLiveSetupFromHandshake } from "../live/live-handshake.js";
import type {
  LiveHandshakeResult, LiveOperatorChannelUnavailable, LivePairingPending,
} from "../live/live-handshake.js";
import type { LiveSetupResult } from "../live/live-config.js";

/**
 * THE RUNTIME HANDSHAKE half of the v2 entry: resolving a live session, the
 * pairing lifecycle around it, and the two honest dead ends it can reach.
 *
 * Split out of `cordum-app.tsx` so neither file carries two jobs. This module owns
 * ATTACHING; the entry owns what is rendered once attached. Nothing here reads a
 * route, a goal or an affordance.
 *
 * `LiveAttempts` is re-exported by `cordum-app.tsx`, which is where `main.tsx`
 * imports it from - the split must not move a consumer's import.
 */

export type LiveResolution =
  | { readonly status: "OPERATOR_CHANNEL_UNAVAILABLE" }
  | { readonly status: "PENDING" }
  | { readonly busy: boolean; readonly pairing: LivePairingPending; readonly status: "PAIRING" }
  | { readonly status: "READY"; readonly setup: LiveSetupResult };

/** What the entry may be handed: one replay-safe attempt, or attempts with a retry. */
export type PreparedHandshake = Promise<LiveHandshakeResult> | LiveAttempts | undefined;

export interface LiveAttempts {
  readonly initial: Promise<LiveHandshakeResult>;
  retry(signal: AbortSignal): Promise<LiveHandshakeResult>;
}
interface NormalizedAttempts {
  readonly initial: Promise<LiveHandshakeResult>;
  readonly retry?: LiveAttempts["retry"] | undefined;
}
interface ActiveAttempt { readonly controller: AbortController }
function isPairingPending(result: LiveHandshakeResult): result is LivePairingPending {
  return "status" in result && result.status === "AWAITING_OPERATOR";
}
function isOperatorChannelUnavailable(
  result: LiveHandshakeResult,
): result is LiveOperatorChannelUnavailable {
  return "status" in result && result.status === "OPERATOR_CHANNEL_UNAVAILABLE";
}
// Exhaustive by construction: both guards run before the READY fallthrough, and
// TypeScript narrows the remainder to LiveSetupResult, so a daemon-stated
// no-terminal answer can never be miscast as an attached or refused session. Every
// settlement - the initial handshake AND a claim - lands here through `publish`.
function resolutionOf(result: LiveHandshakeResult): LiveResolution {
  if (isPairingPending(result)) return { busy: false, pairing: result, status: "PAIRING" };
  if (isOperatorChannelUnavailable(result)) return { status: "OPERATOR_CHANNEL_UNAVAILABLE" };
  return { setup: result, status: "READY" };
}
function unavailable(): LiveSetupResult {
  return { code: "LIVE_BOOTSTRAP_UNAVAILABLE", detail: "daemon bootstrap unavailable", ok: false };
}

function normalizeAttempts(
  prepared: Promise<LiveHandshakeResult> | LiveAttempts | undefined,
): NormalizedAttempts {
  if (prepared === undefined) {
    return { initial: resolveLiveSetupFromHandshake({
      fetchImpl: () => Promise.reject(new Error("runtime handshake was not prepared")),
    }) };
  }
  return "initial" in prepared ? prepared : { initial: prepared };
}
interface AttemptLifecycle {
  readonly activeRef: { current: ActiveAttempt | null };
  readonly generationRef: { current: number };
  readonly stale: (generation: number) => boolean;
}
function useAttemptLifecycle(
  attempts: NormalizedAttempts | null,
  publish: (result: LiveHandshakeResult) => void,
  setResolution: (resolution: LiveResolution) => void,
): AttemptLifecycle {
  const generationRef = useRef(0);
  const activeRef = useRef<ActiveAttempt | null>(null);
  const mountedRef = useRef(false);
  const stale = useCallback(
    (generation: number): boolean => generation !== generationRef.current || !mountedRef.current,
    [],
  );
  useEffect(() => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
      generationRef.current += 1;
      activeRef.current?.controller.abort();
      activeRef.current = null;
    };
  }, []);
  useEffect(() => {
    if (attempts === null) { generationRef.current += 1; activeRef.current?.controller.abort(); activeRef.current = null; return; }
    activeRef.current?.controller.abort();
    const controller = new AbortController();
    const generation = ++generationRef.current;
    activeRef.current = { controller };
    setResolution({ status: "PENDING" });
    void attempts.initial.then((result) => {
      if (stale(generation)) return;
      activeRef.current = null;
      publish(result);
    }, () => {
      if (stale(generation)) return;
      activeRef.current = null;
      publish(unavailable());
    });
  }, [attempts, publish, stale]);
  return { activeRef, generationRef, stale };
}
export function useLiveHandshake(enabled: boolean, prepared: PreparedHandshake) {
  const attempts = useMemo(() => enabled ? normalizeAttempts(prepared) : null, [enabled, prepared]);
  const [resolution, setResolution] = useState<LiveResolution>({ status: "PENDING" });
  const publish = useCallback((result: LiveHandshakeResult): void => {
    setResolution(resolutionOf(result));
  }, []);
  const { activeRef, generationRef, stale } = useAttemptLifecycle(
    attempts, publish, setResolution,
  );
  const claim = useCallback((): void => {
    if (resolution.status !== "PAIRING" || resolution.busy || activeRef.current !== null) return;
    const pairing = resolution.pairing;
    const controller = new AbortController();
    const generation = generationRef.current;
    activeRef.current = { controller };
    setResolution({ busy: true, pairing, status: "PAIRING" });
    void pairing.claim().then((result) => {
      if (stale(generation)) return;
      activeRef.current = null;
      publish(result);
    }, () => {
      if (stale(generation)) return;
      activeRef.current = null;
      publish({ code: "LIVE_PAIRING_REFUSED", detail: "session pairing refused", ok: false });
    });
  }, [publish, resolution, stale]);
  const retry = useCallback((): void => {
    if (attempts?.retry === undefined || activeRef.current !== null) return;
    const controller = new AbortController();
    const generation = ++generationRef.current;
    activeRef.current = { controller };
    setResolution({ status: "PENDING" });
    void Promise.resolve().then(() => attempts.retry?.(controller.signal) ?? unavailable())
      .then((result) => {
        if (stale(generation)) return;
        activeRef.current = null;
        publish(result);
      }, () => {
        if (stale(generation)) return;
        activeRef.current = null;
        publish(unavailable());
      });
  }, [attempts, publish, stale]);
  return { busy: activeRef.current !== null, claim, resolution, retry: attempts?.retry ? retry : undefined };
}
export function LiveRefusalNotice({ busy, onRetry, setup }: Readonly<{
  busy: boolean;
  onRetry: (() => void) | undefined;
  setup: Extract<LiveSetupResult, { readonly ok: false }>;
}>): JSX.Element {
  return <section aria-label="Live connection refusal"><p>{`${setup.code}: ${setup.detail}`}</p>
    {onRetry && <button disabled={busy} onClick={onRetry} type="button">Retry connection</button>}
  </section>;
}

/**
 * The daemon told us it has no terminal to read a pairing label from, so there is
 * nothing to type and no label worth showing. The only honest move left is a
 * restart instruction; this branch renders it and nothing else, deliberately
 * bypassing PairingConfirmation rather than showing an unusable pairing ritual.
 */
const NO_OPERATOR_CHANNEL_COPY = "Moe was started without a terminal it can listen on."
  + " Stop it and run pnpm start from a terminal window, then reload this page.";
export function NoOperatorChannel(): JSX.Element {
  return <div className="cr2-pairing">
    <section aria-label="Pairing unavailable" className="cr2-pairing-card">
      <p className="cr2-pairing-note">{NO_OPERATOR_CHANNEL_COPY}</p>
    </section>
  </div>;
}
