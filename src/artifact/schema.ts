/**
 * The capability artifact.
 *
 * This is the contract between three audiences that never meet:
 *
 *   1. The discovery agent, which writes it once after solving a goal.
 *   2. A human reviewer at the institution, who has to approve it before it may
 *      run unattended, and who is not going to read a model transcript.
 *   3. The production AI agent, which calls it by name with typed arguments and
 *      needs to know what comes back -- including the ways it can legitimately
 *      not work.
 *
 * Design commitments, each of which cost something:
 *
 * - **Data, not code.** Every step, condition, and handler is declarative. No
 *   embedded expressions, no callbacks, nothing eval-ed. This costs
 *   expressiveness -- there are flows this schema cannot describe -- and buys
 *   reviewability, portability to a non-browser surface, and the absence of an
 *   arbitrary-code-execution path in software that runs inside a bank.
 *
 * - **Intents, not selectors.** A step says "the textbox labelled Member ID",
 *   never `#ctl00_MainContent_txtMemberId`. The markup hint is recorded, but as
 *   the last entry in an ordered fallback list.
 *
 * - **Outcomes are part of the type.** `outcomes` declares the business results
 *   a caller must handle. "No such member" is a value, not an exception. This is
 *   the single most important thing the schema does.
 *
 * - **Separation of what from where.** `steps` describe the flow; `overlays`
 *   describe how a specific tenant's build of the same vendor product differs.
 *   One recording, many institutions.
 *
 * - **Provenance without the transcript.** The artifact records a digest of the
 *   discovery transcript, not the transcript. Model reasoning about a live
 *   banking screen contains member data; it belongs in access-controlled
 *   evidence storage, not in a file that gets copied between environments.
 */

import { z } from 'zod';
import type { Action, Condition, ControlRole, RiskClass, SurfaceKind, TargetDescriptor, TargetStrategy } from '../surface/types.js';

/**
 * Schema version of the artifact *format*, distinct from a capability's own
 * version. Bumped when the format changes shape; the loader refuses majors it
 * does not understand rather than guessing.
 */
export const ARTIFACT_SCHEMA_VERSION = '1.0.0' as const;

// ---------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------

const controlRole = z.enum([
  'button', 'link', 'textbox', 'password', 'combobox', 'checkbox', 'radio',
  'heading', 'text', 'cell', 'row', 'table', 'image', 'frame', 'unknown',
]);
const nameMatch = z.enum(['exact', 'normalized', 'contains', 'regex']);

/**
 * Annotated with `z.ZodType<TargetStrategy>` on purpose. The compiler now fails
 * if this schema and the hand-written seam type in surface/types.ts drift apart,
 * which is the kind of divergence that otherwise shows up as a runtime surprise
 * six months later.
 */
export const targetStrategySchema: z.ZodType<TargetStrategy> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('role-name'), role: controlRole, name: z.string(), nameMatch }),
  z.object({ kind: z.literal('labelled-field'), label: z.string(), labelMatch: nameMatch, role: controlRole }),
  z.object({ kind: z.literal('text'), text: z.string(), textMatch: nameMatch, role: controlRole.optional() }),
  z.object({
    kind: z.literal('table-cell'),
    near: z.string().optional(),
    rowKey: z.string(),
    rowKeyMatch: nameMatch,
    columnHeader: z.string(),
  }),
  z.object({ kind: z.literal('section-ordinal'), section: z.string(), role: controlRole, index: z.number().int().min(0) }),
  z.object({ kind: z.literal('dom-hint'), css: z.string() }),
  z.object({ kind: z.literal('anchor-offset'), anchorText: z.string(), dx: z.number(), dy: z.number() }),
]);

export const targetDescriptorSchema: z.ZodType<TargetDescriptor> = z.object({
  description: z.string().min(1, 'every target needs a human-readable description'),
  framePath: z.array(z.string()).optional(),
  strategies: z.array(targetStrategySchema).min(1, 'a target with no strategies can never resolve'),
});

