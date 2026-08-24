/**
 * Target resolution.
 *
 * This module is pure and surface-independent: it maps
 * (PerceivedControl[], TargetDescriptor) -> Resolution. The web driver and a
 * future desktop driver share it verbatim, which is the point -- "how do I find
 * the control the artifact is talking about" is a question about semantics, not
 * about Chromium.
 *
 * Two rules matter more than the rest:
 *
 * 1. Strategies are tried in the order the artifact records them, and the index
 *    of the winner is reported. A fallback firing is not a failure, it is the
 *    cheapest early-warning signal of tenant or version drift, so it gets
 *    surfaced rather than swallowed.
 *
 * 2. Ambiguity is an error, not a coin flip. If a strategy matches several
 *    controls and the narrowing rules below cannot reduce it to one, resolution
 *    fails with TARGET_AMBIGUOUS. Silently taking the first match is how
 *    automation ends up clicking the wrong "Submit" on a screen with two forms.
 */

import type {
  ControlRole,
  NameMatch,
  PerceivedControl,
  Resolution,
  TargetDescriptor,
  TargetStrategy,
} from './types.js';

/** Collapse whitespace, drop trailing label punctuation, casefold. */
export function normalizeText(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .replace(/[\s:*]+$/, '')
    .trim()
    .toLowerCase();
}

export function matchesText(actual: string, expected: string, mode: NameMatch): boolean {
  switch (mode) {
    case 'exact':
      return actual === expected;
    case 'normalized':
      return normalizeText(actual) === normalizeText(expected);
    case 'contains':
      return normalizeText(actual).includes(normalizeText(expected));
    case 'regex':
      try {
        return new RegExp(expected, 'i').test(actual);
      } catch {
        return false;
      }
  }
}

const FIELD_ROLES: ControlRole[] = ['textbox', 'password', 'combobox', 'checkbox', 'radio'];

