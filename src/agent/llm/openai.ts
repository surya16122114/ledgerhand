/**
 * OpenAI chat-completions provider.
 *
 * Uses the tool-calling API rather than asking for JSON in prose. The reason is
 * not convenience: a tool call arrives already separated into name and arguments,
 * so a malformed response is a parse error on one field instead of a
 * hallucinated action that happens to look like valid JSON.
 *
 * Retries are limited to genuinely transient classes (429 and 5xx). A 400 from a
 * bad tool schema is a bug and retrying it just burns money slowly.
 */

import OpenAI from 'openai';
import { LlmError, type LlmProvider, type LlmRequest, type LlmResponse, type LlmToolCall } from './provider.js';

export interface OpenAiProviderOptions {
  apiKey?: string;
  model?: string;
  maxRetries?: number;
  /**
   * Total time to spend waiting across all retries.
   *
   * Bounded by time rather than attempt count because the limit that actually
   * bites is tokens-per-minute, and the only thing that clears it is the minute
   * rolling over. Five attempts four seconds apart all land inside the same
   * exhausted window and report a rate limit as a hard failure; a budget slightly
   * longer than the window survives it.
   */
  retryBudgetMs?: number;
}

export class OpenAiProvider implements LlmProvider {
  readonly id: string;
  private client: OpenAI;
  private model: string;
  private maxRetries: number;
  private retryBudgetMs: number;
  /** Cleared the first time a model rejects an explicit temperature. */
  private temperatureSupported = true;

  constructor(opts: OpenAiProviderOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        'OPENAI_API_KEY is not set. Discovery needs a real model; replay does not. ' +
          'Set it in .env, or run with LLM_PROVIDER=replay to drive the loop from a recorded transcript.',
      );
    }
    this.model = opts.model ?? process.env.OPENAI_MODEL ?? 'gpt-4.1';
    this.maxRetries = opts.maxRetries ?? 8;
    this.retryBudgetMs = opts.retryBudgetMs ?? 75_000;
    this.id = `openai:${this.model}`;
    // Retries are handled here so the backoff is visible in the run log.
    this.client = new OpenAI({ apiKey, maxRetries: 0 });
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: 'system', content: request.system }];
    for (const m of request.messages) {
      if (m.role === 'user') {
        messages.push({ role: 'user', content: m.content });
      } else if (m.role === 'assistant') {
        const entry: OpenAI.Chat.ChatCompletionAssistantMessageParam = { role: 'assistant', content: m.content ?? null };
        if (m.toolCalls?.length) {
          entry.tool_calls = m.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          }));
        }
        messages.push(entry);
      } else {
        messages.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
      }
    }

    let lastError: unknown;
    let waited = 0;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const completion = await this.client.chat.completions.create({
          model: this.model,
          messages,
          tools: request.tools.map((t) => ({
            type: 'function' as const,
            function: { name: t.name, description: t.description, parameters: t.parameters as unknown as Record<string, unknown> },
          })),
          tool_choice: 'auto',
          // Discovery asks for temperature 0, because a recording is worth more when
          // the run that produced it was as close to reproducible as the API allows.
          // Some newer models refuse any value but their default and reject the
          // request outright, so the preference is dropped rather than allowed to
          // fail the run -- see supportsTemperature below.
          ...(this.temperatureSupported ? { temperature: request.temperature ?? 0 } : {}),
          max_completion_tokens: request.maxOutputTokens ?? 1200,
        });

        const choice = completion.choices[0];
        const toolCalls: LlmToolCall[] = [];
        for (const tc of choice?.message.tool_calls ?? []) {
          if (tc.type !== 'function') continue;
          toolCalls.push({ id: tc.id, name: tc.function.name, args: safeParseArgs(tc.function.arguments) });
        }
        return {
          ...(choice?.message.content ? { text: choice.message.content } : {}),
          toolCalls,
          model: completion.model,
          usage: { inputTokens: completion.usage?.prompt_tokens, outputTokens: completion.usage?.completion_tokens },
        };
      } catch (err) {
        lastError = err;
        // A model that refuses a non-default temperature says so explicitly. Honour
        // the constraint and retry once rather than treating a documented API
        // restriction as a failure -- this is the difference between the provider
        // working on any model and working on the ones it was written against.
        if (this.temperatureSupported && /temperature.*does not support|Unsupported value: 'temperature'/i.test(message(err))) {
          this.temperatureSupported = false;
          continue;
        }

        const status = (err as { status?: number }).status;
        // A request that never reached the server has no status, and that is the
        // most transient failure there is -- yet it fell through every arm of this
        // check and aborted immediately. An eleven-turn discovery run died on one
        // dropped connection, "after 1 attempt(s) and 0s of backoff", having
        // already filled the form it was recording.
        //
        // Matched on the absence of a status rather than on the message text, so a
        // reworded SDK error cannot quietly turn this back off. A genuine 4xx
        // still carries a status and is still not retried.
        const neverReachedServer = status === undefined;
        const retryable =
          neverReachedServer || status === 429 || status === 408 || (typeof status === 'number' && status >= 500);
        if (!retryable || attempt === this.maxRetries || waited >= this.retryBudgetMs) {
          throw new LlmError(
            `OpenAI request failed (${status ?? 'no status'}) after ${attempt} attempt(s) and ${Math.round(waited / 1000)}s of backoff: ${message(err)}`,
            retryable,
          );
        }
        // Use the server's own answer when it gives one. A token-per-minute limit
        // knows exactly how long the window has left, and exponential backoff from
        // 500ms guesses under it every time -- burning all the retries inside the
        // window and surfacing a rate limit as a hard failure.
        const wait = Math.min(suggestedDelayMs(err) ?? 500 * 2 ** (attempt - 1), this.retryBudgetMs - waited);
        waited += wait;
        await sleep(wait);
      }
    }
    throw new LlmError(`OpenAI request failed after ${this.maxRetries} attempts: ${message(lastError)}`, false);
  }
}

/**
 * How long the API asked us to wait, from the `retry-after` header if present, or
 * from the hint OpenAI puts in the 429 message body ("try again in 4.54s").
 * A little slack is added so we do not land exactly on the boundary.
 */
export function suggestedDelayMs(err: unknown): number | undefined {
  const headers = (err as { headers?: Record<string, string> }).headers;
  // Each header is read with its own unit.
  //
  // OpenAI sends both on a token-per-minute 429 -- `retry-after: 2` alongside
  // `retry-after-ms: 2862`. Choosing the value from one and the unit from the
  // other read "2 seconds" as "2 milliseconds", so eight retries spent 2s of
  // backoff waiting out a limit measured per minute, and a rate limit surfaced as
  // a crashed discovery run.
  const fromMs = Number(headers?.['retry-after-ms']);
  if (Number.isFinite(fromMs) && fromMs > 0) return fromMs + 250;
  const fromSeconds = Number(headers?.['retry-after']);
  if (Number.isFinite(fromSeconds) && fromSeconds > 0) return fromSeconds * 1000 + 250;
  const hint = /try again in ([\d.]+)\s*(ms|s)\b/i.exec(message(err));
  if (hint) {
    const value = Number(hint[1]);
    if (Number.isFinite(value)) return (hint[2]!.toLowerCase() === 'ms' ? value : value * 1000) + 250;
  }
  return undefined;
}

/**
 * A model can emit syntactically invalid arguments. Returning an empty object
 * lets the loop reply with a validation error the model can correct, which is a
 * better outcome than aborting a discovery run on one bad token.
 */
function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message.split('\n')[0]! : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
