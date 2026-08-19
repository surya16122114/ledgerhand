/**
 * Deliberately hostile HTML.
 *
 * Everything here is authentic to the class of app this project targets:
 *   - a real <frameset> (nav frame + body frame), so nothing is single-document
 *   - table-based layout, <font> tags, spacer gifs' spiritual descendants
 *   - WebForms-style control ids: name="ctl00$MainContent$txtMemberId"
 *   - NO data-testid, NO semantic classes, NO aria-* attributes
 *   - labels sit in an adjacent <td> with no `for=` attribute, which means the
 *     browser computes an EMPTY accessible name for every text input
 *
 * That last point is the important one. It is why a naive
 * "read the accessibility tree and match on role+name" agent fails on legacy
 * apps, and it is the specific problem `src/surface/web/a11y-snapshot.ts`
 * exists to solve. If this app gave its inputs proper labels the whole
 * perception layer would be uninterestingly easy.
 */

import type { TenantConfig } from './tenants/index.js';

/** WebForms mangles `$` in the name into `_` in the id. Reproduce that faithfully. */
export function ctl(name: string): { name: string; id: string } {
  const full = `ctl00$MainContent$${name}`;
  return { name: full, id: full.replace(/\$/g, '_') };
}

function chrome(t: TenantConfig, title: string, body: string): string {
  return `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">
<html><head><title>${title}</title>
<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">
<style type="text/css">
body { background:${t.theme.bg}; font-family:Tahoma,Arial,sans-serif; font-size:11px; margin:0; padding:0; }
table { border-collapse:collapse; font-size:11px; }
td { padding:2px 6px; }
.t1 { background:${t.theme.bar}; color:#fff; font-weight:bold; padding:4px 8px; }
.t2 { background:#f0eee6; border:1px solid #9a9a8a; }
.g  { background:#c8c4bc; font-weight:bold; border-bottom:1px solid #7a7a6a; }
.e  { color:${t.theme.accent}; font-weight:bold; }
input[type=text],input[type=password],select { border:1px solid #7a7a6a; background:#fff; font-family:Tahoma; font-size:11px; padding:1px 2px; }
input[type=submit],button { border:1px outset #b0b0a0; background:#dcdcd0; font-family:Tahoma; font-size:11px; padding:1px 8px; cursor:pointer; }
a { color:#00309a; }
.ftr { color:#555; font-size:10px; padding:6px 8px; }
</style></head>
<body>
<table width="100%" cellspacing="0" cellpadding="0"><tr><td class="t1">${t.institutionName} &nbsp;&#149;&nbsp; ${t.consoleTitle}</td></tr></table>
${body}
<table width="100%"><tr><td class="ftr">CorePoint Servicing ${t.productVersion} &nbsp; | &nbsp; ${t.tenantId} &nbsp; | &nbsp; UNCLASSIFIED &#150; SYNTHETIC DATA ONLY</td></tr></table>
</body></html>`;
}

/**
 * A label/field row where the label is a sibling table cell with no `for=`.
 * This is the single most common legacy form pattern and produces an input
 * with an empty accessible name.
 */
function fieldRow(label: string, control: string): string {
  return `<tr><td align="right" nowrap><font face="Tahoma" size="1"><b>${label}:</b></font></td><td>${control}</td></tr>`;
}

export function loginPage(t: TenantConfig, error?: string): string {
  const u = ctl('txtUserId');
  const p = ctl('txtPassword');
  return chrome(t, `${t.institutionName} - Sign On`, `
<br><center>
<table class="t2" cellpadding="6"><tr><td>
<table width="380"><tr><td class="g" colspan="2">OPERATOR SIGN ON</td></tr>
${error ? `<tr><td colspan="2"><font size="1" class="e">${error}</font></td></tr>` : ''}
<form method="post" action="${t.routes.login}" id="frmSignOn">
${fieldRow('User ID', `<input type="text" name="${u.name}" id="${u.id}" size="24" autocomplete="off">`)}
${fieldRow('Password', `<input type="password" name="${p.name}" id="${p.id}" size="24" autocomplete="off">`)}
<tr><td></td><td><br><input type="submit" name="ctl00$MainContent$btnSignOn" id="ctl00_MainContent_btnSignOn" value="Sign On"></td></tr>
</form>
</table>
</td></tr></table>
<br><font size="1">Authorized use only. Activity is logged.</font>
</center>`);
}

