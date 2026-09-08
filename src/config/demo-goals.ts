/**
 * The goals used to demonstrate the system.
 *
 * These are presets for the CLI, not configuration the system depends on -- a goal
 * can be any free text. They exist so the demo path in README.md is one command
 * rather than a paragraph of flags, and so the three shapes of flow the brief asks
 * about are each covered:
 *
 *   read-balance   search -> detail -> read a field        (read-only, safe)
 *   open-subaccount  navigate -> multi-field form -> confirm  (irreversible write)
 */

import type { DiscoveryParameter } from '../agent/loop.js';

export interface GoalPreset {
  goal: string;
  capabilityId: string;
  baseUrl: string;
  entryUrl: string;
  tenantId: string;
  productId: string;
  productVersion?: string;
  appDescription: string;
  parameters: DiscoveryParameter[];
  expectedOutputs: string[];
}

const BASE = process.env.TARGET_APP_BASE_URL ?? 'http://localhost:4173';

const APP_DESCRIPTION =
  'CorePoint Servicing, a member servicing console for a US credit union. ' +
  'Operators sign on, then use the menu across the top to reach functions. ' +
  'Member Servicing lets you look up a member by id and see their profile with a table of share and deposit accounts.';

const COREPOINT_GOALS: Record<string, GoalPreset> = {
  'read-balance': {
    goal:
      'Sign on to the servicing console, look up member 12345, and read that member\'s current regular share savings balance from their profile.',
    capabilityId: 'member.read-savings-balance',
    baseUrl: BASE,
    entryUrl: `${BASE}/login.aspx`,
    tenantId: 'meridian-cu',
    productId: 'corepoint-servicing',
    productVersion: '4.2.118',
    appDescription: APP_DESCRIPTION,
    parameters: [
      {
        name: 'memberId',
        value: '12345',
        type: 'string',
        // Sensitivity is declared here, at the point the value enters the system,
        // so the redactor is configured before the first log line is written.
        sensitivity: 'pii',
        description: 'The credit union member number to look up.',
        // Part of the capability's contract, checked before a browser is launched.
        pattern: '^\\d{1,10}$',
      },
    ],
    expectedOutputs: ['savingsBalance'],
  },

  'open-subaccount': {
    goal:
      'Sign on to the servicing console, look up member 12345, open a new sub-account for them with the description "Holiday Club" and an initial deposit of 250, and reach the confirmation screen.',
    capabilityId: 'member.open-sub-account',
    baseUrl: BASE,
    entryUrl: `${BASE}/login.aspx`,
    tenantId: 'meridian-cu',
    productId: 'corepoint-servicing',
    productVersion: '4.2.118',
    appDescription: APP_DESCRIPTION,
    parameters: [
      { name: 'memberId', value: '12345', type: 'string', sensitivity: 'pii', description: 'The credit union member number to open the sub-account for.', pattern: '^\\d{1,10}$' },
      { name: 'description', value: 'Holiday Club', type: 'string', sensitivity: 'internal', description: 'Description for the new sub-account.', pattern: '^.{1,40}$' },
      { name: 'initialDeposit', value: '250', type: 'money', sensitivity: 'internal', description: 'Opening deposit amount in dollars. The application requires at least $25.' },
    ],
    expectedOutputs: ['newAccountNumber', 'confirmationReference'],
  },
};

// ---------------------------------------------------------------------------
// Meridian Core -- the live sandbox at web-sample.interface-hiring.com.
//
// The seven functions the exercise asks for, one preset each. Values below were
// chosen against the live host on 2026-09-03: member 103001 is the quietest record
// that still has several OPEN shares to move money between, and every member's
// primary S0001 share is already frozen, so no transfer preset may use one.
//
// See docs/ADAPTATION.md for how each was verified.
// ---------------------------------------------------------------------------

const MERIDIAN_BASE = process.env.MERIDIAN_BASE_URL ?? 'https://web-sample.interface-hiring.com';

