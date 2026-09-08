/**
 * Redaction.
 *
 * Applied at exactly two boundaries -- the structured logger and the artifact
 * writer -- rather than sprinkled through the code. Anything that reaches those
 * two chokepoints is scrubbed; nothing else is responsible for remembering to.
 *
 * Two layers, because they fail differently:
 *
 *  1. **Known values.** Every secret in the vault and every input the caller
 *     declared as `pii` or `secret` is replaced by an explicit token. This is
 *     exact and complete for the data we were handed.
 *
 *  2. **Shape patterns.** SSNs, card numbers, long account-number-shaped digit
 *     runs, tokens. This catches the data we were *not* handed -- values read off
 *     the screen into an observation, a model's paraphrase of a member record, an
 *     error message that quotes a row. In this domain that is the larger risk,
 *     because the automation reads far more regulated data than it is given.
 *
 * The tokens keep the field name so a log stays debuggable: seeing
 * `[pii:memberId]` tells you the shape of what happened without telling you who
 * it happened to.
 */

export interface RedactorOptions {
  /** Exact values to remove. Vault secrets plus sensitive input values. */
  secrets?: string[];
  /** name -> value, for labelled tokens. */
  labelled?: Record<string, string>;
  /** Set false only in a test that is asserting on raw content. */
  patternScrubbing?: boolean;
}

interface ShapeRule {
  name: string;
  re: RegExp;
  replace: (m: string) => string;
}

/**
 * Order matters: the most specific shapes run first, so an SSN is reported as an
 * SSN rather than swallowed by the generic digit-run rule.
 */
const SHAPE_RULES: ShapeRule[] = [
  { name: 'email', re: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, replace: () => '[pii:email]' },
  { name: 'phone', re: /\b(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g, replace: () => '[pii:phone]' },

  { name: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g, replace: () => '[pii:ssn]' },
  {
    name: 'pan',
    re: /\b(?:\d[ -]?){13,19}\b/g,
    // Keep the last four: it is the field operators actually use to confirm
    // identity, and it is what the industry already treats as retainable.
    replace: (m) => `[pii:pan:****${m.replace(/\D/g, '').slice(-4)}]`,
  },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9._-]{20,}/g, replace: () => '[secret:jwt]' },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._-]{16,}/gi, replace: () => '[secret:bearer]' },
  { name: 'apiKey', re: /\b(?:sk|pk)-[A-Za-z0-9]{16,}\b/g, replace: () => '[secret:api-key]' },
  { name: 'passwordAssignment', re: /\b(password|passwd|pwd)(\s*[=:]\s*)(\S+)/gi, replace: (m) => `${m.split(/[=:]/)[0]!}=[secret]` },
  { name: 'accountish', re: /\b\d{9,}\b/g, replace: () => '[pii:account-number]' },
];

export class Redactor {
  private exact: { value: string; token: string }[] = [];
  private patternScrubbing: boolean;

  constructor(opts: RedactorOptions = {}) {
    this.patternScrubbing = opts.patternScrubbing !== false;
    for (const s of opts.secrets ?? []) this.addSecret(s);
    for (const [name, value] of Object.entries(opts.labelled ?? {})) this.addLabelled(name, value);
    this.sortExact();
  }

  /** Values shorter than 4 chars are ignored: scrubbing "12" would destroy every log line. */
  addSecret(value: string): void {
    if (value && value.length >= 4) this.exact.push({ value, token: '[secret]' });
    this.sortExact();
  }

  addLabelled(name: string, value: string): void {
    if (value && value.length >= 4 && !this.exact.some((e) => e.value === value)) this.exact.push({ value, token: `[pii:${name}]` });
    this.sortExact();
  }

  learnObservation(observation: { controls: { role: string; value?: string; container: { table?: { rowKey?: string } } }[] }): void {
    for (const c of observation.controls) {
      if (c.value && c.value.length >= 4) this.addLabelled('surface-value', c.value);
      if (c.container.table?.rowKey) this.addLabelled('record', c.container.table.rowKey);
    }
  }

  /** Longest first, so a secret that contains another secret is replaced whole. */
  private sortExact(): void {
    this.exact.sort((a, b) => b.value.length - a.value.length);
  }

  /**
   * Redact in a single pass over the original string.
   *
   * Sequential `replace` calls are the obvious implementation and they are wrong:
   * a later rule can match inside a token an earlier rule just emitted. With a
   * secret whose value is "secret", replacing it first turns the token `[secret]`
   * into `[[secret]]`, and with shape rules it can mangle a token into something
   * that no longer says what was removed. Collecting every match against the
   * untouched input and splicing once removes that whole class of bug.
   *
   * Overlaps are resolved longest-match-first, which is the safe direction: if a
   * four-digit sensitive input happens to sit inside a sixteen-digit card number,
   * redacting the card number as a whole leaks nothing, whereas redacting the
   * short match first would leave twelve digits of the card in the log.
   */
  text(input: string): string {
    interface Hit {
      start: number;
      end: number;
      token: string;
      exact: boolean;
    }
    const hits: Hit[] = [];

    for (const { value, token } of this.exact) {
      let at = input.indexOf(value);
      while (at !== -1) {
        hits.push({ start: at, end: at + value.length, token, exact: true });
        at = input.indexOf(value, at + value.length);
      }
    }

    if (this.patternScrubbing) {
      for (const rule of SHAPE_RULES) {
        // A fresh RegExp per call: the module-level ones are global, and sharing
        // lastIndex across calls would make redaction depend on call order.
        const re = new RegExp(rule.re.source, rule.re.flags);
        let m: RegExpExecArray | null;
        while ((m = re.exec(input)) !== null) {
          if (m[0].length === 0) {
            re.lastIndex++;
            continue;
          }
          hits.push({ start: m.index, end: m.index + m[0].length, token: rule.replace(m[0]), exact: false });
        }
      }
    }

    if (hits.length === 0) return input;

    hits.sort((a, b) => b.end - b.start - (a.end - a.start) || Number(b.exact) - Number(a.exact) || a.start - b.start);

    const accepted: Hit[] = [];
    for (const hit of hits) {
      if (accepted.some((a) => hit.start < a.end && hit.end > a.start)) continue;
      accepted.push(hit);
    }
    accepted.sort((a, b) => a.start - b.start);

    let out = '';
    let cursor = 0;
    for (const hit of accepted) {
      out += input.slice(cursor, hit.start) + hit.token;
      cursor = hit.end;
    }
    return out + input.slice(cursor);
  }

  /**
   * Deep-redact an arbitrary structure. Keys are left alone (they are schema, not
   * data); string values are scrubbed. Keys whose *name* signals a credential are
   * dropped entirely rather than scrubbed, because a key called `password` with
   * any value at all is a mistake.
   */
  deep<T>(value: T): T {
    return this.walk(value) as T;
  }

  private walk(value: unknown): unknown {
    if (typeof value === 'string') return this.text(value);
    if (Array.isArray(value)) return value.map((v) => this.walk(v));
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (/^(password|passwd|pwd|secret|token|apikey|api_key|authorization|cookie)$/i.test(k)) {
          out[k] = '[secret]';
          continue;
        }
        out[k] = this.walk(v);
      }
      return out;
    }
    return value;
  }

  /** For tests and for the artifact linter's belt-and-braces check. */
  wouldRedact(input: string): boolean {
    return this.text(input) !== input;
  }
}

/** A redactor that scrubs shapes only. Used before any run-specific values are known. */
export function baseRedactor(): Redactor {
  return new Redactor();
}
