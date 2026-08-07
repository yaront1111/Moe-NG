import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

import { DurableStoreError } from "./store-contracts.js";
import { invalidInput } from "./store-input.js";
import { stringIsWellFormed } from "./store-internals.js";

export {
  bootstrapAndValidateSchema,
  isSqliteBusy,
} from "./sqlite-schema-bootstrap.js";

/** Package-internal query exported only so its production access plan can be regression-tested. */
export function canonicalDatabasePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    !Reflect.apply(stringIsWellFormed, value, []) ||
    value.startsWith("file:") ||
    !isAbsolute(value)
  ) {
    return invalidInput("database path must be a well-formed absolute filesystem path");
  }
  try {
    if (existsSync(value)) {
      return realpathSync.native(value);
    }
    return join(realpathSync.native(dirname(value)), basename(value));
  } catch (error) {
    throw new DurableStoreError(
      "STORE_INPUT_INVALID",
      "database path parent must exist and be canonically resolvable",
      { cause: error },
    );
  }
}

export function isFreshDatabaseFileCandidate(databasePath: string | null): boolean {
  if (databasePath === null) {
    return true;
  }
  try {
    return !existsSync(databasePath) || statSync(databasePath).size === 0;
  } catch (error) {
    throw new DurableStoreError(
      "STORE_UNAVAILABLE",
      "unable to inspect the SQLite database file",
      { cause: error },
    );
  }
}

export function compareVersions(left: string, right: string): number {
  const parse = (value: string): readonly number[] => {
    if (!/^\d+\.\d+\.\d+$/.test(value)) {
      throw new Error(`SQLITE_VERSION_INVALID: ${value}`);
    }
    return value.split(".").map((part) => Number.parseInt(part, 10));
  };
  const leftParts = parse(left);
  const rightParts = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

