/**
 * The inputs the daemon-backed lane needs BEFORE any process exists: a scratch
 * store, a per-run identity, the code-node spec the daemon publishes, and the
 * wire protocol version a direct cross-check request has to present.
 *
 * WHY THE IDENTITIES ARE PER-RUN. The journey proves the board rendered REAL
 * daemon data, and the only way an assertion can tell real data from a frozen
 * fixture is to name something no fixture could contain. Every identity below is
 * derived from the scratch directory's own random suffix, so the aggregate id the
 * board card carries is minted by THIS run and cannot be matched by the committed
 * fixture corpus. A fixed id would make the positive arm pass against fixtures.
 *
 * Nothing here spawns, kills or waits — that is `daemon-ports.ts`. Split so the
 * per-file cap is met without either half doing two jobs.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Known to the test, known to the daemon, and never derived from a default. */
export const LANE_CREDENTIAL = "e2e-daemon-lane-credential";
export const LANE_CSRF_TOKEN = "e2e-daemon-lane-csrf";

const SCRATCH_PREFIX = "moe-e2e-daemon-";

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const HOP_COUNTED_ROOT = resolve(HERE, "..", "..", "..");

/**
 * A hop-counted root breaks silently the day this file moves, and every child
 * would then be spawned against a directory that holds no daemon. Anchor it on
 * two files only the real root has and fail closed rather than spawn nothing.
 */
export function repoRoot(): string | null {
  const anchored = existsSync(join(HOP_COUNTED_ROOT, "package.json"))
    && existsSync(join(HOP_COUNTED_ROOT, "pnpm-workspace.yaml"));
  return anchored ? HOP_COUNTED_ROOT : null;
}

export interface LaneScratch {
  /** Where the daemon reads its one code-node spec from. */
  readonly nodeSpecsDir: string;
  /** The aggregate id the seeded `node.deliver` step carries. Unique per run. */
  readonly nodeRef: string;
  readonly projectId: string;
  readonly root: string;
  readonly storePath: string;
  /** The random suffix every identity above is derived from. */
  readonly tag: string;
}

/**
 * Creates the scratch tree and writes the node spec.
 *
 * The spec's five string fields are all required by `readNodeSpec`; the first
 * `.json` by name is the one seeded, and this directory holds exactly one.
 */
export function createLaneScratch(): LaneScratch {
  const root = mkdtempSync(join(tmpdir(), SCRATCH_PREFIX));
  const tag = basename(root).slice(SCRATCH_PREFIX.length).toLowerCase();
  const nodeSpecsDir = join(root, "node-specs");
  mkdirSync(nodeSpecsDir);
  const nodeRef = `node-e2e-${tag}`;
  writeFileSync(join(nodeSpecsDir, "node.json"), JSON.stringify({
    instructions: "The browser lane never runs this node; it only reads its step.",
    nodeRef,
    test: "node --eval \"process.exit(0)\"",
    title: "Daemon-backed browser lane node",
    workspace: root.replaceAll("\\", "/"),
  }), "utf8");
  return Object.freeze({
    nodeRef, nodeSpecsDir, projectId: `e2e-proj-${tag}`,
    root, storePath: join(root, "store.sqlite"), tag,
  });
}

/**
 * The daemon's environment. `MOE_APPROVAL_MODE`/`MOE_SPEED_MODE_DELAY_MS` are
 * daemon-side approval policy the seed cannot supply — the delay must be exactly
 * 0 or `approval.decide` answers APPROVAL_HUMAN_REVIEW_REQUIRED — and the daemon
 * needs the SAME spec directory as the seed or it publishes no `node.deliver`.
 */
export function daemonEnv(scratch: LaneScratch): Readonly<Record<string, string | undefined>> {
  return Object.freeze({
    ...process.env,
    MOE_APPROVAL_MODE: "SPEED",
    MOE_DAEMON_CREDENTIAL: LANE_CREDENTIAL,
    MOE_NODE_SPECS_DIR: scratch.nodeSpecsDir,
    MOE_PROJECT_ID: scratch.projectId,
    MOE_SPEED_MODE_DELAY_MS: "0",
    MOE_STORE_PATH: scratch.storePath,
  });
}

/** The seed reads four variables of its own and refuses each missing one by name. */
export function seedEnv(
  scratch: LaneScratch, daemonOrigin: string,
): Readonly<Record<string, string | undefined>> {
  return Object.freeze({
    ...daemonEnv(scratch),
    MOE_CSRF_TOKEN: LANE_CSRF_TOKEN,
    MOE_DAEMON_ORIGIN: daemonOrigin,
  });
}

/** Whether the served bundle carries live credentials at all. */
export type LiveCredentialMode = "ABSENT" | "ATTACHED";

export function serverEnv(
  daemonOrigin: string, mode: LiveCredentialMode,
): Readonly<Record<string, string | undefined>> {
  const attached = mode === "ATTACHED";
  return Object.freeze({
    ...process.env,
    MOE_DAEMON_ORIGIN: daemonOrigin,
    VITE_MOE_LIVE_CREDENTIAL: attached ? LANE_CREDENTIAL : "",
    VITE_MOE_LIVE_CSRF: attached ? LANE_CSRF_TOKEN : "",
  });
}

/**
 * The `x-moe-protocol-version` value the daemon's compatibility stage demands.
 *
 * Loaded from the generated client's own committed bridge rather than written
 * down here: a hand-copied version would drift into a second compatibility rule,
 * and the daemon answers a stale one with DISTRIBUTION_MISMATCH at stage
 * COMPATIBILITY. Loaded by URL, because this directory's tsconfig cannot reach
 * into `packages/` (TS6059) — the same way `apps/control-room/vite.config.ts`
 * reads the pins it injects.
 */
export async function readWireProtocolVersion(root: string): Promise<string | null> {
  const href = new URL(
    `file:///${join(root, "packages", "control-room-client", "src", "generated", "generated-client.js")
      .replaceAll("\\", "/")}`,
  ).href;
  let loaded: { readonly GENERATED_WIRE_PROTOCOL_VERSION?: unknown };
  try {
    loaded = await import(href) as { readonly GENERATED_WIRE_PROTOCOL_VERSION?: unknown };
  } catch {
    return null;
  }
  const version = loaded.GENERATED_WIRE_PROTOCOL_VERSION;
  return typeof version === "string" && version !== "" ? version : null;
}
