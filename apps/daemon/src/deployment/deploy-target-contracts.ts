import type { JsonObject, JsonValue } from "@moe/contracts";

import { admitEnvironmentName } from "./deploy-receipt-contracts.js";
import type { DeployTarget } from "./deploy-ports.js";

/**
 * WHERE AN ENVIRONMENT DEPLOYS TO, as durable bytes.
 *
 * `deploy-ports.ts` declares `DeployTargetPort` and states that the target is
 * "WRITTEN by `deployment.set_target`; only read here" — this module is that
 * write. It holds the two command kinds' vocabulary, the admission rules for an
 * operator-typed target, and the aggregate the binding lands on. No store, no
 * spawn, no clock: total functions and data only.
 *
 * ADMISSION IS A SECURITY BOUNDARY, NOT TIDINESS. Every field here is
 * operator-typed text that ends up in an argv (`--network <network>`,
 * `ssh <sshTarget> docker ...`) or on a receipt that a screen renders. The
 * engine spawns with `shell: false`, so a metacharacter cannot re-parse into a
 * second command — but an unadmitted value would still reach a remote host, and
 * a url carrying `user:password@` would put a credential on every receipt this
 * environment ever writes. Both are refused below.
 */

export const DEPLOYMENT_SET_TARGET_COMMAND_KIND = "deployment.set_target" as const;
export const DEPLOYMENT_DEPLOY_COMMAND_KIND = "deployment.deploy" as const;

/** `sshTarget` and `url` are REQUIRED KEYS carrying `null`, never omitted ones: the ingress
 *  allow-list refuses an unlisted key, and "local target" must be sayable rather than implied
 *  by an absence a caller could also produce by mistake. */
export const DEPLOYMENT_SET_TARGET_PAYLOAD_KEYS: readonly string[] = Object.freeze([
  "environment", "network", "sshTarget", "url",
]);

/** No build CONTEXT on the wire. The directory docker builds is host-scoped daemon
 *  configuration read at the composition root; a caller-supplied path would let any
 *  operator-authenticated request build an arbitrary directory on the daemon's host. */
export const DEPLOYMENT_DEPLOY_PAYLOAD_KEYS: readonly string[] = Object.freeze([
  "environment", "sha",
]);

export const DEPLOY_TARGET_BOUND_EVENT = "EnvironmentDeployTargetBound" as const;

/** The operator's target did not admit. INGRESS, because they typed it. */
export const DEPLOY_TARGET_INVALID = "DEPLOY_TARGET_INVALID" as const;
/** The deploy names an environment no `deployment.set_target` has bound yet. */
export const DEPLOY_ENVIRONMENT_UNBOUND = "DEPLOY_ENVIRONMENT_UNBOUND" as const;

/** A docker network name, as docker itself accepts it. */
const NETWORK_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/u;
/** `[user@]host[:port]`. No whitespace, no shell metacharacter, no option-looking leading dash. */
const SSH_TARGET = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,63}(?:@[a-zA-Z0-9][a-zA-Z0-9._-]{0,253})?$/u;
const MAX_URL = 512;

/**
 * The environment's public url. HTTP(S) ONLY, and NO USERINFO — `admitDeployUrl`
 * refuses `https://user:secret@host` outright rather than stripping it, because
 * this url is copied verbatim onto every deploy receipt and rendered on the
 * environment screen. Stripping would silently change where the operator
 * believes the environment answers; refusing tells them.
 */
export function admitDeployUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  return value;
}

export function admitDeployNetwork(value: unknown): string | null {
  return typeof value === "string" && NETWORK_NAME.test(value) ? value : null;
}

export function admitSshTarget(value: unknown): string | null {
  return typeof value === "string" && SSH_TARGET.test(value) ? value : null;
}

/** A deploy target binding lands beside the environment, on its own aggregate. */
export function deployTargetAggregateId(projectId: string, environment: string): string {
  return `deploy-target:${projectId}:${environment}`;
}

export interface AdmittedDeployTarget {
  readonly environment: string;
  readonly target: DeployTarget;
}

/**
 * The whole `deployment.set_target` payload, admitted as one unit.
 *
 * `sshTarget` and `url` are each nullable and each admitted when present, so a
 * local target (`sshTarget: null`) and a target with no public url
 * (`url: null`) are both expressible without a second command shape.
 */
export function admitDeployTargetPayload(payload: JsonObject): AdmittedDeployTarget | null {
  const environment = admitEnvironmentName(payload["environment"]);
  const network = admitDeployNetwork(payload["network"]);
  if (environment === null || network === null) return null;
  const rawSsh = payload["sshTarget"];
  const rawUrl = payload["url"];
  const sshTarget = rawSsh === null ? null : admitSshTarget(rawSsh);
  const url = rawUrl === null ? null : admitDeployUrl(rawUrl);
  if ((rawSsh !== null && sshTarget === null) || (rawUrl !== null && url === null)) return null;
  return { environment, target: Object.freeze({ network, sshTarget, url }) };
}

/**
 * A stored binding, read back under TODAY'S admission rules rather than
 * grandfathered in — the same discipline `decodeDeployReceiptBytes` applies to a
 * stored receipt. A binding written before a rule tightened is refused, not
 * honoured.
 */
export function decodeDeployTarget(value: JsonValue | undefined): DeployTarget | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, JsonValue | undefined>;
  const network = admitDeployNetwork(record["network"]);
  if (network === null) return null;
  const rawSsh = record["sshTarget"] ?? null;
  const rawUrl = record["url"] ?? null;
  const sshTarget = rawSsh === null ? null : admitSshTarget(rawSsh);
  const url = rawUrl === null ? null : admitDeployUrl(rawUrl);
  if ((rawSsh !== null && sshTarget === null) || (rawUrl !== null && url === null)) return null;
  return Object.freeze({ network, sshTarget, url });
}
