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
  build: {
    outDir: resolve('dist/assets'),
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          // Group only modules the entry actually needs. New lazy pages must
          // not fragment the shell's shared dependencies into more requests.
          groups: [
            {
              name: 'initial-react',
              tags: ['$initial'],
              test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
            },
            {
              name: 'initial-vendor',
              tags: ['$initial'],
              test: /node_modules/,
            },
            { name: 'initial-app', tags: ['$initial'] },
            {
              // Small lazy icon files otherwise occupy the phone's connections
              // ahead of Vault's data. Initial icons are already grouped above.
              name: 'lazy-icons',
              test: /node_modules[\\/]lucide-react[\\/]dist[\\/]esm[\\/]icons[\\/]/,
            },
          ],
        },
      },
    },
  },
});
