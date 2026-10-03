// Chrome wiring for Tab Triage. Decisions live in lib/rules.js (unit-tested); this file only
// gathers tab state, talks to the local server, and closes/unloads tabs.

import {
  planSweep, textAllowed, unloadOrder, memoryCheckDue, nextSweepAt, sweepDue, closeSelection, isLoaded,
} from "./lib/rules.js";
import { api } from "./lib/api.js";
import { markSeen } from "./lib/seen.js";
import { planTidy } from "./lib/tidy.js";
import { menuItems, parseMenuId } from "./lib/addmenu.js";

const SWEEP_HOUR = 19;
const STALE_MS = 96 * 3600_000;
const LIVE_TAB_BUDGET = 12;
const UNLOAD_PER_CYCLE = 2;
const DASHBOARD = chrome.runtime.getURL("dashboard/index.html");

// --- scheduling ------------------------------------------------------------------

// Runs on every service-worker wake, so only create alarms that are missing — recreating them
// would keep pushing the next firing back.
async function scheduleAlarms() {
  if (!(await chrome.alarms.get("sweep"))) {
    chrome.alarms.create("sweep", { when: nextSweepAt(Date.now(), SWEEP_HOUR) });
  }
  if (!(await chrome.alarms.get("memory"))) chrome.alarms.create("memory", { periodInMinutes: 5 });
}

chrome.runtime.onInstalled.addListener(() => {
  scheduleAlarms();
  rebuildMenus().catch(report);
});
chrome.runtime.onStartup.addListener(async () => {
  await scheduleAlarms();
  const { lastSweepAt } = await chrome.storage.local.get("lastSweepAt");
  if (sweepDue(lastSweepAt ?? null, Date.now())) sweep().catch(report);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "sweep") {
    chrome.alarms.create("sweep", { when: nextSweepAt(Date.now() + 60_000, SWEEP_HOUR) });
    sweep().catch(report);
  } else if (alarm.name === "memory" || alarm.name === "memory-followup") {
    guardMemory().catch(report);
  }
});

function report(err) {
  console.error("[tab-triage]", err);
  chrome.storage.local.set({ lastError: { at: Date.now(), message: String(err?.message ?? err) } });
}

// --- toolbar button opens (or focuses) the dashboard --------------------------

chrome.action.onClicked.addListener(async () => {
  const [existing] = await chrome.tabs.query({ url: DASHBOARD });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: DASHBOARD });
  }
});

// --- activity tracking -------------------------------------------------------------

// When each tab id was last looked at or left, for the memory guard's "recently used" rule.
// Kept in session storage so it survives the service worker being suspended. Updates are chained
// so quick tab switches can't overwrite each other.
let activityQueue = Promise.resolve();
function recordActivity(windowId, tabId) {
  activityQueue = activityQueue.then(async () => {
    const { lastActive = {}, activeByWindow = {} } = await chrome.storage.session.get(["lastActive", "activeByWindow"]);
    const now = Date.now();
    const previous = activeByWindow[windowId];
    if (previous != null && previous !== tabId) lastActive[previous] = now; // the tab you just left
    lastActive[tabId] = now;
    activeByWindow[windowId] = tabId;
    for (const [id, t] of Object.entries(lastActive)) if (now - t > 48 * 3600_000) delete lastActive[id];
    await chrome.storage.session.set({ lastActive, activeByWindow });
  }).catch(report);
  return activityQueue;
}

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  recordActivity(windowId, tabId);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab) markSeen(tab.url);
  updateBadge();
});

let lastMemoryCheck = null;
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url && tab.active) markSeen(info.url);
  if (info.status === "complete" && memoryCheckDue(lastMemoryCheck, Date.now())) {
    lastMemoryCheck = Date.now();
    guardMemory().catch(report);
  }
});
chrome.tabs.onCreated.addListener(updateBadge);
chrome.tabs.onRemoved.addListener(updateBadge);

