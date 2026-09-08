/**
 * The concrete web driver.
 *
 * This is the only file in the project that knows Playwright exists. It
 * implements perception (by running ./perceive.ts inside every frame) and
 * action (by acting on the ref attribute that perception stamped onto the
 * matched element). Resolution is delegated to ../matching.ts, which is shared
 * with any other driver.
 *
 * Determinism notes:
 *
 *  - There are no fixed sleeps in the action path. `settle()` is a bounded wait
 *    for the document to stop loading; actual synchronisation is always done by
 *    evaluating a declared Condition. A capability that needed a `sleep(2000)`
 *    to pass would be a capability that fails on a slower day.
 *
 *  - Every resolve re-perceives. Caching an observation across an action would
 *    be faster and occasionally wrong, and "occasionally wrong" is the failure
 *    mode this whole project exists to eliminate.
 */

import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  type Action,
  type ActionResult,
  type Condition,
  type ConditionResult,
  type ObserveOptions,
  type Observation,
  type PerceivedControl,
  type Resolution,
  type Surface,
  type SurfaceKind,
  type TargetDescriptor,
} from '../types.js';
import { describeTarget, matchTarget } from '../matching.js';
import { MAX_PERCEIVED_CONTROLS, REF_ATTR, perceiveInPage, type RawControl, type RawPerception } from './perceive.js';

export interface WebSurfaceOptions {
  headless?: boolean;
  onObservation?: (observation: Observation) => void;
  /** Bounded wait for a document to finish loading after an action. */
  settleTimeoutMs?: number;
  /** Default budget for condition polling. */
  conditionTimeoutMs?: number;
  /** Slow motion, for making a live handoff demo watchable. */
  slowMoMs?: number;
  viewport?: { width: number; height: number };
}

const DEFAULTS = {
  headless: false,
  onObservation: (_observation: Observation) => {},
  settleTimeoutMs: 15_000,
  conditionTimeoutMs: 10_000,
  slowMoMs: 0,
  viewport: { width: 1280, height: 860 },
};

export class PlaywrightWebSurface implements Surface {
  readonly kind: SurfaceKind = 'legacy-web';
  readonly sessionId: string;

  private browser!: Browser;
  private context!: BrowserContext;
  private page!: Page;
  private generation = 0;
  /**
   * Count of frame navigations seen on this session. Incremented from a
   * Playwright event rather than polled, so "did my click start a navigation?"
   * is answered by the browser instead of guessed from a timer.
   */
  private navSeq = 0;
  private opts: Required<WebSurfaceOptions>;
  /** Retained so evidence capture can describe the last thing we perceived. */
  private lastObservation?: Observation;

  private constructor(opts: WebSurfaceOptions) {
    this.sessionId = `sess_${randomUUID().slice(0, 8)}`;
    this.opts = { ...DEFAULTS, ...opts } as Required<WebSurfaceOptions>;
  }

  static async launch(opts: WebSurfaceOptions = {}): Promise<PlaywrightWebSurface> {
    const s = new PlaywrightWebSurface(opts);
    s.browser = await chromium.launch({
      headless: s.opts.headless,
      slowMo: s.opts.slowMoMs,
      args: ['--disable-features=Translate', '--no-first-run'],
    });
    s.context = await s.browser.newContext({
      viewport: s.opts.viewport,
      // Anything the app tries to persist stays in the throwaway context.
      storageState: undefined,
      // Legacy enterprise apps ship strict, often accidental, CSP headers. We
      // never inject remote code -- perception is a local function -- but a
      // restrictive policy can still block the injection channel itself.
      bypassCSP: true,
    });
    await s.context.addInitScript(NAME_SHIM);
    s.page = await s.context.newPage();
    s.page.on('framenavigated', () => {
      s.navSeq++;
    });
    return s;
  }

  async guardRequests(check: (url: string, method: string, body: string | null) => boolean): Promise<void> {
    await this.context.route('**/*', async route => {
      if (check(route.request().url(), route.request().method(), route.request().postData())) await route.fallback();
      else await route.abort('blockedbyclient');
    });
  }