export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('controlPresent'), target: targetDescriptorSchema }),
    z.object({ kind: z.literal('controlAbsent'), target: targetDescriptorSchema }),
    z.object({ kind: z.literal('textPresent'), pattern: z.string(), ignoreCase: z.boolean().optional() }),
    z.object({ kind: z.literal('textAbsent'), pattern: z.string(), ignoreCase: z.boolean().optional() }),
    z.object({ kind: z.literal('urlMatches'), pattern: z.string() }),
    z.object({ kind: z.literal('valueMatches'), target: targetDescriptorSchema, pattern: z.string() }),
    z.object({ kind: z.literal('all'), of: z.array(conditionSchema).min(1) }),
    z.object({ kind: z.literal('any'), of: z.array(conditionSchema).min(1) }),
    z.object({ kind: z.literal('not'), of: conditionSchema }),
  ]),
) as z.ZodType<Condition>;

export const riskClassSchema: z.ZodType<RiskClass> = z.enum(['safe', 'reversible', 'irreversible']);
export const surfaceKindSchema: z.ZodType<SurfaceKind> = z.enum(['web', 'legacy-web', 'desktop']);

// ---------------------------------------------------------------------------
// Parameters and results -- the calling agent's view
// ---------------------------------------------------------------------------

/**
 * Sensitivity drives redaction, not documentation. It is declared on the
 * parameter rather than inferred from the name because inferring it is how you
 * end up logging a field called `ref2` that happens to hold an account number.
 *
 *   public   - safe to log and to store in evidence
 *   internal - safe to log; not for external egress
 *   pii      - redacted in logs and evidence; passed to the surface only
 *   secret   - never accepted as a literal at all; must arrive as a SecretRef
 */
export const sensitivitySchema = z.enum(['public', 'internal', 'pii', 'secret']);
export type Sensitivity = z.infer<typeof sensitivitySchema>;

export const paramTypeSchema = z.enum(['string', 'number', 'boolean', 'enum', 'money', 'date']);

export const inputParamSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-zA-Z0-9]*$/, 'input names are lowerCamelCase identifiers'),
    type: paramTypeSchema,
    /** Required for type 'enum'. */
    values: z.array(z.string()).min(1).optional(),
    required: z.boolean().default(true),
    description: z.string().min(1),
    sensitivity: sensitivitySchema.default('internal'),
    /** Validated before the browser is even launched. Cheap failures are good failures. */
    pattern: z.string().optional(),
    /** Documentation only, and forbidden on sensitive fields -- see the refine below. */
    example: z.string().optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.type === 'enum' && !v.values?.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `enum input '${v.name}' must declare values` });
    }
    // An "example" is copied into catalogs, prompts and docs. A realistic-looking
    // example of a PII field is how synthetic-looking real data gets committed.
    if (v.example !== undefined && (v.sensitivity === 'pii' || v.sensitivity === 'secret')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `input '${v.name}' is ${v.sensitivity}; examples are not permitted because they propagate into catalogs and prompts`,
      });
    }
    if (v.sensitivity === 'secret' && v.default !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `secret input '${v.name}' cannot have a literal default` });
    }
  });
export type InputParam = z.infer<typeof inputParamSchema>;

export const outputFieldSchema = z.object({
  name: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
  type: paramTypeSchema,
  description: z.string().min(1),
  sensitivity: sensitivitySchema.default('internal'),
  /** False when the field is only populated on some paths through the flow. */
  required: z.boolean().default(true),
});
export type OutputField = z.infer<typeof outputFieldSchema>;

/**
 * The declared vocabulary of non-success results.
 *
 * A caller integrating this capability can switch on `code` exhaustively. If a
 * replay ends in a state that maps to none of these, that is a hard failure by
 * definition -- an undeclared outcome is a gap in the capability, not something
 * to paper over at runtime.
 */
export const businessOutcomeSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'outcome codes are SCREAMING_SNAKE_CASE'),
  description: z.string().min(1),
  /**
   * Guidance for the calling agent: is retrying with different inputs sensible?
   * Encoded because the agent invoking this has no other way to know.
   */
  retryable: z.boolean().default(false),
});

