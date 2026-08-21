import { defineConfig } from 'vitest/config';

/**
 * Default suite: no browser, no network, no API key.
 *
 * `tests/browser` is excluded here and run by `npm run test:browser`. Not because
 * those tests are less important -- perception is the subtlest code in the project --
 * but because they need Chromium and the target app running, and a default `npm test`
 * that can fail for environmental reasons stops being trusted.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'tests/browser/**'],
  },
});
