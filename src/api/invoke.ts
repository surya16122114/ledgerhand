/**
 * Invoking a capability by name.
 *
 * This is the production entry point: an AI agent picks a tool out of the
 * catalog, supplies typed arguments, and gets a structured envelope back. The CLI
 * and the HTTP API are both thin callers of the function below rather than two
 * implementations of the same idea -- the argument validation, the lifecycle
 * check and the envelope shape are exactly the contract this system advertises,
 * and two copies of a contract is one copy too many.
 *
 * The envelope's central property is the one the brief calls out as the most
 * common design mistake: a business outcome is *data*, not an exception. "No such
 * member" comes back as `ok: false` with an `outcome` a caller can branch on,
 * distinct from an `error`, which means the automation itself could not complete.
 */

import { buildCatalog, type CapabilityToolDefinition } from '../artifact/catalog.js';
import { loadCapability } from '../artifact/store.js';
import { replay, type ReplayOptions } from '../replay/engine.js';
import { defaultBaseUrlFor } from '../config/demo-goals.js';
import { SecretVault } from '../policy/vault.js';

export interface InvokeOptions {
  baseUrl?: string;
  tenantId?: string;
  /** Refuse a draft capability, the way an unattended production caller must. */
  unattended?: boolean;
  authorizeIrreversible?: { by: string; reason: string };
  headless?: boolean;
  evidenceBaseDir?: string;
  escalationTimeoutMs?: number;
  vault?: SecretVault;
  capabilityDir?: string;
  onSurfaceReady?: ReplayOptions['onSurfaceReady'];
}

/**
 * A compact per-step trace, returned with every invocation.
 *
 * The replay envelope already carries this and the first version of the API threw
 * it away, which was a mistake in both directions: a caller debugging a failure
 * had only a message, and an operator watching a 30-second run had nothing to look
 * at. It is small, it is the same data the CLI prints, and it is the difference
 * between "it failed" and "it failed at step 14 resolving the Continue button".
 */
export interface StepSummary {
  id: string;
  action: string;
  ok: boolean;
  status: string;
  ms: number;
  /** Which targeting strategy actually resolved the control. */
  via?: string;
}

export type InvokeEnvelope =
  | { ok: true; tool: string; runId: string; evidence: string; outputs: Record<string, unknown>; steps?: StepSummary[]; recoveries?: Awaited<ReturnType<typeof replay>>['recoveries']; durationMs?: number }
  | {
      ok: false;
      tool: string;
      runId: string;
      evidence: string;
      outcome: { code: string; message: string; retryable: boolean };
      steps?: StepSummary[]; recoveries?: Awaited<ReturnType<typeof replay>>['recoveries'];
      durationMs?: number;
    }
  | {
      ok: false;
      tool: string;
      runId?: string;
      evidence?: string;
      error: { code: string; message: string; step?: string; observed?: string; intervention?: string; expected?: unknown };
      steps?: StepSummary[]; recoveries?: Awaited<ReturnType<typeof replay>>['recoveries'];
      durationMs?: number;
    };

/** Everything a caller can invoke, in the shape an agent's tool list expects. */
export async function listTools(capabilityDir?: string, evidenceDir?: string): Promise<CapabilityToolDefinition[]> {
  return (await buildCatalog(capabilityDir, evidenceDir)).tools;
}

export async function findTool(name: string, capabilityDir?: string, evidenceDir?: string): Promise<CapabilityToolDefinition | undefined> {
  const catalog = await buildCatalog(capabilityDir, evidenceDir);
  // Accept either the underscored tool name an agent sees or the dotted
  // capability id a human would type. They address the same thing.
  return catalog.tools.find((t) => t.name === name) ?? catalog.tools.find((t) => t.capabilityId === name);
}

/**
 * Validate arguments against the tool's advertised schema.
 *
 * Deliberately duplicated from the replay engine's own input validation, because
 * the two answer different questions. The engine validates against the
 * *capability*; this validates against the *contract the caller was reading*, so
 * an unknown argument is named as unknown rather than silently ignored.
 */
