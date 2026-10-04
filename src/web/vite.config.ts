import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const isProd = process.env.NODE_ENV === 'production';

export default defineConfig({
  root: '.',
  // The FastAPI app mounts StaticFiles at /static -> src/web, and the Vite
  // build output lives at src/web/dist/. Base must be '/static/dist/' so
  // ?url asset imports (sql.js wasm) resolve to the real file location.
  base: '/static/dist/',

  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src'),
    },
  },

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Ship sourcemaps in dev builds only. Prod strips ~744 KB.
    sourcemap: !isProd,
    // Vite 8 (rolldown-powered) minifies with oxc by default; the old
    // `minify: 'esbuild'` route now requires esbuild installed separately and
    // leans on the deprecated transformWithEsbuild API. Let the default ride.
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'src/main.ts'),
      },
      output: {
        entryFileNames: 'app.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
        // Group modules into cacheable chunks aligned with feature folders so
        // a change in one page does not invalidate the whole bundle.
        manualChunks(id) {
          if (!id.includes('/src/web/src/')) return undefined;
          // The lazy debt dialogs (and the form fields they share with the Debts
          // page) are left to automatic splitting. Forcing them into named groups
          // made rolldown fold the shared code into a dialog chunk, which the Debts
          // page then had to load at startup.
          if (/\/src\/web\/src\/features\/debt-(form|convert|wizard)/.test(id)) return undefined;
          // The same holds for the lazy import wizard and the lazy Budget import cards,
          // which share the import render helpers: grouped, the helpers landed in the
          // wizard chunk and opening Budget loaded the whole wizard.
          if (
            /\/src\/web\/src\/(features\/smart-import|pages\/budget-smart-import|utils\/smart-import-(render|state))/.test(
              id
            )
          ) {
            return undefined;
          }
          if (id.includes('/src/web/src/pages/')) {
            const match = id.match(/\/pages\/([^/]+)/);
            if (match) return `page-${match[1]}`;
          }
          if (id.includes('/src/web/src/features/')) {
            const match = id.match(/\/features\/([^/]+)/);
            if (match) return `feature-${match[1]}`;
          }
          if (
            id.includes('/src/web/src/charts/') ||
            id.includes('/src/web/src/ui/') ||
            id.includes('/src/web/src/state/') ||
            id.includes('/src/web/src/api/') ||
            id.includes('/src/web/src/database/') ||
            id.includes('/src/web/src/utils/')
          ) {
            return 'shared';
          }
          return undefined;
        },
      },
      external: [
        // Keep CDN dependencies external - they're loaded via script tags
      ],
    },
  },

  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },

  define: {},
});
