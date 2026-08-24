import { expect, it } from "vitest";

import {
  DAEMON_ENTRY_LAYER,
  startDaemon,
} from "./daemon-entry.js";
import type { DaemonDependencyProvider } from "./daemon-entry.js";
import { PAIRING_APPROVAL_LAYER } from "./http/pairing-approval-window.js";
import provider from "./daemon-entry-fixtures.js";

const pairingProvider: DaemonDependencyProvider = {
  ...provider,
  sessionHandshake: () => ({
    boundProjectId: "project-entry-pairing",
    mint: () => ({ code: "unused", ok: false }),
  }),
};

it("keeps pairing approval in process and revokes it at daemon shutdown", async () => {
  const started = await startDaemon({ dependencies: pairingProvider });
  if (!started.ok) throw new Error(`daemon refused: ${started.code}`);

  expect(started.approvePairing("abcd-ef01-2345")).toEqual({
    code: "PAIRING_CONFIRMATION_UNKNOWN",
    layer: PAIRING_APPROVAL_LAYER,
    ok: false,
  });
  expect(await started.shutdown()).toEqual({ ok: true });
  expect(started.approvePairing("abcd-ef01-2345")).toEqual({
    code: "DAEMON_ENTRY_ALREADY_STOPPED",
    layer: DAEMON_ENTRY_LAYER,
    ok: false,
  });
});
