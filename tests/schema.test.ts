import { describe, expect, it } from 'vitest';
import { ARTIFACT_SCHEMA_VERSION, capabilitySchema, type Capability } from '../src/artifact/schema.js';
import { canonicalJson, capabilityDigest, lintCapability, parseCapability } from '../src/artifact/store.js';

/**
 * A minimal but valid capability, built by a helper so each test can perturb one
 * thing. Every assertion below is about a mistake a generated artifact actually
 * makes -- the value of validating at load time is catching these before a browser
 * is pointed at a live banking screen, not after step seven.
 */
function base(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    id: 'member.read-savings-balance',
    version: '1.0.0',
    name: 'Read Savings Balance',
    summary: 'Look up a member and read their regular share savings balance.',
    description: 'Signs on, searches for the member, and reads the savings balance.',
    target: {
      productId: 'corepoint-servicing',
      recordedTenantId: 'meridian-cu',
      surfaceKind: 'legacy-web',
      entryUrl: '{{baseUrl}}/login.aspx',
    },
    inputs: [{ name: 'memberId', type: 'string', required: true, description: 'Member number.', sensitivity: 'pii' }],
    outputs: [{ name: 'savingsBalance', type: 'money', description: 'Current savings balance.', sensitivity: 'pii', required: true }],
    outcomes: [{ code: 'MEMBER_NOT_FOUND', description: 'No such member.', terminal: true, retryable: true }],
    steps: [
      {
        id: '01-fill-member-id',
        intent: 'Enter the member number in the search field',
        action: {
          kind: 'fill',
          target: { description: 'member id field', strategies: [{ kind: 'labelled-field', label: 'Member ID', labelMatch: 'normalized', role: 'textbox' }] },
          value: { from: 'input', name: 'memberId' },
        },
        risk: 'reversible',
      },
      {
        id: '02-read-balance',
        intent: 'Read the current savings balance',
        action: {
          kind: 'readText',
          target: { description: 'savings balance cell', strategies: [{ kind: 'table-cell', rowKey: '12345-00', rowKeyMatch: 'normalized', columnHeader: 'Current Balance' }] },
        },
        risk: 'safe',
        captureAs: 'savingsBalance',
        transform: { kind: 'money' },
      },
    ],
    success: { description: 'the profile is shown', checkpoint: { kind: 'textPresent', pattern: 'MEMBER PROFILE' } },
    interrupts: [],
    policy: { allowedUrlPatterns: ['^\\{\\{baseUrl\\}\\}/'], allowedActions: ['fill', 'readText'], maxRisk: 'reversible' },
    provenance: {
      recordedAt: '2026-01-01T00:00:00.000Z',
      recordedBy: 'test',
      discoveryRunId: 'discovery-test',
      model: 'openai:test',
      modelTurns: 4,
      transcriptDigest: 'sha256:deadbeef',
      redactionApplied: true,
      toolVersion: 'ledgerhand/test',
    },
    ...overrides,
  };
}

function issues(input: unknown): string[] {
  const r = capabilitySchema.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => i.message);
}

