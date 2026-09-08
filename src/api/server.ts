/**
 * The HTTP surface.
 *
 * What this is *for* shapes what it does and does not do. A capability is a bank
 * operation: it drives a real browser against a real servicing console for
 * seconds at a time, and some of them move money. That makes this a job-shaped
 * API, not a CRUD one -- there is no useful "list resources" story, and the
 * interesting endpoints are "what can you do" and "do it, carefully".
 *
 * Three decisions worth defending:
 *
 *  - **Invocation is synchronous.** A replay takes ~8-30 seconds, which is long
 *    for a request and far too short to justify a queue, a job table and a
 *    polling protocol. The seam for that is one function (`invokeCapability`), so
 *    moving to 202 + `/runs/:id` later touches this file and nothing else. Queues
 *    are exactly the scaling infrastructure the brief says not to build early.
 *  - **The catalog is the schema.** `GET /capabilities` emits the same typed tool
 *    definitions an LLM gets, so the API documents itself and cannot drift from
 *    what the agent sees -- they are the same object.
 *  - **Irreversible work needs a stated reason.** A caller cannot post a transfer
 *    without `authorize.reason`, which lands in the evidence bundle. The gate is
 *    the same one the CLI uses; this just carries the caller's justification into
 *    it.
 *
 * Cut deliberately: authentication, rate limiting, and persistence of run history
 * beyond the evidence directory on disk. This binds to localhost for a demo. In a
 * real deployment the auth seam is one middleware and the run history is a table,
 * neither of which changes the execution model.
 */

