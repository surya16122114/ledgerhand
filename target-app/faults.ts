/**
 * Fault injection control plane for the target app.
 *
 * Runtime faults are armed out-of-band over HTTP rather than via query strings
 * on the app's own URLs. That matters: a query string would leak into the
 * recorded capability's navigation steps, so the artifact would encode "the run
 * where we broke the app on purpose." Arming faults on a side channel keeps the
 * artifact honest -- the replay under test is byte-identical to the happy-path
 * replay, and only the app's behaviour differs.
 */

export type FaultKind =
  | 'none'
  /** Session cookie is rejected on next request -> app bounces to sign-on. */
  | 'session-expiry'
  /** An unexpected interstitial appears before the requested page renders. */
  | 'unexpected-notice'
  /** Page takes far longer than the normal budget to respond. */
  | 'slow-load'
  /** Server returns a 500 error page. */
  | 'app-error';

export interface ArmedFault {
  kind: FaultKind;
  /** Fire on every matching request, or once and then disarm. */
  mode: 'once' | 'always';
  /** Only fire on request paths containing this substring. Empty = any path. */
  pathContains: string;
  /**
   * Only fire on this HTTP method. Empty = any method.
   *
   * Needed to target a submit rather than the form that precedes it: the GET that
   * renders /subaccount-new.aspx and the POST that submits it share a path, so a
   * path-only filter always fires on the harmless one.
   */
  method: string;
  /** For slow-load. */
  delayMs: number;
}

const NO_FAULT: ArmedFault = { kind: 'none', mode: 'always', pathContains: '', method: '', delayMs: 0 };

let armed: ArmedFault = { ...NO_FAULT };

export function arm(f: Partial<ArmedFault> & { kind: FaultKind }): ArmedFault {
  armed = {
    kind: f.kind,
    mode: f.mode ?? 'once',
    pathContains: f.pathContains ?? '',
    method: (f.method ?? '').toUpperCase(),
    delayMs: f.delayMs ?? 9000,
  };
  return armed;
}

export function disarm(): void {
  armed = { ...NO_FAULT };
}

export function peek(): ArmedFault {
  return armed;
}

/**
 * Returns the fault to apply to this request, consuming it if mode === 'once'.
 *
 * The delay is returned *with* the kind rather than fetched separately afterwards.
 * The separate-getter version had a real bug: consuming a `once` fault reset the
 * armed record before the caller read `delayMs`, so `slow-load` always slept zero
 * milliseconds and the fault silently never fired. Returning both together makes
 * that mistake unrepresentable.
 */
export interface ConsumedFault {
  kind: FaultKind;
  delayMs: number;
}

export function consumeFor(path: string, method = ''): ConsumedFault {
  if (armed.kind === 'none') return { kind: 'none', delayMs: 0 };
  if (armed.pathContains && !path.includes(armed.pathContains)) return { kind: 'none', delayMs: 0 };
  if (armed.method && method.toUpperCase() !== armed.method) return { kind: 'none', delayMs: 0 };
  const consumed: ConsumedFault = { kind: armed.kind, delayMs: armed.delayMs };
  if (armed.mode === 'once') armed = { ...NO_FAULT };
  return consumed;
}
