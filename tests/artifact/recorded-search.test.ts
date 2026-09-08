import { it, expect } from 'vitest';
import { loadCapability } from '../../src/artifact/store.js';

it('records route denials and dynamically binds saved search identities', async () => {
  const cap = await loadCapability('member.find-by-name');
  expect(cap.policy.deniedUrlPatterns).toContain('/admin\\.aspx');
  const name = cap.steps.find((s) => s.captureAs === 'memberName')!;
  expect('target' in name.action && name.action.target.strategies).toEqual([
    expect.objectContaining({ kind: 'table-cell', rowKey: '{{captured.memberNumber}}' }),
  ]);
});


