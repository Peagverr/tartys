import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Относительные пути — сборка работает и на GitHub Pages, и в любой подпапке.
  base: './',
  server: {
    host: true,
    // В разработке API и комнаты обслуживает wrangler dev (npm run dev:worker).
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
  build: { target: 'es2022' },
  test: { include: ['tests/**/*.test.ts'] },
});
