import {
  CUTOVER_GENERATION_SNAPSHOT_LAYER,
  readCutoverGenerationSnapshot,
} from "../../apps/daemon/src/cutover/cutover-generation-snapshot.js";
import {
  IMPORT_GENERATION_READ_LAYER,
  readDurableImportGeneration,
} from "../../apps/daemon/src/projections/import-generation-reader.js";

export type RecentDurableArm = "AFTER" | "BEFORE" | "RACE";

export interface RecentDurableCase {
  readonly arm: RecentDurableArm;
  readonly boundary: string;
  readonly expected: Readonly<{ code: string; layer: string }>;
  readonly run: () => Promise<unknown | readonly [unknown, unknown]>;
}

const cutoverRefusal = (): unknown => readCutoverGenerationSnapshot({
  config: { storeRoot: "unreachable" },
  readFileText: () => { throw new Error("unreachable"); },
  store: { readEventHorizon: () => { throw new Error("store unavailable"); } },
} as never, { projectId: "project-1" });

const importRefusal = (): unknown => readDurableImportGeneration(
  {} as never,
  { importGenerationSha256: "f".repeat(64) },
);

const casesFor = (
  boundary: string,
  expected: Readonly<{ code: string; layer: string }>,
  refused: () => unknown,
): readonly RecentDurableCase[] => Object.freeze([
  { arm: "BEFORE", boundary, expected, run: async () => refused() },
  { arm: "AFTER", boundary, expected, run: async () => { refused(); return refused(); } },
  {
    arm: "RACE", boundary, expected,
    run: async () => Promise.all([
      Promise.resolve().then(refused),
      Promise.resolve().then(refused),
    ]),
  },
]);

export const RECENT_DURABLE_HOSTILE_CASES: readonly RecentDurableCase[] = Object.freeze([
  ...casesFor(
    "CUTOVER_GENERATION_SNAPSHOT_LAYER",
    { code: "CUTOVER_GENERATION_EVIDENCE_UNREADABLE", layer: CUTOVER_GENERATION_SNAPSHOT_LAYER },
    cutoverRefusal,
  ),
  ...casesFor(
    "IMPORT_GENERATION_READ_LAYER",
    { code: "IMPORT_GENERATION_INPUT_INVALID", layer: IMPORT_GENERATION_READ_LAYER },
    importRefusal,
  ),
]);
