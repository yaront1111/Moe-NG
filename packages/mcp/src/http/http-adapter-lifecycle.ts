export interface HttpAdapterLifecycle {
  readonly signal: AbortSignal;
  close(): Promise<void>;
}

/**
 * Seals admission synchronously and shares one cleanup result, including a rejected result.
 * External authentication and binding promises are not shutdown dependencies: callers check
 * this signal after those boundaries settle and compensate a binding accepted after close.
 */
export function createHttpAdapterLifecycle(release: () => Promise<void>): HttpAdapterLifecycle {
  const controller = new AbortController();
  let closing: Promise<void> | undefined;
  return {
    signal: controller.signal,
    close(): Promise<void> {
      if (closing !== undefined) return closing;
      closing = Promise.resolve().then(release);
      controller.abort();
      return closing;
    },
  };
}

/**
 * Initialization can bind before its JSON response exists. The SDK may suppress that response
 * on close, so the attachment's latch must settle initialization just as it settles later POSTs.
 * Deregister on normal completion to avoid retaining a finished response for the session's life.
 */
export function settleHttpResponseOnClose(
  latch: { subscribe(onClose: () => void): () => void },
  dispatch: () => Promise<Response>,
  closed: () => Response,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    let alreadyClosed = false;
    const unsubscribe = latch.subscribe(() => { alreadyClosed = true; resolve(closed()); });
    if (alreadyClosed) { unsubscribe(); return; }
    void Promise.resolve().then(() => alreadyClosed ? closed() : dispatch())
      .then(resolve, reject).finally(unsubscribe);
  });
}
