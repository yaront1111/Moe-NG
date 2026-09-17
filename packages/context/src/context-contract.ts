export const JOURNAL_VERSION = "journal.v1" as const;
export const CONTEXT_MANIFEST_VERSION = "context-manifest.v1" as const;
export const CONTEXT_RENDERER_VERSION = "context-renderer.v1" as const;

export const MAX_JOURNAL_ENTRY_COUNT = 8;
export const MAX_JOURNAL_TEXT_CHARACTERS = 12 * 1024;
export const DEFAULT_CONTEXT_BYTE_BUDGET = 64 * 1024;

interface ContextItemBase {
  readonly id: string;
  readonly section: string;
  readonly content: string;
}

export interface MandatoryContextItem extends ContextItemBase {
  readonly kind: "MANDATORY";
}

export interface OptionalContextItem extends ContextItemBase {
  readonly kind: "OPTIONAL";
  readonly priority: number;
}

export type FactPredicate =
  | Readonly<{
      kind: "FACT_VALUE";
      factId: string;
      operator: "EQUALS" | "NOT_EQUALS";
      expectedValue: string | number | boolean | null;
    }>
  | Readonly<{
      kind: "FACT_VERSION";
      factId: string;
      operator: "EQUALS" | "GREATER_THAN";
      expectedVersion: number;
    }>
  | Readonly<{
      kind: "FACT_DIGEST";
      factId: string;
      operator: "EQUALS" | "NOT_EQUALS";
      expectedDigest: string;
    }>;
