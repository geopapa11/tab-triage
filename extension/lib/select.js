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
