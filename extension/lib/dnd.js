// Where a dragged item lands: the number of rows whose vertical midpoint is above the pointer.
export function dropIndex(midpoints, y) {
  return midpoints.filter((m) => m < y).length;
}

// New ranked order after dropping theme `draggedId` at `index` among the visible ranked themes.
// `all` includes off-screen (snoozed) themes so their ranks survive; intoRanked=false unranks it.
export function rankedOrder(all, visibleRanked, draggedId, index, intoRanked) {
  const order = all
    .filter((t) => t.position != null && t.id !== draggedId)
    .sort((a, b) => a.position - b.position)
    .map((t) => t.id);
  if (!intoRanked) return order;
  const visible = visibleRanked.filter((id) => id !== draggedId);
  const before = visible[index];
  order.splice(before == null ? order.length : order.indexOf(before), 0, draggedId);
  return order;
}

// Target index (among visible ranked themes, excluding the moved one) for the menu moves
// "top" | "up" | "down"; null when the move would do nothing. Feed the result to rankedOrder.
export function nudgeIndex(visibleRanked, id, direction) {
  const i = visibleRanked.indexOf(id);
  if (i === -1) return { top: 0, up: visibleRanked.length, down: null }[direction];
  if (direction === "top" || direction === "up") return i === 0 ? null : direction === "top" ? 0 : i - 1;
  return i === visibleRanked.length - 1 ? null : i + 1;
}
