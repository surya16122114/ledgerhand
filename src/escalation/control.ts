/**
 * The control lease.
 *
 * "Who is driving this session right now" is the question that makes
 * human-in-the-loop handoff safe, and it needs exactly one answer at any moment.
 * A boolean `paused` flag would not be enough: pausing says the automation
 * stopped, not that the human started, and the gap between those two is where a
 * human and a replay engine both click Submit.
 *
 * So the lease is an explicit owner with explicit transitions, and it is enforced
 * by `LeaseGuard` -- a Surface decorator -- rather than by everyone remembering
 * to check it. Automation physically cannot act while the operator holds the
 * lease.
 *
 * The human is deliberately *not* routed through the guard. An authorised
 * employee taking over their own institution's application is not subject to the
 * agent's allowlist; they are subject to the app's own entitlements, which is
 * where that decision belongs. What we owe in exchange is a record of what they
 * did, which is what HumanActionRecorder provides.
 */

import type {
  Action,
  ActionResult,
  Condition,
  ConditionResult,
  ObserveOptions,
  Observation,
  Resolution,
  Surface,
  SurfaceKind,
  TargetDescriptor,
} from '../surface/types.js';

export type Controller = 'automation' | 'operator';

export interface LeaseTransition {
  at: string;
  from: Controller;
  to: Controller;
  by: string;
  reason: string;
}

export class ControlLease {
  private owner: Controller = 'automation';
  private history: LeaseTransition[] = [];
  private waiters: (() => void)[] = [];

  current(): Controller {
    return this.owner;
  }

  heldByAutomation(): boolean {
    return this.owner === 'automation';
  }

  transitions(): LeaseTransition[] {
    return [...this.history];
  }

  /**
   * Hand control to a human. Idempotent: a second operator claiming an already
   * ceded session is not an error, it is two people looking at the same queue.
   */
  cedeToOperator(by: string, reason: string): LeaseTransition {
    return this.transfer('operator', by, reason);
  }

  /** Take control back once the human signals they are done. */
  returnToAutomation(by: string, reason: string): LeaseTransition {
    const t = this.transfer('automation', by, reason);
    const waiting = this.waiters.splice(0);
    for (const w of waiting) w();
    return t;
  }

  private transfer(to: Controller, by: string, reason: string): LeaseTransition {
    const transition: LeaseTransition = { at: new Date().toISOString(), from: this.owner, to, by, reason };
    this.owner = to;
    this.history.push(transition);
    return transition;
  }

  /** Resolves when automation holds the lease again. */
  waitForReturn(): Promise<void> {
    if (this.owner === 'automation') return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

/**
 * Refuses every mutating action while the operator holds the lease.
 *
 * Reads are still permitted, and that is intentional: while a human is working
 * the session the automation still needs to observe -- to render the operator
 * console, to capture evidence, and to notice when the state it was waiting for
 * has appeared. Observation does not compete for the pointer; clicks do.
 */
export class LeaseGuard implements Surface {
  readonly kind: SurfaceKind;
  readonly sessionId: string;

  constructor(
    private readonly inner: Surface,
    private readonly lease: ControlLease,
  ) {
    this.kind = inner.kind;
    this.sessionId = inner.sessionId;
  }

  private static readonly READ_ONLY: Action['kind'][] = ['readText', 'waitFor', 'assert'];

  async perform(action: Action): Promise<ActionResult> {
    if (!this.lease.heldByAutomation() && !LeaseGuard.READ_ONLY.includes(action.kind)) {
      return {
        ok: false,
        error: {
          code: 'POLICY_DENIED',
          message: `automation does not hold the control lease (currently: ${this.lease.current()})`,
          observed: 'a human operator is driving this session',
        },
      };
    }
    return this.inner.perform(action);
  }

  observe(opts?: ObserveOptions): Promise<Observation> {
    return this.inner.observe(opts);
  }
  resolve(target: TargetDescriptor): Promise<Resolution> {
    return this.inner.resolve(target);
  }
  evaluate(condition: Condition, opts?: { timeoutMs?: number }): Promise<ConditionResult> {
    return this.inner.evaluate(condition, opts);
  }
  location(): Promise<{ url: string; title: string; frameUrls: string[] }> {
    return this.inner.location();
  }
  screenshot(path: string, opts?: { maskSensitive?: boolean }): Promise<string | undefined> {
    return this.inner.screenshot(path, opts);
  }
  sourceSnapshot(path: string): Promise<string | undefined> {
    return this.inner.sourceSnapshot(path);
  }
  close(): Promise<void> {
    return this.inner.close();
  }
}
