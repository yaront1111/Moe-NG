import type { NextAllowedCommand } from "@moe/contracts";
import type { JSX } from "react";

import { UNKNOWN_FACT_VALUE } from "../nodes/node-authority.js";
import { COMMAND_STILL_WORKING_COPY, CommandLatency } from "../performance/command-latency.js";
import type { Clock } from "../performance/command-latency.js";
import { useGating } from "../shell/frame.js";

/**
 * The one mutation control every recovery surface renders through (spec §6.3, §8.1,
 * §12 line 711).
 *
 * A control exists only because the daemon returned a `NextAllowedCommand` whose
 * command ID and target are exactly the ones the caller named. There is no widening:
 * no health verdict, no lifecycle state, and no prose in a reconciliation narrative
 * can add an affordance the daemon did not return, and nothing here builds a command
 * envelope or reaches a transport. Activation hands back the exact frozen object the
 * daemon supplied.
 */
export type RecoveryAuthorityMode = "LIVE" | "OFFLINE_READ_ONLY" | "HISTORICAL" | "UNKNOWN";

const LIVE_AUTHORITY: RecoveryAuthorityMode = "LIVE";

/**
 * §12 line 711: a slow command is still accepted; it is never reported as failed.
 *
 * An alias, not a second copy. The sentence lives once, in the shared latency module, so
 * a surface adopting that module can never drift from the wording recovery renders.
 */
export const RECOVERY_STILL_WORKING_COPY = COMMAND_STILL_WORKING_COPY;

/** A refusal names both the stable code and the layer that produced it. */
export interface RecoveryUnavailableReason {
  readonly layer: string;
  readonly phrase: string;
  readonly reasonCode: string;
}

export interface RecoveryCommandPresentation {
  readonly commandId: string;
  readonly label: string;
  readonly qualifier?: string | undefined;
  readonly targetAggregateId: string;
  readonly unavailable?: undefined;
}

export interface RecoveryUnavailablePresentation {
  readonly commandId?: undefined;
  readonly commandKind: string;
  readonly label: string;
  readonly qualifier?: string | undefined;
  readonly unavailable: RecoveryUnavailableReason;
}

/**
 * Either the caller names a command it expects to be current, or it carries the
 * daemon's own reason for the absence. An expectation that matches nothing and
 * explains nothing renders nothing: §8.1 requires absence over invented copy.
 */
export type RecoveryActionPresentation =
  | RecoveryCommandPresentation
  | RecoveryUnavailablePresentation;

export type RecoveryConfirmationHandler = (
  command: NextAllowedCommand,
  presentation: RecoveryCommandPresentation,
) => void;

export type RecoveryFeedbackState = "PENDING" | "CONFIRMED" | "REFUSED";

export interface RecoveryFeedback {
  readonly commandId: string;
  readonly message: string;
  readonly reason?: RecoveryUnavailableReason | undefined;
  /**
   * When the command was sent, on the injected clock's own scale. The still-working line
   * is measured from this; there is deliberately no boolean saying the wait was long,
   * because a caller-supplied flag can claim a threshold nothing ever timed.
   */
  readonly startedAt?: number | undefined;
  readonly state: RecoveryFeedbackState;
}

export interface RecoveryActionsProps {
  readonly authorityMode: RecoveryAuthorityMode;
  /** Absent means this surface cannot measure elapsed time, not that none passed. */
  readonly clock?: Clock | null | undefined;
  readonly disabledCopy?: string | undefined;
  readonly feedback?: readonly RecoveryFeedback[] | undefined;
  readonly onRequestConfirmation?: RecoveryConfirmationHandler | undefined;
  readonly presentations: readonly RecoveryActionPresentation[];
  readonly testId: string;
}

