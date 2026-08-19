/**
 * Deterministic replay: the production execution path.
 *
 * No LLM is constructed, imported, or reachable from this file. That is a
 * structural guarantee rather than a promise -- there is no model client in scope
 * to call. Everything the engine does comes from the artifact.
 *
 * How determinism is actually achieved, in order of how much each contributes:
 *
 *  1. **Conditions, not sleeps.** Every transition is gated on a declared
 *     Condition polled against fresh perception until its budget expires. There
 *     is no `sleep(n)` anywhere in the step loop. This is what makes replay
 *     insensitive to a slow day, and it is why "transient slowness" is a
 *     recoverable condition rather than a flake.
 *
 *  2. **Ordered semantic targeting with reported fallbacks.** The step says what
 *     it wants; resolution tries strategies in the recorded order and reports
 *     which one won. Same inputs against the same app produce the same
 *     resolutions, and a change in *which* strategy wins is surfaced as drift.
 *
 *  3. **Ambiguity fails.** A target matching two controls stops the run. The
 *     alternative -- picking one -- makes replay non-deterministic by design.
 *
 *  4. **Checkpoints after every state change.** A step that cannot verify its own
 *     effect cannot be distinguished from a step that did nothing.
 *
 * The error taxonomy is executed here in a fixed precedence, which matters
 * because several conditions can be true at once (a session-expiry page is also
 * "the checkpoint did not hold"):
 *
 *     step handlers  ->  capability interrupts  ->  hard failure
 *
 * Step handlers are the most specific statement of intent, so they win.
 * Interrupts are the cross-cutting conditions. Anything unclaimed is a hard
 * failure, deliberately: an undeclared condition is a gap in the capability, and
 * quietly continuing past it is how automation does something nobody asked for.
 */

import type {
  Capability,
  Condition,
  Handler,
  Step,
} from '../artifact/index-types.js';
import { capabilityDigest } from '../artifact/store.js';
import { effectiveCapability } from '../artifact/overlay.js';
import { toSurfaceAction } from '../artifact/schema.js';
import { describeTarget } from '../surface/matching.js';
import type { ActionResult, RiskClass, Surface, TargetDescriptor } from '../surface/types.js';
import { PlaywrightWebSurface } from '../surface/web/playwright-surface.js';
import { PolicyGate } from '../policy/gate.js';
import { ControlLease, LeaseGuard } from '../escalation/control.js';
import { InterventionBroker, type EscalationReason, type InterventionContext } from '../escalation/broker.js';
import { Redactor } from '../policy/redact.js';
import { SecretVault } from '../policy/vault.js';
import { RunLogger, newRunId } from '../evidence/logger.js';
import { baseRedactor } from '../policy/redact.js';
import {
  applyTransform,
  materialiseCondition,
  materialiseTarget,
  renderTemplate,
  renderUrlPattern,
  resolveValue,
  validateInputs,
  type InputValue,
} from './inputs.js';
import type {
  DriftSignal,
  RecoveryTrace,
  ReplayFailure,
  ReplayFailureCode,
  ReplayResult,
  StepTrace,
} from './outcome.js';

export interface ReplayOptions {
  /** Host of the target app for this environment. Kept out of the artifact. */
  baseUrl: string;
  /** Which institution this run is for. Selects the overlay. */
  tenantId?: string;
  /** Run a capability against a tenant it has no overlay for. Requires intent. */
  allowUnadapted?: boolean;
  /**
   * True when no human is watching. Tightens two things: a draft capability is
   * refused, and irreversible steps need `authorizeIrreversible`.
   */
  unattended?: boolean;
  /** Caller-side authorisation for the capability's irreversible steps. */
  authorizeIrreversible?: { by: string; reason: string };
  headless?: boolean;
  evidenceBaseDir?: string;
  vault?: SecretVault;
  /** Supplied by the host process so escalations land in a queue an operator is watching. */
  broker?: InterventionBroker;
  lease?: ControlLease;
  /** How long an escalation waits for a human before aborting. */
  escalationTimeoutMs?: number;
  /** Total recovery attempts across the whole run, so a loop cannot spin. */
  recoveryBudget?: number;
  /** Called once the live surface exists, so a host can attach an operator console. */
  onSurfaceReady?: (ctx: { surface: PlaywrightWebSurface; lease: ControlLease; broker: InterventionBroker; logger: RunLogger }) => Promise<void> | void;
}

interface StepOutcome {
  kind: 'continue' | 'business' | 'fail' | 'escalated-abort';
  business?: { code: string; observed?: string };
  failure?: ReplayFailure;
  intervention?: { id: string; reason: string; decision: string; operatorNote?: string; humanActionCount: number };
}

