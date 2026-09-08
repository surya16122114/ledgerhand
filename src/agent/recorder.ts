/**
 * Compiling a discovery run into a capability artifact.
 *
 * The artifact is deliberately *not* a transcript of what the model did. It is a
 * derived, normalized description of the flow, and the normalization is where the
 * value is:
 *
 *  - **Targets come from perception, not from the model.** The model pointed at a
 *    ref; the recorder writes the ordered strategy list that perception computed
 *    for that control. The artifact's robustness is therefore a property of the
 *    perception layer, which is deterministic and testable, rather than of a model's
 *    judgment on the day.
 *
 *  - **Literals become parameters.** A value the model typed that equals a task
 *    parameter is rewritten as `{ from: 'input' }`. Without this, every capability
 *    would be hard-wired to the member used during recording.
 *
 *  - **Checkpoints are synthesized from observed state change.** After each action
 *    the recorder diffs the visible text and picks a phrase that appeared. That is
 *    a better checkpoint than anything the model would volunteer, because it is
 *    grounded in what actually changed.
 *
 *  - **Cross-cutting behavior comes from the product profile.** See
 *    product-profiles.ts: the interrupts and business outcomes a successful run
 *    cannot have observed are inherited rather than invented.
 *
 *  - **The transcript is hashed, not embedded.** Model reasoning about a live
 *    banking screen quotes member data. The digest proves which transcript
 *    produced the artifact; the transcript stays in access-controlled evidence.
 */

import { createHash } from 'node:crypto';
import { ARTIFACT_SCHEMA_VERSION, capabilitySchema, type Capability } from '../artifact/schema.js';
import type { Condition, Handler, RiskClass, Step, StepAction, TargetDescriptor } from '../artifact/index-types.js';
import { profileFor, stepOutcomeHandlers } from '../artifact/product-profiles.js';
import type { ActionKind } from '../surface/types.js';
import { discoveryAllowlist } from '../policy/allowlist.js';
import { escapeRegExp } from '../util/regex.js';

export const TOOL_VERSION = 'ledgerhand/0.1.0';

export interface RecordedStep {
  intent: string;
  action: StepAction;
  risk: RiskClass;
  /** Visible text before and after, used to synthesize a checkpoint. */
  textBefore: string;
  textAfter: string;
  /** Url of the top document after the action. */
  urlAfter: string;
  /**
   * Url of the frame that actually changed.
   *
   * On a frameset app the top document is loaded once and never navigates again,
   * so `urlAfter` is `/console.aspx` for every step after sign-on. A checkpoint
   * built from it asserts nothing. The frame that changed is the one carrying the
   * screen the step was trying to reach.
   */
  contentUrlAfter?: string;
  /** True when the value typed came from the vault. */
  usedSecret: boolean;
  /** Set for read_value steps. */
  capture?: { name: string; format: 'text' | 'money' | 'number' | 'regex'; pattern?: string; observedValue: string };
  /**
   * Structural section headings visible before and after the action.
   *
   * These come from the perception layer, which identifies headings by *styling*
   * -- an upper-case bold cell with a grey background, since these apps have no
   * <h1> -- rather than by content. That makes them structure by construction,
   * which is exactly the property a checkpoint needs and which no amount of string
   * heuristics on the visible text can guarantee.
   */
  headingsBefore?: string[];
  headingsAfter?: string[];
  /** Which frame the action targeted, for auth-block detection. */
  section?: string;
}

