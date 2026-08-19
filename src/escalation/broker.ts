/**
 * Intervention broker.
 *
 * Holds the queue of "a human needs to look at this" requests and owns the
 * lifecycle of each one. In-process and in-memory, with a JSON mirror written
 * into the run's evidence directory.
 *
 * That is a deliberate cut, not an oversight. The real thing is a durable queue
 * with routing rules, per-tenant operator pools, and SLAs. None of that changes
 * the part being designed here, which is the *contract*: what context travels
 * with an escalation, how control changes hands, what the human's decision can
 * be, and how the run resumes. Those are all real below; the transport is not.
 *
 * The context carried with a request is the part worth arguing about. An operator
 * picking this up has no memory of the run, so a request that says "step 6 failed"
 * is useless. Each one carries the goal or capability, the step and its stated
 * intent, why it stopped, where the session is, and a screenshot -- enough to act
 * without asking anyone.
 */

import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ControlLease, LeaseTransition } from './control.js';
import type { Redactor } from '../policy/redact.js';

export type EscalationReason =
  /** Discovery could not find a way forward within its budget. */
  | 'discovery-stuck'
  /** An irreversible action needs a person to authorise it. */
  | 'authorization-required'
  /** Replay hit a condition with no declared handler. */
  | 'unhandled-condition'
  /** A handler explicitly routed to a human. */
  | 'handler-requested';

// Two variants used to live here -- 'policy-violation' and 'recovery-exhausted' -- and
// nothing ever raised either. A latched policy violation surfaces as
// 'unhandled-condition' with the gate's reason attached, and an exhausted recovery
// budget becomes a hard failure rather than a question for a person. An escalation
// reason an operator can never actually see is noise in the one enum a console filters
// on, so they are gone.

export interface HumanAction {
  at: string;
  kind: 'click' | 'input' | 'change' | 'key' | 'navigate';
  /** Description of the control, in the same vocabulary perception uses. */
  control?: string;
  role?: string;
  framePath?: string[];
  /** Present for input/change. Redacted before storage; never set for password fields. */
  value?: string;
  url?: string;
}

export interface InterventionContext {
  runId: string;
  runKind: 'discovery' | 'replay';
  goal?: string;
  capability?: { id: string; version: string; tenantId?: string };
  step?: { index: number; id: string; intent: string };
  /** Where the session is, and a short excerpt of what is on screen. */
  location: { url: string; title: string };
  visibleExcerpt: string;
  evidence: { screenshot?: string; snapshot?: string };
  /** What the automation tried and how it failed. */
  attempt?: { action: string; expected?: string; observed?: string; errorCode?: string };
}

export type InterventionStatus = 'pending' | 'claimed' | 'resolved' | 'abandoned';

/**
 * What the human decided.
 *
 *  resume              - "I fixed the state, carry on from where you were"
 *  authorize-and-resume - "the irreversible action is approved, do it"
 *  skip-step           - "this step is not needed here, move past it"
 *  abort               - "stop; this is not something automation should finish"
 */
export type InterventionDecision = 'resume' | 'authorize-and-resume' | 'skip-step' | 'abort';

export interface Intervention {
  id: string;
  createdAt: string;
  reason: EscalationReason;
  /** One sentence an operator reads first. */
  headline: string;
  detail: string;
  context: InterventionContext;
  status: InterventionStatus;
  claimedBy?: string;
  claimedAt?: string;
  resolvedAt?: string;
  decision?: InterventionDecision;
  operatorNote?: string;
  /** What the human actually did in the live session. */
  humanActions: HumanAction[];
  leaseTransitions: LeaseTransition[];
}

export interface Resolution {
  decision: InterventionDecision;
  note?: string;
  by: string;
  humanActions: HumanAction[];
}

export class InterventionBroker {
  private items = new Map<string, Intervention>();
  private waiters = new Map<string, ((r: Resolution) => void)[]>();
  private listeners: (() => void)[] = [];

  constructor(
    private readonly lease: ControlLease,
    private readonly opts: { evidenceDir?: string; redactor?: Redactor; log?: (type: string, data: Record<string, unknown>) => void } = {},
  ) {}

  onChange(cb: () => void): void {
    this.listeners.push(cb);
  }

  private changed(): void {
    for (const cb of this.listeners) {
      try {
        cb();
      } catch {
        /* a broken listener must not break the queue */
      }
    }
    void this.persist();
  }

