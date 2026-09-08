import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi, statusFor, type ApiHandle, type ChatBackend } from '../../src/api/server.js';
import { validateArguments } from '../../src/api/invoke.js';
import type { CapabilityToolDefinition } from '../../src/artifact/catalog.js';

/**
 * The HTTP contract.
 *
 * The load-bearing assertion in this file is the status mapping: a business
 * outcome is 200. "No such member" is a successful interaction with the bank
 * that produced an answer the caller has to handle, and returning 404 for it
 * would collapse the exact distinction the result contract exists to preserve.
 *
 * Invocation itself is not exercised here -- it drives a real browser against a
 * live console and belongs in evidence, not in a unit suite that must run with
 * no network and no key.
 */

let api: ApiHandle;
let base: string;

const chat: ChatBackend = {
  async reply(message) {
    return { message: `echo: ${message}` };
  },
};

beforeAll(async () => {
  api = await startApi({ port: 0, chat });
  base = api.url;
});

afterAll(async () => {
  await api?.close();
});

describe('statusFor', () => {
  it('maps a business outcome to 200, not an error status', () => {
    // The single most important line in this file.
    expect(statusFor({ ok: false, outcome: { code: 'MEMBER_NOT_FOUND' } })).toBe(200);
  });

  it('maps success to 200', () => {
    expect(statusFor({ ok: true })).toBe(200);
  });

  it('maps a caller mistake to 400 and a missing capability to 404', () => {
    expect(statusFor({ ok: false, error: { code: 'INVALID_ARGUMENTS' } })).toBe(400);
    expect(statusFor({ ok: false, error: { code: 'NOT_APPROVED' } })).toBe(400);
    expect(statusFor({ ok: false, error: { code: 'NO_SUCH_CAPABILITY' } })).toBe(404);
  });

  it('maps an abandoned escalation to 409, since nobody can retry it as-is', () => {
    expect(statusFor({ ok: false, error: { code: 'ESCALATED' } })).toBe(409);
  });

  it('maps an automation failure to 502, because the upstream app is what failed', () => {
    expect(statusFor({ ok: false, error: { code: 'CHECKPOINT_FAILED' } })).toBe(502);
  });
});

describe('validateArguments', () => {
  const tool = {
    inputSchema: { type: 'object', properties: { memberId: {}, shareId: {} }, required: ['memberId'], additionalProperties: false },
  } as unknown as CapabilityToolDefinition;

  it('accepts exactly the declared arguments', () => {
    expect(validateArguments(tool, { memberId: '1', shareId: '2' })).toEqual({ ok: true });
  });

  it('names a missing required argument', () => {
    const r = validateArguments(tool, {});
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain('memberId');
  });

  it('rejects an unknown argument rather than ignoring it', () => {
    // Silently dropping it would let a caller believe it had an effect.
    const r = validateArguments(tool, { memberId: '1', typo: 'x' });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain('typo');
  });
});

describe('routes', () => {
  it('reports health without touching a browser or a model', async () => {
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
  });

  it('serves the catalog as the same typed definitions an agent receives', async () => {
    const r = await fetch(`${base}/capabilities`);
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(Array.isArray(body.capabilities)).toBe(true);
    for (const c of body.capabilities) {
      // The fields a caller needs before deciding to invoke.
      expect(c).toHaveProperty('inputSchema.properties');
      expect(c).toHaveProperty('maxRisk');
      expect(c).toHaveProperty('lifecycle.callableUnattended');
    }
  });

  it('404s an unknown capability by name', async () => {
    expect((await fetch(`${base}/capabilities/no_such_thing`)).status).toBe(404);
    const r = await fetch(`${base}/capabilities/no_such_thing/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ arguments: {} }),
    });
    expect(r.status).toBe(404);
    expect((await r.json()).error.code).toBe('NO_SUCH_CAPABILITY');
  });

  it('rejects an invocation whose arguments do not match the advertised schema', async () => {
    const list = await (await fetch(`${base}/capabilities`)).json();
    const withInputs = list.capabilities.find((c: { inputSchema: { required: string[] } }) => c.inputSchema.required.length > 0);
    if (!withInputs) return; // no committed capability takes arguments; nothing to assert
    const r = await fetch(`${base}/capabilities/${withInputs.name}/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ arguments: { definitely_not_a_real_argument: 1 } }),
    });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error.code).toBe('INVALID_ARGUMENTS');
    // The error names the contract the caller was reading.
    expect(body.error).toHaveProperty('expected.properties');
  });

  it('routes a chat message to the configured backend', async () => {
    const r = await fetch(`${base}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
    expect(r.status).toBe(200);
    expect((await r.json()).message).toBe('echo: hello');
  });

  it('requires a message', async () => {
    const r = await fetch(`${base}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
  });
});

describe('without a model configured', () => {
  it('reports chat unavailable rather than pretending to answer', async () => {
    const noChat = await startApi({ port: 0 });
    try {
      const r = await fetch(`${noChat.url}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'hi' }),
      });
      expect(r.status).toBe(501);
      expect((await r.json()).error.code).toBe('CHAT_UNAVAILABLE');
    } finally {
      await noChat.close();
    }
  });

  it('still serves the catalog, because the API does not need a key', async () => {
    const noChat = await startApi({ port: 0 });
    try {
      expect((await fetch(`${noChat.url}/capabilities`)).status).toBe(200);
    } finally {
      await noChat.close();
    }
  });
});

it('rejects request-controlled destinations before a browser receives credentials', async () => {
  const r = await fetch(`${base}/capabilities/session_sign_on/invoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ baseUrl: 'https://untrusted.example', arguments: { branch: 'MAIN-001' } }) });
  expect(r.status).toBe(400);
});

it('returns a structured error for malformed chat history', async () => {
  const r = await fetch(`${base}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'hello', history: [null] }) });
  expect(r.status).toBe(400);
});

it('lists history independently of the model and rejects evidence traversal', async () => {
  expect((await fetch(`${base}/runs`)).status).toBe(200);
  expect((await fetch(`${base}/runs/not-a-run/evidence`)).status).toBe(400);
});
