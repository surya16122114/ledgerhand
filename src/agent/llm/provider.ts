/**
 * Model provider abstraction.
 *
 * Narrow on purpose: one `complete` call taking a system prompt, a message
 * history, and a tool list, returning text plus tool calls. That is the whole
 * surface the discovery loop needs, and keeping it this small is what lets the
 * loop be tested against a recorded transcript with no network and no key.
 *
 * It is a provider seam, not an agent framework. The loop, the tool definitions,
 * the stall detection and the recording all live in this repo, because those are
 * the parts whose behaviour has to be defensible.
 */

export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface LlmTool {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface LlmToolCall {
  id: string;
  name: string;
  /** Raw arguments as returned by the model. Validated by the caller, never trusted. */
  args: Record<string, unknown>;
}

export type LlmMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content?: string; toolCalls?: LlmToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  tools: LlmTool[];
  maxOutputTokens?: number;
  temperature?: number;
}

export interface LlmResponse {
  text?: string;
  toolCalls: LlmToolCall[];
  usage?: { inputTokens?: number; outputTokens?: number };
  /** For provenance: the exact model string the provider actually used. */
  model: string;
}

export interface LlmProvider {
  /** Stable identifier written into artifact provenance. */
  readonly id: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}
