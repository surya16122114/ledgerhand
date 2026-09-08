import type { TransactionRule } from '../policy/transaction.js';
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
 * product's behavior, and inheriting into every capability recorded against it.
 *
 * So the division of labor is:
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

export type StepOutcomeKind = 'after-search' | 'after-submit';

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
   * Outcomes that are only meaningful immediately after a particular kind of step,
   * so they cannot be interrupts. See `stepOutcomeHandlers`.
   *
   * Order within each array is meaningful for the same reason it is for
   * `interrupts`: several of these products report a specific business refusal and
   * a generic input-validation failure through the same banner, so the specific
   * pattern has to be tried first.
   */
  stepOutcomes?: Partial<Record<StepOutcomeKind, Handler[]>>;
  /**
   * Extra control names that commit, beyond the generic list in `policy/risk.ts`.
   *
   * That list is a verb heuristic, and a heuristic tuned on one product is wrong
   * on the next one: it had 'open account', Meridian's button says 'Open Share',
   * and a control that creates a real account was classified reversible. Three
   * guards silently switched off -- the chatbot would open accounts on a sentence,
   * the dashboard stopped asking for an authorization reason, and an unattended
   * replay stopped demanding one.
   *
   * Rather than grow one global list until it accidentally covers everything, each
   * product declares the wording *it* uses. Same reasoning as its interrupts.
   */
  irreversibleVerbs?: string[];
  authenticationFailurePattern?: string;
  transactionRules?: TransactionRule[];
  deniedUrlPatterns?: string[];
  runtimeOutcomes?: Handler[];
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

  stepOutcomes: {
    'after-search': [
      {
        name: 'no-matching-member',
        when: { kind: 'textPresent', pattern: 'No records found matching' },
        then: { do: 'outcome', code: 'MEMBER_NOT_FOUND' },
        notDuringAuth: false,
      },
    ],
    'after-submit': [
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
    ],
  },

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

/**
 * Meridian Core, the live sandbox this project is evaluated against.
 *
 * Every pattern below was read off the running host rather than inferred from
 * CorePoint, because the two products differ in ways that look cosmetic and are
 * not. Three of them would each have produced a capability that passes discovery
 * and then misbehaves in production:
 *
 *  - **The member id is in the path, not the query.** `/members/103001/transfer`.
 *    CorePoint's `canonicalizeUrl` keeps the whole pathname, so a url condition
 *    recorded here would assert the id of the member discovery happened to use --
 *    Record-time data in an artifact, arriving through the one door the existing
 *    guard does not watch.
 *  - **The maintenance interstitial's "Continue" is a link, not a button.** The
 *    CorePoint interstitial handler matches `role: 'button'` and would never fire.
 *  - **Nothing here says "No records found matching".** An empty search reports
 *    "No member records matched your search.", so CorePoint's search handler
 *    silently never matches and a missing member becomes a hard failure instead of
 *    a MEMBER_NOT_FOUND outcome.
 *
 * Wording captured 2026-09-03; see docs/MERIDIAN-RECON.md for the transcripts and
 * the HTTP status of each.
 */
