import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { cn } from 'cn/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'apps/web',
  plugins: [
    react(),
    tailwindcss(),
    cn({ out: resolve('.local/cn-tables.mjs') }),
  ],
  resolve: {
    alias: [
      { find: '@', replacement: resolve('apps/web/src') },
      { find: /^cn$/, replacement: resolve('apps/web/src/lib/classes.ts') },
      {
        find: 'virtual:cn-tables',
        replacement: resolve('.local/cn-tables.mjs'),
      },
    ],
  },
  build: { outDir: resolve('dist/assets'), emptyOutDir: true },
});
