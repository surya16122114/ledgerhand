/**
 * The discovery prompt.
 *
 * Written to produce a good *artifact*, not merely a completed task. Those pull
 * in different directions: the fastest way to finish a goal is to navigate
 * straight to a deep URL, and the most reusable recording is the one that walks
 * the menus the way an operator does, because deep URLs encode ids and route
 * shapes that differ across tenants. The prompt is explicit about preferring the
 * second.
 *
 * The other thing it is explicit about is stopping. A model that keeps trying
 * after four failed attempts on the same control produces a worse outcome than
 * one that escalates, because escalation preserves the live session for a human
 * while flailing changes state nobody chose.
 */

export interface PromptContext {
  goal: string;
  appDescription: string;
  baseUrl: string;
  secretNames: string[];
  parameters: { name: string; value: string }[];
  expectedOutputs: string[];
  maxSteps: number;
}

export function systemPrompt(ctx: PromptContext): string {
  return `You are operating a back-office banking application through a computer-use interface, the way a trained credit-union employee would. Your job is to accomplish one goal, and to do it in a way that can be recorded and replayed reliably afterwards.

# The application
${ctx.appDescription}
It is served at ${ctx.baseUrl}. It is a legacy server-rendered application: it uses frames, table-based layouts, and full page reloads. Nothing about it is modern.

# What you can see
Before each of your turns you are given an observation: the current URL, and a list of the controls on screen. Each control has:
  - a ref, e.g. "bodyFrame|3:7" -- this is how you refer to it
  - a role (button, link, textbox, combobox, cell, ...)
  - a name -- the label a human would read for it. For fields, this is often recovered from the label in the table cell next to the field, because this application does not label its inputs properly.
  - the frame it lives in, and the screen section it sits under

Refs are only valid for the observation you were just given. Never reuse a ref from an earlier turn.

# How to act
Call exactly one tool per turn. After each action you get a fresh observation showing the result.

Rules that matter:
1. Prefer navigating the way an operator does -- click the menu, use the search screen -- over jumping to a URL. A recording built from menu clicks works at other institutions running this software; one built from a deep URL with an id in it does not.
2. Type task parameter values literally. They are turned into capability inputs automatically.
3. For credentials, use fill_field with secretName. You have not been given any password and must never invent one. Available: ${ctx.secretNames.length ? ctx.secretNames.join(', ') : '(none)'}.
4. Read every value the goal asks for with read_value, even if you can already see it. If it is not read, the capability returns nothing.
5. Look at what actually happened after each action. If a validation message, an unexpected notice, or an error appeared, deal with it rather than repeating the action.
6. If you try the same thing twice and it does not work, do something different. If you are out of ideas, call request_human_help. Escalating is a correct outcome, not a failure.
7. Do not explore. Do not click into General Ledger, Administration, or Teller Operations. Do only what the goal requires -- every extra action becomes a step a reviewer has to approve.
8. Call finish_goal the moment the goal is visibly achieved, and quote a distinctive phrase from the screen that proves it.

You have at most ${ctx.maxSteps} actions.

# Your goal
${ctx.goal}
${ctx.parameters.length ? `\n# Task parameters\n${ctx.parameters.map((p) => `  ${p.name} = ${p.value}`).join('\n')}` : ''}
${ctx.expectedOutputs.length ? `\n# Values to retrieve\n${ctx.expectedOutputs.map((o) => `  ${o}`).join('\n')}` : ''}`;
}

/** Compact, token-efficient rendering of an observation. */
export function renderObservation(input: {
  url: string;
  title: string;
  frames: { path: string[]; url: string }[];
  controls: {
    ref: string;
    role: string;
    name: string;
    nameSource: string;
    value?: string;
    disabled?: boolean;
    container: { framePath: string[]; section?: string; table?: { rowKey?: string; columnHeader?: string } };
  }[];
  text: string;
  truncatedFrames?: string[];
  note?: string;
}): string {
  const lines: string[] = [];
  if (input.note) lines.push(`! ${input.note}`, '');
  if (input.truncatedFrames?.length) {
    // Told plainly, because a model that cannot see a control will otherwise conclude
    // the control does not exist and go looking for another route.
    lines.push(
      `! This screen has more controls than can be listed (frame(s): ${input.truncatedFrames.join(', ')}). ` +
        'If something you expect is missing, narrow the screen first rather than assuming it is absent.',
      '',
    );
  }
  lines.push(`URL: ${input.url}`);
  if (input.frames.length > 1) {
    lines.push(`Frames: ${input.frames.map((f) => `${f.path.join('/') || '(top)'} -> ${short(f.url)}`).join(' | ')}`);
  }
  lines.push('', 'Controls:');

  // Grouped by frame then section, because that is how the screen is actually
  // organized and an ungrouped list of forty controls is hard for anyone to read.
  const groups = new Map<string, typeof input.controls>();
  for (const c of input.controls) {
    if (c.role === 'heading') continue;
    const key = `${c.container.framePath.join('/') || '(top)'} :: ${c.container.section ?? '-'}`;
    const list = groups.get(key) ?? [];
    list.push(c);
    groups.set(key, list);
  }

  for (const [key, controls] of groups) {
    lines.push(`  [${key}]`);
    for (const c of controls) {
      const bits = [`ref=${c.ref}`, c.role, `"${c.name}"`];
      if (c.value !== undefined && c.value !== '' && c.role !== 'cell') bits.push(`value="${truncate(c.value, 40)}"`);
      if (c.role === 'cell' && c.container.table?.rowKey) bits.push(`row="${c.container.table.rowKey}" col="${c.container.table.columnHeader ?? '?'}" text="${truncate(c.value ?? '', 40)}"`);
      if (c.disabled) bits.push('DISABLED');
      // The name source is shown so the model can tell a labelled field from a
      // guess, which affects how confident it should be about what a field is for.
      if (c.nameSource === 'adjacent-cell' || c.nameSource === 'preceding-text') bits.push(`(label inferred)`);
      lines.push(`    ${bits.join(' ')}`);
    }
  }

  // The control list above is the primary signal; this block is context for reading
  // error messages and confirmation banners the control list does not convey. Kept
  // short deliberately: the history is resent every turn, so a generous text dump is
  // paid for once per remaining step, and on a tokens-per-minute limit that is the
  // difference between a run completing and a run stalling.
  lines.push('', 'Visible text (excerpt):', truncate(input.text, 900));
  return lines.join('\n');
}

function short(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + (u.search ? u.search.slice(0, 40) : '');
  } catch {
    return url;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
