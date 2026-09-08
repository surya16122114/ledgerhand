import { it, expect } from 'vitest';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { attachHumanActionRecorder } from '../../src/escalation/human-recorder.js';
import { PlaywrightWebSurface } from '../../src/surface/web/playwright-surface.js';

it('records consecutive handoffs in the same page without recording automation between them', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<button>Manual action</button><input type="password">');
    const first: any[] = [], second: any[] = [];
    const one = await attachHumanActionRecorder(page, a => first.push(a));
    await page.locator('button').click();
    await page.waitForFunction(() => true);
    one.detach();
    await page.locator('button').click();
    const two = await attachHumanActionRecorder(page, a => second.push(a));
    await page.locator('button').click();
    await page.locator('input').fill('private-password');
    await page.locator('input').blur();
    await page.waitForTimeout(50);
    two.detach();
    expect(first.filter(a => a.kind === 'click')).toHaveLength(1);
    expect(second.some(a => a.kind === 'click')).toBe(true);
    expect(JSON.stringify([...first, ...second])).not.toContain('private-password');
  } finally { await browser.close(); }
});

it('blocks a forbidden click destination before the request reaches the server', async () => {
  let forbiddenHits = 0;
  const server = createServer((req, res) => {
    if (req.url === '/forbidden') forbiddenHits++;
    res.setHeader('content-type', 'text/html'); res.end('<a href="/forbidden">Go</a>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const surface = await PlaywrightWebSurface.launch({ headless: true });
  try {
    await surface.guardRequests(url => !url.includes('/forbidden'));
    await surface.livePage().goto(base);
    await surface.livePage().locator('a').click().catch(() => {});
    expect(forbiddenHits).toBe(0);
  } finally { await surface.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('perceives a complete data table by stable headers rather than a member value', async () => {
  const surface = await PlaywrightWebSurface.launch({ headless: true });
  try {
    await surface.livePage().setContent('<table><tr><th>Share</th><th>Balance</th><th>Status</th></tr><tr><td>A</td><td>25.00</td><td>OPEN</td></tr><tr><td>B</td><td>12.00</td><td>HOLD</td></tr></table>');
    const table = (await surface.observe()).controls.find(c => c.role === 'table');
    expect(table?.name).toBe('Share | Balance | Status');
    expect(table?.value).toContain('25.00');
    expect(table?.value).toContain('12.00');
  } finally { await surface.close(); }
});

it('routes an exhausted recovery budget to a human and resumes the same session', async () => {
  const { replay } = await import('../../src/replay/engine.js');
  const { loadCapability } = await import('../../src/artifact/store.js');
  const { mkdtemp, rm, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'lh-exhausted-'));
  const server = createServer((_req, res) => { res.setHeader('content-type','text/html'); res.end('<div id="state">BLOCKED</div><button onclick="document.getElementById(\'state\').textContent=\'READY\'">Repair</button>'); });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  const cap = await loadCapability('member.read-savings-balance');
  cap.inputs=[]; cap.outputs=[]; cap.overlays=[];
  cap.target.entryUrl='{{baseUrl}}/';
  cap.policy.allowedUrlPatterns=['^'+baseUrl];
  cap.policy.allowedActions.push('assert');
  cap.interrupts=[{name:'blocked',when:{kind:'textPresent',pattern:'BLOCKED'},notDuringAuth:false,then:{do:'dismiss',thenRetryStep:true,target:{description:'repair button',strategies:[{kind:'role-name',role:'button',name:'Repair',nameMatch:'exact'}]}}}];
  cap.steps=[{id:'entry',intent:'Open fixture',risk:'safe',action:{kind:'navigate',url:'{{baseUrl}}/'},handlers:[],timeoutMs:1000,partOfAuth:false},{id:'verify',intent:'Verify repaired state',risk:'safe',action:{kind:'assert',condition:{kind:'textPresent',pattern:'READY'}},handlers:[],timeoutMs:1000,partOfAuth:false}];
  cap.success={description:'Repaired state',checkpoint:{kind:'textPresent',pattern:'READY'}};
  let human: Promise<void> | undefined;
  try {
    const result=await replay(cap,{}, {baseUrl,headless:true,evidenceBaseDir:dir,recoveryBudget:0,escalationTimeoutMs:5000,onSurfaceReady:({surface,broker})=>{
      broker.onChange(()=>{
        const pending=broker.list().find(i=>i.status==='pending'); if(!pending || human)return;
        human=(async()=>{broker.claim(pending.id,'test-human');await new Promise(r=>setTimeout(r,200));await surface.livePage().getByRole('button',{name:'Repair'}).click();await new Promise(r=>setTimeout(r,50));broker.resolve(pending.id,'resume','test-human','Repaired the local state');})();
      });
    }});
    await human;
    expect(result, JSON.stringify(result)).toMatchObject({status:'success'});
    const interventions=JSON.parse(await readFile(join(dir,result.runId,'interventions.json'),'utf8')).interventions;
    expect(interventions[0].humanActions.length).toBeGreaterThan(0);
  } finally {await rm(dir,{recursive:true,force:true});await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