export interface CompileInput {
  version?: string;
  id: string;
  name: string;
  summary: string;
  description: string;
  goal: string;
  productId: string;
  productVersion?: string;
  tenantId: string;
  baseUrl: string;
  entryUrl: string;
  /** Task parameters, in the order they were declared. Become capability inputs. */
  parameters: {
    name: string;
    value: string;
    type: 'string' | 'number' | 'money';
    description: string;
    sensitivity: 'public' | 'internal' | 'pii';
    /**
     * Optional format constraint, declared by whoever specified the capability.
     *
     * Deliberately authored rather than inferred. What a capability accepts is a
     * contract decision, and it is checked before the browser launches -- so a
     * malformed member id costs a millisecond and a precise message instead of a
     * browser launch, a sign-on, and a vague complaint from the app four screens in.
     */
    pattern?: string;
  }[];
  successText: string;
  steps: RecordedStep[];
  provenance: {
    discoveryRunId: string;
    model: string;
    modelTurns: number;
    transcript: unknown;
    recordedBy: string;
    humanInterventions: number;
  };
}

export function compileCapability(input: CompileInput): Capability {
  const profile = profileFor(input.productId);
  const paramByValue = new Map(input.parameters.map((p) => [p.value, p]));

  // ------------------------------------------------------- auth block detection
  // Steps up to and including the first click that follows a secret-backed fill
  // are the sign-on block. `reauthenticate` replays exactly these when a session
  // dies mid-run, so getting the boundary right matters: too few and re-auth does
  // not restore the session, too many and it re-submits business actions.
  const lastSecretIndex = lastIndexWhere(input.steps, (s) => s.usedSecret);
  let authBoundary = -1;
  if (lastSecretIndex >= 0) {
    authBoundary = lastSecretIndex;
    for (let i = lastSecretIndex + 1; i < input.steps.length; i++) {
      authBoundary = i;
      if (input.steps[i]!.action.kind === 'click') break;
    }
  }

  const outputs: Capability['outputs'] = [];
  const steps: Step[] = [];
  const capturedIdentities = new Map<string, string>();

  input.steps.forEach((rec, i) => {
    const id = stepId(rec, i);
    const action = parameterize(rec.action, paramByValue, input.baseUrl);
    if ('target' in action) {
      action.target.strategies = action.target.strategies.map((st) => {
        if (st.kind !== 'table-cell') return st;
        const capturedName = capturedIdentities.get(st.rowKey);
        return capturedName ? { ...st, rowKey: `{{captured.${capturedName}}}` } : st;
      });
      if (action.target.strategies.some((st) => st.kind === 'table-cell' && st.rowKey.includes('{{captured.'))) {
        action.target.strategies = action.target.strategies.filter((st) => st.kind === 'table-cell');
      }
    }
    const handlers: Handler[] = [];

    // Step-scoped business outcomes, chosen by what the step just did rather than
    // by the model's opinion. A submit can produce a validation message; a search
    // can produce "no records found".
    if (rec.action.kind === 'click') {
      const label = targetLabel(rec.action);
      const isSearch = /search|find|lookup|inquir/i.test(label);
      if (isSearch) handlers.push(...stepOutcomeHandlers(input.productId, 'after-search'));

      // Every click gets the after-submit handlers, not just ones whose label
      // looks like a submit.
      //
      // This used to be a word list -- submit|save|confirm|open|post|apply -- and
      // the asymmetry is what killed it. An extra handler that never matches costs
      // a few bytes of artifact; a missing one turns a legitimate business outcome
      // into a hard failure. Meridian's two-phase forms submit with a button
      // labelled "Continue", so a transfer out of a frozen share reported
      // TARGET_NOT_FOUND -- the error page had replaced the button -- instead of
      // SOURCE_SHARE_RESTRICTED, which the profile could name precisely.
      //
      // A word list also cannot be right for the next vendor product either, and
      // that is the deeper reason to drop it rather than extend it.
      handlers.push(...stepOutcomeHandlers(input.productId, 'after-submit'));
    }

    // Transient slowness on a navigating step is recoverable, once.
    //
    // Guarded on the failure code rather than on page state. The state-condition
    // version of this handler matched `^\s*$` against the visible text and could
    // never fire, because while a page is loading the browser still shows the
    // *previous* one -- there is no observable "still loading". Verified: with a
    // 16-second stall the handler never triggered and the run escalated.
    //
    // Retrying is safe here specifically because the step loop re-evaluates the
    // checkpoint before any re-attempt, so a load that has since landed is recognized
    // as already satisfied and the click is not repeated. And `retryStep` refuses
    // outright to re-attempt an irreversible step.
    if (rec.action.kind === 'click' || rec.action.kind === 'navigate') {
      handlers.push({
        name: 'transient-slow-load',
        whenFailureCode: ['CHECKPOINT_FAILED', 'TIMEOUT'],
        then: { do: 'retryStep', maxAttempts: 1, backoffMs: 3000 },
        notDuringAuth: false,
      });
    }

    // Parameter values are templated out of the intent prose too, not just out of
    // actions and targets. The model writes intents like "look up member 12345", and
    // that string is what an operator reads in an escalation headline -- so on a run
    // for a different member it says the wrong thing, and meanwhile a member id is
    // sitting in prose inside an artifact that is meant to be free of member data.
    // Computed once here because the same text is reused as an output's description.
    const intent = templateIntent(rec.intent, paramByValue);

    const step: Step = {
      id,
      intent,
      action,
      risk: rec.risk,
      partOfAuth: i <= authBoundary,
      timeoutMs: 10_000,
      handlers,
    };

    const checkpoint = synthesiseCheckpoint(rec, profile);
    if (checkpoint) step.checkpoint = checkpoint;

    if (rec.capture) {
      step.captureAs = rec.capture.name;
      capturedIdentities.set(rec.capture.observedValue.trim(), rec.capture.name);
      const expected = input.parameters.find((p) => p.value === rec.capture?.observedValue.trim());
      if (expected && rec.action.kind === 'readText' && rec.capture.format === 'text') {
        step.checkpoint = { kind: 'valueMatches', target: action.kind === 'readText' ? action.target : rec.action.target,
          pattern: `^{{input.${expected.name}}}$` };
      }
      if (rec.capture.format === 'money') step.transform = { kind: 'money' };
      else if (rec.capture.format === 'number') step.transform = { kind: 'number' };
      // Group 1 by default: the tool requires exactly the shape where the wanted
      // value is the first capture group, and validates that at record time.
      else if (rec.capture.format === 'regex' && rec.capture.pattern) step.transform = { kind: 'regex', pattern: rec.capture.pattern, group: 1 };
      else step.transform = { kind: 'trim' };

      outputs.push({
        name: rec.capture.name,
        type: rec.capture.format === 'money' ? 'money' : rec.capture.format === 'number' ? 'number' : 'string',
        description: intent,
        // A value read off a member servicing screen is member data by default.
        // Requiring the recorder to opt *out* of that is the safe direction.
        sensitivity: 'pii',
        required: true,
      });
    }

    steps.push(step);
  });

  const actionKinds = [...new Set(steps.map((s) => s.action.kind))] as ActionKind[];
  const maxRisk: RiskClass = steps.some((s) => s.risk === 'irreversible')
    ? 'irreversible'
    : steps.some((s) => s.risk === 'reversible')
      ? 'reversible'
      : 'safe';

  const capability: Capability = capabilitySchema.parse({
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    id: input.id,
    version: input.version ?? '1.0.0',
    name: input.name,
    summary: templateIntent(input.summary, paramByValue),
    // The goal is kept because it is the best short explanation of why this
    // capability exists, and templated because a goal is normally written with
    // concrete values in it.
    description: templateIntent(`${input.description}\n\nRecorded from the goal: "${input.goal}"`, paramByValue),
    target: {
      productId: input.productId,
      ...(input.productVersion ? { productVersion: input.productVersion } : {}),
      recordedTenantId: input.tenantId,
      surfaceKind: 'legacy-web',
      entryUrl: templateHost(input.entryUrl, input.baseUrl),
    },
    inputs: input.parameters.map((p) => ({
      name: p.name,
      type: p.type,
      required: true,
      description: p.description,
      sensitivity: p.sensitivity,
      ...(p.pattern ? { pattern: p.pattern } : {}),
      // No example on a pii field -- the schema refuses it, and this is where an
      // "example" that is really a real member id would otherwise get in.
    })),
    outputs,
    outcomes: profile.outcomes,
    steps,
    success: successCondition(input),
    interrupts: [...(profile.runtimeOutcomes ?? []), ...profile.interrupts],
    policy: {
      // The placeholder is left unescaped: it is substituted by
      // `renderUrlPattern`, which regex-escapes the URL it interpolates.
      allowedUrlPatterns: ['^{{baseUrl}}/'],
      deniedUrlPatterns: [...(discoveryAllowlist(input.baseUrl).deniedUrlPatterns ?? []), ...(profile.deniedUrlPatterns ?? [])],
      allowedActions: actionKinds,
      maxRisk,
      requiresApprovalForIrreversible: true,
    },
    lifecycle: {
      // Never born approved. A capability that can move money should not become
      // unattended-runnable because a model said it worked once.
      state: 'draft',
      stability: { runs: 0, successes: 0, consecutiveFailures: 0, fallbackHits: 0 },
    },
    provenance: {
      recordedAt: new Date().toISOString(),
      recordedBy: input.provenance.recordedBy,
      discoveryRunId: input.provenance.discoveryRunId,
      model: input.provenance.model,
      modelTurns: input.provenance.modelTurns,
      transcriptDigest: `sha256:${createHash('sha256').update(JSON.stringify(input.provenance.transcript)).digest('hex').slice(0, 32)}`,
      redactionApplied: true,
      toolVersion: TOOL_VERSION,
      humanInterventions: input.provenance.humanInterventions,
    },
    overlays: [],
  });

  return capability;
}

