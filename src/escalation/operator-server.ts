/**
 * The operator console server.
 *
 * The brief allows mocking the operator UI. This is not mocked, and the reason is
 * that the interesting part of the requirement is not the UI -- it is the claim
 * that a human can drive *the same live session* the automation was using, and
 * then give it back. A mocked console cannot demonstrate that; a real one can, and
 * it costs about two hundred lines.
 *
 * How control actually transfers:
 *
 *   - The browser session is a single long-lived Playwright context. There is no
 *     second session and no re-login, so cookies, the app's server-side session,
 *     the current screen, and the half-filled form are all exactly as the
 *     automation left them.
 *   - Pixels go out over a CDP `Page.startScreencast`.
 *   - Input comes back in over CDP `Input.dispatchMouseEvent` / `insertText` /
 *     `dispatchKeyEvent`, aimed at the same page.
 *   - The ControlLease decides which side may act. Automation is blocked by
 *     LeaseGuard while the operator holds it; the server refuses to forward input
 *     while automation holds it. One owner, enforced on both sides.
 *   - Everything the human does is captured by the injected recorder and attached
 *     to the intervention record.
 *
 * What is genuinely cut: authentication (the console is bound to localhost and
 * has no login), multi-operator routing, and a durable queue. Those are
 * deployment concerns that do not change the control-transfer model.
 */

import express from 'express';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { CDPSession, Page } from 'playwright';
import type { ControlLease } from './control.js';
import type { InterventionBroker, InterventionDecision } from './broker.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export interface OperatorConsoleOptions {
  broker: InterventionBroker;
  lease: ControlLease;
  /** The live page. The same one the automation drives -- that is the point. */
  page: Page;
  port?: number;
  log?: (type: string, data: Record<string, unknown>) => void;
}

export interface OperatorConsole {
  url: string;
  close(): Promise<void>;
}

