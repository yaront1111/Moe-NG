/**
 * ACTIVATION, the read: which of the six activation receipts this project can show RIGHT NOW,
 * each measured or missing with the daemon's own reason, so the Activate card can render
 * before anything is clicked. The measuring is `bootstrap/activation-receipts-measure.ts`;
 * this module is the transport edge — authenticate, check the capability, measure, answer.
 *
 * THIS ROUTE NEVER WRITES. `measureBackup` takes a real `node:sqlite` online backup and
 * creates `<projectRoot>/.moe-next/backups/` on the way, so a card polling this path every
 * two seconds would fill that directory. `readOnlyActivationPorts` neuters both writes and
 * the backup member is then reported under this route's OWN layer as DEFERRED — an honest
 * "not taken by a read", never a fabricated ref or digest for a file that does not exist.
 *
 * The layer constant is module-private and spelled `LAYER`, exactly as `policy-read.ts` and
 * `runs-read-contract.ts` spell theirs: the security lane's private-boundary scan keys on
 * `*_LAYER` names, so this costs no roster backfill.
 */
import { decodeBoundedJsonBytes } from "@moe/contracts";

import type {
  ActivationReceiptMember, ActivationReceipts,
} from "../bootstrap/activation-receipts.js";
import {
  measureActivationReceipts, nodeActivationReceiptPorts,
} from "../bootstrap/activation-receipts-measure.js";
import type {
  ActivationReceiptInput, ActivationReceiptPorts,
} from "../bootstrap/activation-receipts-measure.js";
import { providerCredentials, providerFor } from "../orchestrator/moe-up-credentials.js";
import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import { authenticateHttpRequest } from "./http-command-ingress.js";
import type { Authenticator, HttpPortRefused, HttpRefused } from "./http-contract.js";

export const ACTIVATION_READ_PATH = "/activation/read" as const;
const LAYER = "ACTIVATION_READ" as const;

export const ACTIVATION_READ_CODES = Object.freeze([
  "ACTIVATION_READ_CAPABILITY_DENIED", "ACTIVATION_READ_PROJECT_MISMATCH", "ACTIVATION_READ_UNREADABLE",
] as const);

/** Not a failure: nothing was attempted, because attempting it would WRITE. */
export const ACTIVATION_READ_BACKUP_DEFERRED = "ACTIVATION_READ_BACKUP_DEFERRED" as const;
export const ACTIVATION_READ_BACKUP_REASON =
  "not taken by a read: the store backup is written when project.activate runs";

/**
 * One receipt as the card renders it. `reason` is the daemon's own text, verbatim but for
 * credential-value scrubbing. `code` and `layer` name the stable refusal and the boundary
 * that answered it, both null when the member is measured. `hash` carries the 64-hex digest
 * of the two members core validates as digests.
 */
export interface ActivationReceiptRow {
  readonly code: string | null; readonly hash: string | null; readonly layer: string | null;
  readonly measured: boolean; readonly member: ActivationReceiptMember;
  readonly reason: string; readonly ref: string | null;
}

/**
 * Signing is required by core's exact nine-key roster but is NOT a trust boundary in v0.1
 * (owner decision, 2026-09-04). Minted, never measured, and carrying `trustBoundary: false`
 * so no card can render it as a measured receipt.
 */
export interface ActivationSigningRow {
  readonly measured: false; readonly member: "signing";
  readonly reason: ActivationReceipts["signing"]["reason"];
  readonly ref: ActivationReceipts["signing"]["ref"];
  readonly trustBoundary: false;
}

export interface ActivationView {
  /**
   * The members a READ can measure that are still missing, in card order. Backup is never
   * here: it is deferred, not absent, and only `project.activate` settles it — so an empty
   * list means "nothing a read can see is blocking", NOT "activation will succeed".
   */
  readonly blocking: readonly ActivationReceiptMember[];
  readonly distribution: ActivationReceipts["distribution"];
  readonly measuredAt: string;
  readonly members: readonly ActivationReceiptRow[];
  readonly outcome: "ACTIVATION";
  /**
   * The agent CLI version THIS DAEMON read, or null when the provider member is
   * unmeasured. Published rather than kept internal because a value the daemon
   * measures and never shows is a value nobody can check: the card renders it, and
   * `UNKNOWN` on the screen is the honest answer an operator can act on.
   */
  readonly provider: ActivationReceipts["provider"];
  readonly repository: ActivationReceipts["repository"];
  readonly schemaVersion: ActivationReceipts["schemaVersion"];
  readonly signing: ActivationSigningRow; readonly store: ActivationReceipts["store"];
}