  /** The live Playwright page, for the operator handoff channel only. */
  livePage(): Page {
    return this.page;
  }

  // ------------------------------------------------------------------ perceive

  async observe(opts: ObserveOptions = {}): Promise<Observation> {
    this.generation++;
    const gen = this.generation;
    await this.settle();

    const frames = this.frameTree();
    const controls: PerceivedControl[] = [];
    const texts: string[] = [];
    const headings = new Set<string>();
    const truncatedFrames: string[] = [];
    const frameMeta: { path: string[]; url: string }[] = [];

    for (const { frame, path } of frames) {
      if (opts.framePath && !samePath(path, opts.framePath)) continue;
      frameMeta.push({ path, url: safeUrl(frame) });
      let raw: RawPerception;
      try {
        raw = await evaluatePerception(frame, gen);
      } catch {
        // A frame can navigate out from under us mid-perception. Skipping it is
        // correct: the caller's condition will fail on the next poll if the
        // control it needed lived there.
        continue;
      }
      if (raw.text) texts.push(raw.text);
      if (raw.truncated) truncatedFrames.push(path.join('/') || '(top)');
      for (const h of raw.headings ?? []) headings.add(h);
      for (const rc of raw.controls) controls.push(hydrate(rc, path));
    }

    const { url, title } = await this.location();
    const observation: Observation = {
      generation: gen,
      at: new Date().toISOString(),
      url,
      title,
      frames: frameMeta,
      controls,
      truncatedFrames,
      headings: [...headings],
      text: texts.join('\n'),
    };

    this.opts.onObservation(observation);
    this.lastObservation = observation;
    return observation;
  }

  // ------------------------------------------------------------------- resolve

  async resolve(target: TargetDescriptor, requireActionable = false): Promise<Resolution> {
    const obs = await this.observe();
    const result = matchTarget(obs.controls, target, { requireActionable });

    // If perception was truncated, say so on the failure rather than on every step.
    //
    // A truncated control list can make a perfectly good target unresolvable, and
    // without this note the failure looks like a locator problem and sends you
    // debugging the wrong thing. Attaching it here costs nothing -- the observation
    // already exists -- whereas checking before every step would double perception
    // cost for a diagnostic that is almost never true.
    if (!result.ok && obs.truncatedFrames.length) {
      return {
        ...result,
        attempts: [
          ...result.attempts,
          {
            strategy: { kind: 'dom-hint', css: '(diagnostic)' },
            matched: 0,
            note:
              `perception was truncated in frame(s) ${obs.truncatedFrames.join(', ')} at the ${MAX_PERCEIVED_CONTROLS}-control cap; ` +
              'the target may exist but be unreported',
          },
        ],
      };
    }
    return result;
  }

  // ------------------------------------------------------------------- perform