async function updateBadge() {
  const tabs = await chrome.tabs.query({});
  const live = tabs.filter((t) => isLoaded(t) && t.url !== DASHBOARD).length;
  const over = live > LIVE_TAB_BUDGET;
  await chrome.action.setBadgeText({ text: over ? String(live) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#c2410c" });
}

// --- page probe: in-progress form + first 1500 chars of text ---------------------

function probePage(wantText) {
  const fields = [...document.querySelectorAll("input, textarea, select")];
  const busy = fields.some((el) => {
    if (el.type === "file") return el.files && el.files.length > 0;
    if (el.type === "checkbox" || el.type === "radio") return el.checked !== el.defaultChecked;
    if (el.type === "hidden" || el.tagName === "SELECT") return false;
    return typeof el.defaultValue === "string" && el.value !== el.defaultValue;
  });
  const text = wantText ? (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 1500) : null;
  return { busy, text };
}

// Unloaded tabs hold no form state. For a loaded web page, a probe that errors or hangs counts
// as busy: better to leave a tab open than lose a half-written form.
// Not detected: contenteditable editors (Notion, Linear, Slack) — they're always "editable",
// so flagging them would keep every such tab open forever; those apps autosave drafts.
async function probe(tab, wantText) {
  const idle = { busy: false, text: null };
  if (!tab || tab.discarded || tab.status === "unloaded" || !/^https?:/.test(tab.url)) return idle;
  const unsure = { busy: true, text: null };
  const run = chrome.scripting
    .executeScript({ target: { tabId: tab.id, allFrames: true }, func: probePage, args: [wantText] })
    .then((frames) => ({
      busy: frames.some((f) => f.result?.busy),
      text: frames[0]?.result?.text ?? null,
    }))
    .catch(() => unsure);
  const timeout = new Promise((resolve) => setTimeout(() => resolve(unsure), 2000));
  return Promise.race([run, timeout]);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]);
    }
  });
  await Promise.all(workers);
  return out;
}

async function busyAmong(tabs) {
  const results = await mapLimit(tabs, 6, (t) => probe(t, false));
  return new Set(tabs.filter((_, k) => results[k].busy).map((t) => t.id));
}

// --- sweep ---------------------------------------------------------------------------

// Shared by sweep and its preview. manual: "Sweep now" — every unprotected tab, whatever its age.
async function sweepInputs(manual) {
  const state = await api("GET", "/api/state");
  const [tabs, groups, stored] = await Promise.all([
    chrome.tabs.query({}),
    chrome.tabGroups.query({}),
    chrome.storage.local.get("seen"),
  ]);
  const visible = tabs.filter((t) => t.url !== DASHBOARD);
  const options = {
    now: Date.now(), staleMs: STALE_MS, mode: state.mode, keepOpen: state.settings.keep_open,
    seen: stored.seen ?? {}, groupTitles: new Map(groups.map((g) => [g.id, g.title])),
    ignoreAge: manual,
  };
  return { state, visible, options };
}

// What a manual sweep would do, for the dashboard's confirmation. Changes nothing.
async function previewSweep() {
  const { state, visible, options } = await sweepInputs(true);
  const plan = planSweep(visible, options);
  return { mode: state.mode, saved: plan.candidates.length, dropped: plan.drop.length };
}

