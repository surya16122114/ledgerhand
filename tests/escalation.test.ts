import { describe, expect, it, vi } from 'vitest';
import { ControlLease, LeaseGuard } from '../src/escalation/control.js';
import { InterventionBroker, type InterventionContext } from '../src/escalation/broker.js';
import { Redactor } from '../src/policy/redact.js';
import type { Action, ActionResult, Surface } from '../src/surface/types.js';

/** A Surface that records what reached it, so the guard can be tested in isolation. */
function stubSurface(): Surface & { performed: Action[] } {
  const performed: Action[] = [];
  return {
    kind: 'legacy-web',
    sessionId: 'sess_test',
    performed,
    async perform(action: Action): Promise<ActionResult> {
      performed.push(action);
      return { ok: true };
    },
    async observe() {
      return { generation: 1, at: '', url: 'http://localhost:4173/x', title: '', frames: [], controls: [], headings: [], truncatedFrames: [], text: '' };
    },
    async resolve() {
      return { ok: false, code: 'TARGET_NOT_FOUND', attempts: [] };
    },
    async evaluate() {
      return { satisfied: true, observed: 'stub' };
    },
    async location() {
      return { url: 'http://localhost:4173/x', title: '', frameUrls: ['http://localhost:4173/x'] };
    },
    async screenshot() {
      return undefined;
    },
    async sourceSnapshot() {
      return undefined;
    },
    async close() {},
  };
}

const context = (): InterventionContext => ({
  runId: 'replay-test',
  runKind: 'replay',
  location: { url: 'http://localhost:4173/member-detail.aspx', title: 'Member' },
  visibleExcerpt: 'MEMBER PROFILE',
  evidence: {},
});

describe('ControlLease', () => {
  it('starts with automation in control', () => {
    expect(new ControlLease().current()).toBe('automation');
  });

  it('records every transition with who and why', () => {
    const lease = new ControlLease();
    lease.cedeToOperator('system', 'escalation int_1');
    lease.returnToAutomation('operator@console', 'resolved as resume');
    const t = lease.transitions();
    expect(t.map((x) => `${x.from}->${x.to}`)).toEqual(['automation->operator', 'operator->automation']);
    expect(t[1]?.by).toBe('operator@console');
  });

  it('resolves waitForReturn only once control comes back', async () => {
    const lease = new ControlLease();
    lease.cedeToOperator('system', 'x');
    let returned = false;
    const waiting = lease.waitForReturn().then(() => {
      returned = true;
    });
    expect(returned).toBe(false);
    lease.returnToAutomation('operator', 'done');
    await waiting;
    expect(returned).toBe(true);
  });

  it('resolves waitForReturn immediately when automation already holds it', async () => {
    await expect(new ControlLease().waitForReturn()).resolves.toBeUndefined();
  });
});

describe('LeaseGuard', () => {
  it('lets automation act while it holds the lease', async () => {
    const lease = new ControlLease();
    const inner = stubSurface();
    const guard = new LeaseGuard(inner, lease);
    expect((await guard.perform({ kind: 'press', key: 'Enter' })).ok).toBe(true);
    expect(inner.performed).toHaveLength(1);
  });

  it('blocks a mutating action while the operator holds the lease', async () => {
    const lease = new ControlLease();
    const inner = stubSurface();
    const guard = new LeaseGuard(inner, lease);
    lease.cedeToOperator('system', 'handoff');
    const r = await guard.perform({ kind: 'click', target: { description: 'x', strategies: [{ kind: 'text', text: 'x', textMatch: 'exact' }] } });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('POLICY_DENIED');
    // Nothing reached the real surface: this is what "cede control" has to mean.
    expect(inner.performed).toHaveLength(0);
  });

  it('still permits reads during a handoff, so the console and evidence keep working', async () => {
    const lease = new ControlLease();
    const inner = stubSurface();
    const guard = new LeaseGuard(inner, lease);
    lease.cedeToOperator('system', 'handoff');
    expect((await guard.perform({ kind: 'assert', condition: { kind: 'textPresent', pattern: 'x' } })).ok).toBe(true);
  });
});

