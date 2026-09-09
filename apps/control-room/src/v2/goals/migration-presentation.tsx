import type { JSX } from "react";

import type { DeploymentMigration } from "../../live/live-deployments.js";
import { MIDDOT } from "../glyphs.js";

/**
 * MIGRATION FACTS AS OPERATOR SENTENCES, in ONE place so the Deployments card and the node card
 * cannot drift into saying different things about the same schema.
 *
 * Every function here is pure and reads only members `live-deployments.ts` admits. It invents no
 * field, joins no two subjects, and derives nothing the daemon did not observe - in particular
 * there is NO pending sentence, because no read produces a pending count and computing one by
 * subtracting a node's declarations from an environment's applied list would attribute a
 * PROJECT_ENVIRONMENT observation to a node that never owned it.
 *
 * THE THREE READINGS THIS MODULE EXISTS TO KEEP APART, each one a way a reassuring string means
 * the opposite of what it says:
 *   - UNKNOWN is a STATE, never an absence. "We could not read the receipt" must never render as
 *     "nothing to apply", so the unknown sentence names its code and is never empty.
 *   - APPLIED, REFUSED and REVERTED are three different things to have happened to a schema, and
 *     a refusal must not carry an applied word anywhere in it.
 *   - A backup EXISTS only when it is VERIFIED. NONE is no file; UNVERIFIED is a file that was
 *     claimed and could not be found, which is not a safety net.
 *
 * The backup is a REFERENCE and never an affordance: only the digest ever leaves the daemon, the
 * file path deliberately does not, and nothing here reconstructs one.
 */

/** What the receipt says the schema did, or that it could not be read. Never empty. */
export function migrationWords(migration: DeploymentMigration): string {
  if (migration.state === "UNKNOWN") {
    // NAMED, not blank: the code is the string an operator searches the runbook for, and the
    // layer says which reader could not answer.
    const layer = migration.unknownLayer === null ? "" : ` ${MIDDOT} ${migration.unknownLayer}`;
    return `Migration state is not known here ${MIDDOT} ${migration.unknownCode ?? "UNKNOWN"}${layer}`;
  }
  if (migration.outcome === "REFUSED") {
    // CODE AND LAYER BOTH: more than one layer can refuse a migration, and a line naming only the
    // word leaves an operator unable to tell which one answered. The failing migration is named
    // when the refusal carries one - it is a bare filename, never a path.
    const layer = migration.refusalLayer === null ? "" : ` ${MIDDOT} ${migration.refusalLayer}`;
    const file = migration.refusalFile === null ? "" : ` ${MIDDOT} at ${migration.refusalFile}`;
    return `Refused ${MIDDOT} ${migration.refusalCode ?? "REFUSED"}${layer}${file}`;
  }
  const verb = migration.outcome === "REVERTED" ? "Reverted" : "Applied";
  const identifiers = migration.migrations ?? [];
  return identifiers.length === 0
    ? `${verb} no migrations: the receipt records none.`
    : `${verb} ${identifiers.join(", ")}`;
}

/**
 * The backup as a REFERENCE, or null while the observation itself is unknown - there is nothing
 * honest to say about a backup belonging to a receipt nobody could read.
 */
export function migrationBackupWords(migration: DeploymentMigration): string | null {
  if (migration.backupState === null) return null;
  if (migration.backupState === "VERIFIED") {
    // The digest is the ONLY thing the daemon lets out. It is quoted to the runbook, never
    // clicked: a link here would both reconstruct a path and offer a database dump as a download.
    return `Backup verified ${MIDDOT} sha256 ${migration.backupSha256 ?? ""}`.trimEnd();
  }
  return migration.backupState === "NONE"
    ? "No backup is recorded for this migration."
    : "A backup is claimed but was not confirmed on disk.";
}

/**
 * WHAT A NODE ADDS TO THE SCHEMA, from the node's OWN declaration and nowhere else. Null means
 * there is no line to render at all: an authored empty list is a declared none and a null member
 * is a node that states nothing, and neither is a thing to print an empty label for.
 */
export function declaredMigrationsWords(declared: readonly string[] | null): string | null {
  if (declared === null || declared.length === 0) return null;
  // EVERY identifier, never the first and a truncation: a card that hid the second is a schema
  // change an operator cannot see.
  return declared.length === 1
    ? `adds migration ${declared[0] ?? ""}`
    : `adds migrations ${declared.join(", ")}`;
}

/**
 * THE MIGRATION LINES OF ONE ENVIRONMENT ROW on the Deployments card. It lives here rather than
 * inline in the card so the card stays at its size and every migration string in the product is
 * composed in one file.
 *
 * `testId` is handed in rather than built here, so the card keeps sole ownership of its testid
 * prefix and each environment's facts are queryable under ITS OWN row - one environment can
 * never be read off another.
 *
 * NOTHING IS CLICKABLE. No anchor, no download, no path: the backup is a reference an operator
 * quotes to the runbook, and the daemon keeps the file's location inside its own module.
 */
export function MigrationRow({ migration, testId }: {
  readonly migration: DeploymentMigration | undefined;
  readonly testId: (part: string) => string;
}): JSX.Element | null {
  // An environment with no observation says NOTHING, rather than rendering an empty label that
  // would read as a measured "there is nothing to apply".
  if (migration === undefined) return null;
  const backup = migrationBackupWords(migration);
  return (
    <>
      <p className="cr2-needs-detail" data-testid={testId("migration")}>{migrationWords(migration)}</p>
      {backup === null ? null : (
        <p className="cr2-slot-kicker" data-testid={testId("backup")}>{backup}</p>
      )}
    </>
  );
}