describe('capability schema', () => {
  it('accepts a well-formed capability', () => {
    expect(issues(base())).toEqual([]);
  });

  it('rejects a step referencing an undeclared input', () => {
    const bad = base({ inputs: [] });
    expect(issues(bad).join('\n')).toMatch(/references undeclared input 'memberId'/);
  });

  it('rejects a capture into an undeclared output', () => {
    const bad = base({ outputs: [] });
    expect(issues(bad).join('\n')).toMatch(/captures into undeclared output 'savingsBalance'/);
  });

  it('rejects a required output that no step produces', () => {
    const cap = base() as Record<string, unknown>;
    const outputs = [...(cap.outputs as unknown[]), { name: 'memberName', type: 'string', description: 'Name.', sensitivity: 'pii', required: true }];
    expect(issues(base({ outputs })).join('\n')).toMatch(/output 'memberName' is required but no step captures it/);
  });

  it('rejects an action kind absent from allowedActions', () => {
    expect(issues(base({ policy: { allowedUrlPatterns: ['^x'], allowedActions: ['readText'], maxRisk: 'reversible' } })).join('\n')).toMatch(
      /action 'fill' is not in the capability's allowedActions/,
    );
  });

  it('rejects a step whose risk exceeds the capability ceiling', () => {
    expect(issues(base({ policy: { allowedUrlPatterns: ['^x'], allowedActions: ['fill', 'readText'], maxRisk: 'safe' } })).join('\n')).toMatch(
      /step risk 'reversible' exceeds the capability's maxRisk 'safe'/,
    );
  });

  it('rejects a handler resolving to an undeclared outcome', () => {
    expect(issues(base({ outcomes: [] })).join('\n')).not.toMatch(/undeclared outcome/); // no handlers yet
    const withHandler = base({
      outcomes: [],
      steps: [
        {
          id: '01-search',
          intent: 'Search',
          action: { kind: 'click', target: { description: 'Search', strategies: [{ kind: 'role-name', role: 'button', name: 'Search', nameMatch: 'normalized' }] } },
          risk: 'safe',
          handlers: [{ name: 'nf', when: { kind: 'textPresent', pattern: 'No records' }, then: { do: 'outcome', code: 'MEMBER_NOT_FOUND' } }],
        },
      ],
      outputs: [],
      policy: { allowedUrlPatterns: ['^x'], allowedActions: ['click'], maxRisk: 'safe' },
    });
    expect(issues(withHandler).join('\n')).toMatch(/undeclared outcome 'MEMBER_NOT_FOUND'/);
  });

  it('rejects duplicate step ids, which would make overlay patches ambiguous', () => {
    const cap = base() as Record<string, unknown>;
    const steps = cap.steps as Record<string, unknown>[];
    expect(issues(base({ steps: [steps[0], { ...steps[0] }] })).join('\n')).toMatch(/duplicate step id/);
  });

  it('rejects an example value on a pii input', () => {
    // Examples propagate into catalogs and prompts; a "realistic" example of a PII
    // field is how real member data gets committed.
    const bad = base({ inputs: [{ name: 'memberId', type: 'string', required: true, description: 'x', sensitivity: 'pii', example: '12345' }] });
    expect(issues(bad).join('\n')).toMatch(/examples are not permitted/);
  });

  it('rejects a target with no strategies, which could never resolve', () => {
    const bad = base({
      steps: [
        {
          id: '01-click',
          intent: 'Click',
          action: { kind: 'click', target: { description: 'nothing', strategies: [] } },
          risk: 'safe',
        },
      ],
      inputs: [],
      outputs: [],
      policy: { allowedUrlPatterns: ['^x'], allowedActions: ['click'], maxRisk: 'safe' },
    });
    expect(issues(bad).join('\n')).toMatch(/never resolve/);
  });

  it('rejects a readText step with no captureAs', () => {
    const cap = base() as Record<string, unknown>;
    const steps = cap.steps as Record<string, unknown>[];
    const stripped = { ...steps[1] };
    delete stripped.captureAs;
    expect(issues(base({ steps: [steps[0], stripped], outputs: [] })).join('\n')).toMatch(/reads text but declares no captureAs/);
  });

  it('refuses an artifact schema major it does not understand', () => {
    expect(() => parseCapability(base({ schemaVersion: '2.0.0' }))).toThrow(/Refusing to guess/);
  });
});

describe('digest', () => {
  it('is stable regardless of key insertion order', () => {
    const a = capabilitySchema.parse(base()) as Capability;
    const reordered = JSON.parse(JSON.stringify({ ...a, provenance: a.provenance, id: a.id })) as Capability;
    expect(capabilityDigest(a)).toBe(capabilityDigest(reordered));
  });

  it('changes when a step changes', () => {
    const a = capabilitySchema.parse(base()) as Capability;
    const b = structuredClone(a);
    b.steps[0]!.intent = 'something else';
    expect(capabilityDigest(a)).not.toBe(capabilityDigest(b));
  });

  it('sorts keys at every level of the canonical form', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{\n  "a": {\n    "c": 3,\n    "d": 2\n  },\n  "b": 1\n}');
  });
});

