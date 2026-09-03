/**
 * Minimal .env loader.
 *
 * Node 20 has `--env-file`, but relying on it would mean every invocation needs a
 * flag, and the CLI is meant to be runnable as `npm run replay -- ...`. Existing
 * environment variables always win, so CI and a shell export both override the
 * file rather than being silently replaced by it.
 */

import { readFile } from 'node:fs/promises';

export async function loadEnvFile(path: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return; // no .env is a perfectly normal state
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
    if (quoted) {
      value = value.slice(1, -1);
    } else {
      // Strip a trailing inline comment from an unquoted value.
      //
      // `.env.example` documents each variable inline -- `LLM_PROVIDER=openai  # openai
      // | anthropic | replay` -- and the README's first setup step is
      // `cp .env.example .env`. Without this, following the documented setup makes the
      // provider name the entire string including the comment, and discovery fails with
      // "unknown provider 'openai            # openai | ...'".
      //
      // Only ` #` (whitespace then hash) counts as a comment, so a value that legitimately
      // contains a hash -- a password, a URL fragment -- survives intact. Quoted values are
      // never touched.
      const comment = value.search(/\s#/);
      if (comment !== -1) value = value.slice(0, comment).trimEnd();
    }
    process.env[key] = value;
  }
}
