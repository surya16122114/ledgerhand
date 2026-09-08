import { describe, expect, it } from 'vitest';
import { Allowlist, discoveryAllowlist } from '../../src/policy/allowlist.js';
import { classifyRisk } from '../../src/policy/risk.js';
import { Redactor } from '../../src/policy/redact.js';
import { SecretVault } from '../../src/policy/vault.js';
import { control } from '../helpers/fixtures.js';
import { profileFor } from '../../src/artifact/product-profiles.js';

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

/**
 * Pre-authorizing a discovery run.
 *
 * Recording a write capability otherwise means a person at the operator console
 * clicking Authorize for every commit, inside an escalation timeout. That is not
 * a stronger decision than an explicit one made up front, and the ceiling must
 * still come from the invocation rather than from anything the run declares about
 * itself.
 */
describe('discoveryAllowlist authorization', () => {
  it('holds the ceiling at reversible by default', () => {
    expect(discoveryAllowlist('https://example.test').maxRisk).toBe('reversible');
  });

  it('raises the ceiling only when the caller authorized this run', () => {
    expect(discoveryAllowlist('https://example.test', true).maxRisk).toBe('irreversible');
  });

  it('keeps escalation available either way, so a refusal is never silent', () => {
    for (const preauthorized of [false, true]) {
      expect(discoveryAllowlist('https://example.test', preauthorized).allowEscalationForIrreversible).toBe(true);
    }
  });

  it('still refuses an irreversible action when unauthorized', () => {
    const list = new Allowlist(discoveryAllowlist('https://example.test'));
    expect(list.checkRisk('irreversible', 'posts a transfer').allowed).toBe(false);
  });

  it('permits it once authorized', () => {
    const list = new Allowlist(discoveryAllowlist('https://example.test', true));
    expect(list.checkRisk('irreversible', 'posts a transfer').allowed).toBe(true);
  });

  it('does not widen anything else', () => {
    // Authorization is about risk, not reach: the denied routes and the action
    // vocabulary must be identical either way.
    const off = discoveryAllowlist('https://example.test');
    const on = discoveryAllowlist('https://example.test', true);
    expect(on.deniedUrlPatterns).toEqual(off.deniedUrlPatterns);
    expect(on.allowedActions).toEqual(off.allowedActions);
    expect(on.allowedUrlPatterns).toEqual(off.allowedUrlPatterns);
  });
});

/**
 * Product-specific committing verbs.
 *
 * The generic verb list is a heuristic tuned on the first product, and it was
 * wrong on the second: it contains 'open account', Meridian's button says
 * 'Open Share', and a control that creates a real bank account was classified
 * reversible. Three guards switched off at once -- the chatbot would open accounts
 * on a sentence, the dashboard stopped demanding an authorization reason, and an
 * unattended replay stopped requiring one.
 */
describe('product-specific irreversible verbs', () => {
  const openShare = control({ ref: '1:0', role: 'button', name: 'Open Share' });
  const click = { kind: 'click' as const, target: { description: 'button "Open Share"', strategies: [{ kind: 'dom-hint' as const, css: '#b' }] } };

  it('requires authorization for a control the generic list misses', () => {
    // Documents the bug rather than the fix: without the product's own wording,
    // a button that opens a bank account looks harmless.
    expect(classifyRisk(click, openShare).risk).toBe('irreversible');
  });

  it('classifies it irreversible once the product declares its wording', () => {
    expect(classifyRisk(click, openShare, ['open share']).risk).toBe('irreversible');
  });

  it('names the verb that matched, so a policy denial is explainable', () => {
    expect(classifyRisk(click, openShare, ['open share']).reason).toContain('open share');
  });

  it('does not let a product verb override a known-benign control', () => {
    // BENIGN_OVERRIDES is checked first and must stay that way: 'Continue' is the
    // review button on this product and continuing to a confirm screen commits
    // nothing.
    const cont = control({ ref: '1:1', role: 'button', name: 'Continue' });
    expect(classifyRisk({ ...click, target: { ...click.target, description: 'button "Continue"' } }, cont, ['continue']).risk).toBe('safe');
  });

  it('meridian-core declares the verbs its own screens use', () => {
    const verbs = profileFor('meridian-core').irreversibleVerbs ?? [];
    expect(verbs).toContain('open share');
    for (const v of verbs) expect(v).toBe(v.toLowerCase());
  });
});
