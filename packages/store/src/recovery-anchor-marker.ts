/**
 * The INSTALLED marker, written from exactly one place.
 *
 * Two paths reach this record: the install's own final act, and a resume that
 * found the switch already published but the marker missing. Letting each write
 * the marker itself would leave two encoders of the same durable record free to
 * drift — and a resume that produced a subtly different record would be far
 * worse than the crash window it exists to close.
 *
 * It takes the anchor FILE path rather than the anchor root deliberately:
 * `anchorPath` lives in recovery-anchor-install.ts, which imports this module,
 * so resolving the root here would close an import cycle.
 */
import type {
  RecoveryAnchorInstallResult,
  RecoveryAnchorRecord,
} from "./recovery-anchor-contracts.js";
import { publishFileAtomically } from "./recovery-anchor-fs.js";
import { encodeAnchorRecord, resealAnchorRecord } from "./recovery-anchor-record.js";

/**
 * Seal `switched` as INSTALLED and publish it.
 *
 * The caller must already have published the switch, so this never chooses a
 * slot and never writes into one: `currentSlot` is carried through untouched.
 * After the switch that slot is the LIVE one, and writing to it is the single
 * thing the anchor protocol exists to prevent.
 */
export async function markInstalled(
  anchorFilePath: string,
  switched: RecoveryAnchorRecord,
): Promise<RecoveryAnchorInstallResult> {
  const installed = resealAnchorRecord(switched, { state: "INSTALLED" });
  await publishFileAtomically(anchorFilePath, encodeAnchorRecord(installed));
  return Object.freeze({ anchor: installed, ok: true as const, outcome: "INSTALLED" as const });
}