export interface ActivationRefused {
  readonly code: string; readonly layer: string; readonly outcome: "REFUSED";
}
export type ActivationReadResult = ActivationRefused | ActivationView;

export interface ActivationReadPort {
  readonly boundProjectId: string; readActivation(): Promise<ActivationReadResult>;
}

const refused = (code: string): ActivationRefused => Object.freeze({ code, layer: LAYER, outcome: "REFUSED" as const });

/**
 * The production bundle with both writes removed. `fs.exists`, `fs.stat` and `fs.readBytes`
 * stay REAL — store, distribution and credential are measured through them — and only
 * `mkdir` is neutered, so a read creates nothing.
 */
export function readOnlyActivationPorts(
  overrides: Partial<ActivationReceiptPorts> = {},
): ActivationReceiptPorts {
  const base = nodeActivationReceiptPorts(overrides);
  return Object.freeze({ ...base,
    backup: () => Promise.resolve({ detail: ACTIVATION_READ_BACKUP_REASON, ok: false as const }),
    // A read never creates a directory in the operator's project.
    fs: Object.freeze({ ...base.fs, mkdir: () => undefined }),
  });
}

const REDACTED = "[redacted]";

/**
 * Every credential VALUE this daemon holds for the configured agent. A `reason` is whatever
 * the measurement OBSERVED — a git stderr tail, an OS error string — so a git remote or a
 * host echoing its environment can carry a token into one. This response is rendered onto an
 * operator's screen and into e2e screenshots, so values are scrubbed at the boundary that
 * PUBLISHES rather than trusted never to appear. MEASURED, not hypothetical: a git stderr of
 * `fatal: env ANTHROPIC_AUTH_TOKEN=<token>` reached the wire verbatim before this fence.
 */
function secretValues(
  input: ActivationReceiptInput, ports: ActivationReceiptPorts,
): readonly string[] {
  const provider = providerFor(input.agentCommand);
  if (provider === undefined) return [];
  const entries = providerCredentials(provider, ports.env, (path) => ports.fs.exists(path));
  return (entries ?? []).filter((e) => e.secret && e.value !== "").map((e) => e.value);
}

const scrub = (text: string, secrets: readonly string[]): string =>
  secrets.reduce((carry, secret) => carry.replaceAll(secret, REDACTED), text);

const signingRow = (receipts: ActivationReceipts): ActivationSigningRow => Object.freeze({
  measured: false as const, member: "signing" as const, reason: receipts.signing.reason,
  ref: receipts.signing.ref, trustBoundary: false as const,
});

/** The backup's read-time answer, under THIS route's layer: this route deferred it. */
const deferredBackupRow = (): ActivationReceiptRow => Object.freeze({
  code: ACTIVATION_READ_BACKUP_DEFERRED, hash: null, layer: LAYER, measured: false,
  member: "backup" as const, reason: ACTIVATION_READ_BACKUP_REASON, ref: null,
});

function receiptRow(
  receipt: ActivationReceipts["members"][number], secrets: readonly string[],
): ActivationReceiptRow {
  if (receipt.member === "backup") return deferredBackupRow();
  if (receipt.measured) {
    return Object.freeze({
      code: null, hash: receipt.hash ?? null, layer: null, measured: true,
      member: receipt.member, reason: scrub(receipt.detail, secrets),
      ref: scrub(receipt.ref, secrets),
    });
  }
  return Object.freeze({
    code: receipt.code, hash: null, layer: receipt.layer, measured: false,
    member: receipt.member, reason: scrub(receipt.detail, secrets), ref: null,
  });
}

/**
 * The reading, or null. Bound to the PROVIDER MEMBER's own verdict rather than
 * published on its own: receipts reaching this function are not necessarily the
 * ones this daemon measured, and a version rendered beside a refused provider would
 * read as a measurement that stood. Scrubbed like every other published text —
 * `command` is host configuration and the version is an external CLI's stdout.
 */