async function sweep({ manual = false } = {}) {
  const { state, visible, options } = await sweepInputs(manual);
  const neverRead = state.settings.never_read;

  // Probe everything we might close (saves and drops): catches in-progress forms, grabs text.
  const first = planSweep(visible, options);
  const byId = new Map(visible.map((t) => [t.id, t]));
  const probes = await mapLimit(first.candidates, 6, (c) => probe(byId.get(c.id), textAllowed(c.url, neverRead)));
  const busyIds = new Set(first.candidates.filter((_, k) => probes[k].busy).map((c) => c.id));
  for (const id of await busyAmong(first.drop.map((d) => byId.get(d.id)))) busyIds.add(id);
  const textById = new Map(first.candidates.map((c, k) => [c.id, probes[k].text]));

  const plan = planSweep(visible, { ...options, busyIds });
  const payload = plan.candidates.map(({ id, ...c }) => ({ ...c, text: textById.get(id) || undefined }));
  const res = await api("POST", "/api/sweep", { tabs: payload });

  if (res.close_now) {
    // Probing takes a while; re-read tabs and only close ones that are still what we saved.
    // Cut-off is when the sweep was planned: anything touched since then stays open.
    const current = (await chrome.tabs.query({})).filter((t) => t.url !== DASHBOARD);
    const ids = closeSelection(
      current,
      new Map(plan.candidates.map((c) => [c.url, options.now])),
      new Map(plan.drop.map((d) => [d.id, d.url])),
      { seen: options.seen, busyIds },
    );
    await closeTabs(ids);
    const closedUrls = new Set(current.filter((t) => ids.includes(t.id)).map((t) => t.url));
    await api("POST", "/api/closed", { urls: plan.candidates.map((c) => c.url).filter((u) => closedUrls.has(u)) });
  }
  await chrome.storage.local.set({
    lastSweepAt: Date.now(),
    lastSweep: { at: Date.now(), mode: res.mode, saved: plan.candidates.length, dropped: plan.drop.length },
  });
  updateBadge();
  return { mode: res.mode, saved: plan.candidates.length, dropped: plan.drop.length, closed: res.close_now };
}

async function closeTabs(ids) {
  if (!ids.length) return;
  const live = new Set((await chrome.tabs.query({})).map((t) => t.id));
  const existing = ids.filter((id) => live.has(id));
  if (existing.length) await chrome.tabs.remove(existing);
}

// Approval from the dashboard: close every tab the sweeps saved, plus junk/duplicates.
// The drop list is recomputed from the tabs open right now, every candidate is re-probed for
// half-filled forms, and a saved tab used after it was saved stays open.
async function closePending() {
  const [{ tabs: pending }, state, stored] = await Promise.all([
    api("GET", "/api/pending-close"),
    api("GET", "/api/state"),
    chrome.storage.local.get("seen"),
  ]);
  const tabs = (await chrome.tabs.query({})).filter((t) => t.url !== DASHBOARD);
  const seen = stored.seen ?? {};
  const { drop } = planSweep(tabs, {
    now: Date.now(), staleMs: STALE_MS, mode: state.mode, keepOpen: state.settings.keep_open, seen,
  });
  const saved = new Map(pending.map((p) => [p.url, p.last_seen_at * 1000]));
  const drops = new Map(drop.map((d) => [d.id, d.url]));
  const maybe = closeSelection(tabs, saved, drops, { seen });
  const busyIds = await busyAmong(tabs.filter((t) => maybe.includes(t.id)));
  const ids = closeSelection(tabs, saved, drops, { seen, busyIds });
  await closeTabs(ids);
  const closedUrls = new Set(tabs.filter((t) => ids.includes(t.id)).map((t) => t.url));
  // Saved tabs no longer open in Chrome (closed by hand) are settled too; kept-open ones stay pending.
  const stillOpen = new Set(tabs.filter((t) => !ids.includes(t.id)).map((t) => t.url));
  await api("POST", "/api/closed", {
    urls: pending.map((p) => p.url).filter((u) => closedUrls.has(u) || !stillOpen.has(u)),
  });
  if (state.mode === "first-run") await api("POST", "/api/first-run/complete", {});
  updateBadge();
  return { closed: ids.length };
}

// --- memory guard -----------------------------------------------------------------

async function guardMemory() {
  const mem = await api("GET", "/api/memory");
  await chrome.storage.local.set({ lastMemory: { ...mem, at: Date.now() } });
  if (!mem.over) return mem;
  const state = await api("GET", "/api/state");
  const tabs = await chrome.tabs.query({});
  const { lastActive = {} } = await chrome.storage.session.get("lastActive");
  const order = unloadOrder(tabs.filter((t) => t.url !== DASHBOARD), {
    keepOpen: state.settings.keep_open, now: Date.now(), lastActive,
  });
  const byId = new Map(tabs.map((t) => [t.id, t]));
  let unloaded = 0;
  for (const id of order) {
    if (unloaded >= UNLOAD_PER_CYCLE) break;
    const { busy } = await probe(byId.get(id), false);
    if (busy) continue;
    await chrome.tabs.discard(id).catch(() => null);
    unloaded++;
  }
  if (unloaded) chrome.alarms.create("memory-followup", { when: Date.now() + 30_000 });
  return { ...mem, unloaded };
}

