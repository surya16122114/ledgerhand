/**
 * In-page perception.
 *
 * `perceiveInPage` is serialised and executed inside each frame of the target
 * document. It cannot reference anything from module scope, so every helper is
 * nested. It returns plain data; all matching and decision-making happens back
 * in Node (see ../matching.ts) where it is typed and unit-testable.
 *
 * Why not `page.accessibility.snapshot()` or `ariaSnapshot()`?
 *
 * Because on the apps this project targets they return a tree full of unnamed
 * controls. A legacy form puts its label in a sibling <td> with no `for=`
 * attribute, so the browser correctly computes an EMPTY accessible name for the
 * input, and a role+name matcher has nothing to match on. The value this
 * function adds over the built-in snapshot is precisely the synthesis step: when
 * the authored accessible name is missing, recover the name a human operator
 * would use by reading the label out of the adjacent cell or the preceding text
 * on the same line, and record that the name was synthesised so downstream code
 * knows to keep a fallback ready.
 */

/** Mirrors ControlRole in ../types.ts; duplicated because this runs in-page. */
type RawRole =
  | 'button' | 'link' | 'textbox' | 'password' | 'combobox' | 'checkbox' | 'radio'
  | 'heading' | 'text' | 'cell' | 'row' | 'table' | 'image' | 'frame' | 'unknown';

export interface RawStrategy {
  kind: string;
  [k: string]: unknown;
}

export interface RawControl {
  ref: string;
  role: RawRole;
  name: string;
  nameSource: string;
  value?: string;
  disabled?: boolean;
  checked?: boolean;
  readonly?: boolean;
  section?: string;
  table?: { near?: string; rowIndex?: number; colIndex?: number; columnHeader?: string; rowKey?: string };
  targeting: RawStrategy[];
  box?: { x: number; y: number; width: number; height: number };
}

export interface RawPerception {
  url: string;
  title: string;
  text: string;
  controls: RawControl[];
  /**
   * True when the control cap was hit and some controls were not reported.
   *
   * Silent truncation is the dangerous version of this: a screen with a long table
   * would simply stop mentioning controls past the cap, and a target that resolved
   * yesterday would report TARGET_NOT_FOUND today with nothing to explain why.
   */
  truncated: boolean;
  /**
   * The structural section headings found on this screen.
   *
   * Reported directly rather than inferred from which heading each control was
   * attributed to. Those differ: a screen whose heading has no controls beneath it
   * -- an information-only panel -- contributes no attributions at all, so
   * inferring the heading set from attributions silently loses it.
   */
  headings: string[];
}

export const REF_ATTR = 'data-lh-ref';

/**
 * Upper bound on controls reported per frame.
 *
 * A cap is necessary -- a report screen with a thousand rows would otherwise produce an
 * observation too large to send to a model and slow to match against. Hitting it is
 * reported via `RawPerception.truncated` rather than passing silently.
 */
export const MAX_PERCEIVED_CONTROLS = 400;

/**
 * @param generation observation generation, embedded in every ref so stale refs
 *                   are detectable instead of silently resolving to whatever now
 *                   sits in that slot.
 */
