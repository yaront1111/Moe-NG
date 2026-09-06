import type { JsonObject, JsonValue } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import { sha256Hex } from "../bootstrap/activation-receipts.js";
import { BOOTSTRAP_SCHEMA_VERSION } from "../bootstrap/bootstrap-contracts.js";
import { commitAccepted, readDurableLedger, refuse, versionOf }
  from "../bootstrap/bootstrap-ledger.js";
import type { CommandHandler, HandlerTable } from "../bootstrap/bootstrap-ledger-vocabulary.js";
import { aggregateIdFor } from "../bootstrap/bootstrap-sequence.js";
import { BOOTSTRAP_HANDLERS, admitBootstrapCommand, runBootstrapCommand }
  from "../bootstrap/bootstrap-services.js";
import { DomainRefusal, decisionOf, encoder } from "../daemon-command-dispatch.js";
import type { CommandHandlerInput, DurableDecision } from "../http/http-contract.js";
import type { AsyncCommandHandler } from "../http/http-async-contract.js";
import { isDurableHumanPrincipal } from "../identity/human-approver.js";
import { bootstrapRefusal } from "./repository-bootstrap-contracts.js";
import type { BootstrapGhPort, BootstrapPorts, BootstrapReceiptV1, BootstrapRefusal,
  BootstrapRepository, BootstrapRequest } from "./repository-bootstrap-contracts.js";
import { writeMoeProjectFiles } from "./repository-bootstrap-moe-files.js";
import { createBootstrapGhPort, createBootstrapGitPort, nodeTreeWriter }
  from "./repository-bootstrap-ports.js";
import { bootstrapRepository } from "./repository-bootstrap-service.js";

/**
 * The command edge for `repository.bootstrap`: the one place child A's engine, the EXISTING
 * `project.bind_repository` handler and the manager catalog are composed.
 *
 * IT IS AN ASYNC ENTRY, NOT A `BOOTSTRAP_HANDLERS` ROW, and that is forced rather than chosen.
 * `CommandHandler` is synchronous (`(context) => ServiceOutcome`) and this command runs `git`,
 * optionally `gh`, and a filesystem tree write. `project.activate` hit the same wall for the same
 * reason (daemon-command-registry.ts) and the shape here is deliberately its twin: ADMIT FIRST
 * through the bootstrap surface (decode, replay fence, known kind, durable prerequisites), then
 * perform the effects, then commit through a handler closing over what the effects produced.
 *
 * ADMIT-FIRST IS A SAFETY PROPERTY HERE, not an optimisation. The gates cost nothing and decide
 * identically with or without effects, so a replayed or out-of-sequence request never touches the
 * operator's filesystem at all.
 *
 * NO SECOND BINDING PATH AND NO SECOND ENGINE. The bind is a real `project.bind_repository`
 * request driven through `runBootstrapCommand`; the git/gh/tree work is child A's engine behind
 * its own ports. This module holds no process spawn, no filesystem walk and no reducer.
 */

/** The durable event a committed bootstrap appends. The RECEIPT is the committed result. */
export const REPOSITORY_BOOTSTRAPPED_EVENT = "RepositoryBootstrapped" as const;

export interface CatalogRegistrationRequest {
  readonly configPath: string;
  readonly projectId: string;
  readonly root: string;
  readonly storePath: string;
  readonly title: string;
}

/** Registers the product in the manager catalog. Throws on refusal, like `RepositoryBoundPort`. */
export type BootstrapCatalogPort = (request: CatalogRegistrationRequest) => Promise<void>;

export interface RepositoryBootstrapOptions {
  readonly catalog: BootstrapCatalogPort;
  readonly clock?: () => string;
  /** The configured operator principal. THE ASYNC ENTRY MUST FENCE ITSELF: the registry's
   *  operator check lives in the SYNCHRONOUS handler path, which an async entry never reaches,
   *  so membership in `OPERATOR_PRINCIPAL_KINDS` alone cannot reject non-human sessions.
   *  HTTP ingress requires ADMIN; this entry admits only the operator or a durable HUMAN. */
  readonly operatorPrincipalId: string;
  /** Test seam for the GitHub half. Production passes nothing and gets the real `gh` CLI. */
  readonly gh?: BootstrapGhPort;
  readonly projectId: string;
  readonly store: SqliteEventStore;
}

