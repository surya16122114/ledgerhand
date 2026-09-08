import { describe, expect, it } from 'vitest';
import { capabilitySchema, requiredSecretNames, type Capability } from '../../src/artifact/schema.js';
import { applyTransform, materialiseTarget, renderTemplate, renderUrlPattern, resolveValue, validateInputs } from '../../src/replay/inputs.js';
import { SecretVault } from '../../src/policy/vault.js';

const CAP = capabilitySchema.parse({
  schemaVersion: '1.0.0',
  id: 'member.open-sub-account',
  version: '1.0.0',
  name: 'Open Sub Account',
  summary: 'Open a sub-account for a member.',
  description: 'x',
  target: { productId: 'corepoint-servicing', recordedTenantId: 'meridian-cu', surfaceKind: 'legacy-web', entryUrl: '{{baseUrl}}/login.aspx' },
  inputs: [
    { name: 'memberId', type: 'string', required: true, description: 'Member number.', sensitivity: 'pii', pattern: '^\\d{1,10}$' },
    { name: 'description', type: 'string', required: true, description: 'Sub-account description.', sensitivity: 'internal' },
    { name: 'initialDeposit', type: 'money', required: true, description: 'Opening deposit.', sensitivity: 'internal' },
    { name: 'productType', type: 'enum', values: ['SUBSHARE', 'HOLIDAY'], required: false, description: 'Product code.', sensitivity: 'public', default: 'SUBSHARE' },
  ],
  outputs: [],
  steps: [{ id: '01-noop', intent: 'x', action: { kind: 'assert', condition: { kind: 'textPresent', pattern: 'x' } }, risk: 'safe' }],
  success: { description: 'x', checkpoint: { kind: 'textPresent', pattern: 'x' } },
  policy: { allowedUrlPatterns: ['^x'], allowedActions: ['assert'], maxRisk: 'safe' },
  provenance: { recordedAt: 'now', recordedBy: 't', discoveryRunId: 'd', model: 'm', modelTurns: 1, transcriptDigest: 'sha256:x', redactionApplied: true, toolVersion: 't' },
}) as Capability;