// Note on what used to be here: a `terminal` flag, meaning "the flow can continue
// after this outcome". The engine always treats a business outcome as terminal, so
// the field was declared and never read. On a schema whose whole purpose is to be a
// reviewable contract, a field a reviewer can set and that changes nothing is worse
// than a missing feature -- so it is gone rather than aspirational. Non-terminal
// outcomes would need real support in the step loop, and nothing has asked for them.
export type BusinessOutcomeDecl = z.infer<typeof businessOutcomeSchema>;

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * A value slot in a step. Either a literal, a reference to an input parameter,
 * a reference to a previously captured output, or a reference to a secret held
 * in the runtime vault.
 *
 * `secretRef` exists so that a credential can be *used* by a capability without
 * ever being *in* it. The artifact says "the password named coreOperatorPassword";
 * the vault resolves it at replay time and the value never enters the artifact,
 * the log, or the model's context.
 */
export const valueSourceSchema = z.discriminatedUnion('from', [
  z.object({ from: z.literal('literal'), value: z.string() }),
  z.object({ from: z.literal('input'), name: z.string() }),
  z.object({ from: z.literal('captured'), name: z.string() }),
  z.object({ from: z.literal('secret'), name: z.string() }),
]);
export type ValueSource = z.infer<typeof valueSourceSchema>;

/** Post-processing applied to a captured value before it becomes an output. */
export const extractTransformSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('trim') }),
  /** "$8,241.77" -> 8241.77. Keeps money out of string-land in the result contract. */
  z.object({ kind: z.literal('money') }),
  z.object({ kind: z.literal('number') }),
  z.object({ kind: z.literal('regex'), pattern: z.string(), group: z.number().int().min(0).default(1) }),
]);
export type ExtractTransform = z.infer<typeof extractTransformSchema>;

/**
 * How to respond to a condition being true. This is the error taxonomy made
 * executable, and the three-way split the brief asks for is encoded here in the
 * `then` variants rather than left to convention:
 *
 *   business outcome  -> { do: 'outcome' }
 *   recoverable       -> { do: 'dismiss' | 'retryStep' | 'reauthenticate' }
 *   hard failure      -> { do: 'fail' }
 *   neither, ask a human -> { do: 'escalate' }
 */
export const handlerActionSchema = z.discriminatedUnion('do', [
  /**
   * Classify as a declared business outcome and return it to the caller.
   *
   * (Previously also carried an unimplemented `captureInto`. Removed for the same
   * reason as `terminal`: declared configuration that nothing reads.)
   */
  z.object({ do: z.literal('outcome'), code: z.string() }),
  /** A known interstitial: acknowledge it and re-attempt the step that hit it. */
  z.object({ do: z.literal('dismiss'), target: targetDescriptorSchema, thenRetryStep: z.boolean().default(true) }),
  /** Transient slowness or a lost race. Bounded re-attempt of the same step. */
  z.object({ do: z.literal('retryStep'), maxAttempts: z.number().int().min(1).max(5).default(2), backoffMs: z.number().int().min(0).default(750) }),
  /**
   * Session died mid-run. Re-run the steps flagged `partOfAuth` and resume.
   * Modelled explicitly rather than as a generic retry because a session timeout
   * is the single most common runtime condition in these apps and resuming from
   * the wrong place can re-submit a write.
   */
  z.object({ do: z.literal('reauthenticate'), maxAttempts: z.number().int().min(1).max(3).default(1) }),
  /** Stop and hand the live session to a human. */
  z.object({ do: z.literal('escalate'), reason: z.string().min(1) }),
  /** Stop with a debuggable error. */
  z.object({ do: z.literal('fail'), code: z.string().regex(/^[A-Z][A-Z0-9_]*$/), message: z.string().min(1) }),
]);
export type HandlerAction = z.infer<typeof handlerActionSchema>;

