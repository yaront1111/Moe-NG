/**
 * HOSTILE COVERAGE — the EVIDENCE, WORKSPACE, CONTAINMENT AND SUPERVISION group, and the
 * COMPLETENESS HOME for the whole runtime-provider axis.
 *
 * Nine of the roster's twenty-two entries live here; the other thirteen are in
 * `runtime-provider-platform.security.ts` and `runtime-provider-launch.security.ts`. This file
 * is the ONE place the union of the three partitions is checked against the roster's committed
 * bytes, in BOTH directions, so a boundary owned by nobody — or a name no roster entry carries —
 * reddens exactly once rather than three times or never.
 *
 * WHY THE WHOLE-SLICE INVARIANT RUNS PER FILE. The lane is `pool: "forks"` with `isolate: true`,
 * so the three files cannot share one array. `describeSliceInvariants` is therefore ONE
 * implementation invoked three times, each over that file's ENTIRE ledger rather than per case:
 * no admitted artifact, no accepted receipt, no materialized path outside containment, no
 * executed effect, no truth class above UNKNOWN, and no refusal message echoing a path or digest.
 *
 * CONTAINMENT IS THE HEART OF THIS GROUP. Every path-shaped case covers the escape family —
 * `..` traversal, an absolute/drive-qualified path, a backslash, a reserved device name, a NUL,
 * and a symlink whose target leaves the root. The symlink case CANONICALISES before asserting:
 * `hostileRoot` realpaths its temp directory precisely because macOS `tmpdir()` is the symlink
 * `/var` over `/private/var`, which a naive string comparison reads as an escape and would pass
 * the case for the wrong reason on one platform while failing it on another.
 */

import { realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { enumerateArtifactsAt } from "../../packages/runner/src/artifacts/artifact-enumeration.js";
import { ARTIFACT_ENUMERATION_LAYERS } from "../../packages/runner/src/artifacts/artifact-contract.js";
import { EVIDENCE_REFUSAL_LAYERS } from "../../packages/runner/src/evidence/evidence-contract.js";
import { buildVerificationRecipe } from "../../packages/runner/src/evidence/verification-recipe.js";
import { VERIFIER_PROCESS_LAYERS } from "../../packages/runner/src/evidence/verifier-process-contract.js";
import { runVerifierProcess } from "../../packages/runner/src/evidence/verifier-process.js";
import { MATERIALIZATION_REFUSAL_LAYERS } from "../../packages/runner/src/materialization/materialization-kernel.js";
import { sealNodeInputManifest } from "../../packages/runner/src/materialization/input-manifest-seal.js";
import { revalidateSealedManifest } from "../../packages/runner/src/materialization/manifest-staleness.js";
import { RECOVERY_LAYERS } from "../../packages/runner/src/recovery/recovery-contract.js";
import { RECOVERY_INVENTORY_LAYERS } from "../../packages/runner/src/recovery-inventory/recovery-inventory-contract.js";
import { SCOPE_OBSERVER_LAYERS, ScopeObserverError } from "../../packages/runner/src/scope/scope-contract.js";
import { classifyRefFailure } from "../../packages/runner/src/scope/scope-git-classify.js";
import { observeScope } from "../../packages/runner/src/scope/scope-observation.js";
import { SUPERVISOR_LAYERS } from "../../packages/runner/src/supervisor/effect-kernel.js";
import { isContainedBy } from "../../packages/runner/src/workspace/workspace-contract.js";
import { buildResultManifest } from "../../packages/runner/src/workspace/workspace-manifest.js";
import { probeAfter, probeBefore, probeRacing, withHostileRoot } from "./hostile-harness.js";
import { describeSupervisionBoundaries } from "./runtime-provider-supervision-cases.js";
import {
  ESCAPE_FAMILY, EVIDENCE_SECRETS, POISON_PATH, artifactFs, scopeInput, verifierInput,
} from "./runtime-provider-evidence-fixtures.js";
import {
  RUNTIME_BOUND as BOUND, RUNTIME_PROVIDER_PARTITION, assertRosterPartition, createLedger,
  describeSliceInvariants, hostile, layerOf, refusedWithoutLayer,
} from "./runtime-provider-ledger.js";

const OWNED = RUNTIME_PROVIDER_PARTITION.EVIDENCE;
const ledger = createLedger();

const FS_PORT = layerOf(ARTIFACT_ENUMERATION_LAYERS, "ARTIFACT_FS_PORT");
const STORE = layerOf(ARTIFACT_ENUMERATION_LAYERS, "ARTIFACT_STORE");
const RECIPE_SHAPE = layerOf(EVIDENCE_REFUSAL_LAYERS, "RECIPE_SHAPE");
const LAUNCH_GATE = layerOf(VERIFIER_PROCESS_LAYERS, "LAUNCH_GATE");
const SEAL = layerOf(MATERIALIZATION_REFUSAL_LAYERS, "SEAL");
const STALENESS = layerOf(MATERIALIZATION_REFUSAL_LAYERS, "STALENESS");
const GIT_OBSERVER = layerOf(SCOPE_OBSERVER_LAYERS, "GIT_OBSERVER");
const KERNEL = layerOf(SUPERVISOR_LAYERS, "KERNEL");
const SAFE_BOUNDARY = layerOf(RECOVERY_LAYERS, "SAFE_BOUNDARY");
const CLASSIFICATION = layerOf(RECOVERY_LAYERS, "CLASSIFICATION");
const INVENTORY = layerOf(RECOVERY_INVENTORY_LAYERS, "INVENTORY_ADAPTER");

// ── ARTIFACT_ENUMERATION_LAYERS ───────────────────────────────────────────────────────────
// An enumerator that could not look must never report "no artifacts". The two layers are
// pinned apart: a port that cannot list is the STORE's answer, a directory it could not read
// is the PORT's.
describe("ARTIFACT_ENUMERATION_LAYERS", () => {
  const boundary = "ARTIFACT_ENUMERATION_LAYERS";

  it("BEFORE — a port with no listing capability answers as the STORE, not the port", async () => {
    const outcome = await probeBefore(
      BOUND,
      async () => enumerateArtifactsAt(artifactFs({ list: null }), POISON_PATH),
      async () => enumerateArtifactsAt(artifactFs({ list: null, exists: false }), POISON_PATH),
    );
    const unavailable = { code: "RUNNER_ARTIFACT_ENUMERATION_UNAVAILABLE", layer: STORE };
    ledger.refused(boundary, "BEFORE", outcome.probe, unavailable);
    // Even with the directory absent, the capability gate answers FIRST and stays the STORE's.
    ledger.refused(boundary, "BEFORE", outcome.effect, unavailable);
  });

  it("AFTER — a listing that throws refuses rather than reporting an empty directory", async () => {
    const outcome = await probeAfter(
      BOUND,
      async () => enumerateArtifactsAt(artifactFs({ throws: true }), POISON_PATH),
      async () => enumerateArtifactsAt(artifactFs({ exists: false }), POISON_PATH),
    );
    ledger.refused(boundary, "AFTER", outcome.effect, {
      code: "RUNNER_ARTIFACT_VERIFY_FAILED", layer: FS_PORT,
    });
    ledger.refused(boundary, "AFTER", outcome.probe, {
      code: "RUNNER_ARTIFACT_MISSING", layer: FS_PORT,
    });
  });

  it("RACE — two unreadable enumerations contend and neither admits an artifact", async () => {
    const outcome = await probeRacing(
      BOUND,
      async () => enumerateArtifactsAt(artifactFs({ throws: true }), POISON_PATH),
      async () => enumerateArtifactsAt(artifactFs({ list: null }), POISON_PATH),
    );
    ledger.refusedSide(boundary, outcome.left, {
      code: "RUNNER_ARTIFACT_VERIFY_FAILED", layer: FS_PORT,
    });
    ledger.refusedSide(boundary, outcome.right, {
      code: "RUNNER_ARTIFACT_ENUMERATION_UNAVAILABLE", layer: STORE,
    });
  });
});

// ── EVIDENCE_REFUSAL_LAYERS ───────────────────────────────────────────────────────────────
// A declared artifact ref that no longer names its own bytes, and a path that escapes the
// candidate. RECIPE_SHAPE is arranged: the recipe never reaches binding or execution.
describe("EVIDENCE_REFUSAL_LAYERS", () => {
  const boundary = "EVIDENCE_REFUSAL_LAYERS";
  const refInvalid = { code: "RUNNER_EVIDENCE_ARTIFACT_REF_INVALID", layer: RECIPE_SHAPE };
  const recipe = (declarations: unknown[], argv: unknown[] = ["node", "--version"]): unknown =>
    buildVerificationRecipe(hostile({ argv, declarations }));

  it("BEFORE — a declaration whose ref is not a record cannot enter a recipe", async () => {
    const outcome = await probeBefore(
      BOUND,
      async () => recipe([{ path: "out.txt", ref: null }]),
      async () => recipe([{ path: "out.txt", ref: { sha256: POISON_PATH, byteLength: -1 } }]),
    );
    ledger.refused(boundary, "BEFORE", outcome.probe, refInvalid);
    ledger.refused(boundary, "BEFORE", outcome.effect, refInvalid);
  });

  it("AFTER — every path escape is refused, each keeping its own code", async () => {
    // The whole escape family, swept. The generated count is asserted so a sweep that
    // silently produced nothing cannot pass.
    expect(ESCAPE_FAMILY.length).toBeGreaterThan(4);
    for (const [label, path] of ESCAPE_FAMILY) {
      const observed = recipe([{ path, ref: null }]);
      expect(`${label}:${String((observed as { ok: boolean }).ok)}`).toBe(`${label}:false`);
      ledger.refused(boundary, "AFTER", observed, refInvalid);
    }
  });

  it("RACE — a hostile argv and a hostile declaration contend; no recipe is sealed", async () => {
    const outcome = await probeRacing(
      BOUND,
      async () => recipe([{ path: "out.txt", ref: null }], hostile<unknown[]>(null)),
      async () => recipe(hostile<unknown[]>({ length: 1 })),
    );
    // DISTINCT codes at ONE layer: an argv fault is not a declaration fault, and pinning them
    // together would let either answer for the other.
    for (const side of [outcome.left, outcome.right]) {
      expect((side as { value: { recipe?: unknown } }).value.recipe).toBeUndefined();
    }
    ledger.refusedSide(boundary, outcome.left, {
      code: "RUNNER_EVIDENCE_ARGV_INVALID", layer: RECIPE_SHAPE,
    });
    ledger.refusedSide(boundary, outcome.right, refInvalid);
  });
});

// ── VERIFIER_PROCESS_LAYERS ───────────────────────────────────────────────────────────────
// The gate above the process seam. Every case injects a launcher that THROWS if called, so
// "no child was created" is proven rather than asserted, and the refusal returns without a
// spawn — which is also why none of these can hang.
describe("VERIFIER_PROCESS_LAYERS", () => {
  const boundary = "VERIFIER_PROCESS_LAYERS";
  const sealInvalid = { code: "VERIFIER_PROCESS_RECIPE_SEAL_INVALID", layer: LAUNCH_GATE };

  it("BEFORE — a recipe whose seal does not re-derive never reaches the process seam", async () => {
    const spawns: string[] = [];
    const outcome = await probeBefore(
      BOUND,
      async () => await runVerifierProcess(verifierInput(spawns, {})),
      async () => await runVerifierProcess(verifierInput(spawns, { recipe: { sha256: POISON_PATH, argv: ["evil.cmd"] } })),
    );
    // ZERO spawns: the assertion the gate order exists to support.
    expect(spawns).toEqual([]);
    ledger.refused(boundary, "BEFORE", (outcome.probe as { failure: unknown }).failure, sealInvalid);
    ledger.refused(boundary, "BEFORE", (outcome.effect as { failure: unknown }).failure, sealInvalid);
  });

  it("AFTER — a script shim and an escaping candidate root are both refused at the gate", async () => {
    const spawns: string[] = [];
    const outcome = await probeAfter(
      BOUND,
      async () => await runVerifierProcess(verifierInput(spawns, { recipe: { sha256: "", argv: ["shim.cmd"] } })),
      async () => await runVerifierProcess(verifierInput(spawns, { candidateRoot: "../escape" })),
    );
    expect(spawns).toEqual([]);
    ledger.refused(boundary, "AFTER", (outcome.effect as { failure: unknown }).failure, sealInvalid);
    ledger.refused(boundary, "AFTER", (outcome.probe as { failure: unknown }).failure, sealInvalid);
  });

  it("RACE — two gated launches contend under a bound and BOTH terminate, neither spawning", async () => {
    const spawns: string[] = [];
    const outcome = await probeRacing(
      BOUND,
      async () => await runVerifierProcess(verifierInput(spawns, {})),
      async () => await runVerifierProcess(verifierInput(spawns, { wrapperIdentity: "" })),
    );
    // The bound did not expire: both legs SETTLED, which is what a hang would deny.
    expect([outcome.left.status, outcome.right.status]).toEqual(["fulfilled", "fulfilled"]);
    expect(spawns).toEqual([]);
    for (const side of [outcome.left, outcome.right]) {
      ledger.refusedSide(
        boundary,
        { status: "fulfilled", value: (side as { value: { failure: unknown } }).value.failure },
        sealInvalid,
      );
    }
  });
});

// ── MATERIALIZATION_REFUSAL_LAYERS ────────────────────────────────────────────────────────
// Sealing and revalidation. The two layers are pinned apart: a selection that never sealed is
// SEAL's answer, a sealed manifest whose digest no longer re-derives is STALENESS's.
describe("MATERIALIZATION_REFUSAL_LAYERS", () => {
  const boundary = "MATERIALIZATION_REFUSAL_LAYERS";
  const selectionInvalid = { code: "RUNNER_MATERIALIZATION_SELECTION_INVALID", layer: SEAL };
  const tampered = { code: "RUNNER_MATERIALIZATION_MANIFEST_TAMPERED", layer: STALENESS };
  const seal = (over: Record<string, unknown> = {}): unknown =>
    sealNodeInputManifest(hostile({ selection: null, witnesses: null, graphEpoch: null, environment: null, ...over }));

  it("BEFORE — a selection that is not bounded plain data cannot be sealed", async () => {
    const outcome = await probeBefore(
      BOUND,
      async () => seal(),
      async () => seal({ selection: POISON_PATH }),
    );
    ledger.refused(boundary, "BEFORE", outcome.probe, selectionInvalid);
    ledger.refused(boundary, "BEFORE", outcome.effect, selectionInvalid);
  });

  it("AFTER — a manifest whose digest no longer covers it is TAMPERED, not merely stale", async () => {
    const outcome = await probeAfter(
      BOUND,
      async () => revalidateSealedManifest(hostile({ manifest: null })),
      async () => revalidateSealedManifest(hostile({ manifest: { sha256: POISON_PATH } })),
    );
    ledger.refused(boundary, "AFTER", outcome.effect, tampered);
    ledger.refused(boundary, "AFTER", outcome.probe, tampered);
  });

  it("RACE — a seal and a revalidation contend; each answers at its OWN layer", async () => {
    const outcome = await probeRacing(
      BOUND,
      async () => seal(),
      async () => revalidateSealedManifest(hostile({ manifest: null })),
    );
    ledger.refusedSide(boundary, outcome.left, selectionInvalid);
    ledger.refusedSide(boundary, outcome.right, tampered);
  });
});

// ── SCOPE_OBSERVER_LAYERS ─────────────────────────────────────────────────────────────────
// The one declared layer is GIT_OBSERVER, and only a thrown `ScopeObserverError` carries it —
// `scopeFailure` reports code and path without a layer by design. Both halves are covered:
// `classifyRefFailure` for the layer-attributed refusal, `observeScope` for the escape family.
describe("SCOPE_OBSERVER_LAYERS", () => {
  const boundary = "SCOPE_OBSERVER_LAYERS";

  it("BEFORE — an observer fault is attributed to GIT_OBSERVER, never to the caller", async () => {
    const outcome = await probeBefore(
      BOUND,
      async () => classifyRefFailure(new Error("git exited 128")),
      async () => classifyRefFailure(new ScopeObserverError("RUNNER_SCOPE_OBSERVATION_FAILED", "boom", GIT_OBSERVER)),
    );
    for (const observed of [outcome.probe, outcome.effect]) {
      expect(observed).toBeInstanceOf(ScopeObserverError);
      ledger.refused(boundary, "BEFORE", { code: (observed as ScopeObserverError).code, layer: (observed as ScopeObserverError).layer }, {
        code: (observed as ScopeObserverError).code, layer: GIT_OBSERVER,
      });
    }
  });

  it("AFTER — every containment escape is refused, and each keeps its own code", async () => {
    expect(ESCAPE_FAMILY.length).toBeGreaterThan(4);
    const codes = new Set<string>();
    for (const [label, path, code] of ESCAPE_FAMILY) {
      const observed = observeScope(hostile(scopeInput({ declaredScopePaths: [path] })));
      // The EXACT code per member. "It refused" alone would stay green if a canonicalisation
      // rule were removed: the fixture's git observer throws, so the fall-through also refuses.
      expect(`${label}:${String((observed as { code: string }).code)}`).toBe(`${label}:${code}`);
      codes.add(code);
      refusedWithoutLayer(ledger, boundary, "AFTER", observed, code);
    }
    // More than one code across the family: a single catch-all would prove nothing about WHICH
    // reinterpretation was caught.
    expect(codes.size).toBeGreaterThan(1);
  });

  it("RACE — a symlink leaving the root is an escape AFTER canonicalisation, not before", async () => {
    await withHostileRoot("scope-symlink", async (root) => {
      // `hostileRoot` already realpaths, so the macOS `/var` -> `/private/var` symlink cannot
      // make a legitimate root read as an escape here.
      const outside = join(dirname(root), "outside.txt");
      writeFileSync(outside, "x");
      const link = join(root, "link.txt");
      let linked = true;
      try {
        symlinkSync(outside, link);
      } catch {
        // Windows without developer mode refuses symlink creation. The case does NOT skip: it
        // asserts the containment rule on the canonical target directly, which is the same
        // property the link exists to exercise.
        linked = false;
      }
      // Separators normalised, not the paths themselves: `isContainedBy` is a POSIX-separated
      // segment-prefix rule, and canonicalisation has already happened via realpath.
      const posix = (value: string): string => value.replaceAll("\\", "/");
      const target = posix(linked ? realpathSync(link) : realpathSync(outside));
      expect(isContainedBy(posix(root), target)).toBe(false);
      expect(isContainedBy(posix(root), posix(join(root, "inside.txt")))).toBe(true);
      const outcome = await probeRacing(
        BOUND,
        async () => observeScope(hostile(scopeInput({ declaredScopePaths: ["../outside.txt"] }))),
        async () => observeScope(hostile(scopeInput({ declaredScopePaths: [] }))),
      );
      for (const side of [outcome.left, outcome.right]) {
        expect(side.status).toBe("fulfilled");
        refusedWithoutLayer(
          ledger, boundary, "RACE", (side as { value: unknown }).value,
          String((side as { value: { code: string } }).value.code),
        );
      }
    });
  });
});

// ── SUPERVISOR_LAYERS, RECOVERY_LAYERS AND RECOVERY_INVENTORY_LAYERS ──────────────────────
// Registered from a sibling module for the 400-line rail, exactly as the render cases are.
// Each boundary still supplies its OWN layer constants, so a refusal answering with another
// boundary's layer reddens.
describeSupervisionBoundaries(ledger, {
  kernel: KERNEL, safeBoundary: SAFE_BOUNDARY, classification: CLASSIFICATION, inventory: INVENTORY,
});


// ── RUNNER_WORKSPACE_LAYER ────────────────────────────────────────────────────────────────
// The runner's own result-manifest builder. Its refusals carry a code and no layer: the daemon
// reports them under `RUNNER_WORKSPACE_LAYER`, deliberately keeping the runner's code verbatim
// rather than minting a second vocabulary for one condition. The absence is asserted, so a
// layer appearing on the runner side reddens here.
describe("RUNNER_WORKSPACE_LAYER", () => {
  const boundary = "RUNNER_WORKSPACE_LAYER";
  const build = (over: Record<string, unknown> = {}): unknown =>
    buildResultManifest(hostile({
      inputManifest: {}, scopeObservation: {}, authoredPaths: [], declaredArtifactRefs: [],
      resultTreeEntries: [], ...over,
    }));
  const invalid = "RUNNER_WORKSPACE_INPUT_MANIFEST_INVALID";

  it("BEFORE — an unusable input manifest cannot produce a result manifest", async () => {
    const outcome = await probeBefore(BOUND, async () => build(), async () => build({ inputManifest: { sha256: POISON_PATH } }));
    refusedWithoutLayer(ledger, boundary, "BEFORE", outcome.probe, invalid);
    refusedWithoutLayer(ledger, boundary, "BEFORE", outcome.effect, invalid);
  });

  it("AFTER — authored paths claiming an escape never reach a manifest", async () => {
    expect(ESCAPE_FAMILY.length).toBeGreaterThan(4);
    for (const [label, path] of ESCAPE_FAMILY) {
      const observed = build({ authoredPaths: [path] });
      expect(`${label}:${String((observed as { ok: boolean }).ok)}`).toBe(`${label}:false`);
      refusedWithoutLayer(ledger, boundary, "AFTER", observed, invalid);
    }
  });

  it("RACE — two unusable builds contend and neither yields a manifest", async () => {
    const outcome = await probeRacing(
      BOUND,
      async () => build({ authoredPaths: ["../escape"] }),
      async () => build({ declaredArtifactRefs: [null] }),
    );
    for (const side of [outcome.left, outcome.right]) {
      expect(side.status).toBe("fulfilled");
      expect((side as { value: { manifest?: unknown } }).value.manifest).toBeUndefined();
      refusedWithoutLayer(ledger, boundary, "RACE", (side as { value: unknown }).value, invalid);
    }
  });
});

// The one path exemption is SCOPE_OBSERVER_LAYERS: `scopeFailure` names the CALLER'S OWN
// rejected declaration in its message, which is the caller being told which of its paths was
// refused rather than output leaving a failure path. Digest, base64 and hostile-value checks
// still apply to it, and no provider-facing boundary is exempt from anything.
describeSliceInvariants("evidence group", ledger, OWNED, EVIDENCE_SECRETS, ["SCOPE_OBSERVER_LAYERS"]);

// ── THE COMPLETENESS HOME FOR THE WHOLE AXIS ──────────────────────────────────────────────
describe("runtime-provider axis — roster completeness", () => {
  it("partitions exactly the roster's 22 runtime-provider entries, in BOTH directions", () => {
    assertRosterPartition();
  });
});