describe('lintCapability', () => {
  it('is clean for a well-formed capability', () => {
    const cap = capabilitySchema.parse(base()) as Capability;
    expect(lintCapability(cap).filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('detects a vault secret that leaked into the artifact', () => {
    const cap = capabilitySchema.parse(
      base({
        steps: [
          {
            id: '01-fill-password',
            intent: 'Type the password',
            action: {
              kind: 'fill',
              target: { description: 'password', strategies: [{ kind: 'labelled-field', label: 'Password', labelMatch: 'normalized', role: 'password' }] },
              // Exactly the bug the check exists for: a literal where a secretRef belongs.
              value: { from: 'literal', value: 'demo-password-not-real' },
            },
            risk: 'reversible',
          },
        ],
        inputs: [],
        outputs: [],
        policy: { allowedUrlPatterns: ['^x'], allowedActions: ['fill'], maxRisk: 'reversible' },
      }),
    ) as Capability;
    const findings = lintCapability(cap, ['demo-password-not-real']);
    expect(findings.map((f) => f.code)).toContain('VAULT_SECRET_LEAKED');
  });

  it('detects an SSN-shaped literal without echoing it', () => {
    const cap = capabilitySchema.parse(
      base({ success: { description: 'x', checkpoint: { kind: 'textPresent', pattern: '123-45-6789' } } }),
    ) as Capability;
    const findings = lintCapability(cap);
    const hit = findings.find((f) => f.code === 'SSN_SHAPED');
    expect(hit).toBeDefined();
    expect(JSON.stringify(hit)).not.toContain('123-45-6789');
  });

  it('warns about a step that can only be found by a markup hint', () => {
    const cap = capabilitySchema.parse(
      base({
        steps: [
          {
            id: '01-click-fragile',
            intent: 'Click something only findable by css',
            action: { kind: 'click', target: { description: 'fragile', strategies: [{ kind: 'dom-hint', css: '#ctl00_x' }] } },
            risk: 'safe',
          },
        ],
        inputs: [],
        outputs: [],
        policy: { allowedUrlPatterns: ['^x'], allowedActions: ['click'], maxRisk: 'safe' },
      }),
    ) as Capability;
    expect(lintCapability(cap).map((f) => f.code)).toContain('WEAK_TARGETING');
  });

  it('does not warn about a fill with no checkpoint, which has nothing to verify', () => {
    // A rule that fires on every fill trains the reader to ignore it.
    const cap = capabilitySchema.parse(base()) as Capability;
    expect(lintCapability(cap).map((f) => f.code)).not.toContain('UNVERIFIED_MUTATION');
  });

  it('warns about a screen-transitioning click with no checkpoint', () => {
    const cap = capabilitySchema.parse(
      base({
        steps: [
          {
            id: '01-click-search',
            intent: 'Run the search',
            action: { kind: 'click', target: { description: 'Search', strategies: [{ kind: 'role-name', role: 'button', name: 'Search', nameMatch: 'normalized' }, { kind: 'dom-hint', css: '#b' }] } },
            risk: 'safe',
          },
        ],
        inputs: [],
        outputs: [],
        policy: { allowedUrlPatterns: ['^x'], allowedActions: ['click'], maxRisk: 'safe' },
      }),
    ) as Capability;
    expect(lintCapability(cap).map((f) => f.code)).toContain('UNVERIFIED_MUTATION');
  });

  it('warns when a checkpoint asserts a phrase containing record-time data', () => {
    const cap = capabilitySchema.parse(
      base({ success: { description: 'x', checkpoint: { kind: 'textPresent', pattern: 'Member ID: 12345 Name: Ashgrove, Dolores' } } }),
    ) as Capability;
    expect(lintCapability(cap).map((f) => f.code)).toContain('DATA_IN_CONDITION');
  });
});

describe('approval of human-intervened discovery', () => {
  const withIntervention = () =>
    base({
      provenance: {
        recordedAt: '2026-01-01T00:00:00.000Z',
        recordedBy: 'test',
        discoveryRunId: 'd',
        model: 'm',
        modelTurns: 4,
        transcriptDigest: 'sha256:x',
        redactionApplied: true,
        toolVersion: 't',
        humanInterventions: 1,
      },
      lifecycle: { state: 'approved', approvedBy: 'reviewer', stability: { runs: 0, successes: 0, consecutiveFailures: 0, fallbackHits: 0 } },
    });

  it('parses as valid -- approval is a review decision, not a structural one', () => {
    // Encoding this as a schema error would make the artifact unparseable, so a
    // reviewer could never approve it even having read it.
    expect(issues(withIntervention())).toEqual([]);
  });

  it('is surfaced as a lint warning so the reviewer is told', () => {
    const cap = capabilitySchema.parse(withIntervention()) as Capability;
    const findings = lintCapability(cap);
    expect(findings.map((f) => f.code)).toContain('HUMAN_INTERVENED_DISCOVERY');
    expect(findings.find((f) => f.code === 'HUMAN_INTERVENED_DISCOVERY')?.severity).toBe('warn');
  });
});
