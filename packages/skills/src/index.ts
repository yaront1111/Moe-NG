/**
 * Public surface of the versioned skill bundle runtime.
 *
 * Skills are advisory context only. Nothing exported here can create or mutate
 * command, capability, approval, lease, policy, budget, effect, or execution
 * authority.
 */

export {
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FILES,
  MAX_SKILL_ID_CHARS,
  MAX_SKILL_PATH_CHARS,
  MAX_SKILL_REQUESTS,
  MAX_SKILL_TOTAL_BYTES,
  SKILL_ERROR_CODES,
  SKILL_MANIFEST_VERSION,
  SKILL_ORIGINS,
  SKILL_RENDERER_INPUT_VERSION,
  SKILL_SNAPSHOT_VERSION,
} from "./skill-contract.js";
export type { SkillErrorCode, SkillFailure, SkillOrigin } from "./skill-contract.js";

export { validateSkillManifestBytes } from "./skill-manifest.js";
export type {
  SkillManifest,
  SkillManifestFile,
  SkillManifestResult,
  ValidatedSkillManifest,
} from "./skill-manifest.js";

export { loadSkillBundle } from "./skill-loader.js";
export type {
  LoadedSkillBundle,
  LoadedSkillBundleOk,
  LoadedSkillFile,
  LoadSkillBundleResult,
  SkillFsFacade,
} from "./skill-loader.js";

export { resolveSkillSnapshot, toSkillRendererInput } from "./skill-snapshot.js";
export type {
  SkillRendererInput,
  SkillRequest,
  SkillSnapshot,
  SkillSnapshotEntry,
  SkillSnapshotOk,
  SkillSnapshotResult,
} from "./skill-snapshot.js";
