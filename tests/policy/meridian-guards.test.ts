import { it, expect, vi } from 'vitest';
import { PolicyGate } from '../../src/policy/gate.js';
import { Allowlist, discoveryAllowlist } from '../../src/policy/allowlist.js';
import { profileFor } from '../../src/artifact/product-profiles.js';
import type { Surface, TargetDescriptor } from '../../src/surface/types.js';

it('runtime gate blocks Open Share without authorization, then consumes one approval', async () => {
  const perform = vi.fn(async () => ({ ok: true }));
  const target: TargetDescriptor = { description: 'Open Share', strategies: [{ kind: 'role-name', role: 'button', name: 'Open Share', nameMatch: 'normalized' }] };
  const surface = { kind: 'legacy-web', sessionId: 'fake', perform,
    resolve: async () => ({ ok: true, control: { name: 'Open Share', role: 'button' } }),
    location: async () => ({ url: 'http://localhost:4173/share', frameUrls: [] }),
  } as unknown as Surface;
  const gate = new PolicyGate(surface, { allowlist: discoveryAllowlist('http://localhost:4173'), irreversibleVerbs: profileFor('meridian-core').irreversibleVerbs });
  expect((await gate.perform({ kind: 'click', target })).error?.code).toBe('POLICY_AUTHORIZATION_REQUIRED');
  expect(perform).not.toHaveBeenCalled();
  gate.authorizeNextIrreversible('tester', 'one test action');
  expect((await gate.perform({ kind: 'click', target })).ok).toBe(true);
  expect((await gate.perform({ kind: 'click', target })).ok).toBe(false);
  expect(perform).toHaveBeenCalledTimes(1);
});

it('Meridian product exclusions reject encoded and case-varied settings routes',()=>{
 const rules={...discoveryAllowlist('https://example.test'),deniedUrlPatterns:profileFor('meridian-core').deniedUrlPatterns};
 const policy=new Allowlist(rules);
 for(const path of ['/settings','/Settings','/%73ettings','/admin?x=1'])expect(policy.checkUrl('https://example.test'+path).allowed).toBe(false);
 expect(policy.checkUrl('https://example.test/members/103001').allowed).toBe(true);
});

