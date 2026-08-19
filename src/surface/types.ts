/**
 * The surface seam.
 *
 * Everything above this file -- the discovery agent, the capability artifact,
 * the replay engine -- speaks only in the vocabulary defined here: normalised
 * control roles, semantic target strategies, declarative conditions, and
 * surface-agnostic actions. Nothing above this file may mention Playwright, a
 * CSS selector, or a pixel coordinate.
 *
 * That constraint is the whole design. It is what lets the same artifact and the
 * same replay engine drive a modern web app, a 2004 frameset, or (via an
 * accessibility-API driver) a native desktop application, because all three can
 * answer the same question: "what controls are here, and what are they called?"
 *
 * The concrete web implementation lives in ./web. A documented desktop stub
 * lives in ./desktop to prove the seam holds.
 */

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

export type SurfaceKind = 'web' | 'legacy-web' | 'desktop';

/**
 * Normalised control roles. Intentionally a small closed set: this is the
 * intersection of what a browser accessibility tree, a legacy DOM, and a
 * platform accessibility API can all reliably report. Anything richer would not
 * survive the jump to desktop.
 */
export const CONTROL_ROLES = [
  'button',
  'link',
  'textbox',
  'password',
  'combobox',
  'checkbox',
  'radio',
  'heading',
  'text',
  'cell',
  'row',
  'table',
  'image',
  'frame',
  'unknown',
] as const;
export type ControlRole = (typeof CONTROL_ROLES)[number];

/**
 * How a control's name was arrived at. Recorded because it is the single best
 * predictor of how durable a `role-name` target will be: a name from `aria-label`
 * is authored and stable; a name synthesised from an adjacent table cell is a
 * guess, and replay should keep a fallback ready.
 */
export type NameSource =
  | 'aria-label'
  | 'aria-labelledby'
  | 'label-for'
  | 'label-wrapping'
  | 'value'
  | 'text-content'
  | 'placeholder'
  | 'title'
  | 'alt'
  /** Synthesised: label text sat in a sibling table cell with no `for=`. */
  | 'adjacent-cell'
  /** Synthesised: nearest preceding text on the same visual line. */
  | 'preceding-text'
  /** Synthesised from the table column this cell sits under. */
  | 'column-header'
  | 'none';

/** Where a control sits, expressed without reference to markup. */
export interface ContainerPath {
  /**
   * Named frame chain from the top document, e.g. ['bodyFrame'].
   * Frames are first-class here rather than an afterthought because the target
   * environment is full of framesets, and "which document am I in" is the most
   * common reason naive automation silently fails.
   */
  framePath: string[];
  /** Nearest preceding section/group heading, e.g. 'SHARE / DEPOSIT ACCOUNTS'. */
  section?: string;
  /** Tabular position, when the control sits in a table. */
  table?: {
    /** Nearest heading above the table, used to disambiguate multiple tables. */
    near?: string;
    rowIndex?: number;
    colIndex?: number;
    /** Text of the header cell for this column. */
    columnHeader?: string;
    /** Text of the first cell in this row -- the natural row identity. */
    rowKey?: string;
  };
}

// ---------------------------------------------------------------------------
// Targeting
// ---------------------------------------------------------------------------

export type NameMatch = 'exact' | 'normalized' | 'contains' | 'regex';

/**
 * A single way to find a control again.
 *
 * Strategies are ordered by durability, not convenience. `role-name` first
 * because an accessible name is the closest thing to the operator's own mental
 * model of the screen ("the Search button"), and it is the one thing every
 * surface kind can express. `dom-hint` last because a WebForms control id is
 * exactly the kind of thing that changes between two tenants running the same
 * vendor build.
 */
