import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { capabilityDigest } from './store.js';
/**
 * The agent-facing capability catalog.
 *
 * A saved artifact already contains a typed contract, so exposing it as something
 * an AI agent can discover and call by name is mostly a projection, not new
 * design. That is the point worth making: the schema was shaped so that this file
 * is short.
 *
 * Three things are deliberately included in what the agent sees:
 *
 *  - **The declared business outcomes.** An agent that only knows the success
 *    shape will treat "no such member" as a tool error and retry it. Putting the
 *    outcome vocabulary in the tool description is what lets it say "I couldn't
 *    find that member" instead.
 *
 *  - **The lifecycle state.** A draft capability is listed but flagged, so an
 *    orchestrator can decline to call it unattended without having to fetch the
 *    artifact.
 *
 *  - **The stability signal.** How often it has replayed cleanly, and how often a
 *    fallback locator fired. An agent choosing between two capabilities that do
 *    similar things should be able to prefer the one that actually works.
 */

import { requiredSecretNames } from './schema.js';
import type { Capability, InputParam, OutputField, RiskClass } from './index-types.js';
import { listCapabilities, loadCapabilityFile, type CapabilityIndexEntry } from './store.js';

export interface JsonSchemaProperty {
  type: string;
  description: string;
  enum?: string[];
  pattern?: string;
}

export interface CapabilityToolDefinition {
  /**
   * One sentence, for a person. The `description` below is written for a model --
   * it spells out the whole outcome vocabulary so the model knows a business
   * outcome is an answer rather than a crash. Rendering that verbatim in a human
   * UI buries the one line an operator actually wanted.
   */
  summary: string;
  /** Callable name. Dots are not universally accepted in tool names, so they become underscores. */
  name: string;
  capabilityId: string;
  productId?: string;
  version: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, JsonSchemaProperty>; required: string[]; additionalProperties: false };
  outputSchema: { type: 'object'; properties: Record<string, JsonSchemaProperty>; required: string[] };
  outcomes: { code: string; description: string; retryable: boolean }[];
  lifecycle: { state: string; callableUnattended: boolean };
  /**
   * The capability's declared risk ceiling. Exposed because a caller deciding
   * whether to let a chatbot invoke this needs to know it can change records,
   * and inferring that from the name is exactly the mistake to avoid.
   */
  maxRisk: RiskClass;
  stability: { runs: number; successes: number; successRate: number | null; fallbackHits: number };
  /** Names of vault credentials this capability needs at replay time. */
  requiredSecrets: string[];
}

const JSON_TYPE: Record<InputParam['type'], string> = {
  string: 'string',
  number: 'number',
  money: 'number',
  boolean: 'boolean',
  enum: 'string',
  date: 'string',
};

export function toolNameFor(cap: Pick<Capability, 'id'>): string {
  return cap.id.replace(/[.-]/g, '_');
}

/**
 * Render `{{input.memberId}}` as `<memberId>` for agent-facing prose.
 *
 * The placeholder syntax is an implementation detail of the artifact. Showing an
 * agent `<memberId>` tells it which argument flows where, which is the useful part,
 * without leaking template mechanics into a tool description.
 */
function readablePlaceholders(text: string): string {
  return text.replace(/\{\{\s*input\.([a-zA-Z0-9_]+)\s*\}\}/g, '<$1>');
}

