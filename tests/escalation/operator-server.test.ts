import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { startOperatorConsole } from '../../src/escalation/operator-server.js';
import { ControlLease } from '../../src/escalation/control.js';
import { InterventionBroker } from '../../src/escalation/broker.js';

/**
 * The operator console is a convenience for a human, not a precondition for the
 * automation working. If it cannot bind, the run must continue.
 *
 * This is a regression test for a real crash: the WebSocketServer attached to the http
 * server re-emits that server's errors, and its error listener was registered *after*
 * `listen()`. So a failed bind emitted 'error' on an emitter with no listener, Node
 * threw, and an unrelated replay died with EADDRINUSE -- the exact opposite of what the
 * surrounding code claimed to do. A stale console from an earlier run was enough to
 * trigger it.
 */
const PORT = 4199;
let squatter: Server | undefined;
let consoleHandle: { close(): Promise<void> } | undefined;

/** startOperatorConsole only touches `page` when a websocket connects. */
const fakePage = {} as Page;

afterEach(async () => {
  await consoleHandle?.close().catch(() => {});
  consoleHandle = undefined;
  await new Promise<void>((r) => (squatter ? squatter.close(() => r()) : r()));
  squatter = undefined;
});

describe('startOperatorConsole bind failure', () => {
  it('rejects with an actionable message instead of crashing the process', async () => {
    squatter = createServer();
    await new Promise<void>((r) => squatter!.listen(PORT, '127.0.0.1', r));

    await expect(
      startOperatorConsole({ broker: new InterventionBroker(new ControlLease()), lease: new ControlLease(), page: fakePage, port: PORT }),
    ).rejects.toThrow(/already in use/);
  });

  it('starts normally when the port is free', async () => {
    consoleHandle = await startOperatorConsole({
      broker: new InterventionBroker(new ControlLease()),
      lease: new ControlLease(),
      page: fakePage,
      port: PORT,
    });
    const state = await fetch(`http://127.0.0.1:${PORT}/api/state`).then((r) => r.json());
    expect(state).toMatchObject({ lease: 'automation', interventions: [] });
  });
});
