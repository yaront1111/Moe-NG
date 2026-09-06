import { readFileSync, writeFileSync } from "node:fs";

import type { SqliteEventStore } from "@moe/store";

import { requiredVariableNames } from "../environment/environment-required-variables.js";
import { DomainRefusal } from "../daemon-command-dispatch.js";
import type { AsyncCommandHandler } from "../http/http-async-contract.js";
import type { CommandHandlerInput, DurableDecision } from "../http/http-contract.js";
import { resolveProductContractGate1V2 }
  from "../product-contract/product-contract-v2-gate-1-resolver.js";
import { readCurrentProductContractRevisionV2 }
  from "../product-contract/product-contract-v2-reader.js";
import { sameProductContractV2WorkflowRef }
  from "../product-contract/product-contract-v2-workflow-contract.js";
import { readProductContractV2WorkflowHead }
  from "../product-contract/product-contract-v2-workflow-reader.js";
import {
  decodeFoundationRepositoryScopeCatalog,
  readCurrentFoundationRepositoryScopeRequest,
  resolveFoundationRepositoryScope,
} from "../work/foundation-repository-scope-authority.js";
import { envExampleSyncRefusal } from "./env-example-sync-contracts.js";
import type { EnvExampleSyncCode, EnvExampleSyncRefusalFor }
  from "./env-example-sync-contracts.js";
import { envExampleBytes } from "./controlled-profile/controlled-profile-root-templates.js";
import { LANDER_IDENTITY, nodeGitRunner } from "./git-landing-port.js";

/**
 * THE COMMAND EDGE FOR `product_contract.sync_env_example`: the one place the APPROVED product
 * contract's required variable names reach the committed `.env.example` of the bound repository.
 *
 * ASYNC BY FORCE, NOT CHOICE. `CommandHandler` is synchronous (http-contract.ts:197) while this
 * writes a file and spawns `git`; `preview.start` and `repository.bootstrap` hit the same wall,
 * and this module is their twin, including living in its own file.
 *
 * IT DECIDES NOTHING THE LANDED PIECES ALREADY DECIDE, which is the whole point of the row.
 * `requiredVariableNames` (environment-required-variables.ts:90) is the ONE producer of the
 * names; `envExampleBytes` is the ONE producer of the bytes — dedupe, grammar filter,
 * profile-collision subtraction and sort included; `resolveProductContractGate1V2` is the ONE
 * approval authority; the foundation repository scope authority is the ONE thing allowed to say
 * where a project's repository lives. No second list of names exists anywhere.
 *
 * `readCurrentProductContractRevisionV2` ALONE IS NOT APPROVAL — it proves the current slot and
 * its provenance, never the human grant, so calling its result "approved" would write an
 * UNAPPROVED or superseded revision's names into a file that is committed and pushed. The
 * composition below is copied from `delivery-v2/resolution-selection-reader.ts`.
 *
 * NAMES ONLY, NEVER VALUES: `envExampleBytes` emits `NAME=` with nothing after the `=`, and this
 * module hands it names and nothing else. No value is read from anywhere on this path. The file
 * is committed to a product repository, so a value here is a secret published.
 *
 * REPLAY IS SAFE BY CONSTRUCTION, which is why the kind is deliberately NOT bootstrap-family and
 * carries no durable replay fence. A second identical request regenerates identical bytes, finds
 * the target clean against HEAD and makes NO second commit — the no-change success below. Both
 * preconditions are runtime facts read fresh at (3) and (5) and refused there with stable codes,
 * which serves a per-project fact better than a static prerequisite table could.
 */

/** The one file this command may touch. Repository-relative, never caller-supplied. */
const ENV_EXAMPLE_NAME = ".env.example" as const;
/** A commit landed the approved contract's names. */
export const ENV_EXAMPLE_SYNCED_RESULT_CODE = "ENV_EXAMPLE_SYNCED" as const;
/** The committed file already held exactly these names. A SUCCESS, and the common case. */
export const ENV_EXAMPLE_UNCHANGED_RESULT_CODE = "ENV_EXAMPLE_UNCHANGED" as const;

/** No variable name, no path, no value, no product name — only what the contract sync is. */
const COMMIT_MESSAGE = "chore: sync .env.example with the approved product contract";

/** A source CODE may travel in `detail`; a source MESSAGE may not. Every code the composed
 *  authorities mint is a compile-time SCREAMING_SNAKE literal, so this admits all of them and
 *  nothing else: it cannot carry a filesystem path (no separator, dot or drive colon), a git
 *  stderr line (no lowercase, no space) or a secret value — the detail union stays closed. */
const SOURCE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;

function detailOf(source: unknown): string | null {
  return typeof source === "string" && SOURCE_CODE.test(source) ? source : null;
}

