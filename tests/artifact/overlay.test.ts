import { describe, expect, it } from 'vitest';
import { capabilitySchema, type Capability } from '../../src/artifact/schema.js';
import { applyOverlay, effectiveCapability } from '../../src/artifact/overlay.js';

/**
 * The cross-tenant reuse claim, tested.
 *
 * The base capability below is recorded against meridian-cu. The overlay describes
 * riverstone-fcu, which runs the same vendor product with renamed labels, relocated
 * routes, and one extra compliance gate. The assertions are that the *effective*
 * capability targets the right things and is still a valid capability -- i.e. that
 * a second institution costs a small reviewable diff rather than a second
 * discovery run.
 */
const BASE = capabilitySchema.parse({
  schemaVersion: '1.0.0',
  id: 'member.read-savings-balance',
  version: '1.0.0',
  name: 'Read Savings Balance',
  summary: 'Read a member savings balance.',
  description: 'Search for a member and read their savings balance.',
  target: { productId: 'corepoint-servicing', recordedTenantId: 'meridian-cu', surfaceKind: 'legacy-web', entryUrl: '{{baseUrl}}/login.aspx' },
  inputs: [{ name: 'memberId', type: 'string', required: true, description: 'Member number.', sensitivity: 'pii' }],
  outputs: [{ name: 'savingsBalance', type: 'money', description: 'Balance.', sensitivity: 'pii', required: true }],
  outcomes: [{ code: 'MEMBER_NOT_FOUND', description: 'No such member.', terminal: true, retryable: true }],
  steps: [
    {
      id: '01-open-servicing',
      intent: 'Open the Member Servicing screen from the menu',
      action: { kind: 'click', target: { description: 'Member Servicing link', framePath: ['navFrame'], strategies: [{ kind: 'role-name', role: 'link', name: 'Member Servicing', nameMatch: 'normalized' }, { kind: 'dom-hint', css: '#navServicing' }] } },
      risk: 'safe',
      checkpoint: { kind: 'urlMatches', pattern: '/member-search\\.aspx' },
    },
    {
      id: '02-fill-member-id',
      intent: 'Enter the member number',
      action: { kind: 'fill', target: { description: 'Member ID field', strategies: [{ kind: 'labelled-field', label: 'Member ID', labelMatch: 'normalized', role: 'textbox' }] }, value: { from: 'input', name: 'memberId' } },
      risk: 'reversible',
    },
    {
      id: '03-click-search',
      intent: 'Run the search',
      action: { kind: 'click', target: { description: 'Search button', strategies: [{ kind: 'role-name', role: 'button', name: 'Search', nameMatch: 'normalized' }] } },
      risk: 'safe',
      handlers: [{ name: 'no-matching-member', when: { kind: 'textPresent', pattern: 'No records found matching' }, then: { do: 'outcome', code: 'MEMBER_NOT_FOUND' } }],
    },
    {
      id: '04-read-balance',
      intent: 'Read the savings balance',
      action: { kind: 'readText', target: { description: 'savings balance', strategies: [{ kind: 'table-cell', near: 'SHARE / DEPOSIT ACCOUNTS', rowKey: '12345-00', rowKeyMatch: 'normalized', columnHeader: 'Current Balance' }] } },
      risk: 'safe',
      captureAs: 'savingsBalance',
      transform: { kind: 'money' },
    },
  ],
  success: { description: 'profile shown', checkpoint: { kind: 'textPresent', pattern: 'MEMBER PROFILE' } },
  interrupts: [{ name: 'session-expired', when: { kind: 'textPresent', pattern: 'Your session has expired' }, then: { do: 'reauthenticate', maxAttempts: 1 } }],
  policy: { allowedUrlPatterns: ['^\\{\\{baseUrl\\}\\}/'], allowedActions: ['click', 'fill', 'readText'], maxRisk: 'reversible' },
  provenance: {
    recordedAt: '2026-01-01T00:00:00.000Z',
    recordedBy: 'test',
    discoveryRunId: 'd1',
    model: 'openai:test',
    modelTurns: 6,
    transcriptDigest: 'sha256:abc',
    redactionApplied: true,
    toolVersion: 'test',
  },
  overlays: [
    {
      tenantId: 'riverstone-fcu',
      productVersion: '4.1.94',
      description: 'Riverstone runs an older build with renamed labels, relocated servicing routes, and a mandatory acceptable-use gate.',
      labelAliases: {
        'Member ID': 'Account Holder #',
        Search: 'Find',
        'Member Servicing': 'Member Services',
      },
      routeAliases: {
        '/member-search.aspx': '/servicing/find-member.aspx',
        '/login.aspx': '/signon.aspx',
      },
      extraInterrupts: [
        {
          name: 'riverstone-terms-gate',
          when: { kind: 'textPresent', pattern: 'ACCEPTABLE USE ACKNOWLEDGEMENT' },
          then: { do: 'dismiss', target: { description: 'acknowledge button', strategies: [{ kind: 'role-name', role: 'button', name: 'I Acknowledge', nameMatch: 'normalized' }] }, thenRetryStep: true },
        },
      ],
    },
  ],
}) as Capability;

