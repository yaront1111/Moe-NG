import { createHash, createPublicKey, verify } from "node:crypto";

import { distributionRefusal } from "../../packages/contracts/src/distribution/distribution-contract.js";
import type {
  DistributionRefusal,
} from "../../packages/contracts/src/distribution/distribution-contract.js";
import {
  decodeDistributionContainerBytes,
} from "../../packages/contracts/src/distribution/distribution-parser.js";
import {
  verifyDistributionSet,
} from "../../packages/contracts/src/distribution/distribution-verifier.js";
import type {
  ObservedDistributionComponent,
  StartupDistributionExpectation,
} from "../../packages/contracts/src/distribution/distribution-verifier.js";

/** SPKI DER prefix for a raw 32-byte Ed25519 public key. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface DistributionStartupInput {
  readonly containers: readonly Uint8Array[];
  readonly expectation: StartupDistributionExpectation;
  readonly trustedPublicKeys: Readonly<Record<string, string>>;
}

export type DistributionLaunchPort = (componentId: string) => void;

/**
 * The one refusal this module mints mid-loop. The port has no stop affordance, so a
 * throw on a later component cannot un-launch its predecessors; `launched` reports the
 * components the port had already completed so the caller can reconcile them.
 */
export interface DistributionLaunchFailure extends DistributionRefusal {
  readonly launched: readonly string[];
}

export type DistributionStartupResult =
  | { readonly launched: readonly string[]; readonly ok: true }
  | DistributionRefusal
  | DistributionLaunchFailure;

const refuse = (reason: Parameters<typeof distributionRefusal>[0]): DistributionRefusal =>
  distributionRefusal(reason, "DISTRIBUTION_STARTUP");

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Mirrors the packager's framing exactly; any drift here would reject every honest build. */
function aggregateDigestHex(entries: ReadonlyArray<readonly [string, string]>): string {
  const hash = createHash("sha256");
  for (const [path, digest] of [...entries].sort((l, r) => (l[0] < r[0] ? -1 : 1))) {
    hash.update(path);
    hash.update("\n");
    hash.update(digest);
    hash.update("\n");
  }
  return hash.digest("hex");
}

function verifyWithRawKey(rawHex: string, message: Uint8Array, signatureHex: string): boolean {
  const key = createPublicKey({
    format: "der",
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(rawHex, "hex")]),
    type: "spki",
  });
  return verify(null, message, key, Buffer.from(signatureHex, "hex"));
}

function isStartupInput(value: unknown): value is DistributionStartupInput {
  if (typeof value !== "object" || value === null) return false;
  const input = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(input);
  if (keys.length !== 3) return false;
  if (!Array.isArray(input["containers"])) return false;
  if (!input["containers"].every((entry) => entry instanceof Uint8Array)) return false;
  const trusted = input["trustedPublicKeys"];
  return typeof trusted === "object" && trusted !== null && !Array.isArray(trusted);
}

/**
 * The production startup choke point.
 *
 * Nothing launches until the WHOLE set is admitted: a per-component launch loop would
 * start a valid daemon beside a tampered control room, which is exactly the split state
 * a distribution gate exists to prevent. Every refusal BEFORE the launch loop leaves
 * the launch count at zero; a port that throws mid-loop fails closed and truthfully
 * reports the components already launched, because they cannot be unwound.
 */
export function startDistribution(
  input: unknown, launch: DistributionLaunchPort,
): DistributionStartupResult {
  if (!isStartupInput(input)) return refuse("EXPECTATION_INVALID");
  const observed: ObservedDistributionComponent[] = [];
  for (const bytes of input.containers) {
    const decoded = decodeDistributionContainerBytes(bytes, "DISTRIBUTION_STARTUP");
    if (!decoded.ok) return decoded;
    const { container } = decoded;
    if (!Object.hasOwn(input.trustedPublicKeys, container.manifest.signingKeyId)) {
      return refuse("SIGNING_KEY_UNTRUSTED");
    }
    const digests = Object.entries(container.assets)
      .map(([path, body]) => [path, sha256Hex(new Uint8Array(Buffer.from(body, "base64")))] as const);
    observed.push({
      container,
      recomputedAggregateDigest: aggregateDigestHex(digests),
      recomputedAssetDigests: Object.fromEntries(digests),
    });
  }
  const admission = verifyDistributionSet(observed, input.expectation, (request) => {
    const rawHex = input.trustedPublicKeys[request.keyId];
    if (rawHex === undefined) return false;
    return verifyWithRawKey(rawHex, request.message, request.signature);
  });
  if (!admission.ok) return admission;
  const launched: string[] = [];
  for (const componentId of admission.componentIds) {
    try {
      launch(componentId);
    } catch {
      return Object.freeze({
        ...refuse("LAUNCH_PORT_FAILED"), launched: Object.freeze([...launched]),
      });
    }
    launched.push(componentId);
  }
  return Object.freeze({ launched: Object.freeze(launched), ok: true as const });
}
