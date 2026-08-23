import { createHash } from "node:crypto";

import type { SqliteEventStore } from "@moe/store";

import type { ProjectConfigurationStore }
  from "../configuration/project-configuration-selection.js";
import { readCurrentRuntimeObservation }
  from "../provider-profile/provider-runtime-observation-reader.js";
import { createFoundationVerificationService } from "./foundation-verification-service.js";
import { refuseCatalog } from "./verification-catalog-contracts.js";
import type { VerificationCatalogReader } from "./verification-catalog-reader.js";

/**
 * THE PRODUCTION CALL SITE for `sealRecipe`, and the reason this row exists.
 *
 * `sealRecipe` has been exported and uncalled since it was written: a symbol
 * grep cannot tell an unwired writer from a wired one, so the durable seal — the
 * only shape in the system carrying an executable `argv` — was unreachable from
 * anything a served command could run. This module composes the seal's inputs
 * from server-side authority and CALLS it.
 *
 * WHAT COMES FROM WHERE, and nothing comes from a caller payload:
 *   argv                  host-scoped verification catalog, via the reader
 *   profileRevisionId     that same catalog entry: which durable provider
 *                         profile revision this command is verified under
 *   runtimeObservation    the durable provider probe, read by that identity
 *   verifierIdentity      that same durable observation plus the profile revision
 *   recipeAggregateId     derived here from (projectId, capability)
 *   declaredInputs        empty, and empty is a STATEMENT: this recipe declares
 *   declaredOutputPaths   no input closure and no output paths, rather than
 *                         inheriting a caller's claim about either
 *
 * IT DOES NOT PRE-CHECK THE DURABLE SEAL. `sealRecipe` already answers a re-seal
 * from durable state — the same sha256 replays from the first seal's bytes, a
 * different one refuses FOUNDATION_VERIFICATION_RECIPE_CONFLICT under
 * DAEMON_VERIFICATION_IDENTITY, and the commit is pinned at the recipe's
 * expected version so a race is decided by the store. A caller that pre-read to
 * skip the call, or that minted a fresh aggregate id per call, would destroy
 * both properties silently.
 *
 * THE IDENTITY IS DERIVED FROM THE PAIR, NOT FROM THE ARGV. Folding argv into
 * the aggregate id would give every edited command a brand-new aggregate, so a
 * changed command would quietly seal a second recipe instead of conflicting with
 * the first — the conflict arm would become unreachable and drift would look
 * like success.
 */

/** This module's OWN layer, for the one refusal it authors. Deliberately not
 *  spelled `*_LAYER`: the security-boundary roster scans exported column-zero
 *  `*_LAYER(S)` constants, and this tags a composition refusal, not a boundary. */
export const DAEMON_RECIPE_SEAL = "DAEMON_RECIPE_SEAL" as const;

/**
 * The single code this module authors. Everything else it can answer is some
 * other layer's refusal, forwarded unrestamped. A durable observation with no
 * reported version cannot produce an honest `verifierVersion`, and inventing one
 * would put an unproven string inside a content-addressed recipe.
 */
export const RECIPE_SEAL_CODES = Object.freeze([
  "RECIPE_SEAL_VERIFIER_VERSION_ABSENT",
] as const);
export type RecipeSealCode = (typeof RECIPE_SEAL_CODES)[number];

const RECIPE_IDENTITY_DOMAIN = "moe-verification-recipe-identity/1";

export interface RecipeSealRefused {
  readonly code: string;
  readonly layer: string;
  readonly ok: false;
}

export type RecipeSealResult =
  | { readonly ok: true; readonly recipeAggregateId: string; readonly sha256: string }
  | RecipeSealRefused;

export interface RecipeSealCompositionDeps {
  readonly catalog: VerificationCatalogReader;
  /** The commit identity this daemon writes the seal under. */
  readonly principalId: string;
  readonly projectId: string;
  readonly store: SqliteEventStore;
}

