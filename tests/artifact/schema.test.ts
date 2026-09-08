import { afterAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ARTIFACT_SCHEMA_VERSION, capabilitySchema, type Capability } from '../../src/artifact/schema.js';
import { canonicalJson, capabilityDigest, lintCapability, parseCapability, saveCapability } from '../../src/artifact/store.js';

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

  // The Meridian sandbox signs on with the literal password "password", which is
  // also a ControlRole enum value. Scanning the serialized artifact could not tell
  // those apart, so every capability that signed on anywhere failed to save --
  // including ones already committed and approved.
  it('does not treat a schema enum as a leaked secret', () => {
    const cap = capabilitySchema.parse(
      base({
        steps: [
          {
            id: '01-fill-password',
            intent: 'Enter the operator password to complete sign on.',
            action: {
              kind: 'fill',
              target: {
                description: 'password "Password:" in OPERATOR SIGN ON',
                strategies: [{ kind: 'labelled-field', label: 'Password:', labelMatch: 'normalized', role: 'password' }],
              },
              // Referenced properly. Nothing here is a leak.
              value: { from: 'secret', name: 'meridianOperatorPass' },
            },
            risk: 'reversible',
          },
        ],
        inputs: [],
        outputs: [],
        policy: { allowedUrlPatterns: ['^x'], allowedActions: ['fill'], maxRisk: 'reversible' },
      }),
    ) as Capability;
    const findings = lintCapability(cap, ['password']);
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
    // Still surfaced, just not as a blocker.
    expect(findings.map((f) => f.code)).toContain('VAULT_SECRET_IN_PROSE');
  });

  it("does not read a field label ending in a colon as a password assignment", () => {
    // Meridian renders labels as "Password:"; CorePoint's were colon-less, which
    // is the only reason this regex survived first contact.
    const cap = capabilitySchema.parse(
      base({
        steps: [
          {
            id: '01-fill',
            intent: 'Type into the field labelled Password: on the sign-on screen.',
            action: {
              kind: 'fill',
              target: { description: 'password "Password:" in OPERATOR SIGN ON', strategies: [{ kind: 'dom-hint', css: '#p' }] },
              value: { from: 'secret', name: 'meridianOperatorPass' },
            },
            risk: 'reversible',
          },
        ],
        inputs: [],
        outputs: [],
        policy: { allowedUrlPatterns: ['^x'], allowedActions: ['fill'], maxRisk: 'reversible' },
      }),
    ) as Capability;
    expect(lintCapability(cap).map((f) => f.code)).not.toContain('PASSWORD_ASSIGNMENT');
  });

  it('still catches a genuine inline password assignment', () => {
    const cap = capabilitySchema.parse(
      base({ success: { description: 'x', checkpoint: { kind: 'textPresent', pattern: 'password=hunter2swordfish' } } }),
    ) as Capability;
    expect(lintCapability(cap).map((f) => f.code)).toContain('PASSWORD_ASSIGNMENT');
  });

  it('still errors when a common-word secret lands in a value position', () => {
    // The half of the check that must not be weakened: "password" as a *typed
    // value* is a real leak even though "password" as a role name is not.
    const cap = capabilitySchema.parse(
      base({
        steps: [
          {
            id: '01-fill',
            intent: 'sign on',
            action: {
              kind: 'fill',
              target: { description: 'the password field', strategies: [{ kind: 'dom-hint', css: '#p' }] },
              value: { from: 'literal', value: 'password' },
            },
            risk: 'reversible',
          },
        ],
        inputs: [],
        outputs: [],
        policy: { allowedUrlPatterns: ['^x'], allowedActions: ['fill'], maxRisk: 'reversible' },
      }),
    ) as Capability;
    const findings = lintCapability(cap, ['password']);
    expect(findings.find((f) => f.code === 'VAULT_SECRET_LEAKED')?.severity).toBe('error');
  });

  it('reports where a leak is without echoing the secret', () => {
    const cap = capabilitySchema.parse(
      base({ success: { description: 'x', checkpoint: { kind: 'textPresent', pattern: 'tok-abcdefghijklmnop' } } }),
    ) as Capability;
    const hit = lintCapability(cap, ['tok-abcdefghijklmnop']).find((f) => f.code === 'VAULT_SECRET_LEAKED');
    expect(hit?.where).toContain('success.checkpoint.pattern');
    expect(JSON.stringify(hit)).not.toContain('tok-abcdefghijklmnop');
  });

  /**
   * A capability that reports success when the application is broken.
   *
   * A sign-on run recorded while another user had the shared fault injector armed
   * compiled with "SCHEDULED MAINTENANCE IN PROGRESS" as its success condition.
   * The discovery run looked entirely successful, and nothing objected at save
   * time even though the same product profile declares that exact phrase as an
   * interrupt.
   */
  describe('a checkpoint may not assert a condition the product calls abnormal', () => {
    const meridian = (checkpoint: unknown) =>
      capabilitySchema.parse(
        base({
          target: { productId: 'meridian-core', productVersion: '4.2.1', recordedTenantId: 'meridian-core-sandbox', surfaceKind: 'legacy-web', entryUrl: '{{baseUrl}}/signon' },
          success: { description: 'x', checkpoint },
        }),
      ) as Capability;

    it('rejects a fault page as the definition of success', () => {
      const findings = lintCapability(meridian({ kind: 'textPresent', pattern: 'SCHEDULED MAINTENANCE IN PROGRESS' }));
      expect(findings.find((f) => f.code === 'CHECKPOINT_ASSERTS_ABNORMAL_CONDITION')?.severity).toBe('error');
    });

    it('rejects a business outcome as the definition of success', () => {
      // "No member records matched your search" is a legitimate answer, never a success.
      const findings = lintCapability(meridian({ kind: 'textPresent', pattern: 'No member records matched your search' }));
      expect(findings.map((f) => f.code)).toContain('CHECKPOINT_ASSERTS_ABNORMAL_CONDITION');
    });

    it('still allows the sign-on screen, which an escalate handler also matches', () => {
      // OPERATOR SIGN ON is the legitimate checkpoint for step one of every
      // capability here. Handlers that only escalate mean "unrecognized screen",
      // not "fault", so their phrases are deliberately not banned.
      const findings = lintCapability(meridian({ kind: 'textPresent', pattern: 'OPERATOR SIGN ON' }));
      expect(findings.map((f) => f.code)).not.toContain('CHECKPOINT_ASSERTS_ABNORMAL_CONDITION');
    });

    it('allows an ordinary structural heading', () => {
      const findings = lintCapability(meridian({ kind: 'textPresent', pattern: 'MAIN MENU' }));
      expect(findings.map((f) => f.code)).not.toContain('CHECKPOINT_ASSERTS_ABNORMAL_CONDITION');
    });

    it('catches one alternative inside a multi-phrase interrupt pattern', () => {
      // The maintenance interrupt matches either the heading or the sentence
      // beneath it; asserting just the sentence must not slip through.
      const findings = lintCapability(meridian({ kind: 'textPresent', pattern: 'This window normally clears within a few moments' }));
      expect(findings.map((f) => f.code)).toContain('CHECKPOINT_ASSERTS_ABNORMAL_CONDITION');
    });
  });

  // Two capabilities shipped with a data-bearing success checkpoint because the
  // only test was "contains 3+ digits", and neither piece of data had a digit:
  // a contact update asserting the e-mail it had just written, and a sign-on
  // asserting the operator's display name.
  describe('record-time data in a checkpoint', () => {
    const withSuccess = (pattern: string) =>
      lintCapability(
        capabilitySchema.parse(base({ success: { description: 'x', checkpoint: { kind: 'textPresent', pattern } } })) as Capability,
      ).filter((f) => f.code === 'DATA_IN_CONDITION');

    it('catches an e-mail address', () => {
      expect(withSuccess('E-mail: d\\.vaughan@example\\.org')).toHaveLength(1);
    });

    it('catches a person name, through the regex escaping', () => {
      // Stored escaped as "J\. TELLER", which is why the check runs on the
      // unescaped text rather than the pattern as written.
      expect(withSuccess('Signed on as J\\. TELLER \\(TELLER\\)')).toHaveLength(1);
    });

    it('still catches a long number', () => {
      expect(withSuccess('Member 103001 updated')).toHaveLength(1);
    });

    it('leaves a structural heading alone', () => {
      for (const ok of ['TRANSFER POSTED TRANSACTION COMPLETE', 'ACCOUNT HOLD APPLIED', 'MEMBER RECORD', 'MAIN MENU']) {
        expect(withSuccess(ok)).toEqual([]);
      }
    });
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

describe('saveCapability does not clobber', () => {
  // Regression: the README's own demo path told a reviewer to run `discover`, which
  // silently overwrote the committed artifacts -- the files /evidence references by
  // digest and every replay scenario ran against. Evaluating the submission destroyed
  // part of it.
  const dir = join(tmpdir(), `lh-save-${randomUUID().slice(0, 8)}`);
  const cap = () => capabilitySchema.parse(base()) as Capability;

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a capability that does not exist yet', async () => {
    const { file } = await saveCapability(cap(), dir);
    expect(existsSync(file)).toBe(true);
  });

  it('refuses to replace an existing id@version, and says what to do instead', async () => {
    await expect(saveCapability(cap(), dir)).rejects.toThrow(/already exists/);
    await expect(saveCapability(cap(), dir)).rejects.toThrow(/Bump the version, or pass --force/);
  });

  it('replaces it when overwrite is explicit -- which is how approve and overlay work', async () => {
    const changed = cap();
    changed.lifecycle.state = 'approved';
    const { file } = await saveCapability(changed, dir, { overwrite: true });
    const written = JSON.parse(await readFile(file, 'utf8')) as Capability;
    expect(written.lifecycle.state).toBe('approved');
  });

  it('allows a different version alongside the first', async () => {
    const next = cap();
    next.version = '1.1.0';
    const { file } = await saveCapability(next, dir);
    expect(file).toContain('@1.1.0');
  });
});

