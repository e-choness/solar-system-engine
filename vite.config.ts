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
    // Bind mounts from a Windows/macOS host don't emit inotify events inside the container.
    watch: inDocker ? { usePolling: true, interval: 250 } : undefined,
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
