import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlaywrightWebSurface } from '../../src/surface/web/playwright-surface.js';
import type { TargetDescriptor, TargetStrategy } from '../../src/surface/types.js';

/**
 * Perception, against the real browser and the real target app.
 *
 * These exist because every subtle bug in this project lived here, and none of them
 * were reachable from the browser-free suite: an empty accessible name on a legacy
 * form field, a data grid confused with a label/value form, a bold value mistaken for
 * a label, and a four-column row of two label/value pairs taking its labels from the
 * wrong column. Each assertion below corresponds to one of those.
 *
 * Run with `npm run test:browser` after `npm run target-app`.
 */

const BASE = 'http://localhost:4173';
let surface: PlaywrightWebSurface;

const target = (description: string, strategies: TargetStrategy[], framePath?: string[]): TargetDescriptor =>
  framePath ? { description, strategies, framePath } : { description, strategies };

const byLabel = (label: string, role: 'textbox' | 'password' | 'combobox' = 'textbox'): TargetStrategy => ({
  kind: 'labelled-field',
  label,
  labelMatch: 'normalized',
  role,
});

beforeAll(async () => {
  const health = await fetch(`${BASE}/__health`).catch(() => undefined);
  if (!health?.ok) throw new Error(`target app is not running on ${BASE}. Start it with: npm run target-app`);

  surface = await PlaywrightWebSurface.launch({ headless: true });
  await surface.perform({ kind: 'navigate', url: `${BASE}/login.aspx` });
  await surface.perform({ kind: 'fill', target: target('User ID', [byLabel('User ID')]), value: 'svc_agent' });
  await surface.perform({ kind: 'fill', target: target('Password', [byLabel('Password', 'password')]), value: 'demo-password-not-real' });
  await surface.perform({ kind: 'click', target: target('Sign On', [{ kind: 'role-name', role: 'button', name: 'Sign On', nameMatch: 'normalized' }]) });
});

afterAll(async () => {
  await surface?.close();
});

async function gotoBody(path: string): Promise<void> {
  const body = surface.livePage().frames().find((f) => f.name() === 'bodyFrame');
  if (!body) throw new Error('bodyFrame not found -- the frameset did not load');
  await body.goto(`${BASE}${path}`);
}

describe('accessible-name synthesis on a legacy form', () => {
  it('names fields that have NO accessible name in the markup', async () => {
    // The whole premise. These inputs have no <label for>, no aria-label and no
    // placeholder, so the browser computes an empty accessible name; the label lives
    // in a sibling <td>. If this regresses, nothing else in the project works.
    await gotoBody('/member-search.aspx');
    const obs = await surface.observe();
    const field = obs.controls.find((c) => c.role === 'textbox' && c.container.framePath[0] === 'bodyFrame');

    expect(field).toBeDefined();
    expect(field!.name).toBe('Member ID');
    expect(field!.nameSource).toBe('adjacent-cell');
    // And it must advertise the strategy that can find it again.
    expect(field!.targeting.map((t) => t.kind)).toContain('labelled-field');
  });

  it('signing on at all proves the same thing for the sign-on form', () => {
    // beforeAll signed on using only labelled-field targets. Reaching the frameset
    // console is the assertion.
    expect(surface.livePage().frames().some((f) => f.name() === 'bodyFrame')).toBe(true);
  });
});

