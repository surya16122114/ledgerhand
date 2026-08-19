/**
 * Secret vault.
 *
 * The point of this indirection is that a capability can *use* a credential
 * without ever *containing* one. An artifact says `{ from: 'secret', name:
 * 'coreOperatorPassword' }`; the vault turns that into a value at the moment the
 * keystroke is sent, and nothing in between -- artifact, log, evidence bundle,
 * model context -- ever holds it.
 *
 * Backed by environment variables here. In a real deployment this is the seam
 * where a per-tenant secrets manager goes, and the interface is deliberately
 * narrow enough that swapping it is a one-file change: `get`, `has`, `names`,
 * and a `values()` used only by the redactor and the artifact linter.
 */

const PREFIX = 'LEDGERHAND_SECRET_';

/** Convenience aliases so the demo does not need awkward env var names. */
const ALIASES: Record<string, string> = {
  coreOperatorUser: 'LEDGERHAND_OPERATOR_USER',
  coreOperatorPassword: 'LEDGERHAND_OPERATOR_PASS',
};

export class SecretVault {
  private store = new Map<string, string>();

  static fromEnvironment(env: NodeJS.ProcessEnv = process.env): SecretVault {
    const vault = new SecretVault();
    for (const [key, value] of Object.entries(env)) {
      if (!value) continue;
      if (key.startsWith(PREFIX)) vault.store.set(camelise(key.slice(PREFIX.length)), value);
    }
    for (const [name, envKey] of Object.entries(ALIASES)) {
      const value = env[envKey];
      if (value) vault.store.set(name, value);
    }
    return vault;
  }

  static forTesting(entries: Record<string, string>): SecretVault {
    const vault = new SecretVault();
    for (const [k, v] of Object.entries(entries)) vault.store.set(k, v);
    return vault;
  }

  has(name: string): boolean {
    return this.store.has(name);
  }

  /** Throws rather than returning undefined: a missing credential must stop the run. */
  get(name: string): string {
    const value = this.store.get(name);
    if (value === undefined) {
      throw new Error(
        `secret '${name}' is not available. Set ${PREFIX}${screamingSnake(name)}` +
          (ALIASES[name] ? ` (or ${ALIASES[name]})` : '') +
          ' in the environment.',
      );
    }
    return value;
  }

  /** Names only. Safe to log, and used to render a capability's credential needs. */
  names(): string[] {
    return [...this.store.keys()].sort();
  }

  /**
   * Raw values. Only two callers are legitimate: the redactor, which needs them
   * to scrub output, and the artifact linter, which needs them to prove none
   * leaked. Kept as a method rather than a property to make those call sites
   * grep-able.
   */
  values(): string[] {
    return [...this.store.values()];
  }
}

function camelise(s: string): string {
  return s
    .toLowerCase()
    .split('_')
    .map((part, i) => (i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');
}

function screamingSnake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}
