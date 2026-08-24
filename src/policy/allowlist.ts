/**
 * The allowlist.
 *
 * Two rules that are easy to get wrong:
 *
 *  1. **Deny wins.** A URL matching both an allow and a deny pattern is denied.
 *     Anything else makes the deny list advisory.
 *
 *  2. **Checked after the action too, not only before.** A pre-flight check on a
 *     click cannot know where the click will land, and legacy apps redirect
 *     constantly. So the gate re-checks the location after every action, and a
 *     violation there latches the session closed rather than letting the run
 *     continue from a place it was never allowed to reach.
 */

import type { ActionKind, RiskClass } from '../surface/types.js';
import { escapeRegExp } from '../util/regex.js';

export interface AllowlistConfig {
  /** Regex sources, matched case-insensitively against the full URL. */
  allowedUrlPatterns: string[];
  /** Takes precedence over allowedUrlPatterns. */
  deniedUrlPatterns?: string[];
  allowedActions: ActionKind[];
  maxRisk: RiskClass;
  /**
   * When false, an irreversible action is refused outright rather than escalated.
   * Discovery sets this true (a human can authorize in the moment); unattended
   * replay of a draft capability sets it false.
   */
  allowEscalationForIrreversible?: boolean;
}

export type PolicyDecision =
  | { allowed: true }
  | {
      allowed: false;
      code: 'URL_NOT_ALLOWED' | 'URL_DENIED' | 'ACTION_NOT_ALLOWED' | 'RISK_EXCEEDS_CEILING';
      reason: string;
    };

export class Allowlist {
  private allow: RegExp[];
  private deny: RegExp[];

  constructor(readonly config: AllowlistConfig) {
    this.allow = compile(config.allowedUrlPatterns, 'allowedUrlPatterns');
    this.deny = compile(config.deniedUrlPatterns ?? [], 'deniedUrlPatterns');
    if (this.allow.length === 0) {
      // An empty allowlist that allowed everything would be the worst possible
      // default for this system.
      throw new Error('allowlist must declare at least one allowed URL pattern');
    }
  }

  checkUrl(url: string): PolicyDecision {
    const denied = this.deny.find((re) => re.test(url));
    if (denied) return { allowed: false, code: 'URL_DENIED', reason: `url matches deny pattern /${denied.source}/` };
    if (!this.allow.some((re) => re.test(url))) {
      return {
        allowed: false,
        code: 'URL_NOT_ALLOWED',
        reason: `url is outside the allowlist (${this.allow.map((r) => `/${r.source}/`).join(', ')})`,
      };
    }
    return { allowed: true };
  }

  checkAction(kind: ActionKind): PolicyDecision {
    return this.config.allowedActions.includes(kind)
      ? { allowed: true }
      : { allowed: false, code: 'ACTION_NOT_ALLOWED', reason: `action '${kind}' is not permitted (allowed: ${this.config.allowedActions.join(', ')})` };
  }

  checkRisk(risk: RiskClass, reason: string): PolicyDecision {
    const rank = (r: RiskClass) => (r === 'safe' ? 0 : r === 'reversible' ? 1 : 2);
    return rank(risk) <= rank(this.config.maxRisk)
      ? { allowed: true }
      : { allowed: false, code: 'RISK_EXCEEDS_CEILING', reason: `${reason}; risk '${risk}' exceeds ceiling '${this.config.maxRisk}'` };
  }

  describe(): AllowlistConfig {
    return this.config;
  }
}

function compile(patterns: string[], where: string): RegExp[] {
  return patterns.map((p) => {
    try {
      return new RegExp(p, 'i');
    } catch (err) {
      throw new Error(`${where} contains an invalid regex /${p}/: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

/**
 * Sensible ceiling for a discovery run: the model may explore and fill forms, but
 * the moment it reaches for something irreversible the run stops and a human
 * decides. Discovery is exactly when you do not yet know what a control does.
 */
export function discoveryAllowlist(baseUrl: string): AllowlistConfig {
  const host = escapeRegExp(baseUrl.replace(/\/$/, ''));
  return {
    allowedUrlPatterns: [`^${host}/`],
    // Real institutions have screens the automation account should never touch
    // even though it can reach them. Encoded here rather than left to the model
    // noticing that "General Ledger" is out of scope.
    deniedUrlPatterns: ['/admin\\.aspx', '/gl\\.aspx'],
    allowedActions: ['navigate', 'click', 'fill', 'select', 'readText', 'waitFor', 'assert'],
    maxRisk: 'reversible',
    allowEscalationForIrreversible: true,
  };
}