// ---------------------------------------------------------------------------

/**
 * Rewrite record-time data into input references.
 *
 * Two places need it, and only the first is obvious:
 *
 *  - the value a step types, and
 *  - any parameter value embedded inside a *target*.
 *
 * The second is the one that bites. A table cell addressed by
 * `rowKey: '12345-00'` looks like a locator, but the member id is right there in
 * it. Parameterising only values yields a capability that appears reusable, passes
 * its own replay on the recorded inputs, and quietly resolves to the wrong row for
 * anyone else.
 */
function parameterize(action: StepAction, paramByValue: Map<string, { name: string }>, baseUrl: string): StepAction {
  // Every navigate url gets the host templated out, not only `target.entryUrl`.
  // Missing this leaves the recorded environment baked into step one, so the
  // capability is portable everywhere except the very first action -- which then
  // fails the allowlist for any other host, including the next tenant.
  if (action.kind === 'navigate') {
    return { ...action, url: templateHost(action.url, baseUrl) };
  }
  const withTarget = 'target' in action ? { ...action, target: parameteriseTarget(action.target, paramByValue) } : action;
  if (withTarget.kind !== 'fill' && withTarget.kind !== 'select') return withTarget;
  if (withTarget.value.from !== 'literal') return withTarget;
  const literal = withTarget.value.value;
  const param =
    paramByValue.get(literal) ??
    // A dropdown option carries a code and a label in one string -- "WEST-014 -
    // Westside" -- and the model can only name it by what it sees, so an exact
    // match never fires and the branch stays hardcoded. The capability then
    // advertises a `branch` input and signs on at whatever branch was recorded.
    //
    // Restricted to `select`, and to the code appearing at the *start* on a
    // non-alphanumeric boundary, so this cannot fire on a fill whose text merely
    // begins with a parameter value. Safe because replay resolves a select by the
    // option's underlying value first and only falls back to its label -- and the
    // code is exactly that underlying value.
    (withTarget.kind === 'select'
      ? [...paramByValue.entries()].find(
          ([value]) => value.length >= 3 && literal.startsWith(value) && /^[^A-Za-z0-9]/.test(literal.slice(value.length)),
        )?.[1]
      : undefined);
  if (!param) return withTarget;
  return { ...withTarget, value: { from: 'input', name: param.name } };
}

