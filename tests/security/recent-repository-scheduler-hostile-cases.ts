import {
  createRepositoryDeliveryCoordinator,
} from "../../apps/daemon/src/orchestrator/repository-delivery-coordinator.js";
import type { SpawnRequest } from "../../apps/daemon/src/orchestrator/agent-wrapper.js";
import {
  createRepositoryRecoveryService,
} from "../../apps/daemon/src/repository/repository-recovery-service.js";
import type { RepositoryRecoveryServiceOptions } from "../../apps/daemon/src/repository/repository-recovery-service.js";
import type { HostileCase, HostileRaceCase } from "./scheduler-activation-hostile-cases.js";

const forbidden = (): never => { throw new Error("unadmitted repository request reached an effect"); };
const delivery = createRepositoryDeliveryCoordinator({
  baseline: forbidden, controller: { controllerId: "security-controller", controllerPid: 1 },
  facts: forbidden, isProcessAlive: forbidden, land: forbidden,
  port: new Proxy({} as never, { get: forbidden }), projectId: "security-project",
  retired: forbidden, storeId: "security-store", verify: forbidden, workspaces: forbidden,
});
const recovery = createRepositoryRecoveryService({
  store: new Proxy({} as RepositoryRecoveryServiceOptions["store"], { get: forbidden }),
  projectId: "security-project", storeId: "security-store", workspaces: forbidden,
  clock: forbidden, mintId: forbidden,
  git: new Proxy({} as NonNullable<RepositoryRecoveryServiceOptions["git"]>, { get: forbidden }),
});

const specs = [
  { constant: "REPOSITORY_DELIVERY_LAYER",
    expected: { code: "REPOSITORY_DELIVERY_WORKSPACE_REQUIRED", layer: "REPOSITORY_DELIVERY" },
    hostile: () => delivery.start({ kind: "node.deliver", workspace: null,
      workItemId: "node.deliver@node-1" } as SpawnRequest, async () => forbidden()) },
  { constant: "REPOSITORY_RECOVERY_LAYER",
    expected: { code: "REPOSITORY_RECOVERY_INPUT_INVALID", layer: "REPOSITORY_RECOVERY" },
    hostile: () => recovery.recover({ principalId: "operator", operatorPrincipalId: "operator",
      commandId: "recovery-invalid", correlationId: "security", expectedVersion: 0,
      targetAggregateId: "repository-recovery:unbound", payload: null }) },
] as const;

export const RECENT_REPOSITORY_SCHEDULER_CASES: readonly HostileCase[] = Object.freeze(specs.flatMap(
  ({ constant, expected, hostile }): readonly HostileCase[] => [
    { constant, arm: "BEFORE", expected, arranged: expected.layer,
      name: "missing repository authority refuses before any effect", run: hostile },
    { constant, arm: "AFTER", expected, arranged: expected.layer,
      name: "a prior refusal cannot make an unbound repository request executable",
      run: async () => { await hostile(); return hostile(); } },
  ],
));

export const RECENT_REPOSITORY_SCHEDULER_RACES: readonly HostileRaceCase[] = Object.freeze(specs.map(
  ({ constant, expected, hostile }): HostileRaceCase => ({
    constant, expected, arranged: expected.layer, maxAdmitted: 0,
    name: "racing unbound repository requests both refuse without effects",
    run: async () => Promise.all([hostile(), hostile()]),
  }),
));
