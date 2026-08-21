import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_GOAL_SUBJECT, DEFAULT_RUN_SUBJECT } from "../http/affordance-read.js";
import type { DemoNodeSpec } from "./demo-seed-plan.js";

/**
 * The seed's inputs: four operator variables and one node spec off disk.
 *
 * Every refusal names the EXACT variable an operator must set, and never its
 * value — the credential and the CSRF token pass through this module and are
 * never printed, not even masked, because a masked secret is still a secret
 * shape. Defaults exist only for identities the seed is free to mint (project,
 * goal and run ids); nothing that authenticates is ever defaulted.
 */

export const MOE_SEED_ENV_MISSING = "MOE_SEED_ENV_MISSING" as const;
export const MOE_SEED_ENV_INVALID = "MOE_SEED_ENV_INVALID" as const;
export const MOE_SEED_NODE_SPEC_INVALID = "MOE_SEED_NODE_SPEC_INVALID" as const;

export type SeedEnvCode =
  | typeof MOE_SEED_ENV_INVALID
  | typeof MOE_SEED_ENV_MISSING
  | typeof MOE_SEED_NODE_SPEC_INVALID;

export interface SeedEnvRefusal {
  readonly code: SeedEnvCode;
  readonly message: string;
  /** The exact variable or path an operator must fix — the whole remedy. */
  readonly subject: string;
}

export interface SeedConfig {
  readonly correlationId: string;
  readonly credential: string;
  readonly csrfToken: string;
  readonly goalId: string;
  readonly node: DemoNodeSpec;
  /** The daemon's own origin, sent verbatim as the Origin header. */
  readonly origin: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly runId: string;
  /**
   * `MOE_SEED_STOP_BEFORE_APPROVAL` (any non-empty value): end at
   * `plan.propose`, leaving the approval pending for the live board. The seed
   * carries the OPERATOR credential, so a chain it sends to the end is
   * approved by that same human authority — the only way to leave the decision
   * for a click on the board is to never send it here.
   */
  readonly stopBeforeApproval: boolean;
  /** The only reader the daemon registers at startup; see readSeedConfig. */
  readonly subscriberId: string;
}

export type SeedConfigResult =
  | { readonly config: SeedConfig; readonly ok: true }
  | { readonly ok: false; readonly refusals: readonly SeedEnvRefusal[] };

const REQUIRED = Object.freeze([
  "MOE_DAEMON_ORIGIN",
  "MOE_DAEMON_CREDENTIAL",
  "MOE_CSRF_TOKEN",
  "MOE_NODE_SPECS_DIR",
] as const);

type Env = Readonly<Record<string, string | undefined>>;

const missing = (subject: string): SeedEnvRefusal =>
  Object.freeze({
    code: MOE_SEED_ENV_MISSING,
    message: `${subject} is not set; the seed cannot invent it`,
    subject,
  });

const invalid = (subject: string, message: string): SeedEnvRefusal =>
  Object.freeze({ code: MOE_SEED_ENV_INVALID, message, subject });

const value = (env: Env, name: string): string => env[name] ?? "";

/** An origin, not a URL with a path: the guard compares the header byte for byte. */
function originRefusal(origin: string): SeedEnvRefusal | null {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return invalid("MOE_DAEMON_ORIGIN", "MOE_DAEMON_ORIGIN is not an absolute URL");
  }
  if (parsed.origin !== origin) {
    return invalid(
      "MOE_DAEMON_ORIGIN",
      `MOE_DAEMON_ORIGIN must be a bare origin; the daemon's Origin guard compares it exactly (got a URL whose origin is ${parsed.origin})`,
    );
  }
  return null;
}

function specFileNames(dir: string): readonly string[] | SeedEnvRefusal {
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return invalid("MOE_NODE_SPECS_DIR", `MOE_NODE_SPECS_DIR is not a readable directory: ${dir}`);
  }
  const specs = entries.filter((entry) => entry.endsWith(".json")).sort();
  if (specs.length === 0) {
    return invalid("MOE_NODE_SPECS_DIR", `MOE_NODE_SPECS_DIR holds no .json node spec: ${dir}`);
  }
  return specs;
}

