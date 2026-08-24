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
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { ARTIFACT_SCHEMA_VERSION, capabilitySchema, type Capability } from './schema.js';

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
  { code: 'PASSWORD_ASSIGNMENT', re: /\b(?:password|passwd|pwd)\s*[=:]\s*\S+/i, what: 'an inline password assignment' },
];

/**
 * @param knownSecrets live values from the vault. Passed in rather than read
 *        here so the linter stays a pure function and can be tested.
 */
export function lintCapability(cap: Capability, knownSecrets: string[] = []): LintFinding[] {
  const findings: LintFinding[] = [];
  const serialized = canonicalJson(cap);

  for (const { code, re, what } of FORBIDDEN_LITERALS) {
    const hit = re.exec(serialized);
    if (hit) {
      findings.push({
        severity: 'error',
        code,
        message: `artifact contains ${what}; capabilities must reference inputs or secrets, never literals`,
        // The match itself is not echoed -- reporting a leak by printing it is
        // not an improvement.
        where: `offset ${hit.index}`,
      });
    }
  }

  for (const secret of knownSecrets) {
    if (secret.length >= 4 && serialized.includes(secret)) {
      findings.push({
        severity: 'error',
        code: 'VAULT_SECRET_LEAKED',
        message: 'artifact contains a literal that matches a value held in the secret vault',
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
    if (/\d{3,}/.test(pattern)) {
      findings.push({
        severity: 'warn',
        code: 'DATA_IN_CONDITION',
        message: `condition asserts a phrase containing record-time data, so it will only hold for the record it was recorded against`,
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

export async function saveCapability(cap: Capability, dir = DEFAULT_CAPABILITY_DIR): Promise<{ file: string; digest: string }> {
  const validated = parseCapability(cap);
  const file = join(dir, capabilityFilename(validated));
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
    files = (await readdir(dir)).filter((f) => f.endsWith('.json') && f !== 'index.json');
  } catch {
    return [];
  }
  const out: CapabilityIndexEntry[] = [];
  for (const f of files) {
    const file = join(dir, f);
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