export const handlerSchema = z.object({
  name: z.string().min(1),
  /**
   * A predicate over what is on screen. Optional, because some conditions are not
   * visible in the page at all -- see `whenFailureCode`.
   */
  when: conditionSchema.optional(),
  /**
   * Fire only when the step failed with one of these codes.
   *
   * This exists because `when` alone cannot express the most ordinary runtime
   * condition of all: a page that took longer than the step's budget. There is no
   * text on screen that says "this is still loading" -- the browser is showing the
   * *previous* page, which looks perfectly healthy. Trying to express it as a state
   * condition produced a handler matching `^\s*$` against the visible text, which
   * could never be true once a nav frame had rendered, so it silently never fired.
   *
   * A handler carrying this guard is only ever considered after a failure, never
   * during the pre-step interrupt sweep.
   */
  whenFailureCode: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).min(1).optional(),
  then: handlerActionSchema,
  /**
   * Suppress this handler while a step marked `partOfAuth` is running.
   *
   * Some cross-cutting conditions are only anomalous *outside* sign-on. "The app is
   * showing the sign-on screen" is the definition of being stuck if it happens at
   * step six, and the definition of working correctly if it happens at step one. An
   * interrupt without this distinction fires on every run before it does anything
   * useful, and a handler that always fires gets deleted rather than fixed.
   */
  notDuringAuth: z.boolean().default(false),
}).superRefine((h, ctx) => {
  if (!h.when && !h.whenFailureCode) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `handler '${h.name}' declares neither 'when' nor 'whenFailureCode', so it would fire unconditionally`,
    });
  }
});
export type Handler = z.infer<typeof handlerSchema>;

/** The action of a step. Mirrors surface Action, but values are ValueSources. */
export const stepActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('navigate'), url: z.string() }),
  z.object({ kind: z.literal('click'), target: targetDescriptorSchema }),
  z.object({ kind: z.literal('fill'), target: targetDescriptorSchema, value: valueSourceSchema }),
  z.object({ kind: z.literal('select'), target: targetDescriptorSchema, value: valueSourceSchema }),
  z.object({ kind: z.literal('press'), key: z.string() }),
  z.object({ kind: z.literal('readText'), target: targetDescriptorSchema }),
  z.object({ kind: z.literal('waitFor'), condition: conditionSchema, timeoutMs: z.number().int().min(0).optional() }),
  z.object({ kind: z.literal('assert'), condition: conditionSchema }),
]);
export type StepAction = z.infer<typeof stepActionSchema>;

export const stepSchema = z
  .object({
    // A leading digit is allowed because the recorder prefixes an ordinal
    // ('01-fill-member-id'). Step order is semantic here, and having it visible in
    // the id makes a review diff of a capability far easier to follow.
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'step ids are kebab-case and stable; overlays reference them'),
    /**
     * What this step is for, in the operator's words. Written by the model during
     * discovery. This is what makes a capability reviewable by someone who was
     * not there, and what a failure message quotes.
     */
    intent: z.string().min(1),
    action: stepActionSchema,
    risk: riskClassSchema.default('safe'),
    /** Marks the step as part of sign-on, so `reauthenticate` knows what to replay. */
    partOfAuth: z.boolean().default(false),
    /** Must hold before acting. Usually cheaper than a checkpoint and catches drift early. */
    precondition: conditionSchema.optional(),
    /**
     * Must hold after acting. This is the assertion that turns "I clicked" into
     * "the click did what I meant". A step without one is a step that cannot
     * detect its own failure, so the recorder always writes one for navigations.
     */
    checkpoint: conditionSchema.optional(),
    /** For readText: the output field this populates. */
    captureAs: z.string().optional(),
    transform: extractTransformSchema.optional(),
    timeoutMs: z.number().int().min(0).default(10_000),
    /** Step-scoped handlers, evaluated before the capability-level interrupts. */
    handlers: z.array(handlerSchema).default([]),
  })
  .superRefine((v, ctx) => {
    if (v.action.kind === 'readText' && !v.captureAs) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `step '${v.id}' reads text but declares no captureAs` });
    }
    if (v.captureAs && v.action.kind !== 'readText') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `step '${v.id}' declares captureAs but its action does not read anything` });
    }
  });
export type Step = z.infer<typeof stepSchema>;

// ---------------------------------------------------------------------------
// Cross-tenant overlays
// ---------------------------------------------------------------------------

