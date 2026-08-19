/**
 * Risk classification.
 *
 * Classification is done by this module, from the action and the control it
 * resolved to -- never by the model, and never taken from a field the model
 * wrote. A discovery agent that could label its own actions "safe" would make the
 * whole guardrail decorative.
 *
 * The heuristic is verb-based on the control's accessible name, which is the same
 * signal a human operator uses: a button that says "Submit Request" or "Post
 * Transfer" is doing something you cannot take back, and one that says "Search"
 * or "Cancel" is not. It is a heuristic, and its limits are stated in REPORT.md:
 * it is deliberately biased toward over-classifying, because the cost of
 * over-classifying is an escalation and the cost of under-classifying is an
 * unauthorised write to a member's account.
 */

import type { Action, PerceivedControl, RiskClass } from '../surface/types.js';

/** Names that indicate durable state change or money movement. */
const IRREVERSIBLE_VERBS = [
  'submit', 'confirm', 'post', 'transfer', 'send', 'pay', 'withdraw', 'deposit',
  'delete', 'remove', 'close', 'void', 'reverse', 'approve', 'authorize', 'authorise',
  'issue', 'disburse', 'charge', 'refund', 'wire', 'commit', 'finalize', 'finalise',
  'open account', 'create', 'save', 'apply', 'accept', 'sign off',
];

/** Names that look risky but are not. Checked before the list above. */
const BENIGN_OVERRIDES = ['search', 'find', 'cancel', 'back', 'close window', 'reset', 'clear', 'refresh', 'continue', 'next', 'i acknowledge', 'sign on'];

export interface RiskAssessment {
  risk: RiskClass;
  /** Quoted into policy denials and into the artifact review. */
  reason: string;
}

export function classifyRisk(action: Action, control?: PerceivedControl): RiskAssessment {
  switch (action.kind) {
    case 'readText':
    case 'waitFor':
    case 'assert':
      return { risk: 'safe', reason: `${action.kind} does not change application state` };

    case 'navigate':
      // A GET to a listing screen is safe; a legacy app that mutates on GET is
      // not something we can detect from here, which is why the allowlist
      // constrains routes independently of this classification.
      return { risk: 'safe', reason: 'navigation to an allowlisted route' };

    case 'fill':
    case 'select':
      return { risk: 'reversible', reason: `entering data into '${control?.name ?? action.target.description}' changes form state only` };

    case 'press':
      // Enter in a focused form is a submit in disguise. Treated as irreversible
      // unless the key is plainly navigational.
      return /^(tab|escape|arrow|page|home|end)/i.test(action.key)
        ? { risk: 'safe', reason: `'${action.key}' is a navigation key` }
        : { risk: 'irreversible', reason: `'${action.key}' may submit the focused form; treated conservatively` };

    case 'click': {
      const name = (control?.name ?? action.target.description).toLowerCase();
      const benign = BENIGN_OVERRIDES.find((v) => name === v || name.startsWith(`${v} `) || name.endsWith(` ${v}`));
      if (benign) return { risk: 'safe', reason: `control named '${control?.name ?? name}' is a known-benign '${benign}' control` };

      const verb = IRREVERSIBLE_VERBS.find((v) => name.includes(v));
      if (verb) {
        return { risk: 'irreversible', reason: `control named '${control?.name ?? name}' contains '${verb}', which indicates durable state change` };
      }
      if (control?.role === 'link') return { risk: 'safe', reason: `link '${control.name}' navigates` };
      if (control?.role === 'button') {
        return { risk: 'reversible', reason: `button '${control.name}' has no state-changing verb in its name; treated as reversible` };
      }
      return { risk: 'reversible', reason: `click on '${name}' could not be classified more precisely; defaulting to reversible` };
    }
  }
}

export function riskRank(r: RiskClass): number {
  return r === 'safe' ? 0 : r === 'reversible' ? 1 : 2;
}

export function atMost(actual: RiskClass, ceiling: RiskClass): boolean {
  return riskRank(actual) <= riskRank(ceiling);
}
