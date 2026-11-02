import { readFileSync } from 'node:fs';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const inDocker = Boolean(process.env.DOCKER);

export default defineConfig({
  // itch.io serves HTML5 games from a nested path, so every URL must be relative.
  base: './',
  plugins: [svelte()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  },
  server: {
    host: true,
    port: 5173,
    // The browser container reaches the dev server by its compose alias.
    allowedHosts: ['solar-dev'],
    watch: {
      // Tool scratch (trailer frames, raw downloads): polling thousands of files there slows every
      // response, and a stray .html file would reload the page mid-capture.
      ignored: ['**/.cache/**', '**/.asset-cache/**'],
      // Bind mounts from a Windows/macOS host don't emit inotify events inside the container.
      ...(inDocker && { usePolling: true, interval: 250 }),
    },
  },
  build: {
    target: 'es2023',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1500,
    reportCompressedSize: false,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
