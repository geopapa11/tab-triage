// Shift-click range selection: ids of the visible rows from the anchor to the clicked row.
export function rangeIds(visibleIds, anchorId, clickedId) {
  const a = visibleIds.indexOf(anchorId);
  const b = visibleIds.indexOf(clickedId);
  if (a === -1 || b === -1) return [clickedId];
  return visibleIds.slice(Math.min(a, b), Math.max(a, b) + 1);
}

// Themes offered by "Move to…" and "Merge into…": the visible ones, then Later and snoozed ones
// (labelled), so a parked theme can still receive tabs.
export function pickerThemes(board, excludeId = null) {
  const tag = (list, note) => (list || []).map((t) => ({ id: t.id, name: t.name, note }));
  return [...tag(board.themes, ""), ...tag(board.later_themes, "Later"), ...tag(board.snoozed_themes, "Snoozed")]
    .filter((t) => t.id !== excludeId);
}

export function filterThemes(themes, query) {
  const q = query.trim().toLowerCase();
  return q ? themes.filter((t) => t.name.toLowerCase().includes(q)) : themes;
}

// Rows for the dashboard's "Open tabs" view: every web page open in Chrome (one row per URL),
// with the theme it is already saved in, if any. Completed entries don't count as saved.
export function openTabRows(chromeTabs, board, dashboardUrl) {
  const savedIn = new Map();
  for (const th of [...(board.themes || []), ...(board.later_themes || []), ...(board.snoozed_themes || [])]) {
    for (const t of th.tabs || []) if (t.status === "open") savedIn.set(t.url, th.name);
  }
  for (const t of board.snoozed_tabs || []) savedIn.set(t.url, t.theme);
  const seen = new Set();
  const rows = [];
  for (const t of chromeTabs) {
    if (!/^https?:/.test(t.url) || t.url.startsWith(dashboardUrl) || seen.has(t.url)) continue;
    seen.add(t.url);
    rows.push({ id: t.id, url: t.url, title: t.title || t.url, savedIn: savedIn.get(t.url) ?? null });
  }
  return rows;
}

// "none" | "some" | "all": how much of `ids` is in the selection (for a select-all checkbox).
export function selectionState(selected, ids) {
  const n = ids.filter((id) => selected.has(id)).length;
  return n === 0 ? "none" : n === ids.length ? "all" : "some";
}

// Select-all click: select every id, or clear them if they were all selected already.
export function toggleAll(selected, ids) {
  const next = new Set(selected);
  const all = selectionState(selected, ids) === "all";
  for (const id of ids) all ? next.delete(id) : next.add(id);
  return next;
}

// Viewport y for the selection bar: `gap` px above the topmost selected row, but never off screen.
export function barTop(rowTop, barHeight, viewportHeight, gap = 6, margin = 8) {
  const wanted = rowTop - barHeight - gap;
  return Math.max(margin, Math.min(wanted, viewportHeight - barHeight - margin));
}
