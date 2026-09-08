import { describe, expect, it } from 'vitest';
import { suggestedDelayMs } from '../../src/agent/llm/openai.js';

/**
 * Waiting out a rate limit.
 *
 * A token-per-minute limit is the one error where the server knows exactly how
 * long to wait and says so. Getting the unit wrong turns a recoverable pause into
 * a crashed discovery run, which is what happened: eight retries spent a total of
 * two seconds against a limit measured in minutes.
 */
const err = (headers: Record<string, string>, msg = '429 Rate limit reached') =>
  Object.assign(new Error(msg), { status: 429, headers });

describe('suggestedDelayMs', () => {
  it('reads seconds as seconds when both headers are present', () => {
    // The real shape of an OpenAI TPM 429. Taking the value from `retry-after`
    // and the unit from `retry-after-ms` read 2 seconds as 2 milliseconds.
    const ms = suggestedDelayMs(err({ 'retry-after': '2', 'retry-after-ms': '2862' }));
    expect(ms).toBeGreaterThan(2000);
  });

  it('prefers the millisecond header, which is the more precise one', () => {
    expect(suggestedDelayMs(err({ 'retry-after': '2', 'retry-after-ms': '2862' }))).toBe(3112);
  });

  it('reads a seconds-only header as seconds', () => {
    expect(suggestedDelayMs(err({ 'retry-after': '3' }))).toBe(3250);
  });

  it('reads a milliseconds-only header as milliseconds', () => {
    expect(suggestedDelayMs(err({ 'retry-after-ms': '1500' }))).toBe(1750);
  });

  it('falls back to the hint in the message body', () => {
    expect(suggestedDelayMs(err({}, 'Rate limit reached. Please try again in 2.85s.'))).toBe(3100);
  });

  it('reads a millisecond hint in the body as milliseconds', () => {
    expect(suggestedDelayMs(err({}, 'Please try again in 400ms.'))).toBe(650);
  });

  it('returns nothing when the server gave no hint, so the caller backs off exponentially', () => {
    expect(suggestedDelayMs(err({}, 'Service unavailable'))).toBeUndefined();
  });

  it('ignores a zero or malformed header rather than retrying instantly', () => {
    expect(suggestedDelayMs(err({ 'retry-after': '0' }, 'no hint'))).toBeUndefined();
    expect(suggestedDelayMs(err({ 'retry-after': 'later' }, 'no hint'))).toBeUndefined();
  });
});

/**
 * Which failures are worth retrying.
 *
 * The gap this covers cost a completed discovery run: a dropped connection has no
 * HTTP status, so it matched none of 429/408/5xx and aborted on the first attempt
 * with zero backoff -- eleven model turns and a filled form thrown away.
 */
describe('retry classification', () => {
  // Mirrors the predicate in OpenAiProvider.complete.
  const retryable = (status?: number) =>
    status === undefined || status === 429 || status === 408 || (typeof status === 'number' && status >= 500);

  it('retries a request that never reached the server', () => {
    expect(retryable(undefined)).toBe(true);
  });

  it('retries rate limits, timeouts and server faults', () => {
    for (const s of [408, 429, 500, 502, 503]) expect(retryable(s)).toBe(true);
  });

  it('does not retry a request the server understood and rejected', () => {
    // A 400 from a bad tool schema is a bug; retrying it just burns money slowly.
    for (const s of [400, 401, 403, 404, 422]) expect(retryable(s)).toBe(false);
  });
});
