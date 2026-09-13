export type ProductInspector = "requirements" | "readiness" | "record";
export interface ProductQuery {
  readonly goalId: string;
  readonly artifactId: string | null;
  readonly inspector: ProductInspector | null;
}
export type ProductQueryUpdate = ProductQuery | null | ((current: ProductQuery | null) => ProductQuery | null);
export type UpdateProductQuery = (next: ProductQueryUpdate, replace?: boolean) => void;
const KEYS = ["product", "artifact", "inspect"] as const;
const invalid = { kind: "invalid" } as const;
const validRef = (value: string): boolean => value.trim().length > 0
  && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);

/** Public location state is a lookup request, never an authority or a grant. */
export function readProductQuery(search: string): ProductQuery | typeof invalid | null {
  const params = new URLSearchParams(search);
  if (KEYS.some((key) => params.getAll(key).length > 1)) return invalid;
  const goalId = params.get("product"), artifactId = params.get("artifact"), inspector = params.get("inspect");
  if (goalId === null) return artifactId === null && inspector === null ? null : invalid;
  if (!validRef(goalId) || (artifactId !== null && !validRef(artifactId))) return invalid;
  if (inspector !== null && inspector !== "requirements" && inspector !== "readiness" && inspector !== "record") return invalid;
  return Object.freeze({ goalId, artifactId, inspector });
}

export function writeProductQuery(search: string, query: ProductQuery | null): string {
  const params = new URLSearchParams(search);
  for (const key of KEYS) params.delete(key);
  if (query !== null) {
    params.set("product", query.goalId);
    if (query.artifactId !== null) params.set("artifact", query.artifactId);
    if (query.inspector !== null) params.set("inspect", query.inspector);
  }
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}
