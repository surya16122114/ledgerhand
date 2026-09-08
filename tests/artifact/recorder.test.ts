import { describe, expect, it } from 'vitest';
import { compileCapability, looksLikeData, type CompileInput, type RecordedStep } from '../../src/agent/recorder.js';
import { capabilitySchema } from '../../src/artifact/schema.js';
import type { TargetDescriptor } from '../../src/artifact/index-types.js';

const memberIdTarget: TargetDescriptor = {
  description: 'textbox "Member ID"',
  framePath: ['bodyFrame'],
  strategies: [
    { kind: 'labelled-field', label: 'Member ID', labelMatch: 'normalized', role: 'textbox' },
    { kind: 'dom-hint', css: '#ctl00_MainContent_txtMemberId' },
  ],
};
const searchTarget: TargetDescriptor = {
  description: 'button "Search"',
  framePath: ['bodyFrame'],
  strategies: [{ kind: 'role-name', role: 'button', name: 'Search', nameMatch: 'normalized' }],
};
const balanceTarget: TargetDescriptor = {
  description: 'cell [12345-00 / Current Balance]',
  framePath: ['bodyFrame'],
  strategies: [{ kind: 'table-cell', near: 'SHARE / DEPOSIT ACCOUNTS', rowKey: '12345-00', rowKeyMatch: 'normalized', columnHeader: 'Current Balance' }],
};
const passwordTarget: TargetDescriptor = {
  description: 'password "Password"',
  strategies: [{ kind: 'labelled-field', label: 'Password', labelMatch: 'normalized', role: 'password' }],
};
const signOnTarget: TargetDescriptor = {
  description: 'button "Sign On"',
  strategies: [{ kind: 'role-name', role: 'button', name: 'Sign On', nameMatch: 'normalized' }],
};

const steps: RecordedStep[] = [
  {
    intent: 'Open the servicing console entry screen',
    action: { kind: 'navigate', url: 'http://localhost:4173/login.aspx' },
    risk: 'safe',
    textBefore: '',
    textAfter: 'OPERATOR SIGN ON User ID: Password: Sign On',
    urlAfter: 'http://localhost:4173/login.aspx',
    contentUrlAfter: 'http://localhost:4173/login.aspx',
    headingsBefore: [],
    headingsAfter: ['OPERATOR SIGN ON'],
    usedSecret: false,
  },
  {
    intent: 'Type the operator password',
    action: { kind: 'fill', target: passwordTarget, value: { from: 'secret', name: 'coreOperatorPassword' } },
    risk: 'reversible',
    textBefore: 'OPERATOR SIGN ON',
    textAfter: 'OPERATOR SIGN ON',
    urlAfter: 'http://localhost:4173/login.aspx',
    usedSecret: true,
  },
  {
    intent: 'Sign on to the console',
    action: { kind: 'click', target: signOnTarget },
    risk: 'safe',
    textBefore: 'OPERATOR SIGN ON User ID: Password:',
    textAfter: 'DAILY OPERATIONS SUMMARY Select a function from the menu above.',
    urlAfter: 'http://localhost:4173/console.aspx',
    // On a frameset the top document stays on console.aspx; the screen that
    // actually arrived is in the body frame.
    contentUrlAfter: 'http://localhost:4173/home.aspx',
    headingsBefore: ['OPERATOR SIGN ON'],
    headingsAfter: ['DAILY OPERATIONS SUMMARY'],
    usedSecret: false,
  },
  {
    intent: 'Enter the member number 12345 in the search field',
    action: { kind: 'fill', target: memberIdTarget, value: { from: 'literal', value: '12345' } },
    risk: 'reversible',
    textBefore: 'MEMBER SERVICING - INQUIRY',
    textAfter: 'MEMBER SERVICING - INQUIRY',
    urlAfter: 'http://localhost:4173/member-search.aspx',
    usedSecret: false,
  },
  {
    intent: 'Run the member search',
    action: { kind: 'click', target: searchTarget },
    risk: 'safe',
    textBefore: 'MEMBER SERVICING - INQUIRY Member ID:',
    textAfter: 'MEMBER PROFILE Member ID: 12345 SHARE / DEPOSIT ACCOUNTS REGULAR SHARE SAVINGS BR-014 NORTHGATE Member Since: ACTIVE Tax ID:',
    urlAfter: 'http://localhost:4173/console.aspx',
    contentUrlAfter: 'http://localhost:4173/member-detail.aspx?mid=12345',
    headingsBefore: ['MEMBER SERVICING - INQUIRY'],
    headingsAfter: ['MEMBER PROFILE', 'SHARE / DEPOSIT ACCOUNTS', 'Current Balance'],
    usedSecret: false,
  },
  {
    intent: 'Read the current regular share savings balance',
    action: { kind: 'readText', target: balanceTarget },
    risk: 'safe',
    textBefore: 'MEMBER PROFILE',
    textAfter: 'MEMBER PROFILE',
    urlAfter: 'http://localhost:4173/member-detail.aspx?mid=12345',
    usedSecret: false,
    capture: { name: 'savingsBalance', format: 'money', observedValue: '$8,241.77' },
  },
];