export async function replay(
  capabilityInput: Capability,
  providedInputs: Record<string, unknown>,
  opts: ReplayOptions,
): Promise<ReplayResult> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const runId = newRunId('replay');
  const warnings: string[] = [];
  const steps: StepTrace[] = [];
  const recoveries: RecoveryTrace[] = [];
  const drift: DriftSignal[] = [];
  const interventionIds: string[] = [];
  const outputs: Record<string, InputValue> = {};

  const vault = opts.vault ?? SecretVault.fromEnvironment();
  const digest = capabilityDigest(capabilityInput);

  // The logger is created before input validation, not after.
  //
  // A rejected invocation is exactly the kind of thing an audit wants to see -- "a
  // caller tried to run this capability against a malformed member id" is a real
  // event -- and a result that names an evidence directory which was never created
  // is worse than no directory at all. It starts with shape-only redaction and is
  // upgraded once the run's own sensitive values are known, which is what
  // `useRedactor` exists for. The run header deliberately carries no input values,
  // so nothing sensitive is written before the upgrade.
  const logger = await RunLogger.create({ kind: 'replay', runId, baseDir: opts.evidenceBaseDir, redactor: baseRedactor() });

  const envelope = () => ({
    runId,
    capability: { id: capabilityInput.id, version: capabilityInput.version, digest, lifecycleState: capabilityInput.lifecycle.state },
    tenantId: opts.tenantId ?? capabilityInput.target.recordedTenantId,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    steps,
    recoveries,
    drift,
    interventions: interventionIds,
    evidenceDir: `${opts.evidenceBaseDir ?? 'evidence/runs'}/${runId}`,
    warnings,
  });

  const earlyFailure = async (code: ReplayFailureCode, message: string, extra: Partial<ReplayFailure> = {}): Promise<ReplayResult> => {
    logger.event('replay.rejected', { code, message });
    await logger.finalize({ rejected: { code, message }, capability: { id: capabilityInput.id, version: capabilityInput.version } });
    return { ...envelope(), status: 'failed', failure: { code, message, ...extra }, outputs: {} };
  };

  // ------------------------------------------------------ pre-flight, no browser
  if (opts.unattended && capabilityInput.lifecycle.state !== 'approved') {
    return await earlyFailure(
      'NOT_APPROVED',
      `capability '${capabilityInput.id}@${capabilityInput.version}' is in state '${capabilityInput.lifecycle.state}'; unattended replay requires 'approved'`,
    );
  }

  let capability: Capability;
  let overlaySummary: ReplayResult['overlay'];
  try {
    const resolved = effectiveCapability(capabilityInput, opts.tenantId, { allowUnadapted: opts.allowUnadapted });
    capability = resolved.capability;
    if (resolved.warning) warnings.push(resolved.warning);
    if (resolved.audit) {
      overlaySummary = {
        tenantId: resolved.audit.tenantId,
        description: resolved.audit.description,
        labelRewrites: resolved.audit.labelRewrites.length,
        routeRewrites: resolved.audit.routeRewrites.length,
        stepsSkipped: resolved.audit.stepsSkipped,
      };
    }
  } catch (err) {
    return await earlyFailure('TENANT_NOT_SUPPORTED', message(err));
  }

  const validated = validateInputs(capability, providedInputs);
  if (!validated.ok) {
    return await earlyFailure('INVALID_INPUT', `inputs do not satisfy the capability contract:\n${validated.errors.map((e) => `  - ${e.message}`).join('\n')}`);
  }
  const { values: inputValues, sensitive } = validated.inputs;

  // Upgrade from shape-only redaction to redaction that knows this run's actual
  // sensitive values.
  const redactor = new Redactor({ secrets: vault.values(), labelled: sensitive });
  logger.useRedactor(redactor);

  const lease = opts.lease ?? new ControlLease();
  const broker =
    opts.broker ??
    new InterventionBroker(lease, { evidenceDir: logger.paths.dir, redactor, log: (t, d) => logger.event(t, d) });

  // Substitute {{input.x}} placeholders throughout the capability's targets and
  // conditions, once, before anything runs. Done as a whole-capability
  // transformation rather than per-step so the materialised artifact is a valid
  // capability in its own right -- the same property that keeps the engine ignorant
  // of overlays keeps it ignorant of templating.
  try {
    capability = materialiseCapability(capability, inputValues);
  } catch (err) {
    return await earlyFailure('INVALID_INPUT', message(err));
  }

  logger.event('replay.start', {
    capability: { id: capability.id, version: capability.version, digest, state: capability.lifecycle.state },
    tenantId: opts.tenantId ?? capability.target.recordedTenantId,
    overlay: overlaySummary,
    // Names only. Values are redacted anyway, but there is no reason to write them.
    inputsProvided: Object.keys(inputValues),
    unattended: Boolean(opts.unattended),
    baseUrl: opts.baseUrl,
  });

  let web: PlaywrightWebSurface | undefined;
  try {
    web = await PlaywrightWebSurface.launch({ headless: opts.headless ?? process.env.HEADLESS !== 'false' });

    const authorised = Boolean(opts.authorizeIrreversible);
    const effectiveCeiling =
      capability.policy.requiresApprovalForIrreversible && !authorised
        ? lowerOf(capability.policy.maxRisk, 'reversible')
        : capability.policy.maxRisk;
    logger.event('policy.ceiling', {
      declaredMaxRisk: capability.policy.maxRisk,
      effectiveMaxRisk: effectiveCeiling,
      authorised,
      requiresApprovalForIrreversible: capability.policy.requiresApprovalForIrreversible,
    });

    const gate = new PolicyGate(web, {
      allowlist: {
        allowedUrlPatterns: capability.policy.allowedUrlPatterns.map((p) => renderUrlPattern(p, opts.baseUrl)),
        allowedActions: capability.policy.allowedActions,
        // The ceiling is raised to the capability's declared max ONLY when the
        // caller has authorised this run. Otherwise it is held at 'reversible', so
        // the irreversible step trips the gate rather than sailing through.
        //
        // Setting the ceiling to the capability's own maxRisk unconditionally is the
        // subtle mistake here, and it is worth naming: a write capability declares
        // maxRisk 'irreversible' by definition, so the check passes for every run and
        // the approval requirement becomes decorative. The ceiling has to come from
        // what *this invocation* was permitted to do, not from what the capability is
        // capable of.
        maxRisk: effectiveCeiling,
        // Stopping at the step rather than at load time is deliberate: a read-only
        // prefix of a write capability still returns its outputs, and the caller
        // gets a precise "this step needs authorisation" instead of a flat refusal.
        allowEscalationForIrreversible: !opts.unattended || Boolean(opts.authorizeIrreversible),
      },
      onEvent: (e) => logger.event('policy', e as unknown as Record<string, unknown>),
    });
    if (opts.authorizeIrreversible) {
      logger.event('policy.preauthorized', opts.authorizeIrreversible);
    }
    const surface: Surface = new LeaseGuard(gate, lease);

    await opts.onSurfaceReady?.({ surface: web, lease, broker, logger });

    // ------------------------------------------------------------------ context
    const captured: Record<string, InputValue> = {};
    let recoveryBudget = opts.recoveryBudget ?? 8;

    const observeContext = async (): Promise<InterventionContext['location'] & { excerpt: string }> => {
      const loc = await surface.location();
      let excerpt = '';
      try {
        const obs = await surface.observe();
        excerpt = obs.text.slice(0, 700);
      } catch {
        excerpt = '(perception unavailable)';
      }
      return { ...loc, excerpt };
    };

    const escalate = async (args: {
      reason: EscalationReason;
      headline: string;
      detail: string;
      step?: { index: number; step: Step };
      attempt?: { action: string; expected?: string; observed?: string; errorCode?: string };
    }): Promise<{ decision: string; note?: string; humanActionCount: number; interventionId: string }> => {
      const evidence = await logger.captureFailureEvidence(surface, args.step ? `escalation-${args.step.step.id}` : 'escalation');
      const ctx = await observeContext();
      const item = broker.raise({
        reason: args.reason,
        headline: args.headline,
        detail: args.detail,
        context: {
          runId,
          runKind: 'replay',
          capability: { id: capability.id, version: capability.version, tenantId: opts.tenantId ?? capability.target.recordedTenantId },
          // The intent is materialised for the operator: the artifact stores
          // "look up member {{input.memberId}}", and a person reading an escalation
          // needs to know which member this run is actually about.
          ...(args.step
            ? { step: { index: args.step.index, id: args.step.step.id, intent: renderIntent(args.step.step.intent, inputValues) } }
            : {}),
          location: { url: ctx.url, title: ctx.title },
          visibleExcerpt: redactor.text(ctx.excerpt),
          evidence,
          ...(args.attempt ? { attempt: args.attempt } : {}),
        },
      });
      interventionIds.push(item.id);

      // The human is now driving. Their actions land on the intervention record.
      const recorder = web ? await attachRecorder(web, broker, item.id) : undefined;
      const resolution = await broker.waitForResolution(item.id, opts.escalationTimeoutMs ?? 15 * 60_000);
      recorder?.detach();

      if (resolution.decision === 'authorize-and-resume') {
        gate.authorizeNextIrreversible(resolution.by, resolution.note ?? 'authorised at the operator console');
      }
      if (gate.isTripped()) gate.resetAfterHumanReview(resolution.by);

      return { decision: resolution.decision, note: resolution.note, humanActionCount: resolution.humanActions.length, interventionId: item.id };
    };

    /**
     * Evaluate a handler list against current state. Single-shot (budget 0): the
     * point is to classify the state we are already in, not to wait for one.
     */
    const firstMatchingHandler = async (
      handlers: Handler[],
      context: { duringAuth: boolean } = { duringAuth: false },
    ): Promise<{ handler: Handler; observed: string } | undefined> => {
      for (const handler of handlers) {
        if (handler.notDuringAuth && context.duringAuth) continue;
        const r = await surface.evaluate(handler.when, { timeoutMs: 0 });
        if (r.satisfied) return { handler, observed: r.observed };
      }
      return undefined;
    };

    const authSteps = capability.steps.filter((s) => s.partOfAuth);

    // --------------------------------------------------------------- entry point
    const entryUrl = renderTemplate(capability.target.entryUrl, { baseUrl: opts.baseUrl, inputs: inputValues });

    // The recorder emits the entry navigation as step one, because the assertion
    // that the sign-on screen actually rendered is worth keeping as a checkpoint.
    // That makes a separate entry navigation here redundant -- and redundant
    // navigation is not free: it doubles the first page load and, on an app that
    // mutates on GET, would repeat whatever that mutation is.
    const firstStep = capability.steps[0];
    const firstStepIsEntry =
      firstStep?.action.kind === 'navigate' &&
      renderTemplate(firstStep.action.url, { baseUrl: opts.baseUrl, inputs: inputValues }) === entryUrl;

    const nav = firstStepIsEntry
      ? { ok: true as const }
      : await surface.perform({ kind: 'navigate', url: entryUrl });
    if (!nav.ok) {
      const evidence = await logger.captureFailureEvidence(surface, 'entry-navigation');
      return finish({
        ...envelope(),
        status: 'failed',
        failure: {
          code: nav.error?.code === 'POLICY_DENIED' ? 'POLICY_DENIED' : 'SURFACE_FAULT',
          message: `could not reach the entry point ${entryUrl}: ${nav.error?.message ?? 'unknown'}`,
          observed: nav.error?.observed,
          evidence,
        },
        outputs: {},
      });
    }
    logger.event('replay.entry', { entryUrl, navigatedBy: firstStepIsEntry ? 'step:' + firstStep!.id : 'engine' });

    // ------------------------------------------------------------------ step loop
    for (let index = 0; index < capability.steps.length; index++) {
      const step = capability.steps[index]!;
      const trace: StepTrace = {
        index,
        id: step.id,
        intent: step.intent,
        action: step.action.kind,
        risk: step.risk,
        status: 'ok',
        attempts: 0,
        durationMs: 0,
      };
      const targetDesc = 'target' in step.action ? describeTarget(step.action.target) : undefined;
      if (targetDesc) trace.target = targetDesc;
      const stepStart = Date.now();
      steps.push(trace);

      logger.event('step.start', { index, id: step.id, intent: step.intent, action: step.action.kind, target: targetDesc, risk: step.risk });

      // Interrupts before the step. Session expiry and app-error pages are not
      // properties of a particular step, and catching them here means the step
      // never runs against a screen that is not the one it expects.
      const interrupt = await firstMatchingHandler(capability.interrupts, { duringAuth: step.partOfAuth });
      if (interrupt) {
        const handled = await runHandler(interrupt.handler, interrupt.observed, { index, step }, 'interrupt');
        if (handled.kind !== 'continue') return finish(toResult(handled));
      }

      const outcome = await executeStep(step, index, trace);
      trace.durationMs = Date.now() - stepStart;
      logger.event('step.end', { index, id: step.id, status: trace.status, attempts: trace.attempts, durationMs: trace.durationMs, strategy: trace.strategy, checkpoint: trace.checkpoint, error: trace.error });

      if (outcome.kind !== 'continue') return finish(toResult(outcome));
    }

    // -------------------------------------------------------------- success gate
    const successCheck = await surface.evaluate(capability.success.checkpoint, { timeoutMs: 10_000 });
    logger.event('success.checkpoint', { description: capability.success.description, satisfied: successCheck.satisfied, observed: successCheck.observed });
    if (!successCheck.satisfied) {
      // Before calling this a failure, give the declared outcomes a chance: the
      // most common reason the success condition does not hold is that the app
      // legitimately said something else, and that is a business outcome.
      const late = await firstMatchingHandler(capability.interrupts);
      if (late) {
        const handled = await runHandler(late.handler, late.observed, undefined, 'interrupt');
        if (handled.kind !== 'continue') return finish(toResult(handled));
      }
      const evidence = await logger.captureFailureEvidence(surface, 'success-checkpoint');
      return finish({
        ...envelope(),
        status: 'failed',
        failure: {
          code: 'CHECKPOINT_FAILED',
          message: `every step completed but the capability's success condition did not hold`,
          expected: capability.success.description,
          observed: successCheck.observed,
          evidence,
        },
        outputs: { ...outputs },
      });
    }

    // Declared required outputs must actually be there. Returning a half-filled
    // result as a success would push this check onto every caller.
    const missing = capability.outputs.filter((o) => o.required && outputs[o.name] === undefined).map((o) => o.name);
    if (missing.length) {
      const evidence = await logger.captureFailureEvidence(surface, 'missing-outputs');
      return finish({
        ...envelope(),
        status: 'failed',
        failure: {
          code: 'OUTPUT_MISSING',
          message: `capability succeeded but required output(s) were never captured: ${missing.join(', ')}`,
          evidence,
        },
        outputs: { ...outputs },
      });
    }

    return finish({ ...envelope(), status: 'success', outputs: { ...outputs } });

    // =========================================================================
    // step execution
    // =========================================================================

    async function executeStep(step: Step, index: number, trace: StepTrace): Promise<StepOutcome> {
      let attempt = 0;
      const maxAttempts = 4; // hard ceiling; handlers declare their own lower budgets

      for (;;) {
        attempt++;
        trace.attempts = attempt;

        // Before *re*-attempting a step, check whether its effect is already
        // visible.
        //
        // This is a safety property, not an optimisation. A step can be
        // re-attempted after a recovery fired (an interstitial was dismissed, and
        // this application's notice page resubmits the request it interrupted) or
        // after a human did the work by hand. In both cases the state the step was
        // meant to produce may already exist, and blindly re-running it would
        // submit the same request twice. For a read that is wasteful; for
        // "Open Sub-Account" it opens two accounts.
        if (attempt > 1 && step.checkpoint) {
          const already = await surface.evaluate(step.checkpoint, { timeoutMs: 1500 });
          if (already.satisfied) {
            trace.status = 'satisfied-externally';
            trace.checkpoint = { satisfied: true, observed: already.observed };
            logger.event('step.alreadySatisfied', { stepId: step.id, attempt, observed: already.observed });
            return { kind: 'continue' };
          }
        }

        if (step.precondition) {
          const pre = await surface.evaluate(step.precondition, { timeoutMs: Math.min(step.timeoutMs, 8000) });
          if (!pre.satisfied) {
            const claimed = await claimFailure(step, index, trace, {
              code: 'PRECONDITION_FAILED',
              message: `precondition for step '${step.id}' did not hold`,
              observed: pre.observed,
            });
            if (claimed) return claimed.outcome;
            if (claimed === undefined) continue; // a handler recovered; retry
          }
        }

        // -------------------------------------------------------------- perform
        let result: ActionResult;
        try {
          result = await performStep(step);
        } catch (err) {
          const claimed = await claimFailure(step, index, trace, { code: 'INTERNAL', message: message(err) });
          if (claimed) return claimed.outcome;
          continue;
        }

        if (!result.ok) {
          const code = mapSurfaceError(result.error?.code);
          if (result.error?.code === 'POLICY_AUTHORIZATION_REQUIRED') {
            // An irreversible step with no standing authorisation is exactly the
            // case the human-in-the-loop path exists for.
            const decided = await escalate({
              reason: 'authorization-required',
              headline: `Authorise: ${step.intent}`,
              detail: `Step '${step.id}' is classified irreversible and needs a person to approve it before it runs.\n\n${result.error.observed ?? ''}`,
              step: { index, step },
              attempt: { action: `${step.action.kind} ${trace.target ?? ''}`.trim(), observed: result.error.observed, errorCode: result.error.code },
            });
            const routed = await applyDecision(decided, step, index, trace, {
              code: 'POLICY_DENIED',
              message: `irreversible step '${step.id}' was not authorised`,
              observed: result.error.observed,
            });
            if (routed.kind !== 'continue') return routed;
            if (trace.status === 'skipped' || trace.status === 'satisfied-externally') return { kind: 'continue' };
            continue;
          }

          const claimed = await claimFailure(step, index, trace, {
            code,
            message: result.error?.message ?? `step '${step.id}' failed`,
            expected: trace.target,
            observed: result.error?.observed,
          });
          if (claimed) return claimed.outcome;
          if (attempt >= maxAttempts) {
            return { kind: 'fail', failure: await hardFailure(step, index, { code: 'RECOVERY_EXHAUSTED', message: `step '${step.id}' failed ${attempt} times`, observed: result.error?.observed }) };
          }
          continue;
        }

        if (result.strategyUsed && result.strategyIndex !== undefined) {
          trace.strategy = { kind: result.strategyUsed.kind, index: result.strategyIndex };
          if (result.strategyIndex > 0 && 'target' in step.action) {
            const primary = step.action.target.strategies[0]!;
            drift.push({
              stepId: step.id,
              target: describeTarget(step.action.target),
              primaryStrategy: primary.kind,
              usedStrategy: result.strategyUsed.kind,
              usedIndex: result.strategyIndex,
            });
            logger.event('drift.fallback', { stepId: step.id, primary: primary.kind, used: result.strategyUsed.kind, index: result.strategyIndex });
          }
        }

        // -------------------------------------------------------------- capture
        if (step.captureAs && result.value !== undefined) {
          try {
            const value = applyTransform(result.value, step.transform);
            captured[step.captureAs] = value;
            outputs[step.captureAs] = value;
            const declared = capability.outputs.find((o) => o.name === step.captureAs);
            logger.event('step.captured', {
              name: step.captureAs,
              // A pii-tagged output is not written to the log even in redacted
              // form; the redactor would catch the value, but not writing it is
              // simpler to defend.
              value: declared && (declared.sensitivity === 'pii' || declared.sensitivity === 'secret') ? '[withheld]' : value,
              transform: step.transform?.kind ?? 'trim',
            });
          } catch (err) {
            const claimed = await claimFailure(step, index, trace, {
              code: 'CHECKPOINT_FAILED',
              message: `step '${step.id}' captured text that did not fit its declared transform: ${message(err)}`,
              observed: result.value,
            });
            if (claimed) return claimed.outcome;
            continue;
          }
        }

        // ----------------------------------------------------------- checkpoint
        if (step.checkpoint) {
          const cp = await surface.evaluate(step.checkpoint, { timeoutMs: step.timeoutMs });
          trace.checkpoint = { satisfied: cp.satisfied, observed: cp.observed };
          if (!cp.satisfied) {
            const claimed = await claimFailure(step, index, trace, {
              code: 'CHECKPOINT_FAILED',
              message: `step '${step.id}' ran but its checkpoint did not hold`,
              expected: describeCondition(step.checkpoint),
              observed: cp.observed,
            });
            if (claimed) return claimed.outcome;
            if (attempt >= maxAttempts) {
              return { kind: 'fail', failure: await hardFailure(step, index, { code: 'RECOVERY_EXHAUSTED', message: `checkpoint for '${step.id}' never held`, observed: cp.observed }) };
            }
            continue;
          }
        }

        if (attempt > 1 && trace.status === 'ok') trace.status = 'recovered';
        return { kind: 'continue' };
      }
    }

    async function performStep(step: Step): Promise<ActionResult> {
      if (step.action.kind === 'navigate') {
        return surface.perform({ kind: 'navigate', url: renderTemplate(step.action.url, { baseUrl: opts.baseUrl, inputs: inputValues }) });
      }
      if (step.action.kind === 'fill' || step.action.kind === 'select') {
        const { value, secret } = resolveValue(step.action.value, { inputs: inputValues, captured, vault });
        logger.event('step.value', { stepId: step.id, from: step.action.value.from, secret });
        return surface.perform(toSurfaceAction(step.action, value));
      }
      return surface.perform(toSurfaceAction(step.action));
    }

    /**
     * Give the declared handlers a chance to claim a failure.
     *
     * Returns:
     *   { outcome } - the failure was terminal, propagate it
     *   undefined   - a handler recovered; the caller should retry the step
     */
    async function claimFailure(
      step: Step,
      index: number,
      trace: StepTrace,
      failure: { code: ReplayFailureCode; message: string; expected?: string; observed?: string },
    ): Promise<{ outcome: StepOutcome } | undefined> {
      logger.event('step.failed', { stepId: step.id, ...failure });

      const stepHandler = await firstMatchingHandler(step.handlers);
      if (stepHandler) {
        const handled = await runHandler(stepHandler.handler, stepHandler.observed, { index, step }, 'step');
        if (handled.kind === 'continue') {
          trace.status = 'recovered';
          return undefined;
        }
        return { outcome: handled };
      }

      const interruptHandler = await firstMatchingHandler(capability.interrupts, { duringAuth: step.partOfAuth });
      if (interruptHandler) {
        const handled = await runHandler(interruptHandler.handler, interruptHandler.observed, { index, step }, 'interrupt');
        if (handled.kind === 'continue') {
          trace.status = 'recovered';
          return undefined;
        }
        return { outcome: handled };
      }

      // Nothing claimed it. Rather than fail immediately, offer it to a human --
      // this is the "replay hit a condition it cannot recover from" path.
      //
      // A denial for exceeding the risk ceiling is labelled for what it is. An
      // unattended run with no authorisation reaches this line rather than the
      // POLICY_AUTHORIZATION_REQUIRED branch above, and calling it "stuck" would
      // send an operator looking for a fault when what is actually needed is a
      // decision.
      const needsAuthorisation = failure.code === 'POLICY_DENIED' && (failure.observed ?? '').includes('RISK_EXCEEDS_CEILING');
      const decided = await escalate({
        reason: needsAuthorisation ? 'authorization-required' : 'unhandled-condition',
        headline: needsAuthorisation ? `Authorise: ${step.intent}` : `Replay stuck: ${step.intent}`,
        detail: needsAuthorisation
          ? `Step '${step.id}' is classified ${step.risk} and this run carries no authorisation for it.\n\n${failure.observed ?? ''}`
          : `Step '${step.id}' failed with ${failure.code} and no declared handler matched the current state.\n\nexpected: ${failure.expected ?? '(none)'}\nobserved: ${failure.observed ?? '(none)'}`,
        step: { index, step },
        attempt: { action: `${step.action.kind} ${trace.target ?? ''}`.trim(), expected: failure.expected, observed: failure.observed, errorCode: failure.code },
      });
      const routed = await applyDecision(decided, step, index, trace, failure);
      if (routed.kind === 'continue') {
        if (trace.status === 'skipped' || trace.status === 'satisfied-externally') return { outcome: { kind: 'continue' } };
        return undefined;
      }
      return { outcome: routed };
    }

    /** Turn an operator decision into control flow. */
    async function applyDecision(
      decided: { decision: string; note?: string; humanActionCount: number; interventionId: string },
      step: Step,
      index: number,
      trace: StepTrace,
      failure: { code: ReplayFailureCode; message: string; expected?: string; observed?: string },
    ): Promise<StepOutcome> {
      const interventionSummary = {
        id: decided.interventionId,
        reason: 'human-decision',
        decision: decided.decision,
        ...(decided.note ? { operatorNote: decided.note } : {}),
        humanActionCount: decided.humanActionCount,
      };

      if (decided.decision === 'abort') {
        trace.status = 'failed';
        trace.error = { code: failure.code, message: failure.message, ...(failure.observed ? { observed: failure.observed } : {}) };
        return {
          kind: 'escalated-abort',
          failure: await hardFailure(step, index, failure),
          intervention: interventionSummary,
        };
      }

      if (decided.decision === 'skip-step') {
        trace.status = 'skipped';
        logger.event('step.skipped', { stepId: step.id, by: 'operator', note: decided.note });
        return { kind: 'continue' };
      }

      // resume / authorize-and-resume. The human may already have done the work
      // by hand, so before re-attempting the step, check whether the state it was
      // supposed to produce is already there. Blindly retrying is how you submit
      // the same request twice.
      if (step.checkpoint) {
        const cp = await surface.evaluate(step.checkpoint, { timeoutMs: 3000 });
        if (cp.satisfied) {
          trace.status = 'satisfied-externally';
          trace.checkpoint = { satisfied: true, observed: cp.observed };
          logger.event('step.satisfiedByHuman', { stepId: step.id, observed: cp.observed, humanActionCount: decided.humanActionCount });
          return { kind: 'continue' };
        }
      }
      logger.event('step.resumingAfterHandoff', { stepId: step.id, decision: decided.decision, humanActionCount: decided.humanActionCount });
      return { kind: 'continue' };
    }

    /** Execute a declared handler action. */
    async function runHandler(
      handler: Handler,
      observed: string,
      at: { index: number; step: Step } | undefined,
      origin: 'step' | 'interrupt',
    ): Promise<StepOutcome> {
      const stepId = at?.step.id ?? '(pre-step)';
      logger.event('handler.matched', { handler: handler.name, origin, stepId, then: handler.then.do, observed });

      if (recoveryBudget <= 0 && handler.then.do !== 'outcome' && handler.then.do !== 'fail' && handler.then.do !== 'escalate') {
        return {
          kind: 'fail',
          failure: await hardFailure(at?.step, at?.index, {
            code: 'RECOVERY_EXHAUSTED',
            message: `run exhausted its recovery budget while handling '${handler.name}'`,
            observed,
          }),
        };
      }

      switch (handler.then.do) {
        case 'outcome':
          return { kind: 'business', business: { code: handler.then.code, observed } };

        case 'fail':
          return {
            kind: 'fail',
            failure: await hardFailure(at?.step, at?.index, {
              code: 'DECLARED_FAILURE',
              declaredCode: handler.then.code,
              message: handler.then.message,
              observed,
            }),
          };

        case 'escalate': {
          const decided = await escalate({
            reason: 'handler-requested',
            headline: `${handler.name}: ${handler.then.reason}`,
            detail: `Handler '${handler.name}' routed this run to a human.\n\nreason: ${handler.then.reason}\nobserved: ${observed}`,
            ...(at ? { step: at } : {}),
          });
          if (!at) {
            return decided.decision === 'abort'
              ? {
                  kind: 'escalated-abort',
                  failure: await hardFailure(undefined, undefined, { code: 'RECOVERY_EXHAUSTED', message: handler.then.reason, observed }),
                  intervention: { id: decided.interventionId, reason: 'handler-requested', decision: decided.decision, humanActionCount: decided.humanActionCount },
                }
              : { kind: 'continue' };
          }
          const traceForStep = steps.find((s) => s.id === at.step.id) ?? steps[steps.length - 1]!;
          return applyDecision(decided, at.step, at.index, traceForStep, { code: 'RECOVERY_EXHAUSTED', message: handler.then.reason, observed });
        }

        case 'dismiss': {
          recoveryBudget--;
          const click = await surface.perform({ kind: 'click', target: handler.then.target });
          recoveries.push({
            at: new Date().toISOString(),
            stepId,
            handler: handler.name,
            action: 'dismiss',
            attempt: 1,
            detail: click.ok ? `dismissed via ${describeTarget(handler.then.target)}` : `dismiss failed: ${click.error?.message}`,
          });
          logger.event('handler.dismiss', { handler: handler.name, ok: click.ok, target: describeTarget(handler.then.target), error: click.error });
          if (!click.ok) {
            return {
              kind: 'fail',
              failure: await hardFailure(at?.step, at?.index, {
                code: 'RECOVERY_EXHAUSTED',
                message: `handler '${handler.name}' could not dismiss ${describeTarget(handler.then.target)}`,
                observed: click.error?.observed,
              }),
            };
          }
          return { kind: 'continue' };
        }

        case 'retryStep': {
          recoveryBudget--;
          recoveries.push({ at: new Date().toISOString(), stepId, handler: handler.name, action: 'retryStep', attempt: 1, detail: `backing off ${handler.then.backoffMs}ms` });
          logger.event('handler.retry', { handler: handler.name, backoffMs: handler.then.backoffMs, stepId });
          // The one intentional wait in the engine, and it is a back-off rather
          // than a synchronisation primitive: the condition that follows still
          // has to hold before anything proceeds.
          await sleep(handler.then.backoffMs);
          return { kind: 'continue' };
        }

        case 'reauthenticate': {
          recoveryBudget--;
          logger.event('handler.reauthenticate', { handler: handler.name, authStepCount: authSteps.length, stepId });
          if (authSteps.length === 0) {
            return {
              kind: 'fail',
              failure: await hardFailure(at?.step, at?.index, {
                code: 'SESSION_LOST',
                message: `session expired but capability '${capability.id}' declares no steps marked partOfAuth, so it cannot re-authenticate`,
                observed,
              }),
            };
          }
          for (const authStep of authSteps) {
            const r = await performStep(authStep);
            if (!r.ok) {
              return {
                kind: 'fail',
                failure: await hardFailure(authStep, capability.steps.indexOf(authStep), {
                  code: 'SESSION_LOST',
                  message: `re-authentication failed at '${authStep.id}': ${r.error?.message ?? 'unknown'}`,
                  observed: r.error?.observed,
                }),
              };
            }
            if (authStep.checkpoint) {
              const cp = await surface.evaluate(authStep.checkpoint, { timeoutMs: authStep.timeoutMs });
              if (!cp.satisfied) {
                return {
                  kind: 'fail',
                  failure: await hardFailure(authStep, capability.steps.indexOf(authStep), {
                    code: 'SESSION_LOST',
                    message: `re-authentication step '${authStep.id}' did not reach its checkpoint`,
                    observed: cp.observed,
                  }),
                };
              }
            }
          }
          // Re-authenticating restores the *session*. It does not restore the
          // *screen*: signing back on lands on the console home page, while the
          // step that failed expects to be four screens in. Without repositioning,
          // every session-timeout recovery ends in TARGET_NOT_FOUND on the very
          // next attempt -- the recovery "succeeds" and the run fails anyway.
          //
          // So replay the navigational prefix as well. This is safe because of the
          // rule below, which is the important part: repositioning refuses to
          // re-run anything irreversible. Replaying a read-only path to get back
          // where we were is fine; replaying a submit would open a second
          // sub-account, and no recovery is worth that.
          const upto = at?.index ?? capability.steps.length;
          const repositioned: string[] = [];
          for (let i = 0; i < upto; i++) {
            const prior = capability.steps[i]!;
            if (prior.partOfAuth) continue;
            if (prior.risk === 'irreversible') {
              logger.event('handler.repositionRefused', { stepId: prior.id, risk: prior.risk });
              return {
                kind: 'fail',
                failure: await hardFailure(at?.step, at?.index, {
                  code: 'SESSION_LOST',
                  message:
                    `the session expired after step '${prior.id}', which is irreversible. Re-running it to restore position ` +
                    `could duplicate the action, so recovery stopped instead. This run needs a human to confirm what actually happened.`,
                  observed,
                }),
              };
            }
            const r = await performStep(prior);
            if (!r.ok) {
              return {
                kind: 'fail',
                failure: await hardFailure(prior, i, {
                  code: 'SESSION_LOST',
                  message: `re-authenticated, but could not restore position at '${prior.id}': ${r.error?.message ?? 'unknown'}`,
                  observed: r.error?.observed,
                }),
              };
            }
            if (prior.checkpoint) {
              const cp = await surface.evaluate(prior.checkpoint, { timeoutMs: prior.timeoutMs });
              if (!cp.satisfied) {
                return {
                  kind: 'fail',
                  failure: await hardFailure(prior, i, {
                    code: 'SESSION_LOST',
                    message: `re-authenticated, but step '${prior.id}' did not reach its checkpoint while restoring position`,
                    observed: cp.observed,
                  }),
                };
              }
            }
            // Re-capture on the way through, so an output read before the timeout
            // is not left holding a value from the dead session.
            if (prior.captureAs && r.value !== undefined) {
              try {
                const value = applyTransform(r.value, prior.transform);
                captured[prior.captureAs] = value;
                outputs[prior.captureAs] = value;
              } catch {
                /* the step's own retry path will report this */
              }
            }
            repositioned.push(prior.id);
          }

          recoveries.push({
            at: new Date().toISOString(),
            stepId,
            handler: handler.name,
            action: 'reauthenticate',
            attempt: 1,
            detail: `replayed ${authSteps.length} auth step(s)` + (repositioned.length ? `, then restored position through ${repositioned.join(', ')}` : ''),
          });
          logger.event('handler.reauthenticated', { authSteps: authSteps.map((a) => a.id), repositioned });
          return { kind: 'continue' };
        }
      }
    }

    async function hardFailure(
      step: Step | undefined,
      index: number | undefined,
      failure: { code: ReplayFailureCode; declaredCode?: string; message: string; expected?: string; observed?: string },
    ): Promise<ReplayFailure> {
      const evidence = await logger.captureFailureEvidence(surface, step ? `fail-${step.id}` : 'fail');
      const out: ReplayFailure = { code: failure.code, message: failure.message, evidence };
      if (failure.declaredCode) out.declaredCode = failure.declaredCode;
      if (failure.expected) out.expected = failure.expected;
      if (failure.observed) out.observed = failure.observed;
      if (step) {
        out.stepId = step.id;
        out.stepIntent = step.intent;
      }
      if (index !== undefined) out.stepIndex = index;
      const trace = step ? steps.find((s) => s.id === step.id) : undefined;
      if (trace) {
        trace.status = 'failed';
        trace.error = { code: failure.code, message: failure.message, ...(failure.observed ? { observed: failure.observed } : {}) };
      }
      logger.event('replay.hardFailure', { ...failure, stepId: step?.id, evidence });
      return out;
    }

    function toResult(outcome: StepOutcome): ReplayResult {
      const base = { ...envelope(), ...(overlaySummary ? { overlay: overlaySummary } : {}) };
      if (outcome.kind === 'business') {
        const declared = capability.outcomes.find((o) => o.code === outcome.business!.code);
        return {
          ...base,
          status: 'business_outcome',
          outcome: {
            code: outcome.business!.code,
            description: declared?.description ?? outcome.business!.code,
            retryable: declared?.retryable ?? false,
            ...(outcome.business!.observed ? { observed: outcome.business!.observed } : {}),
          },
          outputs: { ...outputs },
        };
      }
      if (outcome.kind === 'escalated-abort') {
        return { ...base, status: 'escalated', failure: outcome.failure!, intervention: outcome.intervention!, outputs: { ...outputs } };
      }
      return { ...base, status: 'failed', failure: outcome.failure!, outputs: { ...outputs } };
    }

    function finish(result: ReplayResult): ReplayResult {
      const withOverlay = overlaySummary ? { ...result, overlay: overlaySummary } : result;
      return withOverlay;
    }
  } catch (err) {
    logger.event('replay.crashed', { error: message(err) });
    return {
      ...envelope(),
      status: 'failed',
      failure: { code: 'INTERNAL', message: `replay crashed: ${message(err)}` },
      outputs: { ...outputs },
    };
  } finally {
    // The summary is written before the browser closes so a crash in teardown
    // cannot lose the record of what happened. (An early rejection has already
    // finalised and returned, so it never reaches here.)
    await logger.finalize({
      steps,
      recoveries,
      drift,
      interventions: interventionIds,
      warnings,
      outputKeys: Object.keys(outputs),
    });
    await web?.close();
  }
}

