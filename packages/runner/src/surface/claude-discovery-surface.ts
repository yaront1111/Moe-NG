/**
 * The runtime pin-REQUEST seam, and the same principle the telemetry block in
 * `claude-surface.ts` applies to facts, applied here to CAPABILITIES: the caller
 * supplies data, this package mints the ports.
 *
 * `ClaudeRuntimePinRequest` names six fields and only three of them survive an
 * authenticated JSON boundary. The other three — a filesystem, a host facts
 * observer, a clock — are runtime AUTHORITY, and a consumer able to supply them
 * could hand pinning a runtime nobody ever observed. So `createClaudeRuntimePinRequest`
 * takes exactly `{quotedObservation, installedRoot, pinRoot}` as plain data and
 * mints the rest itself. The refusal vocabulary travels with it for the reason
 * every closed union does here: a code a consumer cannot read is a code nobody
 * can branch on.
 */
export {
  CLAUDE_RUNTIME_PIN_ERROR_CODES,
  CLAUDE_RUNTIME_PIN_LAYER,
  type ClaudeRuntimePinErrorCode,
  type ClaudeRuntimePinFailure,
} from "../providers/claude/claude-runtime-pin-closure.js";
export { type ClaudeRuntimePinRequest } from "../providers/claude/claude-runtime-pin.js";
export {
  createClaudeRuntimePinRequest,
  type ClaudeRuntimePinRequestInput,
  type ClaudeRuntimePinRequestResult,
} from "../providers/claude/claude-runtime-request.js";
/**
 * The runtime DISCOVERY seam — the other half of that factory's asymmetry, and
 * the reason the asymmetry is now complete rather than merely one-sided.
 *
 * `createClaudeRuntimePinRequest` validates a caller's `quotedObservation`
 * against one this package observes itself, comparing exactly the reported
 * version, the adapter capability schema digest and the platform identity. Those
 * are three facts no consumer can mint: the version and the digest exist only
 * inside an observation this package performed. So a self-assembled quote — even
 * one whose closure hashes and paths are all TRUE — is refused
 * `CLAUDE_RUNTIME_OBSERVATION_CHANGED`. That is correct and stays correct.
 *
 * Until discovery landed, though, nothing published could PRODUCE a quote that
 * survived the comparison, so no consumer could reach a PROVEN launch at all.
 * That was the gap, and it is what this module closes.
 *
 * IT DOES NOT RE-OPEN THE SEAM `observeInstalledClaudeRuntime` IS WITHHELD TO
 * CLOSE, and the distinction is exact rather than a matter of degree: what makes
 * that function dangerous is its `executablePath` ARGUMENT — a consumer holding
 * it could point the host observer at a binary no quote ever committed to — not
 * the fact that it returns an observation. `discoverInstalledClaudeRuntime` takes
 * NO argument. A consumer receives an observation of THE installed runtime and
 * still has no way to say WHICH runtime gets observed; the host answers that.
 * When the host answers ambiguously — no candidate, or more than one — discovery
 * refuses rather than choosing, so anyone able to shadow a binary on the search
 * path moves the answer to a refusal instead of to one they picked.
 *
 * WITHHELD, and unchanged in both letter and reason: `createNodeClaudeRuntimeFs`,
 * `RUNTIME_PIN_CHUNK_BYTES`, `observeInstalledClaudeRuntime`, `probeClaudeRuntime`,
 * `ClaudeRuntimeFsPort`, `ClaudeRuntimeFactsPort`, `ClaudeRuntimeObservationRefused`
 * and `prepareClaudeRuntimePin`. Discovery is the ONLY thing that may hold the
 * observer's `executablePath` argument, and it hands it a path no caller chose.
 *
 * `WindowsProcessUnknown` travels with the result union because that union really
 * can carry one: four authorities may refuse here and each keeps its own code and
 * layer, so a consumer unable to NAME the fourth arm cannot branch on the layer
 * that answered. It is a plain refusal RECORD, not a capability — publishing the
 * type grants nothing that can observe, spawn or mint anything, which is why it
 * does not belong on the withheld list.
 *
 * Consumers: task-6cbff01023b14b26a78fc5e3eb1dd8a9 (dispatch acceptance), the
 * Foundation ingress chain (task-a9fd91c373c244c78df97945965a8038) and
 * task-44d4873eb9f746b1a978e97ff9743dc4.
 */
export {
  discoverInstalledClaudeRuntime,
  type DiscoverInstalledClaudeRuntimeResult,
  type DiscoveredClaudeRuntime,
} from "../providers/claude/claude-runtime-discovery.js";
export { type WindowsProcessUnknown } from "../platform/windows/windows-process-contract.js";
