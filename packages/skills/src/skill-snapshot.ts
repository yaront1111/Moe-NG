import {
  canonicalDigest,
  canonicalJson,
  deepFreeze,
  MAX_SKILL_REQUESTS,
  SKILL_RENDERER_INPUT_VERSION,
  SKILL_SNAPSHOT_VERSION,
  skillFailure,
} from "./skill-contract.js";
import type { SkillFailure } from "./skill-contract.js";
import type { LoadedSkillBundle, LoadedSkillFile } from "./skill-loader.js";

/** A caller must name the skill, its version, and the exact bundle digest. */
export interface SkillRequest {
  readonly skillId: string;
  readonly version: string;
  readonly bundleDigest: string;
}

export interface SkillSnapshotEntry {
  readonly skillId: string;
  readonly version: string;
  readonly origin: string;
  readonly bundleDigest: string;
  readonly files: readonly LoadedSkillFile[];
}

export interface SkillSnapshot {
  readonly snapshotVersion: string;
  readonly authority: "NONE";
  readonly advisoryOnly: true;
  readonly skills: readonly SkillSnapshotEntry[];
  readonly snapshotDigest: string;
}

export interface SkillSnapshotOk {
  readonly ok: true;
  readonly snapshot: SkillSnapshot;
  readonly canonicalJson: string;
}

export type SkillSnapshotResult = SkillSnapshotOk | SkillFailure;

export interface SkillRendererInput {
  readonly rendererInputVersion: string;
  readonly authority: "NONE";
  readonly advisoryOnly: true;
  readonly skills: readonly SkillSnapshotEntry[];
}

/** One skillId may be offered by at most one loaded bundle. */
function indexBundles(
  bundles: readonly LoadedSkillBundle[],
): ReadonlyMap<string, LoadedSkillBundle> | SkillFailure {
  const index = new Map<string, LoadedSkillBundle>();
  for (const bundle of bundles) {
    if (index.has(bundle.skillId)) {
      return skillFailure(
        "SKILL_REQUEST_AMBIGUOUS",
        `more than one loaded bundle claims skill ${JSON.stringify(bundle.skillId)}`,
      );
    }
    index.set(bundle.skillId, bundle);
  }
  return index;
}

function isFailure(value: unknown): value is SkillFailure {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;
}

function toEntry(bundle: LoadedSkillBundle): SkillSnapshotEntry {
  return {
    skillId: bundle.skillId,
    version: bundle.version,
    origin: bundle.origin,
    bundleDigest: bundle.bundleDigest,
    files: bundle.files,
  };
}

/**
 * Resolves an explicit request list against loaded bundles.
 *
 * Deterministic and all-or-nothing: a single unmatched request fails the whole
 * resolution, and the result is sorted by skillId so request order cannot
 * change the snapshot digest. No wall clock, environment, or absolute path
 * enters the output — provenance is content-derived only, so a replay of the
 * same bytes reproduces the same digest.
 */
export function resolveSkillSnapshot(
  bundles: readonly LoadedSkillBundle[],
  requests: readonly SkillRequest[],
): SkillSnapshotResult {
  if (requests.length > MAX_SKILL_REQUESTS) {
    return skillFailure("SKILL_LIMIT_EXCEEDED", `requests exceed ${MAX_SKILL_REQUESTS} entries`);
  }
  const index = indexBundles(bundles);
  if (isFailure(index)) {
    return index;
  }
  const selected: SkillSnapshotEntry[] = [];
  const requested = new Set<string>();
  for (const request of requests) {
    if (requested.has(request.skillId)) {
      return skillFailure(
        "SKILL_REQUEST_AMBIGUOUS",
        `skill ${JSON.stringify(request.skillId)} was requested more than once`,
      );
    }
    requested.add(request.skillId);
    const bundle = index.get(request.skillId);
    if (
      bundle === undefined ||
      bundle.version !== request.version ||
      bundle.bundleDigest !== request.bundleDigest
    ) {
      return skillFailure(
        "SKILL_REQUEST_UNKNOWN",
        `no loaded bundle matches skill ${JSON.stringify(request.skillId)} at the requested version and digest`,
      );
    }
    selected.push(toEntry(bundle));
  }
  selected.sort((left, right) => (left.skillId < right.skillId ? -1 : left.skillId > right.skillId ? 1 : 0));
  const body = {
    snapshotVersion: SKILL_SNAPSHOT_VERSION,
    authority: "NONE" as const,
    advisoryOnly: true as const,
    skills: selected,
  };
  const snapshot: SkillSnapshot = { ...body, snapshotDigest: canonicalDigest(body) };
  return deepFreeze({
    ok: true as const,
    snapshot,
    canonicalJson: canonicalJson(snapshot),
  });
}

/**
 * Projects a validated snapshot into the shape a provider adapter renders.
 *
 * Pure: no filesystem, no ambient state, no new information. An adapter may
 * render this text but must never reinterpret it as authority.
 */
export function toSkillRendererInput(snapshot: SkillSnapshot): SkillRendererInput {
  return deepFreeze({
    rendererInputVersion: SKILL_RENDERER_INPUT_VERSION,
    authority: "NONE" as const,
    advisoryOnly: true as const,
    skills: snapshot.skills,
  });
}