function identified(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

function stated(value: string | undefined): string {
  return identified(value) && value !== undefined ? value : UNKNOWN_FACT_VALUE;
}

function slug(commandKind: string, qualifier: string | undefined): string {
  const dashed = commandKind.replace(/[._]/gu, "-");
  return identified(qualifier) ? `${dashed}.${qualifier ?? ""}` : dashed;
}

/**
 * Exactly one current command, or none. Two matches are ambiguity, not a menu: acting
 * on a guess about which one the operator meant is the failure this returns null for.
 * A blank ID or target is not an identity, so it never matches — otherwise two records
 * the payload failed to name would join each other.
 */
function resolve(
  commands: readonly NextAllowedCommand[],
  presentation: RecoveryCommandPresentation,
): NextAllowedCommand | null {
  if (!identified(presentation.commandId) || !identified(presentation.targetAggregateId)) {
    return null;
  }
  const matched = commands.filter(
    (command) => command.commandId === presentation.commandId
      && command.targetAggregateId === presentation.targetAggregateId,
  );
  return matched.length === 1 ? matched[0] ?? null : null;
}

function Reason(props: {
  readonly reason: RecoveryUnavailableReason;
  readonly testId: string;
}): JSX.Element {
  const { reason, testId } = props;
  return (
    <span data-reason-code={stated(reason.reasonCode)}
      data-refusing-layer={stated(reason.layer)} data-testid={testId}>
      <span data-testid="cr.recovery.reason.phrase">{stated(reason.phrase)}</span>
      <span data-testid="cr.recovery.reason.code">{stated(reason.reasonCode)}</span>
      <span data-testid="cr.recovery.reason.layer">{stated(reason.layer)}</span>
    </span>
  );
}

/**
 * A refused command keeps its control (§6.3 disables, never hides) and states the
 * daemon's own phrase. A missing code or layer stays UNKNOWN: minting a RuntimeError
 * here would put this surface's guess where the daemon's answer belongs.
 */
function UnavailableAction(props: {
  readonly presentation: RecoveryUnavailablePresentation;
}): JSX.Element {
  const { presentation } = props;
  const id = slug(presentation.commandKind, presentation.qualifier);
  const label = stated(presentation.label);
  return (
    <span>
      <button
        aria-label={`${label}: ${stated(presentation.unavailable.reasonCode)}`}
        data-command-kind={presentation.commandKind} data-testid={`cr.action.${id}`}
        disabled type="button"
      >
        {label}
      </button>
      <Reason reason={presentation.unavailable} testId={`cr.recovery.unavailable.${id}`} />
    </span>
  );
}

function CommandAction(props: {
  readonly command: NextAllowedCommand;
  readonly enabled: boolean;
  readonly onRequestConfirmation?: RecoveryConfirmationHandler | undefined;
  readonly presentation: RecoveryCommandPresentation;
}): JSX.Element {
  const { command, enabled, onRequestConfirmation, presentation } = props;
  // A blank label would render a nameless control. The daemon's own command kind is the
  // only other name in evidence here, so it stands in rather than an invented one.
  const label = identified(presentation.label) ? presentation.label : command.commandKind;
  return (
    <button
      aria-label={`${label}: ${command.targetAggregateId}`}
      data-command-id={command.commandId} data-command-kind={command.commandKind}
      data-command-target={command.targetAggregateId}
      data-testid={`cr.action.${slug(command.commandKind, presentation.qualifier)}`}
      disabled={!enabled}
      onClick={() => {
        onRequestConfirmation?.(command, presentation);
      }}
      type="button"
    >
      {label}
    </button>
  );
}

/** Recovery's namespace for the shared §11.4 feedback; the ids it produces are unchanged. */
const FEEDBACK_PREFIX = "cr.recovery.feedback";

type ResolvedAction = {
  command: NextAllowedCommand; presentation: RecoveryCommandPresentation;
};

export function RecoveryActions(props: RecoveryActionsProps): JSX.Element {
  const {
    authorityMode, clock, disabledCopy, feedback, onRequestConfirmation, presentations, testId,
  } = props;
  const { actionsEnabled, commands } = useGating();
  // `stale` is deliberately not read: a lagging view still shows commands the daemon
  // returned, and those revalidate on the daemon (§8.6); blanket-blocking on lag would
  // refuse work the daemon just authorised.
  const enabled = actionsEnabled && authorityMode === LIVE_AUTHORITY;

  const resolved: ResolvedAction[] = [];
  const unavailable: RecoveryUnavailablePresentation[] = [];
  for (const presentation of presentations) {
    if (presentation.commandId === undefined) {
      unavailable.push(presentation);
      continue;
    }
    const command = resolve(commands, presentation);
    if (command !== null) resolved.push({ command, presentation });
  }

  const current = new Set(resolved.map((entry) => entry.command.commandId));
  const shown = (feedback ?? []).filter((entry) => current.has(entry.commandId));

  return (
    <div data-authority-mode={authorityMode} data-recovery-actions={testId} data-testid={testId}>
      {resolved.map((entry, index) => (
        <CommandAction command={entry.command} enabled={enabled}
          key={`${entry.command.commandId}#${index}`} presentation={entry.presentation}
          onRequestConfirmation={onRequestConfirmation} />
      ))}
      {unavailable.map((presentation, index) => (
        <UnavailableAction presentation={presentation}
          key={`${slug(presentation.commandKind, presentation.qualifier)}#${index}`} />
      ))}
      {!enabled && resolved.length > 0 ? (
        <p data-testid="cr.recovery.disabledcopy">{stated(disabledCopy)}</p>
      ) : null}
      {shown.map((entry, index) => (
        <CommandLatency clock={clock} feedback={entry} key={`${entry.commandId}#${index}`}
          testIdPrefix={FEEDBACK_PREFIX} />
      ))}
    </div>
  );
}