/**
 * Replace parameter values in free text with their placeholder.
 *
 * Longest value first so a parameter whose value contains another's is replaced
 * whole. Only values of at least three characters, since replacing a one- or
 * two-character value inside prose would mangle it.
 */
function templateIntent(intent: string, paramByValue: Map<string, { name: string }>): string {
  const entries = [...paramByValue.entries()].filter(([value]) => value.length >= 3).sort((a, b) => b[0].length - a[0].length);
  let out = intent;
  for (const [value, param] of entries) {
    if (out.includes(value)) out = out.split(value).join(`{{input.${param.name}}}`);
  }
  return out;
}

function templateHost(url: string, baseUrl: string): string {
  const host = baseUrl.replace(/\/$/, '');
  return url.startsWith(host) ? `{{baseUrl}}${url.slice(host.length)}` : url;
}

function parameteriseTarget(target: TargetDescriptor, paramByValue: Map<string, { name: string }>): TargetDescriptor {
  // Longest value first, so a parameter whose value contains another's is replaced
  // whole rather than in fragments.
  const entries = [...paramByValue.entries()].filter(([value]) => value.length >= 2).sort((a, b) => b[0].length - a[0].length);
  if (entries.length === 0) return target;

  const sub = (s: string): string => {
    let out = s;
    for (const [value, param] of entries) {
      if (out.includes(value)) out = out.split(value).join(`{{input.${param.name}}}`);
    }
    return out;
  };

  return {
    ...target,
    // The human-readable description matters as much as the strategies. It is quoted
    // verbatim in failure messages and in the `show` output, so leaving it as
    // 'cell [12345-00 / Current Balance]' means every future run reports a member id
    // that has nothing to do with it.
    description: sub(target.description),
    strategies: target.strategies.map((st) => {
      switch (st.kind) {
        // Labels and control names are screen structure, not data: a field labelled
        // "Member ID" keeps that label whatever member is being looked up. Rewriting
        // them would corrupt the locator.
        case 'role-name':
        case 'labelled-field':
        case 'text':
        case 'section-ordinal':
          return st;
        // Row keys, by contrast, are pure data.
        case 'table-cell':
          return { ...st, rowKey: sub(st.rowKey) };
        case 'dom-hint':
        case 'anchor-offset':
          return st;
      }
    }),
  };
}

