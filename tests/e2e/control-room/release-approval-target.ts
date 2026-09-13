import { admitRemoteUrl } from "../../../apps/daemon/src/repository/publish-receipt-contracts.js";

/** This arm pushes a real Git branch; the default local case proves refusal only. */
export function readReleaseApprovalTarget(environment: Readonly<Record<string, string | undefined>>):
  Readonly<{ enabled: false }> | Readonly<{ enabled: true; remoteUrl: string }> {
  if (environment["MOE_E2E_RELEASE_REMOTE_TEST"] !== "1") return { enabled: false };
  const remoteUrl = admitRemoteUrl(environment["MOE_E2E_RELEASE_REMOTE_URL"]);
  if (remoteUrl === null) throw new Error("RELEASE_REMOTE_URL_INVALID");
  return { enabled: true, remoteUrl };
}