const SPEC_FIELDS = Object.freeze(["instructions", "nodeRef", "test", "title", "workspace"] as const);

/** Reads the FIRST spec by name: one demo node is the whole scope of this seed. */
export function readNodeSpec(dir: string): DemoNodeSpec | SeedEnvRefusal {
  const names = specFileNames(dir);
  if (!Array.isArray(names)) return names as SeedEnvRefusal;
  const path = join(dir, (names as readonly string[])[0] as string);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return Object.freeze({
      code: MOE_SEED_NODE_SPEC_INVALID,
      message: `the node spec is unreadable or not JSON: ${path}`,
      subject: path,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return Object.freeze({
      code: MOE_SEED_NODE_SPEC_INVALID,
      message: `the node spec is not a JSON object: ${path}`,
      subject: path,
    });
  }
  const draft = parsed as Record<string, unknown>;
  const absent = SPEC_FIELDS.filter((field) => typeof draft[field] !== "string" || draft[field] === "");
  if (absent.length > 0) {
    return Object.freeze({
      code: MOE_SEED_NODE_SPEC_INVALID,
      message: `the node spec is missing string fields ${absent.join(",")}: ${path}`,
      subject: path,
    });
  }
  return Object.freeze({
    instructions: String(draft["instructions"]),
    nodeRef: String(draft["nodeRef"]),
    test: String(draft["test"]),
    title: String(draft["title"]),
    workspace: String(draft["workspace"]),
  });
}

const isRefusal = (candidate: DemoNodeSpec | SeedEnvRefusal): candidate is SeedEnvRefusal =>
  "code" in candidate;

/**
 * `MOE_EVENT_SUBSCRIBER` defaults to `control-room-1` because that is the ONLY
 * subscriber the daemon registers at startup (daemon-store-dependencies.ts:130,138);
 * any other id reads back `SUBSCRIPTION_NOT_REGISTERED`, and this seed has no
 * route to register one — the HTTP surface serves six routes and none of them
 * seats a reader.
 */
export function readSeedConfig(env: Env): SeedConfigResult {
  const refusals: SeedEnvRefusal[] = REQUIRED.filter((name) => value(env, name) === "").map(missing);
  const origin = value(env, "MOE_DAEMON_ORIGIN");
  if (origin !== "") {
    const refusal = originRefusal(origin);
    if (refusal !== null) refusals.push(refusal);
  }
  const specsDir = value(env, "MOE_NODE_SPECS_DIR");
  const node = specsDir === "" ? null : readNodeSpec(specsDir);
  if (node !== null && isRefusal(node)) refusals.push(node);
  if (refusals.length > 0 || node === null || isRefusal(node)) {
    return Object.freeze({ ok: false, refusals: Object.freeze(refusals) });
  }
  const projectId = value(env, "MOE_PROJECT_ID") || "demo-project";
  return Object.freeze({
    config: Object.freeze({
      correlationId: value(env, "MOE_SEED_CORRELATION_ID") || `${projectId}-seed`,
      credential: value(env, "MOE_DAEMON_CREDENTIAL"),
      csrfToken: value(env, "MOE_CSRF_TOKEN"),
      // The dev-subject convention, not a free choice: the affordance surface
      // offers approval.decide/goal.close against exactly these ids and the
      // control room's dev payloads address them. A seed that committed under
      // `${projectId}-run` left the board's Dispatch answering a misleading
      // refusal, because the run it named durably did not exist.
      goalId: value(env, "MOE_GOAL_ID") || DEFAULT_GOAL_SUBJECT,
      node,
      origin,
      principalId: value(env, "MOE_PRINCIPAL_ID") || `${projectId}-operator`,
      projectId,
      runId: value(env, "MOE_RUN_ID") || DEFAULT_RUN_SUBJECT,
      stopBeforeApproval: value(env, "MOE_SEED_STOP_BEFORE_APPROVAL") !== "",
      subscriberId: value(env, "MOE_EVENT_SUBSCRIBER") || "control-room-1",
    }),
    ok: true,
  });
}
