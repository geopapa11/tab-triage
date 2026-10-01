// Plan for gathering scattered tabs into at most two windows: work (where the dashboard is, or
// the focused window) and comms (keep-open tabs such as inboxes). Pure — background.js applies it
// with chrome.tabGroups.move / chrome.tabs.move. Nothing is closed; Chrome drops emptied windows.
import { isKeepOpen } from "./rules.js";

export function planTidy(windows, { keepOpen = [], dashboardUrl }) {
  const eligible = windows.filter((w) => w.type === "normal" && !w.incognito);
  if (!eligible.length) return { workId: null, commsId: null, groupMoves: [], tabMoves: [] };
  const work =
    eligible.find((w) => w.tabs.some((t) => t.url === dashboardUrl)) ??
    eligible.find((w) => w.focused) ??
    [...eligible].sort((a, b) => b.tabs.length - a.tabs.length)[0];
  const isComms = (t) => !t.pinned && t.groupId === -1 && isKeepOpen(t, keepOpen);

  let comms = null;
  for (const w of eligible) {
    if (w === work) continue;
    const n = w.tabs.filter(isComms).length;
    if (n && (!comms || n > comms.n)) comms = { w, n };
  }
  const commsId = comms?.w.id ?? null;

  const groupMoves = [];
  const tabMoves = [];
  const seenGroups = new Set();
  for (const w of eligible) {
    for (const t of w.tabs) {
      if (t.groupId !== -1) {
        if (w !== work && !seenGroups.has(t.groupId)) groupMoves.push({ groupId: t.groupId, windowId: work.id });
        seenGroups.add(t.groupId);
        continue;
      }
      const target = isComms(t) && commsId != null ? commsId : work.id;
      if (target !== w.id) tabMoves.push({ tabId: t.id, windowId: target });
    }
  }
  return { workId: work.id, commsId, groupMoves, tabMoves };
}