describe('data grid perception', () => {
  beforeAll(async () => {
    await gotoBody('/member-detail.aspx?mid=12345');
  });

  it('addresses a cell by row key and column header, not by position', async () => {
    const result = await surface.perform({
      kind: 'readText',
      target: target(
        'savings balance',
        [{ kind: 'table-cell', near: 'SHARE / DEPOSIT ACCOUNTS', rowKey: '12345-00', rowKeyMatch: 'normalized', columnHeader: 'Current Balance' }],
        ['bodyFrame'],
      ),
    });
    expect(result.ok).toBe(true);
    expect(result.value).toBe('$8,241.77');
    expect(result.strategyUsed?.kind).toBe('table-cell');
  });

  it('reads a different row of the same column correctly', async () => {
    const result = await surface.perform({
      kind: 'readText',
      target: target(
        'checking balance',
        [{ kind: 'table-cell', rowKey: '12345-10', rowKeyMatch: 'normalized', columnHeader: 'Current Balance' }],
        ['bodyFrame'],
      ),
    });
    expect(result.value).toBe('$1,502.31');
  });

  it('names a data cell after its column, never after its own contents', async () => {
    // A cell named "$8,241.77" would put record-time data into the artifact's target
    // description, which failure messages quote.
    const obs = await surface.observe();
    const balanceCells = obs.controls.filter((c) => c.role === 'cell' && c.container.table?.columnHeader === 'Current Balance');
    expect(balanceCells.length).toBeGreaterThan(1);
    for (const cell of balanceCells) expect(cell.name).toBe('Current Balance');
  });

  it('does not offer ordinal targeting for data cells', async () => {
    // "the 6th cell in this section" resolves successfully to the wrong row once a
    // member has a different number of accounts, which is the worst failure available.
    const obs = await surface.observe();
    const cells = obs.controls.filter((c) => c.role === 'cell' && c.container.table?.rowKey);
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(cell.targeting.map((t) => t.kind)).not.toContain('section-ordinal');
    }
  });

  it('does not treat a column header as a section heading', async () => {
    const obs = await surface.observe();
    expect(obs.headings).toContain('SHARE / DEPOSIT ACCOUNTS');
    expect(obs.headings).not.toContain('Opened');
    expect(obs.headings).not.toContain('Current Balance');
  });
});

describe('label/value grid perception', () => {
  it('takes each value from its NEAREST label in a multi-pair row', async () => {
    // The profile block is four columns wide with two label/value pairs per row.
    // Anchoring on the first cell of the row makes "Name" report as "Member ID".
    await gotoBody('/member-detail.aspx?mid=12345');
    for (const [label, expected] of [
      ['Member ID', '12345'],
      ['Name', 'Ashgrove, Dolores'],
      ['Status', 'ACTIVE'],
      ['Branch', 'BR-014 NORTHGATE'],
      ['Member Since', '03/11/2009'],
    ] as const) {
      const result = await surface.perform({
        kind: 'readText',
        target: target(label, [{ kind: 'role-name', role: 'cell', name: label, nameMatch: 'normalized' }], ['bodyFrame']),
      });
      expect(result.ok, `${label} should resolve`).toBe(true);
      expect(result.value, label).toBe(expected);
    }
  });

  it('does not collect label cells as values, which would make names ambiguous', async () => {
    // Two cells answering to "Status" makes a read of Status fail as ambiguous rather
    // than returning ACTIVE.
    const obs = await surface.observe();
    const named = obs.controls.filter((c) => c.role === 'cell' && c.nameSource === 'adjacent-cell');
    const names = named.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const cell of named) expect(cell.value ?? '').not.toMatch(/:$/);
  });

  it('perceives a BOLD value, which the app uses for the field that matters most', async () => {
    // The confirmation screen bolds the new account number. A styling test for
    // "is this a label" throws away the one field the capability exists to return.
    await gotoBody('/subaccount-new.aspx?mid=20881');
    await surface.perform({ kind: 'fill', target: target('Description', [byLabel('Description')], ['bodyFrame']), value: 'Perception Test' });
    await surface.perform({ kind: 'fill', target: target('Initial Deposit', [byLabel('Initial Deposit')], ['bodyFrame']), value: '75' });
    await surface.perform({
      kind: 'click',
      target: target('Submit Request', [{ kind: 'role-name', role: 'button', name: 'Submit Request', nameMatch: 'normalized' }], ['bodyFrame']),
    });

    const result = await surface.perform({
      kind: 'readText',
      target: target('new account number', [{ kind: 'role-name', role: 'cell', name: 'New Account Number', nameMatch: 'normalized' }], ['bodyFrame']),
    });
    expect(result.ok).toBe(true);
    expect(result.value).toMatch(/^20881-\d+$/);
  });
});

