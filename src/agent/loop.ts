/**
 * The discovery loop: observe -> decide -> act, until the goal is met or a
 * stopping condition fires.
 *
 * The loop owns three things the model does not get a say in:
 *
 *  1. **Translation of intent into a durable target.** The model returns a ref;
 *     the loop looks it up in its own perception and builds the TargetDescriptor.
 *     A ref from a stale observation is rejected with a message the model can act
 *     on rather than silently resolved against whatever now occupies that slot.
 *
 *  2. **Stopping.** Max turns, a wall-clock budget, and a stall detector that
 *     notices the same action being retried against an unchanged screen. Without
 *     the last one, a model that cannot find a control will keep clicking a
 *     plausible substitute, and every one of those clicks becomes a step in the
 *     recording.
 *
 *  3. **Recording.** Every action that succeeds is appended with the before/after
 *     state needed to synthesise a checkpoint later. The recording is a
 *     consequence of the run rather than something the model is asked to produce,
 *     which is why a run cannot end with a plausible-looking artifact that does
 *     not match what happened.
 *
 * Policy and the control lease sit underneath, as Surface decorators, so a
 * discovery run is subject to exactly the same guardrails as a replay. The one
 * difference is the risk ceiling: discovery may escalate an irreversible action to
 * a human, because discovery is precisely the moment when nobody yet knows what a
 * given button does.
 */

import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LlmMessage, LlmProvider, LlmToolCall } from './llm/provider.js';
import { TOOL_NAMES, discoveryTools } from './tools.js';
import { renderObservation, systemPrompt } from './prompts.js';
import { compileCapability, looksLikeData, type CompileInput, type RecordedStep } from './recorder.js';
import type { Capability } from '../artifact/schema.js';
import type { StepAction, TargetDescriptor } from '../artifact/index-types.js';
import type { Action, Observation, PerceivedControl, RiskClass, Surface } from '../surface/types.js';
import { classifyRisk } from '../policy/risk.js';
import { PolicyGate } from '../policy/gate.js';
import { discoveryAllowlist } from '../policy/allowlist.js';
import { ControlLease, LeaseGuard } from '../escalation/control.js';
import { InterventionBroker } from '../escalation/broker.js';
import { PlaywrightWebSurface } from '../surface/web/playwright-surface.js';
import { RunLogger, newRunId } from '../evidence/logger.js';
import { Redactor } from '../policy/redact.js';
import { SecretVault } from '../policy/vault.js';

export interface DiscoveryParameter {
  name: string;
  value: string;
  type: 'string' | 'number' | 'money';
  description: string;
  sensitivity: 'public' | 'internal' | 'pii';
  /** Optional format constraint, enforced before replay launches a browser. */
  pattern?: string;
}

export interface DiscoveryOptions {
  goal: string;
  baseUrl: string;
  entryUrl: string;
  appDescription: string;
  productId: string;
  productVersion?: string;
  tenantId: string;
  capabilityId: string;
  parameters: DiscoveryParameter[];
  expectedOutputs: string[];
  provider: LlmProvider;
  maxSteps?: number;
  maxWallClockMs?: number;
  headless?: boolean;
  evidenceBaseDir?: string;
  vault?: SecretVault;
  recordedBy?: string;
  escalationTimeoutMs?: number;
  onSurfaceReady?: (ctx: {
    surface: PlaywrightWebSurface;
    lease: ControlLease;
    broker: InterventionBroker;
    logger: RunLogger;
  }) => Promise<void> | void;
}

export type DiscoveryResult =
  | { status: 'success'; capability: Capability; runId: string; evidenceDir: string; turns: number; steps: number }
  | { status: 'escalated'; runId: string; evidenceDir: string; reason: string; interventionId: string; decision: string; turns: number }
  | { status: 'failed'; runId: string; evidenceDir: string; reason: string; turns: number };

