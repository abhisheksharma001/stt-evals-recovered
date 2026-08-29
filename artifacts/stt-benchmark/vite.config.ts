import path from 'path';
import { execFileSync } from 'node:child_process';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

// PORT/BASE_PATH used to be hard requirements (Replit-shaped). They are now
// optional with laptop/Vercel-friendly defaults so the same config builds
// anywhere; Replit deployments keep injecting both and behave identically.
const port = (() => {
  const rawPort = process.env.PORT;
  if (!rawPort) return 5173;
  const parsed = Number(rawPort);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`Invalid PORT value: "${rawPort}"`);
  }
  return parsed;
})();

const basePath = process.env.BASE_PATH ?? '/';

// T-39: stamp the UI bundle with the commit it was built from, the same way
// artifacts/api-server/build.mjs stamps the API. The badge in layout.tsx
// shows both when they disagree, which is what a browser serving a stale
// cached UI against a freshly restarted API looks like -- previously
// invisible. "dev" under the dev server; "-dirty" when the tree had
// uncommitted changes; "unknown" outside a git checkout.
const readGit = (args: string[], fallback: string) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return fallback;
  }
};
const uiCommit = readGit(['rev-parse', '--short=12', 'HEAD'], 'unknown');
const uiBuildCommitSha =
  uiCommit === 'unknown' ? 'unknown' : readGit(['status', '--porcelain'], '') !== '' ? `${uiCommit}-dirty` : uiCommit;

export default defineConfig(async ({ command }) => ({
  base: basePath,
  define: {
    __UI_BUILD_COMMIT_SHA__: JSON.stringify(command === 'build' ? uiBuildCommitSha : 'dev'),
  },
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== 'production' &&
    process.env.REPL_ID !== undefined
      ? [
          await import('@replit/vite-plugin-cartographer').then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, '..'),
            }),
          ),
          await import('@replit/vite-plugin-dev-banner').then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    fs: {
      strict: true,
    },
    // Local dev only: the app calls relative `/api/...` (see orval.config.ts
    // baseUrl), which needs same-origin. In Replit's deployment the API and
    // this app are served behind one router; for `pnpm dev` on a laptop
    // there's no such router, so proxy /api to the API server directly.
    ...(process.env.API_PROXY_TARGET
      ? {
          proxy: {
            '/api': {
              target: process.env.API_PROXY_TARGET,
              changeOrigin: true,
            },
          },
        }
      : {}),
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
}));
