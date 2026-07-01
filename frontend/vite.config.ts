import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// VITE_SUPABASE_ANON_KEY is intentionally NOT required here: a missing key
// disables the savings leaderboard at runtime (see src/lib/supabase.ts) rather
// than failing the build, so the package/app stays publishable without it.
export default defineConfig(({ mode }) => {
  // The desktop (Tauri) build runs with `--mode tauri` (see package.json
  // build:tauri). A PWA service worker inside WebView2 precaches the app shell
  // and serves it STALE across rebuilds — the "my change didn't show up" trap.
  // For the desktop build we emit a self-destroying SW: it unregisters itself
  // and clears its caches on load, so the assets bundled into the .exe are
  // always what renders. The browser build keeps the normal installable PWA.
  const isTauri = mode === 'tauri';
  const pwa = isTauri
    ? VitePWA({ selfDestroying: true })
    : VitePWA({
        registerType: 'autoUpdate',
        manifest: {
          name: 'OpenJarvis',
          short_name: 'Jarvis',
          description: 'On-device AI assistant',
          theme_color: '#161618',
          background_color: '#161618',
          display: 'standalone',
          icons: [
            { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
            { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
          navigateFallbackDenylist: [/^\/v1\//, /^\/health/, /^\/dashboard/, /^\/api\//],
        },
      });

  return {
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    plugins: [react(), tailwindcss(), pwa],
    build: {
      outDir: '../src/openjarvis/server/static',
      emptyOutDir: true,
      minify: 'esbuild',
      rollupOptions: {
        output: {
          manualChunks: {
            react: ['react', 'react-dom'],
            markdown: ['react-markdown', 'rehype-highlight', 'remark-gfm'],
            charts: ['recharts'],
            router: ['react-router'],
          },
        },
      },
    },
    server: {
      port: 5173,
      proxy: {
        '/v1': process.env.VITE_API_URL || 'http://localhost:8000',
        '/health': process.env.VITE_API_URL || 'http://localhost:8000',
        '/api': process.env.VITE_API_URL || 'http://localhost:8000',
      },
    },
  };
});
