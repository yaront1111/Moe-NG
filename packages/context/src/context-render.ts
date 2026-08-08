import {
  CONTEXT_MANIFEST_VERSION,
  CONTEXT_RENDERER_VERSION,
  MAX_JOURNAL_ENTRY_COUNT,
  MAX_JOURNAL_TEXT_CHARACTERS,
  type OptionalContextItem,
} from "./context-contract.js";
import {
  type AdmittedContextSelection,
  type ContextExclusion,
} from "./context-selection.js";
import { canonicalSha256, deepFreeze } from "./canonical-digest.js";

export type ContextDigestBoundField =
  | "optionalSelection"
  | "journalCountLimit"
  | "journalTextLimit"
  | "ordering"
  | "rendererVersion"
  | "exclusions"
  | "exactBytes";

export interface ContextDigestBinding {
  readonly optionalSelection: readonly OptionalContextItem[];
  readonly journalCountLimit: number;
  readonly journalTextLimit: number;
  readonly ordering: string;
  readonly rendererVersion: string;
  readonly exclusions: readonly ContextExclusion[];
  readonly exactBytes: readonly number[];
}

export interface ContextRenderManifest {
  readonly version: typeof CONTEXT_MANIFEST_VERSION;
  readonly binding: ContextDigestBinding;
  readonly digest: string;
}

export interface RenderedContext {
  readonly bytes: readonly number[];
  readonly manifest: ContextRenderManifest;
}

function cloneOptionalItems(
  items: readonly OptionalContextItem[],
): readonly OptionalContextItem[] {
  return items.map((item) => ({ ...item }));
}

function cloneExclusions(
  exclusions: readonly ContextExclusion[],
): readonly ContextExclusion[] {
  return exclusions.map((exclusion) => ({ ...exclusion }));
}

function renderExactBytes(selection: AdmittedContextSelection): number[] {
  const chunks = [...selection.mandatory, ...selection.optional].map(
    ({ content }) => content,
  );
  return Array.from(new TextEncoder().encode(chunks.join("")));
}

export function digestContextManifest(binding: ContextDigestBinding): string {
  return canonicalSha256({
    version: CONTEXT_MANIFEST_VERSION,
    binding,
  });
}

export function renderContext(
  selection: AdmittedContextSelection,
): RenderedContext {
  const bytes = renderExactBytes(selection);
  const binding: ContextDigestBinding = {
    optionalSelection: cloneOptionalItems(selection.optional),
    journalCountLimit: MAX_JOURNAL_ENTRY_COUNT,
    journalTextLimit: MAX_JOURNAL_TEXT_CHARACTERS,
    ordering: selection.ordering,
    rendererVersion: CONTEXT_RENDERER_VERSION,
    exclusions: cloneExclusions(selection.exclusions),
    exactBytes: bytes,
  };
  const manifest = {
    version: CONTEXT_MANIFEST_VERSION,
    binding,
    digest: digestContextManifest(binding),
  } as const;
  return deepFreeze({ bytes, manifest });
}
