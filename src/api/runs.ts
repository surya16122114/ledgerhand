/** Disk-backed history and live operator links share the engine's run IDs. */
import { readdir, readFile, realpath } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { startOperatorConsole, type OperatorConsole } from '../escalation/operator-server.js';
import type { ReplayOptions } from '../replay/engine.js';

const active = new Map<string, { console: OperatorConsole; context: Parameters<NonNullable<ReplayOptions['onSurfaceReady']>>[0] }>();

export const attachRunConsole: NonNullable<ReplayOptions['onSurfaceReady']> = async (context) => {
  const console = await startOperatorConsole({ broker: context.broker, lease: context.lease,
    page: context.surface.livePage(), port: 0, log: (type, data) => context.logger.event(type, data) });
  active.set(context.logger.runId, { console, context });
  context.surface.livePage().once('close', () => {
    active.delete(context.logger.runId);
    void console.close();
  });
};

export function activeRuns() {
  return [...active].map(([runId, { console, context }]) => ({
    runId, kind: context.logger.kind, status: context.lease.current() === 'automation' ? 'running' : 'escalated',
    operatorUrl: console.url,
    events: context.logger.recentEvents(),
    interventions: context.broker.list().map((i) => ({ id: i.id, status: i.status, reason: i.reason })),
  }));
}

export function evidenceRoots(baseDir: string): string[] {
  return baseDir === 'evidence/runs' ? [baseDir, 'evidence/assignment-2/past-verifications/runs'] : [baseDir];
}

export async function runHistory(baseDir = 'evidence/runs') {
  const histories = await Promise.all(evidenceRoots(baseDir).map(readHistory));
  const unique = new Map<string, Record<string, unknown>>();
  for (const run of histories.flat()) if (!unique.has(String(run.runId))) unique.set(String(run.runId), run);
  return [...unique.values()].sort((a, b) => String(b.runId).localeCompare(String(a.runId)));
}

async function readHistory(baseDir: string) {
  const root = resolve(baseDir);
  const dirs = await readdir(root, { withFileTypes: true }).catch(() => []);
  const runs: Record<string, unknown>[] = [];
  for (const dir of dirs.filter((d) => d.isDirectory() && /^(replay|discovery)-[\w-]+$/.test(d.name))) {
    try {
      const s = JSON.parse(await readFile(join(root, dir.name, 'summary.json'), 'utf8'));
      // Legacy summaries did not guarantee safe rich evidence. Do not expose their raw files.
      runs.push({ runId: dir.name, kind: s.kind, status: s.status ?? (s.rejected ? 'failed' : 'historical'),
        capability: s.capability,
        ...(s.sanitizedEvidenceVersion === 1 ? { inputs: s.inputs, outputs: s.outputs, inputDetails: s.inputDetails, outputDetails: s.outputDetails, outcome: s.outcome, error: s.error, steps: s.steps, recoveries: s.recoveries, durationMs: s.durationMs } : {}),
        sanitizedEvidenceVersion: s.sanitizedEvidenceVersion });
    } catch { /* A live run has no summary yet. */ }
  }
  const live = activeRuns();
  return [...live, ...runs.filter((r) => !live.some((a) => a.runId === r.runId))]
    .sort((a, b) => String(b.runId).localeCompare(String(a.runId)));
}

/** Files are selected by basename from one safe run, never by a caller-supplied path. */
export async function evidenceFile(baseDir: string, runId: string, kind: string, name: string): Promise<string | undefined> {
  for (const root of evidenceRoots(baseDir)) {
    const file = await safeEvidenceFile(root, runId, kind, name);
    if (file) return file;
  }
  return undefined;
}

async function safeEvidenceFile(baseDir: string, runId: string, kind: string, name: string): Promise<string | undefined> {
  if (!/^(replay|discovery)-[\w-]+$/.test(runId) || !/^[\w.-]+$/.test(name)) return undefined;
  if (!['logs', 'screenshots', 'snapshots'].includes(kind)) return undefined;
  if (kind === 'logs' && !['summary.json', 'run.jsonl'].includes(name)) return undefined;
  if (kind === 'screenshots' && !name.endsWith('.png')) return undefined;
  if (kind === 'snapshots' && !name.endsWith('.html')) return undefined;
  try {
    const root = await realpath(resolve(baseDir));
    const dir = join(root, runId);
    const summary = JSON.parse(await readFile(join(dir, 'summary.json'), 'utf8'));
    if (summary.sanitizedEvidenceVersion !== 1) return undefined;
    const file = await realpath(join(dir, kind === 'logs' ? '' : kind, name));
    const rel = relative(dir, file);
    if (rel.startsWith('..') || isAbsolute(rel) || relative(root, file).startsWith('..') || isAbsolute(relative(root, file))) return undefined;
    return file;
  } catch { return undefined; }
}

export async function evidenceList(baseDir: string, runId: string) {
  const files: { kind: string; name: string }[] = [];
  for (const kind of ['logs', 'screenshots', 'snapshots']) {
    const names = kind === 'logs' ? ['summary.json', 'run.jsonl'] :
      [...new Set((await Promise.all(evidenceRoots(baseDir).map(root => readdir(join(root, runId, kind)).catch(() => [])))).flat())];
    for (const name of names) if (await evidenceFile(baseDir, runId, kind, name)) files.push({ kind, name });
  }
  return files;
}
