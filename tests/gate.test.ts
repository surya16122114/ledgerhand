import { describe, expect, it } from 'vitest';
import { PolicyGate, type PolicyEvent } from '../src/policy/gate.js';
import { discoveryAllowlist } from '../src/policy/allowlist.js';
import type { Action, ActionResult, Observation, Resolution, Surface, TargetDescriptor } from '../src/surface/types.js';
import { control } from './fixtures.js';

/**
 * A Surface whose reported location is scriptable, so the gate's egress check can be
 * tested without a browser. `frameUrls` is the interesting field: the whole point of
 * these tests is that checking only the top document is not enough.
 */
function stub(opts: { frameUrls?: string[]; topUrl?: string; controlName?: string; controlRole?: 'button' | 'link' } = {}) {
  const performed: Action[] = [];
  let frameUrls = opts.frameUrls ?? ['http://localhost:4173/console.aspx'];
  const surface: Surface & { performed: Action[]; setFrameUrls(u: string[]): void } = {
    kind: 'legacy-web',
    sessionId: 'sess_test',
    performed,
    setFrameUrls(u) {
      frameUrls = u;
    },
    async perform(action) {
      performed.push(action);
      return { ok: true } satisfies ActionResult;
    },
    async observe(): Promise<Observation> {
      return { generation: 1, at: '', url: opts.topUrl ?? 'http://localhost:4173/console.aspx', title: '', frames: [], controls: [], headings: [], truncatedFrames: [], text: '' };
    },
    async resolve(): Promise<Resolution> {
      return {
        ok: true,
        ref: 'r',
        control: control({ ref: 'r', role: opts.controlRole ?? 'button', name: opts.controlName ?? 'Search' }),
        strategyUsed: { kind: 'role-name', role: opts.controlRole ?? 'button', name: opts.controlName ?? 'Search', nameMatch: 'normalized' },
        strategyIndex: 0,
        alsoMatched: [],
      };
    },
    async evaluate() {
      return { satisfied: true, observed: 'stub' };
    },
    async location() {
      return { url: opts.topUrl ?? 'http://localhost:4173/console.aspx', title: '', frameUrls };
    },
    async screenshot() {
      return undefined;
    },
    async sourceSnapshot() {
      return undefined;
    },
    async close() {},
  };
  return surface;
}

const target: TargetDescriptor = {
  description: 'a control',
  strategies: [{ kind: 'role-name', role: 'button', name: 'Search', nameMatch: 'normalized' }],
};

function gateOver(inner: Surface, events: PolicyEvent[] = []) {
  return new PolicyGate(inner, { allowlist: discoveryAllowlist('http://localhost:4173'), onEvent: (e) => events.push(e) });
}

