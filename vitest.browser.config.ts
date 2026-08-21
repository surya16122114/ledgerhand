import { defineConfig } from 'vitest/config';

/** Perception tests against a real browser and the running target app. */
export default defineConfig({
  test: {
    include: ['tests/browser/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Perception mutates the page (it stamps ref attributes), so these share one
    // browser session and must not interleave.
    fileParallelism: false,
  },
});
