/**
 * Overlay application: one recording, many institutions.
 *
 * `applyOverlay` is a pure, deterministic function from
 * (base capability, tenant overlay) to an *effective* capability that is itself
 * a valid capability. That property matters more than it looks: it means the
 * replay engine has no idea overlays exist, the effective artifact can be dumped
 * into evidence and diffed against the base by a reviewer, and adding tenant 300
 * cannot introduce a new code path.
 *
 * The alias maps are doing the real work. Across tenants running the same vendor
 * build, the differences that break automation are overwhelmingly renamed labels
 * and relocated routes -- not restructured flows. Expressing exactly those two
 * things as data means a second institution costs about fifteen lines of
 * reviewable configuration instead of a second discovery run against production.
 */

import type {
  Capability,
  Condition,
  Handler,
  Overlay,
  Step,
  StepAction,
} from './index-types.js';
import { normalizeText } from '../surface/matching.js';
import type { TargetDescriptor, TargetStrategy } from '../surface/types.js';
import { escapeRegExp } from '../util/regex.js';

export interface OverlayAudit {
  tenantId: string;
  description: string;
  labelRewrites: { from: string; to: string; at: string }[];
  routeRewrites: { from: string; to: string; at: string }[];
  interruptsAdded: string[];
  stepsPatched: string[];
  stepsSkipped: string[];
}

export interface OverlayResult {
  capability: Capability;
  audit: OverlayAudit;
}


/** Case/whitespace-insensitive lookup, so an overlay author need not match punctuation exactly. */
function makeAliasLookup(map: Record<string, string>): (s: string) => string | undefined {
  const byNorm = new Map<string, string>();
  for (const [from, to] of Object.entries(map)) byNorm.set(normalizeText(from), to);
  return (s: string) => byNorm.get(normalizeText(s));
}

