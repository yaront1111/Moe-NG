/**
 * Production scheduler fairness contracts — the CAP-REVISION family. Split from
 * ./fairness-evidence.ts so each source stays inside the per-file line target.
 *
 * This family carries the migration semantics the reference stated only in a
 * comment ("must be <= the ticket's current bound", fairness-model.ts:95) and
 * enforced against reducer state, so a migration datum alone could not be
 * checked. Carrying the prior bound WITH the datum makes equal-or-tighter a
 * structural property of the value rather than a property of a session.
 *
 * IT DECIDES NOTHING. There is no successor to the reference's
 * CAP_RAISE_REQUIRES_DRAIN_OR_TIGHTER_MIGRATION, because that code is a verdict
 * on whether a raise is PERMITTED, and permission is policy owned by the
 * consumer, task-10cab3e5 (Fair scheduler production). A raise and a reduction
 * validate identically here.
 */
import { exactRecord, isCount } from "../authority/authority-kernel.js";
import {
  acceptFairness,
  isFairnessIdentity,
  isFairnessRefusal,
  makeFairnessIssue,
  readFairnessItems,
  refuseFairness,
  unknownFairness,
} from "./fairness-contract.js";
import type {
  FairnessContractIssueCode,
  FairnessContractRefusal,
  FairnessContractResult,
} from "./fairness-contract.js";

/**
 * A per-item bound tightening carrying the prior bound it must not loosen. A null
 * `currentBoundAtMost` is representable and yields UNKNOWN naming the missing
 * input: an unobserved prior bound cannot be compared, so it is never assumed.
 */
export interface FairnessCapMigration {
  readonly workItemId: string;
  readonly boundAtMost: number;
  readonly currentBoundAtMost: number | null;
}

export interface FairnessCapRevision {
  readonly revisionRef: string;
  readonly dimensionId: string;
  readonly fromCapUnits: number;
  readonly toCapUnits: number;
  readonly drainedWorkItemIds: readonly string[];
  readonly migrations: readonly FairnessCapMigration[];
}

const MIGRATION_KEYS =
  Object.freeze(["workItemId", "boundAtMost", "currentBoundAtMost"] as const);
const REVISION_KEYS = Object.freeze([
  "revisionRef", "dimensionId", "fromCapUnits", "toCapUnits", "drainedWorkItemIds", "migrations",
] as const);

function capRefusal(
  code: FairnessContractIssueCode,
  message: string,
  subjects: readonly string[] = [],
): FairnessContractRefusal {
  return refuseFairness(makeFairnessIssue(code, "CAP_REVISION", message, null, subjects));
}

function readMigration(
  value: unknown,
  index: number,
): FairnessCapMigration | FairnessContractRefusal {
  const parsed = exactRecord(value, MIGRATION_KEYS);
  if (parsed === null) {
    return capRefusal("FAIRNESS_CONTRACT_MALFORMED_INPUT", "a migration is not a migration record");
  }
  const workItemId = parsed["workItemId"];
  if (!isFairnessIdentity(workItemId)) {
    return capRefusal(
      "FAIRNESS_CONTRACT_INVALID_IDENTITY", "workItemId is not a safe fairness identity",
    );
  }
  const boundAtMost = parsed["boundAtMost"];
  if (!isCount(boundAtMost)) {
    return capRefusal(
      "FAIRNESS_CONTRACT_INVALID_COUNTER", "boundAtMost is not a non-negative safe integer",
      [workItemId],
    );
  }
  const currentBoundAtMost = parsed["currentBoundAtMost"];
  if (currentBoundAtMost === null) {
    return unknownFairness(
      "FAIRNESS_CONTRACT_PRIOR_BOUND_UNOBSERVED", "CAP_REVISION",
      `migrations[${index}].currentBoundAtMost`, [workItemId],
    );
  }
  if (!isCount(currentBoundAtMost)) {
    return capRefusal(
      "FAIRNESS_CONTRACT_INVALID_COUNTER", "currentBoundAtMost is not a non-negative safe integer",
      [workItemId],
    );
  }
  if (boundAtMost > currentBoundAtMost) {
    return capRefusal(
      "FAIRNESS_CONTRACT_BOUND_LOOSENED", "a migration must be equal or tighter", [workItemId],
    );
  }
  return { workItemId, boundAtMost, currentBoundAtMost };
}