/** The frameset. Note this is a real frameset, not an iframe convenience. */
export function consoleFrameset(t: TenantConfig, bodySrc: string): string {
  return `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Frameset//EN">
<html><head><title>${t.institutionName} - ${t.consoleTitle}</title></head>
<frameset rows="86,*" border="1" frameborder="1">
  <frame name="navFrame" src="${t.routes.nav}" scrolling="no" noresize>
  <frame name="bodyFrame" src="${bodySrc}">
  <noframes><body>This application requires frame support.</body></noframes>
</frameset></html>`;
}

export function navFrame(t: TenantConfig, operatorLabel: string): string {
  return chrome(t, 'Navigation', `
<table width="100%"><tr>
<td nowrap><font size="1">
<a href="${t.routes.home}" target="bodyFrame">Home</a> &nbsp;|&nbsp;
<a href="${t.routes.memberSearch}" target="bodyFrame">${t.labels.navServicing}</a> &nbsp;|&nbsp;
<a href="/teller.aspx" target="bodyFrame">Teller Ops</a> &nbsp;|&nbsp;
<a href="/gl.aspx" target="bodyFrame">General Ledger</a> &nbsp;|&nbsp;
<a href="/admin.aspx" target="bodyFrame">Administration</a>
</font></td>
<td align="right" nowrap><font size="1">Signed on: <b>${operatorLabel}</b> &nbsp; <a href="/signoff.aspx" target="_top">Sign Off</a></font></td>
</tr></table>`);
}

export function homeFrame(t: TenantConfig): string {
  return chrome(t, 'Home', `
<br><table class="t2" cellpadding="8" width="90%" align="center"><tr><td>
<table width="100%"><tr><td class="g">DAILY OPERATIONS SUMMARY</td></tr></table>
<br><font size="1">
Select a function from the menu above.<br><br>
Batch posting completed 04:11 &nbsp;&#149;&nbsp; 0 exceptions<br>
Item processing queue: 0 &nbsp;&#149;&nbsp; Wire queue: 0
</font>
</td></tr></table>`);
}

export function memberSearchFrame(t: TenantConfig, opts: { error?: string; notFoundFor?: string } = {}): string {
  const f = ctl('txtMemberId');
  return chrome(t, t.labels.navServicing, `
<br><table class="t2" cellpadding="8" width="90%" align="center"><tr><td>
<table width="100%"><tr><td class="g" colspan="2">${t.labels.navServicing.toUpperCase()} &#150; INQUIRY</td></tr></table>
<br>
<form method="get" action="${t.routes.memberSearch}" id="frmSearch">
<table>
${fieldRow(t.labels.memberIdField, `<input type="text" name="${f.name}" id="${f.id}" size="16" maxlength="10">`)}
<tr><td></td><td><br><input type="submit" name="ctl00$MainContent$btnSearch" id="ctl00_MainContent_btnSearch" value="${t.labels.searchButton}"></td></tr>
</table>
</form>
${opts.error ? `<br><font size="1" class="e">${opts.error}</font>` : ''}
${opts.notFoundFor !== undefined ? `<br><table width="100%"><tr><td class="g">SEARCH RESULTS</td></tr></table>
<br><font size="1" class="e">No records found matching the specified criteria.</font>
<br><br><font size="1">${t.labels.memberIdField} searched: ${escapeHtml(opts.notFoundFor)}</font>` : ''}
</td></tr></table>`);
}

export interface DetailView {
  memberId: string;
  memberName: string;
  status: string;
  branch: string;
  joinedOn: string;
  taxIdLast4: string;
  rows: { accountNumber: string; description: string; balance: string; available: string; openedOn: string }[];
}

