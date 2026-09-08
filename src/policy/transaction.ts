/** Compare the actual outgoing transaction with the caller's contract, without logging values. */
export interface TransactionRule {
  path: string;
  allowRead?: boolean;
  fields: Record<string, { input: string; numeric?: boolean }>;
}
export function checkTransaction(
  rules: TransactionRule[], url: string, method: string, body: string | null,
  inputs: Record<string, unknown>,
): string | undefined {
  const path = new URL(url).pathname;
  const rule = rules.find(r => new RegExp(r.path).test(path));
  if (!rule) return;
  if (rule.allowRead && (method === 'GET' || method === 'HEAD')) return;
  if (method !== 'POST') return 'transaction requires POST';
  const member = path.split('/')[2];
  if (member !== String(inputs.memberId)) return 'member identity differs from request';
  const fields = new URLSearchParams(body ?? '');
  if (fields.getAll('_token').length !== 1 || !fields.get('_token')) return 'transaction token is missing or ambiguous';
  for (const [name, spec] of Object.entries(rule.fields)) {
    const actual = fields.getAll(name), expected = inputs[spec.input];
    if (actual.length !== 1 || expected === undefined) return `transaction field ${name} is missing or ambiguous`;
    const matches = spec.numeric
      ? cents(actual[0]!) !== undefined && cents(actual[0]!) === cents(String(expected))
      : actual[0] === String(expected);
    if (!matches) return `transaction field ${name} differs from request`;
  }
}

function cents(value: string): bigint | undefined {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  return match ? BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0')) : undefined;
}