const input: CompileInput = {
  id: 'member.read-savings-balance',
  name: 'Read Savings Balance',
  summary: 'Look up a member and read their savings balance.',
  description: 'x',
  goal: 'read member 12345 savings balance',
  productId: 'corepoint-servicing',
  productVersion: '4.2.118',
  tenantId: 'meridian-cu',
  baseUrl: 'http://localhost:4173',
  entryUrl: 'http://localhost:4173/login.aspx',
  parameters: [{ name: 'memberId', value: '12345', type: 'string', description: 'Member number.', sensitivity: 'pii' }],
  successText: 'MEMBER PROFILE',
  steps,
  provenance: { discoveryRunId: 'discovery-test', model: 'openai:test', modelTurns: 7, transcript: { turns: [] }, recordedBy: 'test', humanInterventions: 0 },
};

describe('compileCapability', () => {
  const cap = compileCapability(input);

  it('produces a capability that validates against the schema', () => {
    expect(capabilitySchema.safeParse(cap).success).toBe(true);
  });

  it('rewrites the literal the model typed into an input reference', () => {
    // Without this, every capability is hard-wired to the member used at record time.
    const step = cap.steps.find((s) => s.id.endsWith('fill-member-id'))!;
    expect(step.action).toMatchObject({ kind: 'fill', value: { from: 'input', name: 'memberId' } });
  });

  it('keeps the secret as a vault reference, never a literal', () => {
    const step = cap.steps.find((s) => s.id.includes('password'))!;
    expect(step.action).toMatchObject({ value: { from: 'secret', name: 'coreOperatorPassword' } });
    expect(JSON.stringify(cap)).not.toContain('demo-password');
  });

  it('templates the host out of the entry url', () => {
    expect(cap.target.entryUrl).toBe('{{baseUrl}}/login.aspx');
  });

  it('marks the sign-on block, and only the sign-on block, as partOfAuth', () => {
    // reauthenticate replays exactly these on a session timeout, so the boundary
    // matters: too many and it would re-submit business actions.
    const auth = cap.steps.filter((s) => s.partOfAuth).map((s) => s.id);
    expect(auth).toHaveLength(3);
    expect(auth[auth.length - 1]).toMatch(/sign-on/);
    expect(cap.steps.filter((s) => s.partOfAuth).some((s) => s.id.includes('search'))).toBe(false);
  });

  it('synthesizes a checkpoint from text that actually appeared', () => {
    const step = cap.steps.find((s) => s.id.includes('sign-on'))!;
    expect(JSON.stringify(step.checkpoint)).toContain('DAILY OPERATIONS SUMMARY');
  });

  it('combines the new phrase with the canonical url in a checkpoint', () => {
    const step = cap.steps.find((s) => s.id.includes('search'))!;
    const json = JSON.stringify(step.checkpoint);
    expect(json).toContain('urlMatches');
    expect(json).toContain('member-detail');
  });

  it('asserts the url of the frame that changed, not the unchanged top document', () => {
    // The top document reported console.aspx for this step. Asserting that would
    // look like a check and never fail.
    const step = cap.steps.find((s) => s.id.includes('search'))!;
    expect(JSON.stringify(step.checkpoint)).not.toContain('console');
  });

  it('checkpoints on a heading perception identified, not on a phrase from the text', () => {
    // The visible text of this screen offers 'BR-014 NORTHGATE Member Since:' (this
    // member's branch) and 'ACTIVE Tax ID:' (this member's status). Both read like
    // headings to a string heuristic, and both would pin the capability to one
    // record -- 'ACTIVE' would fail outright for a dormant member. Preferring a
    // heading the perception layer identified by styling avoids the whole problem.
    const step = cap.steps.find((s) => s.id.includes('search'))!;
    const json = JSON.stringify(step.checkpoint);
    expect(json).not.toContain('NORTHGATE');
    expect(json).not.toContain('ACTIVE');
    expect(json).toMatch(/MEMBER PROFILE|SHARE \/ DEPOSIT ACCOUNTS/);
  });

  it('drops the member id from the checkpoint url, so the capability is not pinned to one member', () => {
    const step = cap.steps.find((s) => s.id.includes('search'))!;
    expect(JSON.stringify(step.checkpoint)).not.toContain('12345');
  });

  it('does not synthesize a checkpoint for a fill, which changes no screen state', () => {
    const step = cap.steps.find((s) => s.id.endsWith('fill-member-id'))!;
    expect(step.checkpoint).toBeUndefined();
  });

  it('declares the read as a money output and attaches the transform', () => {
    const step = cap.steps.find((s) => s.captureAs === 'savingsBalance')!;
    expect(step.transform).toEqual({ kind: 'money' });
    expect(cap.outputs).toEqual([
      expect.objectContaining({ name: 'savingsBalance', type: 'money', sensitivity: 'pii', required: true }),
    ]);
  });

  it('attaches the search-specific business outcome handler to the search click', () => {
    const step = cap.steps.find((s) => s.id.includes('search'))!;
    expect(step.handlers.map((h) => h.name)).toContain('no-matching-member');
  });

  it('inherits the product profile interrupts a happy-path run could never have observed', () => {
    expect(cap.interrupts.map((h) => h.name)).toEqual([
      'app-error-page',
      'permission-denied',
      'session-expired',
      'system-notice-interstitial',
      'terms-acknowledgement-gate',
      'unexpected-signon-screen',
    ]);
  });

  it('inherits the product business outcome vocabulary', () => {
    expect(cap.outcomes.map((o) => o.code)).toEqual(['MEMBER_NOT_FOUND', 'PERMISSION_DENIED', 'VALIDATION_REJECTED']);
  });

  it('is born as a draft, never approved', () => {
    // A capability should not become unattended-runnable because a model said it
    // worked once.
    expect(cap.lifecycle.state).toBe('draft');
  });

  it('records provenance as a transcript digest rather than the transcript', () => {
    expect(cap.provenance.transcriptDigest).toMatch(/^sha256:[0-9a-f]{32}$/);
    expect(JSON.stringify(cap)).not.toContain('"turns"');
  });

  it('sets maxRisk from the highest risk step actually recorded', () => {
    expect(cap.policy.maxRisk).toBe('reversible');
  });

  it('rejects a success phrase carrying record-time data', () => {
    // The model's first instinct is to quote the most distinctive thing on screen,
    // which is the member's own data. Same guard the recorder uses for checkpoints.
    expect(looksLikeData('MEMBER PROFILE Member ID: 12345 Name: Ashgrove, Dolores')).toBe(true);
    expect(looksLikeData('BR-014 NORTHGATE Member Since:')).toBe(true);
    expect(looksLikeData('Opening Balance: $250.00')).toBe(true);
    expect(looksLikeData('Ashgrove, Dolores')).toBe(true);
  });

  it('accepts a structural screen heading as a success phrase', () => {
    expect(looksLikeData('MEMBER PROFILE')).toBe(false);
    expect(looksLikeData('SHARE / DEPOSIT ACCOUNTS')).toBe(false);
    expect(looksLikeData('Sub-Account Opened')).toBe(false);
  });

  it('refuses to compile against a product with no profile', () => {
    expect(() => compileCapability({ ...input, productId: 'unknown-vendor-app' })).toThrow(/no product profile/);
  });
});