const MERIDIAN: ProductProfile = {
  productId: 'meridian-core',
  deniedUrlPatterns: ['^https?://[^/]+/(?:settings|admin)(?:/|[?#]|$)'],
  authenticationFailurePattern: 'Invalid operator ID or password',
  runtimeOutcomes: [{ name: 'contact-validation-rejected', notDuringAuth: true,
    when: { kind: 'all', of: [
      {kind:'urlMatches', pattern:'/members/[0-9]+/update(?:[?#]|$)'},
      {kind:'textPresent', pattern:'Phone number is not valid\\.|E-mail address is not in a valid format\\.'},
    ] }, then: {do:'outcome', code:'VALIDATION_REJECTED'} }],
  transactionRules: [
    { path: '^/members/[^/]+/update$', allowRead: true, fields: {email:{input:'email'}, phone:{input:'phone'}, address:{input:'address'}} },
    { path: '^/members/[^/]+/transfer/post$', fields: {from:{input:'fromShare'}, to:{input:'toShare'}, amount:{input:'amount',numeric:true}, memo:{input:'memo'}} },
    { path: '^/members/[^/]+/open-share/post$', fields: {type:{input:'shareType'}, deposit:{input:'initialDeposit',numeric:true}} },
    { path: '^/members/[^/]+/hold/post$', fields: {share:{input:'shareId'}, reason:{input:'reason'}, notes:{input:'notes'}} },
  ],
  description:
    'Meridian Core (Cornerstone Financial Systems), a server-rendered member services platform v4.2.1. ' +
    'Full page loads, no frames. Sign-on establishes a server session tied to an operator profile and a branch; ' +
    'privileged functions are refused at the review step rather than at sign-on.',

  interrupts: [
    {
      // Terminal, and it carries its own support reference, so it is worth
      // surfacing verbatim rather than collapsing into a generic failure.
      name: 'application-error-page',
      when: { kind: 'textPresent', pattern: 'APPLICATION ERROR|Reference: ERR-' },
      then: { do: 'fail', code: 'APP_ERROR', message: 'the application returned an error page with a support reference' },
      notDuringAuth: false,
    },
    {
      // The supervisor gate. This is the same screen the `permission` fault
      // injects, which is correct: to the caller, an injected refusal and a real
      // entitlement refusal mean the same thing and need the same handling.
      name: 'supervisor-override-required',
      when: { kind: 'all', of: [
        { kind: 'textPresent', pattern: 'SUPERVISOR OVERRIDE REQUIRED|not authorized to perform this function' },
        { kind: 'controlAbsent', target: { description: 'Share selection form', strategies: [{ kind: 'labelled-field', label: 'Share', labelMatch: 'normalized', role: 'combobox' }] } },
      ] },
      then: { do: 'outcome', code: 'PERMISSION_DENIED' },
      notDuringAuth: false,
    },
    {
      // Verified to genuinely destroy the server session, not merely render a
      // warning: a subsequent /menu redirects to sign-on. So re-authenticating is
      // the only way forward, and it is safe.
      name: 'session-timed-out',
      when: { kind: 'textPresent', pattern: 'YOUR SESSION HAS TIMED OUT|session ended due to inactivity' },
      then: { do: 'reauthenticate', maxAttempts: 1 },
      notDuringAuth: true,
    },
    {
      // Transient by the app's own description ("normally clears within a few
      // moments"), and it offers a way onward, so it is dismissed and the
      // interrupted step re-attempted rather than escalated.
      name: 'maintenance-window',
      when: {
        kind: 'all',
        of: [
          { kind: 'textPresent', pattern: 'SCHEDULED MAINTENANCE IN PROGRESS|This window normally clears within a few moments' },
          { kind: 'controlPresent', target: { description: 'Continue link on the maintenance notice', strategies: [{ kind: 'role-name', role: 'link', name: 'Continue', nameMatch: 'normalized' }] } },
        ],
      },
      then: {
        do: 'dismiss',
        target: { description: 'Continue link on the maintenance notice', strategies: [{ kind: 'role-name', role: 'link', name: 'Continue', nameMatch: 'normalized' }] },
        thenRetryStep: true,
      },
      notDuringAuth: false,
    },
    {
      // Reached by navigating to a member id that does not exist. A legitimate
      // answer rather than a fault, and global because any step that carries a
      // member id in its path can land here.
      name: 'record-not-found',
      when: { kind: 'textPresent', pattern: 'RECORD NOT FOUND|could not be located on this host' },
      then: { do: 'outcome', code: 'MEMBER_NOT_FOUND' },
      notDuringAuth: true,
    },
    {
      // Same reasoning as CorePoint's: bounced to sign-on with no expiry wording
      // means we were never signed on, which is a configuration problem rather
      // than something to recover from by signing on again in a loop.
      name: 'unexpected-signon-screen',
      when: {
        kind: 'all',
        of: [
          { kind: 'textPresent', pattern: 'OPERATOR SIGN ON' },
          { kind: 'textAbsent', pattern: 'SESSION HAS TIMED OUT' },
        ],
      },
      then: { do: 'escalate', reason: 'the application returned to the sign-on screen without reporting a timed-out session' },
      notDuringAuth: true,
    },
  ],

  outcomes: [
    {
      code: 'MEMBER_NOT_FOUND',
      description: 'The member number was searched or navigated to and the host reported no such record. A legitimate answer, not an error.',
      retryable: true,
    },
    {
      code: 'PERMISSION_DENIED',
      // Describes the *roles* rather than naming the two demo accounts. Naming
      // them put credential values into every artifact compiled against this
      // profile, which the leak check then reported on every single save --
      // correctly, and forever.
      description:
        'The signed-on operator profile is not entitled to this function -- the host asks for a supervisor override. ' +
        'Placing a hold is the known case: a teller profile is refused at the review step, a supervisor profile is not. ' +
        'Requires a different operator identity, not a retry.',
      retryable: false,
    },
    {
      code: 'VALIDATION_REJECTED',
      description: 'The host rejected the submitted values as malformed. The caller should correct the inputs and retry.',
      retryable: true,
    },
    {
      code: 'SOURCE_SHARE_RESTRICTED',
      description:
        'The source share carries a HOLD and cannot be debited. The automation did everything correctly and the bank declined; ' +
        'retrying the same inputs will always fail, but the same transfer from a different share may succeed.',
      retryable: false,
    },
    {
      code: 'INSUFFICIENT_FUNDS',
      description: 'The source share does not have the available balance for this amount. Not retryable with the same amount.',
      retryable: false,
    },
  ],

  // Read off the actual buttons on this host: "Open Share" commits a new account,
  // "Post Transfer" commits a transfer, "Apply Hold" freezes a share. The generic
  // list already covers post/apply/save; 'open share' is the one it missed.
  irreversibleVerbs: ['open share', 'open new share', 'post transfer', 'apply hold'],

  stepOutcomes: {
    'after-search': [
      {
        name: 'no-matching-member',
        when: { kind: 'textPresent', pattern: 'No member records matched your search' },
        then: { do: 'outcome', code: 'MEMBER_NOT_FOUND' },
        notDuringAuth: false,
      },
    ],
    // Every one of these arrives as HTTP 400 behind the same banner --
    // "The transaction could not be validated:" -- so the specific business
    // refusals have to be matched before the generic catch, or a HOLD share and a
    // typo'd amount become the same outcome code. They are not the same: one is
    // the bank declining, the other is the caller's mistake.
    'after-submit': [
      {
        name: 'source-share-on-hold',
        when: { kind: 'textPresent', pattern: 'Source share is HOLD and cannot be debited' },
        then: { do: 'outcome', code: 'SOURCE_SHARE_RESTRICTED' },
        notDuringAuth: false,
      },
      {
        name: 'insufficient-balance',
        when: { kind: 'textPresent', pattern: 'Insufficient available balance' },
        then: { do: 'outcome', code: 'INSUFFICIENT_FUNDS' },
        notDuringAuth: false,
      },
      {
        name: 'validation-rejected',
        when: {
          kind: 'any',
          of: [
            { kind: 'textPresent', pattern: 'The transaction could not be validated' },
            { kind: 'textPresent', pattern: 'TRANSACTION REJECTED' },
            { kind: 'textPresent', pattern: 'must be a valid dollar figure' },
            { kind: 'textPresent', pattern: 'shares must differ' },
          ],
        },
        then: { do: 'outcome', code: 'VALIDATION_REJECTED' },
        notDuringAuth: false,
      },
    ],
  },

  canonicalizeUrl(url: string): string {
    try {
      const u = new URL(url);
      // The member id is a *path segment* here, so dropping the query -- which is
      // all CorePoint has to do -- would leave the id baked into the pattern.
      // Any all-digit segment is an identifier and becomes a wildcard.
      return u.pathname
        .split('/')
        .map((seg) => (/^\d+$/.test(seg) ? '\\d+' : escapeRegExp(seg)))
        .join('/');
    } catch {
      return escapeRegExp(url);
    }
  },
};

