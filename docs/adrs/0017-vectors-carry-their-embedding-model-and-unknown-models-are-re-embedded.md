# ADR-0017: Vectors carry their embedding model, and a vector of unknown model is re-embedded

Date: 2026-10-30
Status: Accepted

## Context

ADR-0013 promises that meaning search converges after model changes and
lost writes. ADR-0014 adds bounded inspection of the actual index, so a
missing or inconsistent vector invalidates its D1 marker without a search.
Inspection compared only the bucket and content hash in vector metadata.

During a model change, a job from the previous deployment can pass its
freshness check, then overwrite the current model's acknowledged vector and
lose its upsert response. D1 keeps the current marker, the vector matches
its bucket and content, and inspection accepts it indefinitely. Meaning
search stays available but loses recall for that memory
([issue #58](https://github.com/taecontrol/nook/issues/58)).

The marker cannot detect this: it records what the last acknowledged write
claimed, not what the index holds. Only the vector itself can say which
model produced it. Vectors written before this decision, and those written
by a previous Worker still running during a deploy, carry no model.

## Decision

Every vector records the model that produced its values in its metadata.
Inspection treats a vector as consistent only when its bucket, content hash
and model all match the inspecting Worker's. A vector without a model is
inconsistent: its marker is invalidated and scheduled repair re-embeds it
with the current model.

Treating an unknown model as current was rejected. It would avoid one
re-embedding of the corpus, but it would accept exactly the late writer
this decision exists to catch whenever the previous Worker predates model
metadata, and it would never repair a vector already corrupted by an earlier
model change.

The model is not a filter in index queries. D1 remains the authority for
visibility, so a vector from another model can only lower recall, which
inspection repairs; filtering would also need a new metadata index and would
hide unmarked vectors until they are re-embedded.

## Consequences

Late writes from any previous model converge through scheduled inspection
alone, with or without their response, and D1 needs no migration.

The first deployment with model metadata re-embeds every memory once, at the
existing bounds of 50 inspected and 50 repaired memories per scheduled run,
so the whole corpus takes about one run per fifty memories. Until a vector
is replaced it keeps serving meaning search, because invalidating a marker
does not remove the vector. A previous Worker still running during that
deploy ignores the extra metadata and keeps inspecting as before; its writes
without a model are re-embedded by the new Worker.

Two deployments with different models that stay live together for long, as
in a gradual rollout, keep invalidating each other's vectors, as their
markers already did. Changing the model remains a configuration change that
re-embeds the corpus.

## References

- [ADR-0013: Derived search indexes](0013-search-indexes-derive-from-d1-and-converge-eventually.md)
- [ADR-0014: Read-version guards and index inspection](0014-memory-updates-are-guarded-by-the-read-version-and-recognized-by-current-content.md)
- [Late write from a previous model, issue #58](https://github.com/taecontrol/nook/issues/58)
