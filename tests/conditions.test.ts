import { describe, expect, it } from 'vitest';
import { evaluateAgainst } from '../src/surface/web/playwright-surface.js';
import { memberIdField, observation, savingsBalanceCell, searchButton } from './fixtures.js';

/**
 * Condition evaluation is pure over an Observation, which is what makes it
 * testable without a browser -- and what will let a desktop driver inherit the
 * exact same semantics.
 */
describe('evaluateAgainst', () => {
  const obs = observation([memberIdField, searchButton, savingsBalanceCell]);

  it('matches visible text case-insensitively by default', () => {
    expect(evaluateAgainst({ kind: 'textPresent', pattern: 'member profile' }, obs).satisfied).toBe(true);
  });

  it('reports what it actually saw when text is absent', () => {
    const r = evaluateAgainst({ kind: 'textPresent', pattern: 'No records found' }, obs);
    expect(r.satisfied).toBe(false);
    expect(r.observed).toMatch(/not found in \d+ chars/);
  });

  it('checks urlMatches against every frame, not just the top document', () => {
    // The frameset's top url is console.aspx; the interesting url is in bodyFrame.
    expect(evaluateAgainst({ kind: 'urlMatches', pattern: '/member-detail\\.aspx' }, obs).satisfied).toBe(true);
  });

  it('treats an invalid regex as unsatisfied rather than throwing', () => {
    const r = evaluateAgainst({ kind: 'textPresent', pattern: '([unclosed' }, obs);
    expect(r.satisfied).toBe(false);
    expect(r.observed).toMatch(/invalid pattern/);
  });

  it('resolves controlPresent through the full targeting list', () => {
    expect(
      evaluateAgainst(
        { kind: 'controlPresent', target: { description: 'search', strategies: [{ kind: 'role-name', role: 'button', name: 'Search', nameMatch: 'normalized' }] } },
        obs,
      ).satisfied,
    ).toBe(true);
  });

  it('reads a value through valueMatches', () => {
    expect(
      evaluateAgainst(
        {
          kind: 'valueMatches',
          target: { description: 'savings balance', strategies: savingsBalanceCell.targeting },
          pattern: '^\\$[\\d,]+\\.\\d{2}$',
        },
        obs,
      ).satisfied,
    ).toBe(true);
  });

  it('names the failing sub-condition in an all(...)', () => {
    const r = evaluateAgainst(
      {
        kind: 'all',
        of: [
          { kind: 'textPresent', pattern: 'MEMBER PROFILE' },
          { kind: 'textPresent', pattern: 'Sub-Account Opened' },
        ],
      },
      obs,
    );
    expect(r.satisfied).toBe(false);
    expect(r.observed).toMatch(/sub-condition 2 failed/);
  });

  it('short-circuits any(...) and says which branch held', () => {
    const r = evaluateAgainst(
      { kind: 'any', of: [{ kind: 'textPresent', pattern: 'nope' }, { kind: 'textPresent', pattern: 'MEMBER PROFILE' }] },
      obs,
    );
    expect(r.satisfied).toBe(true);
    expect(r.observed).toMatch(/sub-condition 2 held/);
  });

  it('negates through not(...)', () => {
    expect(evaluateAgainst({ kind: 'not', of: { kind: 'textPresent', pattern: 'ACCESS DENIED' } }, obs).satisfied).toBe(true);
  });

  it('treats controlAbsent as satisfied when the target cannot resolve', () => {
    expect(
      evaluateAgainst(
        { kind: 'controlAbsent', target: { description: 'post transfer', strategies: [{ kind: 'role-name', role: 'button', name: 'Post Transfer', nameMatch: 'exact' }] } },
        obs,
      ).satisfied,
    ).toBe(true);
  });
});