/** The canonical bytes of a bootstrap-family request, EXPORTED because the deploy command edge
 *  admits through the same surface (`deploy-command.ts`). A second copy of this shape would be a
 *  second place for `BOOTSTRAP_SCHEMA_VERSION` and the field set to drift, and the digest the
 *  replay fence keys on is computed from exactly these bytes. */
export function bootstrapRequestBytes(
  kind: string, projectId: string, decidedAt: string, payload: JsonObject,
  envelope: { commandId: string; correlationId: string; expectedVersion: number },
  principalId: string,
): Uint8Array {
  return encoder.encode(JSON.stringify({
    commandId: envelope.commandId, correlationId: envelope.correlationId, decidedAt,
    expectedVersion: envelope.expectedVersion, kind, payload, principalId, projectId,
    schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
  }));
}

/**
 * The observation the bind receives. `baseRevisionHash` is the sha256 of a canonical line rather
 * than the raw commit id, reusing `repositoryObservationOf`'s existing convention verbatim:
 * core's `validHash` demands 64 hex and a git object name is 40. The raw sha stays readable on
 * the receipt, so nothing is lost and nothing is invented.
 */
function observationOf(repository: BootstrapRepository): JsonObject {
  return {
    baseRevisionHash: sha256Hex(`git-sha1:${repository.sha}\n`),
    repositoryRef: `repository/${repository.dir}`,
    scopeRef: `scope/${repository.dir}`,
    truthClass: "DAEMON_VERIFIED",
  };
}

/** One committed receipt, on the bootstrap aggregate. Refusals commit here too: an operator whose
 *  bootstrap refused after `git init` needs the receipt to say so, which an uncommitted refusal
 *  cannot. The caller still receives the refusal — see `refusalOf` below. */
function commitReceipt(receipt: BootstrapReceiptV1): CommandHandler {
  return (context) => {
    const { ledger, request, store } = context;
    const aggregateId = aggregateIdFor(request, null);
    return commitAccepted(store, request, {
      aggregateId,
      eventPayload: receipt as unknown as JsonValue,
      eventType: REPOSITORY_BOOTSTRAPPED_EVENT,
      expectedVersion: versionOf(ledger, aggregateId),
      result: receipt as unknown as JsonValue,
    });
  };
}

/** A placeholder that admit-time only has to FIND. `admitBootstrapCommand` checks presence and
 *  never calls it, so reaching this body would mean the gate order had changed underneath. */
const unreachableHandler: CommandHandler = (context) =>
  refuse(context.request.kind, "BOOTSTRAP_COMMAND_UNKNOWN", "DAEMON_INGRESS");

function payloadOf(payload: JsonObject): JsonObject {
  const github = payload["github"];
  return {
    dir: typeof payload["dir"] === "string" ? payload["dir"] : "",
    productName: typeof payload["productName"] === "string" ? payload["productName"] : "",
    profileVersion: typeof payload["profileVersion"] === "string" ? payload["profileVersion"] : "",
    ...(github === undefined ? {} : { github }),
  };
}

function bootstrapRequestOf(payload: JsonObject, projectId: string): BootstrapRequest {
  const fields = payloadOf(payload);
  const github = fields["github"];
  return {
    dir: fields["dir"] as string,
    productName: fields["productName"] as string,
    profileVersion: fields["profileVersion"] as string,
    projectId,
    ...(github === undefined ? {} : { github: github as never }),
  };
}

/** Closed codes and closed details only: `BootstrapDetail` is a literal union, so no exception
 *  message, no stdout, no remote URL and no credential can reach a caller through this path. */
function refusalOf(refusal: BootstrapRefusal): DomainRefusal {
  return new DomainRefusal(refusal.code, refusal.refusedBy, refusal.detail, 422);
}

