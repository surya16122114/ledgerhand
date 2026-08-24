/**
 * Input validation and value resolution.
 *
 * Validation happens before the browser launches. That ordering is worth stating:
 * a bad member id should cost a millisecond and produce a precise message, not
 * cost a browser launch, a sign-on, and four screens before the app says
 * something vague. It also means a caller integrating the capability gets the
 * same error whether or not the target app is up.
 */

import type { Capability, Condition, InputParam, TargetDescriptor, TargetStrategy, ValueSource } from '../artifact/index-types.js';
import type { SecretVault } from '../policy/vault.js';
import { escapeRegExp } from '../util/regex.js';

export type InputValue = string | number | boolean;

export interface InputValidationError {
  name: string;
  message: string;
}

export interface ValidatedInputs {
  values: Record<string, InputValue>;
  /** Values the caller supplied for parameters declared pii/secret. Feeds the redactor. */
  sensitive: Record<string, string>;
}

export function validateInputs(cap: Capability, provided: Record<string, unknown>): { ok: true; inputs: ValidatedInputs } | { ok: false; errors: InputValidationError[] } {
  const errors: InputValidationError[] = [];
  const values: Record<string, InputValue> = {};
  const sensitive: Record<string, string> = {};

  const declared = new Map(cap.inputs.map((i) => [i.name, i]));
  for (const key of Object.keys(provided)) {
    if (!declared.has(key)) {
      // Rejected rather than ignored: silently dropping an argument the caller
      // thought mattered is how a replay runs against the wrong member.
      errors.push({ name: key, message: `'${key}' is not an input of ${cap.id}. Declared inputs: ${[...declared.keys()].join(', ') || '(none)'}` });
    }
  }

  for (const param of cap.inputs) {
    const raw = provided[param.name] ?? param.default;
    if (raw === undefined || raw === '') {
      if (param.required) errors.push({ name: param.name, message: `required input '${param.name}' (${param.type}) was not supplied` });
      continue;
    }
    const coerced = coerce(param, raw);
    if ('error' in coerced) {
      errors.push({ name: param.name, message: coerced.error });
      continue;
    }
    if (param.pattern) {
      let re: RegExp | undefined;
      try {
        re = new RegExp(param.pattern);
      } catch {
        errors.push({ name: param.name, message: `input '${param.name}' declares an invalid pattern /${param.pattern}/` });
      }
      if (re && !re.test(String(coerced.value))) {
        // The offending value is not echoed: it may be the PII this check exists to guard.
        errors.push({ name: param.name, message: `input '${param.name}' does not match the required format /${param.pattern}/` });
      }
    }
    if (param.type === 'enum' && param.values && !param.values.includes(String(coerced.value))) {
      errors.push({ name: param.name, message: `input '${param.name}' must be one of: ${param.values.join(', ')}` });
      continue;
    }
    values[param.name] = coerced.value;
    if (param.sensitivity === 'pii' || param.sensitivity === 'secret') sensitive[param.name] = String(coerced.value);
  }

  return errors.length ? { ok: false, errors } : { ok: true, inputs: { values, sensitive } };
}

function coerce(param: InputParam, raw: unknown): { value: InputValue } | { error: string } {
  switch (param.type) {
    case 'number':
    case 'money': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[$,\s]/g, ''));
      if (!Number.isFinite(n)) return { error: `input '${param.name}' must be a ${param.type}` };
      return { value: n };
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return { value: raw };
      const s = String(raw).toLowerCase();
      if (['true', '1', 'yes', 'y'].includes(s)) return { value: true };
      if (['false', '0', 'no', 'n'].includes(s)) return { value: false };
      return { error: `input '${param.name}' must be a boolean` };
    }
    case 'date': {
      const s = String(raw);
      if (Number.isNaN(Date.parse(s))) return { error: `input '${param.name}' must be a parseable date` };
      return { value: s };
    }
    default:
      return { value: String(raw) };
  }
}

export interface ValueContext {
  inputs: Record<string, InputValue>;
  captured: Record<string, InputValue>;
  vault: SecretVault;
}

/**
 * Resolve a step's value slot.
 *
 * Returns the value *and* whether it is secret, so the caller can decide what may
 * be logged. Returning a bare string here and hoping the log site remembers would
 * be the wrong shape.
 */
export function resolveValue(source: ValueSource, ctx: ValueContext): { value: string; secret: boolean } {
  switch (source.from) {
    case 'literal':
      return { value: source.value, secret: false };
    case 'input': {
      const v = ctx.inputs[source.name];
      if (v === undefined) throw new Error(`step references input '${source.name}', which has no value`);
      return { value: String(v), secret: false };
    }
    case 'captured': {
      const v = ctx.captured[source.name];
      if (v === undefined) throw new Error(`step references captured value '${source.name}', which no earlier step produced`);
      return { value: String(v), secret: false };
    }
    case 'secret':
      return { value: ctx.vault.get(source.name), secret: true };
  }
}

