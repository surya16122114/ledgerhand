/**
 * Copy non-TypeScript assets into dist/.
 *
 * `tsc` only emits what it compiles, so the operator console's HTML would be absent
 * from a build — and the `bin` entry in package.json points at dist/. A declared
 * binary that cannot serve the console is worse than no declared binary.
 */
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const ASSETS = [
  ['src/escalation/operator-console.html', 'dist/src/escalation/operator-console.html'],
  ['src/api/dashboard.html', 'dist/src/api/dashboard.html'],
];

for (const [from, to] of ASSETS) {
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
  process.stdout.write(`copied ${from} -> ${to}\n`);
}