/**
 * How one recording serves many institutions.
 *
 * The observation this is built on: when hundreds of tenants run the same vendor
 * product, what actually differs between them is overwhelmingly (a) field and
 * button labels, (b) route paths, and (c) extra mandated interstitials. The
 * *shape* of the flow -- search, open the record, read the field -- is the
 * vendor's, and it is the same everywhere.
 *
 * So an overlay is not a fork of the steps. It is a small, reviewable diff
 * against the base capability, and `applyOverlay` produces the effective
 * capability deterministically. A tenant that needs more than an overlay is a
 * signal worth having: it means the products have genuinely diverged, and
 * re-recording is the honest answer.
 */
export const overlaySchema = z.object({
  tenantId: z.string().min(1),
  /** Semver range of the vendor build this overlay is known good against. */
  productVersion: z.string().optional(),
  description: z.string().min(1),
  /**
   * Applied to every `role-name`, `labelled-field`, `text` and `table-cell`
   * strategy in the base steps. 'Member ID' -> 'Account Holder #'.
   */
  labelAliases: z.record(z.string(), z.string()).default({}),
  /** Applied to navigate urls and urlMatches patterns. */
  routeAliases: z.record(z.string(), z.string()).default({}),
  /** Extra always-on handlers, e.g. a compliance terms gate this tenant added. */
  extraInterrupts: z.array(handlerSchema).default([]),
  /** Escape hatch for the residue an alias map cannot express. */
  stepPatches: z
    .array(
      z.object({
        stepId: z.string(),
        skip: z.boolean().optional(),
        target: targetDescriptorSchema.optional(),
        value: valueSourceSchema.optional(),
        checkpoint: conditionSchema.optional(),
      }),
    )
    .default([]),
});
export type Overlay = z.infer<typeof overlaySchema>;

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export const capabilityPolicySchema = z.object({
  /**
   * Regexes the capability may navigate to. Enforced by the policy gate on every
   * action, in discovery and in replay, not merely documented here.
   */
  allowedUrlPatterns: z.array(z.string()).min(1),
  deniedUrlPatterns: z.array(z.string()).optional(),
  allowedActions: z.array(z.enum(['navigate', 'click', 'fill', 'select', 'press', 'readText', 'waitFor', 'assert'])),
  /** The highest risk class any step in this capability is permitted to be. */
  maxRisk: riskClassSchema,
  /**
   * When true, an unattended replay refuses to run irreversible steps unless the
   * caller passes an explicit authorization. See replay/engine.ts.
   */
  requiresApprovalForIrreversible: z.boolean().default(true),
});
export type CapabilityPolicy = z.infer<typeof capabilityPolicySchema>;

// ---------------------------------------------------------------------------
// Lifecycle and provenance
// ---------------------------------------------------------------------------

export const lifecycleSchema = z.object({
  /**
   * draft      - replayable by a human on demand; never unattended
   * approved   - a reviewer has read the steps and accepted the blast radius
   * deprecated - kept for audit; the catalog hides it
   */
  state: z.enum(['draft', 'approved', 'deprecated']).default('draft'),
  approvedBy: z.string().optional(),
  approvedAt: z.string().optional(),
  /** Populated by repeated replays. Feeds the confidence signal, not a gate by itself. */
  stability: z
    .object({
      runs: z.number().int().min(0).default(0),
      successes: z.number().int().min(0).default(0),
      lastRunAt: z.string().optional(),
      consecutiveFailures: z.number().int().min(0).default(0),
      /** Times a non-primary locator strategy won. The drift early-warning. */
      fallbackHits: z.number().int().min(0).default(0),
    })
    .default({ runs: 0, successes: 0, consecutiveFailures: 0, fallbackHits: 0 }),
});
export type Lifecycle = z.infer<typeof lifecycleSchema>;