const MERIDIAN_APP_DESCRIPTION =
  'Meridian Core, a member services platform for a US credit union. Operators sign on with an operator id, ' +
  'password and branch, then use the links across the top of every screen (Main Menu, Member Inquiry, ' +
  'System Settings, Sign Off) to navigate. Member Inquiry searches by member number or last name. ' +
  'A member record shows contact details and a table of shares with their balances and statuses. ' +
  'Transfers, new shares and holds are each a three-screen flow: fill the form, review a confirmation ' +
  'screen, then post. Forms have no label associations, so a field is identified by the bold label in the ' +
  'table cell to its left. ' +
  // Named explicitly because it is the only place several values live, it has no
  // heading or label to find it by, and a model that guesses at it lands on the
  // numbered menu list instead -- which reads as a successful capture of "1.".
  'Every screen ends with a single status line holding several values at once, in the form ' +
  '"OPR <operator> | BR <branch> | <date> <time> | SID <session>". It is the only place the signed-on ' +
  'operator and branch appear, and reading it whole gives a caller none of those fields.';

/** Every Meridian capability signs on first, so the shape is shared. */
const MERIDIAN_COMMON = {
  baseUrl: MERIDIAN_BASE,
  entryUrl: `${MERIDIAN_BASE}/signon`,
  tenantId: 'meridian-core-sandbox',
  productId: 'meridian-core',
  productVersion: '4.2.1',
  appDescription: MERIDIAN_APP_DESCRIPTION,
} as const;

const MEMBER_ID_PARAM: DiscoveryParameter = {
  name: 'memberId',
  value: '103001',
  type: 'string',
  sensitivity: 'pii',
  description: 'The credit union member number.',
  pattern: '^\\d{6}$',
};

