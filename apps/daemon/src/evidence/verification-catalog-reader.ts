import { readFileSync, statSync } from "node:fs";

import {
  MAX_VERIFICATION_CATALOG_BYTES, VERIFICATION_CATALOG_ENV_KEY, decodeVerificationCatalog,
  listCatalogCapabilities, lookupCatalogArgv, lookupCatalogEntry, refuseCatalog,
} from "./verification-catalog-contracts.js";
import type {
  VerificationCatalogArgvResult, VerificationCatalogCapabilitiesResult,
  VerificationCatalogEntryResult, VerificationCatalogRefused,
} from "./verification-catalog-contracts.js";

/**
 * The ONLY module in this family permitted to touch the filesystem, and the argv
 * answer for one (projectId, capability). The decode, the code roster and the
 * hostile-input fence live next door in `./verification-catalog-contracts.ts`,
 * which reads nothing — so the rules can be tested without a disk and this
 * reader is the single place a path is opened.
 *
 * It NEVER DEFAULTS. There is no arm that yields an empty argv, a placeholder
 * command or a caller-supplied value: an absent catalog, an unreadable one, an
 * oversized one, a malformed one, an unmentioned project and an uncovered
 * capability are six distinct refusals, each with its own operator repair.
 */

/** Distinguishes the ceiling from every other read fault. A message-matching
 *  reader would reclassify an operator's file the moment the message changed. */
class CatalogTooLargeError extends Error {}

/**
 * Bounded path admission, outside the request plane, mirroring
 * `readFoundationCatalogConfig` (work/foundation-capture-lifecycle.ts:147-161).
 *
 * LAZY BY CONSTRUCTION: the returned thunk is what opens the file, so an absent
 * or unreadable catalog refuses the OPERATION at use time rather than failing
 * daemon boot — the intent daemon-store-dependencies.ts:137-139 states for the
 * sibling catalog. Absent or empty reads as absent rather than as a fault; an
 * unreadable or oversized file THROWS, and the reader below turns that throw
 * into its own exact code.
 */
export function readVerificationCatalogConfig(
  env: Readonly<Record<string, string | undefined>>,
): () => unknown {
  const configured = env[VERIFICATION_CATALOG_ENV_KEY];
  if (configured === undefined || configured === "") return (): unknown => undefined;
  return (): unknown => {
    // SIZE IS CHECKED BEFORE THE READ, not after. Reading first and measuring
    // second would pull an operator-sized file into memory to decide it was too
    // large — the ceiling would exist and protect nothing.
    if (statSync(configured).size > MAX_VERIFICATION_CATALOG_BYTES) {
      throw new CatalogTooLargeError("verification catalog exceeds its byte ceiling");
    }
    return JSON.parse(readFileSync(configured, "utf8")) as unknown;
  };
}

export interface VerificationCatalogReaderDeps {
  /** One source, shared by every consumer, read lazily on each call. */
  readonly catalogSource: () => unknown;
}

export interface VerificationCatalogReader {
  argvFor(projectId: string, capability: string): VerificationCatalogArgvResult;
  /** The whole configured entry — the command AND the provider profile revision
   *  it is verified under — for a consumer that needs both. */
  entryFor(projectId: string, capability: string): VerificationCatalogEntryResult;
  /** The capabilities this project is configured for, or the same refusal
   *  `argvFor` would give. Published so a consumer that holds a server-derived
   *  recipe identity can find which entry produced it WITHOUT the caller naming
   *  a capability — the identity is derived from the pair, so the pair has to be
   *  enumerable to be resolvable. */
  capabilitiesFor(projectId: string): VerificationCatalogCapabilitiesResult;
}

export function createVerificationCatalogReader(
  deps: VerificationCatalogReaderDeps,
): VerificationCatalogReader {
  /**
   * Read on EVERY call rather than memoized. The catalog is operator
   * configuration, not durable state: a corrected file has to take effect
   * without a daemon restart, and a cached refusal would outlive its repair.
   *
   * The result is WRAPPED rather than union-sniffed. Sniffing the loaded value
   * for an `ok: false` shape would let an operator file containing
   * `{"ok":false,"code":...}` impersonate this reader's own refusal and name a
   * code no layer here ever emitted.
   */
  function loaded(): { readonly value: unknown } | { readonly refusal: VerificationCatalogRefused } {
    try {
      return { value: deps.catalogSource() };
    } catch (cause) {
      return {
        refusal: cause instanceof CatalogTooLargeError
          ? refuseCatalog("VERIFICATION_CATALOG_TOO_LARGE")
          : refuseCatalog("VERIFICATION_CATALOG_UNREADABLE"),
      };
    }
  }

  return {
    argvFor(projectId: string, capability: string): VerificationCatalogArgvResult {
      const outcome = loaded();
      if ("refusal" in outcome) return outcome.refusal;
      const raw = outcome.value;
      // Absent is not empty and not malformed: no catalog is configured at all,
      // and the repair is to configure one.
      if (raw === undefined) return refuseCatalog("VERIFICATION_CATALOG_ABSENT");
      const decoded = decodeVerificationCatalog(raw);
      // The decode's own code and layer, forwarded unrestamped — restamping
      // would hide which layer actually answered.
      if (!decoded.ok) return decoded;
      return lookupCatalogArgv(decoded.catalog, projectId, capability);
    },

    entryFor(projectId: string, capability: string): VerificationCatalogEntryResult {
      const outcome = loaded();
      if ("refusal" in outcome) return outcome.refusal;
      const raw = outcome.value;
      if (raw === undefined) return refuseCatalog("VERIFICATION_CATALOG_ABSENT");
      const decoded = decodeVerificationCatalog(raw);
      if (!decoded.ok) return decoded;
      return lookupCatalogEntry(decoded.catalog, projectId, capability);
    },

    capabilitiesFor(projectId: string): VerificationCatalogCapabilitiesResult {
      const outcome = loaded();
      if ("refusal" in outcome) return outcome.refusal;
      const raw = outcome.value;
      if (raw === undefined) return refuseCatalog("VERIFICATION_CATALOG_ABSENT");
      const decoded = decodeVerificationCatalog(raw);
      if (!decoded.ok) return decoded;
      return listCatalogCapabilities(decoded.catalog, projectId);
    },
  };
}
