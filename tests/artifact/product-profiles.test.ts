import { describe, expect, it } from 'vitest';
import { profileFor, stepOutcomeHandlers } from '../../src/artifact/product-profiles.js';
import { evaluateAgainst } from '../../src/surface/web/playwright-surface.js';
import { observation } from '../helpers/fixtures.js';
import type { Condition } from '../../src/surface/types.js';

/**
 * These cover the differences between the two products that are invisible in a
 * diff and fatal at replay. Each one corresponds to a wording or shape captured
 * off the live Meridian host -- see docs/MERIDIAN-RECON.md.
 */
describe('meridian-core profile', () => {
  const meridian = profileFor('meridian-core');

  describe('canonicalizeUrl', () => {
    it('wildcards a member id carried in the path, not just the query', () => {
      // CorePoint keeps the whole pathname because its ids live in the query.
      // Doing that here would bake the discovery member into every url condition.
      const pattern = meridian.canonicalizeUrl('https://web-sample.interface-hiring.com/members/103001/transfer');
      expect(pattern).not.toContain('103001');
      expect(new RegExp(pattern).test('/members/100987/transfer')).toBe(true);
    });

    it('keeps the rest of the path significant', () => {
      const pattern = meridian.canonicalizeUrl('https://web-sample.interface-hiring.com/members/103001/transfer/post');
      // A transfer must not match a hold, or the post-commit checkpoint for one
      // flow would be satisfied by the confirm screen of another.
      expect(new RegExp(`^${pattern}$`).test('/members/100987/hold/post')).toBe(false);
      expect(new RegExp(`^${pattern}$`).test('/members/100987/transfer/post')).toBe(true);
    });
  });

  describe('step outcomes', () => {
    it('classifies an empty search using this host\'s wording', () => {
      // CorePoint says "No records found matching"; Meridian does not.
      const handlers = stepOutcomeHandlers('meridian-core', 'after-search');
      expect(handlers).toHaveLength(1);
      const obs = observation([], { text: 'No member records matched your search. Try member numbers 100234.' });
      expect(evaluateAgainst(handlers[0]!.when as Condition, obs).satisfied).toBe(true);
    });

    it('separates the bank declining from the caller sending nonsense', () => {
      // Both arrive as HTTP 400 behind "The transaction could not be validated:".
      // Collapsing them would tell a caller to fix its inputs when the real answer
      // is that the share is frozen.
      const handlers = stepOutcomeHandlers('meridian-core', 'after-submit');
      const firstMatch = (text: string) => {
        const obs = observation([], { text });
        return handlers.find((h) => evaluateAgainst(h.when as Condition, obs).satisfied);
      };
      expect(firstMatch('The transaction could not be validated: Source share is HOLD and cannot be debited.')?.then)
        .toMatchObject({ do: 'outcome', code: 'SOURCE_SHARE_RESTRICTED' });
      expect(firstMatch('The transaction could not be validated: Insufficient available balance in the source share.')?.then)
        .toMatchObject({ do: 'outcome', code: 'INSUFFICIENT_FUNDS' });
      expect(firstMatch('The transaction could not be validated: Amount must be a valid dollar figure (e.g. 100.00).')?.then)
        .toMatchObject({ do: 'outcome', code: 'VALIDATION_REJECTED' });
    });

    it('does not silently return an empty handler list for a known product', () => {
      // The regression this file exists for: step outcomes used to be a branch on
      // the product id, so any product but CorePoint got nothing and a missing
      // member became a hard failure instead of an outcome.
      for (const id of ['corepoint-servicing', 'meridian-core']) {
        expect(stepOutcomeHandlers(id, 'after-search').length).toBeGreaterThan(0);
        expect(stepOutcomeHandlers(id, 'after-submit').length).toBeGreaterThan(0);
      }
    });

    it('returns nothing for a product with no profile', () => {
      expect(stepOutcomeHandlers('no-such-product', 'after-search')).toEqual([]);
    });
  });

  describe('interrupts', () => {
    const fire = (text: string) => {
      const obs = observation([], { text });
      return meridian.interrupts.find((h) => evaluateAgainst(h.when as Condition, obs).satisfied);
    };

    it('treats the supervisor gate as an outcome, not a crash', () => {
      // teller1 is refused at the review step for a hold. That is a real answer
      // the caller must act on by using a different operator identity.
      expect(fire('SUPERVISOR OVERRIDE REQUIRED Operator profile teller1 is not authorized to perform this function.')?.then)
        .toMatchObject({ do: 'outcome', code: 'PERMISSION_DENIED' });
    });

    it('re-authenticates on a timeout, which really does destroy the session', () => {
      expect(fire('YOUR SESSION HAS TIMED OUT For security, your session ended due to inactivity.')?.then)
        .toMatchObject({ do: 'reauthenticate' });
    });

    it('fails terminally on an application error rather than retrying it', () => {
      expect(fire('APPLICATION ERROR An unexpected error occurred. Reference: ERR-8740BD07')?.then)
        .toMatchObject({ do: 'fail', code: 'APP_ERROR' });
    });

    it('puts the terminal error page ahead of the sign-on escalation', () => {
      // Ordering guard: several of these can be on screen together, and the first
      // match wins.
      const names = meridian.interrupts.map((h) => h.name);
      expect(names.indexOf('application-error-page')).toBeLessThan(names.indexOf('unexpected-signon-screen'));
    });
  });
});

it('recognizes actual Meridian contact rejection messages only on contact routes',()=>{
 const handler=profileFor('meridian-core').runtimeOutcomes![0]!;
 for(const text of ['Phone number is not valid.','E-mail address is not in a valid format.']){
  expect(evaluateAgainst(handler.when!, observation([], {url:'https://example.test/members/103001/update',text})).satisfied).toBe(true);
  expect(evaluateAgainst(handler.when!, observation([], {url:'https://example.test/menu',text})).satisfied).toBe(false);
 }
});
