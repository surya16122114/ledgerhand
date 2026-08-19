/**
 * Product profiles: the cross-cutting knowledge a single discovery run cannot have.
 *
 * This file exists because of a genuine hole in the record-once/replay-many idea.
 * A discovery run sees the happy path -- that is what "successful run" means. It
 * will never see a session timeout, an "unauthorised member record" screen, or an
 * unhandled-exception page, because if it had, the run would not have succeeded.
 * So a system that derives its entire error taxonomy from the recording ships
 * capabilities that only work on the day they were recorded.
 *
 * The answer is that those conditions are not properties of a *capability*, they
 * are properties of the *vendor product*. Every screen in CorePoint Servicing
 * bounces to the same sign-on page with the same wording when a session dies.
 * That is worth writing down exactly once, by an engineer who has read the
 * product's behaviour, and inheriting into every capability recorded against it.
 *
 * So the division of labour is:
 *
 *   discovery run   -> the steps, the targets, the outputs, the success condition
 *   product profile -> the runtime conditions and business outcomes of the product
 *   tenant overlay  -> the label and route differences at one institution
 *
 * Each of those is authored by whoever actually knows the answer, and none of them
 * has to guess at the others. Adding the twentieth capability against CorePoint
 * costs one discovery run and inherits a taxonomy that twenty runs' worth of
 * production experience has hardened.
 *
 * A profile is data, so a new product is a new entry, not new code.
 */

import type { BusinessOutcomeDecl, Handler } from './index-types.js';
import { escapeRegExp } from '../util/regex.js';

export interface ProductProfile {
  productId: string
  description: string;
  /**
   * Conditions that can occur at any step, with how to respond. These land in
   * `capability.interrupts`.
   *
   * Order is meaningful: the first match wins, so the specific and the terminal
   * come before the general.
   */
  interrupts: Handler[];
  /** The vocabulary of legitimate non-success results for this product. */
  outcomes: BusinessOutcomeDecl[];
  /**
   * Turns a concrete URL into a pattern suitable for an allowlist or a checkpoint.
   * `/member-detail.aspx?mid=12345` -> `/member-detail\.aspx`. Without this, a
   * recorded url condition asserts the id of whichever member happened to be used
   * during discovery.
   */
  canonicalizeUrl(url: string): string;
}

/**
 * The fictional core-banking servicing product this project records against.
 *
 * Each interrupt below corresponds to a runtime condition the target app can
 * actually produce, and to a fault the harness can inject on demand, so every one
 * of these is exercised rather than aspirational.
 */