/**
 * Synthesize a checkpoint from what actually changed on screen.
 *
 * The whole difficulty here is separating *screen structure* from *this run's
 * data*. A naive "pick the longest new line" picks
 * "BR-014 NORTHGATE Member Since:" -- which is the branch of the member who
 * happened to be used during recording, so the checkpoint passes once and fails
 * for every other member forever. Getting this wrong produces an artifact that
 * looks correct, replays correctly on the recorded inputs, and is worthless.
 *
 * So candidate phrases are filtered against `looksLikeData`, and then scored to
 * prefer the kind of phrase legacy enterprise apps use for structure: an
 * upper-case screen or section heading.
 *
 * The url half of the checkpoint comes from the frame that actually navigated, not
 * the top document -- see RecordedStep.contentUrlAfter.
 */
function synthesiseCheckpoint(rec: RecordedStep, profile: { canonicalizeUrl(u: string): string }): Condition | undefined {
  if (rec.action.kind === 'fill' || rec.action.kind === 'select') {
    // The one meaningful assertion for a fill is that the value took, and the
    // engine already verifies that by re-perceiving. A textPresent checkpoint here
    // would just assert the label is still on screen.
    return undefined;
  }

  const phrase = pickCheckpointPhrase(rec);

  // Only assert on a url that actually changed. Asserting the unchanged top
  // document of a frameset is worse than asserting nothing, because it looks like
  // a check and never fails.
  const contentUrl = rec.contentUrlAfter;
  const urlPattern = contentUrl ? profile.canonicalizeUrl(contentUrl) : undefined;

  if (phrase && urlPattern) {
    // Both, because either alone is weaker: the phrase can appear on a similar
    // screen, and the url alone does not prove the screen rendered.
    return {
      kind: 'all',
      of: [
        { kind: 'textPresent', pattern: escapeRegExp(phrase) },
        { kind: 'urlMatches', pattern: urlPattern },
      ],
    };
  }
  if (phrase) return { kind: 'textPresent', pattern: escapeRegExp(phrase) };
  if (urlPattern) return { kind: 'urlMatches', pattern: urlPattern };
  return undefined;
}