describe('validateInputs', () => {
  it('accepts a valid set and coerces money to a number', () => {
    const r = validateInputs(CAP, { memberId: '12345', description: 'Holiday Club', initialDeposit: '$250.00' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.inputs.values.initialDeposit).toBe(250);
      expect(r.inputs.values.productType).toBe('SUBSHARE'); // from default
    }
  });

  it('collects sensitive values separately so the redactor can be configured', () => {
    const r = validateInputs(CAP, { memberId: '12345', description: 'x', initialDeposit: 25 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.inputs.sensitive).toEqual({ memberId: '12345' });
  });

  it('reports every missing required input at once rather than one at a time', () => {
    const r = validateInputs(CAP, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.name).sort()).toEqual(['description', 'initialDeposit', 'memberId']);
  });

  it('rejects an unknown argument instead of ignoring it', () => {
    // Silently dropping an argument the caller thought mattered is how a replay
    // runs against the wrong member.
    const r = validateInputs(CAP, { memberId: '12345', description: 'x', initialDeposit: 25, memberID: '99999' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.message).toMatch(/is not an input of/);
  });

  it('enforces a declared pattern without echoing the offending value', () => {
    const r = validateInputs(CAP, { memberId: 'not-a-number', description: 'x', initialDeposit: 25 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]?.message).toMatch(/does not match the required format/);
      expect(r.errors[0]?.message).not.toContain('not-a-number');
    }
  });

  it('rejects a value outside a declared enum', () => {
    const r = validateInputs(CAP, { memberId: '1', description: 'x', initialDeposit: 25, productType: 'VACATION' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.message).toMatch(/must be one of: SUBSHARE, HOLIDAY/);
  });

  it('rejects a non-numeric money value', () => {
    const r = validateInputs(CAP, { memberId: '1', description: 'x', initialDeposit: 'twenty five' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.message).toMatch(/must be a money/);
  });
});

describe('resolveValue', () => {
  const vault = SecretVault.forTesting({ coreOperatorPassword: 'demo-password-not-real' });
  const ctx = { inputs: { memberId: '12345' }, captured: { newAccountNumber: '12345-50' }, vault };

  it('resolves a literal', () => {
    expect(resolveValue({ from: 'literal', value: 'Holiday Club' }, ctx)).toEqual({ value: 'Holiday Club', secret: false });
  });

  it('resolves an input', () => {
    expect(resolveValue({ from: 'input', name: 'memberId' }, ctx)).toEqual({ value: '12345', secret: false });
  });

  it('resolves a previously captured value', () => {
    expect(resolveValue({ from: 'captured', name: 'newAccountNumber' }, ctx)).toEqual({ value: '12345-50', secret: false });
  });

  it('resolves a secret from the vault and flags it as secret', () => {
    // The flag is the point: the caller must not be able to log this without knowing.
    expect(resolveValue({ from: 'secret', name: 'coreOperatorPassword' }, ctx)).toEqual({ value: 'demo-password-not-real', secret: true });
  });

  it('throws when a captured reference has no value yet', () => {
    expect(() => resolveValue({ from: 'captured', name: 'nope' }, ctx)).toThrow(/no earlier step produced/);
  });
});

describe('renderTemplate', () => {
  it('substitutes baseUrl without a trailing slash', () => {
    expect(renderTemplate('{{baseUrl}}/login.aspx', { baseUrl: 'http://localhost:4173/', inputs: {} })).toBe('http://localhost:4173/login.aspx');
  });

  it('url-encodes an input substitution', () => {
    expect(renderTemplate('{{baseUrl}}/d.aspx?mid={{input.memberId}}', { baseUrl: 'http://x', inputs: { memberId: 'a b' } })).toBe('http://x/d.aspx?mid=a%20b');
  });

  it('throws on an unknown placeholder rather than emitting it literally', () => {
    expect(() => renderTemplate('{{tenantHost}}/x', { baseUrl: 'http://x', inputs: {} })).toThrow(/unknown placeholder/);
  });
});

describe('applyTransform', () => {
  it('turns a currency string into a number so callers do not parse money', () => {
    expect(applyTransform('$8,241.77', { kind: 'money' })).toBe(8241.77);
  });

  it('handles a negative balance', () => {
    expect(applyTransform('-$47.90', { kind: 'money' })).toBe(-47.9);
  });

  it('trims by default', () => {
    expect(applyTransform('  ACTIVE  ', undefined)).toBe('ACTIVE');
  });

  it('extracts a regex group', () => {
    expect(applyTransform('Confirmation Reference: SA-1A2B3C', { kind: 'regex', pattern: 'SA-([A-Z0-9]+)', group: 1 })).toBe('1A2B3C');
  });

  it('throws when the captured text does not fit the declared shape', () => {
    // Better to fail loudly than to return NaN to a banking caller.
    expect(() => applyTransform('not money', { kind: 'money' })).toThrow(/could not read a money value/);
  });
});

describe('renderUrlPattern', () => {
  it('escapes the interpolated url so the allowlist cannot be over-permissive', () => {
    // Interpolating raw would let localhost:4173 match localhostX4173.
    expect(renderUrlPattern('^{{baseUrl}}/', 'http://localhost:4173')).toBe('^http://localhost:4173/');
    expect(new RegExp(renderUrlPattern('^{{baseUrl}}/', 'http://localhost:4173')).test('http://localhostX4173/x')).toBe(false);
    expect(new RegExp(renderUrlPattern('^{{baseUrl}}/', 'http://localhost:4173')).test('http://localhost:4173/login.aspx')).toBe(true);
  });

  it('drops a trailing slash on the base url', () => {
    expect(renderUrlPattern('^{{baseUrl}}/', 'http://localhost:4173/')).toBe('^http://localhost:4173/');
  });

  it('leaves the surrounding pattern as authored', () => {
    expect(renderUrlPattern('^{{baseUrl}}/(member|servicing)/', 'http://x.test')).toBe('^http://x\\.test/(member|servicing)/');
  });
});

describe('materialiseTarget', () => {
  const target = {
    description: 'savings balance for {{input.memberId}}',
    strategies: [
      { kind: 'table-cell' as const, near: 'SHARE / DEPOSIT ACCOUNTS', rowKey: '{{input.memberId}}-00', rowKeyMatch: 'normalized' as const, columnHeader: 'Current Balance' },
    ],
  };

  it('substitutes an input into a table row key', () => {
    // Without this the capability is parameterized in name only: the row key still
    // names the member used at record time.
    const out = materialiseTarget(target, { memberId: '20881' });
    expect(out.strategies[0]).toMatchObject({ rowKey: '20881-00' });
    expect(out.description).toBe('savings balance for 20881');
  });

  it('leaves a target with no placeholders untouched', () => {
    const plain = { description: 'Search', strategies: [{ kind: 'role-name' as const, role: 'button' as const, name: 'Search', nameMatch: 'normalized' as const }] };
    expect(materialiseTarget(plain, {})).toEqual(plain);
  });

  it('throws when a placeholder has no value, rather than sending the literal to the browser', () => {
    expect(() => materialiseTarget(target, {})).toThrow(/references input 'memberId'/);
  });
});

describe('requiredSecretNames', () => {
  it('lists the vault credentials a capability needs, deduplicated', () => {
    // One definition, shared by the replay engine's pre-flight check and the catalog.
    // Deriving it in only one of those places is how a missing credential came to be
    // discovered halfway through a run instead of before it started.
    const cap = capabilitySchema.parse({
      schemaVersion: '1.0.0',
      id: 'x.y',
      version: '1.0.0',
      name: 'X',
      summary: 'x',
      description: 'x',
      target: { productId: 'p', recordedTenantId: 't', surfaceKind: 'legacy-web', entryUrl: '{{baseUrl}}/a' },
      inputs: [],
      outputs: [],
      steps: [
        {
          id: '01-user',
          intent: 'user',
          action: { kind: 'fill', target: { description: 'u', strategies: [{ kind: 'labelled-field', label: 'User ID', labelMatch: 'normalized', role: 'textbox' }] }, value: { from: 'secret', name: 'coreOperatorUser' } },
          risk: 'reversible',
        },
        {
          id: '02-pass',
          intent: 'pass',
          action: { kind: 'fill', target: { description: 'p', strategies: [{ kind: 'labelled-field', label: 'Password', labelMatch: 'normalized', role: 'password' }] }, value: { from: 'secret', name: 'coreOperatorPassword' } },
          risk: 'reversible',
        },
        {
          id: '03-again',
          intent: 'again',
          action: { kind: 'fill', target: { description: 'u2', strategies: [{ kind: 'labelled-field', label: 'User ID', labelMatch: 'normalized', role: 'textbox' }] }, value: { from: 'secret', name: 'coreOperatorUser' } },
          risk: 'reversible',
        },
        {
          id: '04-literal',
          intent: 'literal',
          action: { kind: 'fill', target: { description: 'l', strategies: [{ kind: 'labelled-field', label: 'Note', labelMatch: 'normalized', role: 'textbox' }] }, value: { from: 'literal', value: 'x' } },
          risk: 'reversible',
        },
      ],
      success: { description: 'x', checkpoint: { kind: 'textPresent', pattern: 'x' } },
      policy: { allowedUrlPatterns: ['^x'], allowedActions: ['fill'], maxRisk: 'reversible' },
      provenance: { recordedAt: 'now', recordedBy: 't', discoveryRunId: 'd', model: 'm', modelTurns: 1, transcriptDigest: 'sha256:x', redactionApplied: true, toolVersion: 't' },
    }) as Capability;

    expect(requiredSecretNames(cap)).toEqual(['coreOperatorPassword', 'coreOperatorUser']);
  });
});
