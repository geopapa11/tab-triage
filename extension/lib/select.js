// Shift-click range selection: ids of the visible rows from the anchor to the clicked row.
export function rangeIds(visibleIds, anchorId, clickedId) {
  const a = visibleIds.indexOf(anchorId);
  const b = visibleIds.indexOf(clickedId);
  if (a === -1 || b === -1) return [clickedId];
  return visibleIds.slice(Math.min(a, b), Math.max(a, b) + 1);
}