  list(): Intervention[] {
    return [...this.items.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): Intervention | undefined {
    return this.items.get(id);
  }

  /**
   * Raise a request and cede the lease immediately.
   *
   * Ceding at raise time rather than at claim time is the safer ordering: between
   * "I am stuck" and "a human picked this up" the automation must already be
   * incapable of acting, or a retry loop somewhere upstream can keep clicking
   * while the request sits in a queue.
   */
  raise(input: { reason: EscalationReason; headline: string; detail: string; context: InterventionContext }): Intervention {
    const id = `int_${randomUUID().slice(0, 8)}`;
    const item: Intervention = {
      id,
      createdAt: new Date().toISOString(),
      reason: input.reason,
      headline: input.headline,
      detail: input.detail,
      context: input.context,
      status: 'pending',
      humanActions: [],
      leaseTransitions: [],
    };
    const transition = this.lease.cedeToOperator('system', `escalation ${id}: ${input.reason}`);
    item.leaseTransitions.push(transition);
    this.items.set(id, item);
    this.opts.log?.('escalation.raised', { interventionId: id, reason: input.reason, headline: input.headline, step: input.context.step });
    this.changed();
    return item;
  }

  claim(id: string, operator: string): Intervention {
    const item = this.require(id);
    if (item.status === 'resolved') throw new Error(`intervention ${id} is already resolved`);
    // Two operators silently sharing one live session is worse than a visible error:
    // both would be clicking into the same signed-on screen with no way to tell whose
    // action did what. Re-claiming by the same operator is fine -- that is a page
    // reload.
    if (item.status === 'claimed' && item.claimedBy && item.claimedBy !== operator) {
      throw new Error(`intervention ${id} is already held by ${item.claimedBy}; one operator drives a session at a time`);
    }
    item.status = 'claimed';
    item.claimedBy = operator;
    item.claimedAt = new Date().toISOString();
    this.opts.log?.('escalation.claimed', { interventionId: id, operator });
    this.changed();
    return item;
  }

  recordHumanAction(id: string, action: HumanAction): void {
    const item = this.items.get(id);
    if (!item) return;
    const redacted = this.opts.redactor ? this.opts.redactor.deep(action) : action;
    item.humanActions.push(redacted);
    // Not logged per-action: a human typing produces a lot of events, and they
    // are all preserved on the intervention record itself.
    this.changed();
  }

  /**
   * Resolve and hand the lease back. The run's own code is waiting on
   * `waitForResolution`, so this is the point at which automation resumes.
   */
  resolve(id: string, decision: InterventionDecision, by: string, note?: string): Intervention {
    const item = this.require(id);
    item.status = 'resolved';
    item.decision = decision;
    item.operatorNote = note;
    item.resolvedAt = new Date().toISOString();
    const transition = this.lease.returnToAutomation(by, `intervention ${id} resolved as ${decision}`);
    item.leaseTransitions.push(transition);
    this.opts.log?.('escalation.resolved', {
      interventionId: id,
      decision,
      by,
      note,
      humanActionCount: item.humanActions.length,
      humanActions: item.humanActions,
    });
    const resolution: Resolution = { decision, note, by, humanActions: item.humanActions };
    for (const w of this.waiters.get(id) ?? []) w(resolution);
    this.waiters.delete(id);
    this.changed();
    return item;
  }

  /**
   * Block the run until a human resolves the request.
   *
   * `timeoutMs` exists so an unattended replay cannot hang on an empty operator
   * queue forever. Timing out is reported as an abort, which is the conservative
   * reading: nobody said this was safe to continue.
   */
  waitForResolution(id: string, timeoutMs?: number): Promise<Resolution> {
    const item = this.require(id);
    if (item.status === 'resolved') {
      return Promise.resolve({ decision: item.decision!, note: item.operatorNote, by: item.claimedBy ?? 'unknown', humanActions: item.humanActions });
    }
    return new Promise<Resolution>((resolve) => {
      const list = this.waiters.get(id) ?? [];
      list.push(resolve);
      this.waiters.set(id, list);
      if (timeoutMs !== undefined) {
        setTimeout(() => {
          const current = this.items.get(id);
          if (current && current.status !== 'resolved') {
            current.status = 'abandoned';
            this.lease.returnToAutomation('system', `intervention ${id} timed out after ${timeoutMs}ms`);
            this.opts.log?.('escalation.timeout', { interventionId: id, timeoutMs });
            this.changed();
            resolve({ decision: 'abort', note: `no operator responded within ${timeoutMs}ms`, by: 'system', humanActions: current.humanActions });
          }
        }, timeoutMs).unref?.();
      }
    });
  }

  private require(id: string): Intervention {
    const item = this.items.get(id);
    if (!item) throw new Error(`no such intervention: ${id}`);
    return item;
  }

  private async persist(): Promise<void> {
    if (!this.opts.evidenceDir) return;
    try {
      const body = { updatedAt: new Date().toISOString(), interventions: this.list() };
      await writeFile(join(this.opts.evidenceDir, 'interventions.json'), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    } catch {
      /* evidence mirroring is best-effort */
    }
  }
}