export function toToolDefinition(cap: Capability): CapabilityToolDefinition {
  const properties: Record<string, JsonSchemaProperty> = {};
  const required: string[] = [];
  for (const input of cap.inputs) {
    const prop: JsonSchemaProperty = { type: JSON_TYPE[input.type], description: describeInput(input) };
    if (input.type === 'enum' && input.values) prop.enum = input.values;
    if (input.pattern) prop.pattern = input.pattern;
    properties[input.name] = prop;
    if (input.required) required.push(input.name);
  }

  const outputProps: Record<string, JsonSchemaProperty> = {};
  const outputRequired: string[] = [];
  for (const output of cap.outputs) {
    outputProps[output.name] = { type: JSON_TYPE[output.type], description: readablePlaceholders(describeOutput(output)) };
    if (output.required) outputRequired.push(output.name);
  }

  const outcomeLines = cap.outcomes.map((o) => `  - ${o.code}: ${o.description}${o.retryable ? ' (retryable with different inputs)' : ''}`);
  const stability = cap.lifecycle.stability;

  const description = [
    readablePlaceholders(cap.summary),
    '',
    `Operates ${cap.target.productId}${cap.target.productVersion ? ` ${cap.target.productVersion}` : ''} by driving its user interface. Recorded against tenant ${cap.target.recordedTenantId}.`,
    cap.overlays.length ? `Also adapted for: ${cap.overlays.map((o) => o.tenantId).join(', ')}.` : '',
    '',
    'This may return a non-success business outcome instead of throwing. Handle these:',
    ...(outcomeLines.length ? outcomeLines : ['  (none declared)']),
    '',
    cap.lifecycle.state === 'approved'
      ? 'Approved for unattended use.'
      : `Lifecycle state is '${cap.lifecycle.state}': not approved for unattended use, and an unattended call will be refused.`,
  ]
    .filter((l) => l !== '')
    .join('\n');

  return {
    name: toolNameFor(cap),
    capabilityId: cap.id,
    productId: cap.target.productId,
    version: cap.version,
    summary: readablePlaceholders(cap.summary),
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    outputSchema: { type: 'object', properties: outputProps, required: outputRequired },
    outcomes: cap.outcomes.map((o) => ({ code: o.code, description: o.description, retryable: o.retryable })),
    lifecycle: { state: cap.lifecycle.state, callableUnattended: cap.lifecycle.state === 'approved' },
    maxRisk: cap.policy.maxRisk,
    stability: {
      runs: stability.runs,
      successes: stability.successes,
      successRate: stability.runs > 0 ? Number((stability.successes / stability.runs).toFixed(3)) : null,
      fallbackHits: stability.fallbackHits,
    },
    requiredSecrets: requiredSecretNames(cap),
  };
}

function describeInput(input: InputParam): string {
  const sens = input.sensitivity === 'pii' ? ' Treated as member PII: redacted from all logs and evidence.' : input.sensitivity === 'secret' ? ' Secret: must be supplied as a vault reference, not a literal.' : '';
  return `${input.description}${sens}`;
}

function describeOutput(output: OutputField): string {
  const sens = output.sensitivity === 'pii' ? ' (member PII)' : '';
  return `${output.description}${sens}`;
}

export interface Catalog {
  generatedAt: string;
  tools: CapabilityToolDefinition[];
  entries: CapabilityIndexEntry[];
}

export async function buildCatalog(dir?: string, evidenceDir?: string): Promise<Catalog> {
  const entries = await listCapabilities(dir);
  const latest = new Map<string, typeof entries[number]>();
  for (const entry of entries) {
    const prior = latest.get(entry.id);
    if (!prior || entry.version.localeCompare(prior.version, undefined, { numeric: true }) > 0) latest.set(entry.id, entry);
  }
  const tools: CapabilityToolDefinition[] = [];
  for (const entry of latest.values()) {
    if (entry.digest === 'invalid') continue;
    if (entry.state === 'deprecated') continue;
    try {
      const cap = await loadCapabilityFile(entry.file);
      const tool = toToolDefinition(cap);
      tool.stability = await measuredStability(cap, evidenceDir);
      tools.push(tool);
    } catch {
      /* already reported as an invalid index entry */
    }
  }
  return { generatedAt: new Date().toISOString(), tools, entries };
}

/** Resolve a tool name (underscored) back to a capability id. */
export function capabilityIdForToolName(name: string, entries: CapabilityIndexEntry[]): string | undefined {
  return entries.find((e) => e.id.replace(/[.-]/g, '_') === name)?.id;
}

/** Counters belong beside recordings, derived from terminal runs with the same digest. */
export async function measuredStability(cap: Capability, dir = 'evidence/runs'): Promise<CapabilityToolDefinition['stability']> {
  const digest = capabilityDigest(cap);
  let runs = 0, successes = 0, fallbackHits = 0;
  const seen = new Set<string>();
  for (const root of dir === 'evidence/runs' ? [dir, 'evidence/assignment-2/past-verifications/runs'] : [dir]) {
    const names = await readdir(root).catch(() => []);
    for (const name of names.filter((n) => n.startsWith('replay-'))) {
      try {
        if (seen.has(name)) continue;
        const summary = JSON.parse(await readFile(join(root, name, 'summary.json'), 'utf8'));
        seen.add(name);
        if (summary.capability?.digest !== digest || !['success', 'business_outcome', 'failed', 'escalated'].includes(summary.status)) continue;
        runs++;
        if (['success', 'business_outcome'].includes(summary.status)) successes++;
        fallbackHits += Array.isArray(summary.drift) ? summary.drift.length : 0;
      } catch { /* Incomplete runs do not become reliability measurements. */ }
    }
  }
  return { runs, successes, successRate: runs ? Number((successes / runs).toFixed(3)) : null, fallbackHits };
}