import express, { type Express, type Request, type Response, type ErrorRequestHandler } from 'express';
import type { Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { invokeCapability, listTools, findTool, type InvokeOptions } from './invoke.js';
import { buildCatalog } from '../artifact/catalog.js';
import { attachRunConsole, activeRuns, runHistory, evidenceList, evidenceFile } from './runs.js';
import { z } from 'zod';
import { SecretVault } from '../policy/vault.js';

export interface ApiOptions {
  port?: number;
  host?: string;
  capabilityDir?: string;
  /** Defaults applied to every invocation unless the request overrides them. */
  invokeDefaults?: Pick<InvokeOptions, 'baseUrl' | 'headless' | 'evidenceBaseDir' | 'unattended' | 'escalationTimeoutMs'>;
  vault?: SecretVault;
  log?: (event: string, detail: Record<string, unknown>) => void;
  /** Serve the operator-facing UI from the same origin. Default true. */
  dashboard?: boolean;
  /** Chat endpoint needs a model; absent, /chat returns 501 rather than pretending. */
  chat?: ChatBackend;
  /**
   * Teaching a new capability from the UI. Absent, `/discover` returns 501.
   *
   * Kept as a callback for the same reason as `chat`: the API layer stays free of
   * an LLM dependency, and `serve` still runs without a key -- with the feature
   * visibly off rather than silently broken.
   */
  discover?: DiscoverBackend;
}

export interface DiscoverRequest {
  goal: string;
  capabilityId: string;
  parameters: { name: string; value: string }[];
  expectedOutputs: string[];
}

export interface DiscoverBackend {
  run(req: DiscoverRequest): Promise<{
    ok: boolean;
    capabilityId?: string;
    steps?: number;
    turns?: number;
    outputs?: string[];
    evidence?: string;
    reason?: string;
    lint?: { severity: string; code: string; message: string }[];
  }>;
}

/**
 * The chatbot's one job: turn a sentence into a capability call.
 *
 * Modelled as an interface rather than an OpenAI import so the API layer has no
 * LLM dependency of its own -- and so `serve` still runs, with chat disabled,
 * for anyone without a key.
 */
export interface ChatBackend {
  configureInvocation?(defaults: InvokeOptions): void;
  reply(message: string, history: ChatTurn[]): Promise<ChatReply>;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatReply {
  /** What to say back. */
  message: string;
  /** Set when the model chose to call a capability. */
  invoked?: { name: string; arguments: Record<string, unknown>; envelope: unknown };
  invocations?: { name: string; arguments: Record<string, unknown>; envelope: unknown }[];
}

export interface ApiHandle {
  url: string;
  app: Express;
  close(): Promise<void>;
}

export function buildApi(opts: ApiOptions = {}): Express {
  opts.chat?.configureInvocation?.({ ...opts.invokeDefaults, vault: opts.vault ?? SecretVault.fromEnvironment() });
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  const log = opts.log ?? (() => {});
  const evidenceBaseDir = opts.invokeDefaults?.evidenceBaseDir ?? 'evidence/runs';
  let busy = false;
  app.use((req, res, next) => {
    if (req.method !== 'POST') return next();
    const origin = req.get('origin');
    if (origin && origin !== `${req.protocol}://${req.get('host')}`) { res.status(403).json({ ok: false, error: { code: 'ORIGIN_DENIED', message: 'Use the local dashboard origin' } }); return; }
    if (busy) { res.status(409).json({ ok: false, error: { code: 'RUN_BUSY', message: 'Another task is running. Finish or resolve it before starting another.' } }); return; }
    busy = true;
    // Keep the lease until processing finishes, even if the browser client disconnects.
    const end = res.end.bind(res);
    res.end = ((...args: Parameters<typeof res.end>) => { busy = false; return end(...args); }) as typeof res.end;
    next();
  });
  app.get('/runs', async (_req, res) => res.json({ runs: await runHistory(evidenceBaseDir), busy }));
  app.get('/runs/active', (_req, res) => res.json({ runs: activeRuns(), busy }));
  app.get('/runs/:id/evidence', async (req, res) => {
    if (!/^(replay|discovery)-[\w-]+$/.test(req.params.id!)) { res.status(400).json({ error: 'invalid run id' }); return; }
    res.json({ files: await evidenceList(evidenceBaseDir, req.params.id!) });
  });
  app.get('/runs/:id/evidence/:kind/:name', async (req, res) => {
    const file = await evidenceFile(evidenceBaseDir, req.params.id!, req.params.kind!, req.params.name!);
    if (!file) { res.status(404).json({ error: 'evidence unavailable' }); return; }
    res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    res.set('X-Content-Type-Options', 'nosniff');
    res.type(req.params.kind === 'screenshots' ? 'png' : 'text/plain').send(await readFile(file));
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'ledgerhand', time: new Date().toISOString() });
  });

  // The agent's tool list and the API's documentation are the same object.
  app.get('/capabilities', async (_req, res) => {
    const catalog = await buildCatalog(opts.capabilityDir, evidenceBaseDir);
    res.json({
      generatedAt: catalog.generatedAt,
      capabilities: catalog.tools.map((t) => ({
        name: t.name,
        capabilityId: t.capabilityId,
        productId: t.productId,
        version: t.version,
        summary: t.summary,
        description: t.description,
        inputSchema: t.inputSchema,
        outputSchema: t.outputSchema,
        outcomes: t.outcomes,
        lifecycle: t.lifecycle,
        // A caller has to know this can change records before it calls it, not
        // after. The dashboard uses it to demand an authorization reason.
        maxRisk: t.maxRisk,
        // Surfaced because a caller deciding whether to trust an unattended
        // invocation wants the replay history, not just the approval flag.
        stability: t.stability,
        requiredSecrets: t.requiredSecrets,
      })),
    });
  });

  app.get('/capabilities/:name', async (req, res) => {
    const tool = await findTool(req.params.name!, opts.capabilityDir, evidenceBaseDir);
    if (!tool) {
      res.status(404).json({ ok: false, error: { code: 'NO_SUCH_CAPABILITY', message: `no capability named '${req.params.name}'` } });
      return;
    }
    res.json(tool);
  });

  app.post('/capabilities/:name/invoke', async (req: Request, res: Response) => {
    const name = req.params.name!;
    const parsed = z.object({
      arguments: z.record(z.unknown()).default({}),
      authorize: z.object({ by: z.string().trim().min(1).optional(), reason: z.string().trim().min(1) }).optional(),
      tenantId: z.string().min(1).optional(),
      unattended: z.boolean().optional(),
    }).strict().safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ ok: false, error: { code: 'INVALID_ARGUMENTS', message: 'Invalid request. Supply arguments and optional authorization; destinations are server configured.' } }); return; }
    const body = parsed.data;

    const started = Date.now();
    log('invoke.start', { capability: name, unattended: Boolean(body.unattended) });

    try {
      const envelope = await invokeCapability(name, body.arguments ?? {}, {
        ...opts.invokeDefaults,
        onSurfaceReady: attachRunConsole,
        ...(body.tenantId ? { tenantId: body.tenantId } : {}),
        unattended: Boolean(opts.invokeDefaults?.unattended || body.unattended),
        ...(body.authorize?.reason
          ? { authorizeIrreversible: { by: body.authorize.by ?? 'api', reason: body.authorize.reason } }
          : {}),
        ...(opts.capabilityDir ? { capabilityDir: opts.capabilityDir } : {}),
        ...(opts.vault ? { vault: opts.vault } : {}),
      });

      log('invoke.finish', { capability: name, ok: envelope.ok, ms: Date.now() - started });
      res.status(statusFor(envelope)).json(envelope);
    } catch (err) {
      // An exception here is a defect in this system, not a result the caller
      // asked about, so it is the one case that gets a 500.
      log('invoke.crashed', { capability: name, message: err instanceof Error ? err.message : String(err) });
      res.status(500).json({
        ok: false,
        tool: name,
        error: { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) },
      });
    }
  });

  // Natural language in, capability call out. Disabled rather than faked when no
  // model is configured: a chat endpoint that cannot call a model should say so.
  /**
   * Teach a new capability, live.
   *
   * This is the half of the system a catalog cannot show: everything else here
   * replays something already recorded, and this is where a recording comes from.
   * It is the same `discover` the CLI runs -- not a second implementation -- so a
   * capability learned from this button is indistinguishable from one learned at
   * the terminal, including its evidence bundle.
   *
   * Slow and fallible by nature: a model is driving a real browser. The response
   * says which, rather than collapsing both into a 500.
   */
  app.post('/discover', async (req: Request, res: Response) => {
    if (!opts.discover) {
      res.status(501).json({
        ok: false,
        error: { code: 'DISCOVERY_UNAVAILABLE', message: 'no model configured; set OPENAI_API_KEY and restart' },
      });
      return;
    }
    const body = (req.body ?? {}) as Partial<DiscoverRequest>;
    const goal = typeof body.goal === 'string' ? body.goal.trim() : '';
    if (!goal || (body.parameters !== undefined && (!Array.isArray(body.parameters) || body.parameters.some((p) => !p || typeof p.name !== 'string' || typeof p.value !== 'string'))) || (body.expectedOutputs !== undefined && (!Array.isArray(body.expectedOutputs) || body.expectedOutputs.some((o) => typeof o !== 'string')))) {
      res.status(400).json({ ok: false, error: { code: 'INVALID_ARGUMENTS', message: 'goal is required' } });
      return;
    }
    // A capability needs an id to be saved under. Deriving one from the goal beats
    // making the operator invent dotted-kebab names in front of an audience.
    const capabilityId =
      (typeof body.capabilityId === 'string' && body.capabilityId.trim()) ||
      `adhoc.${goal.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 5).join('-') || 'capability'}`;

    log('discover.start', { capabilityId });
    try {
      const result = await opts.discover.run({
        goal,
        capabilityId,
        parameters: Array.isArray(body.parameters) ? body.parameters : [],
        expectedOutputs: Array.isArray(body.expectedOutputs) ? body.expectedOutputs : [],
      });
      log('discover.finish', { capabilityId, ok: result.ok });
      res.status(result.ok ? 200 : 422).json(result);
    } catch (err) {
      log('discover.error', { capabilityId, message: err instanceof Error ? err.message : String(err) });
      res.status(500).json({
        ok: false,
        error: { code: 'DISCOVERY_FAILED', message: err instanceof Error ? err.message : String(err) },
      });
    }
  });

  app.post('/chat', async (req, res) => {
    if (!opts.chat) {
      res.status(501).json({
        ok: false,
        error: {
          code: 'CHAT_UNAVAILABLE',
          message: 'no model is configured for chat. Set OPENAI_API_KEY and restart, or use /capabilities/:name/invoke directly.',
        },
      });
      return;
    }
    const body = (req.body ?? {}) as { message?: string; history?: ChatTurn[] };
    if (typeof body.message !== 'string' || !body.message.trim() || (body.history !== undefined && (!Array.isArray(body.history) || body.history.some((h) => !h || !['user', 'assistant'].includes(h.role) || typeof h.content !== 'string')))) {
      res.status(400).json({ ok: false, error: { code: 'INVALID_ARGUMENTS', message: 'message is required' } });
      return;
    }
    try {
      log('chat.start', { chars: body.message.length });
      const reply = await opts.chat.reply(body.message, body.history ?? []);
      log('chat.finish', { invoked: reply.invoked?.name ?? null });
      res.json({ ok: true, ...reply });
    } catch (err) {
      log('chat.crashed', { message: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) } });
    }
  });

  if (opts.dashboard !== false) {
    const file = new URL('./dashboard.html', import.meta.url);
    app.get('/', async (_req, res) => {
      try {
        res.type('html').send(await readFile(file, 'utf8'));
      } catch {
        res.status(500).type('text').send('dashboard.html is missing; run npm run build or use --no-dashboard');
      }
    });
  }

  const errors: ErrorRequestHandler = (_err, _req, res, _next) => {
    res.status(400).json({ ok: false, error: { code: 'INVALID_ARGUMENTS', message: 'Malformed JSON request.' } });
  };
  app.use(errors);
  return app;
}