export const MERIDIAN_GOALS: Record<string, GoalPreset> = {
  // 1 of 7. Sign-on is the auth block every other capability inherits, but the
  // brief lists it as a function in its own right, so it is recorded standalone
  // as well -- which also makes it the one capability that can be replayed to
  // prove credentials and branch routing without touching a member record.
  'meridian-signon': {
    ...MERIDIAN_COMMON,
    goal:
      'Sign on to Meridian Core as the configured operator at the given branch and reach the main menu. ' +
      'Then read the signed-on operator and the branch out of the status line at the bottom of the screen, ' +
      'the one reading "OPR ... | BR ... | SID ...". Extract each field on its own rather than returning ' +
      'the whole line, and match on the "OPR" and "BR" prefixes rather than on the values themselves.',
    capabilityId: 'session.sign-on',
    parameters: [
      {
        name: 'branch',
        // Deliberately not MAIN-001. That is the dropdown's default selection, so
        // a run recorded against it never has to touch the control -- and compiles
        // a capability that declares a `branch` input, ignores it, and signs on at
        // MAIN-001 whatever the caller passes. Caught by UNUSED_INPUT.
        value: 'WEST-014',
        type: 'string',
        sensitivity: 'internal',
        description: 'Branch code to sign on at. The host offers MAIN-001, WEST-014 and EAST-022.',
        pattern: '^[A-Z]{4}-\\d{3}$',
      },
    ],
    expectedOutputs: ['signedOnOperator', 'signedOnBranch'],
  },

  // 2 of 7. Search is the only function with a legitimate empty result, which is
  // why the profile carries an after-search handler for it.
  'meridian-search': {
    ...MERIDIAN_COMMON,
    goal:
      'Sign on to Meridian Core, open Member Inquiry, search for members by last name using the search term, ' +
      'and read the member number and member name from the same first matching record. Read the number first.',
    capabilityId: 'member.find-by-name',
    parameters: [
      {
        name: 'lastName',
        value: 'Vaughan',
        type: 'string',
        sensitivity: 'pii',
        description: 'Last name to search for. The host does a substring match over the member list.',
        pattern: '^[A-Za-z .-]{1,40}$',
      },
    ],
    expectedOutputs: ['memberNumber', 'memberName'],
  },

  // 3 of 7. Read-only, and the one that most needs discipline about record-time
  // data never entering an artifact: balances and
  // share statuses on this host change between runs because other people are
  // using it.
  'meridian-record': {
    ...MERIDIAN_COMMON,
    // The first version of this asked for "account status" and "home branch",
    // carried over from the CorePoint preset. Neither field exists on a Meridian
    // member record -- it holds Member No., Name, E-mail, Phone, Address and a
    // shares table -- so the model went looking and settled on the *session*
    // footer's "BR MAIN-001", which is the signed-on operator's branch, not
    // anything about the member. Asking for a field the app does not have does not
    // fail; it quietly returns the wrong one.
    goal:
      'Sign on to Meridian Core, look up the member by member number, open their member record, and read ' +
      "the member's name and e-mail address from the record, plus the balance and the status of the one " +
      'share whose Share ID matches the given share id, from the SHARES / BALANCES table. Find that row by ' +
      'its Share ID rather than by its position, because the table gains and loses rows between runs. ' +
      // The status cell renders the code and then repeats it as a coloured badge:
      // "HOLD [HOLD]". Reading the cell whole hands the caller both. Structural
      // knowledge of the screen, so it belongs in the goal rather than in the
      // artifact.
      'The status cell shows the status code followed by a coloured badge that repeats it, for example ' +
      '"OPEN" rendered as "OPEN [OPEN]". Return only the leading code, not the badge.',
    capabilityId: 'member.read-record',
    parameters: [
      MEMBER_ID_PARAM,
      {
        name: 'shareId',
        value: '103001-S0001',
        type: 'string',
        sensitivity: 'internal',
        // Every member's primary share, and the row key the table-cell strategy
        // parameterizes. Row *position* would read a different account each run.
        description: "The share id to read from the member's shares table.",
        pattern: '^\\d{6}-[A-Z0-9]+(-\\d+)?$',
      },
    ],
    expectedOutputs: ['memberName', 'email', 'shareBalance', 'shareStatus'],
  },

  // 4 of 7. Irreversible. The confirm screen says so in its own words, which is
  // what the pre-commit checkpoint asserts.
  'meridian-transfer': {
    ...MERIDIAN_COMMON,
    goal:
      'Sign on to Meridian Core, look up the member, open Funds Transfer, move the given amount from the ' +
      'source share to the destination share with the given memo, review the confirmation screen, post the ' +
      'transfer, and read the resulting confirmation reference.',
    capabilityId: 'member.transfer-funds',
    parameters: [
      MEMBER_ID_PARAM,
      {
        name: 'fromShare',
        value: '103001-MMKT-5',
        type: 'string',
        sensitivity: 'internal',
        // A share carrying a HOLD cannot be debited -- the host refuses with
        // SOURCE_SHARE_RESTRICTED. Every member's primary S0001 is already held.
        description: 'Share id to debit. Must be a share whose status is OPEN.',
        pattern: '^\\d{6}-[A-Z0-9]+(-\\d+)?$',
      },
      {
        name: 'toShare',
        value: '103001-MMKT-7',
        type: 'string',
        sensitivity: 'internal',
        description: 'Share id to credit. Must differ from the source share.',
        pattern: '^\\d{6}-[A-Z0-9]+(-\\d+)?$',
      },
      {
        name: 'amount',
        value: '1',
        type: 'money',
        sensitivity: 'internal',
        description: 'Dollar amount to move. Kept at 1 for demo runs against a shared sandbox.',
      },
      {
        name: 'memo',
        value: 'ledgerhand demo',
        type: 'string',
        sensitivity: 'internal',
        description: 'Free-text memo recorded against the transfer.',
        pattern: '^.{0,40}$',
      },
    ],
    expectedOutputs: ['confirmationReference'],
  },

  // 5 of 7. Irreversible, and the odd one out: its confirm screen carries no
  // "cannot be reversed" warning at all, so the pre-commit checkpoint has to key
  // on the heading instead.
  'meridian-open-share': {
    ...MERIDIAN_COMMON,
    goal:
      'Sign on to Meridian Core, look up the member, open a new share of the given type with the given ' +
      'initial deposit, review the confirmation screen, post it, and read the new share id.',
    capabilityId: 'member.open-share',
    parameters: [
      MEMBER_ID_PARAM,
      {
        name: 'shareType',
        value: 'MMKT',
        type: 'string',
        sensitivity: 'internal',
        description: 'Share type code. The host offers S0001, S0070, MMKT and CERT.',
        pattern: '^(S0001|S0070|MMKT|CERT)$',
      },
      {
        name: 'initialDeposit',
        value: '25',
        type: 'money',
        sensitivity: 'internal',
        description: 'Opening deposit in dollars.',
      },
    ],
    expectedOutputs: ['newShareId'],
  },

  // 6 of 7. Requires the supervisor identity: teller1 is refused at the *review*
  // step with SUPERVISOR OVERRIDE REQUIRED, after the form has already been
  // filled. Recorded as super1; the teller1 refusal is kept as evidence for the
  // PERMISSION_DENIED arm rather than being treated as a failure.
  'meridian-hold': {
    ...MERIDIAN_COMMON,
    goal:
      'Sign on to Meridian Core as a supervisor, look up the member, place a hold on the given share with ' +
      'the given reason and notes, review the confirmation screen, post the hold, and read the confirmation ' +
      'reference.',
    capabilityId: 'member.place-hold',
    parameters: [
      MEMBER_ID_PARAM,
      {
        name: 'shareId',
        value: '103001-MMKT-4',
        type: 'string',
        sensitivity: 'internal',
        description: 'Share id to freeze.',
        pattern: '^\\d{6}-[A-Z0-9]+(-\\d+)?$',
      },
      {
        name: 'reason',
        value: 'LEGAL',
        type: 'string',
        sensitivity: 'internal',
        description: 'Hold reason code. The host offers FRAUD, LEGAL and DECEASED.',
        pattern: '^(FRAUD|LEGAL|DECEASED)$',
      },
      {
        name: 'notes',
        value: 'ledgerhand demo hold',
        type: 'string',
        sensitivity: 'internal',
        description: 'Free-text note, 80 characters maximum.',
        pattern: '^.{0,80}$',
      },
    ],
    expectedOutputs: ['confirmationReference'],
  },

  // 7 of 7. The exception to the three-screen pattern: it saves on first POST with
  // no review step, and it submits e-mail, phone and address together. A
  // capability that changes only the e-mail must therefore carry the other two
  // through unchanged, read from the live form rather than from anything recorded.
  'meridian-update-contact': {
    ...MERIDIAN_COMMON,
    goal:
      'Sign on to Meridian Core, look up the member, open their contact details for update, fill the supplied ' +
      'email, phone and mailing address, save, return to the member record and read back all three saved values.',
    capabilityId: 'member.update-contact',
    parameters: [
      MEMBER_ID_PARAM,
      {
        name: 'email',
        // Must differ from whatever the record currently holds. Recording against a
        // member whose e-mail already equalled this value produced a capability
        // that signed on, read the address back, and declared success without ever
        // opening the update form.
        value: 'dorothy.v@example.net',
        type: 'string',
        sensitivity: 'pii',
        description: 'New e-mail address for the member.',
        pattern: '^[^@\\s]+@[^@\\s]+\\.[A-Za-z]{2,}$',
      },
      { name: 'phone', value: '415-555-0198', type: 'string', sensitivity: 'pii', description: 'New phone number.', pattern: '^.{7,30}$' },
      { name: 'address', value: '120 Demo Street, San Francisco, CA 94104', type: 'string', sensitivity: 'pii', description: 'New mailing address.', pattern: '^.{1,120}$' },
    ],
    expectedOutputs: ['savedEmail', 'savedPhone', 'savedAddress'],
  },
};