function samePath(a: string[] | undefined, b: string[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** Controls a single strategy matches, before narrowing. */
function candidatesFor(controls: PerceivedControl[], strategy: TargetStrategy): { matched: PerceivedControl[]; note?: string } {
  switch (strategy.kind) {
    case 'role-name':
      return {
        matched: controls.filter((c) => c.role === strategy.role && matchesText(c.name, strategy.name, strategy.nameMatch)),
      };

    case 'labelled-field': {
      // Matches on the field's *effective* label regardless of whether that
      // label was authored (`<label for>`) or synthesized from an adjacent cell.
      // That is deliberate: it means a capability recorded against the legacy
      // build keeps working if a tenant upgrades to a build that finally wires
      // up its labels properly.
      const matched = controls.filter(
        (c) => c.role === strategy.role && FIELD_ROLES.includes(c.role) && matchesText(c.name, strategy.label, strategy.labelMatch),
      );
      return { matched };
    }

    case 'text': {
      const matched = controls.filter(
        (c) => (!strategy.role || c.role === strategy.role) && matchesText(c.name, strategy.text, strategy.textMatch),
      );
      return { matched };
    }

    case 'table-cell': {
      const matched = controls.filter((c) => {
        if (c.role !== 'cell') return false;
        const t = c.container.table;
        if (!t?.rowKey || !t.columnHeader) return false;
        if (!matchesText(t.rowKey, strategy.rowKey, strategy.rowKeyMatch)) return false;
        if (normalizeText(t.columnHeader) !== normalizeText(strategy.columnHeader)) return false;
        if (strategy.near && t.near && normalizeText(t.near) !== normalizeText(strategy.near)) return false;
        return true;
      });
      return { matched };
    }

    case 'section-ordinal': {
      // Ordinal by construction: the index IS the disambiguator, so a multi-match
      // here is expected and resolved by position rather than reported as ambiguous.
      const inSection = controls.filter(
        (c) => c.container.section && normalizeText(c.container.section) === normalizeText(strategy.section) && c.role === strategy.role,
      );
      const hit = inSection[strategy.index];
      return {
        matched: hit ? [hit] : [],
        note: hit ? undefined : `section '${strategy.section}' had ${inSection.length} ${strategy.role} control(s), index ${strategy.index} out of range`,
      };
    }

    case 'dom-hint': {
      // Compared against the hint perception recorded for each control, so this
      // module stays free of any DOM querying of its own.
      const matched = controls.filter((c) =>
        c.targeting.some((s) => s.kind === 'dom-hint' && s.css === strategy.css),
      );
      return { matched };
    }

    case 'anchor-offset':
      return { matched: [], note: 'anchor-offset requires a coordinate-capable driver; not supported by this surface' };
  }
}

/**
 * Narrowing, applied only when a strategy matched more than one control.
 * Each rule must be defensible in a post-incident review; "pick the first" is not.
 */
function narrow(
  matched: PerceivedControl[],
  target: TargetDescriptor,
  strategy: TargetStrategy,
): { chosen?: PerceivedControl; rest: PerceivedControl[]; note?: string } {
  let pool = matched;

  // Rule 1: honour the frame the artifact recorded. On a frameset app the same
  // control name legitimately exists in the nav frame and the body frame.
  if (target.framePath) {
    const inFrame = pool.filter((c) => samePath(c.container.framePath, target.framePath));
    if (inFrame.length >= 1 && inFrame.length < pool.length) pool = inFrame;
  }

  // Rule 2: an exact name match beats a loose one.
  if (pool.length > 1) {
    const expected = strategy.kind === 'role-name' ? strategy.name : strategy.kind === 'labelled-field' ? strategy.label : strategy.kind === 'text' ? strategy.text : undefined;
    if (expected !== undefined) {
      const exact = pool.filter((c) => c.name === expected);
      if (exact.length === 1) pool = exact;
    }
  }

  // Rule 3: an enabled control beats a disabled one.
  if (pool.length > 1) {
    const enabled = pool.filter((c) => !c.disabled);
    if (enabled.length === 1) pool = enabled;
  }

  if (pool.length === 1) {
    const chosen = pool[0]!;
    return { chosen, rest: matched.filter((c) => c !== chosen) };
  }
  return { rest: matched, note: `${matched.length} controls matched and narrowing rules could not reduce to one` };
}

export interface MatchOptions {
  /** Reject a control that is present but not actionable. Set for click/fill. */
  requireActionable?: boolean;
}

export function matchTarget(
  controls: PerceivedControl[],
  target: TargetDescriptor,
  opts: MatchOptions = {},
): Resolution {
  const attempts: { strategy: TargetStrategy; matched: number; note?: string }[] = [];

  for (let i = 0; i < target.strategies.length; i++) {
    const strategy = target.strategies[i]!;
    const { matched, note } = candidatesFor(controls, strategy);

    if (matched.length === 0) {
      attempts.push({ strategy, matched: 0, note });
      continue;
    }

    let chosen: PerceivedControl | undefined;
    let alsoMatched: PerceivedControl[] = [];

    if (matched.length === 1) {
      chosen = matched[0]!;
    } else {
      const narrowed = narrow(matched, target, strategy);
      if (!narrowed.chosen) {
        attempts.push({ strategy, matched: matched.length, note: narrowed.note });
        // Ambiguity is terminal for this strategy. Continuing to a weaker
        // strategy would be worse: a vaguer description cannot resolve an
        // ambiguity a more precise one could not.
        return { ok: false, code: 'TARGET_AMBIGUOUS', attempts };
      }
      chosen = narrowed.chosen;
      alsoMatched = narrowed.rest;
    }

    if (opts.requireActionable && chosen.disabled) {
      attempts.push({ strategy, matched: matched.length, note: `matched '${chosen.name}' but it is disabled` });
      return { ok: false, code: 'TARGET_NOT_ACTIONABLE', attempts };
    }

    attempts.push({ strategy, matched: matched.length });
    return { ok: true, ref: chosen.ref, control: chosen, strategyUsed: strategy, strategyIndex: i, alsoMatched };
  }

  return { ok: false, code: 'TARGET_NOT_FOUND', attempts };
}

/** One-line rendering of a descriptor, for logs and failure messages. */
export function describeTarget(target: TargetDescriptor): string {
  const head = target.strategies[0];
  const via = head
    ? head.kind === 'role-name'
      ? `${head.role} "${head.name}"`
      : head.kind === 'labelled-field'
        ? `${head.role} labelled "${head.label}"`
        : head.kind === 'text'
          ? `"${head.text}"`
          : head.kind === 'table-cell'
            ? `cell [${head.rowKey} / ${head.columnHeader}]`
            : head.kind === 'section-ordinal'
              ? `${head.role} #${head.index} in "${head.section}"`
              : head.kind === 'dom-hint'
                ? head.css
                : `anchor "${head.anchorText}"`
    : 'no strategies';
  const frame = target.framePath?.length ? ` @${target.framePath.join('/')}` : '';
  return `${target.description} (${via}${frame})`;
}

/** Human-readable account of a failed resolution. Used verbatim in failure evidence. */
export function explainResolutionFailure(res: Extract<Resolution, { ok: false }>): string {
  const lines = res.attempts.map((a, i) => {
    const label = a.strategy.kind;
    const detail = a.note ? ` -- ${a.note}` : a.matched === 0 ? ' -- no match' : ` -- ${a.matched} matches`;
    return `  ${i + 1}. ${label}${detail}`;
  });
  return `${res.code}\n${lines.join('\n')}`;
}
