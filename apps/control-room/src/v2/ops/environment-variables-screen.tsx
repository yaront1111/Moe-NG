import { useCallback, useState } from "react";
import type { FormEvent, JSX } from "react";

import { ActionButton, Card } from "../components/primitives.js";
import { OutcomeNote } from "../components/outcome-note.js";
import { MIDDOT } from "../glyphs.js";
import type { EnvironmentVariablesOutcome } from "../../live/live-environment-variables.js";
import { environmentTableRows, unsetRequiredCount } from "./environment-variables-model.js";
import type { EnvironmentVariableTableRow } from "./environment-variables-model.js";
import { ENVIRONMENT_WRITE_LAYER } from "./environment-variables-port.js";
import { refusalWords } from "./environment-refusal-words.js";
import type { EnvironmentVariablesPort, EnvironmentWriteOutcome } from "./environment-variables-port.js";

/**
 * THE ENVIRONMENTS SCREEN: per environment, which variables the approved contract REQUIRES,
 * which of them are set, each fingerprint and each last update, plus the set and unset dialogs.
 *
 * THIS SCREEN NEVER RENDERS A VALUE AND NEVER RETAINS ONE. It is the only place in the product
 * where a secret is typed, so it is the likeliest place one leaks. The rules it holds to:
 *
 *   1. The typed value lives in ONE piece of state, inside the dialog, and the dialog is
 *      UNMOUNTED on every settled submit - the refused path included. Echoing the value back so
 *      the operator can correct it is the helpful-looking behaviour that puts a secret in a
 *      screenshot, and it is the exact thing the tests mutate to prove the arm is real.
 *   2. No message is built from input. Codes and the daemon's fixed prose only.
 *   3. The value is never passed downward as a prop: a value handed to a child is visible in a
 *      devtools inspector even when nothing paints it. It goes from the field to the port and
 *      nowhere else.
 *
 * THE FINGERPRINT IS THE OPERATOR'S ONLY FEEDBACK, and it is LABELLED as one. Since a value can
 * never be read back, a changed fingerprint after an update is the only evidence the update took.
 * The word "fingerprint" is in the rendered output on purpose: an operator who reads a truncated
 * hex string as part of their secret will treat a shareable screen as unsafe, or - worse - treat
 * an unsafe one as shareable.
 */

/** Enough hex to distinguish two fingerprints at a glance; never enough to be mistaken for data. */
const FINGERPRINT_SHOWN = 12;
const UNDELIVERED: EnvironmentWriteOutcome = Object.freeze({
  code: "ENVIRONMENT_WRITE_UNDELIVERED", layer: ENVIRONMENT_WRITE_LAYER, ok: false as const,
});

export interface EnvironmentVariablesScreenProps {
  readonly environment: string;
  readonly outcome: EnvironmentVariablesOutcome | null;
  /** null when no session is attached: the screen can read but not write. */
  readonly port: EnvironmentVariablesPort | null;
  /** The names the approved contract requires, from the contract read, not derived here. */
  readonly requiredNames: readonly string[];
  /** Lets the live wrapper re-read, so the fingerprint on screen is the daemon's new one. */
  readonly onSettled?: (() => void) | undefined;
}

/** The fingerprint cell. The WORD is rendered, never only the hex. */
function Fingerprint({ row }: { readonly row: EnvironmentVariableTableRow }): JSX.Element {
  const testId = `cr.env-vars.fingerprint.${row.name}`;
  if (row.fingerprintSha256 === null) return <span data-testid={testId}>Not set</span>;
  return (
    <span
      data-fingerprint={row.fingerprintSha256} data-testid={testId}
      title="A sha256 fingerprint of the stored value. It is not part of the value."
    >
      {`sha256 fingerprint ${row.fingerprintSha256.slice(0, FINGERPRINT_SHOWN)}`}
    </span>
  );
}

interface RowProps {
  readonly busy: boolean;
  readonly onSet: (name: string) => void;
  readonly onUnset: (name: string) => void;
  readonly row: EnvironmentVariableTableRow;
}

function VariableRow({ busy, onSet, onUnset, row }: RowProps): JSX.Element {
  return (
    <tr data-set={row.isSet ? "true" : "false"} data-testid={`cr.env-vars.row.${row.name}`}>
      <td>{row.name}</td>
      <td data-testid={`cr.env-vars.required.${row.name}`}>{row.required ? "Required" : "Extra"}</td>
      <td data-testid={`cr.env-vars.state.${row.name}`}>{row.isSet ? "Set" : "Not set"}</td>
      <td><Fingerprint row={row} /></td>
      <td data-testid={`cr.env-vars.updated.${row.name}`}>{row.updatedAt ?? "Never"}</td>
      <td>
        <ActionButton
          disabled={busy} onClick={() => { onSet(row.name); }}
          testId={`cr.env-vars.set.${row.name}`} variant="secondary"
        >
          {row.isSet ? "Replace" : "Set"}
        </ActionButton>
        {row.isSet && (
          <ActionButton
            disabled={busy} onClick={() => { onUnset(row.name); }}
            testId={`cr.env-vars.unset.${row.name}`} variant="ghost"
          >
            Unset
          </ActionButton>
        )}
      </td>
    </tr>
  );
}