function readDrained(value: unknown): readonly string[] | FairnessContractRefusal {
  const items = readFairnessItems(value, "CAP_REVISION", "drainedWorkItemIds");
  if (isFairnessRefusal(items)) return items;
  const drained: string[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    if (!isFairnessIdentity(raw)) {
      return capRefusal(
        "FAIRNESS_CONTRACT_INVALID_IDENTITY", "a drained id is not a safe fairness identity",
      );
    }
    if (seen.has(raw)) {
      return capRefusal("FAIRNESS_CONTRACT_DUPLICATE_IDENTITY", "a drained id repeats", [raw]);
    }
    seen.add(raw);
    drained.push(raw);
  }
  return drained;
}

/**
 * Total validator. Range-checks the revision and enforces the structural rules a
 * revision datum must satisfy on its own — equal-or-tighter migrations, no target
 * both drained and migrated, no repeated identity. It does NOT judge the
 * DIRECTION of the revision, because that is the consumer's decision.
 */
export function validateCapRevision(
  value: unknown,
): FairnessContractResult<FairnessCapRevision> {
  const parsed = exactRecord(value, REVISION_KEYS);
  if (parsed === null) {
    return capRefusal("FAIRNESS_CONTRACT_MALFORMED_INPUT", "input is not a cap revision record");
  }
  const revisionRef = parsed["revisionRef"];
  const dimensionId = parsed["dimensionId"];
  if (!isFairnessIdentity(revisionRef)) {
    return capRefusal(
      "FAIRNESS_CONTRACT_INVALID_IDENTITY", "revisionRef is not a safe fairness identity",
    );
  }
  if (!isFairnessIdentity(dimensionId)) {
    return capRefusal(
      "FAIRNESS_CONTRACT_INVALID_IDENTITY", "dimensionId is not a safe fairness identity",
    );
  }
  const fromCapUnits = parsed["fromCapUnits"];
  const toCapUnits = parsed["toCapUnits"];
  if (!isCount(fromCapUnits) || !isCount(toCapUnits)) {
    return capRefusal(
      "FAIRNESS_CONTRACT_INVALID_COUNTER", "a cap unit count is not a non-negative safe integer",
    );
  }
  const drainedWorkItemIds = readDrained(parsed["drainedWorkItemIds"]);
  if (isFairnessRefusal(drainedWorkItemIds)) return drainedWorkItemIds;
  const rawMigrations = readFairnessItems(parsed["migrations"], "CAP_REVISION", "migrations");
  if (isFairnessRefusal(rawMigrations)) return rawMigrations;
  const migrations: FairnessCapMigration[] = [];
  const targets = new Set<string>();
  for (const [index, raw] of rawMigrations.entries()) {
    const migration = readMigration(raw, index);
    if (isFairnessRefusal(migration)) return migration;
    if (targets.has(migration.workItemId)) {
      return capRefusal(
        "FAIRNESS_CONTRACT_DUPLICATE_IDENTITY", "a migration target repeats",
        [migration.workItemId],
      );
    }
    targets.add(migration.workItemId);
    migrations.push(migration);
  }
  const drainedSet = new Set(drainedWorkItemIds);
  for (const target of targets) {
    if (drainedSet.has(target)) {
      return capRefusal(
        "FAIRNESS_CONTRACT_MIGRATION_TARGET_DRAINED",
        "a work item is both drained and migrated", [target],
      );
    }
  }
  return acceptFairness({
    revisionRef, dimensionId, fromCapUnits, toCapUnits, drainedWorkItemIds, migrations,
  });
}
