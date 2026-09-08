/**
 * Artifact persistence.
 *
 * Capabilities are plain JSON on disk, one file per version, with a small index.
 * There is no database because there does not need to be one: these are
 * review-gated, human-readable, slow-changing definitions, and the thing you
 * most want from their storage is that a reviewer can read a pull request diff
 * of them. Git is a better fit for that than a table.
 *
 * Two properties are enforced rather than assumed:
 *
 *  - **Validated on load, not just on save.** An artifact is the input to a
 *    process that drives a bank's back office. Trusting a file because we wrote
 *    it once is how a hand-edited step ends up executing.
 *
 *  - **Redaction is verified, not asserted.** `provenance.redactionApplied` is a
 *    claim; `lintCapability` re-derives it by scanning the serialized artifact
 *    for credential- and PII-shaped literals, including the live values from the
 *    secret vault. A recorder bug that leaked a password would otherwise be
 *    invisible until an audit.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { ARTIFACT_SCHEMA_VERSION, capabilitySchema, type Capability } from './schema.js';
import { abnormalPhrases } from './product-profiles.js';

export const DEFAULT_CAPABILITY_DIR = 'capabilities';

export interface CapabilityIndexEntry {
  id: string;
  version: string;
  name: string;
  summary: string;
  productId: string;
  recordedTenantId: string;
  state: Capability['lifecycle']['state'];
  file: string;
  digest: string;
  inputs: string[];
  outputs: string[];
  outcomes: string[];
  tenantOverlays: string[];
}

/**
 * Canonical serialisation: keys sorted at every level.
 *
 * The digest has to be stable across machines and across whatever order a
 * recorder happened to build the object in, or "has this approved artifact
 * changed?" becomes unanswerable.
 */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, walk((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(walk(value), null, 2);
}

export function capabilityDigest(cap: Capability): string {
  return `sha256:${createHash('sha256').update(canonicalJson(cap)).digest('hex').slice(0, 32)}`;
}

export function capabilityFilename(cap: Pick<Capability, 'id' | 'version'>): string {
  return `${cap.id}@${cap.version}.json`;
}

// ---------------------------------------------------------------------------
// Lint
// ---------------------------------------------------------------------------

export interface LintFinding {
  severity: 'error' | 'warn';
  code: string;
  message: string;
  where?: string;
}

/**
 * Patterns that must never appear as literals inside an artifact.
 *
 * Deliberately shaped to catch the realistic leak, which is not a well-formed
 * SSN but a value that a recorder copied out of a page or a prompt: a long digit
 * run, a bearer token, a `password=` fragment.
 */
const FORBIDDEN_LITERALS: { code: string; re: RegExp; what: string }[] = [
  { code: 'SSN_SHAPED', re: /\b\d{3}-\d{2}-\d{4}\b/, what: 'a US SSN-shaped value' },
  { code: 'PAN_SHAPED', re: /\b(?:\d[ -]?){13,19}\b/, what: 'a card-number-shaped value' },
  { code: 'LONG_DIGIT_RUN', re: /\b\d{12,}\b/, what: 'a 12+ digit run (account number?)' },
  { code: 'BEARER_TOKEN', re: /\b(?:bearer\s+[A-Za-z0-9._-]{16,}|eyJ[A-Za-z0-9._-]{20,})/i, what: 'a bearer token or JWT' },
  { code: 'API_KEY', re: /\b(?:sk|pk|api[_-]?key|secret)[-_=:\s]*[A-Za-z0-9]{16,}/i, what: 'an API-key-shaped value' },
  // The negative lookahead is what stops this firing on a *label*. Meridian
  // renders its field labels with the colon included -- the cell reads
  // "Password:" -- and the perception layer puts that label into the target
  // description, so `Password:"` appeared to be an assignment whose value was a
  // quote character. CorePoint's colon-less "Password" never tripped it, which is
  // why this survived until a second app was recorded.
  { code: 'PASSWORD_ASSIGNMENT', re: /\b(?:password|passwd|pwd)\s*[=:]\s*(?!["'\\\\,}\\]])\S{3,}/i, what: 'an inline password assignment' },
];

/**
 * Keys whose values come from a fixed vocabulary rather than from the app or the
 * model: schema enums, match modes, lifecycle states.
 *
 * They are excluded from every literal scan because a schema enum is not data.
 * `role: 'password'` is the case that forced this: it is present in any artifact
 * that signs on to anything, and on a host whose demo password is the word
 * "password" it made the secret-leak check fire on every single capability --
 * including ones already committed and approved. Schema enums are identifiers
 * wearing prose clothing; they are never data.
 */
const STRUCTURAL_KEYS = new Set([
  'kind',
  'role',
  'nameMatch',
  'labelMatch',
  'rowKeyMatch',
  'textMatch',
  'state',
  'do',
  'severity',
  'sensitivity',
  'type',
  'surfaceKind',
  'risk',
]);

/**
 * Keys that carry a literal a caller or the app supplied. A credential sitting in
 * one of these is a genuine leak: it is what replay would type, or what a
 * checkpoint would assert.
 */
const VALUE_KEYS = new Set(['value', 'pattern', 'url', 'css', 'text']);

interface Leaf {
  path: string;
  key: string;
  text: string;
}

/** Every string leaf in the artifact, with the key it hangs off. */
function stringLeaves(value: unknown, path = '', key = ''): Leaf[] {
  if (typeof value === 'string') return [{ path, key, text: value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => stringLeaves(v, `${path}[${i}]`, key));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      stringLeaves(v, path ? `${path}.${k}` : k, k),
    );
  }
  return [];
}

/**
 * @param knownSecrets live values from the vault. Passed in rather than read
 *        here so the linter stays a pure function and can be tested.
 */
export function lintCapability(cap: Capability, knownSecrets: string[] = []): LintFinding[] {
  const findings: LintFinding[] = [];

  // Scanning the serialized blob was the original approach and it does not
  // survive a second product. It cannot tell a schema enum from data, so the
  // moment a vault holds a secret whose value is an ordinary word, every artifact
  // fails to save -- see STRUCTURAL_KEYS.
  const leaves = stringLeaves(cap).filter((l) => !STRUCTURAL_KEYS.has(l.key));
  const valueLeaves = leaves.filter((l) => VALUE_KEYS.has(l.key));

  for (const { code, re, what } of FORBIDDEN_LITERALS) {
    const hit = leaves.find((l) => re.test(l.text));
    if (hit) {
      findings.push({
        severity: 'error',
        code,
        message: `artifact contains ${what}; capabilities must reference inputs or secrets, never literals`,
        // The path, never the match: reporting a leak by printing it is not an
        // improvement. The path alone is enough to find it.
        where: hit.path,
      });
    }
  }

  for (const secret of new Set(knownSecrets)) {
    if (secret.length < 4) continue;

    // A credential sitting where replay would type it, or where a checkpoint
    // would assert it. This is the leak that matters and it stays an error.
    const inValue = valueLeaves.find((l) => l.text.includes(secret));
    if (inValue) {
      findings.push({
        severity: 'error',
        code: 'VAULT_SECRET_LEAKED',
        message: 'artifact contains a literal that matches a value held in the secret vault',
        where: inValue.path,
      });
      continue;
    }

    // A credential quoted in prose -- an intent, a summary, a perceived target
    // description. Worth surfacing, but it cannot be an error: a description of a
    // password field legitimately contains the word "password", and on a host
    // where that *is* the password there is no way to tell the two apart by
    // matching. Erroring here would block every capability and teach whoever hit
    // it to pass --force, which is worse than a warning nobody can act on.
    const inProse = leaves.find((l) => l.text.includes(secret));
    if (inProse) {
      findings.push({
        severity: 'warn',
        code: 'VAULT_SECRET_IN_PROSE',
        message:
          'a vault value appears in descriptive text rather than in a value position; ' +
          'harmless if the secret is an ordinary word, a leak if it is not',
        where: inProse.path,
      });
    }
  }

  // Targeting quality. Not fatal -- a dom-hint-only target can still work today
  // -- but it is the thing most likely to break on the next tenant, so it is
  // surfaced at record time when it is cheap to improve.
  cap.steps.forEach((step) => {
    if (!('target' in step.action)) return;
    const kinds = step.action.target.strategies.map((s) => s.kind);
    if (kinds.length === 1 && kinds[0] === 'dom-hint') {
      findings.push({
        severity: 'warn',
        code: 'WEAK_TARGETING',
        message: `step '${step.id}' can only be found by a markup hint; it will not survive a tenant with a different build`,
        where: `steps/${step.id}`,
      });
    }
    if (!kinds.includes('dom-hint') && kinds.length === 1) {
      findings.push({
        severity: 'warn',
        code: 'NO_FALLBACK_TARGETING',
        message: `step '${step.id}' has a single targeting strategy and no fallback`,
        where: `steps/${step.id}`,
      });
    }
  });

  // A step that changes what is on screen and cannot verify the change is a step
  // that will report success after doing nothing.
  //
  // Scoped to actions that transition the screen, plus anything irreversible. A
  // `fill` is classified reversible but has nothing to check -- the value either
  // took or the fill failed, and perception verifies that -- so warning about it
  // would train a reader to ignore this rule.
  const TRANSITIONING: string[] = ['click', 'navigate', 'press'];
  cap.steps.forEach((step) => {
    const needsCheckpoint = TRANSITIONING.includes(step.action.kind) || step.risk === 'irreversible';
    if (needsCheckpoint && !step.checkpoint) {
      findings.push({
        severity: 'warn',
        code: 'UNVERIFIED_MUTATION',
        message: `step '${step.id}' is a ${step.action.kind} (${step.risk}) with no checkpoint, so it cannot detect its own failure`,
        where: `steps/${step.id}`,
      });
    }
  });

  // An input the caller must supply that no step ever consumes.
  //
  // This is how a capability ends up not doing the thing it is named after. A
  // contact update was recorded against a member whose e-mail already happened to
  // equal the target value, so the model looked at the record, saw the goal
  // satisfied, and finished -- compiling a nine-step artifact that signs on, looks
  // the member up, reads the existing e-mail back, and declares success. It still
  // advertised an `email` input and a `savedEmail` output. Replayed with a
  // different address it would report success and return the old one.
  //
  // The declared contract is the thing that lies here, and an unconsumed input is
  // the cheapest way to catch it: an input nobody reads cannot possibly affect
  // what the capability does.
  const consumedInputs = new Set<string>();
  const noteValue = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const v = value as { from?: string; name?: string };
    if (v.from === 'input' && v.name) consumedInputs.add(v.name);
  };
  const noteTemplates = (text: string): void => {
    for (const m of text.matchAll(/\{\{\s*input\.([A-Za-z0-9_]+)\s*\}\}/g)) consumedInputs.add(m[1]!);
  };
  // Prose is not consumption. Scanning the whole step counted a step *intent*
  // reading "Select the correct branch ({{input.branch}})" as a use, while the
  // action beneath it selected a hardcoded literal -- so the check passed on
  // exactly the artifact it exists to catch.
  const withoutProse = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(withoutProse);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([k]) => k !== 'description' && k !== 'intent' && k !== 'summary')
          .map(([k, v]) => [k, withoutProse(v)]),
      );
    }
    return value;
  };
  for (const step of cap.steps) {
    if ('value' in step.action) noteValue(step.action.value);
    // Targets and conditions can carry `{{input.x}}` too -- a parameterized row
    // key is the whole point of `materialiseTarget`.
    noteTemplates(JSON.stringify(withoutProse(step.action)));
    if (step.checkpoint) noteTemplates(JSON.stringify(withoutProse(step.checkpoint)));
  }
  noteTemplates(JSON.stringify(withoutProse(cap.success)));
  for (const input of cap.inputs) {
    if (consumedInputs.has(input.name)) continue;
    findings.push({
      severity: 'error',
      code: 'UNUSED_INPUT',
      message:
        `input '${input.name}' is declared in the contract but no step reads it, so it cannot affect what this capability does. ` +
        `Most often this means the goal was already satisfied when the run was recorded.`,
      where: `inputs/${input.name}`,
    });
  }

  // Conditions that quote record-time data. The recorder now avoids producing
  // these, but an artifact can also be hand-edited, and a checkpoint pinned to one
  // member's data is the failure mode that passes review and then only ever works
  // for that member.
  const conditionPatterns: { where: string; pattern: string }[] = [];
  const collect = (where: string, condition: unknown): void => {
    if (!condition || typeof condition !== 'object') return;
    const c = condition as { kind?: string; pattern?: string; of?: unknown };
    if ((c.kind === 'textPresent' || c.kind === 'textAbsent') && typeof c.pattern === 'string') {
      conditionPatterns.push({ where, pattern: c.pattern });
    }
    if (Array.isArray(c.of)) c.of.forEach((sub, i) => collect(`${where}[${i}]`, sub));
    else if (c.of) collect(where, c.of);
  };
  collect('success.checkpoint', cap.success.checkpoint);
  cap.steps.forEach((s) => collect(`steps/${s.id}/checkpoint`, s.checkpoint));

  for (const { where, pattern } of conditionPatterns) {
    // Digits in an asserted phrase on these screens mean a member number, a
    // balance, a branch code or a date -- not screen structure.
    //
    // The digit rule alone let two artifacts through, because neither piece of
    // record-time data had a digit in it: a contact update asserting the e-mail it
    // had just written, and a sign-on asserting "J. TELLER". Both would have
    // succeeded only for the run that recorded them.
    const dataShapes: [RegExp, string][] = [
      [/\d{3,}/, 'a number'],
      [/[^\s@]+@[^\s@]+\.[A-Za-z]{2,}/, 'an e-mail address'],
      [/\b[A-Z]\.\s*[A-Z][A-Za-z]+\b/, 'a person name'],
      [/[$£€]\s*\d/, 'a currency amount'],
    ];
    // Tested against the unescaped text, not the stored pattern. These are regexes
    // built by `escapeRegExp`, so "J. TELLER" is stored as "J\. TELLER" -- and a
    // shape written the readable way silently fails to match its own escaped form.
    const asText = pattern.replace(/\\(?=[^A-Za-z0-9])/g, '');
    const shape = dataShapes.find(([re]) => re.test(asText));
    if (shape) {
      findings.push({
        severity: 'warn',
        code: 'DATA_IN_CONDITION',
        message: `condition asserts a phrase containing ${shape[1]}, which is record-time data, so it will only hold for the record it was recorded against`,
        where,
      });
    }

    // A checkpoint may not assert a phrase the product profile declares as an
    // interrupt or a business outcome. It is a contradiction: the capability
    // would report success exactly when the product says something went wrong.
    //
    // An error rather than a warning, because the artifact is not merely weak, it
    // is inverted -- and the run that produced one looked completely successful.
    const abnormal = abnormalPhrases(cap.target.productId).find(
      (phrase) => phrase === pattern || pattern.includes(phrase) || phrase.split('|').some((alt) => alt && pattern.includes(alt)),
    );
    if (abnormal) {
      findings.push({
        severity: 'error',
        code: 'CHECKPOINT_ASSERTS_ABNORMAL_CONDITION',
        message:
          `condition asserts /${pattern}/, which this product declares as an interrupt or business outcome. ` +
          `The capability would report success when the application is reporting a fault. ` +
          `This usually means discovery ran while a fault was injected -- re-record against a healthy host.`,
        where,
      });
    }
  }

  // A capability whose discovery needed a person is not disqualified from approval,
  // but the reviewer should know: the recording contains a step the automation could
  // not do on its own, and that is exactly where it will need a person again.
  if (cap.provenance.humanInterventions > 0) {
    findings.push({
      severity: 'warn',
      code: 'HUMAN_INTERVENED_DISCOVERY',
      message: `discovery required ${cap.provenance.humanInterventions} human intervention(s); confirm the reviewer understands which step needed a person and why`,
      where: 'provenance.humanInterventions',
    });
  }

  if (cap.outcomes.length === 0) {
    findings.push({
      severity: 'warn',
      code: 'NO_BUSINESS_OUTCOMES',
      message: 'capability declares no business outcomes; every real flow has at least one legitimate non-success result',
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

export class CapabilityValidationError extends Error {
  constructor(
    readonly file: string,
    readonly issues: z.ZodIssue[],
  ) {
    super(
      `capability at ${file} is not valid:\n` +
        issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n'),
    );
    this.name = 'CapabilityValidationError';
  }
}

export function parseCapability(raw: unknown, file = '<memory>'): Capability {
  const parsed = capabilitySchema.safeParse(raw);
  if (!parsed.success) throw new CapabilityValidationError(file, parsed.error.issues);
  const cap = parsed.data;

  const [major] = cap.schemaVersion.split('.');
  const [expectedMajor] = ARTIFACT_SCHEMA_VERSION.split('.');
  if (major !== expectedMajor) {
    throw new Error(
      `capability at ${file} uses artifact schema ${cap.schemaVersion}; this build understands ${expectedMajor}.x. ` +
        `Refusing to guess -- run a migration.`,
    );
  }
  return cap;
}

export class CapabilityExistsError extends Error {
  constructor(readonly file: string, readonly id: string, readonly version: string) {
    super(
      `${file} already exists. A discovery run will not silently replace a saved capability: ` +
        `the committed artifact is what the evidence was produced against, and its content digest is what makes ` +
        `"has this approved capability changed?" answerable. Bump the version, or pass --force to overwrite deliberately.`,
    );
    this.name = 'CapabilityExistsError';
  }
}

/**
 * @param overwrite required to replace an existing file.
 *
 * Defaults to false because the obvious behaviour is the dangerous one. Following the
 * README's own demo path used to overwrite the committed artifacts -- the exact files
 * /evidence references by digest and the replay scenarios ran against -- so a reviewer
 * evaluating the submission destroyed part of it just by trying the demo. `approve` and
 * `overlay` legitimately rewrite an artifact in place and opt in.
 */
export async function saveCapability(
  cap: Capability,
  dir = DEFAULT_CAPABILITY_DIR,
  opts: { overwrite?: boolean } = {},
): Promise<{ file: string; digest: string }> {
  const validated = parseCapability(cap);
  const existing = (await listCapabilities(dir)).find(entry => entry.id === validated.id && entry.version === validated.version);
  if (existing && !opts.overwrite) throw new CapabilityExistsError(existing.file, validated.id, validated.version);
  const productDir = resolve(dir) === resolve(DEFAULT_CAPABILITY_DIR)
    ? join(dir, validated.target.productId === 'meridian-core' ? 'assignment-2' : validated.target.productId === 'corepoint-servicing' ? 'assignment-1' : 'other') : dir;
  const file = existing?.file ?? join(productDir, capabilityFilename(validated));
  if (!opts.overwrite && existsSync(file)) {
    throw new CapabilityExistsError(file, validated.id, validated.version);
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${canonicalJson(validated)}\n`, 'utf8');
  await rebuildIndex(dir);
  return { file, digest: capabilityDigest(validated) };
}

export async function loadCapabilityFile(file: string): Promise<Capability> {
  const raw = JSON.parse(await readFile(file, 'utf8')) as unknown;
  return parseCapability(raw, file);
}

/**
 * Resolve `id`, `id@version`, or a filesystem path. Bare ids resolve to the
 * highest semver present, which is what a calling agent means by "the member
 * balance capability".
 */
export async function loadCapability(ref: string, dir = DEFAULT_CAPABILITY_DIR): Promise<Capability> {
  if (ref.endsWith('.json')) return loadCapabilityFile(resolve(ref));

  const entries = await listCapabilities(dir);
  if (entries.length === 0) throw new Error(`no capabilities found in ${resolve(dir)}`);

  const [id, version] = ref.includes('@') ? ref.split('@') : [ref, undefined];
  const matches = entries.filter((e) => e.id === id && (version === undefined || e.version === version));
  if (matches.length === 0) {
    throw new Error(
      `no capability matching '${ref}'. Available: ${entries.map((e) => `${e.id}@${e.version}`).join(', ')}`,
    );
  }
  const best = matches.sort((a, b) => compareSemver(b.version, a.version))[0]!;
  return loadCapabilityFile(best.file);
}

export async function listCapabilities(dir = DEFAULT_CAPABILITY_DIR): Promise<CapabilityIndexEntry[]> {
  let files: string[];
  try {
    const scan = async (folder: string): Promise<string[]> => {
      const entries = await readdir(folder, { withFileTypes: true });
      const found: string[] = [];
      for (const entry of entries) {
        const path = join(folder, entry.name);
        if (entry.isDirectory()) found.push(...await scan(path));
        else if (entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'index.json') found.push(path);
      }
      return found;
    };
    files = await scan(dir);
  } catch {
    return [];
  }
  const out: CapabilityIndexEntry[] = [];
  for (const f of files) {
    const file = f;
    try {
      const cap = await loadCapabilityFile(file);
      out.push(toIndexEntry(cap, file));
    } catch (err) {
      // A malformed file must not make the whole catalog unreadable, but it also
      // must not be silently omitted.
      out.push({
        id: f.replace(/@.*$/, ''),
        version: '0.0.0',
        name: `UNREADABLE: ${f}`,
        summary: err instanceof Error ? err.message.split('\n')[0]! : String(err),
        productId: '?',
        recordedTenantId: '?',
        state: 'deprecated',
        file,
        digest: 'invalid',
        inputs: [],
        outputs: [],
        outcomes: [],
        tenantOverlays: [],
      });
    }
  }
  return out;
}

export function toIndexEntry(cap: Capability, file: string): CapabilityIndexEntry {
  return {
    id: cap.id,
    version: cap.version,
    name: cap.name,
    summary: cap.summary,
    productId: cap.target.productId,
    recordedTenantId: cap.target.recordedTenantId,
    state: cap.lifecycle.state,
    file,
    digest: capabilityDigest(cap),
    inputs: cap.inputs.map((i) => `${i.name}${i.required ? '' : '?'}:${i.type}`),
    outputs: cap.outputs.map((o) => `${o.name}:${o.type}`),
    outcomes: cap.outcomes.map((o) => o.code),
    tenantOverlays: cap.overlays.map((o) => o.tenantId),
  };
}

export async function rebuildIndex(dir = DEFAULT_CAPABILITY_DIR): Promise<CapabilityIndexEntry[]> {
  const entries = (await listCapabilities(dir)).sort((a, b) => `${a.id}@${a.version}`.localeCompare(`${b.id}@${b.version}`));
  await writeFile(join(dir, 'index.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), capabilities: entries }, null, 2)}\n`, 'utf8');
  return entries;
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
