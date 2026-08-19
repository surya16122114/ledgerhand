/**
 * The legacy stand-in: "CorePoint Servicing", a fictional core-banking servicing
 * console, served as a WebForms-era frameset app.
 *
 * Two instances start on two ports, configured as two different institutions
 * running the same vendor product (see tenants/index.ts). Everything is
 * in-memory and synthetic.
 *
 *   npm run target-app
 *     -> http://localhost:4173  Meridian Credit Union   (base recording tenant)
 *     -> http://localhost:4174  Riverstone FCU          (drift / override tenant)
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { TENANTS, type TenantConfig } from './tenants/index.js';
import { findMember, openSubAccount, subAccountsFor, money, type Member } from './data.js';
import * as faults from './faults.js';
import * as R from './render.js';

const SESSION_TTL_MS = 20 * 60 * 1000;
const SESSION_COOKIE = 'CPSESSION';
const MIN_DEPOSIT = 25;

interface Session {
  id: string;
  operator: string;
  createdAt: number;
  expiresAt: number;
  termsAcked: boolean;
  /** Every action the app itself observed, so the operator handoff has app-side truth too. */
  auditTrail: { at: number; path: string; method: string }[];
}

/** Valid operator credentials for the stand-in. Never real, never logged. */
const VALID_USER = process.env.LEDGERHAND_OPERATOR_USER ?? 'svc_agent';
const VALID_PASS = process.env.LEDGERHAND_OPERATOR_PASS ?? 'demo-password-not-real';