interface DialogProps {
  readonly busy: boolean;
  readonly name: string;
  readonly onCancel: () => void;
  readonly onSubmit: (value: string) => void;
}

/**
 * THE ONE PLACE A VALUE IS TYPED. `value` is local to this component and dies with it; the
 * parent unmounts the dialog on every settled submit, refusal included. `type="password"` keeps
 * it off the screen while typing and `autoComplete="off"` keeps a browser autofill or a password
 * manager from capturing it into a store this product does not control.
 */
function SetDialog({ busy, name, onCancel, onSubmit }: DialogProps): JSX.Element {
  const [value, setValue] = useState("");
  const submit = useCallback((event: FormEvent): void => {
    event.preventDefault();
    onSubmit(value);
  }, [onSubmit, value]);
  return (
    <form data-testid="cr.env-vars.dialog" onSubmit={submit}>
      <label htmlFor="cr-env-vars-value">{`Value for ${name}`}</label>
      <input
        autoComplete="off" data-testid="cr.env-vars.value" disabled={busy}
        id="cr-env-vars-value" name="cr-env-vars-value"
        onChange={(event) => { setValue(event.target.value); }}
        spellCheck={false} type="password" value={value}
      />
      <p data-testid="cr.env-vars.dialog-note">
        This value cannot be read back. Once it is stored you will see only its sha256
        fingerprint, which is how you confirm the change took.
      </p>
      <ActionButton disabled={busy} testId="cr.env-vars.submit" type="submit">Store</ActionButton>
      <ActionButton disabled={busy} onClick={onCancel} testId="cr.env-vars.cancel" variant="ghost">
        Cancel
      </ActionButton>
    </form>
  );
}

export function EnvironmentVariablesScreen({
  environment, onSettled, outcome, port, requiredNames,
}: EnvironmentVariablesScreenProps): JSX.Element {
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<EnvironmentWriteOutcome | null>(null);
  const rows = environmentTableRows(outcome, requiredNames);
  const settle = useCallback((next: EnvironmentWriteOutcome): void => {
    // THE TYPED VALUE DIES HERE, ON EVERY SETTLED SUBMIT, REFUSED INCLUDED. Clearing `editing`
    // unmounts the dialog that owns it; there is nowhere else it is held.
    setEditing(null);
    setBusy(false);
    setAnswer(next);
    onSettled?.();
  }, [onSettled]);
  const spend = useCallback((run: (chosen: EnvironmentVariablesPort) => Promise<EnvironmentWriteOutcome>): void => {
    if (port === null) return;
    setBusy(true);
    setAnswer(null);
    void run(port).then(settle, () => { settle(UNDELIVERED); });
  }, [port, settle]);
  const onSubmit = useCallback((value: string): void => {
    if (editing === null) return;
    spend((chosen) => chosen.set(environment, editing, value));
  }, [editing, environment, spend]);
  const onUnset = useCallback((name: string): void => {
    spend((chosen) => chosen.unset(environment, name));
  }, [environment, spend]);
  const unset = unsetRequiredCount(rows);
  return (
    <Card testId="cr.env-vars.root">
      <h2 data-testid="cr.env-vars.kicker">{`Environment variables ${MIDDOT} ${environment}`}</h2>
      <p data-testid="cr.env-vars.summary">
        {`${String(unset)} of ${String(requiredNames.length)} required variables unset for `
          + `${environment}. Values are never readable back; the sha256 fingerprint is how you `
          + "confirm a change took."}
      </p>
      {outcome !== null && outcome.status !== "ENVIRONMENT_VARIABLES" && (
        <OutcomeNote
          code={outcome.code} layer={outcome.layer} role="alert"
          said={outcome.status === "REFUSED"
            ? outcome.detail ?? "The daemon refused this read."
            : "The variable table could not be read."}
          testId="cr.env-vars.read-refusal"
        />
      )}
      <table data-testid="cr.env-vars.table">
        <tbody>
          {rows.map((row) => (
            <VariableRow busy={busy} key={row.name} onSet={setEditing} onUnset={onUnset} row={row} />
          ))}
        </tbody>
      </table>
      {editing !== null && (
        <SetDialog
          busy={busy} name={editing} onCancel={() => { setEditing(null); }} onSubmit={onSubmit}
        />
      )}
      {answer !== null && !answer.ok && (
        <OutcomeNote
          code={answer.code} layer={answer.layer} role="alert" said={refusalWords(answer)}
          testId="cr.env-vars.write-refusal"
        />
      )}
      {answer !== null && answer.ok && (
        <p data-testid="cr.env-vars.write-ok">
          Stored. The fingerprint in the table is the daemon confirmation that it changed.
        </p>
      )}
    </Card>
  );
}
