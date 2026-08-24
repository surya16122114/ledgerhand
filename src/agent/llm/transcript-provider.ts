/**
 * Replay a recorded transcript instead of calling a model.
 *
 * This is what makes the discovery loop testable. Every live run writes its
 * turns to `evidence/runs/<id>/transcript.json`; this provider plays them back
 * turn by turn, so the loop, the tool validation, the ref-to-target conversion
 * and the recorder can all be exercised in CI with no API key and no network.
 *
 * It is not a mock of the model's *reasoning* -- it is the real reasoning from a
 * real run, decoupled from the API call. If the loop's behavior changes such
 * that it would no longer send the same tool call, the transcript stops lining up
 * and the test fails, which is exactly the signal wanted.
 */

import { readFile } from 'node:fs/promises';
import { LlmError, type LlmProvider, type LlmRequest, type LlmResponse } from './provider.js';

export interface RecordedTurn {
  index: number;
  text?: string;
  toolCalls: { id: string; name: string; args: Record<string, unknown> }[];
}

export interface RecordedTranscript {
  model: string;
  turns: RecordedTurn[];
}

export class TranscriptProvider implements LlmProvider {
  readonly id: string;
  private cursor = 0;

  constructor(private readonly transcript: RecordedTranscript) {
    this.id = `transcript:${transcript.model}`;
  }

  static async fromFile(path: string): Promise<TranscriptProvider> {
    const raw = JSON.parse(await readFile(path, 'utf8')) as RecordedTranscript;
    if (!Array.isArray(raw.turns)) throw new Error(`${path} is not a recorded transcript`);
    return new TranscriptProvider(raw);
  }

  async complete(_request: LlmRequest): Promise<LlmResponse> {
    const turn = this.transcript.turns[this.cursor++];
    if (!turn) {
      throw new LlmError(
        `recorded transcript is exhausted after ${this.cursor - 1} turns; the loop asked for another. ` +
          'Either the loop now takes more turns than the recording, or the surface responded differently.',
        false,
      );
    }
    return {
      ...(turn.text ? { text: turn.text } : {}),
      toolCalls: turn.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, args: tc.args })),
      model: this.transcript.model,
    };
  }
}
