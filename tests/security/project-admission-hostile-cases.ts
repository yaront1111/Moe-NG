/** Hostile cases for project-manager admission state machines. */

import {
  PAIRING_APPROVAL_LAYER,
  PAIRING_APPROVAL_TTL_MS,
  createPairingApprovalWindow,
} from "../../apps/daemon/src/http/pairing-approval-window.js";
import {
  PROJECT_MANAGER_BUSY,
  PROJECT_MANAGER_INTAKE_INVALID,
  PROJECT_MANAGER_LAYER,
  PROJECT_MANAGER_PROJECT_UNKNOWN,
  createProjectManagerService,
} from "../../apps/daemon/src/projects/project-manager-service.js";
import type {
  ProjectManagerCatalogPort,
  ProjectRuntimeSupervisorPort,
} from "../../apps/daemon/src/projects/project-manager-service.js";
import type {
  ProjectCatalog,
  RegisterCatalogProjectInput,
} from "../../apps/daemon/src/projects/project-catalog.js";
import type { ProjectManagerFilesPort } from "../../apps/daemon/src/projects/project-manager-files.js";
import { probeRacing } from "./hostile-harness.js";
import type {
  HostileCase,
  HostileRaceCase,
} from "./scheduler-activation-hostile-cases.js";

const BOUND = Object.freeze({ label: "project-admission", timeoutMs: 2_000 });
const EMPTY: ProjectCatalog = Object.freeze({
  entries: Object.freeze([]),
  schemaVersion: "moe-project-catalog/1",
});
const PROJECT = Object.freeze({
  configPath: "C:\\work\\alpha\\moe.config.json",
  projectId: "alpha",
  root: "C:\\work\\alpha",
  storePath: "C:\\work\\alpha\\store.sqlite",
});
const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";

const pairingEntropy = (size: number): Uint8Array => new Uint8Array(size).fill(0x11);

function managerWorld(overrides: Partial<ProjectManagerFilesPort> = {}) {
  const catalogPort: ProjectManagerCatalogPort = Object.freeze({
    register: async (catalog: ProjectCatalog, input: RegisterCatalogProjectInput) => {
      const entry = Object.freeze({ ...input, instanceId: INSTANCE_ID });
      return Object.freeze({
        catalog: Object.freeze({
          entries: Object.freeze([...catalog.entries, entry]),
          schemaVersion: catalog.schemaVersion,
        }),
        entry,
        ok: true as const,
      });
    },
    save: async () => Object.freeze({ ok: true as const }),
  });
  const files: ProjectManagerFilesPort = Object.freeze({
    create: async () => Object.freeze({ ok: true as const, project: PROJECT }),
    register: async () => Object.freeze({ ok: true as const, project: PROJECT }),
    ...overrides,
  });
  const runtime: ProjectRuntimeSupervisorPort = Object.freeze({
    list: () => Object.freeze([]),
    open: async () => Object.freeze({ code: "RUNTIME_OPENED", layer: "PROJECT_RUNTIME_SUPERVISOR", ok: true }),
    start: async () => Object.freeze({ code: "RUNTIME_STARTED", layer: "PROJECT_RUNTIME_SUPERVISOR", ok: true }),
    stop: async () => Object.freeze({ code: "RUNTIME_STOPPED", layer: "PROJECT_RUNTIME_SUPERVISOR", ok: true }),
  });
  return createProjectManagerService({ catalog: EMPTY, catalogPort, files, runtime });
}

const pairingInvalid = Object.freeze({
  code: "PAIRING_REQUEST_INVALID",
  layer: PAIRING_APPROVAL_LAYER,
});
const pairingExpired = Object.freeze({
  code: "PAIRING_REQUEST_EXPIRED",
  layer: PAIRING_APPROVAL_LAYER,
});
const pairingBusy = Object.freeze({
  code: "PAIRING_REQUEST_BUSY",
  layer: PAIRING_APPROVAL_LAYER,
});
const intakeInvalid = Object.freeze({
  code: PROJECT_MANAGER_INTAKE_INVALID,
  layer: PROJECT_MANAGER_LAYER,
});
const projectUnknown = Object.freeze({
  code: PROJECT_MANAGER_PROJECT_UNKNOWN,
  layer: PROJECT_MANAGER_LAYER,
});
const managerBusy = Object.freeze({
  code: PROJECT_MANAGER_BUSY,
  layer: PROJECT_MANAGER_LAYER,
});