/** Everything the CLI can be handed by name. */
export const DEMO_GOALS: Record<string, GoalPreset> = {
  ...COREPOINT_GOALS,
  ...MERIDIAN_GOALS,
};

/**
 * Where a capability recorded against a given product should replay by default.
 *
 * An artifact deliberately does not carry a base URL -- the same capability runs
 * against a different host at every institution, so that is deployment config,
 * not a property of the recording. But defaulting every replay to the local
 * CorePoint stand-in means replaying a Meridian capability silently drives the
 * wrong application and fails two minutes later on a checkpoint, which reads as
 * "the capability is broken" rather than "you pointed it at the wrong host".
 *
 * `--base-url` still overrides, which is what a real deployment would pass.
 */
export function defaultBaseUrlFor(productId: string | undefined): string {
  if (productId === 'meridian-core') return MERIDIAN_BASE;
  return process.env.TARGET_APP_BASE_URL ?? `http://localhost:${process.env.TARGET_APP_PORT ?? 4173}`;
}

/**
 * What a discovery run should assume when the goal is free-form.
 *
 * A preset carries its own host, tenant, entry route and app description. A goal
 * typed at the prompt carries none of them, and the previous defaults were
 * CorePoint's -- so recording something new against Meridian would have used the
 * wrong error taxonomy, the wrong url canonicalisation, and a sign-on route that
 * does not exist on that host. Selecting the product now settles all four
 * together, because they are not independent choices.
 */
export function discoveryDefaultsFor(productId: string): {
  baseUrl: string;
  tenantId: string;
  entryPath: string;
  appDescription: string;
} {
  if (productId === 'meridian-core') {
    return {
      baseUrl: MERIDIAN_BASE,
      tenantId: 'meridian-core-sandbox',
      entryPath: '/signon',
      appDescription: MERIDIAN_APP_DESCRIPTION,
    };
  }
  return {
    baseUrl: BASE,
    tenantId: 'meridian-cu',
    entryPath: '/login.aspx',
    appDescription: APP_DESCRIPTION,
  };
}
