#!/usr/bin/env node
/**
 * Command line entry point.
 *
 * Thin on purpose: parse, wire, print. Every command below is a few lines of glue
 * over the modules that do the work, which is the shape you want if the same
 * capabilities are also going to be invoked from a service.
 *
 * The operator console is started automatically for `discover` and `replay`
 * rather than being a separate process to remember. An escalation is useless if
 * the place to resolve it is not already running.
 */

import { readFile } from 'node:fs/promises';
import { OpenAiProvider } from './agent/llm/openai.js';
import { TranscriptProvider } from './agent/llm/transcript-provider.js';
import type { LlmProvider } from './agent/llm/provider.js';
import { discover, type DiscoveryParameter } from './agent/loop.js';
import { replay } from './replay/engine.js';
import { summarizeResult } from './replay/outcome.js';
import {
  DEFAULT_CAPABILITY_DIR,
  lintCapability,
  loadCapability,
  saveCapability,
} from './artifact/store.js';
import { buildCatalog, toToolDefinition } from './artifact/catalog.js';
import { applyOverlay } from './artifact/overlay.js';
import { overlaySchema } from './artifact/schema.js';
import { SecretVault } from './policy/vault.js';
import { startOperatorConsole } from './escalation/operator-server.js';
import { loadEnvFile } from './config/env.js';
import { DEMO_GOALS } from './config/demo-goals.js';

const HELP = `ledgerhand -- record a UI flow once with a model, replay it deterministically forever

usage
  ledgerhand discover <goal-preset|--goal "...">  [options]
  ledgerhand replay   <capability[@version]>      [options]
  ledgerhand catalog                              [--json]
  ledgerhand lint     <capability[@version]>
  ledgerhand approve  <capability[@version]> --by "Name <email>"
  ledgerhand show     <capability[@version]>
  ledgerhand overlay  <capability[@version]> <overlay.json>
  ledgerhand invoke   <tool-name> --args '{"...":"..."}'   call a capability the way an agent would

discover options
  --goal <text>            free-form goal (or use a preset: ${Object.keys(DEMO_GOALS).join(', ')})
  --capability-id <id>      dotted-kebab id for the artifact, e.g. member.read-savings-balance
  --param <name=value[:type[:sensitivity[:pattern]]]>  repeatable; becomes a typed capability input
  --expect <outputName>     repeatable; a value the goal must retrieve
  --base-url <url>          default http://localhost:4173
  --tenant <tenantId>       default meridian-cu
  --max-steps <n>           default 24
  --provider <openai|transcript>   default from LLM_PROVIDER, else openai
  --transcript <file>       for --provider transcript
  --no-save                 do not write the artifact to ${DEFAULT_CAPABILITY_DIR}/

replay options
  --input <name=value>      repeatable
  --base-url <url>          default http://localhost:4173
  --tenant <tenantId>       selects the overlay; default = the recorded tenant
  --allow-unadapted         run against a tenant with no overlay anyway
  --unattended              refuse drafts, require --authorize for irreversible steps
  --authorize "<reason>"    pre-authorise this run's irreversible steps
  --times <n>               replay n times and report a stability signal

common options
  --headed / --headless     default headed, so a handoff is watchable
  --operator-port <n>       default 4180
  --no-operator             do not start the operator console
  --evidence-dir <dir>      default evidence/runs
  --json                    machine-readable result on stdout
`;

async function main(argv: string[]): Promise<number> {
  await loadEnvFile('.env');
  const [command, ...rest] = argv;
  const args = parseArgs(rest);

  switch (command) {
    case 'discover':
      return cmdDiscover(args);
    case 'replay':
      return cmdReplay(args);
    case 'catalog':
      return cmdCatalog(args);
    case 'lint':
      return cmdLint(args);
    case 'approve':
      return cmdApprove(args);
    case 'show':
      return cmdShow(args);
    case 'overlay':
      return cmdOverlay(args);
    case 'invoke':
      return cmdInvoke(args);
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      process.stdout.write(HELP);
      return 0;
    default:
      process.stderr.write(`unknown command '${command}'\n\n${HELP}`);
      return 2;
  }
}