describe('host templating', () => {
  const cap = compileCapability(input);

  it('templates the host out of the entry url', () => {
    expect(cap.target.entryUrl).toBe('{{baseUrl}}/login.aspx');
  });

  it('templates the host out of every navigate step, not only the entry url', () => {
    // Leaving step one absolute makes a capability portable everywhere except its
    // very first action, which then fails the allowlist against any other host --
    // including the next tenant.
    const nav = cap.steps.find((s) => s.action.kind === 'navigate')!;
    expect(nav.action).toMatchObject({ kind: 'navigate', url: '{{baseUrl}}/login.aspx' });
    expect(JSON.stringify(cap)).not.toContain('localhost:4173');
  });
});

describe('intent templating', () => {
  const cap = compileCapability(input);

  it('templates parameter values out of the intent prose', () => {
    // The intent is what an operator reads in an escalation headline. Left literal,
    // it names the member used at record time on every future run -- and puts a
    // member id in prose inside an artifact meant to hold no member data.
    const step = cap.steps.find((s) => s.id.endsWith('fill-member-id'))!;
    expect(step.intent).toContain('{{input.memberId}}');
    expect(step.intent).not.toContain('12345');
  });

  it('leaves no parameter value anywhere in the artifact', () => {
    expect(JSON.stringify(cap)).not.toContain('12345');
  });
});

