import type { JSX } from "react";

import type { BackupRestoreProof, BackupsOutcome, BackupView } from "../../live/live-backups.js";
import { OutcomeNote } from "../components/outcome-note.js";
import { MIDDOT } from "../glyphs.js";
import { readFailedSaid } from "../outcome-words.js";

/**
 * THE BACKUPS LIST on the Health screen: one row per backup, carrying the restore-proof state
 * the DAEMON determined and the evidence behind it.
 *
 * NOT-YET-CHECKED MUST NEVER READ AS PROVEN. That collapse is the entire failure this surface
 * exists to prevent. Writing a backup is cheap and restore-checking one is not, so a backup
 * routinely exists with no proof behind it, and an operator leans on that difference at the
 * worst possible moment. `data-restore-proof` is `backup.restoreProof` copied across - never
 * derived from a digest, an instant or a truthiness this component can see - and the words
 * beside it come from the same value through one frozen map, so a copy revision cannot make
 * the attribute and the sentence disagree.
 *
 * DISTINGUISHED BY MORE THAN COLOUR. Each state carries its own SENTENCE and its own MARK, so
 * the three stay apart in a monochrome print, under a colour-blind reading and in a screen
 * reader. A CSS class is not a distinction a reader can see, so no state is signalled by one.
 *
 * ABSENT IS SAID, NOT SHOWN AS BLANK. A backup with no digest and no check time renders the
 * words for absence. Never "", never 0, never a dash that reads as a value, and never a
 * defaulted proven: the operator is told there is nothing there rather than left to read an
 * empty cell as a passing one.
 *
 * A REFUSED READ IS NOT AN EMPTY LIST. The two look identical if collapsed, and "no backups
 * exist" is the second sentence this surface must never say without knowing it.
 */

/**
 * The state marks, spelled as `\uXXXX` escapes so the source stays pure ASCII. They live here
 * with their mapping rather than in `glyphs.ts`, following `truth-class.ts`: these three mean
 * nothing away from the three states they mark.
 */
const RESTORE_PROOF_MARKS: Readonly<Record<BackupRestoreProof, string>> = Object.freeze({
  /** BALLOT X. */
  FAILED: "\u2717",
  /** A plain ASCII question mark: the ornament forms are not universally rendered. */
  NOT_CHECKED: "?",
  /** CHECK MARK. */
  PROVEN: "\u2713",
});

/** One sentence per state, and no two of them read alike at a glance. */
const RESTORE_PROOF_WORDS: Readonly<Record<BackupRestoreProof, string>> = Object.freeze({
  FAILED: "Restore check FAILED",
  NOT_CHECKED: "Restore NOT CHECKED yet",
  PROVEN: "Restore PROVEN",
});

/**
 * The evidence line. Each half states its own absence in words: a null digest is "no digest
 * recorded" and a null instant is "never checked", so neither can be read off as a value.
 */
function evidenceWords(backup: BackupView): string {
  const digest = backup.sha256 === null ? "No digest recorded" : `Digest ${backup.sha256}`;
  const checked = backup.checkedAt === null ? "never checked" : `checked ${backup.checkedAt}`;
  return `${digest} ${MIDDOT} ${checked}`;
}

function BackupRow({ backup }: { readonly backup: BackupView }): JSX.Element {
  const testId = `cr.backups.row.${backup.environment}.${backup.ref}`;
  return (
    <li
      className="cr2-ops-card"
      data-restore-proof={backup.restoreProof}
      data-testid={testId}
      key={testId}
    >
      <p className="cr2-slot-kicker" data-testid={`${testId}.ref`}>
        {`${backup.environment} ${MIDDOT} ${backup.ref}`}
      </p>
      <p className="cr2-approve-step-body" data-testid={`${testId}.proof`}>
        {`${RESTORE_PROOF_MARKS[backup.restoreProof]} ${RESTORE_PROOF_WORDS[backup.restoreProof]}`}
      </p>
      <p className="cr2-approve-mono" data-testid={`${testId}.evidence`}>{evidenceWords(backup)}</p>
    </li>
  );
}

export function BackupsList({ backups }: {
  /** Null while the backups read has not answered; an outcome once it has. */
  readonly backups: BackupsOutcome | null;
}): JSX.Element {
  if (backups === null) {
    return (
      <section className="cr2-ops" data-testid="cr.backups.root">
        <p className="cr2-slot-kicker" data-testid="cr.backups.loading">Reading the backups...</p>
      </section>
    );
  }
  if (backups.status !== "BACKUPS") {
    return (
      <section className="cr2-ops" data-testid="cr.backups.root">
        <OutcomeNote
          code={backups.code}
          layer={backups.layer}
          said={readFailedSaid("backups")}
          testId="cr.backups.refusal"
        />
      </section>
    );
  }
  if (backups.backups.length === 0) {
    return (
      <section className="cr2-ops" data-testid="cr.backups.root">
        <div className="cr2-goals-empty" data-testid="cr.backups.empty">
          <p className="cr2-goals-empty-title">No backup recorded.</p>
          <p className="cr2-goals-empty-body">
            The daemon records one row per backup it writes, and a second when a restore check
            runs against it. Nothing here yet is different from nothing answering.
          </p>
        </div>
      </section>
    );
  }
  return (
    <section className="cr2-ops" data-testid="cr.backups.root">
      <p className="cr2-slot-kicker" data-testid="cr.backups.kicker">
        {`Backups ${MIDDOT} ${String(backups.backups.length)} recorded`}
      </p>
      <ul className="cr2-needs-list" data-testid="cr.backups.list">
        {backups.backups.map((backup) => (
          <BackupRow backup={backup} key={`${backup.environment}.${backup.ref}`} />
        ))}
      </ul>
    </section>
  );
}
