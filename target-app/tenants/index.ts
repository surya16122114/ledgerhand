/**
 * Two tenants running "the same vendor product."
 *
 * This is the whole point of the second tenant: at a real institution you do not
 * get a fresh app per customer, you get the same vendor build with different
 * branding, different field labels, a different route layout, and sometimes an
 * extra mandatory interstitial that one institution's compliance team demanded.
 *
 * A capability recorded against `meridian` should replay against `riverstone`
 * with a small, reviewable override -- not a re-recording. Everything that
 * differs below is deliberately the kind of difference that breaks naive
 * CSS-selector automation but survives semantic (role + accessible name)
 * targeting.
 */

export interface TenantConfig {
  /** Stable identifier for the vendor product both tenants run. */
  productId: string;
  /** Per-institution identifier. */
  tenantId: string;
  /** Vendor build string, surfaced in the UI footer so drift is detectable. */
  productVersion: string;
  institutionName: string;
  consoleTitle: string;
  port: number;
  /** Route table -- riverstone reorganised the servicing routes. */
  routes: {
    login: string;
    console: string;
    nav: string;
    home: string;
    memberSearch: string;
    memberDetail: string;
    subAccountNew: string;
    subAccountConfirm: string;
    notice: string;
    terms: string;
  };
  /** Visible labels. Same semantics, different words. */
  labels: {
    memberIdField: string;
    searchButton: string;
    navServicing: string;
    savingsRowLabel: string;
    openSubAccount: string;
    subAccountDescription: string;
    subAccountDeposit: string;
    subAccountSubmit: string;
    confirmHeading: string;
  };
  /** riverstone forces a terms acknowledgement page after login. */
  requiresTermsAck: boolean;
  theme: { bg: string; bar: string; accent: string };
}

const MERIDIAN: TenantConfig = {
  productId: 'corepoint-servicing',
  tenantId: 'meridian-cu',
  productVersion: '4.2.118',
  institutionName: 'Meridian Credit Union',
  consoleTitle: 'Member Servicing Console',
  port: Number(process.env.TARGET_APP_PORT ?? 4173),
  routes: {
    login: '/login.aspx',
    console: '/console.aspx',
    nav: '/nav.aspx',
    home: '/home.aspx',
    memberSearch: '/member-search.aspx',
    memberDetail: '/member-detail.aspx',
    subAccountNew: '/subaccount-new.aspx',
    subAccountConfirm: '/subaccount-confirm.aspx',
    notice: '/system-notice.aspx',
    terms: '/terms-ack.aspx',
  },
  labels: {
    memberIdField: 'Member ID',
    searchButton: 'Search',
    navServicing: 'Member Servicing',
    savingsRowLabel: 'REGULAR SHARE SAVINGS',
    openSubAccount: 'Open Sub-Account',
    subAccountDescription: 'Description',
    subAccountDeposit: 'Initial Deposit',
    subAccountSubmit: 'Submit Request',
    confirmHeading: 'Sub-Account Opened',
  },
  requiresTermsAck: false,
  theme: { bg: '#d4d0c8', bar: '#003c71', accent: '#7a0019' },
};

const RIVERSTONE: TenantConfig = {
  productId: 'corepoint-servicing',
  tenantId: 'riverstone-fcu',
  productVersion: '4.1.94', // an older build of the same product
  institutionName: 'Riverstone Federal Credit Union',
  consoleTitle: 'Account Services Workstation',
  port: Number(process.env.TARGET_APP_PORT_VARIANT ?? 4174),
  routes: {
    login: '/signon.aspx',
    console: '/workstation.aspx',
    nav: '/menu.aspx',
    home: '/welcome.aspx',
    memberSearch: '/servicing/find-member.aspx',
    memberDetail: '/servicing/member-profile.aspx',
    subAccountNew: '/servicing/subshare-request.aspx',
    subAccountConfirm: '/servicing/subshare-confirm.aspx',
    notice: '/system-notice.aspx',
    terms: '/terms-ack.aspx',
  },
  labels: {
    memberIdField: 'Account Holder #',
    searchButton: 'Find',
    navServicing: 'Member Services',
    savingsRowLabel: 'PRIMARY SHARE SAVINGS',
    openSubAccount: 'New Sub-Share',
    subAccountDescription: 'Purpose',
    subAccountDeposit: 'Opening Amount',
    subAccountSubmit: 'Submit',
    confirmHeading: 'Sub-Share Established',
  },
  requiresTermsAck: true,
  theme: { bg: '#e8e8e0', bar: '#1f4f2f', accent: '#8a5a00' },
};

export const TENANTS: Record<string, TenantConfig> = {
  'meridian-cu': MERIDIAN,
  'riverstone-fcu': RIVERSTONE,
};

export const DEFAULT_TENANT = MERIDIAN;
