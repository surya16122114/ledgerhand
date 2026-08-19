# Extending to a desktop surface

Not implemented. This is the design note that the `Surface` seam is meant to make
cheap, written down so the claim can be checked rather than taken on trust.

## What a driver actually owes

`Surface` (see `../types.ts`) is four methods:

```ts
observe(opts?)   -> Observation          // a list of PerceivedControl
resolve(target)  -> Resolution           // delegate to ../matching.ts
perform(action)  -> ActionResult         // act on a resolved control
evaluate(cond)   -> ConditionResult      // delegate to evaluateAgainst()
```

Only `observe` and the action half of `perform` are driver-specific. `resolve` and
`evaluate` are pure functions over `PerceivedControl[]` and are shared verbatim —
that is the point of keeping them out of the web driver.

So a Windows driver is: enumerate the UIAutomation tree into `PerceivedControl[]`,
and map five action kinds onto UIA patterns. Nothing above `src/surface/` changes,
and no artifact needs migrating.

## Why the strategies survive the jump

The target strategies were chosen against this constraint, not adapted to it
afterwards:

| strategy | on Windows (UIA) | on macOS (AX) |
|---|---|---|
| `role-name` | `ControlType` + `Name` | `AXRole` + `AXTitle`/`AXDescription` |
| `labelled-field` | `LabeledBy`, else nearest preceding static text in the same container | `AXTitleUIElement`, else the same fallback |
| `table-cell` | `GridPattern` / `TableItemPattern` row + column headers | `AXRow` / `AXColumn` |
| `section-ordinal` | nth child of a named group in the tree | same |
| `anchor-offset` | offset from a located element's `BoundingRectangle` | offset from `AXFrame` |
| `dom-hint` | **not applicable** | **not applicable** |

`dom-hint` being inapplicable is why it is a distinct strategy kind rather than a
generic "selector" field. A schema with one opaque selector string would have made
every artifact web-only without saying so; keeping the markup hint in its own variant
means a desktop driver can report it unsupported and fall through, exactly as
`matching.ts` already does for `anchor-offset` on a tree-based surface.

The `labelled-field` fallback is the interesting one, and it is the *same* problem
as on the legacy web. A Win32 dialog built with static-text labels next to edit
controls has no programmatic label association, so the accessible name of the edit
control is empty — precisely what `web/perceive.ts` works around by reading the
adjacent table cell. The desktop equivalent is "nearest static text to the left or
above within the same container", which is the same heuristic against a different
tree.

## Action mapping

| action | UIA | AX |
|---|---|---|
| `click` | `InvokePattern`, else `LegacyIAccessible.DoDefaultAction`, else synthesised click at the bounding rect centre | `AXPress` |
| `fill` | `ValuePattern.SetValue`, else focus + synthesised keystrokes | `AXValue` set, else keystrokes |
| `select` | `SelectionItemPattern.Select` | `AXValue` on the popup |
| `readText` | `Name` / `ValuePattern.Value` / `TextPattern` | `AXValue` / `AXTitle` |
| `navigate` | not meaningful; a desktop capability's `entryUrl` becomes a launch command | same |

`navigate` is the only genuinely awkward one. `target.entryUrl` would carry a launch
specification instead of a URL, and `surfaceKind: 'desktop'` already exists on the
schema to signal which reading applies. The allowlist's URL patterns would become
window-title or executable-path patterns, which is a change to
`policy/allowlist.ts` — the one place outside `src/surface/` that assumes a URL, and
worth noting as a real seam violation rather than glossing over.

## What would be harder than it looks

- **Perception cost.** A full UIA tree walk is far slower than a DOM query, and
  `resolve` re-perceives before every action by design. A desktop driver would need
  a cache keyed on a window-change event rather than the current
  perceive-every-time approach, which trades away some of the determinism argument
  in `REPORT.md §3`.
- **Screencast for the operator handoff.** There is no CDP equivalent. The
  handoff would need per-frame window capture plus `SendInput`, or an existing remote
  desktop transport. The `ControlLease` and `InterventionBroker` do not change; only
  the transport in `operator-server.ts` does.
- **No `bypassCSP` analogue needed**, but also no in-page injection: the human action
  recorder would have to hook accessibility events instead of DOM events.