/**
 * Choose the phrase to assert on.
 *
 * Two tiers, and the order matters more than either heuristic:
 *
 *  1. **A section heading that appeared.** Headings are identified by the
 *     perception layer from styling, so they are structure by construction. This
 *     is the tier that actually works.
 *
 *  2. **Fallback: a new phrase from the visible text.** Only reached when nothing
 *     structural changed -- an in-page update, or a screen with no heading. Filtered
 *     by `looksLikeData` and scored toward upper-case, but this tier is a heuristic
 *     and can be fooled: the string "ACTIVE Tax ID:" reads as a heading and is in
 *     fact one member's account status, so a capability checkpointed on it would
 *     fail for a dormant member. That failure is the reason tier 1 exists.
 */
function pickCheckpointPhrase(rec: RecordedStep): string | undefined {
  const priorHeadings = new Set((rec.headingsBefore ?? []).map((h) => h.trim()));
  const newHeading = (rec.headingsAfter ?? [])
    .map((h) => h.trim())
    .filter((h) => h.length >= 6 && h.length <= 70)
    .filter((h) => !priorHeadings.has(h))
    .filter((h) => !looksLikeData(h))
    .map((h) => ({ h, score: structuralScore(h) }))
    .sort((a, b) => b.score - a.score)[0]?.h;
  if (newHeading) return newHeading;

  const priorPhrases = new Set(splitPhrases(rec.textBefore));
  return splitPhrases(rec.textAfter)
    .filter((p) => !priorPhrases.has(p))
    .filter((p) => p.length >= 8 && p.length <= 70)
    .filter((p) => !looksLikeData(p))
    .map((p) => ({ p, score: structuralScore(p) }))
    .sort((a, b) => b.score - a.score)[0]?.p;
}

/**
 * True when a phrase carries record-time data rather than screen structure.
 *
 * Exported because the discovery loop applies the same test to the success phrase
 * the model proposes. One definition, used in both places, so the model cannot
 * hand us something the recorder would have rejected.
 */
/**
 * The capability's overall success condition.
 *
 * Every *step* checkpoint was already filtered through `looksLikeData`, but this
 * one was taken from the model's success phrase verbatim -- the single place a
 * record-time value could still walk into an artifact. Two shipped that way: a
 * contact update asserting the e-mail it happened to set, and a sign-on asserting
 * the operator's display name. Both passed discovery, and both would only ever
 * have succeeded for the run that produced them.
 *
 * When the phrase is unusable the last step's structural heading is a better
 * answer than a data-bearing one. If there is no safe phrase at all we keep the
 * model's, because a wrong checkpoint that `lintCapability` reports beats a
 * missing one that nothing does.
 */
function successCondition(input: CompileInput): { description: string; checkpoint: Condition } {
  const recordTimeValues = input.parameters.map((p) => p.value).filter((v): v is string => typeof v === 'string');
  const phrase = !looksLikeData(input.successText, recordTimeValues)
    ? input.successText
    : ([...input.steps].reverse().flatMap((s) => s.headingsAfter ?? []).find((h) => !looksLikeData(h, recordTimeValues)) ??
      input.successText);
  return {
    description: `the screen shows "${phrase}"`,
    checkpoint: { kind: 'textPresent', pattern: escapeRegExp(phrase) },
  };
}

