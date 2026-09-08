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

/**
 * A filled password field has to look different from an empty one, or the model
 * cannot tell its own fill worked.
 *
 * This is only observable in a browser: the browser-free suite builds
 * Observations from fixtures, so it can assert whatever it likes about a
 * password field without ever running the code that decides what to report.
 */
describe('password fields report that they are filled, never what with', () => {
  const SECRET = 'demo-password-not-real';
  const passwordControl = (obs: { controls: { role: string; value?: string }[] }) =>
    obs.controls.find((c) => c.role === 'password');

  it('reports no value for an untouched password field', async () => {
    // A fresh sign-on page: nothing typed yet.
    const fresh = await PlaywrightWebSurface.launch({ headless: true });
    try {
      await fresh.perform({ kind: 'navigate', url: `${BASE}/login.aspx` });
      expect(passwordControl(await fresh.observe())?.value).toBeUndefined();
    } finally {
      await fresh.close();
    }
  });

  it('reports a masked value once filled, so the fill is observable', async () => {
    const fresh = await PlaywrightWebSurface.launch({ headless: true });
    try {
      await fresh.perform({ kind: 'navigate', url: `${BASE}/login.aspx` });
      await fresh.perform({ kind: 'fill', target: target('Password', [byLabel('Password', 'password')]), value: SECRET });
      const observed = passwordControl(await fresh.observe())?.value;

      // The point of the change: filled and empty are now distinguishable.
      expect(observed).toBeTruthy();
      // The point of the redaction: still nothing about the credential itself.
      expect(observed).not.toContain(SECRET);
      expect(observed).not.toContain('demo');
      // Fixed width -- deriving it from the real length would leak the length.
      expect(observed).toBe('********');
      expect(observed!.length).not.toBe(SECRET.length);
    } finally {
      await fresh.close();
    }
  });

  it('never lets the credential reach the observation at all', async () => {
    const fresh = await PlaywrightWebSurface.launch({ headless: true });
    try {
      await fresh.perform({ kind: 'navigate', url: `${BASE}/login.aspx` });
      await fresh.perform({ kind: 'fill', target: target('Password', [byLabel('Password', 'password')]), value: SECRET });
      // Whole-observation check, not just the one control: the value could also
      // have leaked into a name, a target hint or the page text.
      expect(JSON.stringify(await fresh.observe())).not.toContain(SECRET);
    } finally {
      await fresh.close();
    }
  });
});

/**
 * A table cell that wraps one link is that link, perceived twice.
 *
 * Meridian's search results put `<a href="/members/103001">Select</a>` alone in a
 * cell. Perception offered the model both a `link "Select"` -- with role-name,
 * text and section-ordinal strategies -- and a `cell "Select"` carrying only a
 * positional dom-hint, with nothing to tell them apart. Clicking the cell hits the
 * td's padding and navigates nowhere; a real discovery run did exactly that three
 * times and escalated.
 */
describe('a cell that only wraps a control is not perceived as a value', () => {
  const page = (body: string) =>
    `data:text/html,${encodeURIComponent(`<html><body><table border="1"><tr><th>Member No.</th><th>Name</th><th>Action</th></tr>${body}</table></body></html>`)}`;

  const named = (obs: { controls: { role: string; name: string }[] }, name: string) =>
    obs.controls.filter((c) => c.name === name);

  it('drops the wrapper cell and keeps the link', async () => {
    const fresh = await PlaywrightWebSurface.launch({ headless: true });
    try {
      await fresh.perform({ kind: 'navigate', url: page('<tr><td>103001</td><td>Vaughan, Dorothy</td><td><a href="/members/103001">Select</a></td></tr>') });
      const obs = await fresh.observe();
      const selects = named(obs, 'Select');
      expect(selects).toHaveLength(1);
      expect(selects[0]!.role).toBe('link');
      // The data either side of it is still readable.
      expect(obs.controls.some((c) => c.name === 'Vaughan, Dorothy' || c.value === 'Vaughan, Dorothy')).toBe(true);
    } finally {
      await fresh.close();
    }
  });

  it('keeps a cell that holds a link plus other text', async () => {
    // The local app's own footer is this shape: "Signed on: <b>x</b> | Sign Off".
    // Dropping it would lose a value to read, so the rule is deliberately narrow.
    const fresh = await PlaywrightWebSurface.launch({ headless: true });
    try {
      await fresh.perform({ kind: 'navigate', url: page('<tr><td>103001</td><td>Vaughan, Dorothy</td><td>OPEN &nbsp; <a href="/x">Select</a></td></tr>') });
      const obs = await fresh.observe();
      // Cell survives, because its text is more than the link's.
      // A grid cell is *named* by its column header; its text is the value.
      expect(obs.controls.some((c) => c.role === 'cell' && /OPEN/.test(`${c.name ?? ''} ${c.value ?? ''}`))).toBe(true);
      expect(obs.controls.some((c) => c.role === 'link' && c.name === 'Select')).toBe(true);
    } finally {
      await fresh.close();
    }
  });
});

