# Operations reference

For a new installation, Access configuration, client connections, and updates,
follow [Install Nook](install.md). This reference covers operating an existing
installation.

## Retention and erasure limits

Vault stores AES-GCM ciphertext in D1. Delete and replace remove the current ciphertext, but [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) retains previous database states during its retention window. Nook does not purge that history.

Memory forgetting removes the canonical memory, all versions and keyword
postings in one atomic write. D1 can still keep deleted bytes in free pages;
`secure_delete` is unavailable. Time Travel keeps prior database states for
30 days on Workers Paid and 7 days on Free, including forgotten memories.
Nook cannot purge either. Meaning vectors are removed and their absence
confirmed after a 30-minute settle window on healthy scheduled runs. A vector
absent from Vectorize does not prove erasure from provider storage.

Attached files use R2 encryption at rest, without application-level encryption.
D1 file rows decide availability and the bucket's 1 GiB usage; each file is
limited to 25 MiB. Forget and detach remove those rows and add audit entries
atomically, so subsequent downloads cannot fetch the file. Inline object
removal follows a successful commit. If it fails or the Worker stops, the
five-minute Cron walks one R2 page per invocation and removes unreferenced
objects older than 60 minutes. Physical R2 removal can therefore take the
60-minute grace plus a complete successful sweep walk. Publication uses a
strict ten-minute D1 clock window and keys are never reused, keeping cleanup
safe against delayed writers. Provider retention remains outside Nook's
erasure guarantee.

## Memory search and capacity

Search combines exact words with meaning across the selected bucket, its ancestors, and `me`, within the caller's grant. Exact words are available when `remember` succeeds. Embeddings are written afterwards; Vectorize can take about a minute to expose them. The five-minute Cron Trigger repairs up to 50 pending or outdated memories per run, including memories stored before search was installed. Changing `EMBEDDING_MODEL` in configuration schedules re-embedding; the index still requires 1,024-dimensional vectors. Each vector records its model, and scheduled inspection re-embeds a vector from another model or none, so the first deployment that records models re-embeds every memory once, about one run per fifty memories, while existing vectors keep serving search ([ADR-0017](adrs/0017-vectors-carry-their-embedding-model-and-unknown-models-are-re-embedded.md)).

Vectorize [creates metadata indexes asynchronously](https://developers.cloudflare.com/vectorize/get-started/intro/).
Deployment waits for the string `bucket` index to appear in
`list-metadata-index`, with up to 20 checks three seconds apart. If it never
becomes ready, deployment stops before the Worker can write vectors without
indexed bucket metadata. A rerun uses the existing ready index.

Workers Paid includes the first ten million stored Vectorize dimensions,
enough for 9,765 memories at 1,024 dimensions each, less other indexes' usage;
additional dimensions are billed. The Free allowance is five million
dimensions (4,882 memories), beyond which upserts fail. See
[Vectorize pricing](https://developers.cloudflare.com/vectorize/platform/pricing/).
Pending memories remain searchable by exact words. Meaning service failures
produce an explicit incomplete-results notice. Nook does not enforce a
separate quota.

## Back up a database with full-text search

Cloudflare [does not support D1 exports containing virtual tables](https://developers.cloudflare.com/d1/best-practices/import-export-data/#known-limitations). Full `pnpm exec wrangler d1 export nook --remote --output owner-backup.sql` therefore fails while `memories_fts` exists. Time Travel remains available. For a SQL export, the owner uses a maintenance window: stop memory writes, remove only the derived search objects below, export, and immediately recreate them even if export fails.

```sql
DROP TRIGGER memories_fts_version_insert;
DROP TRIGGER memories_fts_current_update;
DROP TRIGGER memories_fts_delete;
DROP TABLE memories_fts;
DROP VIEW memory_current;
```

Execute that SQL privately in D1, then export to an owner-controlled file. Recreate the objects using [0010_memory_search.sql](../migrations/0010_memory_search.sql) **starting after its first `ALTER TABLE` statement**, including the final `rebuild`. The existing embedding marker column must not be added twice. Search is unavailable during this window; canonical memories and versions stay intact. Keep backup contents out of agent context.

After restoring the export into a new database, recreate these same derived objects, clear `memories.embedding_marker` to `NULL`, and let Cron rebuild the vectors in the correctly provisioned index. Never edit or prune version rows to rebuild search. [ADR-0013](adrs/0013-search-indexes-derive-from-d1-and-converge-eventually.md) records why both indexes are disposable while D1 remains authoritative.

## CLI keyring internals

The Secret Service item has `service=nook` and `url=<origin>`. Its label holds the machine name; its value reaches `secret-tool store` only through stdin. `$XDG_CONFIG_HOME/nook/config.json` (default `~/.config/nook/config.json`) holds only the URL. Logout clears the item only after revocation succeeds or the Worker confirms an invalid token. On macOS, a generic password has service `nook`, account `<origin>`, and the same machine-name label. `security -i` receives one quoted command on stdin, including the token; the token never enters argv. Login, identity, and logout wait up to two minutes for Keychain access. Unlock the login keychain when prompted, then try again if the command times out. The CLI opens the approval URL with `open` on macOS and `xdg-open` on Linux.

An empty or relative `XDG_CONFIG_HOME` uses the default directory. If login cannot save its keyring entry or URL, it revokes the newly issued token and clears any partial keyring entry. If revocation also fails, the CLI keeps any saved keyring entry and gives recovery guidance. Fix the configuration path and keyring, then repeat `login <origin>` to restore the URL when a saved entry exists, without creating another request; `logout` can then revoke the session.

Login and logout coordinate through a Linux abstract socket for the OS user and the actual session bus ID obtained with `dbus-send`. Equivalent bus addresses and different config directories therefore protect the same keyring. A concurrent session command reports that another command is in progress; try again after it finishes. The kernel releases the socket on exit, including a crash. It carries no credential and creates no file. On macOS, an exclusive kernel lock protects an empty `~/Library/Application Support/nook/session.lock`. It is keyed by HOME, so changing `XDG_CONFIG_HOME` cannot bypass coordination. The file stays in place; closing the descriptor or exiting, including SIGKILL, releases the lock.

`nook mcp-header` reads the keyring locally and supplies one headers JSON line
to the client without an HTTP request or credential file. Its stdout contains
the credential and must never enter a log, terminal transcript, or agent
conversation. A missing session emits no stdout and gives login guidance on
stderr. A stalled lookup stops after five seconds, before the client's helper
deadline. Each authenticated MCP request updates the machine's last use;
revocation applies on its next request.