/**
 * The success checkpoint was the one place a record-time value could still reach
 * an artifact: every *step* checkpoint went through `looksLikeData`, but the
 * model's success phrase was taken verbatim.
 */
describe('success checkpoint rejects record-time data', () => {
  const compile = (successText: string, parameters = input.parameters, extraHeading = 'MEMBER RECORD') =>
    compileCapability({
      ...input,
      parameters,
      successText,
      steps: [...steps.slice(0, -1), { ...steps[steps.length - 1]!, headingsAfter: [extraHeading] }],
    });

  it('keeps a structural phrase', () => {
    expect(compile('SUB-ACCOUNT OPENED').success.checkpoint).toMatchObject({ pattern: 'SUB-ACCOUNT OPENED' });
  });

  it('falls back to a structural heading when the phrase carries an e-mail', () => {
    const cap = compile('E-mail: d.vaughan@example.org');
    expect(JSON.stringify(cap.success.checkpoint)).not.toContain('vaughan');
    expect(cap.success.checkpoint).toMatchObject({ pattern: 'MEMBER RECORD' });
  });

  it('falls back when the phrase carries an operator name', () => {
    const cap = compile('Signed on as J. TELLER');
    expect(JSON.stringify(cap.success.checkpoint)).not.toContain('TELLER');
  });

  it('rejects a phrase containing a value this run supplied', () => {
    // The most certain signal: not a guessed shape, but the actual input.
    const cap = compile('Holiday Club opened', [
      { name: 'description', value: 'Holiday Club', type: 'string', description: 'd', sensitivity: 'internal' },
    ]);
    expect(JSON.stringify(cap.success.checkpoint)).not.toContain('Holiday Club');
  });

  it('keeps the model phrase when no safe heading exists, so lint can report it', () => {
    // A wrong checkpoint the linter reports beats a missing one nothing does.
    // Every heading here is data-bearing, so there is nothing to fall back to.
    const cap = compileCapability({
      ...input,
      successText: 'E-mail: d.vaughan@example.org',
      steps: steps.map((st) => ({ ...st, headingsAfter: ['Member 103001'] })),
    });
    expect(cap.success.checkpoint).toMatchObject({ pattern: expect.stringContaining('vaughan') });
  });
});

describe('looksLikeData', () => {
  it('catches shapes with no digits in them', () => {
    expect(looksLikeData('E-mail: d.vaughan@example.org')).toBe(true);
    expect(looksLikeData('Signed on as J. TELLER')).toBe(true);
  });

  it('catches a value this run supplied', () => {
    expect(looksLikeData('Holiday Club opened', ['Holiday Club'])).toBe(true);
  });

  it('does not reject structural headings', () => {
    for (const ok of ['MEMBER PROFILE', 'TRANSFER POSTED TRANSACTION COMPLETE', 'ACCOUNT HOLD APPLIED']) {
      expect(looksLikeData(ok)).toBe(false);
    }
  });
});