/**
 * A declared input nothing reads.
 *
 * This is how a capability ends up not doing the thing it is named after. Two
 * shipped that way in one session: a contact update recorded against a member
 * whose e-mail already equalled the target value (so the model read it back and
 * declared success without opening the form), and a sign-on whose branch was the
 * dropdown's default (so the control was never touched). Both advertised the
 * input in their contract and ignored it.
 */
describe('unused inputs', () => {
  const capWith = (inputs: unknown[], steps: unknown[], outputs: unknown[] = []) =>
    lintCapability(capabilitySchema.parse(base({ inputs, steps, outputs })) as Capability).filter((f) => f.code === 'UNUSED_INPUT');

  const input = (name: string) => ({ name, type: 'string', description: name, sensitivity: 'internal', required: true });
  const fillStep = (id: string, value: unknown) => ({
    id,
    intent: 'x',
    action: { kind: 'fill', target: { description: 't', strategies: [{ kind: 'dom-hint', css: '#t' }] }, value },
    risk: 'reversible',
  });

  it('flags an input no step consumes', () => {
    const findings = capWith([input('email')], [fillStep('01-fill', { from: 'literal', value: 'x' })]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('error');
    expect(findings[0]!.where).toBe('inputs/email');
  });

  it('accepts an input consumed as a step value', () => {
    expect(capWith([input('email')], [fillStep('01-fill', { from: 'input', name: 'email' })])).toEqual([]);
  });

  it('accepts an input consumed only inside a target template', () => {
    // A parameterized row key is the whole reason materialiseTarget exists, and
    // it never appears as a step `value`.
    const steps = [
      {
        id: '01-read',
        intent: 'x',
        action: {
          kind: 'readText',
          target: { description: 'row', strategies: [{ kind: 'table-cell', rowKey: '{{input.shareId}}', rowKeyMatch: 'normalized', columnHeader: 'Balance' }] },
        },
        captureAs: 'shareBalance',
        risk: 'safe',
      },
    ];
    expect(
      capWith([input('shareId')], steps, [
        { name: 'shareBalance', type: 'money', description: 'balance', sensitivity: 'internal', required: true },
      ]),
    ).toEqual([]);
  });
});