/**
 * HTTP status from the envelope.
 *
 * The mapping is the point of the whole result contract, so it is worth being
 * explicit: a business outcome is **200**. "No such member" is a successful
 * interaction with the bank that produced an answer the caller must handle; it is
 * not a client error and it is certainly not a server error. Returning 404 for it
 * would collapse the exact distinction this system exists to preserve.
 */
export function statusFor(envelope: { ok: boolean; outcome?: unknown; error?: { code?: string } }): number {
  if (envelope.ok) return 200;
  if (envelope.outcome) return 200;
  switch (envelope.error?.code) {
    case 'NO_SUCH_CAPABILITY':
      return 404;
    case 'INVALID_INPUT':
    case 'INVALID_ARGUMENTS':
    case 'NOT_APPROVED':
      return 400;
    case 'ESCALATED':
      // The run stopped and is waiting on, or was abandoned by, a human. Not the
      // caller's fault and not retryable without intervention.
      return 409;
    default:
      return 502; // the automation failed against the upstream application
  }
}

export async function startApi(opts: ApiOptions = {}): Promise<ApiHandle> {
  const app = buildApi(opts);
  const port = opts.port ?? Number(process.env.API_PORT ?? 4190);
  const host = opts.host ?? '127.0.0.1';
  const server: Server = await new Promise((resolve, reject) => {
    const s = app.listen(port, host, () => resolve(s));
    s.on('error', reject);
  });
  // Read the port back off the socket rather than echoing what was asked for:
  // port 0 means "pick one", and a URL saying :0 is unusable.
  const address = server.address();
  const bound = typeof address === 'object' && address ? address.port : port;
  return {
    url: `http://${host}:${bound}`,
    app,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