export interface EnvExampleSyncOptions {
  /** The daemon-startup workspace catalog, the SAME source the capture lifecycle reads, so this
   *  command resolves the identical repository scope authority rather than a second view of it. */
  readonly catalogSource: () => unknown;
  /** The configured operator principal. THE ASYNC ENTRY MUST FENCE ITSELF: `entryOf` returns
   *  the async entry BEFORE the synchronous operator check, so `OPERATOR_PRINCIPAL_KINDS`
   *  membership alone leaves the kind dispatchable by any GOAL-capable session. Measured. */
  readonly operatorPrincipalId: string;
  readonly projectId: string;
  readonly store: SqliteEventStore;
}

function refuse<C extends EnvExampleSyncCode>(code: C, source?: unknown): never {
  // Generic over the CODE so the producer's per-code correlated refusal type survives.
  const refusal: EnvExampleSyncRefusalFor<C> = envExampleSyncRefusal(code, detailOf(source));
  throw new DomainRefusal(refusal.code, refusal.layer,
    refusal.detail === null
      ? `product_contract.sync_env_example refused: ${refusal.code}`
      : `product_contract.sync_env_example refused: ${refusal.code} (${refusal.detail})`,
    422);
}

/** The APPROVED revision, or a refusal. Copied from `resolution-selection-reader.ts`: current,
 *  then the ref triple built FROM it, then Gate 1 against that ref, then the workflow head.
 *  `projectId` is the authenticated project throughout and is never read from a payload. */
type ApprovedRead = Extract<
  ReturnType<typeof readCurrentProductContractRevisionV2>, { readonly ok: true }
>;

function approvedRevision(
  store: SqliteEventStore, contractId: string, projectId: string,
): ApprovedRead {
  const current = readCurrentProductContractRevisionV2(store, { contractId, projectId });
  if (!current.ok) refuse("ENV_EXAMPLE_CONTRACT_UNAPPROVED", current.code);
  const ref = Object.freeze({
    contractId: current.revision.contractId,
    revisionDigest: current.revision.revisionDigest,
    revisionId: current.revision.revisionId,
  });
  const gate = resolveProductContractGate1V2(store, { projectId, ref });
  if (!gate.ok) refuse("ENV_EXAMPLE_CONTRACT_UNAPPROVED", gate.code);
  const workflow = readProductContractV2WorkflowHead(store, { contractId, projectId });
  if (!workflow.ok) refuse("ENV_EXAMPLE_CONTRACT_UNAPPROVED", workflow.code);
  if (current.revision.contractId !== contractId
    || current.slot.projectId !== projectId
    || workflow.head.clarificationStatus !== "SATISFIED"
    || !sameProductContractV2WorkflowRef(workflow.head.currentRevision,
      current.slot.currentRevision)
    || !sameProductContractV2WorkflowRef(workflow.head.effectiveGateRef,
      current.slot.currentRevision)
    || workflow.head.currentSlotDigest !== current.slot.slotDigest
    || workflow.head.currentSlotGeneration !== current.slot.generation) {
    refuse("ENV_EXAMPLE_CONTRACT_UNAPPROVED", "PRODUCT_CONTRACT_V2_CONTRACT_STALE");
  }
  return current;
}

/**
 * The bound repository's host root, through the server-owned authority and nothing else. The
 * `repositoryRef` string is NEVER parsed here: that module says of itself it is the only thing
 * allowed to read the host mapping, and it re-fences its answer with `isHostRoot` at the RETURN.
 * A project-state refusal is the PROJECT REDUCER saying there is no binding; a catalog or
 * resolution refusal is the WORKSPACE saying the checkout could not be read.
 */
function boundRepositoryRoot(options: EnvExampleSyncOptions): string {
  const current = readCurrentFoundationRepositoryScopeRequest(options.store, options.projectId);
  if (!current.ok) refuse("ENV_EXAMPLE_REPOSITORY_UNBOUND", current.code);
  let configured: unknown;
  try { configured = options.catalogSource(); } catch {
    refuse("ENV_EXAMPLE_REPOSITORY_UNREADABLE", "FOUNDATION_CATALOG_CONFIG_UNREADABLE");
  }
  if (configured === undefined) {
    refuse("ENV_EXAMPLE_REPOSITORY_UNREADABLE", "FOUNDATION_CATALOG_CONFIG_ABSENT");
  }
  const decoded = decodeFoundationRepositoryScopeCatalog(configured);
  if (!decoded.ok) refuse("ENV_EXAMPLE_REPOSITORY_UNREADABLE", decoded.code);
  const resolved = resolveFoundationRepositoryScope(
    options.store, decoded.catalog, current.request,
  );
  if (!resolved.ok) refuse("ENV_EXAMPLE_REPOSITORY_UNREADABLE", resolved.code);
  return resolved.authority.sourceRepositoryRoot;
}