const COREPOINT: ProductProfile = {
  productId: 'corepoint-servicing',
  description:
    'CorePoint Servicing: a server-rendered, frameset-based member servicing console used by US credit unions. Sign-on establishes a server session; every servicing screen redirects to sign-on when that session expires.',

  interrupts: [
    {
      // Terminal and unambiguous, so it is checked first: an exception page can
      // coexist with other text, and treating it as anything recoverable would
      // mean retrying against a broken app.
      name: 'app-error-page',
      when: { kind: 'textPresent', pattern: 'UNHANDLED EXCEPTION|Server Error in' },
      then: { do: 'fail', code: 'APP_ERROR', message: 'the application returned an unhandled exception page' },
      notDuringAuth: false,
    },
    {
      // A legitimate answer the caller needs, not a crash: the service account
      // genuinely may not read this record.
      name: 'permission-denied',
      when: { kind: 'textPresent', pattern: 'not authorized to view this member record|ACCESS DENIED' },
      then: { do: 'outcome', code: 'PERMISSION_DENIED' },
      notDuringAuth: false,
    },
    {
      // Recoverable, and the most common runtime condition in this class of app.
      // Re-runs the steps marked partOfAuth and resumes.
      name: 'session-expired',
      when: { kind: 'textPresent', pattern: 'Your session has expired' },
      then: { do: 'reauthenticate', maxAttempts: 1 },
      // Suppressed during sign-on, or a failed re-authentication that lands back on
      // the expiry page would trigger another re-authentication.
      notDuringAuth: true,
    },
    {
      // A known interstitial. Acknowledge and re-attempt the step it interrupted.
      name: 'system-notice-interstitial',
      when: {
        kind: 'all',
        of: [
          { kind: 'textPresent', pattern: 'SYSTEM NOTICE' },
          { kind: 'controlPresent', target: { description: 'Continue button on the system notice', strategies: [{ kind: 'role-name', role: 'button', name: 'Continue', nameMatch: 'normalized' }] } },
        ],
      },
      then: {
        do: 'dismiss',
        target: { description: 'Continue button on the system notice', strategies: [{ kind: 'role-name', role: 'button', name: 'Continue', nameMatch: 'normalized' }] },
        thenRetryStep: true,
      },
      // A maintenance notice can interrupt sign-on too, so this one is not scoped.
      notDuringAuth: false,
    },
    {
      // Per-institution compliance gates use this shape. Kept in the base profile
      // because more than one tenant has one, and the overlay only needs to say
      // so when the wording differs.
      name: 'terms-acknowledgement-gate',
      when: {
        kind: 'all',
        of: [
          { kind: 'textPresent', pattern: 'ACKNOWLEDGEMENT|ACKNOWLEDGMENT' },
          { kind: 'controlPresent', target: { description: 'acknowledgement button', strategies: [{ kind: 'role-name', role: 'button', name: 'I Acknowledge', nameMatch: 'contains' }] } },
        ],
      },
      then: {
        do: 'dismiss',
        target: { description: 'acknowledgement button', strategies: [{ kind: 'role-name', role: 'button', name: 'I Acknowledge', nameMatch: 'contains' }] },
        thenRetryStep: true,
      },
      // A compliance gate appears immediately after sign-on, so it must be allowed
      // to fire while the auth block is still running.
      notDuringAuth: false,
    },
    {
      // Bounced to sign-on without the expiry wording. Distinct from an expiry:
      // it means we were never signed on, which is a configuration problem, not
      // something to recover from by signing on again in a loop.
      name: 'unexpected-signon-screen',
      when: {
        kind: 'all',
        of: [
          { kind: 'textPresent', pattern: 'OPERATOR SIGN ON' },
          { kind: 'textAbsent', pattern: 'Your session has expired' },
        ],
      },
      then: { do: 'escalate', reason: 'the application returned to the sign-on screen without reporting an expired session' },
      // Essential. Without it this fires on step one of every single run, because
      // step one navigates to the sign-on screen on purpose.
      notDuringAuth: true,
    },
  ],

  outcomes: [
    {
      code: 'MEMBER_NOT_FOUND',
      description: 'The member id was searched and the application reported no matching records. A legitimate answer, not an error.',
      retryable: true,
    },
    {
      code: 'PERMISSION_DENIED',
      description: 'The member record exists but the service account is not entitled to read it. Requires an entitlement change, not a retry.',
      retryable: false,
    },
    {
      code: 'VALIDATION_REJECTED',
      description: 'The application rejected the submitted values with a validation message. The caller should correct the inputs and retry.',
      retryable: true,
    },
  ],

  canonicalizeUrl(url: string): string {
    try {
      const u = new URL(url);
      // Path only, query dropped: the query is where the member id lives, and a
      // recorded condition that includes it asserts the wrong thing forever.
      return escapeRegExp(u.pathname);
    } catch {
      return escapeRegExp(url);
    }
  },
};

export const PRODUCT_PROFILES: Record<string, ProductProfile> = {
  [COREPOINT.productId]: COREPOINT,
};

/**
 * A profile is required rather than optional. Recording a capability against a
 * product nobody has characterised should be a deliberate act, because the
 * resulting artifact will only handle the happy path.
 */
export function profileFor(productId: string): ProductProfile {
  const profile = PRODUCT_PROFILES[productId];
  if (!profile) {
    throw new Error(
      `no product profile for '${productId}'. A profile declares the runtime conditions and business outcomes of the ` +
        `vendor product, which a single discovery run cannot observe. Add one in src/artifact/product-profiles.ts.`,
    );
  }
  return profile;
}

/**
 * Business outcomes that must be detected at a specific step rather than globally.
 *
 * "No records found" is only meaningful right after a search, and a validation
 * message is only meaningful right after a submit. Declaring these as interrupts
 * would classify the run as MEMBER_NOT_FOUND if the phrase happened to be on
 * screen at any other point.
 */
export function stepOutcomeHandlers(profileId: string, kind: 'after-search' | 'after-submit'): Handler[] {
  if (profileId !== COREPOINT.productId) return [];
  if (kind === 'after-search') {
    return [
      {
        name: 'no-matching-member',
        when: { kind: 'textPresent', pattern: 'No records found matching' },
        then: { do: 'outcome', code: 'MEMBER_NOT_FOUND' },
        notDuringAuth: false,
      },
    ];
  }
  return [
    {
      name: 'validation-rejected',
      when: {
        kind: 'any',
        of: [
          { kind: 'textPresent', pattern: 'is required\\.' },
          { kind: 'textPresent', pattern: 'must be at least' },
          { kind: 'textPresent', pattern: 'must be a valid' },
          { kind: 'textPresent', pattern: 'must be numeric' },
        ],
      },
      then: { do: 'outcome', code: 'VALIDATION_REJECTED' },
      notDuringAuth: false,
    },
  ];
}