describe('applyOverlay', () => {
  const overlay = BASE.overlays[0]!;
  const { capability: effective, audit } = applyOverlay(BASE, overlay);

  it('rewrites a role-name target label', () => {
    const step = effective.steps.find((s) => s.id === '01-open-servicing')!;
    const strategy = 'target' in step.action ? step.action.target.strategies[0] : undefined;
    expect(strategy).toMatchObject({ kind: 'role-name', name: 'Member Services' });
  });

  it('rewrites a labelled-field target label -- the field the legacy app never labelled', () => {
    const step = effective.steps.find((s) => s.id === '02-fill-member-id')!;
    const strategy = 'target' in step.action ? step.action.target.strategies[0] : undefined;
    expect(strategy).toMatchObject({ kind: 'labelled-field', label: 'Account Holder #' });
  });

  it('rewrites a route inside a url checkpoint', () => {
    const step = effective.steps.find((s) => s.id === '01-open-servicing')!;
    // The rewritten pattern is still a regex, so the dots stay escaped.
    expect(step.checkpoint).toMatchObject({ kind: 'urlMatches', pattern: '/servicing/find-member\\.aspx' });
  });

  it('rewrites the templated entry url', () => {
    expect(effective.target.entryUrl).toBe('{{baseUrl}}/signon.aspx');
  });

  it('drops the base tenant markup hints, which would match the wrong control elsewhere', () => {
    const step = effective.steps.find((s) => s.id === '01-open-servicing')!;
    const kinds = 'target' in step.action ? step.action.target.strategies.map((s) => s.kind) : [];
    expect(kinds).not.toContain('dom-hint');
  });

  it('does NOT alias a table row key, which is data rather than a label', () => {
    const step = effective.steps.find((s) => s.id === '04-read-balance')!;
    const strategy = 'target' in step.action ? step.action.target.strategies[0] : undefined;
    expect(strategy).toMatchObject({ rowKey: '12345-00' });
  });

  it('puts the tenant compliance gate ahead of the base interrupts', () => {
    // A generic handler must not claim a condition the tenant-specific one exists for.
    expect(effective.interrupts[0]?.name).toBe('riverstone-terms-gate');
    expect(effective.interrupts.map((h) => h.name)).toContain('session-expired');
  });

  it('rewrites labels inside a handler target too', () => {
    const step = effective.steps.find((s) => s.id === '03-click-search')!;
    const strategy = 'target' in step.action ? step.action.target.strategies[0] : undefined;
    expect(strategy).toMatchObject({ name: 'Find' });
  });

  it('produces an auditable record of every rewrite', () => {
    expect(audit.tenantId).toBe('riverstone-fcu');
    expect(audit.labelRewrites.length).toBeGreaterThanOrEqual(3);
    expect(audit.routeRewrites.length).toBeGreaterThanOrEqual(2);
    expect(audit.interruptsAdded).toEqual(['riverstone-terms-gate']);
  });

  it('yields an effective capability that is itself valid', () => {
    // This is the property that keeps the replay engine ignorant of overlays.
    expect(capabilitySchema.safeParse(effective).success).toBe(true);
  });

  it('leaves the base capability untouched', () => {
    const step = BASE.steps.find((s) => s.id === '02-fill-member-id')!;
    const strategy = 'target' in step.action ? step.action.target.strategies[0] : undefined;
    expect(strategy).toMatchObject({ label: 'Member ID' });
  });
});

describe('applyOverlay stepPatches', () => {
  it('can skip a step a tenant does not have', () => {
    const overlay = { ...BASE.overlays[0]!, stepPatches: [{ stepId: '01-open-servicing', skip: true }] };
    const { capability, audit } = applyOverlay(BASE, overlay);
    expect(capability.steps.map((s) => s.id)).not.toContain('01-open-servicing');
    expect(audit.stepsSkipped).toEqual(['01-open-servicing']);
  });
});

describe('effectiveCapability', () => {
  it('returns the base unchanged for the recorded tenant', () => {
    const r = effectiveCapability(BASE, 'meridian-cu');
    expect(r.capability).toBe(BASE);
    expect(r.audit).toBeUndefined();
  });

  it('applies the overlay for a tenant that has one', () => {
    const r = effectiveCapability(BASE, 'riverstone-fcu');
    expect(r.audit?.tenantId).toBe('riverstone-fcu');
  });

  it('refuses an un-adapted tenant rather than silently running the wrong flow', () => {
    expect(() => effectiveCapability(BASE, 'summit-cu')).toThrow(/no overlay for 'summit-cu'/);
  });

  it('allows an un-adapted run when explicitly waived, and says so', () => {
    const r = effectiveCapability(BASE, 'summit-cu', { allowUnadapted: true });
    expect(r.warning).toMatch(/no overlay for 'summit-cu'/);
    expect(r.capability).toBe(BASE);
  });
});
