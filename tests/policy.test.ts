import { describe, expect, it } from 'vitest';
import { Allowlist, discoveryAllowlist } from '../src/policy/allowlist.js';
import { classifyRisk } from '../src/policy/risk.js';
import { Redactor } from '../src/policy/redact.js';
import { SecretVault } from '../src/policy/vault.js';
import { control } from './fixtures.js';

describe('Allowlist', () => {
  const list = new Allowlist({
    allowedUrlPatterns: ['^http://localhost:4173/'],
    deniedUrlPatterns: ['/admin\\.aspx', '/gl\\.aspx'],
    allowedActions: ['navigate', 'click', 'fill', 'readText'],
    maxRisk: 'reversible',
  });

  it('allows an in-scope url', () => {
    expect(list.checkUrl('http://localhost:4173/member-search.aspx').allowed).toBe(true);
  });

  it('denies an out-of-scope host', () => {
    const d = list.checkUrl('http://evil.example/steal');
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.code).toBe('URL_NOT_ALLOWED');
  });

  it('lets deny win over allow', () => {
    // /admin.aspx matches the allow pattern too. If allow won, the deny list
    // would be decorative.
    const d = list.checkUrl('http://localhost:4173/admin.aspx');
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.code).toBe('URL_DENIED');
  });

  it('refuses an action kind that is not permitted', () => {
    const d = list.checkAction('press');
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.code).toBe('ACTION_NOT_ALLOWED');
  });

  it('enforces the risk ceiling', () => {
    expect(list.checkRisk('reversible', 'typing').allowed).toBe(true);
    const d = list.checkRisk('irreversible', 'clicking Submit Request');
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.code).toBe('RISK_EXCEEDS_CEILING');
  });

  it('refuses to construct with an empty allowlist', () => {
    expect(() => new Allowlist({ allowedUrlPatterns: [], allowedActions: [], maxRisk: 'safe' })).toThrow(/at least one allowed URL pattern/);
  });

  it('reports an invalid pattern instead of silently never matching', () => {
    expect(() => new Allowlist({ allowedUrlPatterns: ['([bad'], allowedActions: [], maxRisk: 'safe' })).toThrow(/invalid regex/);
  });

  it('denies General Ledger and Administration in the default discovery policy', () => {
    const discovery = new Allowlist(discoveryAllowlist('http://localhost:4173'));
    expect(discovery.checkUrl('http://localhost:4173/gl.aspx').allowed).toBe(false);
    expect(discovery.checkUrl('http://localhost:4173/member-search.aspx').allowed).toBe(true);
  });
});

describe('classifyRisk', () => {
  const target = { description: 'x', strategies: [{ kind: 'role-name' as const, role: 'button' as const, name: 'x', nameMatch: 'normalized' as const }] };

  it('treats reads and navigation as safe', () => {
    expect(classifyRisk({ kind: 'readText', target }).risk).toBe('safe');
    expect(classifyRisk({ kind: 'navigate', url: 'http://x/' }).risk).toBe('safe');
  });

  it('treats typing as reversible', () => {
    expect(classifyRisk({ kind: 'fill', target, value: 'v' }).risk).toBe('reversible');
  });

  it('classifies a state-changing button name as irreversible', () => {
    for (const name of ['Submit Request', 'Post Transfer', 'Confirm', 'Void Item', 'Approve']) {
      const c = control({ ref: 'r', role: 'button', name });
      expect(classifyRisk({ kind: 'click', target }, c).risk, name).toBe('irreversible');
    }
  });

  it('does not over-classify benign controls that contain risky-looking words', () => {
    for (const name of ['Search', 'Cancel', 'Continue', 'I Acknowledge', 'Sign On']) {
      const c = control({ ref: 'r', role: 'button', name });
      expect(classifyRisk({ kind: 'click', target }, c).risk, name).toBe('safe');
    }
  });

  it('treats a link as safe navigation', () => {
    const c = control({ ref: 'r', role: 'link', name: 'Open Sub-Account' });
    expect(classifyRisk({ kind: 'click', target }, c).risk).toBe('safe');
  });

  it('treats Enter as potentially submitting the focused form', () => {
    expect(classifyRisk({ kind: 'press', key: 'Enter' }).risk).toBe('irreversible');
    expect(classifyRisk({ kind: 'press', key: 'Tab' }).risk).toBe('safe');
  });

  it('gives a reason that can be quoted in a denial', () => {
    const c = control({ ref: 'r', role: 'button', name: 'Submit Request' });
    expect(classifyRisk({ kind: 'click', target }, c).reason).toMatch(/'submit'/);
  });
});

describe('Redactor', () => {
  it('removes exact secret values', () => {
    const r = new Redactor({ secrets: ['demo-password-not-real'] });
    expect(r.text('signing on with demo-password-not-real now')).toBe('signing on with [secret] now');
  });

  it('labels known sensitive inputs so logs stay debuggable', () => {
    const r = new Redactor({ labelled: { memberId: '12345' } });
    expect(r.text('looking up member 12345')).toBe('looking up member [pii:memberId]');
  });

  it('replaces the longest matching secret first', () => {
    const r = new Redactor({ secrets: ['secret', 'supersecret-value'] });
    expect(r.text('supersecret-value')).toBe('[secret]');
  });

  it('ignores values too short to scrub safely', () => {
    // Scrubbing "12" would destroy every log line that mentions a number.
    const r = new Redactor({ secrets: ['12'] });
    expect(r.text('12 items')).toBe('12 items');
  });

  it('scrubs SSN and card shapes it was never told about', () => {
    const r = new Redactor();
    expect(r.text('tax id 123-45-6789')).toBe('tax id [pii:ssn]');
    expect(r.text('card 4111 1111 1111 1111')).toBe('card [pii:pan:****1111]');
  });

  it('scrubs long digit runs that look like account numbers', () => {
    expect(new Redactor().text('acct 987654321')).toBe('acct [pii:account-number]');
  });

  it('drops credential-named keys entirely rather than scrubbing their values', () => {
    const out = new Redactor().deep({ user: 'svc_agent', password: 'anything', nested: { token: 'abc' } });
    expect(out).toEqual({ user: 'svc_agent', password: '[secret]', nested: { token: '[secret]' } });
  });

  it('walks arrays and nested objects', () => {
    const r = new Redactor({ labelled: { memberId: '12345' } });
    expect(r.deep({ rows: [{ note: 'member 12345' }] })).toEqual({ rows: [{ note: 'member [pii:memberId]' }] });
  });
});

describe('SecretVault', () => {
  it('exposes names but requires an explicit call for values', () => {
    const vault = SecretVault.forTesting({ coreOperatorPassword: 'p@ssw0rd-demo' });
    expect(vault.names()).toEqual(['coreOperatorPassword']);
    expect(vault.get('coreOperatorPassword')).toBe('p@ssw0rd-demo');
  });

  it('throws a message naming the env var when a secret is missing', () => {
    const vault = SecretVault.forTesting({});
    expect(() => vault.get('coreOperatorPassword')).toThrow(/LEDGERHAND_SECRET_CORE_OPERATOR_PASSWORD/);
  });

  it('reads the operator credentials aliases from the environment', () => {
    const vault = SecretVault.fromEnvironment({ LEDGERHAND_OPERATOR_USER: 'svc_agent', LEDGERHAND_OPERATOR_PASS: 'demo-password-not-real' } as NodeJS.ProcessEnv);
    expect(vault.names()).toEqual(['coreOperatorPassword', 'coreOperatorUser']);
  });
});