export const PRODUCT_PROFILES: Record<string, ProductProfile> = {
  [COREPOINT.productId]: COREPOINT,
  [MERIDIAN.productId]: MERIDIAN,
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
 *
 * The handlers themselves live on the profile. They used to be a branch on the
 * product id in this function, which meant the second product silently inherited
 * an empty list: `meridian-core` would have compiled with no search or validation
 * handlers at all and reported a missing member as a hard failure.
 */
export function stepOutcomeHandlers(profileId: string, kind: StepOutcomeKind): Handler[] {
  return PRODUCT_PROFILES[profileId]?.stepOutcomes?.[kind] ?? [];
}

/**
 * Phrases that mean "this is not the happy path", drawn from what the profile
 * already declares.
 *
 * A checkpoint asserting one of these is self-contradictory: it defines success as
 * the presence of a condition the same profile treats as an interrupt or a
 * business outcome. That is not hypothetical. A sign-on capability was recorded
 * while another user had armed the shared fault injector, and it compiled with
 * `SCHEDULED MAINTENANCE IN PROGRESS` as its success condition -- a capability
 * that passes only when the application is broken, and which nothing objected to
 * at save time.
 *
 * Handlers whose action is `escalate` are deliberately excluded. Those mean "I do
 * not know what this screen is" rather than "this screen is a fault", and one of
 * them matches OPERATOR SIGN ON -- which is the legitimate checkpoint for the
 * first step of every capability here.
 */
export function abnormalPhrases(productId: string): string[] {
  const profile = PRODUCT_PROFILES[productId];
  if (!profile) return [];
  const phrases: string[] = [];
  const collect = (condition: unknown): void => {
    if (!condition || typeof condition !== 'object') return;
    const c = condition as { kind?: string; pattern?: string; of?: unknown };
    if (c.kind === 'textPresent' && typeof c.pattern === 'string') phrases.push(c.pattern);
    if (Array.isArray(c.of)) c.of.forEach(collect);
    else if (c.of) collect(c.of);
  };
  for (const handler of profile.interrupts) {
    if (handler.then.do === 'escalate') continue;
    collect(handler.when);
  }
  for (const handlers of Object.values(profile.stepOutcomes ?? {})) {
    for (const handler of handlers) collect(handler.when);
  }
  return phrases;
}
