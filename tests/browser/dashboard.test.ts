import { it, expect } from 'vitest';
import { chromium } from 'playwright';
import { startApi } from '../../src/api/server.js';

it('keeps selection and all mutation panes locked until the original invocation completes', async () => {
  const api = await startApi({ port: 0 });
  const browser = await chromium.launch({ headless: true });
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  try {
    const page = await browser.newPage();
    let requests = 0;
    await page.route('**/capabilities/*/invoke', async route => {
      requests++;
      await wait;
      await route.fulfill({ json: { ok: true, outputs: { fixture: 'original result' }, steps: [] } });
    });
    await page.goto(api.url);
    await page.locator('#go').waitFor();
    expect(await page.locator('[data-product="meridian-core"] .cap').count()).toBeGreaterThanOrEqual(8);
    expect(await page.locator('[data-product="corepoint-servicing"] .cap').count()).toBe(3);
    expect((await page.locator('body').innerText()).toLowerCase()).not.toContain('recruiter');
    await page.locator('#assignmentSelect').selectOption('corepoint-servicing');
    expect(await page.locator('[data-product="corepoint-servicing"]').isVisible()).toBe(true);
    expect(await page.locator('[data-product="meridian-core"]').isVisible()).toBe(false);
    await page.locator('[data-product="corepoint-servicing"] .cap').first().click();
    expect(await page.locator('.cap.sel').count()).toBe(1);
    expect(await page.locator('#paneInvoke').textContent()).toContain('Assignment 1 · Local applications');
    await page.locator('#assignmentSelect').selectOption('meridian-core');
    await page.locator('[data-product="meridian-core"] .cap').first().click();
    expect(await page.locator('.cap.sel').count()).toBe(1);
    expect(await page.locator('#paneInvoke').textContent()).toContain('Assignment 2 · MERIDIAN CORE');

    const original = await page.locator('#paneInvoke h2').textContent();
    await page.locator('#go').click();
    await page.locator('#tabChat').click();
    expect(await page.locator('#chatSend').isDisabled()).toBe(true);
    await page.locator('#tabTeach').click();
    expect(await page.locator('#teachGo').isDisabled()).toBe(true);
    // Keyboard/programmatic activation must respect the same guard as pointer input.
    await page.locator('.cap').nth(1).dispatchEvent('click');
    expect(await page.locator('#paneInvoke h2').textContent()).toBe(original);
    await page.locator('#tabInvoke').click();
    expect(await page.locator('#go').isDisabled()).toBe(true);
    release();
    await page.waitForFunction(() => document.querySelector('#out')?.textContent?.includes('original result'));
    expect(await page.locator('#go').isDisabled()).toBe(false);
    expect(requests).toBe(1);
    await page.locator('.cap').nth(1).click();
    expect(await page.locator('#paneInvoke h2').textContent()).not.toBe(original);
  } finally {
    release();
    await browser.close();
    await api.close();
  }
});

it('requires an explicit choice for upfront approval and omits authorization for operator handoff', async () => {
  const api = await startApi({ port: 0 });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const bodies: any[] = [];
    await page.route('**/capabilities/*/invoke', async route => {
      bodies.push(route.request().postDataJSON());
      await route.fulfill({ json: { ok: true, outputs: { done: true }, steps: [] } });
    });
    await page.goto(api.url);
    await page.locator('.cap').filter({ hasText: 'member_update_contact' }).click();
    expect(await page.locator('.cap.sel .authorization-tag').isVisible()).toBe(true);
    expect(await page.locator('.cap.sel .authorization-tag').innerText()).toBe('Requires authorization');
    expect(await page.locator('#fullDesc').isVisible()).toBe(false);
    await page.locator('#showFull').click();
    expect(await page.locator('#fullDesc').innerText()).toContain('Draft · attended use only');
    await page.locator('#showFull').click();
    await page.locator('[data-arg="memberId"]').fill('103001');
    await page.locator('[data-arg="email"]').fill('verified.member@example.net');
    await page.locator('[data-arg="phone"]').fill('415-555-0196');
    await page.locator('[data-arg="address"]').fill('130 Demo Street');
    expect(await page.locator('#approvalMode').inputValue()).toBe('operator');
    await page.locator('#why').fill('An old reason must not silently authorize');
    await page.locator('#go').click();
    await page.waitForFunction(() => document.querySelector('#out')?.textContent?.includes('SUCCESS'));
    expect(bodies[0].authorize).toBeUndefined();
    await page.locator('#approvalMode').selectOption('upfront');
    await page.locator('#why').fill('');
    await page.locator('#go').click();
    expect(bodies).toHaveLength(1);
    await page.locator('#why').fill('Explicit approval');
    await page.locator('#go').click();
    await page.waitForFunction(() => document.querySelector('#out')?.textContent?.includes('SUCCESS'));
    expect(bodies[1].authorize.reason).toBe('Explicit approval');
  } finally { await browser.close(); await api.close(); }
});
