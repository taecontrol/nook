# Memory storage and MCP contract

Status: Accepted, 2026-10-09, by the owner. Grounded on commit `abae34e`.
Applies to issue #10 and constrains #11 (search), #12 (update and history), and #13 (forget).
Retire this brief once its decisions live in code, tests, `docs/`, and an ADR.

## Problem and scope

Memory needs persisted rows, MCP write and read tools, and an owner read API. All of them are costly to reverse. This brief fixes:

- the D1 schema;
- the `remember` and `get` contract, including retries and concurrent writers;
- provenance capture;
- the owner list and detail API;
- the bucket deletion guard.

It does not cover web rendering, search, update, or forget, beyond what each of those needs from the schema.

## Grounding

- **ADRs:** buckets and ancestor reads come from ADR-0002, and the minimal model with explicit writes and hard delete from ADR-0004. ADR-0007 sets up D1 with atomic batches and no transactions, and ADR-0008 lets empty buckets be deleted. ADR-0009 serves a fresh `McpServer` per request, and ADR-0010 keeps machine tokens under `/api/machine/*`.
- **Spike, 2026-10-09:**
  - Claude Code 2.1.295 sends `_meta["io.modelcontextprotocol/clientInfo"]` on every request. The SDK exposes it in a tool handler as `ctx.mcpReq.envelope`.
  - Codex 0.162.0 speaks protocol 2025-06-18. It sends `clientInfo` only on `initialize`, which a stateless server does not see, and sends `User-Agent: codex-mcp-client/0.162.0` on every request.
- **Current code:**
  - `machineMcpHandler` authenticates with `whoami` and drops the machine id and name. `forAudit` returns `{id, machine, grant}`.
  - The Vault create path already uses the batch-plus-state-select pattern that `remember` reuses.
- **Arena:** two independent candidates and a cross-judge. Working material lived in `.work/arena/`.

## Domain meaning (accepted by the owner)

- **Memory:** a memory has an id and lives in one bucket. It has Markdown content, tags, versions, and provenance. There is no title field. The title is derived from the content for display.
- **Content:** must be non-empty after trimming, at most 16 KiB of UTF-8, and free of NUL and lone surrogates. It is stored byte for byte.
- **Tags:** 0 to 10 per memory, with no duplicates. Each tag follows the bucket-segment grammar: lowercase letters, digits, and single hyphens, 1 to 32 characters. Uppercase is rejected with a lowercase suggestion.
- **Provenance** is recorded per version:
  - The client, as the client reports it: the envelope `clientInfo` name and version, otherwise the first `User-Agent` product token split at `/`, otherwise `unknown`. Only well-formed strings without control characters are used, within the length bounds.
  - The principal, which comes only from authentication. It is either a machine, with its id and a snapshot of its name, or the owner.
  - An optional absolute `workingDirectory`, validated with `validateWorkingDirectory`.
  - The server time.
- **Exact-duplicate guard:** if the bucket already has a memory whose current content is byte-identical, `remember` returns that memory with `created: false` and writes nothing. It does not merge or change tags.
- **Reads and denials:** `get` for an id that is missing, malformed, or outside the read grant returns "Memory not found." `remember` outside the write grant returns "Access to this bucket is forbidden.", and into a missing bucket returns "Bucket not found."
- **Bucket deletion:** a bucket with memories cannot be deleted. The error is "Delete its memories first." (409). When several blockers apply, they are reported in this order: children, then secrets, then memories.

## Caller usage

```jsonc
// MCP tools/call remember (owner /mcp or machine /api/machine/mcp)
{ "bucket": "work/acme", "content": "# Release process\n…", "tags": ["deploy"],
  "workingDirectory": "/Users/luis/code/acme-api" }
// → structuredContent
{ "created": true, "id": "5f0c…", "bucket": "work/acme", "version": 1,
  "tags": ["deploy"], "createdAt": "2026-10-09T14:02:11.482Z" }
// The same call after a lost response, even with other tags → same id, "created": false, stored tags
// A machine granted ["work"] calling remember in "personal" → isError, "Access to this bucket is forbidden."
// get({ id }) → { id, bucket, content, tags, version, createdAt, updatedAt, provenance }
```

Owner HTTP API, owner-only and outside `/api/machine/*`:

- `GET /api/memories?bucket=work/acme[&cursor=…]` returns `{ memories: MemoryListItem[], next: string | null }`.
  - The page covers the bucket, its ancestors, and `me`, intersected with the read grant. It never includes siblings or descendants.
  - Items are ordered newest first by `(created_at DESC, id DESC)`, 25 per page.
  - Each item carries its bucket, a derived title, tags, and provenance. Items do not include content.
  - The cursor is opaque. It binds the bucket and the last ordering pair. A malformed cursor, or one that does not match the bucket, returns 400 `InvalidMemoryCursor`.
- `GET /api/memories/:id` returns the full memory. A missing id, or one outside the grant, returns 404.

## Architecture shape

| Owner | Owns |
|---|---|
| `packages/contract/src/memory.ts` | Limits, `validateMemoryContent`, `validateTags`, `memoryTitle`, schemas (`Remember`, `Remembered`, `Memory`, `MemoryListItem`, `Provenance`, `Principal`), and errors (`InvalidMemory` 400, `MemoryNotFound` 404, `BucketHasMemories` 409, `InvalidMemoryCursor` 400) |
| `packages/contract/src/buckets.ts` | `readLineage(bucket)`: the bucket, then its ancestors, then `me`. `secretLineage` delegates to it |
| `apps/worker/src/memory.ts` | `memoryStore(grant)`: `remember(principal, client, input)`, `get(id)`, and `list(bucket, cursor?)`. This module holds the only SQL that touches the memory tables. It owns grant checks, validation, hashing, the batch, outcome classification, lineage, and cursors |
| `apps/worker/src/mcp.ts` | The `remember` and `get` tools. `clientFrom(envelope, userAgent)` reads the raw `Request` header before SDK dispatch. `mcpHandler(db, caller)` takes `caller = {grant, principal}` |
| `apps/worker/src/machine-routes.ts` | Authenticates with `forAudit` so it can pass `{kind: 'machine', id, name}` |
| `apps/worker/src/buckets.ts` | Extends the guarded DELETE and its classification batch with memories |
| `apps/worker/src/index.ts` | The `memories` HTTP group, `knownRoute`, and the 400 allowlist in `sanitized` (`InvalidMemory`, `InvalidMemoryCursor`) |

Tool inputs never carry the principal or the client. `memoryStore` receives them as arguments.

### Migration `0009_memories.sql` (sketch)

```sql
CREATE TABLE memories (
  seq INTEGER PRIMARY KEY,                 -- internal; reserved as FTS5 content_rowid for #11
  id TEXT NOT NULL UNIQUE CHECK (length(id) = 36),
  bucket TEXT NOT NULL REFERENCES buckets(path) ON DELETE RESTRICT,
  current_version INTEGER NOT NULL CHECK (current_version >= 1),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX memories_current_content ON memories(bucket, content_hash);  -- the duplicate guard; droppable
CREATE INDEX memories_feed ON memories(bucket, created_at DESC, id DESC);
CREATE TABLE memory_versions (             -- rowid table: rows up to 16 KiB
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  content TEXT NOT NULL CHECK (length(CAST(content AS BLOB)) BETWEEN 1 AND 16384),
  tags TEXT NOT NULL CHECK (json_valid(tags) AND json_type(tags) = 'array' AND json_array_length(tags) <= 10),
  client_name TEXT NOT NULL CHECK (length(client_name) BETWEEN 1 AND 128),
  client_version TEXT CHECK (client_version IS NULL OR length(client_version) BETWEEN 1 AND 64),
  principal TEXT NOT NULL CHECK (principal IN ('machine', 'owner')),
  machine_id TEXT,                         -- no FK: provenance survives revocation
  machine_name TEXT,                       -- snapshot, as in audit_entries
  working_directory TEXT,
  created_at TEXT NOT NULL,
  CHECK ((principal = 'machine' AND machine_id IS NOT NULL AND machine_name IS NOT NULL)
      OR (principal = 'owner' AND machine_id IS NULL AND machine_name IS NULL)),
  UNIQUE (memory_id, version)
);
```

Identity:

- A memory id is a lowercase UUID v4 that the Worker mints. It never changes.
- A version is identified by `(memory_id, version)` and numbered from 1.
- `content_hash` is the SHA-256 hex digest of the content's exact UTF-8 bytes. It always describes the current version.
- `seq` is never exposed.