export function looksLikeData(phrase: string, recordTimeValues: string[] = []): boolean {
  // Any digit at all. On these screens digits are member numbers, balances,
  // branch codes, dates and queue counts -- never structure. This is blunt, and
  // deliberately so: the cost of rejecting a usable phrase is that we fall back to
  // another one, and the cost of accepting a data-bearing phrase is a capability
  // that only works for one member.
  if (/\d/.test(phrase)) return true;
  // Currency.
  if (/[$\u00a3\u20ac]/.test(phrase)) return true;
  // "Lastname, Firstname" -- how these apps render a member name.
  if (/\b[A-Z][a-z]+,\s+[A-Z][a-z]+/.test(phrase)) return true;
  // An e-mail address. Every check above is digit- or punctuation-shaped, and a
  // contact-update capability compiled with "E-mail: d.vaughan@example.org" as its
  // definition of success -- passing only for the address it was recorded with.
  if (/[^\s@]+@[^\s@]+\.[A-Za-z]{2,}/.test(phrase)) return true;
  // "J. TELLER" -- an initial and a surname, how these apps render an operator.
  // A sign-on capability asserted this and would have failed as any other user.
  if (/\b[A-Z]\.\s*[A-Z][A-Za-z]+\b/.test(phrase)) return true;
  // Anything this particular run supplied. The cheapest and most certain signal
  // available, and the only one that does not rely on guessing a shape -- but it
  // needs the caller to pass the values, so it supplements the patterns above
  // rather than replacing them.
  return recordTimeValues.some((v) => v.length >= 3 && phrase.includes(v));
}

/**
 * Prefer an upper-case heading over a prose sentence.
 *
 * Legacy enterprise screens announce themselves with a bold upper-case bar --
 * "MEMBER PROFILE", "SHARE / DEPOSIT ACCOUNTS", "SUB-ACCOUNT OPENED". Those are the
 * most stable strings on the screen and the closest thing the app has to a page
 * identity, so they make the best checkpoints.
 */
function structuralScore(phrase: string): number {
  const letters = phrase.replace(/[^A-Za-z]/g, '');
  if (letters.length === 0) return 0;
  const upperRatio = phrase.replace(/[^A-Z]/g, '').length / letters.length;
  let score = 0;
  if (upperRatio >= 0.75) score += 40;
  else if (upperRatio >= 0.5) score += 15;
  // Mild preference for longer, as a tie-break among similar phrases.
  score += Math.min(20, phrase.length / 4);
  return score;
}

/** Split visible text into candidate phrases: lines, then sentence-ish fragments. */
function splitPhrases(text: string): string[] {
  return text
    .split(/[\n\r]+|(?<=[.:])\s+|\s{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function stepId(rec: RecordedStep, index: number): string {
  const base =
    rec.action.kind === 'navigate'
      ? 'open-entry'
      : rec.capture
        ? `read-${kebab(rec.capture.name)}`
        : `${rec.action.kind}-${kebab(targetLabel(rec.action) || String(index))}`;
  return `${String(index + 1).padStart(2, '0')}-${base}`.slice(0, 48).replace(/-+$/, '');
}

function targetLabel(action: StepAction): string {
  if (!('target' in action)) return '';
  const t = action.target as TargetDescriptor;
  const head = t.strategies[0];
  if (!head) return t.description;
  if (head.kind === 'role-name') return head.name;
  if (head.kind === 'labelled-field') return head.label;
  if (head.kind === 'text') return head.text;
  if (head.kind === 'table-cell') return `${head.rowKey}-${head.columnHeader}`;
  return t.description;
}

function kebab(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'step';
}

function lastIndexWhere<T>(arr: T[], pred: (v: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i]!)) return i;
  return -1;
}

