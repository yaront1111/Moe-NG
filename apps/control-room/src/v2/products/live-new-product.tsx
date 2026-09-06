import { useCallback, useRef, useState } from "react";
import type { JSX } from "react";

import type { SurfaceFrame } from "../../live/live-board-feed.js";
import { readBootstrapReceipt } from "../../live/live-bootstrap-receipt.js";
import type { BootstrapReceiptState } from "../../live/live-bootstrap-receipt.js";
import type { LiveSetup } from "../../live/live-config.js";
import { spendOffer } from "../approvals/offer-wire.js";
import type { OfferOutcome, OfferWire } from "../approvals/offer-wire.js";
import { createGoalDispatcher } from "../goals/live-goal-create.js";
import type { GoalCreateResult, GoalDraft } from "../goals/goal-model.js";
import {
  ACTIVATION_CHAIN_KINDS, createActivationPort, driveActivationChain, readSurfaceOnce,
} from "../ops/activation-port.js";
import type { ActivationChainKind, ActivationStep } from "../ops/activation-port.js";
import { NewProductForm } from "./new-product-form.js";

/**
 * NEW PRODUCT FROM A PRD, as the browser drives it. This module talks to the daemon; the form
 * beside it renders what comes back, so neither file has to carry both jobs. The receipt DECODE
 * lives with the other route readers in `live/live-bootstrap-receipt.ts`, and the four-state
 * classification is its, not this module's and certainly not the form's.
 *
 * NO CREDENTIAL IS STORED OR REPORTED HERE. The wire carries the attached session because
 * `spendOffer` cannot send anything without it; it is never copied into state, into a
 * `NewProductRun`, or into any string a card could render. Every value that comes back out of
 * this module is the daemon's own.
 */

export const NEW_PRODUCT_LAYER = "CONTROL_ROOM_NEW_PRODUCT" as const;
export const BOOTSTRAP_KIND = "repository.bootstrap" as const;
/** The surface read itself failed, so the command was never attempted. */
export const BOOTSTRAP_SURFACE_UNREADABLE = "BOOTSTRAP_SURFACE_UNREADABLE" as const;
/** The daemon offers no bootstrap on this surface: unreachable from here, not refused. */
export const BOOTSTRAP_NOT_OFFERED = "BOOTSTRAP_NOT_OFFERED" as const;

/**
 * HAND-TRANSCRIBED FROM `CONTROLLED_PROFILE_VERSION`
 * (apps/daemon/src/repository/controlled-profile/controlled-profile-generator.ts:26), for the
 * same reason `ACTIVATION_CHAIN_KINDS` is transcribed: apps/control-room cannot import
 * apps/daemon (no workspace edge, no tsconfig `paths`, a deep relative import is TS6059), and
 * the daemon discloses this string on no browser-readable route. It is NOT operator input -
 * the operator types a directory, a PRD, a product name and optionally a GitHub target.
 *
 * RE-CHECK IT WHENEVER THE GENERATOR MOVES; it went controlled-1 -> controlled-2 on
 * 2026-09-06. Drift fails CLOSED and legibly rather than silently: the daemon answers
 * BOOTSTRAP_PROFILE_VERSION_UNKNOWN @ DAEMON_INGRESS, which the form renders verbatim.
 */
export const CONTROLLED_PROFILE_VERSION = "controlled-2" as const;

export type BootstrapVisibility = "internal" | "private" | "public";

export interface NewProductGithub {
  readonly name: string;
  readonly owner: string;
  readonly visibility: BootstrapVisibility;
}

/** The operator's typed values. `github` is ABSENT, never empty, when it was not asked for. */
export interface NewProductRequest {
  readonly dir: string;
  readonly productName: string;
  readonly github?: NewProductGithub | undefined;
}

/**
 * The caller half, built from what the operator typed. `github` is OMITTED rather than sent
 * empty: an empty object asks the daemon to create a repository named nothing, which it refuses
 * at GITHUB_REQUEST_INVALID instead of taking the local-only path the operator chose.
 */
