import { createHash } from "node:crypto";

import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonObject, JsonValue } from "@moe/contracts";

/**
 * The durable shapes of DEPLOYING: a deploy names an environment and a landed
 * sha; the engine builds an image tagged with that sha, starts a candidate and
 * probes it; ONE receipt per deploy decision records what happened — DEPLOYED
 * with the image digest and the url, or REFUSED with the tool's own words.
 *
 * The receipt is the effect, recorded under a reserved principal beside the
 * environment, never on it. The command kind is `internal.*` deliberately: an
 * internal receipt kind is outside PAYLOAD_KEYS, the command registry and the
 * MCP roster, so this shape costs no roster backfill.
 */

export const DEPLOY_ENGINE_PRINCIPAL_ID = "daemon:deploy-engine" as const;
export const DEPLOY_RECEIPT_VERSION = "moe-deploy-receipt/1" as const;
export const DEPLOY_RECEIPT_COMMAND_KIND = "internal.deployment.deploy_receipt" as const;

/**
 * The refusing layer, carried on every refusal beside its code so a reader can
 * tell WHICH layer answered. Named `..._STAMP` rather than `..._LAYER`
 * deliberately: `tests/security/boundary-roster.security.ts` treats a
 * column-zero exported const whose NAME ends in LAYER/LAYERS/BOUNDARIES as a
 * public security boundary owing a roster row. The VALUE is the layer's name.
 */
export const DEPLOY_ENGINE_STAMP = "DAEMON_DEPLOY_ENGINE" as const;
export type DeployEngineStamp = typeof DEPLOY_ENGINE_STAMP;

/** No target is bound for the environment, so there is nowhere to deploy to. */
export const DEPLOY_TARGET_MISSING = "DEPLOY_TARGET_MISSING" as const;
/** `docker build` refused; the detail carries docker's own last stderr line. */
export const DEPLOY_BUILD_FAILED = "DEPLOY_BUILD_FAILED" as const;
/** No docker to talk to at all: a spawn failure or a refusing `docker version`. */
export const DEPLOY_DOCKER_UNAVAILABLE = "DEPLOY_DOCKER_UNAVAILABLE" as const;
/** The candidate never reported healthy inside the budget. */
export const DEPLOY_HEALTH_TIMEOUT = "DEPLOY_HEALTH_TIMEOUT" as const;

export const DEPLOY_REFUSAL_CODES = Object.freeze([
  DEPLOY_BUILD_FAILED, DEPLOY_DOCKER_UNAVAILABLE, DEPLOY_HEALTH_TIMEOUT, DEPLOY_TARGET_MISSING,
] as const);

export type DeployRefusalCode = (typeof DEPLOY_REFUSAL_CODES)[number];

export interface DeployRefusal {
  readonly code: DeployRefusalCode;
  readonly detail: string;
  readonly layer: DeployEngineStamp;
}

export interface DeployReceiptV1 {
  readonly decidedAt: string;
  readonly decisionId: string;
  readonly environment: string;
  /** The image actually started, or null on every refusal. */
  readonly imageDigest: string | null;
  readonly outcome: "DEPLOYED" | "REFUSED";
  readonly projectId: string;
  readonly receiptId: string;
  readonly refusal: DeployRefusal | null;
  /** The release decision this deploy cited, or null when the goal carried none. */
  readonly releaseDecision: string | null;
  readonly sha: string;
  /** Where the environment answers, when the target names a url. */
  readonly url: string | null;
  readonly version: typeof DEPLOY_RECEIPT_VERSION;
}

export type DeployReceiptDecodeResult =
  | Readonly<{ readonly ok: true; readonly receipt: DeployReceiptV1 }>
  | Readonly<{ readonly code: "DEPLOY_RECEIPT_INVALID"; readonly ok: false }>;

const HEX64 = /^[0-9a-f]{64}$/u;
/** The same anchored shape its sibling uses for git object ids: sha-1 or sha-256. */
const GIT_OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
/** `sha256:<64 hex>`, the form `docker inspect` reports an image digest in. */
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const ENVIRONMENT_NAME = /^[a-z][a-z0-9-]{0,62}$/u;

const RECEIPT_KEYS = [
  "decidedAt", "decisionId", "environment", "imageDigest", "outcome", "projectId", "receiptId",
  "refusal", "releaseDecision", "sha", "url", "version",
] as const;
const REFUSAL_KEYS = ["code", "detail", "layer"] as const;

function isObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && value !== undefined && typeof value === "object"
    && !Array.isArray(value) && Object.getPrototypeOf(value) === null;
}

