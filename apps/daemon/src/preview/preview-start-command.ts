import type { SqliteEventStore } from "@moe/store";

import { DomainRefusal } from "../daemon-command-dispatch.js";
import type { AsyncCommandHandler } from "../http/http-async-contract.js";
import type { CommandHandlerInput, DurableDecision } from "../http/http-contract.js";
import { decodePreviewStartPayload, previewRefusal } from "./preview-contracts.js";
import type { PreviewRefusal } from "./preview-contracts.js";
import { readPreviewReceipt } from "./preview-ledger.js";
import { previewReceiptId } from "./preview-receipt-contracts.js";
import type { PreviewSupervisor } from "./preview-supervisor.js";

/**
 * THE COMMAND EDGE FOR `preview.start`: the one place the operator's ask reaches the landed
 * preview runner.
 *
 * IT IS AN ASYNC ENTRY, AND THAT IS FORCED RATHER THAN CHOSEN. `CommandHandler` is synchronous
 * (`(input) => DurableDecision`, http-contract.ts:197) while `runPreview` spawns a dev server,
 * waits for it to become answerable and drives a browser through Playwright. `repository.bootstrap`
 * hit the same wall for the same reason, and this module is deliberately its twin — including
 * living in its OWN file rather than inline in `daemon-command-async-entries.ts`.
 *
 * IT COMPOSES; IT DECIDES NOTHING THE RUNNER ALREADY DECIDES. Landing, command resolution,
 * start timeout, path containment, in-flight de-duplication and the receipt write all belong to
 * `preview-runner` / `preview-supervisor`, which are landed and green. Nothing here re-derives
 * any of them. What this module owns is exactly four things: the operator fence, the payload
 * decode, WHERE the workspace comes from, and reading the durable receipt back.
 *
 * THE SUPERVISOR IS INJECTED, NEVER CONSTRUCTED. `createPreviewSupervisor` holds live previews
 * in an in-memory Map, so a second instance would each hold half the roster: `preview.decide`
 * would find nothing to stop for one half, and daemon shutdown would sweep only the other,
 * leaving a dev server holding a port with no owner. The daemon builds exactly one, at
 * `daemon-store-foundation-composition.ts`, and hands `PreviewDaemonRuntime.supervisor` here.
 *
 * AN ABSENT SUPERVISOR OR AN UNCONFIGURED WORKSPACE IS A REFUSING STATE, NEVER A SKIPPED ONE —
 * the same fail-closed posture the decide edge takes for an absent port. Both answer
 * PREVIEW_COMMAND_MISSING @ RUNNER: nothing on this host knows how to serve the preview. No
 * default workspace is invented, because the workspace is a directory the runner spawns a
 * script out of.
 *
 * IT NEVER WRITES A RECEIPT. `runPreview` already records one on BOTH paths
 * (preview-runner.ts, `record`), so a second `recordPreviewReceipt` here would be absorbed by
 * the ledger's idempotence and answer `replayed: true` — looking correct while hiding a
 * double-write. This module READS, through `readPreviewReceipt`, the one production read
 * surface, so the answer an operator gets is the record the store actually holds rather than
 * the writer's own account of it.
 */

/** What a started preview leaves behind on the wire: the receipt the operator's screen reads. */
export const PREVIEW_START_RESULT_CODE = "PREVIEW_STARTED" as const;

export interface PreviewStartOptions {
  /** The configured operator principal. THE ASYNC ENTRY MUST FENCE ITSELF: `entryOf`
   *  (daemon-command-registry.ts) returns the async entry BEFORE the synchronous operator check,
   *  so `OPERATOR_PRINCIPAL_KINDS` membership alone would leave the kind dispatchable by any
   *  REVIEW-capable session. Measured on the bootstrap row; not rediscovered here. */
  readonly operatorPrincipalId: string;
  readonly projectId: string;
  readonly store: SqliteEventStore;
  /** The daemon's ONE supervisor, as composed by `createPreviewDaemonPort`. ABSENT is REFUSING. */
  readonly supervisor?: PreviewSupervisor | undefined;
  /** THE DAEMON'S OWN BOUND WORKSPACE, never a payload value. `workspaceScripts`
   *  (preview-runner.ts) reads `<workspace>/package.json` and the runner spawns a script out of
   *  it, so a caller-chosen workspace would be arbitrary command execution on the daemon host.
   *  ABSENT or empty is REFUSING; it is never defaulted and never guessed. */
  readonly workspace?: string | null | undefined;
}