export function validateArguments(
  tool: CapabilityToolDefinition,
  args: Record<string, unknown>,
): { ok: true } | { ok: false; message: string } {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { ok: false, message: 'arguments must be an object' };
  const missing = tool.inputSchema.required.filter((k) => args[k] === undefined);
  const unknown = Object.keys(args).filter((k) => !(k in tool.inputSchema.properties));
  if (!missing.length && !unknown.length) return { ok: true };
  return {
    ok: false,
    message: [
      missing.length ? `missing required argument(s): ${missing.join(', ')}` : '',
      unknown.length ? `unknown argument(s): ${unknown.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('; '),
  };
}

export async function invokeCapability(
  name: string,
  args: Record<string, unknown>,
  opts: InvokeOptions = {},
): Promise<InvokeEnvelope> {
  const tool = await findTool(name, opts.capabilityDir, opts.evidenceBaseDir);
  if (!tool) {
    const available = (await listTools(opts.capabilityDir, opts.evidenceBaseDir)).map((t) => t.name);
    return {
      ok: false,
      tool: name,
      error: { code: 'NO_SUCH_CAPABILITY', message: `no callable capability named '${name}'`, expected: available },
    };
  }

  const validation = validateArguments(tool, args);
  if (!validation.ok) {
    return {
      ok: false,
      tool: tool.name,
      error: { code: 'INVALID_ARGUMENTS', message: validation.message, expected: tool.inputSchema },
    };
  }

  // A draft is a capability nobody has approved. Refusing it here rather than at
  // the browser means an unattended caller fails in milliseconds with a reason,
  // instead of after a sign-on.
  if (opts.unattended && !tool.lifecycle.callableUnattended) {
    return {
      ok: false,
      tool: tool.name,
      error: {
        code: 'NOT_APPROVED',
        message: `'${tool.name}' is in lifecycle state '${tool.lifecycle.state}' and cannot be called unattended`,
      },
    };
  }

  const capability = await loadCapability(`${tool.capabilityId}@${tool.version}`, opts.capabilityDir);
  const result = await replay(capability, args, {
    baseUrl: opts.baseUrl ?? defaultBaseUrlFor(capability.target.productId),
    ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
    ...(opts.unattended ? { unattended: true } : {}),
    ...(opts.authorizeIrreversible ? { authorizeIrreversible: opts.authorizeIrreversible } : {}),
    ...(opts.headless !== undefined ? { headless: opts.headless } : {}),
    ...(opts.evidenceBaseDir ? { evidenceBaseDir: opts.evidenceBaseDir } : {}),
    ...(opts.vault ? { vault: opts.vault } : {}),
    ...(opts.onSurfaceReady ? { onSurfaceReady: opts.onSurfaceReady } : {}),
    escalationTimeoutMs: opts.escalationTimeoutMs ?? (opts.onSurfaceReady ? 15 * 60_000 : 15_000),
  });

  return toEnvelope(tool.name, result);
}

export function toEnvelope(tool: string, result: Awaited<ReturnType<typeof replay>>): InvokeEnvelope {
  const steps: StepSummary[] = result.steps.map((s) => ({
    id: s.id,
    action: s.action,
    ok: ['ok', 'recovered', 'satisfied-externally'].includes(s.status),
    status: s.status,
    ms: s.durationMs,
    ...(s.strategy ? { via: s.strategy.kind } : {}),
  }));
  const base = { tool, runId: result.runId, evidence: result.evidenceDir, steps, recoveries: result.recoveries, durationMs: result.durationMs };
  switch (result.status) {
    case 'success':
      return { ok: true, ...base, outputs: result.outputs };
    case 'business_outcome':
      // Not an error. The automation did its job and the institution's system
      // gave an answer the caller has to handle.
      return {
        ok: false,
        ...base,
        outcome: { code: result.outcome.code, message: result.outcome.description, retryable: result.outcome.retryable },
      };
    case 'escalated':
      return {
        ok: false,
        ...base,
        error: {
          code: 'ESCALATED',
          message: result.failure.message,
          step: result.failure.stepId,
          intervention: result.intervention.id,
        },
      };
    default:
      return {
        ok: false,
        ...base,
        error: {
          code: result.failure.declaredCode ?? result.failure.code,
          ...(result.failure.expected ? { expected: result.failure.expected } : {}),
          message: result.failure.message,
          step: result.failure.stepId,
          ...(result.failure.observed ? { observed: result.failure.observed } : {}),
        },
      };
  }
}