export async function startOperatorConsole(opts: OperatorConsoleOptions): Promise<OperatorConsole> {
  const { broker, lease, page } = opts;
  const port = opts.port ?? Number(process.env.OPERATOR_PORT ?? 4180);
  const log = opts.log ?? (() => {});

  const app = express();
  app.use(express.json());

  const consoleHtml = await readFile(join(HERE, 'operator-console.html'), 'utf8');
  app.get('/', (_req, res) => {
    res.type('html').send(consoleHtml);
  });

  app.get('/api/state', (_req, res) => {
    res.json({
      lease: lease.current(),
      leaseTransitions: lease.transitions(),
      interventions: broker.list(),
    });
  });

  app.post('/api/interventions/:id/claim', (req, res) => {
    try {
      const operator = String(req.body?.operator ?? 'operator');
      const item = broker.claim(req.params.id!, operator);
      res.json({ ok: true, intervention: item });
    } catch (err) {
      res.status(400).json({ ok: false, error: message(err) });
    }
  });

  app.post('/api/interventions/:id/resolve', (req, res) => {
    try {
      const decision = String(req.body?.decision ?? '') as InterventionDecision;
      if (!['resume', 'authorize-and-resume', 'skip-step', 'abort'].includes(decision)) {
        res.status(400).json({ ok: false, error: `unknown decision '${decision}'` });
        return;
      }
      const item = broker.resolve(req.params.id!, decision, String(req.body?.by ?? 'operator'), req.body?.note ? String(req.body.note) : undefined);
      res.json({ ok: true, intervention: item });
    } catch (err) {
      res.status(400).json({ ok: false, error: message(err) });
    }
  });

  const server: Server = createServer(app);

  /**
   * Reject websocket connections that did not come from the console itself.
   *
   * The live channel forwards mouse and keyboard input into a signed-on banking
   * session. Without an origin check, any page the operator happens to have open in
   * another tab could connect to ws://127.0.0.1:<port>/live and -- whenever the lease
   * happens to sit with the operator -- drive that session. Binding to localhost stops
   * remote attackers, not local pages.
   *
   * This is proportionate rather than complete: `Origin` is set by browsers and can be
   * omitted by a non-browser client, so it stops the drive-by case and not a
   * determined local process. A per-session bearer token minted with the intervention
   * would close that, and is the right next step if this ever leaves a workstation.
   */
  const expectedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const wss = new WebSocketServer({
    server,
    path: '/live',
    verifyClient: ({ origin }, done) => {
      if (origin && !expectedOrigins.has(origin)) {
        log('operator.console.rejectedOrigin', { origin });
        done(false, 403, 'origin not permitted');
        return;
      }
      done(true);
    },
  });

  wss.on('connection', (socket: WebSocket) => {
    void attachLiveSession(socket, page, lease, log);
  });

  // Bind failures must not take the run down with them.
  //
  // Without this, an EADDRINUSE surfaces as an unhandled 'error' event on the
  // WebSocketServer and crashes the process -- so a stale console from an earlier run
  // holding the port would kill an unrelated replay. The console is how a human gets
  // involved; it is not a precondition for the automation working.
  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener('listening', onListening);
      reject(
        new Error(
          err.code === 'EADDRINUSE'
            ? `operator console port ${port} is already in use (another run may still be holding it)`
            : `operator console failed to start: ${err.message}`,
        ),
      );
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
  // Past the bind, a socket-level error should be logged, not thrown.
  server.on('error', (err) => log('operator.console.error', { error: err.message }));
  wss.on('error', (err) => log('operator.console.error', { error: err.message }));

  const url = `http://127.0.0.1:${port}/`;
  log('operator.console.started', { url });

  return {
    url,
    async close() {
      for (const client of wss.clients) client.close();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * One websocket = one live view.
 *
 * Screencast frames must be acknowledged or Chromium stops sending them, so the
 * ack is not optional bookkeeping -- forgetting it looks exactly like a frozen
 * session.
 */
async function attachLiveSession(
  socket: WebSocket,
  page: Page,
  lease: ControlLease,
  log: (type: string, data: Record<string, unknown>) => void,
): Promise<void> {
  let cdp: CDPSession | undefined;
  try {
    cdp = await page.context().newCDPSession(page);
  } catch (err) {
    socket.send(JSON.stringify({ type: 'error', message: `could not attach to the live session: ${message(err)}` }));
    socket.close();
    return;
  }

  const canDrive = () => lease.current() === 'operator';

  cdp.on('Page.screencastFrame', async (frame: { data: string; sessionId: number }) => {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ type: 'frame', data: frame.data, canDrive: canDrive() }));
    }
    try {
      await cdp!.send('Page.screencastFrameAck', { sessionId: frame.sessionId });
    } catch {
      /* session detached */
    }
  });

  try {
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 55, maxWidth: 1280, maxHeight: 900, everyNthFrame: 1 });
  } catch (err) {
    socket.send(JSON.stringify({ type: 'error', message: `screencast unavailable: ${message(err)}` }));
  }

  socket.on('message', async (raw) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      return;
    }

    // A screencast only emits on repaint, and the screen an operator is summoned to
    // look at is typically static, so a fresh connection can sit blank indefinitely.
    // Restarting the screencast forces one frame out. Allowed regardless of the
    // lease: it is a read.
    if (msg.type === 'requestFrame') {
      try {
        await cdp!.send('Page.stopScreencast');
        await cdp!.send('Page.startScreencast', { format: 'jpeg', quality: 55, maxWidth: 1280, maxHeight: 900, everyNthFrame: 1 });
      } catch {
        /* session detached */
      }
      return;
    }

    // The lease is re-checked on every single input event rather than at connect
    // time. An operator who has already returned control must not be able to keep
    // clicking into a session the automation has resumed driving.
    if (!canDrive()) return;
    try {
      await dispatch(cdp!, msg);
      // Logged at a summary level: an operator typing produces a lot of events, and
      // the characters themselves are already captured -- redacted -- on the
      // intervention record by the human-action recorder.
      log('operator.input.forwarded', { kind: String(msg.type), length: msg.type === 'text' ? String(msg.text ?? '').length : undefined });
    } catch (err) {
      log('operator.input.failed', { error: message(err), kind: msg.type });
    }
  });

  const stop = async () => {
    try {
      await cdp?.send('Page.stopScreencast');
    } catch {
      /* ignored */
    }
    try {
      await cdp?.detach();
    } catch {
      /* ignored */
    }
  };
  socket.on('close', stop);
  socket.on('error', stop);
}