describe('PolicyGate egress check', () => {
  it('allows an action that leaves every document inside the allowlist', async () => {
    const inner = stub({ frameUrls: ['http://localhost:4173/console.aspx', 'http://localhost:4173/nav.aspx', 'http://localhost:4173/member-search.aspx'] });
    const gate = gateOver(inner);
    expect((await gate.perform({ kind: 'click', target })).ok).toBe(true);
    expect(gate.isTripped()).toBe(false);
  });

  it('catches a DENIED route reached in a child frame while the top document is unchanged', async () => {
    // The regression this exists for. On a frameset the top document loads once and
    // never navigates, so a gate that checks only `url` sees console.aspx forever and
    // never notices that the body frame is now on /admin.aspx.
    const inner = stub({
      topUrl: 'http://localhost:4173/console.aspx',
      frameUrls: ['http://localhost:4173/console.aspx', 'http://localhost:4173/nav.aspx', 'http://localhost:4173/admin.aspx'],
    });
    const events: PolicyEvent[] = [];
    const gate = gateOver(inner, events);

    const result = await gate.perform({ kind: 'click', target });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('POLICY_DENIED');
    expect(gate.isTripped()).toBe(true);
    expect(gate.trippedReason()?.reason).toContain('/admin.aspx');
    expect(events.at(-1)).toMatchObject({ phase: 'post-action', decision: 'deny', code: 'URL_DENIED' });
  });

  it('catches an off-allowlist host reached in a child frame', async () => {
    const inner = stub({ frameUrls: ['http://localhost:4173/console.aspx', 'https://evil.example/collect'] });
    const gate = gateOver(inner);
    const result = await gate.perform({ kind: 'click', target });
    expect(result.ok).toBe(false);
    expect(gate.trippedReason()?.code).toBe('URL_NOT_ALLOWED');
  });

  it('does not trip on an unloaded frame', async () => {
    // A frame that has not navigated yet is not an egress.
    const inner = stub({ frameUrls: ['http://localhost:4173/console.aspx', 'about:blank', ''] });
    const gate = gateOver(inner);
    expect((await gate.perform({ kind: 'click', target })).ok).toBe(true);
    expect(gate.isTripped()).toBe(false);
  });

  it('latches: once tripped, every later action is refused without reaching the surface', async () => {
    const inner = stub({ frameUrls: ['http://localhost:4173/console.aspx', 'http://localhost:4173/gl.aspx'] });
    const gate = gateOver(inner);
    await gate.perform({ kind: 'click', target });
    expect(gate.isTripped()).toBe(true);

    const before = inner.performed.length;
    const second = await gate.perform({ kind: 'click', target });
    expect(second.ok).toBe(false);
    expect(second.error?.message).toContain('latched');
    expect(inner.performed.length).toBe(before);
  });

  it('only a human review clears a latched violation', async () => {
    const inner = stub({ frameUrls: ['http://localhost:4173/admin.aspx'] });
    const gate = gateOver(inner);
    await gate.perform({ kind: 'click', target });
    expect(gate.isTripped()).toBe(true);
    gate.resetAfterHumanReview('operator@console');
    expect(gate.isTripped()).toBe(false);
  });
});

describe('PolicyGate risk ceiling', () => {
  it('requests authorisation for an irreversible action instead of silently allowing it', async () => {
    const inner = stub({ controlName: 'Submit Request' });
    const gate = gateOver(inner);
    const result = await gate.perform({ kind: 'click', target });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('POLICY_AUTHORIZATION_REQUIRED');
    // Nothing reached the surface: the write did not happen.
    expect(inner.performed).toHaveLength(0);
  });

  it('honours a one-shot authorisation and consumes it', async () => {
    const inner = stub({ controlName: 'Submit Request' });
    const gate = gateOver(inner);
    gate.authorizeNextIrreversible('operator@console', 'reviewed at the console');

    expect((await gate.perform({ kind: 'click', target })).ok).toBe(true);
    expect(inner.performed).toHaveLength(1);

    // Consumed: the next irreversible action needs its own decision.
    const second = await gate.perform({ kind: 'click', target });
    expect(second.error?.code).toBe('POLICY_AUTHORIZATION_REQUIRED');
    expect(inner.performed).toHaveLength(1);
  });

  it('refuses an action kind outside the allowlist before touching the surface', async () => {
    const inner = stub();
    const gate = gateOver(inner);
    const result = await gate.perform({ kind: 'press', key: 'Enter' });
    expect(result.error?.code).toBe('POLICY_DENIED');
    expect(inner.performed).toHaveLength(0);
  });

  it('refuses a navigation to a denied route before it happens', async () => {
    const inner = stub();
    const gate = gateOver(inner);
    const result = await gate.perform({ kind: 'navigate', url: 'http://localhost:4173/gl.aspx' });
    expect(result.error?.code).toBe('POLICY_DENIED');
    expect(inner.performed).toHaveLength(0);
  });

  it('emits an event for allows as well as denials', async () => {
    // An audit log with only denials is not an audit log.
    const events: PolicyEvent[] = [];
    const gate = gateOver(stub(), events);
    await gate.perform({ kind: 'readText', target });
    expect(events.filter((e) => e.decision === 'allow')).not.toHaveLength(0);
  });
});
