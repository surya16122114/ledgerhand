/**
 * Recording what the human did.
 *
 * When an operator takes over a live session, their actions have to end up in the
 * audit record for the same reason the automation's do -- and, more usefully, they
 * are the raw material for extending the capability. A handoff that happens at the
 * same step on every run is a missing step in the artifact, and this is the data
 * that tells you which one.
 *
 * Implemented as capture-phase listeners installed in every frame, reporting
 * through a Playwright binding. Deliberately *not* implemented by diffing
 * observations before and after: a diff cannot tell a click from a keystroke, and
 * loses the order.
 *
 * The script is a plain string rather than a serialized function, which sidesteps
 * the build-helper problem described in playwright-surface.ts and keeps the
 * injected payload readable in a code review.
 */

import type { Page } from 'playwright';
import type { HumanAction } from './broker.js';

const RECORDER_SCRIPT = String.raw`
(() => {
  if (window.__lhRecorderInstalled) return;
  window.__lhRecorderInstalled = true;

  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const strip = (s) => norm(s).replace(/[\s:*]+$/, '');

  const roleOf = (el) => {
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
      if (t === 'password') return 'password';
      if (t === 'checkbox' || t === 'radio') return t;
      return 'textbox';
    }
    return tag || 'unknown';
  };

  // Same synthesis idea as the perception layer: on these apps the visible label
  // is in a sibling table cell, so that is where a control's name comes from.
  const nameOf = (el) => {
    const aria = norm(el.getAttribute && el.getAttribute('aria-label'));
    if (aria) return aria;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'submit' || t === 'button' || t === 'reset') return norm(el.value);
    }
    if (tag === 'a' || tag === 'button') {
      const txt = norm(el.innerText || el.textContent);
      if (txt) return txt;
    }
    const cell = el.closest && el.closest('td, th');
    if (cell) {
      let prev = cell.previousElementSibling;
      while (prev) {
        if (!prev.querySelector('input, select, textarea, button, a[href]')) {
          const txt = strip(prev.innerText || prev.textContent);
          if (txt && txt.length <= 60) return txt;
        }
        prev = prev.previousElementSibling;
      }
    }
    return norm(el.id || el.name || tag);
  };

  const send = (payload) => {
    try {
      if (window.__lhRecordHumanAction) window.__lhRecordHumanAction(payload);
    } catch (e) {
      /* the page must keep working even if the channel is gone */
    }
  };

  document.addEventListener(
    'click',
    (e) => {
      const el = e.target;
      if (!el || !el.tagName) return;
      const actionable = el.closest('a, button, input, select, textarea, [onclick]') || el;
      send({ kind: 'click', role: roleOf(actionable), control: nameOf(actionable), url: location.href });
    },
    true,
  );

  document.addEventListener(
    'change',
    (e) => {
      const el = e.target;
      if (!el || !el.tagName) return;
      const role = roleOf(el);
      // A password the human typed is not evidence we want. Recorded as an event
      // with no value at all rather than a redacted one, so there is nothing to
      // leak even if redaction is misconfigured downstream.
      const value = role === 'password' ? undefined : norm(el.value);
      send({ kind: 'change', role, control: nameOf(el), value, url: location.href });
    },
    true,
  );

  window.addEventListener('beforeunload', () => {
    send({ kind: 'navigate', url: location.href });
  });
})();
`;

export interface HumanRecorderHandle {
  detach(): void;
}

const recorderStates = new WeakMap<Page, { sink?: (action: HumanAction) => void }>();

export async function attachHumanActionRecorder(
  page: Page,
  sink: (action: HumanAction) => void,
): Promise<HumanRecorderHandle> {
  const existing = recorderStates.get(page);
  if (existing) {
    existing.sink = sink;
    return { detach() { if (existing.sink === sink) existing.sink = undefined; } };
  }
  const state: { sink?: (action: HumanAction) => void } = { sink };

  await page.exposeBinding('__lhRecordHumanAction', (source, payload) => {
    if (!state.sink) return;
    const p = (payload ?? {}) as Partial<HumanAction>;
    const framePath: string[] = [];
    let frame = source.frame;
    while (frame && frame.parentFrame()) {
      framePath.unshift(frame.name() || '#');
      frame = frame.parentFrame()!;
    }
    state.sink({
      at: new Date().toISOString(),
      kind: (p.kind as HumanAction['kind']) ?? 'click',
      ...(p.control ? { control: p.control } : {}),
      ...(p.role ? { role: p.role } : {}),
      ...(framePath.length ? { framePath } : {}),
      ...(p.value !== undefined ? { value: p.value } : {}),
      ...(p.url ? { url: p.url } : {}),
    });
  });

  recorderStates.set(page, state);
  await page.addInitScript(RECORDER_SCRIPT);
  // addInitScript only affects documents loaded from now on; the session already
  // has documents open, so install into those too.
  for (const frame of page.frames()) {
    await frame.evaluate(RECORDER_SCRIPT).catch(() => {});
  }

  return {
    detach() {
      if (state.sink === sink) state.sink = undefined;
    },
  };
}
