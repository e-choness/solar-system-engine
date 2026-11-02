import { readFileSync } from 'node:fs';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const inDocker = Boolean(process.env.DOCKER);

/** three's Basis Universal transcoder, which KTX2Loader fetches by these fixed names. */
const BASIS = new URL('./node_modules/three/examples/jsm/libs/basis/', import.meta.url);
const BASIS_FILES: Record<string, string> = {
  'basis_transcoder.js': 'text/javascript',
  'basis_transcoder.wasm': 'application/wasm',
};

/** Serves the transcoder at basis/ and ships it there, always matching the installed three. */
function basisTranscoder(): Plugin {
  return {
    name: 'basis-transcoder',
    configureServer(server) {
      server.middlewares.use('/basis', (req, res, next) => {
        const name = (req.url ?? '').slice(1).split('?')[0];
        if (!(name in BASIS_FILES)) return next();
        res.setHeader('Content-Type', BASIS_FILES[name]);
        res.end(readFileSync(new URL(name, BASIS)));
      });
    },
    generateBundle() {
      for (const name of Object.keys(BASIS_FILES)) {
        this.emitFile({ type: 'asset', fileName: `basis/${name}`, source: readFileSync(new URL(name, BASIS)) });
      }
    },
  };
}

export default defineConfig({
  // itch.io serves HTML5 games from a nested path, so every URL must be relative.
  base: './',
  plugins: [svelte(), basisTranscoder()],
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