  async perform(action: Action): Promise<ActionResult> {
    try {
      switch (action.kind) {
        case 'navigate': {
          const seq = this.navSeq;
          await this.page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: this.opts.settleTimeoutMs });
          await this.settle(seq);
          return { ok: true, navigated: true };
        }

        case 'press': {
          const seq = this.navSeq;
          await this.page.keyboard.press(action.key);
          await this.settle(seq);
          return { ok: true };
        }

        case 'waitFor': {
          const r = await this.evaluate(action.condition, { timeoutMs: action.timeoutMs ?? this.opts.conditionTimeoutMs });
          return r.satisfied
            ? { ok: true }
            : { ok: false, error: { code: 'CONDITION_TIMEOUT', message: 'wait condition never became true', observed: r.observed } };
        }

        case 'assert': {
          const r = await this.evaluate(action.condition, { timeoutMs: 0 });
          return r.satisfied
            ? { ok: true }
            : { ok: false, error: { code: 'CONDITION_TIMEOUT', message: 'assertion did not hold', observed: r.observed } };
        }

        case 'click':
        case 'fill':
        case 'select':
        case 'readText':
          return await this.performOnTarget(action);
      }
    } catch (err) {
      return { ok: false, error: { code: 'SURFACE_FAULT', message: errMsg(err) } };
    }
  }

  private async performOnTarget(
    action: Extract<Action, { kind: 'click' | 'fill' | 'select' | 'readText' }>,
  ): Promise<ActionResult> {
    const mutating = action.kind !== 'readText';
    const res = await this.resolve(action.target, mutating);
    if (!res.ok) {
      return {
        ok: false,
        error: {
          code: res.code,
          message: `could not resolve ${describeTarget(action.target)}`,
          observed: res.attempts
            .map((a) => `${a.strategy.kind}: ${a.note ?? `${a.matched} match(es)`}`)
            .join(' | '),
        },
      };
    }

    const frame = this.frameByPath(res.control.container.framePath);
    if (!frame) {
      return { ok: false, error: { code: 'SURFACE_FAULT', message: `frame ${res.control.container.framePath.join('/')} disappeared` } };
    }
    const locator = frame.locator(`[${REF_ATTR}="${domRef(res.ref)}"]`);
    const base = {
      strategyUsed: res.strategyUsed,
      strategyIndex: res.strategyIndex,
      ...(res.alsoMatched.length ? { narrowedFrom: res.alsoMatched.length + 1 } : {}),
    };

    switch (action.kind) {
      case 'click': {
        const seq = this.navSeq;
        await locator.click({ timeout: this.opts.settleTimeoutMs });
        await this.settle(seq);
        return { ok: true, ...base, navigated: this.navSeq !== seq };
      }

      case 'fill':
        await locator.fill(action.value, { timeout: this.opts.settleTimeoutMs });
        return { ok: true, ...base };

      case 'select':
        // Try by value first, then by visible label. Tenants relabel options
        // while keeping the underlying codes, so the code is the durable key.
        try {
          await locator.selectOption({ value: action.value }, { timeout: 3000 });
        } catch {
          await locator.selectOption({ label: action.value }, { timeout: 3000 });
        }
        return { ok: true, ...base };

      case 'readText': {
        const value = (res.control.value ?? res.control.name ?? '').trim();
        return { ok: true, value, ...base };
      }
    }
  }

  // ----------------------------------------------------------------- evaluate

  async evaluate(condition: Condition, opts: { timeoutMs?: number } = {}): Promise<ConditionResult> {
    const budget = opts.timeoutMs ?? this.opts.conditionTimeoutMs;
    const deadline = Date.now() + budget;
    let last: ConditionResult = { satisfied: false, observed: 'never evaluated' };

    for (;;) {
      const obs = await this.observe();
      last = evaluateAgainst(condition, obs);
      if (last.satisfied) return last;
      if (Date.now() >= deadline) return last;
      await sleep(Math.min(400, Math.max(50, deadline - Date.now())));
    }
  }

  // ----------------------------------------------------------------- evidence

  async location(): Promise<{ url: string; title: string; frameUrls: string[] }> {
    try {
      return {
        url: this.page.url(),
        title: await this.page.title(),
        frameUrls: this.frameTree().map((f) => safeUrl(f.frame)),
      };
    } catch {
      return { url: 'about:unknown', title: '', frameUrls: [] };
    }
  }

  /** Persist only layout: text and form values are never trusted to be non-PII. */
  async screenshot(path: string, _opts: { maskSensitive?: boolean } = {}): Promise<string | undefined> {
    const styles: import('playwright').ElementHandle[] = [];
    try {
      await mkdir(dirname(path), { recursive: true });
      for (const { frame } of this.frameTree()) {
        // A disappearing frame is a failed capture, not permission to capture it unmasked.
        styles.push(await frame.addStyleTag({ content: `
          * { color: transparent !important; text-shadow: none !important;
              background-image: none !important; caret-color: transparent !important; }
          *::before, *::after { content: none !important; }
          input, textarea, select, img, svg, canvas, video, object, embed { visibility: hidden !important; }
        ` }));
      }
      await this.page.screenshot({ path, fullPage: false, animations: 'disabled' });
      return path;
    } catch {
      return undefined;
    } finally {
      for (const style of styles) await style.evaluate((el) => el.parentNode?.removeChild(el)).catch(() => {});
    }
  }

  /** Structure-only DOM: no text, attributes containing values, URLs, scripts or hidden tokens. */
  async sourceSnapshot(path: string): Promise<string | undefined> {
    try {
      await mkdir(dirname(path), { recursive: true });
      const parts: string[] = ['<!-- ledgerhand-sanitized-evidence-v1 -->'];
      let index = 0;
      for (const { frame } of this.frameTree()) {
        const html = await frame.evaluate(() => {
          const root = document.body.cloneNode(true) as HTMLElement;
          root.querySelectorAll('script,style,noscript,template,input[type="hidden"],iframe,object,embed,svg,canvas,img,video,audio').forEach((el) => el.parentNode?.removeChild(el));
          const visit = (node: Node): void => {
            if (node.nodeType === Node.TEXT_NODE) { node.textContent = node.textContent?.trim() ? '[redacted]' : ''; return; }
            if (node.nodeType === Node.COMMENT_NODE) { node.parentNode?.removeChild(node); return; }
            if (node instanceof Element) {
              for (const attr of Array.from(node.attributes)) node.removeAttribute(attr.name);
            }
            Array.from(node.childNodes).forEach(visit);
          };
          visit(root);
          return root.outerHTML;
        });
        parts.push(`<!-- frame ${index++} -->\n${html}`);
      }
      await writeFile(path, parts.join('\n'), 'utf8');
      return path;
    } catch {
      return undefined;
    }
  }

  lastSeen(): Observation | undefined {
    return this.lastObservation;
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
  }

  // ------------------------------------------------------------------ internals

  private frameTree(): { frame: Frame; path: string[] }[] {
    const out: { frame: Frame; path: string[] }[] = [];
    const walk = (frame: Frame, path: string[]) => {
      out.push({ frame, path });
      frame.childFrames().forEach((child, i) => {
        const name = child.name() || `#${i}`;
        walk(child, [...path, name]);
      });
    };
    walk(this.page.mainFrame(), []);
    return out;
  }

  private frameByPath(path: string[]): Frame | undefined {
    return this.frameTree().find((f) => samePath(f.path, path))?.frame;
  }

  /**
   * Wait for the document tree to stop loading.
   *
   * This is the one place where naive automation on this class of app goes
   * wrong, so it is worth being explicit. Clicking a submit button does not
   * navigate synchronously: the click returns, and the navigation starts a beat
   * later. `waitForLoadState` at that moment resolves instantly against the
   * document that is still on screen, so perception reads the *old* page and
   * every downstream decision is made about a screen that no longer exists.
   *
   * The fix is to ask the browser rather than a timer. `framenavigated` bumps
   * `navSeq`; if the caller passes the sequence number from before its action,
   * we can distinguish "no navigation was triggered" from "a navigation is
   * about to start", and in the latter case wait for the whole frame tree --
   * including the redirect chain and the child frames of a frameset -- to go
   * quiet.
   *
   * Two bounded timers remain, and neither is load-bearing for correctness:
   *
   *   - `navGraceMs`: how long to wait for a navigation to *start* before
   *     concluding the action was in-page. Guessing low here costs a wasted
   *     perception, not a wrong answer.
   *   - `quietMs`: quiescence window used to detect the end of a redirect chain.
   *
   * Correctness comes from Conditions, which poll against fresh observations
   * until their budget expires. `settle` only reduces how many polls that takes.
   */
  private async settle(seqBefore?: number): Promise<void> {
    const deadline = Date.now() + this.opts.settleTimeoutMs;
    const navGraceMs = 600;
    const quietMs = 150;

    if (seqBefore !== undefined && this.navSeq === seqBefore) {
      const graceEnd = Math.min(Date.now() + navGraceMs, deadline);
      while (this.navSeq === seqBefore && Date.now() < graceEnd) await sleep(20);
    }

    await this.waitFramesLoaded(deadline);

    // A frameset load, or a POST that 302s, produces several navigations in a
    // row. Keep waiting while new ones keep arriving.
    for (;;) {
      const mark = this.navSeq;
      await sleep(Math.min(quietMs, Math.max(0, deadline - Date.now())));
      if (this.navSeq === mark || Date.now() >= deadline) break;
      await this.waitFramesLoaded(deadline);
    }
  }

  private async waitFramesLoaded(deadline: number): Promise<void> {
    try {
      await this.page.waitForLoadState('domcontentloaded', { timeout: Math.max(200, deadline - Date.now()) });
    } catch {
      /* still loading; perception reports what is there now */
    }
    for (const { frame } of this.frameTree()) {
      if (Date.now() >= deadline) break;
      try {
        await frame.waitForLoadState('domcontentloaded', { timeout: Math.max(200, Math.min(3000, deadline - Date.now())) });
      } catch {
        /* a frame can detach mid-wait; not fatal */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Condition evaluation -- pure, over an Observation.
// ---------------------------------------------------------------------------

/**
 * Exported and pure so conditions can be unit-tested against fixture
 * observations without a browser, and so a desktop driver gets the same
 * semantics for free.
 */
export function evaluateAgainst(condition: Condition, obs: Observation): ConditionResult {
  switch (condition.kind) {
    case 'controlPresent': {
      const r = matchTarget(obs.controls, condition.target);
      return r.ok
        ? { satisfied: true, observed: `found ${r.control.role} "${r.control.name}" via ${r.strategyUsed.kind}` }
        : { satisfied: false, observed: `${describeTarget(condition.target)} not resolvable (${r.code})` };
    }
    case 'controlAbsent': {
      const r = matchTarget(obs.controls, condition.target);
      return r.ok
        ? { satisfied: false, observed: `${describeTarget(condition.target)} is still present` }
        : { satisfied: true, observed: 'absent' };
    }
    case 'textPresent': {
      const re = safeRegExp(condition.pattern, condition.ignoreCase ?? true);
      if (!re) return { satisfied: false, observed: `invalid pattern /${condition.pattern}/` };
      const hit = re.exec(obs.text);
      return hit
        ? { satisfied: true, observed: `matched "${truncate(hit[0], 120)}"` }
        : { satisfied: false, observed: `/${condition.pattern}/ not found in ${obs.text.length} chars of visible text` };
    }
    case 'textAbsent': {
      const re = safeRegExp(condition.pattern, condition.ignoreCase ?? true);
      if (!re) return { satisfied: false, observed: `invalid pattern /${condition.pattern}/` };
      const hit = re.exec(obs.text);
      return hit
        ? { satisfied: false, observed: `unexpectedly matched "${truncate(hit[0], 120)}"` }
        : { satisfied: true, observed: 'absent' };
    }
    case 'urlMatches': {
      const re = safeRegExp(condition.pattern, true);
      if (!re) return { satisfied: false, observed: `invalid pattern /${condition.pattern}/` };
      const anyFrame = [obs.url, ...obs.frames.map((f) => f.url)];
      const hit = anyFrame.find((u) => re.test(u));
      return hit
        ? { satisfied: true, observed: `url ${hit}` }
        : { satisfied: false, observed: `no frame url matched; saw ${anyFrame.join(', ')}` };
    }
    case 'valueMatches': {
      const r = matchTarget(obs.controls, condition.target);
      if (!r.ok) return { satisfied: false, observed: `${describeTarget(condition.target)} not resolvable (${r.code})` };
      const re = safeRegExp(condition.pattern, true);
      if (!re) return { satisfied: false, observed: `invalid pattern /${condition.pattern}/` };
      const actual = r.control.value ?? r.control.name;
      return re.test(actual)
        ? { satisfied: true, observed: `value "${truncate(actual, 80)}"` }
        : { satisfied: false, observed: `value was "${truncate(actual, 80)}"` };
    }
    case 'all': {
      const results = condition.of.map((c) => evaluateAgainst(c, obs));
      const failed = results.findIndex((r) => !r.satisfied);
      return failed === -1
        ? { satisfied: true, observed: `all ${results.length} sub-conditions held` }
        : { satisfied: false, observed: `sub-condition ${failed + 1} failed: ${results[failed]!.observed}` };
    }
    case 'any': {
      const results = condition.of.map((c) => evaluateAgainst(c, obs));
      const passed = results.findIndex((r) => r.satisfied);
      return passed >= 0
        ? { satisfied: true, observed: `sub-condition ${passed + 1} held: ${results[passed]!.observed}` }
        : { satisfied: false, observed: `none of ${results.length} sub-conditions held` };
    }
    case 'not': {
      const r = evaluateAgainst(condition.of, obs);
      return { satisfied: !r.satisfied, observed: `negated: ${r.observed}` };
    }
  }
}

// ---------------------------------------------------------------------------

function hydrate(rc: RawControl, framePath: string[]): PerceivedControl {
  const control: PerceivedControl = {
    ref: rc.ref,
    role: rc.role,
    name: rc.name,
    nameSource: rc.nameSource as PerceivedControl['nameSource'],
    container: { framePath, ...(rc.section ? { section: rc.section } : {}), ...(rc.table ? { table: rc.table } : {}) },
    targeting: rc.targeting as PerceivedControl['targeting'],
  };
  if (rc.value !== undefined) control.value = rc.value;
  if (rc.disabled) control.disabled = true;
  if (rc.checked !== undefined) control.checked = rc.checked;
  if (rc.readonly) control.readonly = true;
  if (rc.box) control.box = rc.box;
  // A ref stamped in a frame must carry the frame, or two frames collide on "1:3".
  control.ref = framePath.length ? `${framePath.join('/')}|${rc.ref}` : rc.ref;
  return control;
}

/**
 * The build step (esbuild, via tsx) rewrites named inner functions as
 * `__name(fn, "fn")` to preserve `Function.prototype.name`. When we serialize
 * `perceiveInPage` into the page, those `__name` calls come along and there is
 * no such helper in page scope, so perception throws before it reads anything.
 *
 * The fix installs a no-op `__name` in the page instead of reconstructing the
 * function with `new Function`. That choice is deliberate: `new Function` is
 * blocked outright by a `script-src` CSP without `unsafe-eval`, which legacy
 * enterprise apps do ship, and a perception layer that dies on some tenants'
 * apps and not others would be a miserable thing to debug.
 */
const NAME_SHIM = `(() => { if (typeof globalThis.__name !== 'function') { globalThis.__name = (f) => f; } })();`;

async function evaluatePerception(frame: Frame, generation: number): Promise<RawPerception> {
  // addInitScript covers documents loaded after launch; this covers the rest
  // (already-open documents, and frames that were live before we attached).
  await frame.evaluate(NAME_SHIM);
  return frame.evaluate(perceiveInPage, generation);
}

/**
 * Refs are namespaced by frame path in Node (`bodyFrame|3:14`) so two frames
 * cannot collide on the same slot number, but the attribute stamped in the
 * document is the bare `3:14`. Strip the namespace before building a locator.
 */
function domRef(ref: string): string {
  const bar = ref.lastIndexOf('|');
  return bar === -1 ? ref : ref.slice(bar + 1);
}

/** Generation embedded in a ref, used to detect a caller acting on stale perception. */
export function refGeneration(ref: string): number {
  const bare = domRef(ref);
  return Number(bare.split(':')[0] ?? NaN);
}

function samePath(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function safeUrl(frame: Frame | undefined): string {
  try {
    return frame?.url() ?? '';
  } catch {
    return '';
  }
}

function safeRegExp(pattern: string, ignoreCase: boolean): RegExp | undefined {
  try {
    return new RegExp(pattern, ignoreCase ? 'i' : '');
  } catch {
    return undefined;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message.split('\n')[0]! : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