/**
 * The status line: several label/value pairs in one element, with no heading,
 * no label and no accessible name.
 *
 * Nothing else in the perception layer collected it, so the model could read
 * "OPR TELLER1 | BR MAIN-001" in the page text while having no ref to point at.
 * It pointed at the nearest control it did have and captured the menu's "1." --
 * a green run returning the wrong value.
 */
describe('status lines are perceived, and named after their shape', () => {
  const FOOTER = 'OPR TELLER1 | BR MAIN-001 | 09/03/2026 23:38:07 | SID 3CAB058F';
  const page = (body: string) => `data:text/html,${encodeURIComponent(`<html><body>${body}</body></html>`)}`;

  const statusLine = (obs: { controls: { name: string; value?: string }[] }) =>
    obs.controls.find((c) => /OPR/.test(`${c.name ?? ''}`));

  it('perceives a status line that carries no label of any kind', async () => {
    const fresh = await PlaywrightWebSurface.launch({ headless: true });
    try {
      await fresh.perform({ kind: 'navigate', url: page(`<table><tr><td><font size="1">${FOOTER}</font></td></tr></table>`) });
      const found = statusLine(await fresh.observe());
      expect(found).toBeDefined();
      expect(found!.value).toContain('MAIN-001');
    } finally {
      await fresh.close();
    }
  });

  it('names it after its labels, keeping record-time data out of the name', async () => {
    // The name is what lands in a target descriptor and in failure messages. A
    // name containing the operator and session id would be pinned to one run.
    const fresh = await PlaywrightWebSurface.launch({ headless: true });
    try {
      await fresh.perform({ kind: 'navigate', url: page(`<table><tr><td><font size="1">${FOOTER}</font></td></tr></table>`) });
      const found = statusLine(await fresh.observe())!;
      expect(found.name).toBe('OPR | BR | SID');
      expect(found.name).not.toContain('TELLER1');
      expect(found.name).not.toContain('3CAB058F');
    } finally {
      await fresh.close();
    }
  });

  it('gives the same name when the values differ, so a target survives the next run', async () => {
    const fresh = await PlaywrightWebSurface.launch({ headless: true });
    try {
      await fresh.perform({ kind: 'navigate', url: page('<table><tr><td><font>OPR SUPER1 | BR EAST-022 | 01/01/2027 00:00:00 | SID FFFFFFFF</font></td></tr></table>') });
      expect(statusLine(await fresh.observe())!.name).toBe('OPR | BR | SID');
    } finally {
      await fresh.close();
    }
  });

  it('does not mistake ordinary prose for a status line', async () => {
    const fresh = await PlaywrightWebSurface.launch({ headless: true });
    try {
      await fresh.perform({ kind: 'navigate', url: page('<table><tr><td>Type or click a menu option to continue.</td></tr></table>') });
      expect(statusLine(await fresh.observe())).toBeUndefined();
    } finally {
      await fresh.close();
    }
  });

  it('perceives it once, not once per nesting depth', async () => {
    // The <font> is inside a <td> inside a <table>; all three have the same text.
    const fresh = await PlaywrightWebSurface.launch({ headless: true });
    try {
      await fresh.perform({ kind: 'navigate', url: page(`<table><tr><td><font size="1">${FOOTER}</font></td></tr></table>`) });
      const obs = await fresh.observe();
      expect(obs.controls.filter((c) => /OPR/.test(`${c.name ?? ''}`))).toHaveLength(1);
    } finally {
      await fresh.close();
    }
  });
});

it('persists structure-only snapshots without hidden tokens, attributes or PII', async () => {
  const { readFile, mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'lh-sanitized-'));
  const page = surface.livePage();
  const isolated = await page.context().newPage();
  // Use the actual surface with a simple page after the other perception scenarios.
  await page.goto('about:blank');
  await page.setContent('<p data-name="PRIVATE_PERSON">PRIVATE_PERSON</p><input type="hidden" name="_token" value="PRIVATE_TOKEN"><input value="PRIVATE_EMAIL@example.com"><script type="application/json">PRIVATE_SCRIPT</script>');
  try {
    const file = await surface.sourceSnapshot(join(dir, 'snapshot.html'));
    expect(file).toBeTruthy();
    const snapshot = await readFile(file!, 'utf8');
    expect(snapshot).toContain('ledgerhand-sanitized-evidence-v1');
    expect(snapshot).not.toContain('PRIVATE');
    expect(snapshot).not.toContain('_token');
    expect(snapshot).not.toContain('<script');
    const shot = await surface.screenshot(join(dir, 'snapshot.png'));
    expect(shot).toBeTruthy();
    expect(await page.locator('input:not([type="hidden"])').inputValue()).toBe('PRIVATE_EMAIL@example.com');
    expect(await page.locator('p').evaluate((el) => getComputedStyle(el).color)).not.toBe('rgba(0, 0, 0, 0)');
  } finally { await isolated.close(); await rm(dir, { recursive: true, force: true }); }
});