export async function discover(opts: DiscoveryOptions): Promise<DiscoveryResult> {
  const runId = newRunId('discovery');
  const maxSteps = opts.maxSteps ?? 24;
  const maxWallClockMs = opts.maxWallClockMs ?? 5 * 60_000;
  const deadline = Date.now() + maxWallClockMs;
  const vault = opts.vault ?? SecretVault.fromEnvironment();

  const redactor = new Redactor({
    secrets: vault.values(),
    labelled: Object.fromEntries(opts.parameters.filter((p) => p.sensitivity === 'pii').map((p) => [p.name, p.value])),
  });

  const logger = await RunLogger.create({ kind: 'discovery', runId, baseDir: opts.evidenceBaseDir, redactor });
  const lease = new ControlLease();
  const broker = new InterventionBroker(lease, { evidenceDir: logger.paths.dir, redactor, log: (t, d) => logger.event(t, d) });

  const recorded: RecordedStep[] = [];
  const transcript: { model: string; turns: { index: number; text?: string; toolCalls: LlmToolCall[] }[] } = {
    model: opts.provider.id,
    turns: [],
  };
  let humanInterventions = 0;
  let turns = 0;

  const evidenceDir = logger.paths.dir;
  const fail = (reason: string): DiscoveryResult => ({ status: 'failed', runId, evidenceDir, reason, turns });

  logger.event('discovery.start', {
    goal: opts.goal,
    baseUrl: opts.baseUrl,
    productId: opts.productId,
    tenantId: opts.tenantId,
    model: opts.provider.id,
    maxSteps,
    parameterNames: opts.parameters.map((p) => p.name),
    secretsAvailable: vault.names(),
  });

  let web: PlaywrightWebSurface | undefined;
  try {
    web = await PlaywrightWebSurface.launch({ headless: opts.headless ?? process.env.HEADLESS !== 'false' });

    const gate = new PolicyGate(web, {
      allowlist: discoveryAllowlist(opts.baseUrl),
      onEvent: (e) => logger.event('policy', e as unknown as Record<string, unknown>),
    });
    const surface: Surface = new LeaseGuard(gate, lease);
    await opts.onSurfaceReady?.({ surface: web, lease, broker, logger });

    // ------------------------------------------------------------- entry point
    const nav = await surface.perform({ kind: 'navigate', url: opts.entryUrl });
    if (!nav.ok) return fail(`could not open the entry point ${opts.entryUrl}: ${nav.error?.message}`);
    let observation = await surface.observe();
    recorded.push({
      intent: 'Open the servicing console entry screen',
      action: { kind: 'navigate', url: opts.entryUrl },
      risk: 'safe',
      textBefore: '',
      textAfter: observation.text,
      urlAfter: observation.url,
      contentUrlAfter: observation.url,
      headingsBefore: [],
      headingsAfter: structuralHeadings(observation),
      usedSecret: false,
    });
    logger.event('discovery.entry', { entryUrl: opts.entryUrl, controls: observation.controls.length });

    // -------------------------------------------------------------------- loop
    const tools = discoveryTools({
      secretNames: vault.names(),
      outputNames: opts.expectedOutputs,
      inputNames: opts.parameters.map((p) => p.name),
    });
    const system = systemPrompt({
      goal: opts.goal,
      appDescription: opts.appDescription,
      baseUrl: opts.baseUrl,
      secretNames: vault.names(),
      parameters: opts.parameters.map((p) => ({ name: p.name, value: p.value })),
      expectedOutputs: opts.expectedOutputs,
      maxSteps,
    });
    const messages: LlmMessage[] = [];
    /**
     * Indices of the messages that carry an observation.
     *
     * A computer-use loop resends its whole history every turn, and an observation
     * of a legacy screen is the largest thing in it. Left alone, token use grows
     * quadratically in the number of steps: the run gets slower and more expensive
     * with every action, and on a token-per-minute limit it simply stops. Since the
     * model only ever acts on the *latest* observation -- refs from older ones are
     * rejected by design -- the older ones can be replaced with a stub without
     * removing anything it is allowed to use.
     */
    const observationIndices: number[] = [];
    const OBSERVATIONS_KEPT_IN_FULL = 1;

    const pushObservation = (obs: Observation, note?: string): void => {
      observationIndices.push(messages.length);
      messages.push({ role: 'user', content: renderObservation(note ? { ...obs, note } : obs) });
    };

    /** Replace all but the most recent observations with a one-line placeholder. */
    const pruneObservations = (): void => {
      const stale = observationIndices.slice(0, Math.max(0, observationIndices.length - OBSERVATIONS_KEPT_IN_FULL));
      for (const index of stale) {
        const message = messages[index];
        if (message?.role === 'user' && !message.content.startsWith('[earlier observation')) {
          messages[index] = { role: 'user', content: '[earlier observation omitted to keep the context small; act on the most recent one]' };
        }
      }
    };

    pushObservation(observation);

    /** Fingerprint of (screen, intended action), for stall detection. */
    const attemptFingerprints = new Map<string, number>();
    let successText: string | undefined;
    let summary: string | undefined;

    while (turns < maxSteps) {
      if (Date.now() > deadline) {
        logger.event('discovery.timeout', { maxWallClockMs, turns });
        return fail(`wall-clock budget of ${maxWallClockMs}ms exhausted after ${turns} turns`);
      }
      turns++;
      pruneObservations();

      const response = await opts.provider.complete({ system, messages, tools, temperature: 0 });
      // Tool calls are parameterised on the way into the transcript, not redacted.
      //
      // Both keep member data out of a committed file, but they are not equivalent:
      // a redacted transcript is unreplayable, because replaying it types the literal
      // string "[pii:memberId]" into the search field and every subsequent turn
      // diverges. Substituting the placeholder instead keeps the transcript safe to
      // commit *and* usable as a regression harness for this loop.
      transcript.turns.push({
        index: turns,
        ...(response.text ? { text: parameteriseText(response.text, opts.parameters) } : {}),
        toolCalls: response.toolCalls.map((tc) => ({ ...tc, args: parameteriseArgs(tc.args, opts.parameters) })),
      });
      logger.event('model.turn', {
        turn: turns,
        model: response.model,
        // The model's prose is kept (redacted): it is the record of *why* the
        // capability looks the way it does, and it is what a reviewer reads when
        // an artifact surprises them.
        text: response.text,
        toolCalls: response.toolCalls.map((tc) => ({ name: tc.name, args: tc.args })),
        usage: response.usage,
      });

      const call = response.toolCalls[0];
      if (!call) {
        messages.push({ role: 'assistant', content: response.text ?? '' });
        messages.push({
          role: 'user',
          content: 'You must call exactly one tool. Choose an action, or call request_human_help if you are stuck.',
        });
        continue;
      }
      messages.push({ role: 'assistant', ...(response.text ? { content: response.text } : {}), toolCalls: [call] });
      const reply = (content: string) => messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content });

      // ------------------------------------------------------- terminal tools
      if (call.name === TOOL_NAMES.finish) {
        const claimedText = resolveParameterPlaceholders(String(call.args.successText ?? '').trim(), opts.parameters);
        summary = String(call.args.summary ?? '').trim();
        if (!claimedText) {
          reply('finish_goal requires successText: a distinctive phrase visible on the current screen that proves the goal was reached.');
          continue;
        }
        const verify = await surface.evaluate({ kind: 'textPresent', pattern: escapeRegExp(claimedText) }, { timeoutMs: 3000 });
        logger.event('discovery.finishClaimed', { successText: claimedText, verified: verify.satisfied, observed: verify.observed });
        if (!verify.satisfied) {
          // The model's claim of completion is checked against the screen rather
          // than believed. This is what stops a confident, wrong artifact being
          // written.
          reply(`That phrase is not on the current screen (${verify.observed}). Either finish the task or quote a phrase that is actually visible.`);
          continue;
        }
        if (looksLikeData(claimedText)) {
          // A model asked for "a distinctive phrase that proves the goal" will
          // reach for the most distinctive thing on screen, which is the member's
          // own data. That produces a capability whose success condition only ever
          // holds for the member it was recorded with -- and puts member data in the
          // artifact. Same test the recorder uses for checkpoints.
          logger.event('discovery.finishRejected', { successText: claimedText, reason: 'contains record-time data' });
          reply(
            `"${claimedText}" contains data specific to this member (a number, an amount, or a name), so it would only ever ` +
              'match this one record. Quote a phrase that is part of the screen itself -- a heading or a section title -- ' +
              'that would be present for any member.',
          );
          continue;
        }
        successText = claimedText;
        break;
      }

      if (call.name === TOOL_NAMES.escalate) {
        const reason = String(call.args.reason ?? 'the agent reported it was stuck');
        const decided = await raiseIntervention('discovery-stuck', `Discovery stuck: ${truncate(reason, 60)}`, reason);
        humanInterventions++;
        if (decided.decision === 'abort') {
          return { status: 'escalated', runId, evidenceDir, reason, interventionId: decided.id, decision: decided.decision, turns };
        }
        observation = await surface.observe();
        reply(
          `A human operator took over the live session and chose '${decided.decision}'${decided.note ? ` with the note: ${decided.note}` : ''}. ` +
            `They performed ${decided.humanActionCount} action(s). Continue from the current screen.`,
        );
        pushObservation(observation, 'state after human intervention');
        continue;
      }

      // -------------------------------------------------------- acting tools
      const before = observation;
      const built = buildAction(call, before, vault.names(), opts.parameters);
      if ('error' in built) {
        logger.event('model.invalidCall', { turn: turns, tool: call.name, error: built.error });
        reply(built.error);
        continue;
      }

      const fingerprint = createHash('sha256')
        .update(`${hashText(before.text)}|${call.name}|${JSON.stringify(built.fingerprint)}`)
        .digest('hex')
        .slice(0, 16);
      const seen = (attemptFingerprints.get(fingerprint) ?? 0) + 1;
      attemptFingerprints.set(fingerprint, seen);
      if (seen >= 3) {
        // The same action against the same screen, three times. Continuing would
        // add near-duplicate steps to the recording and change state nobody chose.
        const reason = `the agent attempted the same action against an unchanged screen ${seen} times (${built.intent})`;
        logger.event('discovery.stalled', { fingerprint, attempts: seen, intent: built.intent });
        const decided = await raiseIntervention('discovery-stuck', 'Discovery is looping', reason);
        humanInterventions++;
        if (decided.decision === 'abort') {
          return { status: 'escalated', runId, evidenceDir, reason, interventionId: decided.id, decision: decided.decision, turns };
        }
        attemptFingerprints.clear();
        observation = await surface.observe();
        reply(`You repeated the same action ${seen} times without progress, so a human intervened and chose '${decided.decision}'. Look carefully at the new observation and try a different approach.`);
        pushObservation(observation, 'state after human intervention');
        continue;
      }

      const surfaceAction = toSurfaceActionForBuilt(built, vault);
      let result = await surface.perform(surfaceAction);

      if (!result.ok && result.error?.code === 'POLICY_AUTHORIZATION_REQUIRED') {
        const reason = `the agent wants to ${built.intent}, which is classified irreversible: ${result.error.observed ?? ''}`;
        const decided = await raiseIntervention('authorization-required', `Authorise: ${truncate(built.intent, 60)}`, reason);
        humanInterventions++;
        if (decided.decision === 'abort') {
          return { status: 'escalated', runId, evidenceDir, reason, interventionId: decided.id, decision: decided.decision, turns };
        }
        if (decided.decision === 'authorize-and-resume') {
          gate.authorizeNextIrreversible(decided.by, decided.note ?? 'authorised at the operator console');
          result = await surface.perform(surfaceAction);
          if (!result.ok) {
            reply(`Even after authorisation the action failed: ${result.error?.message}. Try something else.`);
            observation = await surface.observe();
            pushObservation(observation);
            continue;
          }
        } else {
          // The human did it by hand, or told us to skip. Either way the action we
          // proposed is not what happened, so it is not recorded as a step.
          observation = await surface.observe();
          reply(`A human handled this step manually (decision: ${decided.decision}, ${decided.humanActionCount} action(s)). Continue from the current screen.`);
          pushObservation(observation, 'state after human intervention');
          continue;
        }
      }

      if (!result.ok) {
        logger.event('action.failed', { turn: turns, tool: call.name, intent: built.intent, error: result.error });
        reply(
          `That action failed: ${result.error?.message ?? 'unknown error'}${result.error?.observed ? ` (${result.error.observed})` : ''}. ` +
            'The screen may have changed; look at the new observation.',
        );
        observation = await surface.observe();
        pushObservation(observation);
        continue;
      }

      const after = await surface.observe();
      const contentUrl = changedFrameUrl(before, after);
      const rec: RecordedStep = {
        intent: built.intent,
        action: built.stepAction,
        risk: built.risk,
        textBefore: before.text,
        textAfter: after.text,
        urlAfter: after.url,
        ...(contentUrl ? { contentUrlAfter: contentUrl } : {}),
        headingsBefore: structuralHeadings(before),
        headingsAfter: structuralHeadings(after),
        usedSecret: built.fill?.kind === 'secret',
      };
      if (built.section) rec.section = built.section;
      if (built.capture) {
        rec.capture = { ...built.capture, observedValue: result.value ?? '' };
        logger.event('discovery.captured', { name: built.capture.name, format: built.capture.format });
      }
      recorded.push(rec);
      observation = after;

      logger.event('action.ok', {
        turn: turns,
        intent: built.intent,
        action: surfaceAction.kind,
        strategy: result.strategyUsed?.kind,
        strategyIndex: result.strategyIndex,
        urlAfter: after.url,
        controls: after.controls.length,
      });
      reply('Done.');
      pushObservation(after);
    }

    if (!successText) {
      logger.event('discovery.exhausted', { turns, maxSteps });
      return fail(`the agent used all ${maxSteps} available actions without reaching the goal`);
    }

    // ----------------------------------------------------------------- compile
    await writeFile(join(logger.paths.dir, 'transcript.json'), `${JSON.stringify(redactor.deep(transcript), null, 2)}\n`, 'utf8');

    const compileInput: CompileInput = {
      id: opts.capabilityId,
      name: titleCase(opts.capabilityId.split('.').pop() ?? opts.capabilityId),
      summary: truncate(summary ?? opts.goal, 190),
      description: summary ?? opts.goal,
      goal: opts.goal,
      productId: opts.productId,
      ...(opts.productVersion ? { productVersion: opts.productVersion } : {}),
      tenantId: opts.tenantId,
      baseUrl: opts.baseUrl,
      entryUrl: opts.entryUrl,
      parameters: opts.parameters,
      successText,
      steps: recorded,
      provenance: {
        discoveryRunId: runId,
        model: opts.provider.id,
        modelTurns: turns,
        transcript,
        recordedBy: opts.recordedBy ?? 'ledgerhand-discovery',
        humanInterventions,
      },
    };
    const capability = compileCapability(compileInput);
    logger.event('discovery.compiled', {
      capability: { id: capability.id, version: capability.version },
      steps: capability.steps.length,
      inputs: capability.inputs.map((i) => i.name),
      outputs: capability.outputs.map((o) => o.name),
      outcomes: capability.outcomes.map((o) => o.code),
      interrupts: capability.interrupts.map((h) => h.name),
    });

    return { status: 'success', capability, runId, evidenceDir, turns, steps: capability.steps.length };

    // =========================================================================

    async function raiseIntervention(
      reason: 'discovery-stuck' | 'authorization-required',
      headline: string,
      detail: string,
    ): Promise<{ id: string; decision: string; note?: string; by: string; humanActionCount: number }> {
      const evidence = await logger.captureFailureEvidence(surface, `escalation-turn-${turns}`);
      const loc = await surface.location();
      const item = broker.raise({
        reason,
        headline,
        detail,
        context: {
          runId,
          runKind: 'discovery',
          goal: opts.goal,
          location: loc,
          visibleExcerpt: redactor.text(observation.text.slice(0, 700)),
          evidence,
        },
      });
      let recorder: { detach(): void } | undefined;
      if (web) {
        const { attachHumanActionRecorder } = await import('../escalation/human-recorder.js');
        recorder = await attachHumanActionRecorder(web.livePage(), (a) => broker.recordHumanAction(item.id, a)).catch(() => undefined);
      }
      const resolution = await broker.waitForResolution(item.id, opts.escalationTimeoutMs ?? 15 * 60_000);
      recorder?.detach();
      if (gate.isTripped()) gate.resetAfterHumanReview(resolution.by);
      return {
        id: item.id,
        decision: resolution.decision,
        note: resolution.note,
        by: resolution.by,
        humanActionCount: resolution.humanActions.length,
      };
    }
  } catch (err) {
    logger.event('discovery.crashed', { error: err instanceof Error ? err.message : String(err) });
    return fail(`discovery crashed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await logger.finalize({ turns, recordedSteps: recorded.length, humanInterventions, model: opts.provider.id });
    await web?.close();
  }
}

// ---------------------------------------------------------------------------
// Tool call -> action
// ---------------------------------------------------------------------------

/**
 * A model tool call, translated.
 *
 * `fill` is kept as a description of *where the value comes from* rather than as
 * the value itself. The secret is resolved from the vault at the moment the action
 * is performed, so it exists only inside `toSurfaceActionForBuilt` and never in a
 * structure that gets fingerprinted, logged, or recorded.
 */
interface BuiltAction {
  intent: string;
  stepAction: StepAction;
  risk: RiskClass;
  target?: TargetDescriptor;
  fill?: { kind: 'literal'; value: string } | { kind: 'secret'; name: string };
  selectValue?: string;
  /** Identifies the action for stall detection, with no secret material in it. */
  fingerprint: unknown;
  section?: string;
  capture?: { name: string; format: 'text' | 'money' | 'number' };
}

function toSurfaceActionForBuilt(built: BuiltAction, vault: SecretVault): Action {
  switch (built.stepAction.kind) {
    case 'navigate':
      return { kind: 'navigate', url: built.stepAction.url };
    case 'click':
      return { kind: 'click', target: built.target! };
    case 'fill': {
      const value = built.fill!.kind === 'secret' ? vault.get(built.fill!.name) : built.fill!.value;
      return { kind: 'fill', target: built.target!, value };
    }
    case 'select':
      return { kind: 'select', target: built.target!, value: built.selectValue ?? '' };
    case 'readText':
      return { kind: 'readText', target: built.target! };
    default:
      throw new Error(`discovery does not emit '${built.stepAction.kind}' actions`);
  }
}

/**
 * Convert a model tool call into a concrete action plus the durable step recorded
 * for it.
 *
 * This is where "the model does not author selectors" is implemented: the
 * TargetDescriptor comes from `control.targeting`, which perception computed, with
 * the frame path attached so a frameset app resolves in the right document.
 */
/**
 * Replace a task parameter's value with its placeholder in free text.
 * Longest first so a value containing another is replaced whole.
 */
function parameteriseText(text: string, parameters: DiscoveryParameter[]): string {
  let out = text;
  for (const p of [...parameters].sort((a, b) => b.value.length - a.value.length)) {
    if (p.value.length >= 2 && out.includes(p.value)) out = out.split(p.value).join(`{{input.${p.name}}}`);
  }
  return out;
}

function parameteriseArgs(args: Record<string, unknown>, parameters: DiscoveryParameter[]): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).map(([k, v]) => [k, typeof v === 'string' ? parameteriseText(v, parameters) : v]),
  );
}

/** Resolve `{{input.name}}` back to the value, for a transcript-driven run. */
function resolveParameterPlaceholders(text: string, parameters: DiscoveryParameter[]): string {
  return text.replace(/\{\{\s*input\.([a-zA-Z0-9_]+)\s*\}\}/g, (m, name: string) => {
    const found = parameters.find((p) => p.name === name);
    return found ? found.value : m;
  });
}

function buildAction(
  call: LlmToolCall,
  observation: Observation,
  secretNames: string[],
  parameters: DiscoveryParameter[],
): BuiltAction | { error: string } {
  const why = String(call.args.why ?? '').trim();

  if (call.name === TOOL_NAMES.navigate) {
    const url = String(call.args.url ?? '').trim();
    if (!url) return { error: 'navigate_to requires a url.' };
    return {
      intent: why || `Open ${url}`,
      stepAction: { kind: 'navigate', url },
      risk: 'safe',
      fingerprint: { kind: 'navigate', url },
    };
  }

  if (!why) return { error: `${call.name} requires "why": one sentence describing what this step accomplishes.` };

  const ref = String(call.args.ref ?? '').trim();
  if (!ref) return { error: `${call.name} requires a ref taken from the latest observation.` };
  const control = observation.controls.find((c) => c.ref === ref);
  if (!control) {
    const generation = refGeneration(ref);
    if (generation !== undefined && generation !== observation.generation) {
      return {
        error:
          `ref '${ref}' is from an earlier observation (generation ${generation}; current is ${observation.generation}). ` +
          'Refs expire every turn -- pick one from the observation you were just shown.',
      };
    }
    return { error: `there is no control with ref '${ref}' on the current screen. Pick a ref from the latest observation.` };
  }

  const target = targetFor(control);
  const common = {
    intent: why,
    target,
    ...(control.container.section ? { section: control.container.section } : {}),
  };
  const refDescription = `${control.container.framePath.join('/')}::${control.role}::${control.name}`;

  switch (call.name) {
    case TOOL_NAMES.click:
      return {
        ...common,
        stepAction: { kind: 'click', target },
        risk: classifyRisk({ kind: 'click', target }, control).risk,
        fingerprint: { kind: 'click', control: refDescription },
      };

    case TOOL_NAMES.fill: {
      const secretName = call.args.secretName ? String(call.args.secretName) : undefined;
      const literal =
        call.args.value !== undefined ? resolveParameterPlaceholders(String(call.args.value), parameters) : undefined;
      if (secretName && literal !== undefined) return { error: 'fill_field takes either value or secretName, not both.' };
      if (!secretName && literal === undefined) {
        return { error: 'fill_field requires either value (literal text) or secretName (a stored credential).' };
      }
      if (secretName && !secretNames.includes(secretName)) {
        return { error: `there is no stored credential named '${secretName}'. Available: ${secretNames.join(', ') || '(none)'}.` };
      }
      if (!secretName && literal !== undefined && secretNames.includes(literal.trim())) {
        // The model typed the credential's *name* into the field as though it were
        // the value. Easy mistake -- the names are right there in the tool
        // description -- and without this guard it silently submits a wrong
        // credential, gets "User ID or Password is not valid", and burns its
        // remaining turns trying to work out why.
        return {
          error:
            `'${literal.trim()}' is the *name* of a stored credential, not its value, and you have not been given the value. ` +
            `Call fill_field again with secretName: "${literal.trim()}" and no value, and the credential will be typed for you.`,
        };
      }
      if (!secretName && control.role === 'password') {
        // Structural rather than advisory: a literal into a password field is
        // refused regardless of what the model thinks it is doing.
        return {
          error:
            `'${control.name}' is a password field. Use secretName so the credential is never in your context. ` +
            `Available: ${secretNames.join(', ') || '(none)'}.`,
        };
      }
      const fill = secretName ? ({ kind: 'secret', name: secretName } as const) : ({ kind: 'literal', value: literal! } as const);
      return {
        ...common,
        fill,
        stepAction: {
          kind: 'fill',
          target,
          value: secretName ? { from: 'secret', name: secretName } : { from: 'literal', value: literal! },
        },
        risk: classifyRisk({ kind: 'fill', target, value: '' }, control).risk,
        fingerprint: { kind: 'fill', control: refDescription, secret: Boolean(secretName), value: secretName ? '[secret]' : literal },
      };
    }

    case TOOL_NAMES.select: {
      const value = resolveParameterPlaceholders(String(call.args.value ?? ''), parameters);
      if (!value) return { error: 'select_option requires a value.' };
      return {
        ...common,
        selectValue: value,
        stepAction: { kind: 'select', target, value: { from: 'literal', value } },
        risk: classifyRisk({ kind: 'select', target, value }, control).risk,
        fingerprint: { kind: 'select', control: refDescription, value },
      };
    }

    case TOOL_NAMES.read: {
      const outputName = String(call.args.outputName ?? '').trim();
      if (!/^[a-z][a-zA-Z0-9]*$/.test(outputName)) {
        return { error: `read_value requires outputName in lowerCamelCase, e.g. savingsBalance. Got '${outputName}'.` };
      }
      const format = ['text', 'money', 'number'].includes(String(call.args.format))
        ? (String(call.args.format) as 'text' | 'money' | 'number')
        : 'text';
      return {
        ...common,
        stepAction: { kind: 'readText', target },
        risk: 'safe',
        capture: { name: outputName, format },
        fingerprint: { kind: 'readText', control: refDescription, outputName },
      };
    }

    default:
      return { error: `unknown tool '${call.name}'.` };
  }
}

/**
 * The durable description of a control, taken from perception.
 *
 * `container.framePath` is carried onto the descriptor so resolution is scoped to
 * the document the control was actually in: on a frameset app the nav frame and
 * the body frame regularly hold controls with the same name.
 */
export function targetFor(control: PerceivedControl): TargetDescriptor {
  const description = control.container.section
    ? `${control.role} "${control.name}" in ${control.container.section}`
    : `${control.role} "${control.name}"`;
  return {
    description,
    ...(control.container.framePath.length ? { framePath: control.container.framePath } : {}),
    strategies: control.targeting,
  };
}

/**
 * The structural headings of a screen, as reported by perception.
 *
 * Also folds in the headings each control was attributed to, which catches a
 * heading in a frame that perception reached only through attribution.
 */
export function structuralHeadings(obs: Observation): string[] {
  const out = new Set<string>(obs.headings ?? []);
  for (const c of obs.controls) {
    if (c.container.section) out.add(c.container.section);
    if (c.container.table?.near) out.add(c.container.table.near);
  }
  return [...out];
}

/**
 * The url of the frame that changed, preferring the deepest one.
 *
 * On a frameset app the top document is loaded once and then never navigates, so
 * comparing top urls reports "nothing happened" for every real interaction. The
 * frame that changed is the one holding the screen the step was reaching for.
 * Returns undefined when nothing navigated, which is correct for an in-page action
 * like reading a cell -- there is no url worth asserting.
 */
function changedFrameUrl(before: Observation, after: Observation): string | undefined {
  const priorByPath = new Map(before.frames.map((f) => [f.path.join('/'), f.url]));
  const changed = after.frames.filter((f) => priorByPath.get(f.path.join('/')) !== f.url);
  if (changed.length === 0) return undefined;
  return changed.sort((a, b) => b.path.length - a.path.length)[0]!.url;
}

function refGeneration(ref: string): number | undefined {
  const bare = ref.includes('|') ? ref.slice(ref.lastIndexOf('|') + 1) : ref;
  const n = Number(bare.split(':')[0]);
  return Number.isFinite(n) ? n : undefined;
}

function hashText(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 12);
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}...` : s;
}

function titleCase(s: string): string {
  return s.replace(/[-_.]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
