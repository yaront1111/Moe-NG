/**
 * The SERVER-OWNED completion of a launch template, composed from durable authorities alone.
 *
 * It exists because the transport no longer carries a `launchTemplate`. The sealed context
 * already supplies argv, environment, launch selection and limits — all produced server-side by
 * `produceLaunchTemplateFields` inside the pre-launch chain — and this authority supplies the
 * three fields that chain cannot know: the runtime section, the session's bootstrap credential
 * digest, and the working directory. None of the three may be proposed by a caller, so the
 * SIGNATURE IS THE FENCE: `completeLaunchTemplate` takes no dispatch request and no payload
 * value on any path, and every fact it reads comes from the durable store it was built over.
 *
 * `cwd` IS THE ASSIGNMENT'S REAL ROOT. The preparation phase already resolved, materialized and
 * sealed the tree this attempt runs in; taking the cwd from anywhere else would let the launch
 * name a directory the capture never proved.
 *
 * `pinRoot` is daemon-process configuration, passed IN and never derived from cwd, a repository
 * root or a literal default. It is forwarded to `produceLaunchRuntimeSection` UNVALIDATED: that
 * producer owns the absent/relative rules and refuses with its own codes, and pre-checking here
 * would be a second place for those rules to drift.
 *
 * EVERY REFUSAL IS THE UPSTREAM'S OWN, unrestamped. Four different authorities can answer one
 * completion and they publish three different refusal vocabularies (`{code, layer}` for the
 * configuration and profile readers, `{code, layer}` for the runtime section, `{code, refusedBy}`
 * for the credential reader), so each is carried across by NAME rather than by spread. A refusal
 * carries no runtime and no digest: partial authority is unrepresentable, not merely unset.
 */

import type { SqliteEventStore } from "@moe/store";

import type { ProjectConfigurationStore }
  from "../configuration/project-configuration-selection.js";
import { readLatestProjectConfiguration }
  from "../configuration/project-configuration-selection.js";
import { readSessionCredentialDigest } from "../identity/session-credential-digest.js";
import { resolveCurrentProviderProfile }
  from "../provider-profile/provider-profile-resolver.js";
import type {
  FoundationAttemptLaunchTemplate,
  FoundationLaunchTemplateCompletionAuthority,
  FoundationLaunchTemplateCompletionInput,
  FoundationLaunchTemplateCompletionRefused,
} from "./foundation-attempt-contracts.js";
import { produceLaunchRuntimeSection } from "./launch-runtime-section.js";

/**
 * THIS BOUNDARY'S OWN closed code roster — one member, for the containment below.
 *
 * Every refusal this module can FORWARD belongs to an upstream authority and keeps that
 * authority's code. The only refusal it MINTS is the one no upstream could have produced: a
 * throw escaping a reader that was supposed to contain its own. Borrowing an upstream code
 * for that would be a restamp in the one direction that matters — it would name an authority
 * that never answered.
 */
export const FOUNDATION_LAUNCH_COMPLETION_CODES = Object.freeze([
  "FOUNDATION_LAUNCH_COMPLETION_UNREADABLE",
] as const);

/** Module-private by design; exported boundary rosters key off column-zero layer constants. */
const COMPLETION_LAYER = "FOUNDATION_LAUNCH_COMPLETION";

export type FoundationLaunchCompletionCode = (typeof FOUNDATION_LAUNCH_COMPLETION_CODES)[number];
export type FoundationLaunchCompletionLayer = typeof COMPLETION_LAYER;

export interface FoundationLaunchCompletionConfig {
  /** Host-scoped daemon-process configuration, forwarded RAW. Absent means unconfigured, and
   *  the runtime producer refuses it under its own code rather than acquiring a default. */
  readonly pinRoot?: string | undefined;
  readonly store: SqliteEventStore;
}

export type FoundationLaunchCompletionResult =
  | FoundationAttemptLaunchTemplate
  | FoundationLaunchTemplateCompletionRefused;

/** Named by hand, never spread: an upstream result carries fields a refusal may not publish. */
function carry(code: string, layer: string): FoundationLaunchTemplateCompletionRefused {
  return Object.freeze({ code, layer, ok: false as const });
}

