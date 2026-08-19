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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
