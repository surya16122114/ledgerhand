/**
 * The chatbot.
 *
 * It is deliberately the thinnest thing that is still honest. The model does not
 * drive the browser, does not author selectors, and does not decide what is safe
 * -- it does exactly one job: turn a sentence into a call to an already-recorded,
 * already-approved capability, with typed arguments. Everything after that is the
 * same deterministic replay path the CLI and the API use.
 *
 * That is the whole architectural point restated at the top of the stack: the
 * model chooses *which* capability and *with what arguments*; the capability
 * decides *how*. A model that could improvise UI steps here would undo every
 * guarantee underneath it.
 *
 * Two consequences worth naming:
 *
 *  - The tool list handed to the model is `buildCatalog()` output verbatim. There
 *    is no second description of what the system can do that could drift.
 *  - Irreversible capabilities are not callable from chat unless the caller
 *    supplied an authorization reason. Asking a chatbot to move money on the
 *    strength of a sentence is precisely the thing the policy gate exists to stop,
 *    so the refusal happens before the model is even offered the tool.
 */

import type { LlmMessage, LlmProvider, LlmTool } from '../agent/llm/provider.js';
import { listTools, invokeCapability, type InvokeOptions } from './invoke.js';
import type { ChatBackend, ChatReply, ChatTurn } from './server.js';

export interface ChatOptions {
  provider: LlmProvider;
  invoke?: InvokeOptions;
  /**
   * Reason recorded against any irreversible invocation the chat makes. Absent,
   * capabilities containing irreversible steps are withheld from the model.
   */
  authorize?: { by: string; reason: string };
  capabilityDir?: string;
  maxTurns?: number;
  invokeFunction?: typeof invokeCapability;
}

const SYSTEM = [
  'You are a servicing assistant for a credit union back-office system.',
  'You can only act by calling one of the capabilities provided as tools. You cannot browse, click, or improvise steps.',
  'Every capability drives a real servicing console against real records, so call one only when the user has given you every required argument.',
  'If an argument is missing or ambiguous, ask for it in plain language instead of guessing. A member number is never a guess.',
  'After a capability returns, report the result plainly.',
  'A business outcome such as "no such member" is a real answer, not a failure: say what happened and what it means, do not retry it.',
  'Never invent balances, references, or member details. Only state values a capability actually returned.',
].join(' ');

export function createChatBackend(opts: ChatOptions): ChatBackend {
  return {
    configureInvocation(defaults) { opts.invoke = { ...opts.invoke, ...defaults }; },
    async reply(message: string, history: ChatTurn[]): Promise<ChatReply> {
      const tools = await listTools(opts.capabilityDir, opts.invoke?.evidenceBaseDir);

      // Withholding rather than refusing later: a tool the model cannot safely
      // call should not be in its list at all, or it will promise the user
      // something the gate is about to deny.
      const offered = tools.filter((t) => opts.authorize || !mutates(t));
      const llmTools: LlmTool[] = offered.map((t) => ({
        name: t.name,
        description: `${t.description} Returns: ${Object.keys(t.outputSchema.properties).join(', ') || 'nothing'}. Possible business outcomes: ${t.outcomes.map((o) => o.code).join(', ') || 'none'}.`,
        parameters: t.inputSchema,
      }));

      // Bounded: the client controls `history`, so an unbounded one is an
      // unbounded prompt paid for per turn. Recent turns are what a follow-up
      // question ("and its status?") actually needs.
      const recent = history.slice(-(opts.maxTurns ?? 8));
      const messages: LlmMessage[] = [
        ...recent.map((h) => ({ role: h.role, content: h.content }) as LlmMessage),
        { role: 'user', content: message },
      ];

      const invocations: NonNullable<ChatReply['invocations']> = [];
      const completed = new Map<string, unknown>();
      // Bound both model turns and actual operations. A repeated write is answered
      // from its prior envelope, never posted a second time by a looping model.
      for (let turn = 0; turn < 4; turn++) {
        const response = await opts.provider.complete({ system: SYSTEM, messages, tools: llmTools });
        if (!response.toolCalls?.length) {
          return { message: response.text?.trim() || summarize(invocations), invocations,
            ...(invocations[0] ? { invoked: invocations[0] } : {}) };
        }
        messages.push({ role: 'assistant', toolCalls: response.toolCalls });
        for (const call of response.toolCalls) {
          const tool = offered.find((t) => t.name === call.name);
          const args = call.args as Record<string, unknown>;
          const key = call.name + ':' + JSON.stringify(args, Object.keys(args ?? {}).sort());
          let envelope = completed.get(key);
          if (!envelope) {
            envelope = !tool ? { ok: false, error: { code: 'NO_SUCH_CAPABILITY', message: 'Capability unavailable' } } :
              invocations.length >= 6 ? { ok: false, error: { code: 'CALL_LIMIT', message: 'Six-operation limit reached; remaining operations were not run.' } } :
              await (opts.invokeFunction ?? invokeCapability)(call.name, args, {
                ...opts.invoke,
                ...(opts.authorize && mutates(tool) ? { authorizeIrreversible: opts.authorize } : {}),
                ...(opts.capabilityDir ? { capabilityDir: opts.capabilityDir } : {}),
              });
            completed.set(key, envelope);
            invocations.push({ name: call.name, arguments: args, envelope });
          }
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify(envelope) });
        }
      }
      return { message: summarize(invocations), invocations, ...(invocations[0] ? { invoked: invocations[0] } : {}) };

    },
  };
}

/**
 * Whether a capability can change the institution's records.
 *
 * Read off the capability's declared risk ceiling rather than its name: a
 * capability called "read-record" that contained a write would still be caught,
 * and one called "transfer" that only reads would not be needlessly withheld.
 */
function mutates(tool: { maxRisk: string }): boolean {
  return tool.maxRisk === 'irreversible';
}

function summarize(invocations: NonNullable<ChatReply['invocations']>): string {
  if (!invocations.length) return 'No capability was invoked.';
  return invocations.map((i) => {
    const e = i.envelope as { ok: boolean; outputs?: unknown; outcome?: { code: string }; error?: { code: string } };
    return `${i.name}: ${e.ok ? 'completed — ' + JSON.stringify(e.outputs ?? {}) : e.outcome?.code ?? e.error?.code ?? 'stopped'}`;
  }).join('\n');
}