export const provenanceSchema = z.object({
  recordedAt: z.string(),
  recordedBy: z.string(),
  discoveryRunId: z.string(),
  /** Model identity, for the audit question "what wrote this". */
  model: z.string(),
  modelTurns: z.number().int().min(0),
  /**
   * SHA-256 of the discovery transcript, which lives in access-controlled
   * evidence storage and NOT here. The digest is enough to prove which
   * transcript produced this artifact without carrying member data around.
   */
  transcriptDigest: z.string(),
  /** Asserted by the recorder; the linter re-checks it rather than trusting it. */
  redactionApplied: z.literal(true),
  toolVersion: z.string(),
  /** Set when a human took over during discovery. Reviewers need to know. */
  humanInterventions: z.number().int().min(0).default(0),
});
export type Provenance = z.infer<typeof provenanceSchema>;

// ---------------------------------------------------------------------------
// The capability
// ---------------------------------------------------------------------------

export const capabilitySchema = z
  .object({
    schemaVersion: z.string(),
    /** Stable across versions. What a calling agent invokes by name. */
    id: z.string().regex(/^[a-z][a-z0-9.-]*$/, 'capability ids are dotted kebab-case, e.g. member.read-savings-balance'),
    version: z.string().regex(/^\d+\.\d+\.\d+$/, 'capability versions are semver'),
    name: z.string().min(1),
    /** One line. This is what the agent sees in the catalog before choosing. */
    summary: z.string().min(1).max(200),
    description: z.string().min(1),

    target: z.object({
      /** Shared by every tenant running this vendor build. The reuse key. */
      productId: z.string().min(1),
      productVersion: z.string().optional(),
      /** The tenant this was RECORDED against. Overlays cover the others. */
      recordedTenantId: z.string().min(1),
      surfaceKind: surfaceKindSchema,
      /**
       * Entry point with the host factored out, e.g. '{{baseUrl}}/login.aspx'.
       * A capability that hard-coded localhost:4173 would be a capability that
       * only works in the environment it was recorded in.
       */
      entryUrl: z.string().min(1),
    }),

    inputs: z.array(inputParamSchema).default([]),
    outputs: z.array(outputFieldSchema).default([]),
    outcomes: z.array(businessOutcomeSchema).default([]),

    steps: z.array(stepSchema).min(1),

    /** The assertion that the goal was actually achieved. Not optional. */
    success: z.object({
      description: z.string().min(1),
      checkpoint: conditionSchema,
    }),

    /**
     * Handlers evaluated before every step, not attached to one.
     *
     * Session expiry, an app error page, and a randomly-injected system notice
     * are not properties of step 4. They can happen anywhere, and a schema that
     * only allows per-step handlers forces the recorder to copy them onto every
     * step, where they will inevitably be copied inconsistently.
     */
    interrupts: z.array(handlerSchema).default([]),

    policy: capabilityPolicySchema,
    lifecycle: lifecycleSchema.default({ state: 'draft', stability: { runs: 0, successes: 0, consecutiveFailures: 0, fallbackHits: 0 } }),
    provenance: provenanceSchema,
    overlays: z.array(overlaySchema).default([]),
  })
  .superRefine((cap, ctx) => {
    const at = (path: (string | number)[], message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

    // Referential integrity. These are the mistakes a generated artifact
    // actually makes, and catching them at load time rather than at step 7 of a
    // replay against a live banking screen is the entire point of validating.
    const inputNames = new Set(cap.inputs.map((i) => i.name));
    const outputNames = new Set(cap.outputs.map((o) => o.name));
    const outcomeCodes = new Set(cap.outcomes.map((o) => o.code));
    const stepIds = new Set<string>();

    cap.steps.forEach((step, i) => {
      if (stepIds.has(step.id)) at(['steps', i, 'id'], `duplicate step id '${step.id}'`);
      stepIds.add(step.id);

      const v = 'value' in step.action ? step.action.value : undefined;
      if (v?.from === 'input' && !inputNames.has(v.name)) at(['steps', i, 'action', 'value'], `references undeclared input '${v.name}'`);
      if (v?.from === 'captured' && !outputNames.has(v.name)) at(['steps', i, 'action', 'value'], `references undeclared capture '${v.name}'`);

      if (step.captureAs && !outputNames.has(step.captureAs)) at(['steps', i, 'captureAs'], `captures into undeclared output '${step.captureAs}'`);

      if (!cap.policy.allowedActions.includes(step.action.kind)) {
        at(['steps', i, 'action', 'kind'], `action '${step.action.kind}' is not in the capability's allowedActions`);
      }
      if (riskRank(step.risk) > riskRank(cap.policy.maxRisk)) {
        at(['steps', i, 'risk'], `step risk '${step.risk}' exceeds the capability's maxRisk '${cap.policy.maxRisk}'`);
      }

      step.handlers.forEach((h, j) => {
        if (h.then.do === 'outcome' && !outcomeCodes.has(h.then.code)) {
          at(['steps', i, 'handlers', j, 'then', 'code'], `handler resolves to undeclared outcome '${h.then.code}'`);
        }
      });
    });

    cap.interrupts.forEach((h, j) => {
      if (h.then.do === 'outcome' && !outcomeCodes.has(h.then.code)) {
        at(['interrupts', j, 'then', 'code'], `interrupt resolves to undeclared outcome '${h.then.code}'`);
      }
    });

    // Every declared required output must actually be produced by some step.
    // Without this check a capability can advertise a return value it never fills.
    const captured = new Set(cap.steps.map((s) => s.captureAs).filter(Boolean) as string[]);
    cap.outputs.forEach((o, i) => {
      if (o.required && !captured.has(o.name)) {
        at(['outputs', i, 'name'], `output '${o.name}' is required but no step captures it`);
      }
    });

    // Overlay patches must reference real steps, or an overlay silently no-ops
    // and a tenant quietly runs the un-adapted flow.
    cap.overlays.forEach((ov, i) => {
      ov.stepPatches.forEach((p, j) => {
        if (!stepIds.has(p.stepId)) at(['overlays', i, 'stepPatches', j, 'stepId'], `patches unknown step '${p.stepId}'`);
      });
    });

    // Note on what is deliberately NOT checked here: whether a capability that
    // required human intervention during discovery should be allowed to reach the
    // 'approved' state. That is a review judgment, and encoding it as a schema
    // error would make such an artifact unparseable -- so it could never be
    // approved at all, no matter what a reviewer decided. It belongs in the linter,
    // which advises, not in validation, which refuses. See lintCapability.
  });

export type Capability = z.infer<typeof capabilitySchema>;

export function riskRank(r: RiskClass): number {
  return r === 'safe' ? 0 : r === 'reversible' ? 1 : 2;
}

/**
 * The vault credentials a capability needs in order to run.
 *
 * One definition, used by the replay engine's pre-flight check and by the catalog's
 * `requiredSecrets`. Previously the catalog derived this inline and the engine did not
 * derive it at all, which is how a missing credential came to be discovered halfway
 * through a run instead of before it started.
 */
export function requiredSecretNames(cap: Capability): string[] {
  return [
    ...new Set(
      cap.steps
        .map((s) => ('value' in s.action && s.action.value.from === 'secret' ? s.action.value.name : undefined))
        .filter((n): n is string => Boolean(n)),
    ),
  ].sort();
}

/** Narrowing helper used by the replay engine and the policy gate. */
export function stepTarget(action: StepAction): TargetDescriptor | undefined {
  return 'target' in action ? action.target : undefined;
}

/** Turn a validated StepAction into a surface Action, given resolved values. */
export function toSurfaceAction(action: StepAction, resolvedValue?: string): Action {
  switch (action.kind) {
    case 'navigate':
      return { kind: 'navigate', url: action.url };
    case 'click':
      return { kind: 'click', target: action.target };
    case 'fill':
      return { kind: 'fill', target: action.target, value: resolvedValue ?? '' };
    case 'select':
      return { kind: 'select', target: action.target, value: resolvedValue ?? '' };
    case 'press':
      return { kind: 'press', key: action.key };
    case 'readText':
      return { kind: 'readText', target: action.target };
    case 'waitFor':
      return action.timeoutMs === undefined
        ? { kind: 'waitFor', condition: action.condition }
        : { kind: 'waitFor', condition: action.condition, timeoutMs: action.timeoutMs };
    case 'assert':
      return { kind: 'assert', condition: action.condition };
  }
}

export type { ControlRole };
