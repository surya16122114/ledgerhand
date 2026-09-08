/** Read-only backup demo; recorded UI inputs and returned member values are masked. */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { startApi } from '../src/api/server.js';
import { loadEnvFile } from '../src/config/env.js';
import { SecretVault } from '../src/policy/vault.js';

await loadEnvFile('.env');
await mkdir('evidence/demo/past-runs/video', { recursive: true });
const api = await startApi({ port: 0, vault: SecretVault.fromEnvironment(), invokeDefaults: { headless: true } });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, recordVideo: { dir: 'evidence/demo/past-runs/video', size: { width: 1280, height: 900 } } });
const page = await context.newPage();
const video = page.video()!;
try {
  // Mask values before rendering the response into the recorded dashboard.
  await page.route('**/capabilities/*/invoke', async (route) => {
    const response = await route.fetch({ timeout: 120000 });
    const body = await response.json();
    if (body.outputs) body.outputs = Object.fromEntries(Object.keys(body.outputs).map((k) => [k, '[withheld in backup recording]']));
    await route.fulfill({ response, json: body });
  });
  await page.goto(api.url);
  await page.addStyleTag({ content: '[data-arg] { color: transparent !important; caret-color: transparent !important; } #liveRuns { visibility: hidden; }' });
  await page.locator('.cap').filter({ has: page.locator('h3', { hasText: /^member_read_record$/ }) }).click();
  await page.locator('[data-arg="memberId"]').fill('103001');
  await page.locator('[data-arg="shareId"]').fill('103001-S0001');
  await page.locator('#go').click();
  await page.locator('#out').filter({ hasText: 'SUCCESS' }).waitFor({ timeout: 120000 });
  await page.waitForTimeout(2500);
  await page.locator('.cap').filter({ has: page.locator('h3', { hasText: /^member_find_by_name$/ }) }).click();
  await page.locator('[data-arg="lastName"]').fill('Zzyzx');
  await page.locator('#go').click();
  await page.locator('#out').filter({ hasText: 'BUSINESS OUTCOME' }).waitFor({ timeout: 120000 });
  await page.waitForTimeout(2500);
  await page.locator('#tabRuns').click();
  await page.waitForTimeout(2000);
} finally {
  await context.close();
  await video.saveAs('evidence/demo/demo.webm');
  await video.delete();
  await browser.close();
  await api.close();
}
console.log('Saved evidence/demo/demo.webm (inputs and member outputs masked).');
