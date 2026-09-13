import { COMMAND_AUTHORITY_PLANES } from "./http-contract.js";
import type {
  CommandAdapterDeps, CommandAuthorityPlanePort, CommandDecisionPort, CommandRegistry,
} from "./http-contract.js";

/**
 * Command deps that FOLLOW THE CUTOVER PLANE, for a process that calls
 * `handleCommandRequest(deps, ...)` directly instead of going through an MCP port.
 *
 * `createMcpDispatchPort` resolves the plane per dispatch. The wrapper binary's own
 * `session.open` and `work.claim`, its exit-path `work.release`/`session.close`, the boot
 * reclaim and the node verifier all take a `CommandAdapterDeps` VALUE, and a value captured
 * from `provider.provide()` at process start is the `/1` plane for the life of the process.
 * Measured over the shipped composition (agent-wrapper-command-plane.test.ts, control arm):
 * once the durable cutover marker binds current readiness, that wrapper's every
 * `session.open` answers V1_AUTHORITY_RETIRED, so each READY item is reported with that code
 * on every pass and charged an attempt until STAFFING_ATTEMPTS_EXHAUSTED.
 *
 * `registry` and `decisions` are accessors that consult the plane reader ON EVERY READ, so
 * nothing about the plane is memoised in the value. `authenticator` and `eventStreamAccess`
 * come from the `/1` deps, as the MCP port's queries take them: in the shipped composition
 * both planes close over the same two instances (daemon-store-foundation-composition.ts,
 * `provide` and `provideV2`).
 *
 * A marker that moves between the registry read and the decisions read of ONE call cannot
 * commit on the wrong plane: each plane's handlers assert their own gate inside the handler
 * (`createCommandAuthorityGate` on `/1`, `handlerFor` on `/2`), so a mixed pair buys a
 * refusal, never a mixed commit. A plane answer outside the roster throws
 * COMMAND_AUTHORITY_PLANE_INVALID, exactly as the MCP port and `/bootstrap` do, and is never
 * coerced to `/1`. Both planes are REQUIRED: there is no "unavailable" arm here because the
 * shipped provider always composes `/2`, and a caller without `/2` deps has to refuse by name
 * before building one rather than let this value fall back to `/1`.
 */
export interface PlaneFollowingDepsConfig {
  readonly commandAuthorityPlane: CommandAuthorityPlanePort;
  /** The `/1` plane; also the source of the authenticator and the event-stream authority. */
  readonly deps: CommandAdapterDeps;
  /** The `/2` plane. */
  readonly v2Deps: CommandAdapterDeps;
}

export function createPlaneFollowingDeps(config: PlaneFollowingDepsConfig): CommandAdapterDeps {
  const { authenticator, eventStreamAccess } = config.deps;
  const current = (): CommandAdapterDeps => {
    const plane: unknown = config.commandAuthorityPlane.readPlane();
    if (typeof plane !== "string"
      || !(COMMAND_AUTHORITY_PLANES as readonly string[]).includes(plane)) {
      throw new Error("COMMAND_AUTHORITY_PLANE_INVALID");
    }
    return plane === "V2" ? config.v2Deps : config.deps;
  };
  return Object.freeze({
    authenticator,
    get decisions(): CommandDecisionPort { return current().decisions; },
    get registry(): CommandRegistry { return current().registry; },
    ...(eventStreamAccess === undefined ? {} : { eventStreamAccess }),
  });
}
