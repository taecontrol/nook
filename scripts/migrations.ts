import { startHostIsolation } from './lib/host-isolation.ts';
import { verifyMemoryFilesMigrations } from './lib/memory-files-migrations.ts';
import { verifyMigrations } from './lib/migrations.ts';

const isolation = await startHostIsolation();
try {
  console.log(
    JSON.stringify(
      {
        ...(await verifyMigrations()),
        ...(await verifyMemoryFilesMigrations()),
      },
      null,
      2,
    ),
  );
} finally {
  await isolation.close();
}