/**
 * The durable settings digest this project is currently configured under.
 *
 * `resolveCurrentProviderProfile` takes an EXACT two-key request and refuses anything that is
 * not a 64-character lowercase hex digest, and nothing on the dispatch path can yield one —
 * the sibling reader only VALIDATES a digest a caller already holds. So the discover-current
 * read is the only honest way in, and its refusal travels out under its own code and layer.
 */
function currentSettingsDigest(
  store: SqliteEventStore, projectId: string,
): { readonly digest: string; readonly ok: true } | FoundationLaunchTemplateCompletionRefused {
  const current = readLatestProjectConfiguration(
    store as unknown as ProjectConfigurationStore, { projectId },
  );
  return current.ok
    ? Object.freeze({ digest: current.manifest.settingsDigest, ok: true as const })
    : carry(current.code, current.layer);
}

function completeFrom(
  config: FoundationLaunchCompletionConfig,
  input: FoundationLaunchTemplateCompletionInput,
): FoundationLaunchCompletionResult {
  const { store } = config;
  const { projectId, sessionId } = input;

  const configuration = currentSettingsDigest(store, projectId);
  if (!configuration.ok) return configuration;

  // THE CAPABILITIES ARE READ, NEVER DEFAULTED. An absent or severed provider profile refuses
  // the whole completion rather than yielding a template built on weaker authority.
  const capabilities = resolveCurrentProviderProfile(
    store as unknown as ProjectConfigurationStore,
    { expectedConfigurationDigest: configuration.digest, projectId },
  );
  if (!capabilities.ok) return carry(capabilities.code, capabilities.layer);

  // The producer's EXACT four-key input. `pinRoot` is forwarded raw; the producer owns the
  // unconfigured and non-absolute rules and answers with LAUNCH_RUNTIME_PIN_ROOT_* itself.
  const section = produceLaunchRuntimeSection({
    pinRoot: config.pinRoot,
    profileRevisionId: capabilities.profileRevisionId,
    projectId,
    store,
  });
  if (!section.ok) return carry(section.code, section.layer);

  // The ONLY honest source of the bootstrap digest: the durable session fold. Its refusal names
  // the refusing authority in `refusedBy` rather than `layer`, so it is carried across by name.
  const credential = readSessionCredentialDigest(store, projectId, sessionId);
  if (!credential.ok) return carry(credential.code, credential.refusedBy);

  return Object.freeze({
    argv: input.template.argv,
    bootstrapCredentialDigest: credential.credentialSha256,
    // THE ASSIGNMENT IS THE ROOT. The preparation phase proved this tree; no other cwd exists.
    cwd: input.assignment.realWorktreePath,
    environment: input.template.environment,
    launchSelection: input.template.launchSelection,
    limits: input.template.limits,
    runtime: section.runtime,
  });
}

/**
 * Built once per handler over the store the dispatch already serves, then called per attempt.
 * It holds no per-attempt state, so concurrent dispatches sharing one instance cannot observe
 * each other: every fact either arrives in `input` or is re-read from the durable store.
 */
export function createFoundationLaunchCompletionAuthority(
  config: FoundationLaunchCompletionConfig,
): FoundationLaunchTemplateCompletionAuthority {
  const bound = Object.freeze({
    ...(config.pinRoot === undefined ? {} : { pinRoot: config.pinRoot }),
    store: config.store,
  });
  return Object.freeze({
    completeLaunchTemplate(
      input: FoundationLaunchTemplateCompletionInput,
    ): FoundationLaunchCompletionResult {
      try {
        return completeFrom(bound, input);
      } catch {
        // CONTAINED, UNDER THIS BOUNDARY'S OWN NAME. A throw escaping to the service would
        // leave the attempt with no advisory record at all, so it must become a refusal here.
        // All four readers below contain their own store faults and answer with their own
        // codes, so anything reaching this handler came from somewhere none of them can speak
        // for — and answering with one of THEIR codes would name an authority that never ran.
        return carry(FOUNDATION_LAUNCH_COMPLETION_CODES[0], COMPLETION_LAYER);
      }
    },
  });
}