export function memberDetailFrame(t: TenantConfig, v: DetailView, savingsLabel: string): string {
  const rows = v.rows
    .map(
      (r) => `<tr>
<td nowrap><font size="1">${r.accountNumber}</font></td>
<td nowrap><font size="1">${r.description === 'REGULAR SHARE SAVINGS' ? savingsLabel : r.description}</font></td>
<td nowrap align="right"><font size="1">${r.balance}</font></td>
<td nowrap align="right"><font size="1">${r.available}</font></td>
<td nowrap><font size="1">${r.openedOn}</font></td>
</tr>`,
    )
    .join('\n');
  return chrome(t, `Member ${v.memberId}`, `
<br><table class="t2" cellpadding="8" width="94%" align="center"><tr><td>
<table width="100%"><tr><td class="g" colspan="4">MEMBER PROFILE</td></tr></table>
<br>
<table width="100%">
<tr>
  <td align="right" nowrap><font size="1"><b>${t.labels.memberIdField}:</b></font></td><td nowrap><font size="1"><b>${v.memberId}</b></font></td>
  <td align="right" nowrap><font size="1"><b>Name:</b></font></td><td nowrap><font size="1">${escapeHtml(v.memberName)}</font></td>
</tr>
<tr>
  <td align="right" nowrap><font size="1"><b>Status:</b></font></td><td nowrap><font size="1">${v.status}</font></td>
  <td align="right" nowrap><font size="1"><b>Tax ID:</b></font></td><td nowrap><font size="1">***-**-${v.taxIdLast4}</font></td>
</tr>
<tr>
  <td align="right" nowrap><font size="1"><b>Branch:</b></font></td><td nowrap><font size="1">${v.branch}</font></td>
  <td align="right" nowrap><font size="1"><b>Member Since:</b></font></td><td nowrap><font size="1">${v.joinedOn}</font></td>
</tr>
</table>
<br>
<table width="100%"><tr><td class="g" colspan="5">SHARE / DEPOSIT ACCOUNTS</td></tr></table>
<table width="100%" border="0" cellspacing="0">
<tr>
  <td class="g" nowrap><font size="1">Account</font></td>
  <td class="g" nowrap><font size="1">Description</font></td>
  <td class="g" nowrap align="right"><font size="1">Current Balance</font></td>
  <td class="g" nowrap align="right"><font size="1">Available</font></td>
  <td class="g" nowrap><font size="1">Opened</font></td>
</tr>
${rows}
</table>
<br>
<font size="1">
<a href="${t.routes.subAccountNew}?mid=${encodeURIComponent(v.memberId)}">${t.labels.openSubAccount}</a>
&nbsp;|&nbsp; <a href="${t.routes.memberSearch}">New Search</a>
</font>
</td></tr></table>`);
}

export function subAccountFormFrame(
  t: TenantConfig,
  memberId: string,
  memberName: string,
  opts: { validationError?: string; description?: string; deposit?: string } = {},
): string {
  const d = ctl('txtDescription');
  const a = ctl('txtInitialDeposit');
  const ty = ctl('ddlProductType');
  return chrome(t, t.labels.openSubAccount, `
<br><table class="t2" cellpadding="8" width="90%" align="center"><tr><td>
<table width="100%"><tr><td class="g" colspan="2">${t.labels.openSubAccount.toUpperCase()} &#150; REQUEST</td></tr></table>
<br><font size="1">Member <b>${memberId}</b> &#150; ${escapeHtml(memberName)}</font><br><br>
${opts.validationError ? `<font size="1" class="e">${opts.validationError}</font><br><br>` : ''}
<form method="post" action="${t.routes.subAccountNew}?mid=${encodeURIComponent(memberId)}" id="frmSubAccount">
<table>
${fieldRow(
  'Product Type',
  `<select name="${ty.name}" id="${ty.id}"><option value="SUBSHARE">Sub-Share Savings</option><option value="HOLIDAY">Holiday Club</option><option value="VACATION">Vacation Club</option></select>`,
)}
${fieldRow(t.labels.subAccountDescription, `<input type="text" name="${d.name}" id="${d.id}" size="30" maxlength="40" value="${escapeHtml(opts.description ?? '')}">`)}
${fieldRow(t.labels.subAccountDeposit, `<input type="text" name="${a.name}" id="${a.id}" size="12" maxlength="12" value="${escapeHtml(opts.deposit ?? '')}">`)}
<tr><td></td><td><br>
<input type="submit" name="ctl00$MainContent$btnSubmit" id="ctl00_MainContent_btnSubmit" value="${t.labels.subAccountSubmit}">
&nbsp;<input type="submit" name="ctl00$MainContent$btnCancel" id="ctl00_MainContent_btnCancel" value="Cancel">
</td></tr>
</table>
</form>
<br><font size="1">Minimum opening deposit is $25.00. Requests post same-day.</font>
</td></tr></table>`);
}

