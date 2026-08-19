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

export const DEMO_GOALS: Record<string, GoalPreset> = {
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