export function bootstrapPayload(request: NewProductRequest): Readonly<Record<string, unknown>> {
  const base = {
    dir: request.dir, productName: request.productName,
    profileVersion: CONTROLLED_PROFILE_VERSION,
  };
  if (request.github === undefined) return Object.freeze(base);
  const { name, owner, visibility } = request.github;
  return Object.freeze({ ...base, github: Object.freeze({ name, owner, visibility }) });
}

export interface NewProductPorts {
  readonly createGoal: (draft: GoalDraft) => Promise<GoalCreateResult>;
  readonly drive: (kinds?: readonly ActivationChainKind[]) => Promise<readonly ActivationStep[]>;
  readonly readReceipt: () => Promise<BootstrapReceiptState>;
  readonly submit: (request: NewProductRequest) => Promise<OfferOutcome>;
}

/**
 * One run's whole answer. `dispatch` is what the COMMAND said and `bootstrap` is what the
 * DURABLE RECEIPT says, kept apart on purpose: a delivered command whose receipt cannot be read
 * is a different situation from a refused one, and only the receipt can tell a partial success
 * from a full one.
 */
export interface NewProductRun {
  readonly bootstrap: BootstrapReceiptState | null;
  /** `project.register` before the bootstrap, then probe/policy/activate after it. */
  readonly chain: readonly ActivationStep[];
  readonly dispatch: OfferOutcome;
  /** The PRD goal, or null when the run stopped before it could be created. */
  readonly goal: GoalCreateResult | null;
}

const refusedHere = (code: string): OfferOutcome =>
  Object.freeze({ code, layer: NEW_PRODUCT_LAYER, ok: false as const });

async function submitBootstrap(
  wire: OfferWire, readSurface: () => Promise<SurfaceFrame>, request: NewProductRequest,
): Promise<OfferOutcome> {
  let surface: SurfaceFrame;
  try {
    surface = await readSurface();
  } catch {
    return refusedHere(BOOTSTRAP_SURFACE_UNREADABLE);
  }
  const offer = surface.offers.find((candidate) => candidate["commandKind"] === BOOTSTRAP_KIND);
  if (offer === undefined) return refusedHere(BOOTSTRAP_NOT_OFFERED);
  return await spendOffer(
    wire, BOOTSTRAP_KIND, offer, bootstrapPayload(request), "ui-newproduct", NEW_PRODUCT_LAYER,
  );
}

/**
 * The four ports, all spending the attached session's own wire. `createGoalDispatcher` is given
 * `() => null` for its cached frame so it ALWAYS re-reads: the surface it must find
 * `goal.create_with_source` on is the one that exists after THIS run's commits, and a frame
 * captured before them describes a project that did not yet exist.
 */
export function createNewProductPorts(
  setup: LiveSetup,
  readSurface: () => Promise<SurfaceFrame> = () => readSurfaceOnce(setup.headers),
): NewProductPorts {
  const port = createActivationPort(setup);
  return Object.freeze({
    createGoal: createGoalDispatcher(setup, () => null),
    drive: (kinds: readonly ActivationChainKind[] = ACTIVATION_CHAIN_KINDS) =>
      driveActivationChain(port, readSurface, kinds),
    readReceipt: () => readBootstrapReceipt(setup.headers),
    submit: (request: NewProductRequest) => submitBootstrap(setup, readSurface, request),
  });
}

const failed = (steps: readonly ActivationStep[]): boolean =>
  steps.some((step) => step.state === "ANSWERED" && !step.outcome.ok);

/**
 * THE RECEIPT IS READ ON THE REFUSED PATH TOO, because that is where an operator most needs it.
 * The daemon commits the receipt BEFORE it throws the refusal - "the receipt is durable either
 * way", repository-bootstrap-command.ts:219-222 - so a failure inside the engine leaves a durable
 * record of whether the local repository SURVIVED, carried in the detail as
 * `*_LOCAL_REPOSITORY_RETAINED`. Reading every refused dispatch as "nothing was created" is the
 * same harm as reading BOOTSTRAP_GH_UNAVAILABLE as a total failure: it invites an operator to
 * delete a repository that is real, committed and bound.
 *
 * ONLY WHEN THE CODES MATCH. A refusal raised at ADMISSION - a replay, an unmet
 * `project.register`, a malformed envelope - returns at repository-bootstrap-command.ts:207
 * before any receipt is written, so the read would answer with the PREVIOUS run's receipt, which
 * may say BOOTSTRAPPED and would turn this run's refusal into a success on screen. The daemon
 * rethrows the receipt's own refusal verbatim, so an EQUAL code is what says the receipt
 * describes THIS run. Anything else is discarded as stale and the run reports no receipt, which
 * is the honest answer for a command that never reached the engine.
 */