export const PROJECT_ADMISSION_CASES: readonly HostileCase[] = Object.freeze([
  {
    arm: "BEFORE",
    arranged: PAIRING_APPROVAL_LAYER,
    constant: "PAIRING_APPROVAL_LAYER",
    expected: pairingInvalid,
    name: "a non-request identity cannot enter the approval window",
    run: async () => createPairingApprovalWindow().requests.reserve(null),
  },
  {
    arm: "AFTER",
    arranged: PAIRING_APPROVAL_LAYER,
    constant: "PAIRING_APPROVAL_LAYER",
    expected: pairingExpired,
    name: "a request replayed at its deadline remains expired",
    run: async () => {
      let now = 0;
      const window = createPairingApprovalWindow({ now: () => now, randomBytes: pairingEntropy });
      const created = window.requests.create();
      if (!created.ok) return created;
      now = PAIRING_APPROVAL_TTL_MS;
      return window.requests.reserve(created.requestId);
    },
  },
  {
    arm: "BEFORE",
    arranged: PROJECT_MANAGER_LAYER,
    constant: "PROJECT_MANAGER_LAYER",
    expected: intakeInvalid,
    name: "a secret-bearing project intake is refused before filesystem authority",
    run: async () => await managerWorld().create({
      credential: "caller-secret", root: PROJECT.root, title: "Alpha",
    } as never),
  },
  {
    arm: "AFTER",
    arranged: PROJECT_MANAGER_LAYER,
    constant: "PROJECT_MANAGER_LAYER",
    expected: projectUnknown,
    name: "a lifecycle command cannot revive an unknown project identity",
    run: async () => await managerWorld().start("22222222-2222-4222-8222-222222222222"),
  },
]);

let managerRaceAdmissions = 0;

export const PROJECT_ADMISSION_RACES: readonly HostileRaceCase[] = Object.freeze([
  {
    arranged: PAIRING_APPROVAL_LAYER,
    constant: "PAIRING_APPROVAL_LAYER",
    expected: pairingBusy,
    maxAdmitted: 1,
    name: "two approved claims contend and only one reservation is live",
    run: async () => {
      const window = createPairingApprovalWindow({ now: () => 0, randomBytes: pairingEntropy });
      const created = window.requests.create();
      if (!created.ok) return [created, created] as const;
      const approved = window.operator.approve(created.confirmationLabel);
      if (!approved.ok) return [approved, approved] as const;
      const outcome = await probeRacing(
        BOUND,
        async () => window.requests.reserve(created.requestId),
        async () => window.requests.reserve(created.requestId),
      );
      const left = outcome.left.status === "fulfilled" ? outcome.left.value : outcome.left.reason;
      const right = outcome.right.status === "fulfilled" ? outcome.right.value : outcome.right.reason;
      return [left, right] as const;
    },
  },
  {
    arranged: PROJECT_MANAGER_LAYER,
    constant: "PROJECT_MANAGER_LAYER",
    durableAdmissions: () => managerRaceAdmissions,
    expected: managerBusy,
    maxAdmitted: 1,
    name: "overlapping catalog mutations publish exactly one project",
    run: async () => {
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const held = new Promise<void>((resolve) => { release = resolve; });
      const service = managerWorld({
        create: async () => {
          entered();
          await held;
          return Object.freeze({ ok: true as const, project: PROJECT });
        },
      });
      managerRaceAdmissions = 0;
      const left = service.create({ root: PROJECT.root, title: "Alpha" });
      await started;
      const right = service.register({ root: "C:\\work\\beta", title: "Beta" });
      release();
      const outcome = await Promise.all([left, right]);
      managerRaceAdmissions = service.snapshot().entries.length;
      return outcome;
    },
  },
]);
