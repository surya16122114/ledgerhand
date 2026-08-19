/**
 * In-memory fixture data for the legacy stand-in app.
 *
 * All of it is synthetic. Member names are invented, "SSNs" are obviously fake,
 * balances are arbitrary. Nothing here is real PII -- but the app presents it in
 * the shape a real core-banking screen would, so the redaction machinery has
 * something realistic to bite on.
 */

export interface Member {
  memberId: string;
  firstName: string;
  lastName: string;
  taxIdLast4: string;
  status: 'ACTIVE' | 'DORMANT' | 'CLOSED';
  branch: string;
  joinedOn: string;
  accounts: Account[];
  /** Simulates a member whose record the service account may not read. */
  restricted?: boolean;
}

export interface Account {
  accountNumber: string;
  type: 'SAVINGS' | 'CHECKING' | 'CERTIFICATE' | 'SUB-SAVINGS';
  description: string;
  balance: number;
  available: number;
  openedOn: string;
}

export const MEMBERS: Member[] = [
  {
    memberId: '12345',
    firstName: 'Dolores',
    lastName: 'Ashgrove',
    taxIdLast4: '4417',
    status: 'ACTIVE',
    branch: 'BR-014 NORTHGATE',
    joinedOn: '03/11/2009',
    accounts: [
      { accountNumber: '12345-00', type: 'SAVINGS', description: 'REGULAR SHARE SAVINGS', balance: 8241.77, available: 8241.77, openedOn: '03/11/2009' },
      { accountNumber: '12345-10', type: 'CHECKING', description: 'FREE CHECKING', balance: 1502.31, available: 1402.31, openedOn: '06/02/2011' },
      { accountNumber: '12345-40', type: 'CERTIFICATE', description: '18MO SHARE CERTIFICATE', balance: 15000.0, available: 0, openedOn: '01/19/2024' },
    ],
  },
  {
    memberId: '20881',
    firstName: 'Merrick',
    lastName: 'Vandal',
    taxIdLast4: '9002',
    status: 'ACTIVE',
    branch: 'BR-002 CENTRAL',
    joinedOn: '08/24/2016',
    accounts: [
      { accountNumber: '20881-00', type: 'SAVINGS', description: 'REGULAR SHARE SAVINGS', balance: 312.05, available: 312.05, openedOn: '08/24/2016' },
    ],
  },
  {
    memberId: '30014',
    firstName: 'Ilse',
    lastName: 'Bramwell',
    taxIdLast4: '1188',
    status: 'DORMANT',
    branch: 'BR-014 NORTHGATE',
    joinedOn: '11/05/1998',
    accounts: [
      { accountNumber: '30014-00', type: 'SAVINGS', description: 'REGULAR SHARE SAVINGS', balance: 47.9, available: 47.9, openedOn: '11/05/1998' },
    ],
  },
  {
    // Exercises the permission-denied branch of the error taxonomy.
    memberId: '40009',
    firstName: 'Restricted',
    lastName: 'Record',
    taxIdLast4: '0000',
    status: 'ACTIVE',
    branch: 'BR-001 EXEC',
    joinedOn: '01/01/2020',
    accounts: [],
    restricted: true,
  },
];

export function findMember(memberId: string): Member | undefined {
  return MEMBERS.find((m) => m.memberId === memberId.trim());
}

/** Sub-accounts opened during a session live here so confirmation screens are real. */
const openedSubAccounts = new Map<string, Account[]>();

export function openSubAccount(memberId: string, description: string, initialDeposit: number): Account {
  const existing = openedSubAccounts.get(memberId) ?? [];
  const seq = 50 + existing.length;
  const account: Account = {
    accountNumber: `${memberId}-${seq}`,
    type: 'SUB-SAVINGS',
    description: description.toUpperCase(),
    balance: initialDeposit,
    available: initialDeposit,
    openedOn: new Date().toLocaleDateString('en-US'),
  };
  openedSubAccounts.set(memberId, [...existing, account]);
  return account;
}

export function subAccountsFor(memberId: string): Account[] {
  return openedSubAccounts.get(memberId) ?? [];
}

export function money(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}