export type TargetStrategy =
  /** Role + accessible name. Portable across web, legacy web, and desktop. */
  | { kind: 'role-name'; role: ControlRole; name: string; nameMatch: NameMatch }
  /**
   * A form field identified by its visible label, where that label is NOT
   * programmatically associated (no `for=`, no aria-labelledby). The dominant
   * pattern in legacy enterprise forms and the reason `role-name` alone is not
   * enough.
   */
  | { kind: 'labelled-field'; label: string; labelMatch: NameMatch; role: ControlRole }
  /** Any element carrying this text. Good for links and static assertions. */
  | { kind: 'text'; text: string; textMatch: NameMatch; role?: ControlRole }
  /**
   * A data cell addressed the way a human reads a report: "the Current Balance
   * column of the row whose first cell is 12345-00". Survives column reordering
   * and row reordering, which index-based cell targeting does not.
   */
  | { kind: 'table-cell'; near?: string; rowKey: string; rowKeyMatch: NameMatch; columnHeader: string }
  /** The nth control of a role within a named section. A weak but real fallback. */
  | { kind: 'section-ordinal'; section: string; role: ControlRole; index: number }
  /**
   * A raw markup hint. Recorded for diagnostics and as a last resort, never
   * preferred. Web-only by construction, which is why it is fenced off in its
   * own strategy kind rather than smuggled into the others.
   */
  | { kind: 'dom-hint'; css: string }
  /**
   * Offset from a named visual anchor. The escape hatch for surfaces with no
   * queryable tree at all (screenshot-only control, canvas-rendered apps, some
   * Win32 dialogs). Not used by the web driver; present so the schema does not
   * have to change when a screenshot driver is added.
   */
  | { kind: 'anchor-offset'; anchorText: string; dx: number; dy: number };

export type TargetStrategyKind = TargetStrategy['kind'];

/**
 * How the artifact refers to a control: a human-readable description plus an
 * ordered list of ways to find it. Replay walks the list until one resolves
 * unambiguously, and reports which one won -- a fallback firing is the earliest
 * available signal of tenant or version drift.
 */
export interface TargetDescriptor {
  /** For humans reviewing the capability and for error messages. */
  description: string;
  /** Which document the control lives in. */
  framePath?: string[];
  /** Ordered most-durable-first. */
  strategies: TargetStrategy[];
}

// ---------------------------------------------------------------------------
// Perception
// ---------------------------------------------------------------------------

export interface PerceivedControl {
  /**
   * Handle valid only within the observation that produced it. Formatted
   * `<generation>:<n>` so a stale reference is detected rather than silently
   * acting on whatever now occupies that slot.
   */
  ref: string;
  role: ControlRole;
  name: string;
  nameSource: NameSource;
  value?: string;
  disabled?: boolean;
  checked?: boolean;
  readonly?: boolean;
  container: ContainerPath;
  /** Candidate strategies for re-finding this control, most durable first. */
  targeting: TargetStrategy[];
  /** Viewport-relative box, for screenshot-based drivers and evidence overlays. */
  box?: { x: number; y: number; width: number; height: number };
}

