import { verifyMigrations } from './lib/migrations.ts';

console.log(JSON.stringify(await verifyMigrations(), null, 2));
