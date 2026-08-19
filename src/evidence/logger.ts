/**
 * Run evidence.
 *
 * One directory per run, containing a JSONL event stream, screenshots, and DOM
 * snapshots. Chosen shape and its reasons:
 *
 *  - **JSONL, not a prose log.** The questions asked of this later are "which
 *    step failed, what did it expect, what did it see" and "how often does the
 *    fallback locator fire". Both are queries, not reading.
 *
 *  - **Every line passes through the redactor.** Not "log lines that look
 *    sensitive" -- every line. Perception output in particular is full of member
 *    data, because that is what is on the screen.
 *
 *  - **The rich signal is captured on failure, not always.** A screenshot and a
 *    per-frame DOM dump at the moment of failure is what makes a replay failure
 *    debuggable without reproducing it. Capturing them on every step would be
 *    both slow and a pile of regulated data at rest.
 *
 *  - **Writes are serialised through a promise chain.** Interleaved appends from
 *    concurrent awaits would corrupt the ordering that makes the stream readable.
 */

import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Surface } from '../surface/types.js';
import { Redactor, baseRedactor } from '../policy/redact.js';

export type RunKind = 'discovery' | 'replay';

export interface RunPaths {
  dir: string;
  log: string;
  summary: string;
  screenshots: string;
  snapshots: string;
}

export interface FailureEvidence {
  screenshot?: string;
  snapshot?: string;
}

export function newRunId(kind: RunKind): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  return `${kind}-${stamp}-${randomUUID().slice(0, 6)}`;
}

export class RunLogger {
  private queue: Promise<void> = Promise.resolve();
  private seq = 0;
  private counts = new Map<string, number>();

  private constructor(
    readonly runId: string,
    readonly kind: RunKind,
    readonly paths: RunPaths,
    private redactor: Redactor,
  ) {}

  static async create(opts: {
    kind: RunKind;
    baseDir?: string;
    runId?: string;
    redactor?: Redactor;
  }): Promise<RunLogger> {
    const runId = opts.runId ?? newRunId(opts.kind);
    const dir = join(opts.baseDir ?? 'evidence/runs', runId);
    const paths: RunPaths = {
      dir,
      log: join(dir, 'run.jsonl'),
      summary: join(dir, 'summary.json'),
      screenshots: join(dir, 'screenshots'),
      snapshots: join(dir, 'snapshots'),
    };
    await mkdir(paths.screenshots, { recursive: true });
    await mkdir(paths.snapshots, { recursive: true });
    const logger = new RunLogger(runId, opts.kind, paths, opts.redactor ?? baseRedactor());
    logger.event('run.start', { runId, kind: opts.kind, at: new Date().toISOString() });
    return logger;
  }

  /**
   * Replace the redactor once run-specific sensitive values are known (the
   * caller's pii inputs, the vault contents). Earlier lines were already written
   * with shape-based scrubbing only, which is why the run header deliberately
   * contains no input values.
   */
  useRedactor(redactor: Redactor): void {
    this.redactor = redactor;
  }

  /** Fire-and-forget by design: logging must never be able to fail a run. */
  event(type: string, data: Record<string, unknown> = {}): void {
    this.counts.set(type, (this.counts.get(type) ?? 0) + 1);
    const line = {
      seq: ++this.seq,
      at: new Date().toISOString(),
      runId: this.runId,
      type,
      ...this.redactor.deep(data),
    };
    this.queue = this.queue
      .then(() => appendFile(this.paths.log, `${JSON.stringify(line)}\n`, 'utf8'))
      .catch(() => {});
  }

  /**
   * Capture the richer failure signal. Best-effort and never throws: losing a
   * screenshot must not turn a diagnosable failure into a crash.
   */
  async captureFailureEvidence(surface: Surface, label: string): Promise<FailureEvidence> {
    const slug = `${String(this.seq).padStart(3, '0')}-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`.slice(0, 80);
    const out: FailureEvidence = {};
    try {
      out.screenshot = await surface.screenshot(join(this.paths.screenshots, `${slug}.png`), { maskSensitive: true });
    } catch {
      /* ignored */
    }
    try {
      out.snapshot = await surface.sourceSnapshot(join(this.paths.snapshots, `${slug}.html`));
    } catch {
      /* ignored */
    }
    this.event('evidence.captured', { label, ...out });
    return out;
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  async finalize(summary: Record<string, unknown>): Promise<void> {
    this.event('run.end', { at: new Date().toISOString() });
    await this.flush();
    const body = {
      runId: this.runId,
      kind: this.kind,
      eventCounts: Object.fromEntries([...this.counts.entries()].sort()),
      ...this.redactor.deep(summary),
    };
    await writeFile(this.paths.summary, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  }
}
