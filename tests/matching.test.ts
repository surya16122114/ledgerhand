import { describe, expect, it } from 'vitest';
import { matchTarget, normalizeText, describeTarget } from '../src/surface/matching.js';
import {
  bodyHomeLink,
  checkingBalanceCell,
  memberIdField,
  navHomeLink,
  savingsBalanceCell,
  searchButton,
} from './fixtures.js';

describe('normalizeText', () => {
  it('collapses whitespace, strips trailing label punctuation, and casefolds', () => {
    expect(normalizeText('  Member   ID: ')).toBe('member id');
    expect(normalizeText('Account Holder #')).toBe('account holder #');
  });
});

describe('matchTarget', () => {
  const controls = [memberIdField, searchButton, savingsBalanceCell, checkingBalanceCell, navHomeLink, bodyHomeLink];

  it('resolves a legacy form field by its synthesised adjacent-cell label', () => {
    const res = matchTarget(controls, {
      description: 'member id field',
      strategies: [{ kind: 'labelled-field', label: 'Member ID', labelMatch: 'normalized', role: 'textbox' }],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.control.ref).toBe(memberIdField.ref);
      expect(res.strategyIndex).toBe(0);
    }
  });

  it('addresses a table cell by row key and column header rather than by index', () => {
    const res = matchTarget(controls, {
      description: 'savings balance',
      strategies: [
        { kind: 'table-cell', near: 'SHARE / DEPOSIT ACCOUNTS', rowKey: '12345-00', rowKeyMatch: 'normalized', columnHeader: 'Current Balance' },
      ],
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.control.value).toBe('$8,241.77');
  });

  it('falls back to a later strategy and reports which one won', () => {
    const res = matchTarget(controls, {
      description: 'search button',
      strategies: [
        // Wrong name: this is what tenant drift looks like.
        { kind: 'role-name', role: 'button', name: 'Find', nameMatch: 'exact' },
        { kind: 'role-name', role: 'button', name: 'Search', nameMatch: 'normalized' },
      ],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.strategyIndex).toBe(1);
      expect(res.strategyUsed.kind).toBe('role-name');
    }
  });

  it('uses the recorded frame path to disambiguate the same name in two frames', () => {
    const res = matchTarget(controls, {
      description: 'nav home link',
      framePath: ['navFrame'],
      strategies: [{ kind: 'role-name', role: 'link', name: 'Home', nameMatch: 'normalized' }],
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.control.ref).toBe(navHomeLink.ref);
  });

  it('fails as ambiguous rather than guessing when narrowing cannot reduce to one', () => {
    // No framePath declared, and "Home" exists in both frames.
    const res = matchTarget(controls, {
      description: 'home link',
      strategies: [{ kind: 'role-name', role: 'link', name: 'Home', nameMatch: 'normalized' }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('TARGET_AMBIGUOUS');
  });

  it('does not fall through to a weaker strategy after an ambiguous match', () => {
    const res = matchTarget(controls, {
      description: 'home link',
      strategies: [
        { kind: 'role-name', role: 'link', name: 'Home', nameMatch: 'normalized' },
        // A weaker description cannot resolve an ambiguity a precise one could not,
        // so this must never be reached.
        { kind: 'text', text: 'Home', textMatch: 'contains' },
      ],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.attempts).toHaveLength(1);
  });

  it('reports per-strategy detail when nothing matches, so a failure is debuggable', () => {
    const res = matchTarget(controls, {
      description: 'nonexistent',
      strategies: [
        { kind: 'role-name', role: 'button', name: 'Post Transfer', nameMatch: 'exact' },
        { kind: 'labelled-field', label: 'Routing Number', labelMatch: 'normalized', role: 'textbox' },
      ],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('TARGET_NOT_FOUND');
      expect(res.attempts.map((a) => a.strategy.kind)).toEqual(['role-name', 'labelled-field']);
      expect(res.attempts.every((a) => a.matched === 0)).toBe(true);
    }
  });

  it('refuses a disabled control when the action needs to be actionable', () => {
    const disabled = { ...searchButton, ref: 'x', disabled: true };
    const res = matchTarget([disabled], {
      description: 'search',
      strategies: [{ kind: 'role-name', role: 'button', name: 'Search', nameMatch: 'normalized' }],
    }, { requireActionable: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('TARGET_NOT_ACTIONABLE');
  });

  it('prefers an enabled control over a disabled one with the same name', () => {
    const disabled = { ...searchButton, ref: 'disabled-dup', disabled: true };
    const res = matchTarget([disabled, searchButton], {
      description: 'search',
      strategies: [{ kind: 'role-name', role: 'button', name: 'Search', nameMatch: 'normalized' }],
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.control.ref).toBe(searchButton.ref);
  });

  it('matches a labelled-field strategy against a properly authored label too', () => {
    // The same capability must keep working if a tenant upgrades to a build that
    // finally wires up <label for>.
    const modernised = { ...memberIdField, nameSource: 'label-for' as const };
    const res = matchTarget([modernised], {
      description: 'member id',
      strategies: [{ kind: 'labelled-field', label: 'Member ID', labelMatch: 'normalized', role: 'textbox' }],
    });
    expect(res.ok).toBe(true);
  });

  it('matches a dom-hint by comparing against the hint perception recorded', () => {
    const res = matchTarget([memberIdField], {
      description: 'member id',
      strategies: [{ kind: 'dom-hint', css: '#ctl00_MainContent_txtMemberId' }],
    });
    expect(res.ok).toBe(true);
  });

  it('reports anchor-offset as unsupported on a tree-based surface instead of silently failing', () => {
    const res = matchTarget([memberIdField], {
      description: 'member id by pixel',
      strategies: [{ kind: 'anchor-offset', anchorText: 'Member ID', dx: 80, dy: 0 }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.attempts[0]?.note).toMatch(/coordinate-capable/);
  });
});

describe('describeTarget', () => {
  it('renders a one-line description including the frame', () => {
    expect(
      describeTarget({
        description: 'member id field',
        framePath: ['bodyFrame'],
        strategies: [{ kind: 'labelled-field', label: 'Member ID', labelMatch: 'normalized', role: 'textbox' }],
      }),
    ).toBe('member id field (textbox labelled "Member ID" @bodyFrame)');
  });
});
