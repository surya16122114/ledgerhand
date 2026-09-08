import { it, expect } from 'vitest';
import { validateInputs, materialiseCapturedTarget, materialiseCondition } from '../../src/replay/inputs.js';
import { loadCapability } from '../../src/artifact/store.js';
import { statusFor } from '../../src/api/server.js';
import { matchTarget } from '../../src/surface/matching.js';
import type { TargetDescriptor } from '../../src/surface/types.js';

it('binds a name to the captured first member number, even if the recorded member is second', () => {
  const target: TargetDescriptor = { description: 'member name', strategies: [{ kind: 'table-cell', rowKey: '{{captured.memberNumber}}', rowKeyMatch: 'normalized', columnHeader: 'Name' }] };
  const controls = ['100234', '103001'].map((rowKey, i) => ({ ref: String(i), role: 'cell' as const, name: 'Name', nameSource: 'column-header' as const, value: `name-${i}`, targeting: [], container: { framePath: [], table: { rowKey, columnHeader: 'Name', rowIndex: i, colIndex: 1 } } }));
  const result = matchTarget(controls, materialiseCapturedTarget(target, { memberNumber: '100234' }));
  expect(result.ok && result.control.value).toBe('name-0');
  expect(() => materialiseCapturedTarget(target, {})).toThrow('missing captured');
});

it('requires saved values to equal the requested values, escaping regex characters', () => {
  const target: TargetDescriptor = { description: 'Email', strategies: [{ kind: 'role-name', name: 'Email', role: 'cell', nameMatch: 'normalized' }] };
  const condition = materialiseCondition({ kind: 'valueMatches', target, pattern: '^{{input.email}}$' }, { email: 'a+b@example.net' });
  expect(condition.kind).toBe('valueMatches');
  if (condition.kind === 'valueMatches') {
    expect(new RegExp(condition.pattern).test('a+b@example.net')).toBe(true);
    expect(new RegExp(condition.pattern).test('ab@exampleXnet')).toBe(false);
  }
});

it('accepts an explicitly empty memo but still rejects a missing memo', async () => {
  const cap = await loadCapability('member.transfer-funds');
  const args = { memberId: '103001', fromShare: '103001-MMKT-1', toShare: '103001-MMKT-2', amount: 1, memo: '' };
  expect(validateInputs(cap, args).ok).toBe(true);
  const { memo: _, ...missing } = args;
  expect(validateInputs(cap, missing).ok).toBe(false);
  expect(statusFor({ ok: false, error: { code: 'INVALID_INPUT' } })).toBe(400);
});

