import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measuredStability, buildCatalog } from '../../src/artifact/catalog.js';
import { loadCapability, capabilityDigest } from '../../src/artifact/store.js';
it('measures terminal outcomes for this exact recording without modifying its digest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lh-stability-'));
  const cap = await loadCapability('member.read-record');
  const digest = capabilityDigest(cap);
  try {
    for (const [name, status, hash] of [['a','success',digest], ['b','business_outcome',digest], ['c','failed',digest], ['d','success','other-version']] ) {
      await mkdir(join(root, 'replay-' + name));
      await writeFile(join(root, 'replay-' + name, 'summary.json'), JSON.stringify({ status, capability: { digest: hash }, drift: [] }));
    }
    expect(await measuredStability(cap, root)).toEqual({ runs: 3, successes: 2, successRate: .667, fallbackHits: 0 });
    const catalog=await buildCatalog(undefined,root);
    expect(catalog.tools.find(t=>t.capabilityId===cap.id)?.stability).toEqual({runs:3,successes:2,successRate:.667,fallbackHits:0});
    expect(capabilityDigest(cap)).toBe(digest);
  } finally { await rm(root, { recursive: true, force: true }); }
});