// --- right-click menu: add the current page to a theme --------------------------------

let menuKey = null;
async function rebuildMenus() {
  const board = await api("GET", "/api/board");
  const themes = [...board.themes, ...board.later_themes, ...board.snoozed_themes]
    .filter((t) => t.name !== "Unsorted")
    .map((t) => ({ id: t.id, name: t.name }));
  const key = JSON.stringify(themes);
  if (key === menuKey) return;
  menuKey = key;
  await chrome.contextMenus.removeAll();
  for (const item of menuItems(themes)) {
    chrome.contextMenus.create({ contexts: ["page", "action"], ...item });
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const action = parseMenuId(info.menuItemId);
  if (!action || !tab || !/^https?:/.test(tab.url)) return;
  try {
    const [state, board] = await Promise.all([api("GET", "/api/state"), api("GET", "/api/board")]);
    const all = [...board.themes, ...board.later_themes, ...board.snoozed_themes];
    const theme = action.unsorted ? "Unsorted"
      : action.themeId == null ? null : all.find((t) => t.id === action.themeId)?.name;
    const { text } = textAllowed(tab.url, state.settings.never_read) ? await probe(tab, true) : { text: null };
    await api("POST", "/api/tabs/add", { url: tab.url, title: tab.title, theme, text });
    if (action.close) await chrome.tabs.remove(tab.id);
    await chrome.action.setBadgeText({ text: "✓" });
    setTimeout(() => updateBadge(), 1500);
  } catch (e) {
    report(e);
  }
});

// --- merge windows: gather everything into a work window + an inbox window --------

async function tidyWindows() {
  const [windows, state] = await Promise.all([
    chrome.windows.getAll({ populate: true, windowTypes: ["normal"] }),
    api("GET", "/api/state"),
  ]);
  const plan = planTidy(windows, { keepOpen: state.settings.keep_open, dashboardUrl: DASHBOARD });
  const pinned = new Set(windows.flatMap((w) => w.tabs).filter((t) => t.pinned).map((t) => t.id));
  let moved = 0;
  let failed = 0;
  for (const g of plan.groupMoves) {
    try {
      await chrome.tabGroups.move(g.groupId, { windowId: g.windowId, index: -1 });
      moved++;
    } catch {
      failed++;
    }
  }
  for (const m of plan.tabMoves) {
    try {
      // Pinned tabs must land in the pinned strip at the front.
      await chrome.tabs.move(m.tabId, { windowId: m.windowId, index: pinned.has(m.tabId) ? 0 : -1 });
      moved++;
    } catch {
      failed++;
    }
  }
  if (plan.workId != null) await chrome.windows.update(plan.workId, { focused: true });
  const left = (await chrome.windows.getAll({ windowTypes: ["normal"] })).filter((w) => !w.incognito).length;
  return { moved, failed, windows: left };
}

// --- messages from the dashboard page ------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const handlers = {
    sweepNow: () => sweep({ manual: true }),
    previewSweep,
    themesChanged: rebuildMenus,
    closePending,
    checkMemory: guardMemory,
    tidyWindows,
  };
  const fn = handlers[msg?.type];
  if (!fn) return false;
  fn().then((r) => sendResponse({ ok: true, result: r }), (e) => {
    report(e);
    sendResponse({ ok: false, error: String(e?.message ?? e) });
  });
  return true;
});

// Seed "which tab is showing in each window" so the first tab you leave after a reload counts.
chrome.tabs.query({ active: true }).then((tabs) => {
  for (const t of tabs) recordActivity(t.windowId, t.id);
}).catch(report);

scheduleAlarms();
updateBadge();
rebuildMenus().catch(report);
