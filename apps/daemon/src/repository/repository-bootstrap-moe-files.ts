import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CREDENTIAL_BYTES, MOE_CONFIG_FILENAME, MOE_CONFIG_SCHEMA_VERSION, cryptoRandomHex }
  from "../cli/moe-init.js";
import type { MoeConfig } from "../cli/moe-init.js";

/**
 * MOE'S OWN FILES INSIDE A FRESHLY BOOTSTRAPPED PRODUCT — the two paths the manager catalog is
 * registered against, and the reason `repository.bootstrap` could not once succeed before this
 * module existed.
 *
 * `canonicalEntry` (project-catalog.ts) realpaths an entry's `configPath` and the DIRECTORY of its
 * `storePath`. The command named `<dir>/moe.config.json` and `<dir>/.moe-next/store.sqlite`, the
 * controlled profile emits NEITHER, so both were ENOENT and EVERY local-only bootstrap answered
 * PROJECT_CATALOG_PATH_UNRESOLVED -> BOOTSTRAP_CATALOG_FAILED — after the repository had already
 * been created, committed and BOUND. The operator was told the bootstrap failed while holding a
 * perfectly good bound repository.
 *
 * THESE ARE NOT PRODUCT FILES AND THEY ARE NOT IN THE CONTROLLED PROFILE. The scaffold emits the
 * product; this emits Moe's bookkeeping ABOUT the product. That separation is why the fix lives
 * here rather than in `controlled-profile-*`, and why the catalog's realpath contract was left
 * strictly alone: it is the guard that stops a typo registering, not the defect.
 */

/** Moe's per-checkout directory inside a product. Gitignored by the generated `.gitignore`. */
const MOE_DIRECTORY = ".moe-next";
const STORE_FILENAME = "store.sqlite";

export interface MoeProjectPaths {
  readonly configPath: string;
  readonly storePath: string;
}

/** THE ONE derivation of both paths, so the bytes written here and the bytes handed to the
 *  catalog cannot drift into naming different files. */
export function moeProjectPaths(dir: string): MoeProjectPaths {
  return {
    configPath: join(dir, MOE_CONFIG_FILENAME),
    storePath: join(dir, MOE_DIRECTORY, STORE_FILENAME),
  };
}

/**
 * Creates `.moe-next/` and writes `moe.config.json`. It runs AFTER the scaffold commit and BEFORE
 * the catalog registration, and BOTH halves of that window are load-bearing.
 *
 * AFTER THE COMMIT, because `createBootstrapGitPort` commits with `add -A`. Creating these any
 * earlier would sweep a SQLite store directory AND A MINTED CREDENTIAL into the operator's very
 * first commit — and when the GitHub half is requested, `gh repo create --source . --push` would
 * push that commit. A secret in a scaffold commit is a secret in every clone of it.
 *
 * BEFORE `registerCatalog`, because that is the only caller these two paths exist for.
 *
 * THE CONFIG IS GITIGNORED RATHER THAN COMMITTED — deliberately, on two independent grounds, so
 * that the next reader re-opens the question on purpose rather than by accident. (1) It carries a
 * minted credential, and a committed credential is a published one. (2) `planInit` refuses
 * `MOE_INIT_CONFIG_PRESENT` when `moe.config.json` is already in the target (moe-init.ts:143-146),
 * unwaivable by `--force`, so a committed config would make `moe init` REFUSE on every fresh clone
 * of the product.
 *
 * IT THROWS ON FAILURE, and that is the contract the caller wants: `bootstrapRepository` has
 * BOOTSTRAP_CATALOG_FAILED / CATALOG_FAILED_LOCAL_REPOSITORY_RETAINED already armed at this point,
 * so a throw here answers with that exact code and the operator's repository is RETAINED. Nothing
 * on this path deletes or rolls back a repository to tidy a failure.
 */
export async function writeMoeProjectFiles(
  dir: string, projectId: string, randomHex: (bytes: number) => string = cryptoRandomHex,
): Promise<MoeProjectPaths> {
  const paths = moeProjectPaths(dir);
  await mkdir(join(dir, MOE_DIRECTORY), { recursive: true });
  // The KEY ORDER is fixed by this literal, matching `planInit`'s config so the two writers
  // produce the same shape; `parseMoeConfig` must accept these bytes back.
  const config: MoeConfig = {
    credential: randomHex(CREDENTIAL_BYTES), projectId,
    schemaVersion: MOE_CONFIG_SCHEMA_VERSION, storePath: paths.storePath,
  };
  // `wx` NEVER overwrites. The directory was empty at `prepare` and only the scaffold has written
  // to it since, so a config already sitting here means an assumption broke: fail closed rather
  // than overwrite a file this command did not create.
  await writeFile(paths.configPath, `${JSON.stringify(config, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" });
  return paths;
}
