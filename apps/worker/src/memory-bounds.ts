export const memoryBounds = {
  indexChunk: 50,
  embeddingChunk: 32,
  removalSettleMs: 30 * 60_000,
  inspectionSettleMs: 10 * 60_000,
  // One rotation slot per */5 * * * * invocation in wrangler.jsonc.
  rotationSlotMs: 5 * 60_000,
  listPage: 25,
  historyPage: 26,
} as const;
