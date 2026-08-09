import type { NextAllowedCommand } from "@moe/contracts";
import type { JSX } from "react";

import { UNKNOWN_FACT_VALUE } from "../nodes/node-authority.js";
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

/** §12 line 711: a slow command is still accepted; it is never reported as failed. */
export const RECOVERY_STILL_WORKING_COPY =
  "still working — the daemon accepted the command (event pending)";

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
  readonly overTwoSeconds?: boolean | undefined;
  readonly reason?: RecoveryUnavailableReason | undefined;
  readonly state: RecoveryFeedbackState;
}

export interface RecoveryActionsProps {
  readonly authorityMode: RecoveryAuthorityMode;
  readonly disabledCopy?: string | undefined;
  readonly feedback?: readonly RecoveryFeedback[] | undefined;
  readonly onRequestConfirmation?: RecoveryConfirmationHandler | undefined;
  readonly presentations: readonly RecoveryActionPresentation[];
  readonly testId: string;
}

function stated(value: string | undefined): string {
  return value !== undefined && value.trim() !== "" ? value : UNKNOWN_FACT_VALUE;
}

function slug(commandKind: string, qualifier: string | undefined): string {
  const dashed = commandKind.replace(/[._]/gu, "-");
  return qualifier === undefined || qualifier.trim() === "" ? dashed : `${dashed}.${qualifier}`;
}

function identified(value: string): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Exactly one current command, or none. Two matches are ambiguity, not a menu: acting
 * on a guess about which one the operator meant is the failure this returns null for.
 *
 * A blank command ID or target is not an identity, so it can never match — otherwise
 * two records the payload failed to name would join each other.
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

function Feedback(props: { readonly feedback: RecoveryFeedback }): JSX.Element {
  const { feedback } = props;
  const refused = feedback.state === "REFUSED";
  return (
    <div data-state={feedback.state} role={refused ? "alert" : "status"}
      data-testid={`cr.recovery.feedback.${feedback.commandId}`}
    >
      <span data-testid="cr.recovery.feedback.message">{stated(feedback.message)}</span>
      {feedback.state === "PENDING" && feedback.overTwoSeconds === true ? (
        <span data-testid="cr.recovery.feedback.stillworking">
          {RECOVERY_STILL_WORKING_COPY}
        </span>
      ) : null}
      {refused ? (
        <>
          <span data-testid="cr.recovery.feedback.code">{stated(feedback.reason?.reasonCode)}</span>
          <span data-testid="cr.recovery.feedback.layer">{stated(feedback.reason?.layer)}</span>
        </>
      ) : null}
    </div>
  );
}

interface ResolvedAction {
  readonly command: NextAllowedCommand;
  readonly presentation: RecoveryCommandPresentation;
}

export function RecoveryActions(props: RecoveryActionsProps): JSX.Element {
  const {
    authorityMode, disabledCopy, feedback, onRequestConfirmation, presentations, testId,
  } = props;
  const { actionsEnabled, commands } = useGating();
  /*
   * `stale` is deliberately not read. A lagging view still shows commands the daemon
   * returned, and those validate against current state on the daemon (§8.6); blanket-
   * blocking on lag would refuse work the daemon just authorised.
   */
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
        <CommandAction
          command={entry.command}
          enabled={enabled}
          key={`${entry.command.commandId}#${index}`}
          onRequestConfirmation={onRequestConfirmation}
          presentation={entry.presentation}
        />
      ))}
      {unavailable.map((presentation, index) => (
        <UnavailableAction
          key={`${slug(presentation.commandKind, presentation.qualifier)}#${index}`}
          presentation={presentation}
        />
      ))}
      {!enabled && resolved.length > 0 ? (
        <p data-testid="cr.recovery.disabledcopy">{stated(disabledCopy)}</p>
      ) : null}
      {shown.map((entry, index) => (
        <Feedback feedback={entry} key={`${entry.commandId}#${index}`} />
      ))}
    </div>
  );
}
