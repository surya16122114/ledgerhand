/**
 * The tool surface offered to the discovery model.
 *
 * The single most important decision in this file: **there is no tool that
 * accepts a selector.** The model acts on `ref`, an opaque handle from the
 * observation it was just shown. The system then looks that ref up in its own
 * perception and writes the durable TargetDescriptor -- role+name, adjacent-label,
 * table coordinates -- into the artifact.
 *
 * That inversion is what makes the recorded capability trustworthy. If the model
 * wrote the locators, the artifact's robustness would be a property of a language
 * model's taste in CSS on the day it ran. Instead the model contributes what it is
 * uniquely good at (working out *what to do* on an unfamiliar screen) and the
 * system contributes what it is good at (describing a control durably and
 * identically every time).
 *
 * The second decision: the model cannot read a credential. `fill` takes either a
 * literal `value` or a `secretName`, and in the second case the value is fetched
 * from the vault at keystroke time. The model can sign the session in without the
 * password ever entering its context, its transcript, or the artifact.
 */

import type { JsonSchema, LlmTool } from './llm/provider.js';

export const TOOL_NAMES = {
  click: 'click_control',
  fill: 'fill_field',
  select: 'select_option',
  read: 'read_value',
  navigate: 'navigate_to',
  finish: 'finish_goal',
  escalate: 'request_human_help',
} as const;

function obj(properties: Record<string, unknown>, required: string[]): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

const why = {
  type: 'string',
  description:
    'One sentence, in the words a bank operator would use, describing what this step accomplishes. This is recorded as the step intent and is what a human reviewer reads when approving the capability.',
};

export function discoveryTools(opts: { secretNames: string[]; outputNames: string[]; inputNames: string[] }): LlmTool[] {
  const secretHint = opts.secretNames.length
    ? `Available credential names: ${opts.secretNames.join(', ')}.`
    : 'No credentials are configured for this run.';
  const inputHint = opts.inputNames.length
    ? `Values you were given as task parameters: ${opts.inputNames.join(', ')}. Type these literally; the recorder will turn them into capability inputs automatically.`
    : '';

  return [
    {
      name: TOOL_NAMES.click,
      description: 'Click a control. Use the ref exactly as shown in the latest observation.',
      parameters: obj(
        {
          ref: { type: 'string', description: 'The ref of the control to click, e.g. "bodyFrame|3:7".' },
          why,
        },
        ['ref', 'why'],
      ),
    },
    {
      name: TOOL_NAMES.fill,
      description:
        `Type into a text field. Provide either "value" for ordinary data or "secretName" for a credential -- never both. ` +
        `${secretHint} A credential's *name* is not its value: to type a credential, pass its name as "secretName" and omit "value" entirely. ` +
        `Putting a credential name (or a password) in "value" is refused. ${inputHint}`,
      parameters: obj(
        {
          ref: { type: 'string', description: 'The ref of the field to type into.' },
          value: { type: 'string', description: 'Literal text to type. Omit when using secretName.' },
          secretName: { type: 'string', description: 'Name of a stored credential to type without ever seeing it. Omit when using value.' },
          why,
        },
        ['ref', 'why'],
      ),
    },
    {
      name: TOOL_NAMES.select,
      description: 'Choose an option in a dropdown, by the option value or its visible label.',
      parameters: obj(
        {
          ref: { type: 'string', description: 'The ref of the dropdown.' },
          value: { type: 'string', description: 'Option value or visible label.' },
          why,
        },
        ['ref', 'value', 'why'],
      ),
    },
    {
      name: TOOL_NAMES.read,
      description:
        'Read a value off the screen and record it as an output of this capability. Use this for every piece of data the goal asks you to retrieve. ' +
        (opts.outputNames.length ? `Outputs the task expects: ${opts.outputNames.join(', ')}.` : 'Name the output in lowerCamelCase.'),
      parameters: obj(
        {
          ref: { type: 'string', description: 'The ref of the control or table cell holding the value.' },
          outputName: { type: 'string', description: 'lowerCamelCase name for this output, e.g. savingsBalance.' },
          format: {
            type: 'string',
            enum: ['text', 'money', 'number'],
            description: 'How callers should receive it. Use "money" for currency so the caller gets a number, not "$8,241.77".',
          },
          why,
        },
        ['ref', 'outputName', 'why'],
      ),
    },
    {
      name: TOOL_NAMES.navigate,
      description:
        'Go directly to a URL within the target application. Prefer clicking the menu the way an operator would; direct navigation is for recovering when you are lost.',
      parameters: obj({ url: { type: 'string', description: 'Absolute URL inside the allowlisted application.' }, why }, ['url', 'why']),
    },
    {
      name: TOOL_NAMES.finish,
      description:
        'Call this only once the goal is visibly achieved on screen. Describe the condition that proves it -- a distinctive phrase that is present now and was not present before you started.',
      parameters: obj(
        {
          successText: {
            type: 'string',
            description:
              'A distinctive phrase visible on the current screen that proves the goal was reached, e.g. "Sub-Account Opened" or "MEMBER PROFILE". Must not be text that appears on every screen.',
          },
          summary: { type: 'string', description: 'One or two sentences describing what this capability does, for the catalog.' },
        },
        ['successText', 'summary'],
      ),
    },
    {
      name: TOOL_NAMES.escalate,
      description:
        'Call this when you cannot make progress: you cannot find the control you need, the application is showing an error you cannot clear, or the next step looks irreversible and you are unsure. A human operator will take over the live session.',
      parameters: obj(
        {
          reason: { type: 'string', description: 'What you were trying to do and what is blocking you.' },
        },
        ['reason'],
      ),
    },
  ];
}