function buildApp(t: TenantConfig) {
  const app = express();
  const sessions = new Map<string, Session>();
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser);
  app.disable('x-powered-by');
  app.set('etag', false);

  // ---------------------------------------------------------------- fault plane
  app.post('/__fault/arm', express.json(), (req, res) => {
    const armed = faults.arm(req.body ?? { kind: 'none' });
    res.json({ ok: true, armed });
  });
  app.post('/__fault/disarm', (_req, res) => {
    faults.disarm();
    res.json({ ok: true, armed: faults.peek() });
  });
  app.get('/__fault', (_req, res) => res.json(faults.peek()));
  app.get('/__health', (_req, res) => res.json({ ok: true, tenant: t.tenantId, product: `${t.productId}@${t.productVersion}` }));

  // ------------------------------------------------------- fault interception
  app.use(async (req, res, next) => {
    if (req.path.startsWith('/__')) return next();
    const { kind, delayMs } = faults.consumeFor(req.path, req.method);
    switch (kind) {
      case 'slow-load':
        await sleep(delayMs);
        return next();
      case 'app-error':
        res.status(500).send(R.appErrorFrame(t, randomUUID().slice(0, 8)));
        return;
      case 'session-expiry': {
        const sid = req.cookies[SESSION_COOKIE];
        if (sid) sessions.delete(sid);
        return next();
      }
      case 'unexpected-notice': {
        const qs = new URLSearchParams(req.query as Record<string, string>).toString();
        const back = qs ? `${req.path}?${qs}` : req.path;
        res.send(R.systemNoticeFrame(t, back));
        return;
      }
      default:
        return next();
    }
  });

  // ------------------------------------------------------------------- helpers
  function currentSession(req: Request): Session | undefined {
    const sid = req.cookies[SESSION_COOKIE];
    if (!sid) return undefined;
    const s = sessions.get(sid);
    if (!s) return undefined;
    if (Date.now() > s.expiresAt) {
      sessions.delete(sid);
      return undefined;
    }
    s.expiresAt = Date.now() + SESSION_TTL_MS;
    s.auditTrail.push({ at: Date.now(), path: req.path, method: req.method });
    return s;
  }

  /**
   * Guards every servicing page. Two distinct redirect shapes matter downstream:
   * an expired session lands on sign-on WITH a message, a never-signed-on
   * request lands on sign-on WITHOUT one. Replay uses that message to tell
   * "my session died mid-run" (recoverable: re-auth) apart from "I was never
   * signed on" (a setup bug).
   */
  function requireSession(req: Request, res: Response, next: NextFunction) {
    const s = currentSession(req);
    if (!s) {
      const had = Boolean(req.cookies[SESSION_COOKIE]);
      res.clearCookie(SESSION_COOKIE);
      const msg = had ? 'Your session has expired. Please sign on again.' : undefined;
      res.status(had ? 200 : 200).send(R.loginPage(t, msg));
      return;
    }
    if (t.requiresTermsAck && !s.termsAcked && req.path !== t.routes.terms) {
      const qs = new URLSearchParams(req.query as Record<string, string>).toString();
      res.send(R.termsAckFrame(t, qs ? `${req.path}?${qs}` : req.path));
      return;
    }
    next();
  }

  // --------------------------------------------------------------------- auth
  app.get('/', (_req, res) => res.redirect(t.routes.login));
  app.get(t.routes.login, (_req, res) => res.send(R.loginPage(t)));

  app.post(t.routes.login, (req, res) => {
    const user = String(req.body['ctl00$MainContent$txtUserId'] ?? '');
    const pass = String(req.body['ctl00$MainContent$txtPassword'] ?? '');
    if (user !== VALID_USER || pass !== VALID_PASS) {
      res.send(R.loginPage(t, 'Sign on failed. The User ID or Password is not valid.'));
      return;
    }
    const s: Session = {
      id: randomUUID(),
      operator: user,
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL_MS,
      termsAcked: false,
      auditTrail: [],
    };
    sessions.set(s.id, s);
    res.cookie(SESSION_COOKIE, s.id, { httpOnly: true, sameSite: 'lax' });
    res.redirect(t.routes.console);
  });

  app.get('/signoff.aspx', (req, res) => {
    const sid = req.cookies[SESSION_COOKIE];
    if (sid) sessions.delete(sid);
    res.clearCookie(SESSION_COOKIE);
    res.send(R.loginPage(t, 'You have been signed off.'));
  });

  app.get(t.routes.terms, requireSession, (req, res) => {
    const s = currentSession(req)!;
    if (req.query.ack === '1') {
      s.termsAcked = true;
      const back = String(req.query.returnTo ?? t.routes.home);
      res.redirect(back.startsWith('/') ? back : t.routes.home);
      return;
    }
    res.send(R.termsAckFrame(t, t.routes.home));
  });

  // ------------------------------------------------------------------ console
  app.get(t.routes.console, requireSession, (_req, res) => res.send(R.consoleFrameset(t, t.routes.home)));
  app.get(t.routes.nav, requireSession, (req, res) => res.send(R.navFrame(t, currentSession(req)!.operator)));
  app.get(t.routes.home, requireSession, (_req, res) => res.send(R.homeFrame(t)));

  // Menu destinations that exist only so the allowlist has real routes to forbid.
  // The agent can see these links in the nav frame; policy must stop it from
  // wandering into General Ledger or Administration while pursuing a goal.
  for (const route of ['/teller.aspx', '/gl.aspx', '/admin.aspx']) {
    app.get(route, requireSession, (_req, res) => {
      res.send(R.homeFrame(t));
    });
  }

  // ------------------------------------------------------------------ search
  app.get(t.routes.memberSearch, requireSession, (req, res) => {
    const raw = req.query['ctl00$MainContent$txtMemberId'];
    if (raw === undefined) {
      res.send(R.memberSearchFrame(t));
      return;
    }
    const memberId = String(raw).trim();
    if (memberId === '') {
      res.send(R.memberSearchFrame(t, { error: `${t.labels.memberIdField} is required.` }));
      return;
    }
    if (!/^\d{1,10}$/.test(memberId)) {
      res.send(R.memberSearchFrame(t, { error: `${t.labels.memberIdField} must be numeric.` }));
      return;
    }
    const member = findMember(memberId);
    if (!member) {
      res.send(R.memberSearchFrame(t, { notFoundFor: memberId }));
      return;
    }
    res.redirect(`${t.routes.memberDetail}?mid=${encodeURIComponent(memberId)}`);
  });

  // ------------------------------------------------------------------ detail
  app.get(t.routes.memberDetail, requireSession, (req, res) => {
    const memberId = String(req.query.mid ?? '').trim();
    const member = findMember(memberId);
    if (!member) {
      res.send(R.memberSearchFrame(t, { notFoundFor: memberId }));
      return;
    }
    if (member.restricted) {
      res.status(403).send(R.permissionDeniedFrame(t, memberId));
      return;
    }
    res.send(R.memberDetailFrame(t, detailView(member), t.labels.savingsRowLabel));
  });

  // ------------------------------------------------------------- sub-account
  app.get(t.routes.subAccountNew, requireSession, (req, res) => {
    const member = findMember(String(req.query.mid ?? ''));
    if (!member) {
      res.send(R.memberSearchFrame(t, { notFoundFor: String(req.query.mid ?? '') }));
      return;
    }
    res.send(R.subAccountFormFrame(t, member.memberId, fullName(member)));
  });

  app.post(t.routes.subAccountNew, requireSession, (req, res) => {
    const member = findMember(String(req.query.mid ?? ''));
    if (!member) {
      res.send(R.memberSearchFrame(t, { notFoundFor: String(req.query.mid ?? '') }));
      return;
    }
    if (req.body['ctl00$MainContent$btnCancel'] !== undefined) {
      res.redirect(`${t.routes.memberDetail}?mid=${encodeURIComponent(member.memberId)}`);
      return;
    }
    const description = String(req.body['ctl00$MainContent$txtDescription'] ?? '').trim();
    const depositRaw = String(req.body['ctl00$MainContent$txtInitialDeposit'] ?? '').trim();
    const form = { description, deposit: depositRaw };

    if (description === '') {
      res.send(R.subAccountFormFrame(t, member.memberId, fullName(member), { ...form, validationError: `${t.labels.subAccountDescription} is required.` }));
      return;
    }
    const deposit = Number(depositRaw.replace(/[$,]/g, ''));
    if (depositRaw === '' || Number.isNaN(deposit)) {
      res.send(R.subAccountFormFrame(t, member.memberId, fullName(member), { ...form, validationError: `${t.labels.subAccountDeposit} must be a valid dollar amount.` }));
      return;
    }
    if (deposit < MIN_DEPOSIT) {
      res.send(
        R.subAccountFormFrame(t, member.memberId, fullName(member), {
          ...form,
          validationError: `${t.labels.subAccountDeposit} must be at least ${money(MIN_DEPOSIT)}.`,
        }),
      );
      return;
    }
    const account = openSubAccount(member.memberId, description, deposit);
    const reference = `SA-${Date.now().toString(36).toUpperCase().slice(-8)}`;
    res.send(
      R.subAccountConfirmFrame(t, {
        memberId: member.memberId,
        accountNumber: account.accountNumber,
        description: account.description,
        balance: money(account.balance),
        reference,
      }),
    );
  });

  function detailView(member: Member): R.DetailView {
    return {
      memberId: member.memberId,
      memberName: fullName(member),
      status: member.status,
      branch: member.branch,
      joinedOn: member.joinedOn,
      taxIdLast4: member.taxIdLast4,
      rows: [...member.accounts, ...subAccountsFor(member.memberId)].map((a) => ({
        accountNumber: a.accountNumber,
        description: a.description,
        balance: money(a.balance),
        available: money(a.available),
        openedOn: a.openedOn,
      })),
    };
  }

  return app;
}

function fullName(m: Member): string {
  return `${m.lastName}, ${m.firstName}`;
}

/** Minimal cookie parser -- avoids a dependency for one header. */
function cookieParser(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.cookie ?? '';
  const jar: Record<string, string> = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) jar[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  (req as Request & { cookies: Record<string, string> }).cookies = jar;
  next();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

declare global {
  namespace Express {
    interface Request {
      cookies: Record<string, string>;
    }
  }
}

for (const tenant of Object.values(TENANTS)) {
  buildApp(tenant).listen(tenant.port, () => {
    console.log(`[target-app] ${tenant.institutionName.padEnd(34)} ${tenant.productId}@${tenant.productVersion}  http://localhost:${tenant.port}${tenant.routes.login}`);
  });
}