export function applyOverlay(base: Capability, overlay: Overlay): OverlayResult {
  const cap: Capability = structuredClone(base);
  const label = makeAliasLookup(overlay.labelAliases);
  const route = makeAliasLookup(overlay.routeAliases);

  const audit: OverlayAudit = {
    tenantId: overlay.tenantId,
    description: overlay.description,
    labelRewrites: [],
    routeRewrites: [],
    interruptsAdded: overlay.extraInterrupts.map((h) => h.name),
    stepsPatched: [],
    stepsSkipped: [],
  };

  const relabel = (s: string, at: string): string => {
    const to = label(s);
    if (to === undefined || to === s) return s;
    audit.labelRewrites.push({ from: s, to, at });
    return to;
  };

  const reroute = (s: string, at: string): string => {
    // Whole-value alias first (a route used verbatim).
    const whole = route(s);
    if (whole !== undefined && whole !== s) {
      audit.routeRewrites.push({ from: s, to: whole, at });
      return whole;
    }
    // Then substring substitution, which is what a templated entry url needs
    // ('{{baseUrl}}/member-search.aspx').
    let out = s;
    for (const [from, to] of Object.entries(overlay.routeAliases)) {
      if (out.includes(from)) {
        out = out.split(from).join(to);
        audit.routeRewrites.push({ from, to, at });
      }
    }
    return out;
  };

  /**
   * Rerouting a `urlMatches` pattern is not the same as rerouting a URL.
   *
   * The pattern is a regex, so a recorded condition for /member-search.aspx is
   * stored as `/member-search\.aspx`. A literal substring substitution against
   * that misses -- and misses *silently*, leaving the overlay looking applied while
   * the capability still asserts the base tenant's route. So both the raw alias
   * key and its regex-escaped form are substituted, and the replacement is escaped
   * on the way in so the result is still a valid pattern.
   */
  const reroutePattern = (pattern: string, at: string): string => {
    let out = pattern;
    for (const [from, to] of Object.entries(overlay.routeAliases)) {
      for (const needle of [escapeRegExp(from), from]) {
        if (out.includes(needle)) {
          out = out.split(needle).join(escapeRegExp(to));
          audit.routeRewrites.push({ from: needle, to, at });
          break; // one form per alias, or the second pass rewrites the first result
        }
      }
    }
    return out;
  };

  const mapStrategy = (st: TargetStrategy, at: string): TargetStrategy => {
    switch (st.kind) {
      case 'role-name':
        return { ...st, name: relabel(st.name, at) };
      case 'labelled-field':
        return { ...st, label: relabel(st.label, at) };
      case 'text':
        return { ...st, text: relabel(st.text, at) };
      case 'table-cell':
        // rowKey is data (an account number), not a label -- deliberately not aliased.
        return {
          ...st,
          columnHeader: relabel(st.columnHeader, at),
          ...(st.near ? { near: relabel(st.near, at) } : {}),
        };
      case 'section-ordinal':
        return { ...st, section: relabel(st.section, at) };
      case 'dom-hint':
        // A markup hint from another tenant's build is worse than useless -- it
        // may match the wrong control. Overlays drop it rather than translate it.
        return st;
      case 'anchor-offset':
        return { ...st, anchorText: relabel(st.anchorText, at) };
    }
  };

  const mapTarget = (t: TargetDescriptor, at: string): TargetDescriptor => ({
    ...t,
    strategies: t.strategies.map((s) => mapStrategy(s, at)).filter((s) => s.kind !== 'dom-hint' || overlay.tenantId === base.target.recordedTenantId),
  });

  const mapCondition = (c: Condition, at: string): Condition => {
    switch (c.kind) {
      case 'controlPresent':
      case 'controlAbsent':
        return { ...c, target: mapTarget(c.target, at) };
      case 'valueMatches':
        return { ...c, target: mapTarget(c.target, at) };
      case 'textPresent':
      case 'textAbsent':
        return { ...c, pattern: relabel(c.pattern, at) };
      case 'urlMatches':
        return { ...c, pattern: reroutePattern(c.pattern, at) };
      case 'all':
      case 'any':
        return { ...c, of: c.of.map((sub) => mapCondition(sub, at)) };
      case 'not':
        return { ...c, of: mapCondition(c.of, at) };
    }
  };

  const mapAction = (a: StepAction, at: string): StepAction => {
    switch (a.kind) {
      case 'navigate':
        return { ...a, url: reroute(a.url, at) };
      case 'click':
      case 'readText':
        return { ...a, target: mapTarget(a.target, at) };
      case 'fill':
      case 'select':
        return { ...a, target: mapTarget(a.target, at) };
      case 'waitFor':
        return { ...a, condition: mapCondition(a.condition, at) };
      case 'assert':
        return { ...a, condition: mapCondition(a.condition, at) };
      case 'press':
        return a;
    }
  };

  const mapHandler = (h: Handler, at: string): Handler => {
    const then = h.then.do === 'dismiss' ? { ...h.then, target: mapTarget(h.then.target, `${at}/dismiss`) } : h.then;
    return { ...h, ...(h.when ? { when: mapCondition(h.when, at) } : {}), then };
  };

  // ------------------------------------------------------------------ rewrite
  cap.target.entryUrl = reroute(cap.target.entryUrl, 'target.entryUrl');
  cap.interrupts = cap.interrupts.map((h) => mapHandler(h, `interrupt:${h.name}`));
  cap.success.checkpoint = mapCondition(cap.success.checkpoint, 'success.checkpoint');

  const patchById = new Map(overlay.stepPatches.map((p) => [p.stepId, p]));
  const steps: Step[] = [];
  for (const step of cap.steps) {
    const at = `step:${step.id}`;
    const patch = patchById.get(step.id);
    if (patch?.skip) {
      audit.stepsSkipped.push(step.id);
      continue;
    }

    let next: Step = {
      ...step,
      action: mapAction(step.action, at),
      handlers: step.handlers.map((h) => mapHandler(h, `${at}/handler:${h.name}`)),
      ...(step.precondition ? { precondition: mapCondition(step.precondition, `${at}/precondition`) } : {}),
      ...(step.checkpoint ? { checkpoint: mapCondition(step.checkpoint, `${at}/checkpoint`) } : {}),
    };

    if (patch) {
      audit.stepsPatched.push(step.id);
      if (patch.target && 'target' in next.action) next = { ...next, action: { ...next.action, target: patch.target } as StepAction };
      if (patch.value && (next.action.kind === 'fill' || next.action.kind === 'select')) {
        next = { ...next, action: { ...next.action, value: patch.value } };
      }
      if (patch.checkpoint) next = { ...next, checkpoint: patch.checkpoint };
    }

    steps.push(next);
  }
  cap.steps = steps;

  // Tenant-specific interrupts go first: a compliance gate this institution
  // added must be handled before the base capability's generic conditions get a
  // look, or the generic 'unexpected page' handler will claim it.
  cap.interrupts = [...overlay.extraInterrupts.map((h) => mapHandler(h, `overlay-interrupt:${h.name}`)), ...cap.interrupts];

  return { capability: cap, audit };
}

/** Pick the overlay for a tenant, if the base capability carries one. */
export function overlayFor(cap: Capability, tenantId: string | undefined): Overlay | undefined {
  if (!tenantId || tenantId === cap.target.recordedTenantId) return undefined;
  return cap.overlays.find((o) => o.tenantId === tenantId);
}

/**
 * Resolve a capability for a tenant. Returns the base unchanged when the tenant
 * is the one it was recorded against, and refuses to silently run an un-adapted
 * flow against a tenant with no overlay -- that is a decision for a human, not a
 * default.
 */
export function effectiveCapability(
  cap: Capability,
  tenantId: string | undefined,
  opts: { allowUnadapted?: boolean } = {},
): { capability: Capability; audit?: OverlayAudit; warning?: string } {
  if (!tenantId || tenantId === cap.target.recordedTenantId) return { capability: cap };
  const overlay = overlayFor(cap, tenantId);
  if (overlay) return applyOverlay(cap, overlay);
  const warning = `capability '${cap.id}' was recorded against tenant '${cap.target.recordedTenantId}' and has no overlay for '${tenantId}'`;
  if (!opts.allowUnadapted) throw new Error(`${warning}; pass --allow-unadapted to run it anyway`);
  return { capability: cap, warning };
}
