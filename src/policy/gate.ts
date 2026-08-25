/**
 * The policy gate.
 *
 * A Surface decorator, so it is impossible to reach the browser without passing
 * through it. That is the whole reason it is shaped this way rather than as a
 * `checkPolicy()` helper that each call site is trusted to remember: the
 * discovery agent, the replay engine, and the recovery paths all hold a
 * `Surface`, and the only `Surface` any of them are ever handed is this one.
 *
 * What it enforces, in order:
 *
 *   1. Action kind is on the allowlist.
 *   2. For a navigation, the destination URL is on the allowlist.
 *   3. The action's risk class -- computed here from the *resolved* control, not
 *      taken from anything the model wrote -- is within the ceiling. Irreversible
 *      actions either fail closed or request authorization, depending on config.
 *   4. After the action, the resulting location is still on the allowlist. This
 *      is the check that catches what a pre-flight check cannot: a click that
 *      redirects somewhere the agent was never permitted to be. A violation here
 *      latches the gate shut for the rest of the session, because at that point
 *      we no longer know what state the app is in.
 *
 * Known gap, stated rather than hidden: the gate resolves the target to classify
 * risk, and the inner surface resolves it again to act. Between those two
 * resolutions the page could in principle change, so the control that was
 * classified is not provably the control that was clicked. On the stable
 * enterprise UIs this targets that window is not a practical risk, and the
 * post-action location check bounds the consequence. Closing it properly means
 * threading a resolution handle through `perform`, which would put a
 * driver-specific concept into the seam.
 */

import type {
  Action,
  ActionResult,
  Condition,
  ConditionResult,
  ObserveOptions,
  Observation,
  Resolution,
  RiskClass,
  Surface,
  SurfaceKind,
  TargetDescriptor,
} from '../surface/types.js';
import { Allowlist, type AllowlistConfig, type PolicyDecision } from './allowlist.js';
import { classifyRisk } from './risk.js';

export interface PolicyEvent {
  at: string;
  phase: 'pre-action' | 'post-action';
  action: Action['kind'];
  target?: string;
  decision: 'allow' | 'deny' | 'authorization-required';
  risk?: RiskClass;
  code?: string;
  reason?: string;
}

export interface PolicyGateOptions {
  allowlist: AllowlistConfig;
  /** Every decision, allow or deny, is emitted. An audit log with only denials is not an audit log. */
  onEvent?: (event: PolicyEvent) => void;
}

export class PolicyGate implements Surface {
  readonly kind: SurfaceKind;
  readonly sessionId: string;

  private allowlist: Allowlist;
  private onEvent: (event: PolicyEvent) => void;
  /** Latched when a post-action location check fails. */
  private tripped?: { code: string; reason: string };
  /** One-shot authorization for a single irreversible action. */
  private authorization?: { grantedBy: string; reason: string };

  constructor(
    private readonly inner: Surface,
    opts: PolicyGateOptions,
  ) {
    this.kind = inner.kind;
    this.sessionId = inner.sessionId;
    this.allowlist = new Allowlist(opts.allowlist);
    this.onEvent = opts.onEvent ?? (() => {});
  }

  /**
   * Grant permission for the next single irreversible action.
   *
   * Deliberately one-shot and consumed on use. A durable "the operator said yes"
   * flag would drift out of scope of what the operator actually looked at.
   */
  authorizeNextIrreversible(grantedBy: string, reason: string): void {
    this.authorization = { grantedBy, reason };
  }

  isTripped(): boolean {
    return this.tripped !== undefined;
  }

  trippedReason(): { code: string; reason: string } | undefined {
    return this.tripped;
  }

  /** Only a human handoff should clear a latched violation. */
  resetAfterHumanReview(by: string): void {
    this.onEvent({
      at: new Date().toISOString(),
      phase: 'post-action',
      action: 'assert',
      decision: 'allow',
      reason: `latched policy violation cleared by ${by}`,
    });
    this.tripped = undefined;
  }

  policy(): AllowlistConfig {
    return this.allowlist.describe();
  }

  // ------------------------------------------------------------------ passthrough

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

  // --------------------------------------------------------------------- gated

