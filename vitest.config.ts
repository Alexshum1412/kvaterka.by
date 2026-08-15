import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    // Integration tests spin up an in-process PostgreSQL (PGlite) per file.
    // Keep them isolated but allow parallelism across files.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: false },
    },
  },
});