### `remember`: one atomic batch

1. Insert the head row only if the bucket exists:

   ```sql
   INSERT INTO memories … SELECT … WHERE EXISTS (bucket) ON CONFLICT(bucket, content_hash) DO NOTHING RETURNING id
   ```

2. Insert version 1 with `SELECT … FROM memories WHERE id = :mintedId`. This statement is inert when step 1 inserted nothing, so it does not depend on `changes()`.
3. Read the state:

   ```sql
   SELECT has_bucket, m.id, m.current_version, m.created_at, v.content, v.tags
     FROM (SELECT 1)
     LEFT JOIN memories m        ON m.bucket = :bucket AND m.content_hash = :hash
     LEFT JOIN memory_versions v ON v.memory_id = m.id AND v.version = m.current_version
   ```

The outcome follows from the results:

- If step 1 returned a row, the result is `created: true`.
- Otherwise, if step 3 found a row whose content is byte-equal to the input, the result is `created: false` with the stored tags.
- Otherwise, if the bucket is missing, the result is `BucketNotFound`.
- Otherwise the hash collided, and the result is `ServiceUnavailable`.

## Hidden complexity

- **`memoryStore`:** it hides hashing, the batch and its classification, current-version joins, lineage ordering, cursor encoding, and title derivation. Callers express intent only.
- **The MCP adapter:** it hides the two protocol revisions and where the client name comes from.
- **The contract:** it hides the validation grammar. It reuses the bucket-segment grammar and the uppercase suggestion.

## Failure behavior

- **Lost response:** the retry hits the unique index and returns the same id with `created: false`.
- **Concurrent identical writers:** D1 serializes the batches, so exactly one call gets `created: true` and both return the same id. Concurrent writers with different content both create.
- **Bucket deleted concurrently:** when `remember` runs first, the delete fails with "Delete its memories first." When the delete runs first, `remember` fails with "Bucket not found." No orphans remain, and the foreign key backs this up.
- **Revoked machine:** the request fails with 401 before the SDK runs. Stored provenance keeps the name snapshot.
- **D1 unavailable:** the tool returns "Service unavailable. Try again later." The outcome is unknown, and the tool description says retrying is safe. Errors never echo content.

## Alternatives and tradeoffs

- **Client write id (ADR-0011 style):** rejected. Models regenerate tool calls and do not preserve an id across retries.
- **"Current = highest version", with no head row:** rejected. The guard would live in a correlated query instead of a constraint, and FTS5 would have no stable integer key.
- **A single table with an `is_current` flag:** rejected. It repeats the bucket on every version and flips mutable rows.
- **`UNIQUE(bucket, content)` without a hash:** rejected. Its index keys would reach 16 KiB.
- **Returning the full memory from `remember`:** rejected. It costs agent context, and `get` already exists for that.
- **Accepted costs:**
  - `x` and `x\n` are different memories.
  - A bucket with memories cannot be deleted until #13 ships.
  - The list costs one join per item to derive titles, using `substr(content, 1, 512)`.

## Synthesis provenance