function providerReading(
  receipts: ActivationReceipts, secrets: readonly string[],
): ActivationReceipts["provider"] {
  const reading = receipts.provider;
  const member = receipts.members.find((receipt) => receipt.member === "provider");
  if (reading === null || member === undefined || !member.measured) return null;
  return Object.freeze({
    command: scrub(reading.command, secrets), version: scrub(reading.version, secrets),
  });
}

export function activationViewOf(
  receipts: ActivationReceipts, secrets: readonly string[] = [],
): ActivationView {
  const members = receipts.members.map((receipt) => receiptRow(receipt, secrets));
  const blocking = members
    .filter((row) => !row.measured && row.code !== ACTIVATION_READ_BACKUP_DEFERRED)
    .map((row) => row.member);
  return Object.freeze({
    blocking: Object.freeze(blocking),
    distribution: receipts.distribution,
    measuredAt: receipts.measuredAt,
    members: Object.freeze(members),
    outcome: "ACTIVATION" as const,
    provider: providerReading(receipts, secrets),
    repository: receipts.repository,
    schemaVersion: receipts.schemaVersion,
    signing: signingRow(receipts),
    store: receipts.store,
  });
}

export function createActivationReadPort(options: {
  readonly input: ActivationReceiptInput;
  readonly measure?: (
    input: ActivationReceiptInput, ports: ActivationReceiptPorts,
  ) => Promise<ActivationReceipts>;
  readonly ports?: Partial<ActivationReceiptPorts>;
}): ActivationReadPort {
  const measure = options.measure ?? measureActivationReceipts;
  const ports = readOnlyActivationPorts(options.ports ?? {});

  const readActivation = async (): Promise<ActivationReadResult> => {
    try {
      return activationViewOf(
        await measure(options.input, ports), secretValues(options.input, ports),
      );
    } catch {
      // A measurement that throws must become a coded refusal, never a 500 with a stack.
      return refused("ACTIVATION_READ_UNREADABLE");
    }
  };
  return Object.freeze({ boundProjectId: options.input.projectId, readActivation });
}

export type ActivationReadDispatch =
  | {
    readonly body: ActivationReadResult | HttpPortRefused | HttpRefused;
    readonly httpStatus: number; readonly kind: "REPLY";
  }
  | {
    readonly code: "LISTENER_ACTIVATION_REQUEST_INVALID" | "LISTENER_ACTIVATION_UNAVAILABLE";
    readonly kind: "LISTENER_REFUSAL"; };

interface ActivationReadRequest {
  readonly body: unknown; readonly credential: string | null; readonly protocolVersion: unknown;
}

/** The body must be empty or exactly `{}`: this read takes no operand a caller could shape. */
function emptyBody(body: unknown): boolean {
  if (body instanceof Uint8Array && body.length === 0) return true;
  const decoded = decodeBoundedJsonBytes(body);
  if (!decoded.ok) return false;
  const value = decoded.value;
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === 0;
}

export async function handleActivationReadRequest(
  dependencies: {
    readonly activation?: ActivationReadPort | undefined; readonly authenticator: Authenticator;
  },
  request: ActivationReadRequest,
): Promise<ActivationReadDispatch> {
  const access = authenticateHttpRequest(
    dependencies.authenticator, request.credential, request.protocolVersion,
  );
  if (!access.ok) return Object.freeze({ body: access, httpStatus: access.httpStatus, kind: "REPLY" });
  if (!access.principal.capabilities.includes(CAPABILITIES.ADMIN)) {
    return Object.freeze({ body: refused("ACTIVATION_READ_CAPABILITY_DENIED"), httpStatus: 200, kind: "REPLY" });
  }
  const port = dependencies.activation;
  if (port === undefined) return Object.freeze({ code: "LISTENER_ACTIVATION_UNAVAILABLE", kind: "LISTENER_REFUSAL" });
  if (access.principal.projectId !== port.boundProjectId) {
    return Object.freeze({ body: refused("ACTIVATION_READ_PROJECT_MISMATCH"), httpStatus: 200, kind: "REPLY" });
  }
  if (!emptyBody(request.body)) {
    return Object.freeze({ code: "LISTENER_ACTIVATION_REQUEST_INVALID", kind: "LISTENER_REFUSAL" });
  }
  return Object.freeze({ body: await port.readActivation(), httpStatus: 200, kind: "REPLY" });
}