// ---------------------------------------------------------------------------
// discover
// ---------------------------------------------------------------------------

async function cmdDiscover(args: Args): Promise<number> {
  const preset = args.positional[0] ? DEMO_GOALS[args.positional[0]] : undefined;
  if (args.positional[0] && !preset) {
    process.stderr.write(`unknown goal preset '${args.positional[0]}'. Available: ${Object.keys(DEMO_GOALS).join(', ')}\n`);
    return 2;
  }

  const goal = args.str('goal') ?? preset?.goal;
  const capabilityId = args.str('capability-id') ?? preset?.capabilityId;
  if (!goal || !capabilityId) {
    process.stderr.write('discover needs a goal preset, or both --goal and --capability-id\n');
    return 2;
  }

  const baseUrl = args.str('base-url') ?? preset?.baseUrl ?? 'http://localhost:4173';
  const tenantId = args.str('tenant') ?? preset?.tenantId ?? 'meridian-cu';
  const parameters: DiscoveryParameter[] = args.list('param').length ? args.list('param').map(parseParam) : (preset?.parameters ?? []);
  const expectedOutputs = args.list('expect').length ? args.list('expect') : (preset?.expectedOutputs ?? []);

  const provider = await buildProvider(args);
  const vault = SecretVault.fromEnvironment();

  process.stdout.write(
    [
      `discovery run`,
      `  goal        ${goal}`,
      `  capability  ${capabilityId}`,
      `  target      ${baseUrl} (tenant ${tenantId})`,
      `  model       ${provider.id}`,
      `  parameters  ${parameters.map((p) => `${p.name}=${p.sensitivity === 'pii' ? '<pii>' : p.value}`).join(', ') || '(none)'}`,
      `  credentials ${vault.names().join(', ') || '(none)'}`,
      '',
    ].join('\n'),
  );

  let consoleHandle: { url: string; close(): Promise<void> } | undefined;
  const result = await discover({
    ...(args.flag('no-operator') ? { escalationTimeoutMs: 15_000 } : {}),
    goal,
    capabilityId,
    baseUrl,
    entryUrl: preset?.entryUrl ?? `${baseUrl.replace(/\/$/, '')}/login.aspx`,
    appDescription: preset?.appDescription ?? 'A back-office member servicing console.',
    productId: preset?.productId ?? 'corepoint-servicing',
    ...(preset?.productVersion ? { productVersion: preset.productVersion } : {}),
    tenantId,
    parameters,
    expectedOutputs,
    provider,
    maxSteps: args.num('max-steps') ?? 24,
    headless: args.headless(),
    ...(args.str('evidence-dir') ? { evidenceBaseDir: args.str('evidence-dir')! } : {}),
    vault,
    onSurfaceReady: async ({ surface, lease, broker, logger }) => {
      if (args.flag('no-operator')) return;
      try {
        consoleHandle = await startOperatorConsole({
          broker,
          lease,
          page: surface.livePage(),
          port: args.num('operator-port') ?? Number(process.env.OPERATOR_PORT ?? 4180),
          log: (t, d) => logger.event(t, d),
        });
        process.stdout.write(`  operator console: ${consoleHandle.url}\n\n`);
      } catch (err) {
        process.stdout.write(`  operator console unavailable: ${err instanceof Error ? err.message : String(err)}\n  (the run continues; an escalation will time out with no operator)\n\n`);
      }
    },
  });

  await consoleHandle?.close();

  if (result.status !== 'success') {
    process.stdout.write(`\ndiscovery ${result.status}: ${result.reason}\nevidence: ${result.evidenceDir}\n`);
    if (args.flag('json')) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 1;
  }

  const cap = result.capability;
  const findings = lintCapability(cap, vault.values());
  process.stdout.write(
    [
      '',
      `discovery succeeded in ${result.turns} model turns`,
      `  capability  ${cap.id}@${cap.version} (${cap.lifecycle.state})`,
      `  steps       ${cap.steps.length}`,
      `  inputs      ${cap.inputs.map((i) => `${i.name}:${i.type}`).join(', ') || '(none)'}`,
      `  outputs     ${cap.outputs.map((o) => `${o.name}:${o.type}`).join(', ') || '(none)'}`,
      `  outcomes    ${cap.outcomes.map((o) => o.code).join(', ') || '(none)'}`,
      `  interrupts  ${cap.interrupts.map((h) => h.name).join(', ') || '(none)'}`,
      `  evidence    ${result.evidenceDir}`,
      '',
    ].join('\n'),
  );
  printFindings(findings);

  if (findings.some((f) => f.severity === 'error')) {
    process.stderr.write('\nrefusing to save: the artifact has lint errors\n');
    return 1;
  }

  if (!args.flag('no-save')) {
    const { file, digest } = await saveCapability(cap);
    process.stdout.write(`saved ${file}\n  digest ${digest}\n\nnext: npm run replay -- ${cap.id} --input ${cap.inputs.map((i) => `${i.name}=<value>`).join(' --input ')}\n`);
  }
  if (args.flag('json')) process.stdout.write(`${JSON.stringify({ status: 'success', capability: cap.id, version: cap.version, runId: result.runId }, null, 2)}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// replay
// ---------------------------------------------------------------------------

async function cmdReplay(args: Args): Promise<number> {
  const ref = args.positional[0];
  if (!ref) {
    process.stderr.write('replay needs a capability reference, e.g. member.read-savings-balance\n');
    return 2;
  }
  const capability = await loadCapability(ref);
  const inputs = Object.fromEntries(args.list('input').map((kv) => splitOnce(kv, '=')));
  const times = args.num('times') ?? 1;
  const vault = SecretVault.fromEnvironment();

  const results = [];
  for (let attempt = 1; attempt <= times; attempt++) {
    if (times > 1) process.stdout.write(`\n--- run ${attempt}/${times} ---\n`);
    let consoleHandle: { url: string; close(): Promise<void> } | undefined;

    const authorize = args.str('authorize');
    // With no operator console there is nobody who *can* respond, so waiting the
    // full attended timeout just hangs a CI run for fifteen minutes. Timing out is
    // reported as an abort, which is the honest result: nobody approved anything.
    const escalationTimeoutMs = args.flag('no-operator') ? 15_000 : undefined;
    const result = await replay(capability, inputs, {
      ...(escalationTimeoutMs ? { escalationTimeoutMs } : {}),
      baseUrl: args.str('base-url') ?? 'http://localhost:4173',
      ...(args.str('tenant') ? { tenantId: args.str('tenant')! } : {}),
      allowUnadapted: args.flag('allow-unadapted'),
      unattended: args.flag('unattended'),
      ...(authorize ? { authorizeIrreversible: { by: 'cli', reason: authorize } } : {}),
      headless: args.headless(),
      ...(args.str('evidence-dir') ? { evidenceBaseDir: args.str('evidence-dir')! } : {}),
      vault,
      onSurfaceReady: async ({ surface, lease, broker, logger }) => {
        if (args.flag('no-operator')) return;
        try {
          consoleHandle = await startOperatorConsole({
            broker,
            lease,
            page: surface.livePage(),
            port: args.num('operator-port') ?? Number(process.env.OPERATOR_PORT ?? 4180),
            log: (t, d) => logger.event(t, d),
          });
          process.stdout.write(`operator console: ${consoleHandle.url}\n`);
        } catch (err) {
          process.stdout.write(`operator console unavailable: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      },
    });
    await consoleHandle?.close();
    results.push(result);

    if (args.flag('json')) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      printReplay(result);
    }
  }

  if (times > 1) {
    const successes = results.filter((r) => r.status === 'success').length;
    const fallbacks = results.reduce((n, r) => n + r.drift.length, 0);
    process.stdout.write(
      [
        '',
        'stability',
        `  runs              ${times}`,
        `  success           ${successes}/${times} (${((successes / times) * 100).toFixed(0)}%)`,
        `  business outcomes ${results.filter((r) => r.status === 'business_outcome').length}`,
        `  failures          ${results.filter((r) => r.status === 'failed' || r.status === 'escalated').length}`,
        `  locator fallbacks ${fallbacks}`,
        '',
      ].join('\n'),
    );
  }

  const last = results[results.length - 1]!;
  return last.status === 'success' || last.status === 'business_outcome' ? 0 : 1;
}