export interface RecipeSealComposition {
  /** Seals the recipe this project's catalog configures for one capability. */
  sealForCapability(capability: string): RecipeSealResult;
  /** Seals the recipe a SERVER-DERIVED identity names. The identity is matched
   *  against the ids this project's configured pairs derive to, so a caller can
   *  name which recipe to materialize without contributing a byte of it. */
  sealNamed(recipeAggregateId: string): RecipeSealResult;
}

/**
 * Stable, server-derived, and a pure function of the pair. Published so a
 * consumer holding (projectId, capability) computes the same identity this
 * module seals under, instead of guessing a spelling.
 */
export function derivedRecipeAggregateId(projectId: string, capability: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([RECIPE_IDENTITY_DOMAIN, projectId, capability]), "utf8")
    .digest("hex");
  return `recipe-${digest}`;
}

const refuseHere = (code: RecipeSealCode): RecipeSealRefused =>
  Object.freeze({ code, layer: DAEMON_RECIPE_SEAL, ok: false as const });

/** Upstream code AND layer, carried exactly as they arrived. Restamping would
 *  hide which layer actually answered, which is the whole point of the field. */
const carry = (upstream: { readonly code: string; readonly layer: string }): RecipeSealRefused =>
  Object.freeze({ code: upstream.code, layer: upstream.layer, ok: false as const });

export function createRecipeSealComposition(
  deps: RecipeSealCompositionDeps,
): RecipeSealComposition {
  const { catalog, principalId, projectId, store } = deps;

  function sealForCapability(capability: string): RecipeSealResult {
    const configured = catalog.entryFor(projectId, capability);
    if (!configured.ok) return carry(configured);
    const { argv, profileRevisionId } = configured.entry;

    // A PROVEN observation, read by identity from the durable probe. Never one
    // built here: the launch gate's whole guarantee is that what runs and the
    // runtime it runs on were sealed together by one event.
    // The same widening work/launch-runtime-section.ts:141 does: the observation
    // reader declares the narrower read surface it actually uses.
    const observed = readCurrentRuntimeObservation(
      store as unknown as ProjectConfigurationStore, projectId, profileRevisionId);
    if (!observed.ok) return carry(observed);
    const { observation } = observed;
    if (observation.reportedVersion === null || observation.reportedVersion.length === 0) {
      return refuseHere("RECIPE_SEAL_VERIFIER_VERSION_ABSENT");
    }

    // Built PER CALL over this identity, exactly as the served verification
    // command does: a service hoisted to startup would attribute one caller's
    // seal to whoever booted the daemon.
    const service = createFoundationVerificationService({ principalId, projectId, store });
    return service.sealRecipe({
      argv,
      declaredInputs: [],
      declaredOutputPaths: [],
      recipeAggregateId: derivedRecipeAggregateId(projectId, capability),
      runtimeObservation: observation,
      verifierIdentity: {
        capabilitySchemaDigest: observation.adapterCapabilitySchemaDigest,
        verifierId: profileRevisionId,
        verifierVersion: observation.reportedVersion,
      },
    });
  }

  function sealNamed(recipeAggregateId: string): RecipeSealResult {
    const capabilities = catalog.capabilitiesFor(projectId);
    if (!capabilities.ok) return carry(capabilities);
    const matched = capabilities.capabilities.find(
      (capability) => derivedRecipeAggregateId(projectId, capability) === recipeAggregateId);
    // An identity no configured pair derives to names no entry. That is the
    // catalog's own ENTRY_ABSENT answer under the catalog's own layer: this
    // module does not mint a second code for a condition the catalog already
    // names, and does not restamp the catalog's answer as its own.
    if (matched === undefined) return refuseCatalog("VERIFICATION_CATALOG_ENTRY_ABSENT");
    return sealForCapability(matched);
  }

  return { sealForCapability, sealNamed };
}
