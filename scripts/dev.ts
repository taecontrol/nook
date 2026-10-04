import { buildProduct } from './build.ts';

await buildProduct();
process.env.NOOK_BUILD = 'dist';
await import('./serve.ts');