/** `{{baseUrl}}` and `{{input.name}}` substitution for navigation urls. */
export function renderTemplate(template: string, ctx: { baseUrl: string; inputs: Record<string, InputValue> }): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, key: string) => {
    if (key === 'baseUrl') return ctx.baseUrl.replace(/\/$/, '');
    if (key.startsWith('input.')) {
      const name = key.slice('input.'.length);
      const v = ctx.inputs[name];
      if (v === undefined) throw new Error(`template references undefined input '${name}'`);
      return encodeURIComponent(String(v));
    }
    throw new Error(`template references unknown placeholder '{{${key}}}'`);
  });
}

/**
 * Substitute `{{input.name}}` placeholders inside a target descriptor.
 *
 * Necessary because record-time data leaks into *targets*, not only into values.
 * A table cell addressed as "the Current Balance column of the row whose key is
 * 12345-00" embeds the member used during recording. Parameterising fill values but
 * not targets produces a capability that is parameterized in name only.
 *
 * Its absence has a specific and nasty failure mode. With the row key pinned to one
 * member, replay for a different member falls through to a weaker strategy and can
 * resolve to a *neighbouring account's* cell -- returning a number that is real,
 * plausible, and wrong. Failing is much better than that, and being correctly
 * parameterized is better still.
 */
export function materialiseTarget(target: TargetDescriptor, inputs: Record<string, InputValue>): TargetDescriptor {
  const sub = (s: string): string =>
    s.replace(/\{\{\s*input\.([a-zA-Z0-9_]+)\s*\}\}/g, (_m, name: string) => {
      const v = inputs[name];
      if (v === undefined) throw new Error(`target '${target.description}' references input '${name}', which has no value`);
      return String(v);
    });

  return {
    ...target,
    description: sub(target.description),
    strategies: target.strategies.map((st): TargetStrategy => {
      switch (st.kind) {
        case 'role-name':
          return { ...st, name: sub(st.name) };
        case 'labelled-field':
          return { ...st, label: sub(st.label) };
        case 'text':
          return { ...st, text: sub(st.text) };
        case 'table-cell':
          return { ...st, rowKey: sub(st.rowKey), columnHeader: sub(st.columnHeader), ...(st.near ? { near: sub(st.near) } : {}) };
        case 'section-ordinal':
          return { ...st, section: sub(st.section) };
        case 'dom-hint':
          return { ...st, css: sub(st.css) };
        case 'anchor-offset':
          return { ...st, anchorText: sub(st.anchorText) };
      }
    }),
  };
}

/** Recursively materialise every target inside a condition. */
export function materialiseCondition(condition: Condition, inputs: Record<string, InputValue>): Condition {
  switch (condition.kind) {
    case 'controlPresent':
    case 'controlAbsent':
      return { ...condition, target: materialiseTarget(condition.target, inputs) };
    case 'valueMatches':
      return { ...condition, target: materialiseTarget(condition.target, inputs) };
    case 'all':
    case 'any':
      return { ...condition, of: condition.of.map((c) => materialiseCondition(c, inputs)) };
    case 'not':
      return { ...condition, of: materialiseCondition(condition.of, inputs) };
    default:
      return condition;
  }
}

/**
 * Substitute `{{baseUrl}}` into a *regex* pattern.
 *
 * Distinct from `renderTemplate` on purpose, and the distinction is not cosmetic:
 * the value being substituted is a URL, and a URL is full of regex metacharacters
 * (`.` and `:` at minimum). Interpolating it raw would produce a pattern where
 * `localhost:4173` matches `localhostX4173`, which is a permissive allowlist --
 * the one direction you never want to be wrong in. So the substituted value is
 * regex-escaped on the way in, while the surrounding pattern is left as authored.
 */
export function renderUrlPattern(pattern: string, baseUrl: string): string {
  return pattern.replace(/\{\{\s*baseUrl\s*\}\}/g, escapeRegExp(baseUrl.replace(/\/$/, '')));
}


/** Apply a declared transform to a captured string. */
export function applyTransform(raw: string, transform: { kind: string; pattern?: string; group?: number } | undefined): InputValue {
  if (!transform) return raw.trim();
  switch (transform.kind) {
    case 'trim':
      return raw.trim();
    // Both numeric transforms require at least one digit in the source before
    // converting. Stripping non-numeric characters from "not money" leaves the
    // empty string, and Number('') is 0 -- so without this guard a failed read
    // reports a balance of $0.00, which is a far worse outcome for a banking
    // caller than an explicit error.
    case 'money': {
      if (!/\d/.test(raw)) throw new Error(`could not read a money value from '${raw}'`);
      const n = Number(raw.replace(/[^0-9.-]/g, ''));
      if (!Number.isFinite(n)) throw new Error(`could not read a money value from '${raw}'`);
      return n;
    }
    case 'number': {
      if (!/\d/.test(raw)) throw new Error(`could not read a number from '${raw}'`);
      const n = Number(raw.replace(/[^0-9.eE+-]/g, ''));
      if (!Number.isFinite(n)) throw new Error(`could not read a number from '${raw}'`);
      return n;
    }
    case 'regex': {
      const re = new RegExp(transform.pattern ?? '');
      const m = re.exec(raw);
      if (!m) throw new Error(`captured text did not match /${transform.pattern}/`);
      return m[transform.group ?? 1] ?? m[0]!;
    }
    default:
      return raw.trim();
  }
}