function refuse(refusal: PreviewRefusal): never {
  throw new DomainRefusal(
    refusal.code,
    refusal.layer,
    refusal.sourceCode === null
      ? `preview.start refused: ${refusal.code}`
      : `preview.start refused: ${refusal.code} (${refusal.sourceLayer}/${refusal.sourceCode})`,
  );
}

/** Serve one `preview.start`. The gate order is the header's; each gate names itself below. */
export function createPreviewStartHandler(options: PreviewStartOptions): AsyncCommandHandler {
  const { projectId, store } = options;
  return async ({ envelope, principal }: CommandHandlerInput): Promise<DurableDecision> => {
    // FENCED AT ENTRY, before the decode and before any effect. Asking for a preview runs the
    // product on the operator's own host; it is never widened to a paired browser human the
    // way `repository.publish` is.
    if (principal.principalId !== options.operatorPrincipalId) {
      throw new DomainRefusal("OPERATOR_PRINCIPAL_REQUIRED", "DAEMON_AUTHORIZATION",
        "this command requires the configured operator principal", 403);
    }
    const decoded = decodePreviewStartPayload(envelope.payload);
    if (!decoded.ok) refuse(decoded);
    const { goalId, sha } = decoded.payload;

    // SERVER-HELD, both of them. Neither can be named by the caller.
    const workspace = options.workspace;
    const supervisor = options.supervisor;
    if (supervisor === undefined || workspace === undefined || workspace === null
      || workspace === "") {
      refuse(previewRefusal("PREVIEW_COMMAND_MISSING"));
    }

    // ONE PREVIEW PER (project, goal, revision), AND THIS CHECK IS WHAT KEEPS IT TRUE ACROSS
    // COMMANDS. The supervisor de-duplicates starts that are IN FLIGHT together
    // (`preview-supervisor.ts`, the `starting` map), but a SECOND command arriving after the
    // first has finished finds that map empty and reaches `runPreview`, which SPAWNS A SECOND
    // DEV SERVER before it records anything. The ledger is idempotent by receipt id, so the
    // second run's record answers the FIRST receipt -- and the supervisor then does
    // `live.set(receiptId, {handle: THE NEW ONE, ...})`, EVICTING the first handle from the
    // roster. Nothing would ever stop that first process: not `preview.decide`, not shutdown.
    // It would hold its port until the host was rebooted.
    // Answering the existing receipt as REPLAYED is also what the ledger's own model already
    // says -- the receipt id is a function of (projectId, goalId, sha), so a second preview of
    // the same revision is not a thing the system can represent.
    // A REFUSED receipt deliberately does NOT short-circuit: a refusal is retryable, because the
    // condition that caused it (an unconfigured workspace, a missing script) can be fixed.
    const receiptId = previewReceiptId(projectId, goalId, sha);
    const already = readPreviewReceipt(store, projectId, receiptId);
    if (already.ok && already.receipt.outcome === "STARTED") {
      return Object.freeze({
        commandId: envelope.commandId,
        disposition: "REPLAYED" as const,
        effectId: already.receipt.receiptId,
        resultCode: PREVIEW_START_RESULT_CODE,
      });
    }

    // The runner records the receipt on BOTH paths; this call returns without throwing by
    // contract, and de-duplicates a concurrent start for the same revision by receipt id.
    const result = await supervisor.start({ goalId, sha, workspace });

    // READ BACK THROUGH THE PRODUCTION READ SURFACE. The receipt id is deterministic, so this
    // does not depend on what `start` handed back: an answer assembled from the return value
    // would report a write that the store might not hold.
    const read = readPreviewReceipt(store, projectId, receiptId);
    if (!result.ok) {
      // The receipt is ALREADY REFUSED with the runner's own code, so the refusal travels back
      // with that code and the layer `PREVIEW_CODE_LAYERS` maps it to. A code is never invented
      // here: the recorded one and the answered one are the same fact.
      refuse(read.ok && read.receipt.code !== null
        ? previewRefusal(read.receipt.code)
        : result.refusal);
    }
    if (!read.ok) {
      // The preview started but nothing durable says so, which is exactly the condition the
      // runner itself answers PREVIEW_START_TIMEOUT for when its own record comes back null.
      // The refusal carries the ledger's own code as the SOURCE, unrestamped.
      refuse(previewRefusal("PREVIEW_START_TIMEOUT", read.code, "DURABLE_STORE"));
    }
    return Object.freeze({
      commandId: envelope.commandId,
      disposition: "DECIDED" as const,
      effectId: read.receipt.receiptId,
      resultCode: PREVIEW_START_RESULT_CODE,
    });
  };
}
