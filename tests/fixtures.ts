/**
 * Test fixtures.
 *
 * The observations here are hand-written to mirror what perception actually
 * returns from the target app, including the parts that matter: fields whose names
 * were synthesized from an adjacent cell, controls with the same name in two
 * frames, and table cells addressed by row key and column header.
 */

import type { Observation, PerceivedControl, TargetStrategy } from '../src/surface/types.js';

export function control(partial: Partial<PerceivedControl> & Pick<PerceivedControl, 'ref' | 'role' | 'name'>): PerceivedControl {
  return {
    nameSource: 'text-content',
    container: { framePath: [] },
    targeting: [],
    ...partial,
  };
}

export function withTargeting(c: PerceivedControl, strategies: TargetStrategy[]): PerceivedControl {
  return { ...c, targeting: strategies };
}

export function observation(controls: PerceivedControl[], overrides: Partial<Observation> = {}): Observation {
  return {
    generation: 1,
    at: '2026-01-01T00:00:00.000Z',
    url: 'http://localhost:4173/console.aspx',
    title: 'Member Servicing Console',
    frames: [
      { path: [], url: 'http://localhost:4173/console.aspx' },
      { path: ['navFrame'], url: 'http://localhost:4173/nav.aspx' },
      { path: ['bodyFrame'], url: 'http://localhost:4173/member-detail.aspx?mid=12345' },
    ],
    controls,
    headings: ['MEMBER PROFILE', 'SHARE / DEPOSIT ACCOUNTS'],
    truncatedFrames: [],
    text: 'MEMBER PROFILE Member ID: 12345 SHARE / DEPOSIT ACCOUNTS REGULAR SHARE SAVINGS $8,241.77',
    ...overrides,
  };
}

/** A search form field whose label came from the neighbouring table cell. */
export const memberIdField = withTargeting(
  control({
    ref: 'bodyFrame|1:0',
    role: 'textbox',
    name: 'Member ID',
    nameSource: 'adjacent-cell',
    container: { framePath: ['bodyFrame'], section: 'MEMBER SERVICING - INQUIRY' },
  }),
  [
    { kind: 'labelled-field', label: 'Member ID', labelMatch: 'normalized', role: 'textbox' },
    { kind: 'section-ordinal', section: 'MEMBER SERVICING - INQUIRY', role: 'textbox', index: 0 },
    { kind: 'dom-hint', css: '#ctl00_MainContent_txtMemberId' },
  ],
);

export const searchButton = withTargeting(
  control({
    ref: 'bodyFrame|1:1',
    role: 'button',
    name: 'Search',
    nameSource: 'value',
    container: { framePath: ['bodyFrame'], section: 'MEMBER SERVICING - INQUIRY' },
  }),
  [
    { kind: 'role-name', role: 'button', name: 'Search', nameMatch: 'normalized' },
    { kind: 'text', text: 'Search', textMatch: 'normalized', role: 'button' },
    { kind: 'dom-hint', css: '#ctl00_MainContent_btnSearch' },
  ],
);

/** Same accessible name in two different frames -- the classic frameset trap. */
export const navHomeLink = withTargeting(
  control({ ref: 'navFrame|1:0', role: 'link', name: 'Home', container: { framePath: ['navFrame'] } }),
  [{ kind: 'role-name', role: 'link', name: 'Home', nameMatch: 'normalized' }],
);
export const bodyHomeLink = withTargeting(
  control({ ref: 'bodyFrame|1:9', role: 'link', name: 'Home', container: { framePath: ['bodyFrame'] } }),
  [{ kind: 'role-name', role: 'link', name: 'Home', nameMatch: 'normalized' }],
);

export const savingsBalanceCell = withTargeting(
  control({
    ref: 'bodyFrame|1:4',
    role: 'cell',
    name: 'Current Balance',
    nameSource: 'column-header',
    value: '$8,241.77',
    container: {
      framePath: ['bodyFrame'],
      section: 'SHARE / DEPOSIT ACCOUNTS',
      table: { near: 'SHARE / DEPOSIT ACCOUNTS', rowKey: '12345-00', columnHeader: 'Current Balance', rowIndex: 1, colIndex: 2 },
    },
  }),
  [
    { kind: 'table-cell', near: 'SHARE / DEPOSIT ACCOUNTS', rowKey: '12345-00', rowKeyMatch: 'normalized', columnHeader: 'Current Balance' },
    { kind: 'dom-hint', css: 'table:nth-child(3) > tbody > tr:nth-child(2) > td:nth-child(3)' },
  ],
);

export const checkingBalanceCell = withTargeting(
  control({
    ref: 'bodyFrame|1:8',
    role: 'cell',
    name: 'Current Balance',
    nameSource: 'column-header',
    value: '$1,502.31',
    container: {
      framePath: ['bodyFrame'],
      section: 'SHARE / DEPOSIT ACCOUNTS',
      table: { near: 'SHARE / DEPOSIT ACCOUNTS', rowKey: '12345-10', columnHeader: 'Current Balance', rowIndex: 2, colIndex: 2 },
    },
  }),
  [{ kind: 'table-cell', near: 'SHARE / DEPOSIT ACCOUNTS', rowKey: '12345-10', rowKeyMatch: 'normalized', columnHeader: 'Current Balance' }],
);