export function subAccountConfirmFrame(
  t: TenantConfig,
  v: { memberId: string; accountNumber: string; description: string; balance: string; reference: string },
): string {
  return chrome(t, t.labels.confirmHeading, `
<br><table class="t2" cellpadding="8" width="90%" align="center"><tr><td>
<table width="100%"><tr><td class="g" colspan="2">${t.labels.confirmHeading.toUpperCase()}</td></tr></table>
<br><font size="1">The request completed successfully. Retain the confirmation reference below.</font><br><br>
<table>
<tr><td align="right" nowrap><font size="1"><b>New Account Number:</b></font></td><td nowrap><font size="1"><b>${v.accountNumber}</b></font></td></tr>
<tr><td align="right" nowrap><font size="1"><b>Description:</b></font></td><td nowrap><font size="1">${escapeHtml(v.description)}</font></td></tr>
<tr><td align="right" nowrap><font size="1"><b>Opening Balance:</b></font></td><td nowrap><font size="1">${v.balance}</font></td></tr>
<tr><td align="right" nowrap><font size="1"><b>Confirmation Reference:</b></font></td><td nowrap><font size="1">${v.reference}</font></td></tr>
</table>
<br><font size="1"><a href="${t.routes.memberDetail}?mid=${encodeURIComponent(v.memberId)}">Return to Member Profile</a></font>
</td></tr></table>`);
}

/** The unexpected interstitial. Appears mid-flow and blocks progress until acknowledged. */
export function systemNoticeFrame(t: TenantConfig, returnTo: string): string {
  return chrome(t, 'System Notice', `
<br><center>
<table class="t2" cellpadding="10" width="480"><tr><td>
<table width="100%"><tr><td class="g">SYSTEM NOTICE</td></tr></table>
<br><font size="1">
Scheduled maintenance is planned for this Saturday 02:00&#150;05:00 ET.
Servicing functions will be unavailable during that window.
</font><br><br>
<form method="get" action="${returnTo.split('?')[0]}" id="frmNotice">
${returnTo.includes('?') ? returnTo.split('?')[1]!.split('&').map((kv) => { const [k, ...r] = kv.split('='); return `<input type="hidden" name="${escapeHtml(decodeURIComponent(k!))}" value="${escapeHtml(decodeURIComponent(r.join('=')))}">`; }).join('') : ''}
<input type="hidden" name="noticeAck" value="1">
<input type="submit" value="Continue">
</form>
</td></tr></table></center>`);
}

/** riverstone's compliance-mandated terms gate. A per-tenant extra step. */
export function termsAckFrame(t: TenantConfig, returnTo: string): string {
  return chrome(t, 'Terms Acknowledgement', `
<br><center>
<table class="t2" cellpadding="10" width="520"><tr><td>
<table width="100%"><tr><td class="g">ACCEPTABLE USE ACKNOWLEDGEMENT</td></tr></table>
<br><font size="1">
Access to member records is restricted to legitimate business purpose. All access is
recorded and subject to audit review.
</font><br><br>
<form method="get" action="${t.routes.terms}" id="frmTerms">
<input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
<input type="hidden" name="ack" value="1">
<input type="submit" value="I Acknowledge">
</form>
</td></tr></table></center>`);
}

export function permissionDeniedFrame(t: TenantConfig, memberId: string): string {
  return chrome(t, 'Not Authorized', `
<br><table class="t2" cellpadding="8" width="90%" align="center"><tr><td>
<table width="100%"><tr><td class="g">ACCESS DENIED</td></tr></table>
<br><font size="1" class="e">You are not authorized to view this member record.</font>
<br><br><font size="1">Member ${escapeHtml(memberId)} is flagged restricted. Contact the Security Administrator
to request entitlement SVC-RESTRICTED-READ.</font>
<br><br><font size="1"><a href="${t.routes.memberSearch}">Return to Search</a></font>
</td></tr></table>`);
}

export function appErrorFrame(t: TenantConfig, ref: string): string {
  return chrome(t, 'Server Error', `
<br><table class="t2" cellpadding="8" width="90%" align="center"><tr><td>
<table width="100%"><tr><td class="g">UNHANDLED EXCEPTION</td></tr></table>
<br><font size="1" class="e">Server Error in '/' Application.</font><br><br>
<font size="1"><b>Object reference not set to an instance of an object.</b></font><br><br>
<font size="1">Description: An unhandled exception occurred during the execution of the current
web request. Correlation id ${ref}.</font>
</td></tr></table>`);
}

export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