describe('InterventionBroker', () => {
  it('cedes the lease at raise time, not at claim time', () => {
    // Between "stuck" and "a human picked this up" the automation must already be
    // incapable of acting, or a retry loop upstream keeps clicking while the
    // request sits in a queue.
    const lease = new ControlLease();
    const broker = new InterventionBroker(lease);
    broker.raise({ reason: 'unhandled-condition', headline: 'h', detail: 'd', context: context() });
    expect(lease.current()).toBe('operator');
  });

  it('returns the lease when resolved', () => {
    const lease = new ControlLease();
    const broker = new InterventionBroker(lease);
    const item = broker.raise({ reason: 'unhandled-condition', headline: 'h', detail: 'd', context: context() });
    broker.claim(item.id, 'operator@console');
    broker.resolve(item.id, 'resume', 'operator@console', 'fixed by hand');
    expect(lease.current()).toBe('automation');
    expect(broker.get(item.id)?.decision).toBe('resume');
  });

  it('unblocks a waiting run when the operator resolves', async () => {
    const lease = new ControlLease();
    const broker = new InterventionBroker(lease);
    const item = broker.raise({ reason: 'authorization-required', headline: 'h', detail: 'd', context: context() });
    const waiting = broker.waitForResolution(item.id);
    broker.resolve(item.id, 'authorize-and-resume', 'operator@console');
    await expect(waiting).resolves.toMatchObject({ decision: 'authorize-and-resume' });
  });

  it('resolves immediately if the request was already handled', async () => {
    const lease = new ControlLease();
    const broker = new InterventionBroker(lease);
    const item = broker.raise({ reason: 'handler-requested', headline: 'h', detail: 'd', context: context() });
    broker.resolve(item.id, 'skip-step', 'operator');
    await expect(broker.waitForResolution(item.id)).resolves.toMatchObject({ decision: 'skip-step' });
  });

  it('times out as an abort, because nobody said it was safe to continue', async () => {
    vi.useFakeTimers();
    try {
      const lease = new ControlLease();
      const broker = new InterventionBroker(lease);
      const item = broker.raise({ reason: 'unhandled-condition', headline: 'h', detail: 'd', context: context() });
      const waiting = broker.waitForResolution(item.id, 1000);
      vi.advanceTimersByTime(1001);
      await expect(waiting).resolves.toMatchObject({ decision: 'abort' });
      expect(broker.get(item.id)?.status).toBe('abandoned');
      // The lease must come back even on a timeout, or the session is stuck forever.
      expect(lease.current()).toBe('automation');
    } finally {
      vi.useRealTimers();
    }
  });

  it('redacts recorded human actions', () => {
    const lease = new ControlLease();
    const broker = new InterventionBroker(lease, { redactor: new Redactor({ labelled: { memberId: '12345' } }) });
    const item = broker.raise({ reason: 'unhandled-condition', headline: 'h', detail: 'd', context: context() });
    broker.recordHumanAction(item.id, { at: 'now', kind: 'change', control: 'Member ID', value: '12345' });
    expect(broker.get(item.id)?.humanActions[0]?.value).toBe('[pii:memberId]');
  });

  it('refuses to claim an already-resolved request', () => {
    const lease = new ControlLease();
    const broker = new InterventionBroker(lease);
    const item = broker.raise({ reason: 'unhandled-condition', headline: 'h', detail: 'd', context: context() });
    broker.resolve(item.id, 'abort', 'operator');
    expect(() => broker.claim(item.id, 'someone')).toThrow(/already resolved/);
  });

  it('logs the escalation with the step context an operator needs', () => {
    const events: { type: string; data: Record<string, unknown> }[] = [];
    const broker = new InterventionBroker(new ControlLease(), { log: (type, data) => events.push({ type, data }) });
    broker.raise({
      reason: 'unhandled-condition',
      headline: 'Replay stuck',
      detail: 'd',
      context: { ...context(), step: { index: 3, id: '04-click-submit', intent: 'Submit the request' } },
    });
    expect(events[0]?.type).toBe('escalation.raised');
    expect(events[0]?.data.step).toMatchObject({ id: '04-click-submit' });
  });
});

describe('InterventionBroker concurrent claims', () => {
  const ctx = (): InterventionContext => ({
    runId: 'r',
    runKind: 'replay',
    location: { url: 'http://localhost:4173/x', title: '' },
    visibleExcerpt: '',
    evidence: {},
  });

  it('refuses a second operator claiming a session another already holds', () => {
    const broker = new InterventionBroker(new ControlLease());
    const item = broker.raise({ reason: 'unhandled-condition', headline: 'h', detail: 'd', context: ctx() });
    broker.claim(item.id, 'alice@console');
    expect(() => broker.claim(item.id, 'bob@console')).toThrow(/already held by alice@console/);
  });

  it('allows the same operator to re-claim, which is just a page reload', () => {
    const broker = new InterventionBroker(new ControlLease());
    const item = broker.raise({ reason: 'unhandled-condition', headline: 'h', detail: 'd', context: ctx() });
    broker.claim(item.id, 'alice@console');
    expect(() => broker.claim(item.id, 'alice@console')).not.toThrow();
  });
});