  async perform(action: Action): Promise<ActionResult> {
    if (this.tripped) {
      return this.deny(action, undefined, {
        allowed: false,
        code: 'URL_NOT_ALLOWED',
        reason: `session is latched closed: ${this.tripped.reason}`,
      });
    }

    const kindCheck = this.allowlist.checkAction(action.kind);
    if (!kindCheck.allowed) return this.deny(action, undefined, kindCheck);

    if (action.kind === 'navigate') {
      const urlCheck = this.allowlist.checkUrl(action.url);
      if (!urlCheck.allowed) return this.deny(action, action.url, urlCheck);
    }

    // Risk needs the control, so resolve first for the actions that have a target.
    let control;
    let targetLabel: string | undefined;
    if ('target' in action) {
      targetLabel = action.target.description;
      const res = await this.inner.resolve(action.target);
      if (res.ok) control = res.control;
      // A target that will not resolve is the inner surface's error to report,
      // with its per-strategy detail. Failing here would lose that.
    }

    const assessment = classifyRisk(action, control);
    const riskCheck = this.allowlist.checkRisk(assessment.risk, assessment.reason);
    if (!riskCheck.allowed) {
      const escalatable = assessment.risk === 'irreversible' && this.allowlist.config.allowEscalationForIrreversible;
      if (this.authorization) {
        const granted = this.authorization;
        this.authorization = undefined; // consumed
        this.emit({
          phase: 'pre-action',
          action: action.kind,
          target: targetLabel,
          decision: 'allow',
          risk: assessment.risk,
          reason: `irreversible action authorized by ${granted.grantedBy}: ${granted.reason}`,
        });
      } else if (escalatable) {
        this.emit({
          phase: 'pre-action',
          action: action.kind,
          target: targetLabel,
          decision: 'authorization-required',
          risk: assessment.risk,
          code: 'POLICY_AUTHORIZATION_REQUIRED',
          reason: assessment.reason,
        });
        return {
          ok: false,
          error: {
            code: 'POLICY_AUTHORIZATION_REQUIRED',
            message: `'${targetLabel ?? action.kind}' is irreversible and needs human authorization`,
            observed: assessment.reason,
          },
        };
      } else {
        return this.deny(action, targetLabel, riskCheck, assessment.risk);
      }
    } else {
      this.emit({
        phase: 'pre-action',
        action: action.kind,
        target: targetLabel,
        decision: 'allow',
        risk: assessment.risk,
        reason: assessment.reason,
      });
    }

    const result = await this.inner.perform(action);

    // Post-action egress check, across every document in the tree.
    //
    // Checking only the top document is the mistake worth naming, because it fails
    // silently in exactly the environment this system targets. On a frameset the top
    // document loads once and never navigates, so a click in the nav frame that
    // sends the body frame to a denied route leaves the top url untouched and the
    // check passes. Verified against the target app: the agent reached /admin.aspx,
    // a route on the deny list, and the gate allowed it.
    const { frameUrls, url: topUrl } = await this.inner.location();
    // Only real web navigations are egress. Everything else a frame url can hold is a
    // browser state, not a place the agent went.
    //
    // This distinction is load-bearing, and getting it wrong is worse than having no
    // check. A frame whose navigation stalls or fails is left on
    // `chrome-error://chromewebdata/`, which is not `about:` and not `blob:` -- so an
    // allowlist test that only skips those two reads a *failed page load* as an attempt
    // to escape, latches the session shut, and escalates. Observed exactly that on a
    // loaded machine: a click on a permitted menu link timed out, retried, and tripped
    // the guardrail. A slow load is a job for the checkpoint and the retry handler; the
    // policy latch is for the agent actually reaching a forbidden place.
    const candidates = [topUrl, ...frameUrls].filter((u) => /^https?:\/\//i.test(u));
    const offending = candidates.find((u) => !this.allowlist.checkUrl(u).allowed);
    const after = offending ? this.allowlist.checkUrl(offending) : { allowed: true as const };
    if (!after.allowed) {
      const url = offending!;
      this.tripped = { code: after.code, reason: `${after.reason} (reached ${url} after ${action.kind})` };
      this.emit({
        phase: 'post-action',
        action: action.kind,
        target: targetLabel,
        decision: 'deny',
        code: after.code,
        reason: this.tripped.reason,
      });
      return {
        ok: false,
        error: {
          code: 'POLICY_DENIED',
          message: `action landed outside the allowlist; session halted`,
          observed: this.tripped.reason,
        },
      };
    }

    return result;
  }

  private deny(action: Action, target: string | undefined, decision: Extract<PolicyDecision, { allowed: false }>, risk?: RiskClass): ActionResult {
    this.emit({
      phase: 'pre-action',
      action: action.kind,
      target,
      decision: 'deny',
      risk,
      code: decision.code,
      reason: decision.reason,
    });
    return { ok: false, error: { code: 'POLICY_DENIED', message: decision.reason, observed: decision.code } };
  }

  private emit(e: Omit<PolicyEvent, 'at'>): void {
    this.onEvent({ at: new Date().toISOString(), ...e });
  }
}
