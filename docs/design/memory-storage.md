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
- **#12:**
  - An update that collides with another memory's current content is rejected with an error naming that memory.
  - Whether omitted tags copy the current tags is still open.
- **Untrusted client strings:** User-Agent strings from other clients are bounded and filtered for control characters.
- **ADR candidate:** the rationale for "content identity instead of a write id" and for recording `workingDirectory` instead of the repository that ADR-0004 mentions.
