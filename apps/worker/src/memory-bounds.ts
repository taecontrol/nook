export const memoryBounds = {
  indexChunk: 50,
  meaningTopK: 50,
  keywordCandidates: 50,
  embeddingChunk: 32,
  // Vectorize rejects larger id payloads with code 40007 (#95).
  vectorGetIds: 20,
  vectorDeleteIds: 100,
  removalSettleMs: 30 * 60_000,
  inspectionSettleMs: 10 * 60_000,
  // One rotation slot per */5 * * * * invocation in wrangler.jsonc.
  rotationSlotMs: 5 * 60_000,
  pageSize: 25,
} as const;