function printReplay(result: Awaited<ReturnType<typeof replay>>): void {
  const lines: string[] = ['', summarizeResult(result), ''];
  if (result.overlay) {
    lines.push(
      `overlay applied for ${result.overlay.tenantId}: ${result.overlay.labelRewrites} label rewrite(s), ${result.overlay.routeRewrites} route rewrite(s)` +
        (result.overlay.stepsSkipped.length ? `, skipped ${result.overlay.stepsSkipped.join(', ')}` : ''),
      '',
    );
  }
  lines.push('steps');
  for (const s of result.steps) {
    const mark = s.status === 'ok' ? 'ok  ' : s.status === 'failed' ? 'FAIL' : s.status.slice(0, 4);
    const via = s.strategy ? ` via ${s.strategy.kind}${s.strategy.index > 0 ? ` (fallback #${s.strategy.index})` : ''}` : '';
    lines.push(`  ${mark} ${String(s.index + 1).padStart(2)}. ${s.id.padEnd(30)} ${s.action}${via} ${s.durationMs}ms`);
    if (s.error) lines.push(`       ${s.error.code}: ${s.error.message}`);
  }
  if (result.recoveries.length) {
    lines.push('', 'recoveries');
    for (const r of result.recoveries) lines.push(`  ${r.handler} (${r.action}) at ${r.stepId}: ${r.detail}`);
  }
  if (result.drift.length) {
    lines.push('', 'locator drift (fallback strategies fired)');
    for (const d of result.drift) lines.push(`  ${d.stepId}: expected ${d.primaryStrategy}, resolved via ${d.usedStrategy} (#${d.usedIndex})`);
  }
  if (result.status === 'failed' || result.status === 'escalated') {
    const f = result.failure;
    lines.push('', 'failure detail');
    lines.push(`  code      ${f.code}${f.declaredCode ? ` / ${f.declaredCode}` : ''}`);
    if (f.stepId) lines.push(`  step      ${f.stepId} -- ${f.stepIntent ?? ''}`);
    if (f.expected) lines.push(`  expected  ${f.expected}`);
    if (f.observed) lines.push(`  observed  ${f.observed}`);
    if (f.evidence?.screenshot) lines.push(`  screenshot ${f.evidence.screenshot}`);
    if (f.evidence?.snapshot) lines.push(`  snapshot   ${f.evidence.snapshot}`);
  }
  if (result.status === 'business_outcome') {
    lines.push('', 'business outcome', `  ${result.outcome.code}: ${result.outcome.description}`, `  retryable: ${result.outcome.retryable}`);
    if (result.outcome.observed) lines.push(`  observed: ${result.outcome.observed}`);
  }
  if (result.warnings.length) lines.push('', 'warnings', ...result.warnings.map((w) => `  ${w}`));
  lines.push('', `evidence ${result.evidenceDir}`, '');
  process.stdout.write(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// catalog / lint / approve / show
// ---------------------------------------------------------------------------

async function cmdCatalog(args: Args): Promise<number> {
  const catalog = await buildCatalog();
  if (args.flag('json')) {
    process.stdout.write(`${JSON.stringify(catalog, null, 2)}\n`);
    return 0;
  }
  if (catalog.tools.length === 0) {
    process.stdout.write(`no capabilities in ${DEFAULT_CAPABILITY_DIR}/ -- run a discovery first\n`);
    return 0;
  }
  const lines = ['', `${catalog.tools.length} callable capability(ies)`, ''];
  for (const tool of catalog.tools) {
    const rate = tool.stability.successRate === null ? 'never replayed' : `${(tool.stability.successRate * 100).toFixed(0)}% over ${tool.stability.runs} run(s)`;
    lines.push(
      `  ${tool.name}  (${tool.capabilityId}@${tool.version})`,
      `    ${tool.description.split('\n')[0]}`,
      `    args     ${Object.entries(tool.inputSchema.properties).map(([k, v]) => `${k}:${v.type}${tool.inputSchema.required.includes(k) ? '' : '?'}`).join(', ') || '(none)'}`,
      `    returns  ${Object.entries(tool.outputSchema.properties).map(([k, v]) => `${k}:${v.type}`).join(', ') || '(none)'}`,
      `    outcomes ${tool.outcomes.map((o) => o.code).join(', ') || '(none)'}`,
      `    state    ${tool.lifecycle.state}${tool.lifecycle.callableUnattended ? '' : ' (attended only)'} -- ${rate}`,
      `    secrets  ${tool.requiredSecrets.join(', ') || '(none)'}`,
      '',
    );
  }
  process.stdout.write(lines.join('\n'));
  return 0;
}

async function cmdLint(args: Args): Promise<number> {
  const ref = args.positional[0];
  if (!ref) {
    process.stderr.write('lint needs a capability reference\n');
    return 2;
  }
  const cap = await loadCapability(ref);
  const findings = lintCapability(cap, SecretVault.fromEnvironment().values());
  process.stdout.write(`\n${cap.id}@${cap.version}\n`);
  printFindings(findings);
  return findings.some((f) => f.severity === 'error') ? 1 : 0;
}

async function cmdApprove(args: Args): Promise<number> {
  const ref = args.positional[0];
  const by = args.str('by');
  if (!ref || !by) {
    process.stderr.write('approve needs a capability reference and --by "Name <email>"\n');
    return 2;
  }
  const cap = await loadCapability(ref);
  const findings = lintCapability(cap, SecretVault.fromEnvironment().values());
  if (findings.some((f) => f.severity === 'error')) {
    printFindings(findings);
    process.stderr.write('\nrefusing to approve a capability with lint errors\n');
    return 1;
  }
  cap.lifecycle.state = 'approved';
  cap.lifecycle.approvedBy = by;
  cap.lifecycle.approvedAt = new Date().toISOString();
  const { file, digest } = await saveCapability(cap);
  process.stdout.write(`approved ${cap.id}@${cap.version} by ${by}\n  ${file}\n  digest ${digest}\n`);
  return 0;
}

async function cmdShow(args: Args): Promise<number> {
  const ref = args.positional[0];
  if (!ref) {
    process.stderr.write('show needs a capability reference\n');
    return 2;
  }
  const cap = await loadCapability(ref);
  if (args.flag('json')) {
    process.stdout.write(`${JSON.stringify(toToolDefinition(cap), null, 2)}\n`);
    return 0;
  }
  const lines = [
    '',
    `${cap.name}  ${cap.id}@${cap.version}  [${cap.lifecycle.state}]`,
    `${cap.summary}`,
    '',
    `product   ${cap.target.productId}${cap.target.productVersion ? ` ${cap.target.productVersion}` : ''}`,
    `recorded  tenant ${cap.target.recordedTenantId}, ${cap.provenance.model}, ${cap.provenance.modelTurns} turns, ${cap.provenance.recordedAt}`,
    `overlays  ${cap.overlays.map((o) => o.tenantId).join(', ') || '(none)'}`,
    '',
    'steps',
  ];
  cap.steps.forEach((s, i) => {
    const target = 'target' in s.action ? s.action.target.strategies[0] : undefined;
    const how = target
      ? target.kind === 'role-name'
        ? `${target.role} "${target.name}"`
        : target.kind === 'labelled-field'
          ? `field labelled "${target.label}"`
          : target.kind === 'table-cell'
            ? `cell [${target.rowKey} / ${target.columnHeader}]`
            : target.kind
      : s.action.kind === 'navigate'
        ? s.action.url
        : '';
    lines.push(`  ${String(i + 1).padStart(2)}. ${s.id}  [${s.risk}]${s.partOfAuth ? ' [auth]' : ''}`);
    lines.push(`      ${s.intent}`);
    lines.push(`      ${s.action.kind} ${how}`);
    if ('target' in s.action) lines.push(`      fallbacks: ${s.action.target.strategies.map((x) => x.kind).join(' -> ')}`);
    if (s.checkpoint) lines.push(`      checkpoint: ${JSON.stringify(s.checkpoint).slice(0, 150)}`);
    if (s.handlers.length) lines.push(`      handlers: ${s.handlers.map((h) => `${h.name}->${h.then.do}`).join(', ')}`);
  });
  lines.push('', 'interrupts (checked before every step)');
  for (const h of cap.interrupts) lines.push(`  ${h.name} -> ${h.then.do}`);
  lines.push('', `success: ${cap.success.description}`, '');
  process.stdout.write(lines.join('\n'));
  return 0;
}

/**
 * Invoke a capability the way a calling agent would.
 *
 * This is the other half of the catalog. `catalog --json` is what an agent reads to
 * discover a tool; this is what it calls, and the two agree by construction because
 * both come from `toToolDefinition`. The differences from `replay` are the point:
 *
 *  - addressed by **tool name** (`member_read_savings_balance`), not by file or id,
 *    because that is the name the catalog advertises;
 *  - arguments arrive as one **JSON object**, validated against the declared input
 *    schema before anything launches, so a wrong argument name is a typed error and
 *    not a mystery four screens in;
 *  - the result is an **agent-shaped envelope** rather than a human step table. A
 *    business outcome comes back as `ok: false` with a `code` the agent can branch on
 *    and `retryable` telling it whether trying again could possibly help -- which is
 *    the whole reason outcomes are in the schema.
 */
async function cmdInvoke(args: Args): Promise<number> {
  const name = args.positional[0];
  if (!name) {
    process.stderr.write("invoke needs a tool name (see `ledgerhand catalog`) and --args '{...}'\n");
    return 2;
  }

  const catalog = await buildCatalog();
  const tool =
    catalog.tools.find((t) => t.name === name) ??
    catalog.tools.find((t) => t.capabilityId === name);
  if (!tool) {
    process.stderr.write(`no callable capability named '${name}'. Available: ${catalog.tools.map((t) => t.name).join(', ') || '(none)'}\n`);
    return 2;
  }

  let parsedArgs: Record<string, unknown>;
  try {
    parsedArgs = JSON.parse(args.str('args') ?? '{}') as Record<string, unknown>;
  } catch (err) {
    process.stderr.write(`--args is not valid JSON: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  // Check the arguments against the advertised schema before doing anything. The
  // engine validates too; doing it here as well means the error names the *tool's*
  // contract, which is what the caller was reading.
  const missing = tool.inputSchema.required.filter((k) => parsedArgs[k] === undefined);
  const unknown = Object.keys(parsedArgs).filter((k) => !(k in tool.inputSchema.properties));
  if (missing.length || unknown.length) {
    const envelope = {
      ok: false as const,
      error: {
        code: 'INVALID_ARGUMENTS',
        message: [
          missing.length ? `missing required argument(s): ${missing.join(', ')}` : '',
          unknown.length ? `unknown argument(s): ${unknown.join(', ')}` : '',
        ]
          .filter(Boolean)
          .join('; '),
        expected: tool.inputSchema,
      },
    };
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    return 1;
  }

  if (args.flag('unattended') && !tool.lifecycle.callableUnattended) {
    process.stdout.write(
      `${JSON.stringify(
        { ok: false, error: { code: 'NOT_APPROVED', message: `'${tool.name}' is in lifecycle state '${tool.lifecycle.state}' and cannot be called unattended` } },
        null,
        2,
      )}\n`,
    );
    return 1;
  }

  const capability = await loadCapability(tool.capabilityId);
  const authorize = args.str('authorize');
  const result = await replay(capability, parsedArgs, {
    baseUrl: args.str('base-url') ?? 'http://localhost:4173',
    ...(args.str('tenant') ? { tenantId: args.str('tenant')! } : {}),
    unattended: args.flag('unattended'),
    ...(authorize ? { authorizeIrreversible: { by: 'invoke', reason: authorize } } : {}),
    headless: args.headless(),
    escalationTimeoutMs: 15_000,
    ...(args.str('evidence-dir') ? { evidenceBaseDir: args.str('evidence-dir')! } : {}),
  });

  process.stdout.write(`${JSON.stringify(toAgentEnvelope(tool.name, result), null, 2)}\n`);
  return result.status === 'success' ? 0 : 1;
}

/** The shape a calling agent sees. Deliberately small: outcome, outputs, or error. */
function toAgentEnvelope(tool: string, result: Awaited<ReturnType<typeof replay>>) {
  const base = { tool, runId: result.runId, evidence: result.evidenceDir };
  switch (result.status) {
    case 'success':
      return { ok: true, ...base, outputs: result.outputs };
    case 'business_outcome':
      return {
        ok: false,
        ...base,
        outcome: { code: result.outcome.code, message: result.outcome.description, retryable: result.outcome.retryable },
      };
    case 'escalated':
      return {
        ok: false,
        ...base,
        error: { code: 'ESCALATED', message: result.failure.message, step: result.failure.stepId, intervention: result.intervention.id },
      };
    default:
      return {
        ok: false,
        ...base,
        error: { code: result.failure.code, message: result.failure.message, step: result.failure.stepId, observed: result.failure.observed },
      };
  }
}

/**
 * Attach a tenant overlay to a capability.
 *
 * The overlay is applied immediately and the *result* is validated, so an overlay
 * that would produce an invalid capability is rejected at attach time rather than
 * mid-run against that tenant's live application. The audit of what it rewrote is
 * printed, because "four labels and four routes" is the number a reviewer wants to
 * see before approving it.
 */
async function cmdOverlay(args: Args): Promise<number> {
  const [ref, file] = args.positional;
  if (!ref || !file) {
    process.stderr.write('overlay needs a capability reference and an overlay json file\n');
    return 2;
  }
  const cap = await loadCapability(ref);
  const raw = JSON.parse(await readFile(file, 'utf8')) as unknown;
  const parsed = overlaySchema.safeParse(raw);
  if (!parsed.success) {
    process.stderr.write(`${file} is not a valid overlay:\n${parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}\n`);
    return 1;
  }
  const overlay = parsed.data;

  const { audit } = applyOverlay(cap, overlay);

  cap.overlays = [...cap.overlays.filter((o) => o.tenantId !== overlay.tenantId), overlay];
  const { file: written, digest } = await saveCapability(cap);

  process.stdout.write(
    [
      '',
      `attached overlay for ${overlay.tenantId} to ${cap.id}@${cap.version}`,
      `  ${overlay.description}`,
      '',
      `  label rewrites  ${audit.labelRewrites.length}`,
      ...audit.labelRewrites.map((r) => `    "${r.from}" -> "${r.to}"  (${r.at})`),
      `  route rewrites  ${audit.routeRewrites.length}`,
      ...audit.routeRewrites.map((r) => `    ${r.from} -> ${r.to}  (${r.at})`),
      `  extra interrupts ${audit.interruptsAdded.length ? audit.interruptsAdded.join(', ') : '(none)'}`,
      `  steps skipped    ${audit.stepsSkipped.length ? audit.stepsSkipped.join(', ') : '(none)'}`,
      '',
      `  ${written}`,
      `  digest ${digest}`,
      '',
      `next: npm run replay -- ${cap.id} --tenant ${overlay.tenantId} --base-url http://localhost:4174 --input ${cap.inputs.map((i) => `${i.name}=<value>`).join(' --input ')}`,
      '',
    ].join('\n'),
  );
  return 0;
}

function printFindings(findings: { severity: string; code: string; message: string; where?: string }[]): void {
  if (findings.length === 0) {
    process.stdout.write('lint: clean\n');
    return;
  }
  process.stdout.write('lint\n');
  for (const f of findings) {
    process.stdout.write(`  ${f.severity === 'error' ? 'ERROR' : 'warn '} ${f.code}${f.where ? ` (${f.where})` : ''}: ${f.message}\n`);
  }
}

// ---------------------------------------------------------------------------
// plumbing
// ---------------------------------------------------------------------------

async function buildProvider(args: Args): Promise<LlmProvider> {
  const kind = args.str('provider') ?? process.env.LLM_PROVIDER ?? 'openai';
  if (kind === 'transcript' || kind === 'replay') {
    const file = args.str('transcript');
    if (!file) throw new Error('--provider transcript requires --transcript <file>');
    return TranscriptProvider.fromFile(file);
  }
  if (kind !== 'openai') throw new Error(`unknown provider '${kind}'. Supported: openai, transcript.`);
  return new OpenAiProvider();
}

/**
 * `--param memberId=12345:string:pii` -- type and sensitivity are optional and
 * default to string/internal. Declaring sensitivity at the point the value enters
 * the system is what lets the redactor know about it before anything is logged.
 */
function parseParam(raw: string): DiscoveryParameter {
  const [name, tail] = splitOnce(raw, '=');
  const parts = tail.split(':');
  const value = parts[0] ?? '';
  const type = (parts[1] ?? 'string') as DiscoveryParameter['type'];
  const sensitivity = (parts[2] ?? 'internal') as DiscoveryParameter['sensitivity'];
  const pattern = parts.slice(3).join(':') || undefined;
  if (!['string', 'number', 'money'].includes(type)) throw new Error(`--param ${name}: unsupported type '${type}'`);
  if (!['public', 'internal', 'pii'].includes(sensitivity)) throw new Error(`--param ${name}: unsupported sensitivity '${sensitivity}'`);
  return { name, value, type, sensitivity, ...(pattern ? { pattern } : {}), description: `${name} supplied by the calling agent` };
}

function splitOnce(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep);
  return i === -1 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)];
}

interface Args {
  positional: string[];
  flag(name: string): boolean;
  str(name: string): string | undefined;
  num(name: string): number | undefined;
  list(name: string): string[];
  headless(): boolean;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string[]>();

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags.add(name);
    } else {
      const list = values.get(name) ?? [];
      list.push(next);
      values.set(name, list);
      i++;
    }
  }

  return {
    positional,
    flag: (name) => flags.has(name),
    str: (name) => values.get(name)?.[0],
    num: (name) => {
      const raw = values.get(name)?.[0];
      if (raw === undefined) return undefined;
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`--${name} expects a number, got '${raw}'`);
      return n;
    },
    list: (name) => values.get(name) ?? [],
    headless: () => {
      if (flags.has('headless')) return true;
      if (flags.has('headed')) return false;
      return process.env.HEADLESS === 'true';
    },
  };
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`\n${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