describe('frameset perception', () => {
  it('reports every frame and attributes controls to the right one', async () => {
    await gotoBody('/member-search.aspx');
    const obs = await surface.observe();
    const paths = obs.frames.map((f) => f.path.join('/'));
    expect(paths).toContain('navFrame');
    expect(paths).toContain('bodyFrame');
    expect(obs.controls.some((c) => c.container.framePath[0] === 'navFrame')).toBe(true);
    expect(obs.controls.some((c) => c.container.framePath[0] === 'bodyFrame')).toBe(true);
  });

  it('reports the url of every document, not just the top one', async () => {
    // What the policy gate's egress check depends on.
    const loc = await surface.location();
    expect(loc.url).toContain('/console.aspx');
    expect(loc.frameUrls.some((u) => u.includes('/member-search.aspx'))).toBe(true);
  });

  it('distinguishes same-named controls in different frames by frame path', async () => {
    const inNav = await surface.resolve(
      target('Home link in nav', [{ kind: 'role-name', role: 'link', name: 'Home', nameMatch: 'normalized' }], ['navFrame']),
    );
    expect(inNav.ok).toBe(true);
    if (inNav.ok) expect(inNav.control.container.framePath).toEqual(['navFrame']);
  });
});

describe('action kinds no committed capability happens to use', () => {
  // These are implemented in the driver and reachable from a hand-authored artifact,
  // but the three discovered capabilities never needed them -- so until now they were
  // code paths nobody had run. Untested surface on a system that drives banking screens
  // is the same liability as declared-but-unenforced config, so they are pinned here.
  beforeAll(async () => {
    await gotoBody('/subaccount-new.aspx?mid=12345');
  });

  it('selects a dropdown option by its underlying value', async () => {
    const result = await surface.perform({
      kind: 'select',
      target: target('Product Type', [byLabel('Product Type', 'combobox')], ['bodyFrame']),
      value: 'HOLIDAY',
    });
    expect(result.ok).toBe(true);
    const obs = await surface.observe();
    expect(obs.controls.find((c) => c.role === 'combobox')?.value).toBe('HOLIDAY');
  });

  it('falls back to selecting by visible label when the value does not match', async () => {
    // Tenants relabel options while keeping the underlying codes, so the code is tried
    // first and the label second.
    const result = await surface.perform({
      kind: 'select',
      target: target('Product Type', [byLabel('Product Type', 'combobox')], ['bodyFrame']),
      value: 'Vacation Club',
    });
    expect(result.ok).toBe(true);
    const obs = await surface.observe();
    expect(obs.controls.find((c) => c.role === 'combobox')?.value).toBe('VACATION');
  });

  it('assert holds and fails without waiting', async () => {
    expect((await surface.perform({ kind: 'assert', condition: { kind: 'textPresent', pattern: 'OPEN SUB-ACCOUNT' } })).ok).toBe(true);
    const bad = await surface.perform({ kind: 'assert', condition: { kind: 'textPresent', pattern: 'NOT ON THIS SCREEN' } });
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe('CONDITION_TIMEOUT');
  });

  it('waitFor polls and reports what it saw on timeout', async () => {
    expect((await surface.perform({ kind: 'waitFor', condition: { kind: 'textPresent', pattern: 'Minimum opening deposit' }, timeoutMs: 3000 })).ok).toBe(true);
    const bad = await surface.perform({ kind: 'waitFor', condition: { kind: 'textPresent', pattern: 'NEVER APPEARS' }, timeoutMs: 1200 });
    expect(bad.ok).toBe(false);
    expect(bad.error?.observed).toContain('NEVER APPEARS');
  });

  it('press Enter submits the focused form -- which is why risk treats it as irreversible', async () => {
    await surface.perform({ kind: 'fill', target: target('Description', [byLabel('Description')], ['bodyFrame']), value: 'Press Test' });
    await surface.perform({ kind: 'fill', target: target('Initial Deposit', [byLabel('Initial Deposit')], ['bodyFrame']), value: '55' });
    expect((await surface.perform({ kind: 'press', key: 'Enter' })).ok).toBe(true);
    const obs = await surface.observe();
    expect(obs.text).toContain('SUB-ACCOUNT OPENED');
  });
});