export interface Observation {
  /** Monotonic per-session; embedded in every ref. */
  generation: number;
  at: string;
  url: string;
  title: string;
  /** All frames in the document tree, in traversal order. */
  frames: { path: string[]; url: string }[];
  controls: PerceivedControl[];
  /**
   * Structural section headings, across all frames.
   *
   * Identified by styling rather than by tag name, because the apps this targets
   * have no <h1> -- they have a bold cell with a grey background. These are the most
   * stable strings on a screen and the best basis for a checkpoint.
   */
  headings: string[];
  /** Visible text of the surface, normalised. Used for `textPresent` conditions. */
  text: string;
  /** Present when the driver was asked for one. Path on disk, never inline base64 in logs. */
  screenshotPath?: string;
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

/**
 * A declarative predicate over surface state.
 *
 * Deliberately data, not code. Conditions are authored by the model during
 * discovery, stored verbatim in the artifact, reviewed by a human, and evaluated
 * by the replay engine. If they were snippets of JavaScript the artifact would
 * be unreviewable, unportable to a desktop surface, and an arbitrary-code-
 * execution hole in a system that runs inside banks.
 */
export type Condition =
  | { kind: 'controlPresent'; target: TargetDescriptor }
  | { kind: 'controlAbsent'; target: TargetDescriptor }
  | { kind: 'textPresent'; pattern: string; ignoreCase?: boolean }
  | { kind: 'textAbsent'; pattern: string; ignoreCase?: boolean }
  | { kind: 'urlMatches'; pattern: string }
  | { kind: 'valueMatches'; target: TargetDescriptor; pattern: string }
  | { kind: 'all'; of: Condition[] }
  | { kind: 'any'; of: Condition[] }
  | { kind: 'not'; of: Condition };

export interface ConditionResult {
  satisfied: boolean;
  /** Human-readable account of what was actually observed. Goes into failures. */
  observed: string;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Risk classification. Assigned by policy, not by the model, and carried on
 * every step of the artifact so a reviewer can see the blast radius of a
 * capability without reading its steps.
 */
export type RiskClass =
  /** Reads and navigation. No state change. */
  | 'safe'
  /** Changes UI state but nothing durable, e.g. typing into a field. */
  | 'reversible'
  /** Writes durable state or moves money. Requires explicit authorisation. */
  | 'irreversible';

export type Action =
  | { kind: 'navigate'; url: string }
  | { kind: 'click'; target: TargetDescriptor }
  | { kind: 'fill'; target: TargetDescriptor; value: string }
  | { kind: 'select'; target: TargetDescriptor; value: string }
  | { kind: 'press'; key: string }
  | { kind: 'readText'; target: TargetDescriptor }
  | { kind: 'waitFor'; condition: Condition; timeoutMs?: number }
  | { kind: 'assert'; condition: Condition };

export type ActionKind = Action['kind'];

export interface ActionResult {
  ok: boolean;
  /** For readText. */
  value?: string;
  /** Which strategy resolved the target, if any. Drives the drift signal. */
  strategyUsed?: TargetStrategy;
  /** Index of the winning strategy in the descriptor's list. >0 means a fallback fired. */
  strategyIndex?: number;
  /** Set when !ok. */
  error?: { code: SurfaceErrorCode; message: string; observed?: string };
  /** True when the action caused a document load. */
  navigated?: boolean;
}

export type SurfaceErrorCode =
  /** No strategy in the descriptor matched anything. */
  | 'TARGET_NOT_FOUND'
  /** A strategy matched more than one control and could not be narrowed. */
  | 'TARGET_AMBIGUOUS'
  /** Matched, but not actionable (hidden, disabled, covered). */
  | 'TARGET_NOT_ACTIONABLE'
  /** The ref handed in belongs to an older observation. */
  | 'STALE_REF'
  /** Condition did not hold within its budget. */
  | 'CONDITION_TIMEOUT'
  /** The surface itself misbehaved (crash, closed page, driver fault). */
  | 'SURFACE_FAULT'
  /**
   * Refused by the policy gate. Present on SurfaceErrorCode rather than in a
   * separate channel because the gate *is* a Surface -- everything above it sees
   * one uniform failure type, and there is no path that reaches a real surface
   * without passing through the gate.
   */
  | 'POLICY_DENIED'
  /** Irreversible action that a human has not authorised. Distinct from a flat denial. */
  | 'POLICY_AUTHORIZATION_REQUIRED';

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export type Resolution =
  | {
      ok: true;
      ref: string;
      control: PerceivedControl;
      strategyUsed: TargetStrategy;
      strategyIndex: number;
      /** Other controls the winning strategy also matched. Non-empty = ambiguity we broke by rule. */
      alsoMatched: PerceivedControl[];
    }
  | {
      ok: false;
      code: Extract<SurfaceErrorCode, 'TARGET_NOT_FOUND' | 'TARGET_AMBIGUOUS' | 'TARGET_NOT_ACTIONABLE'>;
      /** Per-strategy account of why each one failed. This is what makes a failure debuggable. */
      attempts: { strategy: TargetStrategy; matched: number; note?: string }[];
    };

// ---------------------------------------------------------------------------
// Driver contract
// ---------------------------------------------------------------------------

export interface ObserveOptions {
  /** Capture a screenshot alongside the tree. Costs ~100ms; off by default. */
  screenshot?: boolean;
  /** Restrict perception to one frame. */
  framePath?: string[];
}

export interface Surface {
  readonly kind: SurfaceKind;
  /** Stable id for the live session, so an operator can be pointed at it. */
  readonly sessionId: string;

  observe(opts?: ObserveOptions): Promise<Observation>;
  resolve(target: TargetDescriptor): Promise<Resolution>;
  perform(action: Action): Promise<ActionResult>;
  evaluate(condition: Condition, opts?: { timeoutMs?: number }): Promise<ConditionResult>;

  /** Current location, cheaply. */
  location(): Promise<{ url: string; title: string }>;

  /** Failure evidence. Both are best-effort and must never throw. */
  screenshot(path: string, opts?: { maskSensitive?: boolean }): Promise<string | undefined>;
  sourceSnapshot(path: string): Promise<string | undefined>;

  close(): Promise<void>;
}
