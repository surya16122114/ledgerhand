import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHistory, evidenceFile, evidenceList } from '../../src/api/runs.js';

it('persists safe history across reads and excludes legacy evidence and symlink escapes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lh-history-'));
  const id = 'replay-20260905T000000-test';
  const old = 'replay-20260904T000000-test';
  try {
    await mkdir(join(root, id, 'snapshots'), { recursive: true });
    await mkdir(join(root, old), { recursive: true });
    await writeFile(join(root, id, 'summary.json'), JSON.stringify({ sanitizedEvidenceVersion: 1, kind: 'replay', status: 'success', inputs: { memberId: '[withheld]' } }));
    await writeFile(join(root, old, 'summary.json'), JSON.stringify({ kind: 'replay', steps: [{ observed: 'PRIVATE_LEGACY' }] }));
    await writeFile(join(root, 'outside.html'), 'PRIVATE_OUTSIDE');
    await symlink(join(root, 'outside.html'), join(root, id, 'snapshots', 'escape.html'));
    expect(JSON.stringify(await runHistory(root))).not.toContain('PRIVATE');
    expect(await evidenceFile(root, id, 'snapshots', 'escape.html')).toBeUndefined();
    expect(await evidenceFile(root, id, 'logs', '../outside.html')).toBeUndefined();
    expect(await evidenceList(root, old)).toEqual([]);
    expect(await evidenceList(root, id)).toEqual([{ kind: 'logs', name: 'summary.json' }]);
    expect((await runHistory(root)).find((r: any) => r.runId === id)).toMatchObject({ status: 'success', inputs: { memberId: '[withheld]' } });
  } finally { await rm(root, { recursive: true, force: true }); }
});
