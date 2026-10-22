import { D1Client } from '@effect/sql-d1';
import { Effect } from 'effect';
import { type FileBindings, fileNow, fileObjects } from './file-objects.ts';
import { unavailable } from './http-errors.ts';

const graceMs = 60 * 60 * 1000;
export const fileSweep = (bindings: FileBindings) =>
  Effect.gen(function* () {
    const sql = yield* D1Client.D1Client;
    const objects = fileObjects(bindings);
    const rows = yield* sql<{
      cursor: string | null;
    }>`SELECT cursor FROM file_sweep WHERE id=1`.pipe(unavailable);
    const cursor = rows[0]?.cursor ?? undefined;
    const page = yield* objects.list(cursor).pipe(Effect.result);
    if (page._tag === 'Failure') {
      if (cursor && page.failure._tag === 'InvalidFileCursor')
        yield* sql`UPDATE file_sweep SET cursor=NULL WHERE id=1`.pipe(
          unavailable,
        );
      return;
    }
    const now = fileNow(bindings);
    const candidates = page.success.objects.filter(
      (object) => object.uploaded.getTime() < now - graceMs,
    );
    for (let offset = 0; offset < candidates.length; offset += 90) {
      const keys = candidates
        .slice(offset, offset + 90)
        .map((object) => object.key);
      const referenced = yield* sql<{
        object_key: string;
      }>`SELECT object_key FROM memory_files WHERE ${sql.in('object_key', keys)}`.pipe(
        unavailable,
      );
      const live = new Set(referenced.map((row) => row.object_key));
      // Uploads older than grace cannot publish: D1 enforces the shorter window,
      // and no other operation can reuse any of these keys.
      yield* objects.remove(keys.filter((key) => !live.has(key)));
    }
    yield* sql`INSERT INTO file_sweep(id,cursor,swept_at) VALUES(1,${page.success.cursor},${new Date(now).toISOString()}) ON CONFLICT(id) DO UPDATE SET cursor=excluded.cursor,swept_at=excluded.swept_at`.pipe(
      unavailable,
    );
  });
