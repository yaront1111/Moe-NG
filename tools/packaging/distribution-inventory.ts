import type {
  DistributionComponentKind,
} from "../../packages/contracts/src/distribution/distribution-contract.js";

/**
 * THE CANONICAL SHIPPED DISTRIBUTION SUBJECT.
 *
 * One production-owned list of exactly what this repo ships, consumed by BOTH
 * scripts/release/release-subject.mjs and the distribution integration suite. Before this
 * module existed there were two answers to "what ships": the release script named five
 * components and omitted the JetBrains IDE adapter entirely, while the integration test
 * built its own six-entry list. Their provider-claude asset sets disagreed too — eleven
 * hand-written paths against twenty-two discovered by a directory walk.
 *
 * HAND-WRITTEN AND FROZEN, NEVER GENERATED. These asset paths are the SUBJECT of a
 * distribution digest. Deriving them from a directory walk would make the shipped subject
 * depend on whatever happens to be on disk at build time, which is the one thing a
 * canonical inventory exists to prevent. The walk this module replaced demonstrated the
 * hazard concretely: it excluded `*.test.ts` but not `*-test-fixtures.ts`, so it swept
 * claude-launcher-test-fixtures.ts and claude-launcher-authority-test-fixtures.ts into a
 * shipped distribution.
 *
 * PATHS ARE FORWARD-SLASH LOGICAL PATHS, NEVER OS-JOINED. `readOwned` in
 * release-subject.mjs splits on "/" and resolves against the source root, and this repo
 * ships on Windows.
 *
 * ORDER IS PART OF THE SUBJECT. The release layer admits a caller-supplied inventory only
 * when it byte-matches this array, order included; reordering here changes what a caller
 * must present.
 *
 * This module has NO runtime imports by design — the type import above is erased — so it
 * loads under plain Node with nothing to resolve.
 */
export type DistributionInventoryComponent = {
  readonly assets: readonly string[];
  readonly componentId: string;
  readonly componentKind: DistributionComponentKind;
};

const component = (
  componentId: string,
  componentKind: DistributionComponentKind,
  assets: readonly string[],
): DistributionInventoryComponent =>
  Object.freeze({ assets: Object.freeze([...assets]), componentId, componentKind });

/**
 * The two provider adapters ship their curated runtime modules only. The launcher family
 * under packages/runner/src/providers/claude is deliberately absent: it was never part of
 * the release script's shipped subject, and half of what a directory walk found there is
 * test fixtures. Adding it would change provider-claude's container digest and is a
 * decision for its own task, not a side effect of unifying two inventories.
 */
const PROVIDER_CLAUDE_ASSETS = [
  "packages/runner/src/providers/claude/claude-cancel-reconcile.ts",
  "packages/runner/src/providers/claude/claude-capabilities.ts",
  "packages/runner/src/providers/claude/claude-observation.ts",
  "packages/runner/src/providers/claude/claude-probe.ts",
  "packages/runner/src/providers/claude/claude-render.ts",
  "packages/runner/src/providers/claude/claude-runtime-pin-closure.ts",
  "packages/runner/src/providers/claude/claude-runtime-pin-copy.ts",
  "packages/runner/src/providers/claude/claude-runtime-pin-fs.ts",
  "packages/runner/src/providers/claude/claude-runtime-pin.ts",
  "packages/runner/src/providers/claude/claude-stream-anomalies.ts",
  "packages/runner/src/providers/claude/claude-stream.ts",
];

const PROVIDER_CODEX_ASSETS = [
  "packages/runner/src/providers/codex/codex-cancel-reconcile.ts",
  "packages/runner/src/providers/codex/codex-capabilities.ts",
  "packages/runner/src/providers/codex/codex-observation.ts",
  "packages/runner/src/providers/codex/codex-probe.ts",
  "packages/runner/src/providers/codex/codex-render-skills.ts",
  "packages/runner/src/providers/codex/codex-render.ts",
  "packages/runner/src/providers/codex/codex-stream-anomalies.ts",
  "packages/runner/src/providers/codex/codex-stream.ts",
];

/**
 * The JetBrains IDE adapter, landed by task-9fd52b41f3ea4aad8c0c07bbe6fd3025
 * (adapters/jetbrains, adapters/ide-contract) and task-9fff3d4258ca4bd8b6e167761ee94fdf
 * (the host that composes them).
 *
 * Both the `.ts` modules AND their `.js` bridges are enumerated. The bridges are what let
 * these modules resolve each other under plain Node; an adapter shipped without them
 * would not load at all.
 */
const IDE_ADAPTER_JETBRAINS_ASSETS = [
  "adapters/ide-contract/src/index.js",
  "adapters/ide-contract/src/index.ts",
  "adapters/jetbrains/src/host/jetbrains-host-port-detail.js",
  "adapters/jetbrains/src/host/jetbrains-host-port-detail.ts",
  "adapters/jetbrains/src/host/jetbrains-host-ports.js",
  "adapters/jetbrains/src/host/jetbrains-host-ports.ts",
  "adapters/jetbrains/src/host/jetbrains-host.js",
  "adapters/jetbrains/src/host/jetbrains-host.ts",
  "adapters/jetbrains/src/index.js",
  "adapters/jetbrains/src/index.ts",
  "adapters/jetbrains/src/jetbrains-distribution-gate.js",
  "adapters/jetbrains/src/jetbrains-distribution-gate.ts",
];

/** The six shipped components. Adding, dropping or reordering an entry changes the
 *  shipped subject and must be a deliberate, reviewed act. */
export const DISTRIBUTION_INVENTORY: readonly DistributionInventoryComponent[] =
  Object.freeze([
    component("daemon", "DAEMON", ["apps/daemon/src/index.ts"]),
    component("control-room", "CONTROL_ROOM", ["apps/control-room/index.html"]),
    component("mcp-bridge", "MCP_BRIDGE", ["packages/mcp/src/index.ts"]),
    component("provider-claude", "PROVIDER_ADAPTER", PROVIDER_CLAUDE_ASSETS),
    component("provider-codex", "PROVIDER_ADAPTER", PROVIDER_CODEX_ASSETS),
    component("ide-adapter-jetbrains", "IDE_ADAPTER", IDE_ADAPTER_JETBRAINS_ASSETS),
  ]);
