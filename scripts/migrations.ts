import { startHostIsolation } from './lib/host-isolation.ts';
import { verifyMigrations } from './lib/migrations.ts';

const isolation = await startHostIsolation();
try {
  console.log(JSON.stringify(await verifyMigrations(), null, 2));
} finally {
  await isolation.close();
}