// ---------------------------------------------------------------------------

async function attachRecorder(web: PlaywrightWebSurface, broker: InterventionBroker, interventionId: string) {
  const { attachHumanActionRecorder } = await import('../escalation/human-recorder.js');
  try {
    return await attachHumanActionRecorder(web.livePage(), (action) => broker.recordHumanAction(interventionId, action));
  } catch {
    // A recorder that fails to attach must not block the handoff -- the human
    // still needs the session. The gap is visible in evidence as an intervention
    // with zero recorded actions.
    return undefined;
  }
}

/**
 * Resolve `{{input.x}}` placeholders in every target and condition of a capability.
 *
 * Values (`{ from: 'input' }`) are resolved at the moment a step runs, because a
 * secret must not sit resolved in memory any longer than necessary. Targets are
 * resolved up front, because they are not sensitive and because doing it once
 * guarantees a step and its checkpoint agree about which row they are talking
 * about.
 */
function materialiseCapability(cap: Capability, inputs: Record<string, InputValue>): Capability {
  const mapHandler = (h: Handler): Handler => ({
    ...h,
    when: materialiseCondition(h.when, inputs),
    then: h.then.do === 'dismiss' ? { ...h.then, target: materialiseTarget(h.then.target, inputs) } : h.then,
  });

  return {
    ...cap,
    interrupts: cap.interrupts.map(mapHandler),
    success: { ...cap.success, checkpoint: materialiseCondition(cap.success.checkpoint, inputs) },
    steps: cap.steps.map((step) => ({
      ...step,
      action: 'target' in step.action ? { ...step.action, target: materialiseTarget(step.action.target, inputs) } : step.action,
      ...(step.precondition ? { precondition: materialiseCondition(step.precondition, inputs) } : {}),
      ...(step.checkpoint ? { checkpoint: materialiseCondition(step.checkpoint, inputs) } : {}),
      handlers: step.handlers.map(mapHandler),
    })),
  };
}

