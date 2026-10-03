// Plan for getting down to at most two windows. Two or fewer: nothing moves. More: the work window
// (where the dashboard is, else the focused one) and one second window stay — the one holding the
// most keep-open tabs (inboxes), else the largest. Tabs in those two never move; tabs from every
// other window fold in: keep-open tabs to the second window, everything else (groups whole) to the
// work window. Pure — background.js applies it. Nothing is closed; Chrome drops emptied windows.
import { isKeepOpen } from "./rules.js";

export function planTidy(windows, { keepOpen = [], dashboardUrl }) {
  const eligible = windows.filter((w) => w.type === "normal" && !w.incognito);
  const result = (workId = null, secondId = null) => ({ workId, secondId, groupMoves: [], tabMoves: [] });
  if (!eligible.length) return result();
  const work =
    eligible.find((w) => w.tabs.some((t) => t.url === dashboardUrl)) ??
    eligible.find((w) => w.focused) ??
    [...eligible].sort((a, b) => b.tabs.length - a.tabs.length)[0];
  if (eligible.length <= 2) return result(work.id);

  const isComms = (t) => !t.pinned && t.groupId === -1 && isKeepOpen(t, keepOpen);
  const commsCount = (w) => w.tabs.filter(isComms).length;
  const second = eligible
    .filter((w) => w !== work)
    .sort((a, b) => commsCount(b) - commsCount(a) || b.tabs.length - a.tabs.length)[0];

  const plan = result(work.id, second.id);
  const seenGroups = new Set();
  for (const w of eligible) {
    if (w === work || w === second) continue;
    for (const t of w.tabs) {
      if (t.groupId !== -1) {
        if (!seenGroups.has(t.groupId)) plan.groupMoves.push({ groupId: t.groupId, windowId: work.id });
        seenGroups.add(t.groupId);
      } else {
        plan.tabMoves.push({ tabId: t.id, windowId: isComms(t) ? second.id : work.id });
      }
    }
  }
  return plan;
}