async function refusedReceiptOf(
  ports: NewProductPorts, code: string,
): Promise<BootstrapReceiptState | null> {
  const state = await ports.readReceipt();
  return state.state === "REFUSED" && state.refusal.code === code ? state : null;
}

/**
 * THE WHOLE RUN, in the daemon's own prerequisite order, with nothing invented between steps.
 *
 * `project.register` runs FIRST because the admission table names it as the bootstrap's one
 * prerequisite (bootstrap-sequence.ts, `"repository.bootstrap": ["project.register"]`). The
 * bootstrap then creates, commits, BINDS and catalogs the repository, so the rest of the chain
 * finds `project.bind_repository` already committed and skips it - leaving the real bind the
 * daemon just performed in place of the placeholder observation the dev roster carries.
 * `goal.create_with_source` names `project.activate` as ITS prerequisite, so the goal can only
 * be created after the chain completes; sending it sooner answers BOOTSTRAP_PREREQUISITE_MISSING
 * and leaves the operator with a repository and no goal.
 *
 * A PARTIAL SUCCESS CONTINUES. The local repository is real, committed and bound, so the GitHub
 * half not happening is no reason to abandon the project the operator just created.
 */
export async function runNewProduct(
  ports: NewProductPorts, request: NewProductRequest, draft: GoalDraft | null,
): Promise<NewProductRun> {
  const registered = await ports.drive(["project.register"]);
  if (failed(registered)) {
    return Object.freeze({
      bootstrap: null, chain: registered, dispatch: refusedHere(BOOTSTRAP_NOT_OFFERED), goal: null,
    });
  }
  const dispatch = await ports.submit(request);
  if (!dispatch.ok) {
    return Object.freeze({
      bootstrap: await refusedReceiptOf(ports, dispatch.code),
      chain: registered, dispatch, goal: null,
    });
  }
  const bootstrap = await ports.readReceipt();
  if (bootstrap.state === "REFUSED" || bootstrap.state === "NO_RECEIPT") {
    return Object.freeze({ bootstrap, chain: registered, dispatch, goal: null });
  }
  const activated = await ports.drive();
  const chain = Object.freeze([...registered, ...activated]);
  if (draft === null || failed(activated)) {
    return Object.freeze({ bootstrap, chain, dispatch, goal: null });
  }
  return Object.freeze({ bootstrap, chain, dispatch, goal: await ports.createGoal(draft) });
}

export interface LiveNewProductProps {
  /** Injectable for tests; the default spends the attached session own wire. */
  readonly ports?: NewProductPorts | undefined;
  readonly setup: LiveSetup;
}

/**
 * The card the operator actually sees: the form, plus the one run it drives.
 *
 * The re-entry guard is a REF rather than the `busy` state, for the reason the Activate card
 * gives at activation-screen.tsx:221 - two clicks can land in the same React batch, before the
 * disabled button re-renders, and two runs would race the same aggregate version. Here the
 * second run would also answer BOOTSTRAP_DIR_NOT_EMPTY over the directory the first one just
 * populated, which reads to an operator as if their own product had broken it.
 */
export function LiveNewProduct({ ports, setup }: LiveNewProductProps): JSX.Element {
  const [wired] = useState(() => ports ?? createNewProductPorts(setup));
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<NewProductRun | null>(null);
  const inFlight = useRef(false);
  const onCreate = useCallback((request: NewProductRequest, draft: GoalDraft | null): void => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setRun(null);
    const settle = (): void => { inFlight.current = false; setBusy(false); };
    void runNewProduct(wired, request, draft).then((done) => { setRun(done); settle(); }, settle);
  }, [wired]);
  return <NewProductForm busy={busy} onCreate={onCreate} run={run} />;
}