/**
 * Substitute input values into an intent for display.
 *
 * Note this is for *operator-facing* text only. The stored artifact keeps the
 * placeholder, and the structured log records the artifact's version -- where the
 * redactor would scrub a materialised member id anyway.
 */
function renderIntent(intent: string, inputs: Record<string, InputValue>): string {
  return intent.replace(/\{\{\s*input\.([a-zA-Z0-9_]+)\s*\}\}/g, (m, name: string) => String(inputs[name] ?? m));
}

function lowerOf(a: RiskClass, b: RiskClass): RiskClass {
  const rank = (r: RiskClass) => (r === 'safe' ? 0 : r === 'reversible' ? 1 : 2);
  return rank(a) <= rank(b) ? a : b;
}

function mapSurfaceError(code: string | undefined): ReplayFailureCode {
  switch (code) {
    case 'TARGET_NOT_FOUND':
      return 'TARGET_NOT_FOUND';
    case 'TARGET_AMBIGUOUS':
      return 'TARGET_AMBIGUOUS';
    case 'TARGET_NOT_ACTIONABLE':
      return 'TARGET_NOT_FOUND';
    case 'CONDITION_TIMEOUT':
      return 'TIMEOUT';
    case 'POLICY_DENIED':
      return 'POLICY_DENIED';
    case 'SURFACE_FAULT':
      return 'SURFACE_FAULT';
    default:
      return 'INTERNAL';
  }
}

export function describeCondition(c: Condition): string {
  switch (c.kind) {
    case 'textPresent':
      return `text matching /${c.pattern}/ is present`;
    case 'textAbsent':
      return `text matching /${c.pattern}/ is absent`;
    case 'urlMatches':
      return `url matches /${c.pattern}/`;
    case 'controlPresent':
      return `${describeTarget(c.target as TargetDescriptor)} is present`;
    case 'controlAbsent':
      return `${describeTarget(c.target as TargetDescriptor)} is absent`;
    case 'valueMatches':
      return `${describeTarget(c.target as TargetDescriptor)} matches /${c.pattern}/`;
    case 'all':
      return `all of [${c.of.map(describeCondition).join('; ')}]`;
    case 'any':
      return `any of [${c.of.map(describeCondition).join('; ')}]`;
    case 'not':
      return `not (${describeCondition(c.of)})`;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message.split('\n')[0]! : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
