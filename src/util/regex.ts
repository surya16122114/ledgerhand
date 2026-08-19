/**
 * Regex helpers.
 *
 * `escapeRegExp` had six identical copies across the codebase. Individually
 * harmless; collectively the kind of thing where one copy quietly diverges and the
 * bug appears only in whichever module owns the stale one. The correctness of every
 * synthesised checkpoint depends on this function, so it gets one definition.
 *
 * Deliberately not imported by `surface/web/perceive.ts`: that module is serialised
 * into the page and cannot reference anything outside itself.
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