/**
 * Input messages arrive from a websocket, so the allowed values are enumerated
 * rather than passed through. This is not only to satisfy the CDP types: the
 * console is the one component here that accepts input from outside the process,
 * and `Input.dispatchMouseEvent` with an attacker-chosen event type aimed at a
 * live banking session is not something to be relaxed about.
 */
const MOUSE_EVENTS = ['mousePressed', 'mouseReleased', 'mouseMoved'] as const;
type MouseEventType = (typeof MOUSE_EVENTS)[number];
const MOUSE_BUTTONS = ['left', 'middle', 'right'] as const;
type MouseButtonName = (typeof MOUSE_BUTTONS)[number];

function asMouseEvent(v: unknown): MouseEventType | undefined {
  return MOUSE_EVENTS.find((e) => e === v);
}
function asMouseButton(v: unknown): MouseButtonName {
  return MOUSE_BUTTONS.find((b) => b === v) ?? 'left';
}
/** Bounded so a malformed frame cannot dispatch to a wild coordinate. */
function asCoord(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(10_000, Math.round(n))) : 0;
}

async function dispatch(cdp: CDPSession, msg: Record<string, unknown>): Promise<void> {
  const x = asCoord(msg.x);
  const y = asCoord(msg.y);
  switch (msg.type) {
    case 'mouse': {
      const event = asMouseEvent(msg.event);
      if (!event) return;
      await cdp.send('Input.dispatchMouseEvent', {
        type: event,
        x,
        y,
        button: asMouseButton(msg.button),
        clickCount: event === 'mouseMoved' ? 0 : 1,
      });
      return;
    }
    case 'scroll':
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: Number(msg.dy ?? 0) });
      return;
    case 'text': {
      // Length-capped so one message cannot paste a novel into a field.
      const text = String(msg.text ?? '').slice(0, 256);
      if (!text) return;

      // Typing into a frameset is fussier than clicking into one.
      //
      // `Input.insertText` targets the focused node of the *page*, and on a frameset
      // the focused node lives in a child document, so it inserts nothing. A bare
      // `char` event is not reliable either. What does work is the full
      // keyDown/keyUp pair with `text` set and a virtual key code -- the same
      // sequence Playwright synthesises for `keyboard.type` -- because that is what
      // the renderer's input pipeline expects before it will route a key to the
      // focused element in a subframe.
      //
      // Worth recording how this presented: forwarded mouse clicks worked
      // immediately, typing silently did nothing, and because a screencast only
      // emits on repaint the stale frame made it look like it had worked. The
      // ground truth came from asking the application what it had actually stored.
      for (const ch of text) {
        const code = ch.toUpperCase().charCodeAt(0);
        await cdp.send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: ch,
          text: ch,
          unmodifiedText: ch,
          windowsVirtualKeyCode: code,
          nativeVirtualKeyCode: code,
        });
        await cdp.send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: ch,
          windowsVirtualKeyCode: code,
          nativeVirtualKeyCode: code,
        });
      }
      return;
    }
    case 'key': {
      const key = String(msg.key ?? '');
      const mapped = KEY_MAP[key];
      if (!mapped) return;
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...mapped });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...mapped });
      return;
    }
    default:
      return;
  }
}

/** Only the keys an operator needs to complete a form. */
const KEY_MAP: Record<string, { key: string; code: string; windowsVirtualKeyCode: number; text?: string }> = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
};

function message(err: unknown): string {
  return err instanceof Error ? err.message.split('\n')[0]! : String(err);
}
