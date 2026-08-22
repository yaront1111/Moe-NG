/** One non-primary leg's fence, as it enters the scoped request digest. */
export interface AdditionalLegFence {
  readonly aggregateId: string;
  readonly expectedVersion: number;
}
