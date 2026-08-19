/**
 * The replay result contract.
 *
 * This is the type a production AI agent programs against, so the shape of it is
 * a product decision, not a detail. The single most important thing it does is
 * make the three-way split explicit in the type system:
 *
 *   status: 'success'          -> the goal was achieved; `outputs` is populated
 *   status: 'business_outcome' -> the app gave a legitimate answer that is not
 *                                 success. "No such member." Not an error.
 *   status: 'failed'           -> something is wrong with the automation, the app,
 *                                 or the environment. A human should look.
 *   status: 'escalated'        -> a human was brought in and chose to stop.
 *
 * Conflating the first two is the mistake the brief calls out, and it is a
 * mistake with real consequences: an agent that receives an exception for "no
 * such member" will retry it, alert on it, or tell the member something false.
 * An agent that receives `{ status: 'business_outcome', code: 'MEMBER_NOT_FOUND' }`
 * can say "I couldn't find that member" and move on.
 *
 * Recoverable conditions deliberately have no status of their own. By the time a
 * result exists they have already been handled, and they appear in `recoveries`
 * as things that happened rather than things the caller must react to. Surfacing
 * them as a status would push the retry logic back onto every caller, which is
 * precisely what this layer exists to absorb.
 */

import type { RiskClass, TargetStrategy } from '../surface/types.js';

export type ReplayStepStatus =
  | 'ok'
  /** Succeeded, but only after a declared recovery fired. */
  | 'recovered'
  /** Skipped by an overlay or by an operator decision. */
  | 'skipped'
  /** The state it was meant to produce already held -- typically after a human handoff. */
  | 'satisfied-externally'
  | 'failed';

export interface StepTrace {
  index: number;
  id: string;
  intent: string;
  action: string;
  target?: string;
  risk: RiskClass;
  status: ReplayStepStatus;
  attempts: number;
  durationMs: number;
  /** Which locator strategy won, and how far down the fallback list it was. */
  strategy?: { kind: TargetStrategy['kind']; index: number };
  checkpoint?: { satisfied: boolean; observed: string };
  error?: { code: string; message: string; observed?: string };
}

export interface RecoveryTrace {
  at: string;
  stepId: string;
  handler: string;
  /** What the handler did. */
  action: 'dismiss' | 'retryStep' | 'reauthenticate';
  attempt: number;
  detail: string;
}

/**
 * Locator drift signal.
 *
 * Every time replay has to fall back past the primary strategy it is recorded
 * here. On a stable UI this list is empty. A capability that starts producing
 * entries is telling you the app changed before anything has actually broken,
 * which is the only cheap moment to fix it.
 */
export interface DriftSignal {
  stepId: string;
  target: string;
  primaryStrategy: TargetStrategy['kind'];
  usedStrategy: TargetStrategy['kind'];
  usedIndex: number;
}

export type ReplayFailureCode =
  /** Inputs did not satisfy the declared contract. Detected before the browser starts. */
  | 'INVALID_INPUT'
  /** Unattended replay of a capability that is not approved. */
  | 'NOT_APPROVED'
  /** No overlay for the requested tenant and adaptation was not waived. */
  | 'TENANT_NOT_SUPPORTED'
  /** A target could not be resolved by any strategy. */
  | 'TARGET_NOT_FOUND'
  /** A target resolved to more than one control. */
  | 'TARGET_AMBIGUOUS'
  /** A checkpoint or success condition did not hold. */
  | 'CHECKPOINT_FAILED'
  /** A precondition did not hold before the step ran. */
  | 'PRECONDITION_FAILED'
  /** A wait never became true. */
  | 'TIMEOUT'
  /** The app returned an error page. */
  | 'APP_ERROR'
  /** The session expired and re-authentication was not possible or not permitted. */
  | 'SESSION_LOST'
  /** Blocked by the allowlist or the risk ceiling. */
  | 'POLICY_DENIED'
  /** Recovery handlers ran out of attempts. */
  | 'RECOVERY_EXHAUSTED'
  /** A declared handler asked to fail with its own code -- carried in `declaredCode`. */
  | 'DECLARED_FAILURE'
  /** The driver or the browser broke. */
  | 'SURFACE_FAULT'
  /** A required declared output was never captured. */
  | 'OUTPUT_MISSING'
  /** Anything unclassified. Should be rare, and each occurrence is a bug in the taxonomy. */
  | 'INTERNAL';

export interface ReplayFailure {
  code: ReplayFailureCode;
  /** Set when the failure came from a handler's `fail` action. */
  declaredCode?: string;
  message: string;
  stepId?: string;
  stepIntent?: string;
  stepIndex?: number;
  /** What the step was asserting. */
  expected?: string;
  /** What was actually there. Quoting both is what makes a failure debuggable. */
  observed?: string;
  evidence?: { screenshot?: string; snapshot?: string };
}

export interface ReplayEnvelope {
  runId: string;
  capability: { id: string; version: string; digest: string; lifecycleState: string };
  tenantId: string;
  /** Populated when an overlay was applied. */
  overlay?: { tenantId: string; description: string; labelRewrites: number; routeRewrites: number; stepsSkipped: string[] };
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  steps: StepTrace[];
  recoveries: RecoveryTrace[];
  drift: DriftSignal[];
  interventions: string[];
  evidenceDir: string;
  /** Non-fatal notes, e.g. an unadapted tenant run that was explicitly waived. */
  warnings: string[];
}

export type ReplayResult = ReplayEnvelope &
  (
    | { status: 'success'; outputs: Record<string, string | number | boolean> }
    | {
        status: 'business_outcome';
        outcome: { code: string; description: string; retryable: boolean; observed?: string };
        /** Outputs captured before the outcome was detected. Often useful. */
        outputs: Record<string, string | number | boolean>;
      }
    | { status: 'failed'; failure: ReplayFailure; outputs: Record<string, string | number | boolean> }
    | {
        status: 'escalated';
        failure: ReplayFailure;
        intervention: { id: string; reason: string; decision: string; operatorNote?: string; humanActionCount: number };
        outputs: Record<string, string | number | boolean>;
      }
  );

/** Compact one-line summary for a CLI or a log line. */
export function summarizeResult(r: ReplayResult): string {
  switch (r.status) {
    case 'success':
      return `SUCCESS  ${r.capability.id}@${r.capability.version}  outputs=${JSON.stringify(r.outputs)}  ${r.durationMs}ms`;
    case 'business_outcome':
      return `OUTCOME  ${r.outcome.code}  ${r.outcome.description}  ${r.durationMs}ms`;
    case 'failed':
      return `FAILED   ${r.failure.code}${r.failure.declaredCode ? `/${r.failure.declaredCode}` : ''}  at step ${r.failure.stepId ?? '-'}  ${r.failure.message}`;
    case 'escalated':
      return `ESCALATED ${r.intervention.reason} -> ${r.intervention.decision}  at step ${r.failure.stepId ?? '-'}`;
  }
}