export function perceiveInPage(generation: number): RawPerception {
  const REF = 'data-lh-ref';
  const MAX_CONTROLS = 400; // keep in sync with MAX_PERCEIVED_CONTROLS (this runs in-page)

  // Clear refs from the previous observation so nothing stale lingers.
  for (const el of Array.from(document.querySelectorAll('[' + REF + ']'))) el.removeAttribute(REF);

  const norm = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();
  const stripLabelPunct = (s: string): string => s.replace(/[\s:* ]+$/, '').trim();

  function isVisible(el: Element): boolean {
    const he = el as HTMLElement;
    const cs = getComputedStyle(he);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    const r = he.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    return true;
  }

  function roleOf(el: Element): RawRole {
    const explicit = el.getAttribute('role');
    if (explicit) {
      const map: Record<string, RawRole> = {
        button: 'button', link: 'link', textbox: 'textbox', combobox: 'combobox',
        listbox: 'combobox', checkbox: 'checkbox', radio: 'radio', heading: 'heading',
        cell: 'cell', gridcell: 'cell', row: 'row', table: 'table', grid: 'table', img: 'image',
      };
      if (map[explicit]) return map[explicit]!;
    }
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const t = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
      if (t === 'password') return 'password';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      return 'textbox';
    }
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'button') return 'button';
    if (tag === 'a') return (el as HTMLAnchorElement).href ? 'link' : 'text';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'td' || tag === 'th') return 'cell';
    if (tag === 'tr') return 'row';
    if (tag === 'table') return 'table';
    if (tag === 'img') return 'image';
    return 'unknown';
  }

  /**
   * Simplified accessible-name computation. Follows the spirit of the accname
   * spec for the cases that occur in practice, and stops there -- a full
   * implementation would be a lot of code for no additional coverage on these
   * surfaces.
   */
  function authoredName(el: Element): { name: string; source: string } {
    const aria = norm(el.getAttribute('aria-label'));
    if (aria) return { name: aria, source: 'aria-label' };

    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const parts = labelledby.split(/\s+/).map((id) => norm(document.getElementById(id)?.textContent)).filter(Boolean);
      if (parts.length) return { name: parts.join(' '), source: 'aria-labelledby' };
    }

    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const t = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (t === 'submit' || t === 'button' || t === 'reset') {
        const v = norm((el as HTMLInputElement).value);
        if (v) return { name: v, source: 'value' };
      }
      if (t === 'image') {
        const alt = norm(el.getAttribute('alt'));
        if (alt) return { name: alt, source: 'alt' };
      }
    }
    if (tag === 'img') {
      const alt = norm(el.getAttribute('alt'));
      if (alt) return { name: alt, source: 'alt' };
    }
    if (tag === 'button' || tag === 'a' || /^h[1-6]$/.test(tag) || tag === 'td' || tag === 'th') {
      const txt = norm((el as HTMLElement).innerText || el.textContent);
      if (txt) return { name: txt, source: 'text-content' };
    }

    const id = el.getAttribute('id');
    if (id) {
      // CSS.escape is not available in every legacy document mode.
      const forLabel = Array.from(document.querySelectorAll('label[for]')).find((l) => l.getAttribute('for') === id);
      if (forLabel) {
        const txt = stripLabelPunct(norm((forLabel as HTMLElement).innerText || forLabel.textContent));
        if (txt) return { name: txt, source: 'label-for' };
      }
    }
    const wrapping = el.closest('label');
    if (wrapping) {
      const txt = stripLabelPunct(norm((wrapping as HTMLElement).innerText || wrapping.textContent));
      if (txt) return { name: txt, source: 'label-wrapping' };
    }
    const title = norm(el.getAttribute('title'));
    if (title) return { name: title, source: 'title' };
    const placeholder = norm(el.getAttribute('placeholder'));
    if (placeholder) return { name: placeholder, source: 'placeholder' };

    return { name: '', source: 'none' };
  }

  /**
   * The synthesis step. Runs only when there is no authored name.
   *
   * 1. adjacent-cell: the label sits in a preceding <td> of the same row. This
   *    is the classic `<td>Member ID:</td><td><input></td>` pattern.
   * 2. preceding-text: the label is a bare text node or inline element before
   *    the control inside the same container.
   */
  function synthesiseName(el: Element): { name: string; source: string } {
    const cell = el.closest('td, th');
    if (cell) {
      let prev = cell.previousElementSibling;
      while (prev) {
        // A cell that itself contains controls is a layout cell, not a label.
        if (!prev.querySelector('input, select, textarea, button, a[href]')) {
          const txt = stripLabelPunct(norm((prev as HTMLElement).innerText || prev.textContent));
          if (txt && txt.length <= 60) return { name: txt, source: 'adjacent-cell' };
        }
        prev = prev.previousElementSibling;
      }
    }

    // Walk backwards through preceding siblings for the nearest label-ish text.
    let node: Node | null = el.previousSibling;
    let hops = 0;
    while (node && hops < 8) {
      const txt = stripLabelPunct(norm(node.textContent));
      if (txt && txt.length <= 60) return { name: txt, source: 'preceding-text' };
      node = node.previousSibling;
      hops++;
    }
    return { name: '', source: 'none' };
  }

  /**
   * Section headings, in document order.
   *
   * Legacy apps have no <h1>. They have a table cell rendered bold with a grey
   * background. So "heading" is detected structurally -- a text-only cell whose
   * computed font-weight is bold -- rather than by tag name. Getting this right
   * is what makes `section` and `table.near` useful for disambiguation.
   */
  const headings: { el: Element; text: string }[] = [];
  // Populated below, after headerRowOf is available -- a column header must not be
  // counted as a section heading.

  function sectionFor(el: Element): string | undefined {
    let best: string | undefined;
    for (const h of headings) {
      if (h.el === el) continue;
      const pos = h.el.compareDocumentPosition(el);
      // el comes after the heading (and is not contained by a control we care about)
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) best = h.text;
    }
    return best;
  }

  const isHeaderish = (c: HTMLTableCellElement): boolean => {
    if (c.tagName.toLowerCase() === 'th') return true;
    if (c.querySelector('input, select, textarea, a[href]')) return false;
    return Number(getComputedStyle(c).fontWeight) >= 600 || Boolean(c.querySelector('b, strong'));
  };

  /**
   * Header row of a data table, or null if this is not a data table.
   *
   * The second condition is the one that matters. Legacy screens use tables for two
   * completely different things: a data grid (header row, then rows of records) and
   * a label/value form ("New Account Number:" | "12345-50"). Both begin with a row of
   * bold cells, so "first row whose cells are all bold" identifies a header row in
   * the first case and misidentifies a *record* as a header in the second.
   *
   * The tell is the row underneath. In a data grid the row below the header starts
   * with data -- an account number, unstyled. In a label/value form every row starts
   * with another bold label. So a candidate header row only counts if the first cell
   * of the following row is not itself label-like.
   *
   * Getting this wrong is not cosmetic: it produced a confirmation-screen target
   * whose "column header" was the previous row's *value*, and a replay that read the
   * account description where the account number was meant to be.
   */
  const headerRowCache = new Map<Element, HTMLTableRowElement | null>();
  function headerRowOf(table: HTMLTableElement): HTMLTableRowElement | null {
    if (headerRowCache.has(table)) return headerRowCache.get(table)!;
    let found: HTMLTableRowElement | null = null;
    const rows = Array.from(table.rows);
    for (let i = 0; i < Math.min(4, rows.length); i++) {
      const row = rows[i]!;
      const cells = Array.from(row.cells);
      if (cells.length < 2) continue;
      if (!cells.every(isHeaderish)) continue;

      const next = rows[i + 1];
      const nextFirst = next?.cells[0];
      if (!nextFirst) continue; // a bold row with nothing under it is a caption
      if (isHeaderish(nextFirst)) continue; // label/value form, not a data grid

      found = row;
      break;
    }
    headerRowCache.set(table, found);
    return found;
  }

  /**
   * The label of a read-only value cell in a label/value table.
   *
   * Confirmation screens and profile panels present their data this way, and those
   * are exactly the values a capability needs to return. The label in the preceding
   * cell is a unique caption on the screen -- unlike a column header, which is shared
   * by every row in its column -- so it is a sound basis for targeting.
   */
  function valueCellLabel(cell: HTMLTableCellElement): string | undefined {
    const row = cell.closest('tr') as HTMLTableRowElement | null;
    if (!row) return undefined;
    const cells = Array.from(row.cells);
    const index = cells.indexOf(cell);
    if (index <= 0) return undefined;

    // A cell that is itself a label is not a value.
    //
    // Without this, a four-column row of two label/value pairs reports the *labels*
    // as values too -- "Name:" would come back as a value whose label is the previous
    // pair's contents. Worse than noise: two cells then answer to the name "Status",
    // and a read of Status fails as ambiguous rather than returning ACTIVE.
    //
    // The trailing colon is the signal, which is a convention rather than a
    // guarantee -- but it is the near-universal one for label/value presentation in
    // these applications, and `stripLabelPunct` already relies on it when deriving
    // names. A label without a colon degrades to an extra perceived control, not to a
    // wrong answer.
    if (/:\s*$/.test(norm(cell.innerText || cell.textContent))) return undefined;

    // The label is the NEAREST preceding label-like cell in this row, not the first
    // cell of the row.
    //
    // Both halves of that sentence were learned the hard way. Testing the cell itself
    // for boldness fails because this application bolds the value it most wants the
    // operator to notice -- a confirmation screen's new account number is bold, and a
    // styling test throws away the very field the capability exists to return. But
    // anchoring on cells[0] instead fails on the profile block, which packs *two*
    // label/value pairs into one four-column row: the "Name" value sits at index 3 and
    // would take its label from "Member ID" at index 0. Walking backwards to the
    // nearest label handles both, and multi-pair rows are the norm on these screens.
    for (let i = index - 1; i >= 0; i--) {
      const candidate = cells[i];
      if (!candidate) continue;
      if (candidate.querySelector('input, select, textarea, button, a[href]')) continue;
      if (!isHeaderish(candidate)) continue;
      const txt = stripLabelPunct(norm(candidate.innerText || candidate.textContent));
      if (txt && txt.length <= 60) return txt;
    }
    return undefined;
  }

  function tableInfoFor(el: Element): RawControl['table'] {
    const cell = el.closest('td, th') as HTMLTableCellElement | null;
    if (!cell) return undefined;
    const row = cell.closest('tr') as HTMLTableRowElement | null;
    const table = cell.closest('table') as HTMLTableElement | null;
    if (!row || !table) return undefined;
    const colIndex = Array.from(row.cells).indexOf(cell);
    const rowIndex = Array.from(table.rows).indexOf(row);
    const header = headerRowOf(table);
    const columnHeader = header && header !== row ? norm(header.cells[colIndex]?.textContent) || undefined : undefined;
    const firstCell = row.cells[0];
    const rowKey = firstCell && firstCell !== cell ? norm(firstCell.textContent) || undefined : undefined;
    return {
      near: sectionFor(table),
      rowIndex: rowIndex >= 0 ? rowIndex : undefined,
      colIndex: colIndex >= 0 ? colIndex : undefined,
      columnHeader,
      rowKey,
    };
  }

  /** Last-resort markup hint. Prefers an id, else a short nth-child path. */
  function domHint(el: Element): string {
    const id = el.getAttribute('id');
    if (id) return '#' + id.replace(/([^\w-])/g, '\\$1');
    const parts: string[] = [];
    let cur: Element | null = el;
    let depth = 0;
    while (cur && cur !== document.body && depth < 5) {
      const parent: Element | null = cur.parentElement;
      const idx = parent ? Array.from(parent.children).indexOf(cur) + 1 : 1;
      parts.unshift(cur.tagName.toLowerCase() + ':nth-child(' + idx + ')');
      cur = parent;
      depth++;
    }
    return parts.join(' > ');
  }

  // ---------------------------------------------------------------- headings
  // Deferred until here because excluding column headers needs headerRowOf, whose
  // cache is declared above this point.
  for (const el of Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,th,td,legend,caption'))) {
    if (!isVisible(el)) continue;
    if (el.querySelector('input, select, textarea, button, a[href], table')) continue;
    // A column header names a column, not a section. Counting them attributed every
    // data cell in a grid to whichever column header came last in the document
    // ("Opened"), and let a checkpoint be synthesised from a column name.
    const owningRow = el.closest('tr') as HTMLTableRowElement | null;
    const owningTable = el.closest('table') as HTMLTableElement | null;
    if (owningRow && owningTable && headerRowOf(owningTable) === owningRow) continue;

    const tag = el.tagName.toLowerCase();
    const bold = /^h[1-6]$/.test(tag) || tag === 'legend' || tag === 'caption' || tag === 'th'
      ? true
      : Number(getComputedStyle(el as HTMLElement).fontWeight) >= 600 || Boolean(el.querySelector(':scope > b, :scope > strong'));
    if (!bold) continue;
    const text = norm((el as HTMLElement).innerText || el.textContent);
    if (!text || text.length > 80) continue;
    headings.push({ el, text });
  }

  // ------------------------------------------------------------------ collect
  const INTERACTIVE = 'a[href], button, input, select, textarea, [role=button], [role=link], [onclick]';
  const candidates: Element[] = [];
  for (const el of Array.from(document.querySelectorAll(INTERACTIVE))) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' && (el.getAttribute('type') ?? '').toLowerCase() === 'hidden') continue;
    if (!isVisible(el)) continue;
    candidates.push(el);
  }
  // Value-bearing cells. Two shapes, both of which a capability needs to read:
  //
  //   data grid       -> addressed by row key + column header
  //   label/value row -> addressed by its label
  //
  // Cells that are themselves labels are skipped; only the values are collected.
  for (const table of Array.from(document.querySelectorAll('table'))) {
    const header = headerRowOf(table as HTMLTableElement);
    for (const row of Array.from((table as HTMLTableElement).rows)) {
      if (row === header) continue;
      for (const cell of Array.from(row.cells)) {
        if (!isVisible(cell)) continue;
        if (cell.querySelector('table, input, select, textarea')) continue;
        const txt = norm(cell.textContent);
        if (!txt || txt.length > 120) continue;
        if (!header && !valueCellLabel(cell)) continue; // neither a grid cell nor a labelled value
        candidates.push(cell);
      }
    }
  }
  for (const h of headings) candidates.push(h.el);

  const controls: RawControl[] = [];
  let n = 0;
  let truncated = false;
  const seen = new Set<Element>();
  for (const el of candidates) {
    if (controls.length >= MAX_CONTROLS) {
      truncated = true;
      break;
    }
    if (seen.has(el)) continue;
    seen.add(el);

    const role = roleOf(el);
    let { name, source } = authoredName(el);
    if (!name && (role === 'textbox' || role === 'password' || role === 'combobox' || role === 'checkbox' || role === 'radio')) {
      const syn = synthesiseName(el);
      name = syn.name;
      source = syn.source;
    }
    const table = tableInfoFor(el);
    if (role === 'cell') {
      // A cell's *name* is what it is called, never what it contains.
      //
      // The generic accessible-name path returns a table cell's text content, which
      // for a data cell is the value -- so the savings balance cell ends up named
      // "$8,241.77". That is wrong twice over: it is not a name, and it writes
      // record-time data into the target description that failure messages quote.
      // The caption of a label/value pair wins over a column header, because it
      // identifies one value rather than a whole column.
      const label = valueCellLabel(el as HTMLTableCellElement);
      if (label) {
        name = label;
        source = 'adjacent-cell';
      } else if (table?.columnHeader) {
        name = table.columnHeader;
        source = 'column-header';
      }
      // Otherwise the text content stands: a standalone cell used as a heading.
    }

    const ref = generation + ':' + n++;
    el.setAttribute(REF, ref);

    const he = el as HTMLElement;
    const rect = he.getBoundingClientRect();
    const section = sectionFor(el);

    // ------------------------------------------------------- build strategies
    const targeting: RawStrategy[] = [];
    const authoredSources = ['aria-label', 'aria-labelledby', 'label-for', 'label-wrapping', 'value', 'text-content', 'alt', 'title'];
    const isField = role === 'textbox' || role === 'password' || role === 'combobox' || role === 'checkbox' || role === 'radio';

    if (role === 'cell' && table?.rowKey && table?.columnHeader) {
      targeting.push({ kind: 'table-cell', near: table.near, rowKey: table.rowKey, rowKeyMatch: 'normalized', columnHeader: table.columnHeader });
    }
    if (isField && (source === 'adjacent-cell' || source === 'preceding-text') && name) {
      targeting.push({ kind: 'labelled-field', label: name, labelMatch: 'normalized', role });
    }
    // A cell named from its column header is ambiguous by construction -- every row
    // in that column shares the name -- so role-name is withheld for those. A cell
    // named from an adjacent label is not: that caption identifies one value, and it
    // is the most durable way to find it.
    if (name && role === 'cell' && source === 'adjacent-cell') {
      targeting.push({ kind: 'role-name', role, name, nameMatch: 'normalized' });
    }
    if (name && authoredSources.indexOf(source) >= 0 && role !== 'cell') {
      targeting.push({ kind: 'role-name', role, name, nameMatch: 'normalized' });
    }
    if (isField && name && authoredSources.indexOf(source) < 0 && !targeting.some((s) => s.kind === 'labelled-field')) {
      targeting.push({ kind: 'labelled-field', label: name, labelMatch: 'normalized', role });
    }
    if ((role === 'link' || role === 'button') && name) {
      targeting.push({ kind: 'text', text: name, textMatch: 'normalized', role });
    }
    // Ordinal targeting is deliberately NOT offered for data cells.
    //
    // "the 6th cell in SHARE / DEPOSIT ACCOUNTS" is meaningless the moment a member
    // has a different number of accounts, and its failure mode is the worst one
    // available: it resolves successfully to the wrong row and returns a
    // neighbouring account's balance. A read that cannot be addressed by row and
    // column should fail, not guess.
    if (section && role !== 'cell') {
      const sameSection = controls.filter((c) => c.section === section && c.role === role).length;
      targeting.push({ kind: 'section-ordinal', section, role, index: sameSection });
    }
    targeting.push({ kind: 'dom-hint', css: domHint(el) });

    const raw: RawControl = { ref, role, name, nameSource: source, targeting };
    if (section) raw.section = section;
    if (table) raw.table = table;
    if (rect.width || rect.height) raw.box = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };

    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      const inp = el as HTMLInputElement;
      const t = (inp.getAttribute('type') ?? 'text').toLowerCase();
      // Never read back the contents of a password field, not even into memory.
      if (t !== 'password' && t !== 'submit' && t !== 'button' && t !== 'reset') raw.value = inp.value;
      if (t === 'checkbox' || t === 'radio') raw.checked = inp.checked;
      if (inp.readOnly) raw.readonly = true;
      if (inp.disabled) raw.disabled = true;
    } else if (tag === 'select') {
      const sel = el as HTMLSelectElement;
      raw.value = sel.value;
      if (sel.disabled) raw.disabled = true;
    } else if (role === 'cell' || role === 'heading') {
      raw.value = norm((el as HTMLElement).innerText || el.textContent);
    } else if (tag === 'button' && (el as HTMLButtonElement).disabled) {
      raw.disabled = true;
    }

    controls.push(raw);
  }

  return {
    url: location.href,
    title: document.title,
    text: norm((document.body as HTMLElement | null)?.innerText ?? document.body?.textContent ?? ''),
    controls,
    truncated,
    headings: Array.from(new Set(headings.map((h) => h.text))),
  };
}
