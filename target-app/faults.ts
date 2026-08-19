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
  /** For slow-load. */
  delayMs: number;
}

const NO_FAULT: ArmedFault = { kind: 'none', mode: 'always', pathContains: '', delayMs: 0 };

let armed: ArmedFault = { ...NO_FAULT };

export function arm(f: Partial<ArmedFault> & { kind: FaultKind }): ArmedFault {
  armed = {
    kind: f.kind,
    mode: f.mode ?? 'once',
    pathContains: f.pathContains ?? '',
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

/** Returns the fault to apply to this request, consuming it if mode === 'once'. */
export function consumeFor(path: string): FaultKind {
  if (armed.kind === 'none') return 'none';
  if (armed.pathContains && !path.includes(armed.pathContains)) return 'none';
  const kind = armed.kind;
  if (armed.mode === 'once') armed = { ...NO_FAULT };
  return kind;
}

export function currentDelayMs(): number {
  return armed.delayMs;
}