/**
 * A dropdown option names a code and a label in one string.
 *
 * The model can only refer to an option by what it sees -- "WEST-014 - Westside"
 * -- so an exact match against the parameter value "WEST-014" never fired, and a
 * sign-on capability compiled with the branch hardcoded while still advertising a
 * `branch` input. It signed on at the recorded branch whatever the caller passed.
 */
describe('parameterizing a dropdown selection', () => {
  const selectStep = (value: string): RecordedStep =>
    ({
      intent: 'Choose the branch',
      action: {
        kind: 'select',
        target: { description: 'combobox "Branch"', strategies: [{ kind: 'dom-hint', css: '#branch' }] },
        value: { from: 'literal', value },
      },
      risk: 'reversible',
      textBefore: 'OPERATOR SIGN ON',
      textAfter: 'OPERATOR SIGN ON',
      urlAfter: 'http://localhost:4173/login.aspx',
      usedSecret: false,
    }) as unknown as RecordedStep;

  const compileWithBranch = (optionText: string) =>
    compileCapability({
      ...input,
      parameters: [{ name: 'branch', value: 'WEST-014', type: 'string', description: 'Branch code.', sensitivity: 'internal' }],
      steps: [steps[0]!, selectStep(optionText)],
      outputs: undefined,
    } as unknown as CompileInput);

  it('maps a "CODE - Label" option back to the input', () => {
    const step = compileWithBranch('WEST-014 - Westside').steps.find((s) => s.action.kind === 'select')!;
    expect(step.action).toMatchObject({ value: { from: 'input', name: 'branch' } });
  });

  it('still maps an exact code', () => {
    const step = compileWithBranch('WEST-014').steps.find((s) => s.action.kind === 'select')!;
    expect(step.action).toMatchObject({ value: { from: 'input', name: 'branch' } });
  });

  it('does not fire when the code is only a prefix of a longer token', () => {
    // "WEST-0140" is a different branch, not this one with a suffix.
    const step = compileWithBranch('WEST-0140 - Elsewhere').steps.find((s) => s.action.kind === 'select')!;
    expect(step.action).toMatchObject({ value: { from: 'literal' } });
  });
})

/**
 * Which steps get the business-outcome handlers.
 *
 * This was a word list matched against the button's label, and it silently
 * excluded the one that mattered. Meridian's two-phase forms submit with a button
 * labelled "Continue", and the business rule -- "source share is HOLD and cannot
 * be debited" -- fires at that step, not at the final Post. So a legitimate
 * refusal came back as TARGET_NOT_FOUND, because by the time replay looked for
 * the button the error page had replaced it.
 */
describe('business-outcome handler attachment', () => {
  const clickStep = (label: string): RecordedStep =>
    ({
      intent: `Click ${label}`,
      action: {
        kind: 'click',
        target: { description: `button "${label}"`, strategies: [{ kind: 'role-name', role: 'button', name: label, nameMatch: 'normalized' }] },
      },
      risk: 'safe',
      textBefore: 'FUNDS TRANSFER',
      textAfter: 'CONFIRM TRANSFER',
      urlAfter: 'https://example.test/members/1/transfer/review',
      headingsBefore: ['FUNDS TRANSFER'],
      headingsAfter: ['CONFIRM TRANSFER'],
      usedSecret: false,
    }) as unknown as RecordedStep;

  const handlersFor = (label: string) => {
    const cap = compileCapability({
      ...input,
      productId: 'meridian-core',
      tenantId: 'meridian-core-sandbox',
      parameters: [],
      steps: [steps[0]!, clickStep(label)],
      outputs: undefined,
    } as unknown as CompileInput);
    const step = cap.steps.find((s) => s.action.kind === 'click');
    return (step?.handlers ?? []).map((h) => h.name);
  };

  it('attaches them to a button labelled "Continue"', () => {
    // The exact case that failed: a two-phase form's review submit.
    expect(handlersFor('Continue')).toContain('source-share-on-hold');
  });

  it('still attaches them to an obvious submit', () => {
    expect(handlersFor('Post Transfer')).toContain('source-share-on-hold');
  });

  it('attaches them regardless of label, because a miss is worse than a spare', () => {
    for (const label of ['Go', 'Next', 'OK', 'Apply Settings']) {
      expect(handlersFor(label)).toContain('validation-rejected');
    }
  });
});
