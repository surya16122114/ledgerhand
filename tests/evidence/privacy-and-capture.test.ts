import { it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InterventionBroker } from '../../src/escalation/broker.js';
import { ControlLease } from '../../src/escalation/control.js';
import { Redactor } from '../../src/policy/redact.js';
import { RunLogger } from '../../src/evidence/logger.js';

it('redacts the entire persisted intervention, including materialized intent and location', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'lh-private-'));
 try {
  const broker = new InterventionBroker(new ControlLease(), { evidenceDir: dir, redactor: new Redactor({ labelled: { member: '123456' } }) });
  broker.raise({ reason: 'discovery-stuck', headline: 'Member 123456', detail: '123456', context: { runId: 'test', runKind: 'discovery', goal: 'Read 123456', location: { url: 'https://example.test/members/123456', title: '123456' }, visibleExcerpt: '123456', evidence: {} } });
  let saved = '';
  for (let i=0; i<50; i++) { saved = await readFile(join(dir,'interventions.json'),'utf8').catch(()=> ''); if (saved) break; await new Promise(r=>setTimeout(r,10)); }
  expect(saved).toContain('[pii:member]'); expect(saved).not.toContain('123456');
 } finally { await rm(dir,{recursive:true,force:true}); }
});

it('records evidence unavailability explicitly when both rich captures fail', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'lh-capture-'));
 try {
  const logger = await RunLogger.create({kind:'replay',baseDir:dir});
  await logger.captureFailureEvidence({ screenshot: async()=>undefined, sourceSnapshot: async()=>undefined } as any,'closed-page');
  await logger.finalize({status:'failed'});
  expect(await readFile(logger.paths.log,'utf8')).toContain('evidence.unavailable');
 } finally { await rm(dir,{recursive:true,force:true}); }
});