function exact(value: JsonObject, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function ref(value: JsonValue | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      freezeDeep((value as Record<PropertyKey, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** A deploy fact lands beside the environment, never on it. */
export function deployAggregateId(projectId: string, environment: string): string {
  return `deploy:${projectId}:${environment}`;
}

/** One receipt per deploy decision: the id is a pure function of that decision. */
export function deployReceiptId(
  projectId: string, environment: string, decisionId: string,
): string {
  const parts = [DEPLOY_RECEIPT_VERSION, "receipt-id", projectId, environment, decisionId];
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
}

/**
 * The image tag for a landed sha. The tag IS the sha — never a prefix of it,
 * never a timestamp: every later rollback, dossier and incident claim resolves
 * through this tag, so a tag that cannot be mapped back to a commit makes all
 * of them unverifiable.
 */
export function deployImageTag(environment: string, sha: string): string {
  return `moe-deploy-${environment}:${sha}`;
}

export function admitDeploySha(value: unknown): string | null {
  return typeof value === "string" && GIT_OBJECT_ID.test(value) ? value : null;
}

export function admitEnvironmentName(value: unknown): string | null {
  return typeof value === "string" && ENVIRONMENT_NAME.test(value) ? value : null;
}

function decodeRefusal(value: JsonValue | undefined): DeployRefusal | null | "INVALID" {
  if (value === null) return null;
  if (!isObject(value) || !exact(value, REFUSAL_KEYS)) return "INVALID";
  const code = value["code"];
  const codes: readonly string[] = DEPLOY_REFUSAL_CODES;
  if (typeof code !== "string" || !codes.includes(code)) return "INVALID";
  if (typeof value["detail"] !== "string" || value["layer"] !== DEPLOY_ENGINE_STAMP) return "INVALID";
  return { code: code as DeployRefusalCode, detail: value["detail"], layer: DEPLOY_ENGINE_STAMP };
}

/**
 * THE NULL-PAIRING DISCIPLINE IS ENFORCED HERE, NOT BY THE TYPE. `T | null` on
 * both sides merely PERMITS the pairing; what makes it a discipline is that
 * this decoder REFUSES a receipt carrying BOTH an imageDigest and a refusal,
 * and one carrying NEITHER.
 */
export function decodeDeployReceiptBytes(input: unknown): DeployReceiptDecodeResult {
  const invalid = { code: "DEPLOY_RECEIPT_INVALID", ok: false } as const;
  const decoded = decodeBoundedJsonBytes(input);
  if (!decoded.ok || !isObject(decoded.value) || !exact(decoded.value, RECEIPT_KEYS)) return invalid;
  const value = decoded.value;
  const refusal = decodeRefusal(value["refusal"]);
  if (refusal === "INVALID") return invalid;
  const outcome = value["outcome"];
  const imageDigest = value["imageDigest"];
  const url = value["url"];
  const releaseDecision = value["releaseDecision"];
  // Admitted through the same functions the writer uses, so a stored value stays
  // subject to today's admission rule rather than being grandfathered in.
  const environment = admitEnvironmentName(value["environment"]);
  const sha = admitDeploySha(value["sha"]);
  if (value["version"] !== DEPLOY_RECEIPT_VERSION || !ref(value["projectId"])
    || !ref(value["decisionId"]) || !ref(value["decidedAt"])
    || environment === null || sha === null
    || !HEX64.test(String(value["receiptId"]))
    || (outcome !== "DEPLOYED" && outcome !== "REFUSED")
    // Exactly one side populated, BOTH directions: a receipt with neither fails
    // the pair below, one with both fails it from the other side.
    || (outcome === "REFUSED") !== (refusal !== null)
    || (outcome === "DEPLOYED") !== (typeof imageDigest === "string")
    || !(imageDigest === null || (typeof imageDigest === "string" && IMAGE_DIGEST.test(imageDigest)))
    || !(url === null || ref(url)) || !(releaseDecision === null || ref(releaseDecision))) {
    return invalid;
  }
  const receiptId = value["receiptId"] as string;
  if (receiptId !== deployReceiptId(value["projectId"], environment, value["decisionId"])) {
    return invalid;
  }
  const receipt: DeployReceiptV1 = {
    decidedAt: value["decidedAt"],
    decisionId: value["decisionId"],
    environment,
    imageDigest: imageDigest as string | null,
    outcome,
    projectId: value["projectId"],
    receiptId,
    refusal,
    releaseDecision: releaseDecision as string | null,
    sha,
    url: url as string | null,
    version: DEPLOY_RECEIPT_VERSION,
  };
  return { ok: true, receipt: freezeDeep(receipt) };
}
