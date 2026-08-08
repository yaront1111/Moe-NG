import {
  type MandatoryContextItem,
  type OptionalContextItem,
} from "./context-contract.js";
import { encodeCanonical } from "./canonical-digest.js";

type RenderableContextItem = MandatoryContextItem | OptionalContextItem;

function renderItem(item: RenderableContextItem): string {
  return encodeCanonical(item);
}

export function renderedItemByteLength(item: RenderableContextItem): number {
  return new TextEncoder().encode(renderItem(item)).byteLength;
}

export function selectionByteLength(
  mandatory: readonly MandatoryContextItem[],
  optional: readonly OptionalContextItem[],
): number {
  const items: readonly RenderableContextItem[] = [...mandatory, ...optional];
  if (items.length === 0) return 0;
  const contentBytes = items.reduce(
    (total, item) => total + renderedItemByteLength(item),
    0,
  );
  return contentBytes + items.length - 1;
}

export function renderSelectionBytes(
  mandatory: readonly MandatoryContextItem[],
  optional: readonly OptionalContextItem[],
): number[] {
  const rendered = [...mandatory, ...optional].map(renderItem).join("\n");
  return Array.from(new TextEncoder().encode(rendered));
}