function portsFor(
  options: RepositoryBootstrapOptions, drive: (bytes: Uint8Array) => void,
  envelope: CommandHandlerInput["envelope"], principalId: string, decidedAt: string,
): BootstrapPorts {
  return {
    bindRepository: async (repository) => {
      // THE BIND CARRIES THE PROJECT AGGREGATE'S OWN VERSION, read at the moment it runs.
      // `envelope.expectedVersion` belongs to the BOOTSTRAP aggregate; the project stream has
      // already advanced (a committed `project.register` is this command's prerequisite), so
      // reusing it made the reducer refuse EVERY successful bootstrap with
      // BOOTSTRAP_BIND_FAILED — measured, not theorised.
      const projectVersion = versionOf(
        readDurableLedger(options.store, options.projectId), options.projectId,
      );
      drive(bootstrapRequestBytes("project.bind_repository", options.projectId, decidedAt,
        { observation: observationOf(repository) },
        { ...envelope, commandId: `${envelope.commandId}-bind`, expectedVersion: projectVersion },
        principalId));
    },
    gh: options.gh ?? createBootstrapGhPort(),
    git: createBootstrapGitPort(),
    now: options.clock ?? ((): string => new Date().toISOString()),
    registerCatalog: async (repository) => {
      // THE PATHS ARE CREATED BEFORE THEY ARE REGISTERED, and this line is the whole fix.
      // `canonicalEntry` realpaths `configPath` and `dirname(storePath)`; naming two paths
      // nothing produced made every local-only bootstrap answer BOOTSTRAP_CATALOG_FAILED after
      // the repository was already committed and bound. `writeMoeProjectFiles` owns WHY this
      // runs here — after the `add -A` commit, before the registration — and returns the exact
      // paths it wrote, so the entry cannot name a different file from the one on disk.
      const paths = await writeMoeProjectFiles(repository.dir, repository.projectId);
      await options.catalog({
        configPath: paths.configPath, projectId: repository.projectId,
        root: repository.dir, storePath: paths.storePath,
        title: repository.productName,
      });
    },
    tree: nodeTreeWriter,
  };
}

export function createRepositoryBootstrapHandler(
  options: RepositoryBootstrapOptions,
): AsyncCommandHandler {
  const { projectId, store } = options;
  const clock = options.clock ?? ((): string => new Date().toISOString());
  return async ({ envelope, principal }: CommandHandlerInput): Promise<DurableDecision> => {
    // Unlike scoped-work judgments, creating a repository at a supplied path requires ADMIN:
    // HTTP ingress enforces this kind's CAPABILITIES.ADMIN before dispatch. Identity is fenced
    // HERE, before the clock, decode and effects; the synchronous registry carve-out is not on
    // this route. Keep the operator roster intact: it also keeps this command MCP-excluded.
    if (principal.principalId !== options.operatorPrincipalId
      && !isDurableHumanPrincipal(store, principal.principalId)) {
      throw new DomainRefusal("OPERATOR_PRINCIPAL_REQUIRED", "DAEMON_AUTHORIZATION",
        "this command requires the configured operator or a durable human principal", 403);
    }
    const decidedAt = clock();
    const bytes = bootstrapRequestBytes("repository.bootstrap", projectId, decidedAt,
      envelope.payload, envelope, principal.principalId);
    // ADMIT FIRST. A replay, an unmet `project.register` or a malformed envelope is answered
    // here, before one byte is written into the operator's directory.
    const admitted = admitBootstrapCommand(store, bytes,
      { ...BOOTSTRAP_HANDLERS, "repository.bootstrap": unreachableHandler } satisfies HandlerTable);
    if ("outcome" in admitted) return decisionOf(admitted.outcome);

    // The bind is driven through the EXISTING handler. It THROWS on refusal, which the engine
    // turns into BOOTSTRAP_BIND_FAILED with the local repository retained.
    const drive = (bindBytes: Uint8Array): void => {
      const outcome = runBootstrapCommand(store, bindBytes, BOOTSTRAP_HANDLERS);
      if (!outcome.ok) throw refusalOf(bootstrapRefusal("BOOTSTRAP_BIND_FAILED",
        "BIND_FAILED_LOCAL_REPOSITORY_RETAINED"));
    };
    const receipt = await bootstrapRepository(bootstrapRequestOf(envelope.payload, projectId),
      portsFor(options, drive, envelope, principal.principalId, decidedAt));

    const committed = runBootstrapCommand(store, bytes,
      { ...BOOTSTRAP_HANDLERS, "repository.bootstrap": commitReceipt(receipt) });
    // The receipt is durable either way; a refused bootstrap still answers with its own code and
    // its own layer rather than a committed success the operator would misread as a repository.
    if (committed.ok && receipt.outcome === "REFUSED") throw refusalOf(receipt.refusal);
    return decisionOf(committed);
  };
}
