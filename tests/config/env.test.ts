import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnvFile } from '../../src/config/env.js';

/**
 * The README's first setup step is `cp .env.example .env`, and `.env.example`
 * documents every variable with an inline comment. A loader that cannot strip those
 * comments turns the documented happy path into a confusing failure -- and one that
 * only shows up on `discover`, because replay never reads the affected variable.
 */
const touched: string[] = [];
async function load(contents: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'lh-env-'));
  const file = join(dir, '.env');
  await writeFile(file, contents, 'utf8');
  await loadEnvFile(file);
}
afterEach(() => {
  for (const k of touched.splice(0)) delete process.env[k];
});

describe('loadEnvFile', () => {
  it('strips an inline comment from an unquoted value', async () => {
    touched.push('LH_TEST_PROVIDER');
    await load('LH_TEST_PROVIDER=openai            # openai | anthropic | replay\n');
    expect(process.env.LH_TEST_PROVIDER).toBe('openai');
  });

  it('keeps a hash that is part of the value', async () => {
    // A password or URL fragment may legitimately contain '#'.
    touched.push('LH_TEST_SECRET');
    await load('LH_TEST_SECRET=p@ss#word\n');
    expect(process.env.LH_TEST_SECRET).toBe('p@ss#word');
  });

  it('leaves a quoted value untouched, comment marker and all', async () => {
    touched.push('LH_TEST_QUOTED');
    await load('LH_TEST_QUOTED="value # not a comment"\n');
    expect(process.env.LH_TEST_QUOTED).toBe('value # not a comment');
  });

  it('ignores whole-line comments and blanks', async () => {
    touched.push('LH_TEST_AFTER');
    await load('# a heading\n\n   \nLH_TEST_AFTER=ok\n');
    expect(process.env.LH_TEST_AFTER).toBe('ok');
  });

  it('does not override a variable already set in the environment', async () => {
    touched.push('LH_TEST_PRESET');
    process.env.LH_TEST_PRESET = 'from-shell';
    await load('LH_TEST_PRESET=from-file\n');
    expect(process.env.LH_TEST_PRESET).toBe('from-shell');
  });
});