/** Serve one `product_contract.sync_env_example`. Each gate names itself. */
export function createEnvExampleSyncHandler(
  options: EnvExampleSyncOptions,
): AsyncCommandHandler {
  const { projectId, store } = options;
  return async ({ envelope, principal }: CommandHandlerInput): Promise<DurableDecision> => {
    // (1) FENCED AT ENTRY, before the decode and before any effect. Writing into and committing
    // in the operator's own repository is their act, never widened to a paired browser human.
    if (principal.principalId !== options.operatorPrincipalId) {
      throw new DomainRefusal("OPERATOR_PRINCIPAL_REQUIRED", "DAEMON_AUTHORIZATION",
        "this command requires the configured operator principal", 403);
    }
    // (2) The ingress already refused any key outside the roster (`checkPayload`,
    // http-command-ingress.ts:162), so only the TYPE is left. A non-string names no contract
    // and is answered by the reader's slot-absent code at (3), not a fifth code minted here.
    const contractId = typeof envelope.payload["contractId"] === "string"
      ? envelope.payload["contractId"] : "";

    // (3) THE APPROVAL, not the current revision.
    const current = approvedRevision(store, contractId, projectId);

    // (4) The ONE producer of the names, over the revision the gate just validated.
    const names = requiredVariableNames(current.revision);

    // (5) The ONE authority over where this project's repository lives.
    const root = boundRepositoryRoot(options);

    // (6)+(7) Write the scaffold's own bytes, then land them narrowly.
    const effectId = await syncEnvExampleFile(root, envExampleBytes(names));
    return Object.freeze({
      commandId: envelope.commandId,
      disposition: "DECIDED" as const,
      effectId: effectId.commit,
      resultCode: effectId.changed
        ? ENV_EXAMPLE_SYNCED_RESULT_CODE : ENV_EXAMPLE_UNCHANGED_RESULT_CODE,
    });
  };
}

/**
 * Write `.env.example` and land it, touching NOTHING else in the operator's repository.
 *
 * TWO SEPARATE HAZARDS, BOTH GUARDED. `git add -A` sweeps the WORKTREE — right for a directory
 * the daemon just created, wrong for one the operator owns. A BARE `git commit` sweeps the
 * INDEX: staging one path narrowly does NOT make the commit narrow, because a pathspec-less
 * commit lands everything ALREADY staged, so an operator with pre-staged work would find it
 * committed under Moe's authorship line. `--only` is what makes the COMMIT narrow, and it
 * leaves every other staged entry staged and every other dirty file dirty.
 *
 * NOTHING TO COMMIT IS A SUCCESS, decided by whether the TARGET PATH actually differs — never
 * by matching git's message text, which varies with locale and version. Every spawn is
 * `execFile` with `shell: false` and an argv ARRAY; no path reaches a command line.
 */
async function syncEnvExampleFile(
  root: string, bytes: string,
): Promise<{ readonly changed: boolean; readonly commit: string | null }> {
  const name = ENV_EXAMPLE_NAME;
  // Probe BEFORE writing: a non-repository must refuse without first leaving a file behind.
  const probe = await nodeGitRunner(root, ["rev-parse", "--git-dir"]);
  if (probe.code !== 0) refuse("ENV_EXAMPLE_REPOSITORY_UNREADABLE");

  const target = `${root}/${name}`;
  let existing: string | null = null;
  try { existing = readFileSync(target, "utf8"); } catch { existing = null; }
  if (existing !== bytes) {
    // A read-only checkout fails HERE, and "the write did not land" is what COMMIT_FAILED means.
    try { writeFileSync(target, bytes); } catch { refuse("ENV_EXAMPLE_COMMIT_FAILED"); }
  }

  // `add` names ONE path, so it cannot sweep; it makes an UNTRACKED `.env.example` a path git
  // knows, which `commit --only` requires. It stages nothing else, and re-stages only the
  // target — the one file this command owns.
  const staged = await nodeGitRunner(root, ["add", "--", name]);
  if (staged.code !== 0) refuse("ENV_EXAMPLE_COMMIT_FAILED");
  // ANYTHING TO COMMIT? Asked of the TARGET PATH against HEAD — the actual question — and never
  // of git's message text. Exit 0 = no difference = the committed file already holds these names.
  // A fatal (unborn HEAD, 128) is NOT "no difference", so it falls through and commits.
  const pending = await nodeGitRunner(root, ["diff", "--cached", "--quiet", "HEAD", "--", name]);
  if (pending.code === 0) {
    const unchanged = await nodeGitRunner(root, ["rev-parse", "HEAD"]);
    return { changed: false, commit: unchanged.code === 0 ? unchanged.stdout.trim() : null };
  }
  const committed = await nodeGitRunner(root,
    [...LANDER_IDENTITY, "commit", "--only", "-m", COMMIT_MESSAGE, "--", name]);
  if (committed.code !== 0) refuse("ENV_EXAMPLE_COMMIT_FAILED");
  const head = await nodeGitRunner(root, ["rev-parse", "HEAD"]);
  if (head.code !== 0) refuse("ENV_EXAMPLE_COMMIT_FAILED");
  return { changed: true, commit: head.stdout.trim() };
}
