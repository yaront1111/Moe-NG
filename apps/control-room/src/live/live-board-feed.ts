/**
 * Polls the daemon's affordance surface and shapes what it says — verbatim.
 *
 * Discipline copied from live-event-feed.ts: an undelivered round trip is
 * DISCONNECTED with the local code; any daemon answer (SURFACE or REFUSED) is
 * CONNECTED carrying the daemon's own fields; a malformed body is
 * LIVE_SURFACE_UNREADABLE. Steps and offered commands are copied field-for-field
 * so a dispatch later presents the daemon's own identity back to it untouched.
 */

export interface SurfaceStep {
  readonly aggregateId: string | null;
  readonly kind: string;
  readonly missing: readonly string[];
  readonly status: "BLOCKED" | "COMMITTED" | "READY";
  readonly version: number | null;
}

export interface SurfaceFrame {
  readonly connection: "CONNECTED" | "DISCONNECTED";
  readonly detail: string;
  /** The daemon's NextAllowedCommand objects, untouched. */
  readonly offers: readonly Record<string, unknown>[];
  readonly outcome: string;
  readonly steps: readonly SurfaceStep[];
}

export interface BoardFeedOptions {
  readonly headers: Readonly<Record<string, string>>;
  readonly intervalMs: number;
  readonly onFrame: (frame: SurfaceFrame) => void;
  readonly post?: ((body: string) => Promise<Response>) | undefined;
  readonly schedule?: ((run: () => void, delayMs: number) => () => void) | undefined;
}

export interface BoardFeed {
  start(): void;
  stop(): void;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stepOf(value: unknown): SurfaceStep | null {
  if (!isRecord(value)) return null;
  const status = value["status"];
  if (status !== "BLOCKED" && status !== "COMMITTED" && status !== "READY") return null;
  const kind = text(value["kind"]);
  if (kind === "") return null;
  const aggregateId = value["aggregateId"];
  if (aggregateId !== null && typeof aggregateId !== "string") return null;
  const missing = value["missing"];
  if (!Array.isArray(missing) || !missing.every((entry) => typeof entry === "string")) return null;
  const version = value["version"];
  if (version !== null
    && (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0)) return null;
  return Object.freeze({
    aggregateId,
    kind,
    missing: Object.freeze([...missing]) as readonly string[],
    status,
    version,
  });
}

function offerOf(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (text(value["commandId"]) === "" || text(value["commandKind"]) === ""
    || text(value["targetAggregateId"]) === "") return null;
  const expectedVersion = value["expectedVersion"];
  if (typeof expectedVersion !== "number"
    || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) return null;
  return Object.freeze({ ...value });
}

function frame(
  connection: SurfaceFrame["connection"],
  outcome: string,
  detail: string,
  steps: readonly SurfaceStep[] = [],
  offers: readonly Record<string, unknown>[] = [],
): SurfaceFrame {
  return Object.freeze({
    connection, detail, offers: Object.freeze([...offers]), outcome,
    steps: Object.freeze([...steps]),
  });
}

export function frameOfSurface(response: unknown): SurfaceFrame {
  if (!isRecord(response)) return frame("CONNECTED", "UNREADABLE", "LIVE_SURFACE_UNREADABLE");
  const outcome = text(response["outcome"]);
  if (outcome === "SURFACE") {
    const rawSteps = response["steps"];
    const rawOffers = response["nextAllowedCommands"];
    if (!Array.isArray(rawSteps) || !Array.isArray(rawOffers)) {
      return frame("CONNECTED", "UNREADABLE", "LIVE_SURFACE_UNREADABLE");
    }
    const steps: SurfaceStep[] = [];
    for (const rawStep of rawSteps) {
      const step = stepOf(rawStep);
      if (step === null) return frame("CONNECTED", "UNREADABLE", "LIVE_SURFACE_UNREADABLE");
      steps.push(step);
    }
    const offers: Record<string, unknown>[] = [];
    for (const rawOffer of rawOffers) {
      const offer = offerOf(rawOffer);
      if (offer === null) return frame("CONNECTED", "UNREADABLE", "LIVE_SURFACE_UNREADABLE");
      offers.push(offer);
    }
    return frame("CONNECTED", outcome, "", steps, offers);
  }
  if (outcome === "REFUSED") return frame("CONNECTED", outcome, text(response["code"]));
  return frame("CONNECTED", "UNREADABLE", "LIVE_SURFACE_UNREADABLE");
}

export function createBoardFeed(options: BoardFeedOptions): BoardFeed {
  const post = options.post
    ?? ((body: string): Promise<Response> => fetch("/affordances/read", {
      body, headers: options.headers, method: "POST",
    }));
  const schedule = options.schedule
    ?? ((run: () => void, delayMs: number): (() => void) => {
      const timer = setTimeout(run, delayMs);
      return () => { clearTimeout(timer); };
    });
  let cancel: (() => void) | null = null;
  let running = false;

  const poll = async (): Promise<void> => {
    let next: SurfaceFrame;
    try {
      const response = await post("{}");
      next = frameOfSurface(await response.json());
    } catch {
      next = frame("DISCONNECTED", "UNDELIVERED", "TRANSPORT_REQUEST_FAILED");
    }
    if (!running) return;
    options.onFrame(next);
    if (running) cancel = schedule(() => { void poll(); }, options.intervalMs);
  };

  return Object.freeze({
    start: (): void => {
      if (running) return;
      running = true;
      void poll();
    },
    stop: (): void => {
      running = false;
      cancel?.();
      cancel = null;
    },
  });
}