- **Base:** candidate A (Claude).
- **Grafts from candidate B (GPT):**
  - feed ordered by `created_at` so updates do not move items between pages;
  - an opaque cursor bound to the bucket;
  - re-checking scope and the current version in D1 after each Vectorize hit (#11).
- **Fixes from the cross-judge:**
  - the unique guard is a separate index, so it can be dropped without a table rebuild;
  - `memory_versions` is a rowid table rather than `WITHOUT ROWID`;
  - A's FTS5 clause, which combined `content=''` with `content_rowid`, was contradictory and is deferred to #11.
- **Decided on the owner's behalf as reversible:**
  - The owner principal is stored as kind only, without the email.
  - The page size is a fixed 25, with no `limit` parameter.

## Implementation contract

**Preserve:**

- the tables, columns, constraints, and indexes above;
- the UUID ids minted by the Worker;
- the duplicate guard enforced by the unique index;
- the single-batch `remember`;
- the outcome set and the error wording;
- the provenance sources and the rule that tool inputs cannot set provenance;
- the denial wording;
- feed order and paging semantics;
- the bucket-deletion order;
- `schema.sql` updated as the drift snapshot.

**Free to choose:**

- module-internal helpers and the exact SQL text;
- how the cursor is encoded;
- the tool description wording, which must still say to name the bucket explicitly, to ask the owner when unsure, and that retrying is safe;
- the tool annotations: `remember` has `idempotentHint: true` and `destructiveHint: false`, and `get` has `readOnlyHint: true`.

**Validation obligations:**

- An MCP driver test against Miniflare on both protocol shapes and both endpoints. It must cover:
  - the round trip;
  - the three client-name fallbacks;
  - retry returning `created: false`;
  - N parallel identical writers producing exactly one `created: true`;
  - writes outside the grant returning Forbidden;
  - a sibling `get` returning not found;
  - an ancestor `get` being allowed;
  - the 16384/16385-byte content boundary with multibyte characters;
  - the tag grammar;
  - a revoked token leaving the row count unchanged;
  - D1 failure.
- HTTP tests for:
  - lineage and labels;
  - cursor paging with no gaps;
  - cursor tampering;
  - a narrowed grant;
  - a 404 detail;
  - a 409 bucket delete through HTTP and MCP;
  - the delete-against-remember race;
  - a direct DELETE of a bucket row that still has memories failing on the foreign key;
  - a unique-index violation path.
- Migration ordering and drift.

**Re-enter design if:**

- D1 rejects the batch shape or does not enforce foreign keys;
- an update policy in #12 needs duplicate current content;
- #11 needs a different integer key.

## Open risks

- **#11:** the FTS5 external-content table needs `content=<view over current versions>` with `content_rowid=seq`. Spike it against D1's SQLite version before #11. Vectorize metadata stores a hash of the bucket path, because the path can exceed the 64-byte index prefix.
- **#12:** resolved in [Update and history (#12)](#update-and-history-12).
- **Untrusted client strings:** User-Agent strings from other clients are bounded and filtered for control characters.
- **ADR candidate:** the rationale for "content identity instead of a write id" and for recording `workingDirectory` instead of the repository that ADR-0004 mentions.

## Update and history (#12)

Status: Accepted, 2026-10-13, by the owner. Grounded on commit `0a24f2c`. Retire with the rest of this brief once its decisions live in code, tests, `docs/`, and ADR-0014.

### Problem and scope

Agents need to replace a memory's content when a fact changes, and the owner needs to see the earlier versions. This section fixes the MCP `update` contract, its retry and concurrency behavior, how it keeps the duplicate guard (ADR-0012) and both search derivatives (ADR-0013) correct, and the owner-only history read. It does not cover forget (#13), moving memories between buckets, owner editing or restoring, or a version cap.

### Domain meaning (accepted by the owner)

- An update creates version n+1 with its own provenance, from the same sources as `remember`. Version rows are immutable. The id, bucket, and `createdAt` never change. Reverting to an earlier version's text is a new version.
- **Concurrency:** `update` requires the version the caller read. When the current version differs, nothing changes and the caller must `get` again.
- **Retry identity:** when the current content is byte-identical to the request and the resulting tags equal the current tags (as JSON arrays, in order), the update already happened. It succeeds with `updated: false`, writes nothing, and keeps the current provenance, even when `expectedVersion` is stale.
- **Tags:** omitted tags keep the current tags, and `[]` clears them. A version may change only tags.
- **Duplicates:** content byte-identical to another memory's current content in the same bucket is rejected with that memory's id. The unique index `memories_current_content` stays.
- **History is owner-only.** There is no MCP history tool and no `/api/machine/*` history route.

### Caller usage

```jsonc
// tools/call update (owner /mcp or machine /api/machine/mcp)
{ "id": "5f0c…", "expectedVersion": 2, "content": "# Release process\n…",
  "tags": ["deploy"], "workingDirectory": "/Users/luis/code/acme-api" }   // tags and workingDirectory optional
// → structuredContent
{ "updated": true, "id": "5f0c…", "bucket": "work/acme", "version": 3,
  "tags": ["deploy"], "createdAt": "2026-10-09T14:02:11.482Z", "updatedAt": "2026-10-13T10:41:07.913Z" }
```

Outcomes, in classification order:

| Condition | Result | Writes |
|---|---|---|
| Missing, malformed, or unreadable id | "Memory not found." | No |
| Readable but not writable (ancestor, `me`) | "Access to this bucket is forbidden." | No |
| Invalid input | The contract's validation message; never echoes content | No |
| Current content and resulting tags equal the request | `updated: false`, current facts | No |
| Current version differs from `expectedVersion` | `MemoryChanged` (409): "This memory changed: it is now version 3, not 2. Get it again before updating." | No |
| Another memory in the bucket has byte-identical current content | `DuplicateMemory` (409): "Memory <id> in this bucket already has this content." | No |
| Otherwise | `updated: true`, version n+1 | Yes |
| Same hash with different bytes, D1 failure, or an unexplained state | "Service unavailable. Try again later." Outcome unknown; retrying identical input is safe | Unknown |

A retry after an unconfirmed attempt answers from the current state. If another writer changed the memory in between, the retry gets `MemoryChanged` even though the first attempt may have committed; the tool description says so. `update` is annotated `readOnlyHint: false`, `destructiveHint: true` (agents cannot see the replaced text), `idempotentHint: true`.

### Architecture shape

| Owner | Owns for #12 |
|---|---|
| `packages/contract/src/memory.ts` | `UpdateMemory` (`id`, `expectedVersion`, `content`, `tags?`, `workingDirectory?`), `Updated`, `MemoryChanged` 409, `DuplicateMemory` 409, the `expectedVersion` validation message, and `MemoryVersion` for the history read |
| `apps/worker/src/memory.ts` | `memoryStore.update(principal, client, input)` and `history(id)`. The only SQL touching memory tables; the guard fragments, the batch, and the classifier |
| `apps/worker/src/memory-index.ts` | `inspect(ids)` over `getByIds`, decoding vector metadata |
| `apps/worker/src/mcp.ts` | The `update` tool: schemas, description, annotations, principal and client plumbing. No policy |
| `apps/worker/src/index.ts` | Owner-only `GET /api/memories/:id/versions` |
| `migrations/` | Unchanged. No migration; `schema.sql` does not change |

`update` runs:

1. Validate the id (else "Memory not found.") and the input. Hash the content.
2. Preflight: `SELECT bucket FROM memories WHERE id = :id`. Missing or `!canRead` → not found; `!canWrite` → forbidden. Authorization stays in the shared grant functions.
3. One atomic batch, bound to the authorized bucket:
   - **S1** `INSERT INTO memory_versions … SELECT m.current_version + 1, :content, COALESCE(:tags, cur.tags), <provenance>, :now … WHERE m.id = :id AND m.bucket = :bucket AND m.current_version = :expected AND NOT <equals_request> AND NOT <duplicate_hash> AND NOT <self_collision> RETURNING version`
   - **S2** `UPDATE memories SET current_version = current_version + 1, content_hash = :hash, updated_at = :now WHERE id = :id AND current_version = :expected AND EXISTS (version row current_version + 1)` — inert unless S1 wrote.
   - **S3** the state row: `id`, `bucket`, `current_version`, timestamps, current tags, `equals_request`, `duplicate_id` (another current memory with the same hash and byte-equal content), and `hash_collision` (same hash, different bytes).
4. Classify once from the batch: S1 returned a row → `updated: true`; otherwise the order in the table above.

The guard conditions are written once as SQL fragments and used both in S1's `WHERE` and as S3's flags; TypeScript only orders the outcomes. Calls: one preflight query plus one three-statement batch for every outcome past authorization.

**Keyword index.** S1 inserts version n+1 while the head still points to n, so `memories_fts_version_insert` does not fire. S2 fires `memories_fts_current_update`, which deletes the immutable version n postings and indexes version n+1. A tags-only update follows the same path.

**Meaning index.**

- A content change moves `content_hash`, so the marker `model:old_hash` becomes outdated and the scheduled sync re-embeds; `waitUntil` re-embeds immediately when the content changed. A tags-only update keeps the marker.
- The shared `embedding` helper keeps only rows whose hash is still current before upserting, and writes the marker as `CASE WHEN content_hash = :hash THEN :marker ELSE NULL END`, so a superseded job clears the marker instead of leaving it.
- **Vector inspection (owner decision: ships in #12).** Each scheduled run, after the existing marker repair, inspects up to 50 memories whose marker is current and whose `updated_at` is older than 10 minutes, in a stateless rotating window over `seq` derived from the scheduled time. It reads their vectors with `getByIds` and clears the marker of every memory whose vector is missing or whose `contentHash` or bucket digest differs from D1. The next run's marker repair re-embeds them, within the existing 50-embedding and 32-per-chunk bounds. An inspection failure changes nothing. This makes stale vectors converge without any search request, including a job that dies between upsert and marker write and an old-Worker job during deploy.
- Search keeps re-reading every vector hit against the current hash and visible buckets in D1.

**History read (reversible).** `GET /api/memories/:id/versions` returns `{ versions: MemoryVersion[] }`, newest first, each `{ version, content, tags, provenance }`. A missing or unreadable id is 404. Paging and exact shape are implementation choices.

### Alternatives and tradeoffs

- **Database-owned publication through triggers and a migration** (candidate B): rejected. It wrote the retry rule in three places, forbade pruning, moves, and imports, and broke existing schema tests. A `BEFORE UPDATE ON memory_versions` immutability trigger is deferred to #13 or a hardening change.
- **Pre-read classification of rejections** (candidate A): rejected. It created a second decision path to save a round trip on rare outcomes.
- **Last writer wins, or client write ids:** rejected by the owner's concurrency decision and ADR-0012.
- **Per-version vector ids:** rejected. They need orphan cleanup and change the id scheme search and sync assume.
- **Accepted costs:** two round trips per update; tag equality is order-sensitive; an ABA sequence makes a stale retry answer `updated: false`, truthful about current state; a full inspection sweep takes about `ceil(N / 50)` scheduled runs.

### Synthesis provenance

Base: candidate A (Claude). Grafts from candidate B (GPT): `expectedVersion` (as Vault's `ReplaceSecret`), byte-checked duplicates, `createdAt` in `Updated`, explicit retry-after-intervention wording, bucket-only preflight with one classification, and actual-index inspection. From the cross-judge: guard fragments defined once; stateless rotating window instead of a repair table; `destructiveHint: true`. Working material: `.work/arena/memory-update/`.

### Implementation contract

**Preserve:** the contract, outcome order, and wording above; no migration; the preflight-plus-batch shape with S1 before S2; guard fragments shared by S1 and S3; authorization only through `canRead`/`canWrite`; no MCP history; marker semantics and inspection bounds; owner-only history.

**Free to choose:** helper names and exact SQL text; the tool description wording, which must say to pass the version from `get`, that omitted tags are kept and `[]` clears them, that duplicates name the other memory, and that retrying is safe but can answer "changed" after another writer; the history page shape; the inspection window arithmetic and how `getByIds` calls are chunked.

**Validation obligations:**

- MCP driver tests on both protocol shapes and both endpoints: round trip with new provenance and unchanged `createdAt`; omitted, cleared, and explicit tags; retry → `updated: false` with row counts unchanged; stale → `MemoryChanged`; stale-but-equal → `updated: false`; duplicate naming the id; forbidden ancestor and `me`; not found for sibling, missing, and malformed ids (the deny-outside-grant test); revoked token; content and tag boundaries; N distinct parallel updates → one winner; N identical → one version row; update against `remember` in both orders; D1 failure mid-batch with FTS integrity intact.
- Search: an old-only word stops matching immediately; a stale vector is filtered; sync re-embeds; a late old-content upsert after the new marker is repaired by inspection with no search request; inspection failure is harmless; the 50/32 bounds hold.
- D1 call observation: one preflight plus one three-statement batch per update past authorization.
- Owner history HTTP: newest-first versions with provenance, 404 outside the grant, machine tokens denied.

**Re-enter design if:** D1 rejects the batch shape; hosted `getByIds` does not return metadata, which its API reference says it does; or an observed agent need requires an MCP history read.

### Open risks

- Hosted `getByIds` freshness after a recent upsert is undocumented; the 10-minute settle window keeps inspection off rows still propagating. The owner verifies inspection on the deployed index after merge.
- ADR candidate: ADR-0014, "Memory updates are guarded by the read version and recognized by current content", recording the retry identity, duplicate rejection, and actual-index inspection as the meaning of ADR-0013's eventual convergence.
