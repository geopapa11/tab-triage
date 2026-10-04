// Tab Triage dashboard. Server data in, DOM out; every action is an API call followed by a refresh.

import { api } from "../lib/api.js";
import { snoozePresets, ago, dayLabel, localISODate, fileStamp } from "../lib/time.js";
import { dropIndex, rankedOrder, nudgeIndex, edgeScrollSpeed } from "../lib/dnd.js";
import { markSeen } from "../lib/seen.js";
import { isLoaded } from "../lib/rules.js";
import { rangeIds, pickerThemes, filterThemes, openTabRows } from "../lib/select.js";
import { extractTitle } from "../lib/addmenu.js";

const DAY_S = 86400;
const LIVE_TAB_BUDGET = 12;
const SELF = location.href.split("#")[0];
const $ = (id) => document.getElementById(id);

const S = {
  view: readView(),
  state: null,
  board: null,
  completed: [],
  pending: 0,
  memory: null,
  liveTabs: 0,
  openTabs: [],
  windows: 0,
  lastSweep: null,
  offline: false,
  expandedDone: new Set(),
  selected: new Set(),
  anchor: null, // last row clicked, for shift-click ranges
  drag: null,
  busy: false,
};

function readView() {
  try {
    return localStorage.getItem("view") || "themes";
  } catch {
    return "themes";
  }
}

function saveView(v) {
  try {
    localStorage.setItem("view", v);
  } catch {
    /* per-viewer convenience only */
  }
}

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const favicon = (url) => `/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`;
const gb = (bytes) => (bytes / 1024 ** 3).toFixed(2);
const hhmm = (sec) => new Date(sec * 1000).toTimeString().slice(0, 5);

// --- data ---------------------------------------------------------------------------

let pollTimer;
async function refresh({ animate = false } = {}) {
  const before = animate ? snapshot() : null;
  try {
    const [state, board, completed, pending, memory, tabs, local, wins] = await Promise.all([
      api("GET", "/api/state"),
      api("GET", "/api/board"),
      api("GET", "/api/completed"),
      api("GET", "/api/pending-close"),
      api("GET", "/api/memory"),
      chrome.tabs.query({}),
      chrome.storage.local.get(["lastSweep", "lastError"]),
      chrome.windows.getAll({ windowTypes: ["normal"] }),
    ]);
    Object.assign(S, {
      state, board, completed: completed.tabs, pending: pending.urls.length, memory,
      liveTabs: tabs.filter((t) => isLoaded(t) && !t.url.startsWith(SELF)).length,
      openTabs: openTabRows(tabs, board, SELF),
      lastSweep: local.lastSweep ?? null, offline: false,
      windows: wins.filter((w) => !w.incognito).length,
    });
  } catch (e) {
    console.error(e);
    S.offline = true;
  }
  render();
  if (before) flip(before);
  if (!S.offline) chrome.runtime.sendMessage({ type: "themesChanged" }).catch(() => {});
  clearTimeout(pollTimer);
  pollTimer = setTimeout(refresh, S.state?.sorting ? 2500 : 20000);
}

async function act(fn, { animate = true } = {}) {
  try {
    await fn();
  } catch (e) {
    toast(`Something went wrong: ${e.message}`);
  }
  await refresh({ animate });
}

// --- render -------------------------------------------------------------------------

function render() {
  renderDateline();
  renderInstruments();
  renderBanners();
  renderViews();
  if (S.offline) {
    $("main").innerHTML = "";
    return;
  }
  const views = { themes: renderThemes, open: renderOpen, snoozed: renderSnoozed, completed: renderCompleted };
  $("main").innerHTML = (views[S.view] || renderThemes)();
  const present = new Set([...document.querySelectorAll("[data-tab-id]")].map((r) => Number(r.dataset.tabId)));
  for (const id of S.selected) if (!present.has(id)) S.selected.delete(id);
  renderBulkBar();
}

function renderDateline() {
  const now = new Date();
  const part = (opts) => now.toLocaleDateString("en-GB", opts);
  const parts = [`${part({ weekday: "long" })} ${now.getDate()} ${part({ month: "long" })} ${now.getFullYear()}`];
  const sweep = S.state?.last_sweep;
  if (sweep) parts.push(`last sweep ${ago(sweep.at, Date.now())}`);
  if (S.state?.last_model) parts.push(`sorted by ${S.state.last_model}`);
  $("dateline").textContent = parts.join(" · ");
}

function modeInfo() {
  const st = S.state;
  if (!st) return { cls: "", label: "—" };
  if (st.mode === "first-run") return { cls: "first", label: "First run" };
  if (st.mode === "dry-run") {
    const day = Math.min(7, Math.floor((Date.now() / 1000 - st.first_run_done_at) / DAY_S) + 1);
    return { cls: "dry", label: `Dry-run · day ${day}/7` };
  }
  return { cls: "live", label: "Live" };
}

function renderInstruments() {
  if (S.offline || !S.memory) {
    $("instruments").innerHTML = "";
    return;
  }
  const { chrome_bytes: total, tabs_bytes: tabsMem, tab_cap_bytes: cap } = S.memory;
  const memCls = tabsMem > cap ? "over" : tabsMem > cap * 0.8 ? "warn" : "";
  const pct = Math.min(100, (tabsMem / cap) * 100);
  const tabPct = Math.min(100, (S.liveTabs / LIVE_TAB_BUDGET) * 100);
  const mode = modeInfo();
  $("instruments").innerHTML = `
    <div class="gauge">
      <div class="label"><span>Mode</span></div>
      <div class="value"><span class="pill ${mode.cls}">${esc(mode.label)}</span></div>
    </div>
    <div class="gauge" title="Memory of web-page tabs — the part unloading tabs can reduce. Above the budget, least-recently-used tabs are unloaded. The Chrome total also counts the browser itself, GPU, network and extensions (and over-counts shared memory).">
      <div class="label"><span>Tab memory</span><span>budget ${+(cap / 1024 ** 3).toFixed(2)} GB</span></div>
      <div class="value">${gb(tabsMem)} GB <span class="sub-value">· Chrome total ${gb(total)} GB</span></div>
      <div class="meter ${memCls}"><i style="width:${pct}%"></i></div>
    </div>
    <div class="gauge" title="Loaded tabs across all windows">
      <div class="label"><span>Live tabs</span><span>budget ${LIVE_TAB_BUDGET}</span></div>
      <div class="value">${S.liveTabs}</div>
      <div class="meter ${S.liveTabs > LIVE_TAB_BUDGET ? "over" : ""}"><i style="width:${tabPct}%"></i></div>
    </div>
    <div class="gauge" title="Normal Chrome windows. Merge windows gathers tabs into a work window and an inbox window.">
      <div class="label"><span>Windows</span><span>budget 2</span></div>
      <div class="value">${S.windows}</div>
      <div class="meter ${S.windows > 2 ? "over" : ""}"><i style="width:${Math.min(100, (S.windows / 2) * 100)}%"></i></div>
    </div>`;
}

function banner(cls, body, button = "") {
  return `<div class="banner ${cls}">${body}${button}</div>`;
}

function renderBanners() {
  const out = [];
  if (S.offline) {
    out.push(banner("signal",
      `<p><strong>Can't reach the local server.</strong> It should start at login. Run
       <code>scripts/install.sh</code> in the tab-triage folder, or start it by hand with
       <code>uv run python -m server</code>.</p>`,
      `<button class="btn ghost small" data-action="retry">Retry</button>`));
    $("banners").innerHTML = out.join("");
    return;
  }
  const st = S.state;
  const nThemes = S.board.themes.length;
  const dropped = S.lastSweep?.dropped ?? 0;
  if (st.sorting) {
    out.push(banner("", `<span class="spinner"></span><p><strong>Sorting with Claude…</strong> New tabs appear in their themes as each batch finishes.</p>`));
  }
  if (st.sort_error) {
    const e = st.sort_error;
    const why = e.kind === "auth"
      ? "Claude isn't logged in with your subscription, so nothing was sent. Run <code>claude auth login</code> in a terminal, then re-sort."
      : esc(e.message);
    out.push(banner("signal", `<p><strong>Sorting failed</strong> — tabs were saved to Unsorted. ${why}</p>`,
      `<button class="btn ghost small" data-action="resort">Re-sort</button>`));
  }
  if (st.mode === "first-run") {
    if (!S.lastSweep && !S.pending) {
      out.push(banner("signal",
        `<p><strong>First run.</strong> Sweep every open tab (except pinned, active, playing audio, keep-open and half-filled forms) into themes. Nothing closes until you approve.</p>`,
        `<button class="btn signal" data-action="sweep-now">Run first sweep</button>`));
    } else {
      out.push(banner("signal",
        `<p><strong>${S.pending} tabs saved into ${nThemes} themes</strong>${dropped ? `, plus ${dropped} duplicates and junk tabs to drop` : ""}. Look the themes over, fix anything misplaced, then close them all.</p>`,
        `<button class="btn signal" data-action="approve" ${S.pending + dropped ? "" : "disabled"}>Approve &amp; close ${S.pending + dropped}</button>`));
    }
  } else if (st.mode === "dry-run") {
    if (st.auto_close_tomorrow) {
      out.push(banner("amber", `<p><strong>From tomorrow, swept tabs close automatically.</strong> Dry-run week ends tonight.</p>`));
    }
    if (S.pending) {
      out.push(banner("amber",
        `<p><strong>Dry-run:</strong> ${S.pending} stale tabs are saved here but still open in Chrome.</p>`,
        `<button class="btn ghost small" data-action="approve">Close them now</button>`));
    }
  }
  $("banners").innerHTML = out.join("");
}

function renderViews() {
  const labels = { themes: "Themes", open: "Open tabs", snoozed: "Snoozed", completed: "Completed" };
  const counts = S.offline ? {} : {
    themes: S.board.themes.length,
    open: S.openTabs.length,
    snoozed: S.board.snoozed_tabs.length + S.board.snoozed_themes.length,
    completed: S.completed.length,
  };
  for (const b of $("views").querySelectorAll("button")) {
    const v = b.dataset.view;
    b.setAttribute("aria-current", v === S.view ? "page" : "false");
    b.innerHTML = `${esc(labels[v] ?? v)}${counts[v] != null ? `<span class="count">${counts[v]}</span>` : ""}`;
  }
}

function tabRow(t, { theme = null, done = false } = {}) {
  const sub = [esc(t.domain), done ? `done ${hhmm(t.completed_at)}` : `saved ${ago(t.captured_at, Date.now())}`];
  if (theme) sub.unshift(`<span class="theme-chip">${esc(theme)}</span>`);
  if (t.pending_close) sub.push(`<span class="open-dot">● still open in Chrome</span>`);
  if (t.snoozed_until) sub.push(`wakes ${dayLabel(t.snoozed_until, Date.now())} ${hhmm(t.snoozed_until)}`);
  const remove = `<button class="tool" data-action="remove-tab" title="Not useful after all: take it off the list (no Completed history) and close it in Chrome">Remove</button>`;
  const tools = t.snoozed_until
    ? `<button class="tool" data-action="wake-tab">Wake now</button>${remove}`
    : done ? "" : `<button class="tool" data-action="snooze-tab">Snooze</button>${remove}`;
  return `
    <li class="tab ${t.status} ${t.back ? "back" : ""} ${S.selected.has(t.id) ? "selected" : ""}" data-tab-id="${t.id}" data-url="${esc(t.url)}"
        draggable="${!done && !t.snoozed_until && !theme}">
      <button class="check" data-action="${t.status === "done" ? "uncheck" : "check"}"
              aria-label="${t.status === "done" ? "Mark not done" : "Mark done"}"></button>
      <img src="${favicon(t.url)}" alt="" loading="lazy">
      <div class="title">
        <a href="${esc(t.url)}" data-action="open-tab" title="${esc(t.title)}">${esc(t.title)}</a>
        <div class="sub">${sub.join(" · ")}</div>
      </div>
      <div class="row-tools">${tools}</div>
    </li>`;
}

function themeCard(th, i) {
  const open = th.tabs.filter((t) => t.status === "open");
  const done = th.tabs.filter((t) => t.status === "done");
  const expanded = S.expandedDone.has(th.id);
  const merges = (S.state.merge_suggestions || []).filter((m) => m.from === th.name);
  const badges = [
    th.back ? `<span class="badge back">Back</span>` : "",
    th.stale ? `<button class="badge stale" data-action="drop-theme" title="Untouched for 7+ days">Stale — drop it?</button>` : "",
    !th.ranked && th.suggested_position != null ? `<span class="badge suggest">suggested #${th.suggested_position + 1}</span>` : "",
  ].join("");
  return `
    <li class="theme ${th.ranked ? "" : "unranked"}" data-theme-id="${th.id}" data-theme-name="${esc(th.name)}">
      <div class="rank" ${th.name === "Unsorted" ? 'title="Unsorted always stays last"' : 'draggable="true" data-drag="theme" title="Drag to reprioritize"'}>
        <b>${th.ranked ? String(i + 1).padStart(2, "0") : "—"}</b><span class="grip">⋮⋮</span>
      </div>
      <div class="theme-body">
        <div class="theme-head">
          <h2 class="theme-name" data-action="rename" title="Click to rename">${esc(th.name)}</h2>
          ${badges}
          <span class="theme-meta">${open.length} open${done.length ? ` · ${done.length} done` : ""}</span>
          <div class="theme-tools">
            ${th.name === "Unsorted" ? `<button class="tool" data-action="resort" title="Ask Claude to sort these tabs again">Re-sort</button>` : ""}
            <button class="tool" data-action="open-theme">Open ${Math.min(S.state.settings.open_tabs_max, open.length)}</button>
            <button class="tool" data-action="add-link" title="Paste a link to add it to this theme">+ Add link</button>
            <button class="tool" data-action="later" title="Collapse it into the Later list at the bottom">Later</button>
            <button class="tool" data-action="snooze-theme">Snooze</button>
            ${th.name === "Unsorted" ? "" : `<button class="tool warn" data-action="remove-theme" title="Remove every tab in this theme (not useful after all). Undo is offered.">Remove</button>`}
            <button class="tool" data-action="theme-menu" aria-label="More">⋯</button>
          </div>
        </div>
        ${merges.map((m) => `
          <div class="merge-hint" data-into="${esc(m.into)}">
            <span>Looks like it overlaps <strong>${esc(m.into)}</strong> — ${esc(m.reason)}</span>
            <button class="btn small" data-action="accept-merge">Merge</button>
            <button class="tool" data-action="dismiss-merge">Dismiss</button>
          </div>`).join("")}
        <ul class="tabs" data-theme-name="${esc(th.name)}">${open.map((t) => tabRow(t)).join("")}</ul>
        ${done.length ? `
          <button class="done-toggle" data-action="toggle-done">${expanded ? "▾" : "▸"} ${done.length} completed</button>
          ${expanded ? `<ul class="tabs done-list">${done.map((t) => tabRow(t, { done: true })).join("")}</ul>` : ""}` : ""}
      </div>
    </li>`;
}

function renderThemes() {
  const themes = S.board.themes;
  const later = S.board.later_themes;
  if (!themes.length && !later.length) {
    return `<div class="empty-state"><b>Nothing here yet</b>${
      S.state.mode === "first-run" ? "Run the first sweep to sort your open tabs into themes." : "The 19:00 sweep will file stale tabs here."
    }</div>`;
  }
  const ranked = themes.filter((t) => t.ranked);
  const unranked = themes.filter((t) => !t.ranked);
  return `
    <div class="zone-label" data-zone="ranked">Your priorities</div>
    <ol class="theme-list ${ranked.length ? "" : "empty"}" id="ranked">${ranked.map(themeCard).join("")}</ol>
    ${unranked.length ? `
      <div class="zone-label" data-zone="unranked">Unranked · drag up to prioritize</div>
      <ol class="theme-list" id="unranked">${unranked.map((t, i) => themeCard(t, i)).join("")}</ol>` : ""}
    ${later.length ? `
      <div class="zone-label">Later · ${later.length}</div>
      <ul class="later-list">${later.map((th) => `
        <li data-theme-id="${th.id}">
          <button class="later-row" data-action="unlater" title="Bring it back to its place in your priorities">
            <span class="later-name">${esc(th.name)}</span>
            <span class="theme-meta">${th.tabs.filter((t) => t.status === "open").length} open</span>
            <span class="later-back">Bring back ↑</span>
          </button>
        </li>`).join("")}</ul>` : ""}
    ${S.board.pending_sort ? `<p class="footnote">${S.board.pending_sort} tabs waiting to be sorted.</p>` : ""}`;
}

// Every web page open in Chrome right now, so any of them can be filed into a theme from here.
function renderOpen() {
  if (!S.openTabs.length) {
    return `<div class="empty-state"><b>No other tabs open</b>Pages you have open in Chrome show up here, ready to add to a theme.</div>`;
  }
  const row = (r) => `
    <li class="tab open-row" data-open-id="${r.id}">
      <span></span>
      <img src="${favicon(r.url)}" alt="" loading="lazy">
      <div class="title">
        <a href="${esc(r.url)}" data-action="focus-tab" title="Switch to this tab">${esc(r.title)}</a>
        <div class="sub">${esc(new URL(r.url).hostname.replace(/^www\./, ""))} · ${
          r.savedIn ? `already in <span class="theme-chip">${esc(r.savedIn)}</span>` : "not saved yet"}</div>
      </div>
      <div class="row-tools" style="opacity:1">
        <button class="tool" data-action="add-open" data-close="1">Add &amp; close</button>
        <button class="tool" data-action="add-open">Add, keep open</button>
      </div>
    </li>`;
  return `<div class="ledger">
    <h3>Open in Chrome · ${S.openTabs.length}</h3>
    <ul class="tabs">${S.openTabs.map(row).join("")}</ul>
    <p class="footnote">Add a tab to a theme without waiting for a sweep. “Add &amp; close” also closes it in Chrome.</p>
  </div>`;
}

function renderSnoozed() {
  const { snoozed_themes: themes, snoozed_tabs: tabs } = S.board;
  if (!themes.length && !tabs.length) {
    return `<div class="empty-state"><b>Nothing snoozed</b>Snoozed tabs and themes wait here and come back on their own.</div>`;
  }
  const themeRows = themes.map((th) => `
    <li class="tab" data-theme-id="${th.id}">
      <span></span><span></span>
      <div class="title"><strong>${esc(th.name)}</strong>
        <div class="sub">${th.tabs.filter((t) => t.status === "open").length} tabs · wakes ${dayLabel(th.snoozed_until, Date.now())} ${hhmm(th.snoozed_until)}</div></div>
      <div class="row-tools" style="opacity:1"><button class="tool" data-action="wake-theme">Wake now</button></div>
    </li>`).join("");
  return `<div class="ledger">
    ${themes.length ? `<h3>Themes</h3><ul class="tabs">${themeRows}</ul>` : ""}
    ${tabs.length ? `<h3>Tabs</h3><ul class="tabs">${tabs.map((t) => tabRow(t, { theme: t.theme })).join("")}</ul>` : ""}
  </div>`;
}

function renderCompleted() {
  if (!S.completed.length) {
    return `<div class="empty-state"><b>Nothing completed yet</b>Tick a tab when you're done with it. It stays here for ${S.state.settings.done_retention_days} days.</div>`;
  }
  const groups = new Map();
  for (const t of S.completed) {
    const label = dayLabel(t.completed_at, Date.now());
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(t);
  }
  return `<div class="ledger">
    ${[...groups].map(([label, tabs]) => `
      <h3>${esc(label)} · ${tabs.length}</h3>
      <ul class="tabs">${tabs.map((t) => tabRow(t, { theme: t.theme, done: true })).join("")}</ul>`).join("")}
    <p class="footnote">Completed tabs are deleted ${S.state.settings.done_retention_days} days after you tick them. Untick to bring one back.</p>
  </div>`;
}

// --- motion: FLIP so checked rows visibly slide to the bottom ----------------------

function snapshot() {
  const pos = new Map();
  for (const el of document.querySelectorAll("[data-tab-id], .theme[data-theme-id]")) {
    pos.set(el.dataset.tabId ? `t${el.dataset.tabId}` : `h${el.dataset.themeId}`, el.getBoundingClientRect().top);
  }
  return pos;
}

function flip(before) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  for (const el of document.querySelectorAll("[data-tab-id], .theme[data-theme-id]")) {
    const key = el.dataset.tabId ? `t${el.dataset.tabId}` : `h${el.dataset.themeId}`;
    const was = before.get(key);
    if (was == null) continue;
    const dy = was - el.getBoundingClientRect().top;
    if (Math.abs(dy) < 1) continue;
    el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }],
      { duration: 320, easing: "cubic-bezier(.2,.8,.2,1)" });
  }
}

// --- small UI pieces -----------------------------------------------------------------

let toastTimer;
function toast(text, action = null) {
  const el = $("toast");
  el.textContent = text;
  el.classList.toggle("has-action", !!action);
  if (action) {
    const b = document.createElement("button");
    b.textContent = action.label;
    b.onclick = () => {
      el.classList.remove("show");
      action.run();
    };
    el.append(" ", b);
  }
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), action ? 7000 : 3200);
}

// Remove = not useful after all: off the list (no Completed history), and closed in Chrome.
// Undo restores the list entries and reopens the Chrome tabs in the background.
async function removeTabs(ids, what = null) {
  const byId = new Map(
    [...S.board.themes, ...S.board.later_themes, ...S.board.snoozed_themes]
      .flatMap((th) => th.tabs).concat(S.board.snoozed_tabs).map((t) => [t.id, t]),
  );
  const urls = new Set(ids.map((id) => byId.get(id)?.url).filter(Boolean));
  await api("POST", "/api/tabs/bulk", { ids, action: "remove" });
  const open = (await chrome.tabs.query({})).filter((t) => urls.has(t.url) && !t.url.startsWith(SELF));
  if (open.length) await chrome.tabs.remove(open.map((t) => t.id));
  const one = what ?? (ids.length === 1 ? `“${byId.get(ids[0])?.title ?? "tab"}”` : `${ids.length} tabs`);
  toast(`Removed ${one}${open.length ? ` and closed ${open.length} in Chrome` : ""}.`, {
    label: "Undo",
    run: () => act(async () => {
      await api("POST", "/api/tabs/restore", { ids });
      for (const t of open) await chrome.tabs.create({ url: t.url, active: false, windowId: t.windowId }).catch(() => chrome.tabs.create({ url: t.url, active: false }));
    }),
  });
  await refresh({ animate: true });
}

// A searchable list of themes: used by "Move to…" and "Merge into…". Includes Later and snoozed
// themes so parked themes can still receive tabs.
function themePicker(anchor, { exclude = null, allowNew = false, withAuto = false } = {}, onPick) {
  const themes = pickerThemes(S.board, exclude).filter((t) => !(withAuto && t.name === "Unsorted"));
  popover(anchor, `
    ${withAuto ? `
      <button data-choice="__auto">Let Claude choose</button>
      <button data-choice="__unsorted">On its own <span class="hint">Unsorted</span></button>
      <hr>` : ""}
    <input type="search" class="picker-filter" placeholder="Find a theme…" aria-label="Find a theme">
    <div class="picker-list">${themes.map((t) => `
      <button data-choice="${t.id}">${esc(t.name)}${t.note ? `<span class="hint">${t.note}</span>` : ""}</button>`).join("")}
    </div>
    ${allowNew ? `<hr><button data-choice="__new">New theme…</button>` : ""}`,
  (choice) => {
    if (choice === "__auto") onPick({ id: null, name: null });
    else if (choice === "__unsorted") onPick({ id: null, name: "Unsorted" });
    else if (choice === "__new") {
      const name = prompt("Name of the new theme:")?.trim();
      if (name) onPick({ id: null, name });
    } else {
      const t = themes.find((x) => String(x.id) === choice);
      if (t) onPick(t);
    }
  });
  const pop = $("popover");
  const input = pop.querySelector(".picker-filter");
  const rows = () => [...pop.querySelectorAll(".picker-list button")];
  input.focus();
  input.addEventListener("input", () => {
    const keep = new Set(filterThemes(themes, input.value).map((t) => String(t.id)));
    for (const b of rows()) b.hidden = !keep.has(b.dataset.choice);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") rows().find((b) => !b.hidden)?.click();
  });
}

async function pageTitle(url) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(url, { signal: ctrl.signal, credentials: "include" });
    clearTimeout(timer);
    return extractTitle(await res.text(), url);
  } catch {
    return extractTitle("", url);
  }
}

function closePopover() {
  $("popover").hidden = true;
  $("popover").innerHTML = "";
}

function popover(anchor, html, onClick) {
  const pop = $("popover");
  pop.innerHTML = html;
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  // Never let a tall menu (e.g. 30 "Merge into" rows) push its first items off the top.
  pop.style.top = `${Math.max(10, Math.min(r.bottom + 6, innerHeight - pop.offsetHeight - 10))}px`;
  pop.style.left = `${Math.max(10, Math.min(r.right - w, innerWidth - w - 10))}px`;
  pop.onclick = (e) => {
    const b = e.target.closest("[data-choice]");
    if (!b) return;
    const input = b.dataset.choice === "date" ? pop.querySelector("input[type=date]")
      : b.dataset.choice === "input" ? pop.querySelector("input[type=url]") : null;
    const value = input ? input.value.trim() : b.dataset.choice;
    if (input && !value) return;
    closePopover();
    onClick(value);
  };
}

function snoozeMenu(anchor, apply) {
  const wake = S.state.settings.snooze_time;
  const p = snoozePresets(Date.now(), wake);
  const fmt = (ms) => `${dayLabel(ms / 1000, Date.now())} ${wake}`;
  const tomorrow = localISODate(Date.now() + DAY_S * 1000);
  popover(anchor, `
    <button data-choice="${p.tomorrow}">Tomorrow <span class="hint">${fmt(p.tomorrow)}</span></button>
    <button data-choice="${p.nextMonday}">Next Monday <span class="hint">${fmt(p.nextMonday)}</span></button>
    <button data-choice="${p.week}">In a week <span class="hint">${fmt(p.week)}</span></button>
    <hr>
    <label>Pick a date <input type="date" min="${tomorrow}"></label>
    <button data-choice="date">Snooze until that date</button>`,
  (value) => {
    const ms = /^\d{4}-/.test(value)
      ? new Date(`${value}T${wake}:00`).getTime()
      : Number(value);
    apply(ms / 1000);
  });
}

function themeById(id) {
  return S.board.themes.find((t) => t.id === id);
}

// One numeric setting: label, input with its limits, and a one-line explanation.
function numberField(key, label, help, { min, max, step = 1, unit = "" }) {
  const v = S.state.settings[key];
  return `
    <label for="set-${key}">${label}${unit ? ` (${unit})` : ""}</label>
    <input id="set-${key}" type="number" min="${min}" max="${max}" step="${step}" value="${v}" data-setting="${key}">
    <p class="help">${help} <span class="range">${min}–${max}.</span></p>`;
}

function timeField(key, label, help) {
  return `
    <label for="set-${key}">${label}</label>
    <input id="set-${key}" type="time" value="${esc(S.state.settings[key])}" data-setting="${key}">
    <p class="help">${help}</p>`;
}

function renderSettings() {
  const s = S.state.settings;
  const models = ["sonnet", "opus", "haiku"];
  $("settings").innerHTML = `
    <h2>Settings</h2>

    <h3>Sweeps</h3>
    ${numberField("stale_hours", "A tab is stale after", "The daily sweep saves tabs you haven't looked at for this long. Sweep now ignores it.", { min: 1, max: 720, unit: "hours" })}
    ${timeField("sweep_time", "Daily sweep time", "When the automatic sweep runs each day. If Chrome is closed then, it runs when you next open it.")}
    ${numberField("done_retention_days", "Keep completed tabs for", "Ticked tabs stay in Completed this long, then are deleted for good.", { min: 1, max: 365, unit: "days" })}

    <h3>Working from the list</h3>
    ${numberField("open_tabs_max", "“Open N” opens at most", "How many of a theme's top tabs open in a new window.", { min: 1, max: 12, unit: "tabs" })}
    ${timeField("snooze_time", "Snoozed items wake at", "The time of day a snoozed tab or theme comes back.")}

    <h3>Sorting</h3>
    <label for="set-model">Sorting model</label>
    <select id="set-model">${[...new Set([s.model, ...models])].map((m) => `<option ${m === s.model ? "selected" : ""}>${esc(m)}</option>`).join("")}</select>
    <p class="help">An alias always means the newest version. Falls back to <b>${esc(s.fallback_model)}</b> if unavailable. Runs on your Claude subscription only.</p>
    ${numberField("max_themes", "Maximum themes", "New themes stop being created at this count; extra tabs go to Unsorted. Merge themes to make room.", { min: 5, max: 60 })}

    <h3>Memory</h3>
    ${numberField("tab_memory_cap_mb", "Tab memory budget", "Above this, least-recently-used tabs are unloaded (not closed), keep-open tabs last.", { min: 256, max: 65536, step: 128, unit: "MB" })}
    ${numberField("unload_idle_hours", "Never unload a tab used in the last", "Protects tabs you used recently from being unloaded, so they don't reload when you return. 0 turns the protection off.", { min: 0, max: 168, unit: "hours" })}

    <h3>Which tabs</h3>
    <label for="set-keep">Keep open — never closed</label>
    <textarea id="set-keep">${esc(s.keep_open.join("\n"))}</textarea>
    <p class="help">One URL pattern per line; <code>*</code> matches anything. Pinned tabs are always kept.</p>
    <label for="set-never">Never read page text</label>
    <textarea id="set-never">${esc(s.never_read.join("\n"))}</textarea>
    <p class="help">Only the title and URL of these go to Claude. Sign-in pages are always excluded.</p>

    <details class="advanced">
      <summary>Advanced</summary>
      ${numberField("theme_stale_days", "Flag a theme as stale after", "A theme nobody has touched for this long shows “Stale — drop it?”.", { min: 1, max: 90, unit: "days" })}
      ${numberField("memory_check_minutes", "Check memory every", "How often tab memory is measured. It is also checked after a page finishes loading.", { min: 1, max: 60, unit: "minutes" })}
      ${numberField("min_tabs_new_theme", "A new theme needs at least", "Claude only creates a theme when this many tabs belong to it; fewer go to Unsorted.", { min: 1, max: 10, unit: "tabs" })}
      ${numberField("text_chars", "Page text sent to Claude", "Characters of each page's text included when sorting. 0 sends titles and addresses only.", { min: 0, max: 2000, unit: "characters" })}
      ${numberField("batch_size", "Tabs per Claude call", "Larger batches sort faster but give Claude more to juggle at once.", { min: 5, max: 50, unit: "tabs" })}
    </details>

    <div class="row">
      <button class="btn" data-action="save-settings">Save</button>
      <button class="btn ghost" data-action="toggle-settings">Close</button>
    </div>`;
}

const lines = (id) => $(id).value.split("\n").map((l) => l.trim()).filter(Boolean);

// --- actions --------------------------------------------------------------------------

async function message(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res?.ok) throw new Error(res?.error || "extension did not answer");
  return res.result;
}

const actions = {
  retry: () => refresh(),
  "sweep-now": async (el) => {
    el.disabled = true;
    try {
      const p = await message("previewSweep");
      const live = p.mode === "live";
      if (!p.saved && !(live && p.dropped)) {
        toast("Nothing to sweep: every open tab is protected (the one you're on, pinned, inboxes, audio, half-typed forms).");
        return;
      }
      const what = `Save ${p.saved} tab${p.saved === 1 ? "" : "s"} to the dashboard${live ? " and close them" : ""}`
        + (p.dropped && live ? `, and close ${p.dropped} duplicate${p.dropped === 1 ? "" : "s"}/junk` : "") + "?";
      const kept = "The tab you're on in each window, pinned tabs, inboxes, tabs playing audio and half-typed forms stay open.";
      const later = live ? "" : " (Dry-run week: saved tabs stay open until you click Close them now.)";
      if (!confirm(`${what}\n\n${kept}${later}`)) return;
      toast("Sweeping…");
      await act(async () => {
        const r = await message("sweepNow");
        const none = !r.saved && !r.dropped;
        toast(none
          ? "Nothing to sweep: every open tab is protected."
          : r.closed
            ? `Saved and closed ${r.saved} tabs, dropped ${r.dropped}.`
            : `Saved ${r.saved} tabs${r.dropped ? `, ${r.dropped} to drop` : ""}. Nothing closed yet.`);
      });
    } catch (e) {
      toast(`Sweep failed: ${e.message}`);
    } finally {
      el.disabled = false;
    }
  },
  tidy: async (el) => {
    el.disabled = true;
    try {
      await act(async () => {
        const r = await message("tidyWindows");
        toast(r.moved || r.failed
          ? `Merged into ${r.windows} window${r.windows === 1 ? "" : "s"} (moved ${r.moved} tabs or groups${r.failed ? `, ${r.failed} couldn't move` : ""}).`
          : `Nothing to merge: you have ${r.windows} window${r.windows === 1 ? "" : "s"}, within the budget of 2.`);
      });
    } finally {
      el.disabled = false;
    }
  },
  approve: async () => {
    const n = S.pending + (S.lastSweep?.dropped ?? 0);
    if (!confirm(`Close about ${n} tabs now? Everything saved stays here; reopen any tab with one click.`)) return;
    await act(async () => toast(`Closed ${(await message("closePending")).closed} tabs.`));
  },
  resort: () => act(() => api("POST", "/api/resort", {})),
  check: (el) => act(() => api("POST", `/api/tabs/${tabId(el)}/check`, {})),
  uncheck: (el) => act(() => api("POST", `/api/tabs/${tabId(el)}/uncheck`, {})),
  "open-tab": async (el, e) => {
    e.preventDefault();
    await chrome.tabs.create({ url: el.getAttribute("href"), active: true });
    await markSeen(el.getAttribute("href"));
    act(() => api("POST", `/api/tabs/${tabId(el)}/opened`, {}), { animate: false });
  },
  "snooze-tab": (el) => snoozeMenu(el, (until) => act(() => api("POST", `/api/tabs/${tabId(el)}/snooze`, { until }))),
  "wake-tab": (el) => act(() => api("POST", `/api/tabs/${tabId(el)}/snooze`, { until: null })),
  "snooze-theme": (el) => snoozeMenu(el, (until) => act(() => api("POST", `/api/themes/${themeId(el)}/snooze`, { until }))),
  "remove-tab": (el) => removeTabs([tabId(el)]),
  "focus-tab": async (el, e) => {
    e.preventDefault();
    const id = Number(el.closest("[data-open-id]").dataset.openId);
    const tab = await chrome.tabs.update(id, { active: true }).catch(() => null);
    if (tab) chrome.windows.update(tab.windowId, { focused: true });
  },
  "add-open": (el) => {
    const id = Number(el.closest("[data-open-id]").dataset.openId);
    const close = el.dataset.close === "1";
    const row = S.openTabs.find((r) => r.id === id);
    themePicker(el, { allowNew: true, withAuto: true }, (t) => act(async () => {
      await message("addOpenTab", { tabId: id, theme: t.name, close });
      const where = t.name ? `to “${t.name}”` : "— Claude is choosing a theme";
      toast(`Added “${row?.title ?? "tab"}” ${where}${close ? " and closed it" : ""}.`);
    }));
  },
  "add-link": (el) => {
    const th = themeById(themeId(el));
    popover(el, `
      <label>Link <input type="url" placeholder="https://…" style="width:260px"></label>
      <button data-choice="input">Add to “${esc(th.name)}”</button>`,
    async (url) => {
      if (!/^https?:\/\//i.test(url)) {
        toast("Only web links (http or https) can be added.");
        return;
      }
      toast("Adding…");
      await act(async () => {
        const title = await pageTitle(url);
        await api("POST", "/api/tabs/add", { url, title, theme: th.name });
        toast(`Added “${title}” to ${th.name}.`);
      });
    });
    const input = $("popover").querySelector("input[type=url]");
    input.focus();
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") $("popover").querySelector('[data-choice="input"]').click();
    });
  },
  later: (el) => {
    const th = themeById(themeId(el));
    act(() => api("POST", `/api/themes/${th.id}/later`, { on: true }));
    toast(`“${th.name}” moved to Later. Bring it back from the bottom of the list.`);
  },
  unlater: (el) => act(() => api("POST", `/api/themes/${themeId(el)}/later`, { on: false })),
  "wake-theme": (el) => act(() => api("POST", `/api/themes/${themeId(el)}/snooze`, { until: null })),
  "toggle-done": (el) => {
    const id = themeId(el);
    S.expandedDone.has(id) ? S.expandedDone.delete(id) : S.expandedDone.add(id);
    render();
  },
  "open-theme": async (el) => {
    const th = themeById(themeId(el));
    const top = th.tabs.filter((t) => t.status === "open").slice(0, S.state.settings.open_tabs_max);
    if (!top.length) return;
    await chrome.windows.create({ url: top.map((t) => t.url), focused: true });
    await markSeen(top.map((t) => t.url));
    toast(`Opened ${top.length} tabs in a new window.`);
    act(() => api("POST", "/api/opened", { ids: top.map((t) => t.id) }), { animate: false });
  },
  "drop-theme": async (el) => {
    const th = themeById(themeId(el));
    const open = th.tabs.filter((t) => t.status === "open");
    if (!confirm(`Mark all ${open.length} tabs in “${th.name}” as done? They stay in Completed for ${S.state.settings.done_retention_days} days.`)) return;
    await act(async () => {
      for (const t of open) await api("POST", `/api/tabs/${t.id}/check`, {});
    });
  },
  rename: (el) => {
    if (el.isContentEditable) return;
    const old = el.textContent;
    el.contentEditable = "true";
    el.focus();
    getSelection().selectAllChildren(el);
    const finish = async (save) => {
      el.removeEventListener("keydown", onKey);
      el.removeEventListener("blur", onBlur);
      el.contentEditable = "false";
      const name = el.textContent.trim();
      if (!save || !name || name === old) {
        el.textContent = old;
        return;
      }
      await act(() => api("POST", `/api/themes/${themeId(el)}/rename`, { name }));
    };
    const onKey = (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      if (e.key === "Escape") finish(false);
    };
    const onBlur = () => finish(true);
    el.addEventListener("keydown", onKey);
    el.addEventListener("blur", onBlur);
  },
  "theme-menu": (el) => {
    const id = themeId(el);
    const th = themeById(id);
    const open = th.tabs.filter((t) => t.status === "open").length;
    popover(el, `
      ${th.name === "Unsorted" ? "" : `
      <button data-choice="move:top">Move to top <span class="hint">makes it #1</span></button>
      <button data-choice="move:up">Move up</button>
      <button data-choice="move:down">Move down</button>
      <hr>`}
      <button data-choice="rename">Rename</button>
      <button data-choice="done">Mark all done <span class="hint">kept ${S.state.settings.done_retention_days} days</span></button>
      <button data-choice="dissolve">Dissolve <span class="hint">re-sort its tabs</span></button>
      <button data-choice="merge">Merge into… <span class="hint">pick a theme</span></button>
      ${th.name === "Unsorted" ? "" : `<button data-choice="remove" class="danger">Remove theme <span class="hint">all its tabs, with undo</span></button>`}`,
    (choice) => {
      if (choice.startsWith("move:")) {
        const visibleRanked = S.board.themes.filter((t) => t.ranked).map((t) => t.id);
        const index = nudgeIndex(visibleRanked, id, choice.slice(5));
        if (index == null) return;
        const all = [...S.board.themes, ...S.board.snoozed_themes, ...S.board.later_themes];
        act(() => api("POST", "/api/themes/reorder", { ids: rankedOrder(all, visibleRanked, id, index, true) }));
      } else if (choice === "rename") actions.rename(el.closest(".theme").querySelector(".theme-name"));
      else if (choice === "done") {
        act(() => api("POST", `/api/themes/${id}/done`, {}));
        toast(`Marked ${open} tabs done. Untick any of them in Completed within ${S.state.settings.done_retention_days} days.`);
      } else if (choice === "dissolve") {
        if (!confirm(`Dissolve “${th.name}”? Its ${open} tabs go back to Claude to be sorted again, and Claude won't recreate this theme.`)) return;
        act(() => api("POST", `/api/themes/${id}/dissolve`, {}));
      } else if (choice === "remove") {
        actions["remove-theme"](el);
      } else if (choice === "merge") {
        // Opened after this click finishes, or the "click outside closes the menu" handler
        // would close the picker straight away.
        setTimeout(() => themePicker(el, { exclude: id }, (into) => {
          act(() => api("POST", `/api/themes/${id}/merge`, { into: into.id }));
          toast(`Merged “${th.name}” into “${into.name}”.`);
        }), 0);
      }
    });
  },
  "remove-theme": (el) => {
    const th = themeById(themeId(el));
    const ids = [
      ...th.tabs.filter((t) => t.status === "open").map((t) => t.id),
      ...S.board.snoozed_tabs.filter((t) => t.theme === th.name).map((t) => t.id),
    ];
    if (!ids.length) return;
    removeTabs(ids, `the theme “${th.name}” (${ids.length} tab${ids.length === 1 ? "" : "s"})`)
      .catch((e) => toast(`Remove failed: ${e.message}`));
  },
  "accept-merge": (el) => {
    const into = S.board.themes.find((t) => t.name === el.closest(".merge-hint").dataset.into);
    if (into) act(() => api("POST", `/api/themes/${themeId(el)}/merge`, { into: into.id }));
  },
  "dismiss-merge": (el) => act(() => api("POST", "/api/merge-suggestions/dismiss", {
    from: themeById(themeId(el)).name, into: el.closest(".merge-hint").dataset.into,
  })),
  export: async () => {
    const text = await api("GET", "/api/export.md");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
    a.download = `tab-triage-${fileStamp(Date.now())}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  },
  "toggle-settings": () => {
    const panel = $("settings");
    if (panel.hidden && S.state) renderSettings();
    panel.hidden = !panel.hidden;
  },
  "save-settings": async () => {
    const values = { model: $("set-model").value, keep_open: lines("set-keep"), never_read: lines("set-never") };
    for (const input of $("settings").querySelectorAll("[data-setting]")) {
      values[input.dataset.setting] = input.type === "number" ? Number(input.value) : input.value;
    }
    try {
      await api("PATCH", "/api/settings", values);
    } catch (e) {
      // The server names the field and its limits, e.g. "open_tabs_max must be a whole number from 1 to 12".
      let why = /"error": "([^"]+)"/.exec(e.message)?.[1] ?? e.message;
      const label = $("settings").querySelector(`label[for="set-${why.split(" ")[0]}"]`)?.textContent;
      if (label) why = why.replace(why.split(" ")[0], label.replace(/ \(.*\)$/, "")); // label, not key
      toast(`Not saved: ${why}`);
      return;
    }
    await chrome.runtime.sendMessage({ type: "settingsChanged" }).catch(() => {}); // re-time the alarms
    $("settings").hidden = true;
    toast("Settings saved.");
    await refresh();
  },
};

const tabId = (el) => Number(el.closest("[data-tab-id]").dataset.tabId);
const themeId = (el) => Number(el.closest("[data-theme-id]").dataset.themeId);

document.addEventListener("click", (e) => {
  if (!$("popover").hidden && !e.target.closest("#popover")) closePopover();
  const view = e.target.closest("[data-view]");
  if (view) {
    S.view = view.dataset.view;
    saveView(S.view);
    render();
    return;
  }
  const el = e.target.closest("[data-action]");
  if (el && actions[el.dataset.action]) {
    actions[el.dataset.action](el, e);
    return;
  }
  // Clicking a tab row's empty space (not its title, tick box or tools) toggles selection;
  // shift-click selects every visible row between the last clicked row and this one.
  const row = e.target.closest(".tab[data-tab-id]");
  if (row && !e.target.closest("a, button, input")) {
    const id = Number(row.dataset.tabId);
    if (e.shiftKey) {
      const visible = [...document.querySelectorAll(".tab[data-tab-id]")].map((r) => Number(r.dataset.tabId));
      for (const k of rangeIds(visible, S.anchor, id)) S.selected.add(k);
    } else {
      S.selected.has(id) ? S.selected.delete(id) : S.selected.add(id);
    }
    S.anchor = id;
    for (const r of document.querySelectorAll(".tab[data-tab-id]")) {
      r.classList.toggle("selected", S.selected.has(Number(r.dataset.tabId)));
    }
    renderBulkBar();
  }
});
// Shift-clicking rows would otherwise also highlight page text.
document.addEventListener("mousedown", (e) => {
  if (e.shiftKey && e.target.closest(".tab[data-tab-id]") && !e.target.closest("a, button, input")) e.preventDefault();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closePopover();
    clearSelection();
  }
});

// --- multi-select bulk bar --------------------------------------------------------------

function clearSelection() {
  S.selected.clear();
  S.anchor = null;
  for (const r of document.querySelectorAll(".tab.selected")) r.classList.remove("selected");
  renderBulkBar();
}

function renderBulkBar() {
  const bar = $("bulkbar");
  const n = S.selected.size;
  bar.hidden = n === 0;
  document.body.classList.toggle("bulk-on", n > 0);
  if (!n) return;
  bar.innerHTML = `
    <span class="bulk-count">${n} selected</span>
    <button class="btn small" data-bulk="check">Done</button>
    <button class="btn small ghost" data-bulk="move">Move to…</button>
    <button class="btn small ghost" data-bulk="snooze">Snooze</button>
    <button class="btn small ghost danger" data-bulk="remove">Remove</button>
    <button class="tool" data-bulk="clear">Clear</button>`;
}

async function bulk(action, extra = {}) {
  const ids = [...S.selected];
  clearSelection();
  await act(() => api("POST", "/api/tabs/bulk", { ids, action, ...extra }));
}

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-bulk]");
  if (!b) return;
  const n = S.selected.size;
  const kind = b.dataset.bulk;
  if (kind === "clear") clearSelection();
  else if (kind === "check") {
    bulk("check");
    toast(`Marked ${n} tabs done. They stay in Completed for ${S.state.settings.done_retention_days} days.`);
  } else if (kind === "snooze") snoozeMenu(b, (until) => bulk("snooze", { until }));
  else if (kind === "remove") {
    const ids = [...S.selected];
    clearSelection();
    removeTabs(ids).catch((e) => toast(`Remove failed: ${e.message}`));
  } else if (kind === "move") {
    themePicker(b, { allowNew: true }, (t) => {
      bulk("move", { theme: t.name });
      toast(`Moved ${n} tab${n === 1 ? "" : "s"} to “${t.name}”.`);
    });
  }
});

// --- drag and drop ---------------------------------------------------------------------

const line = document.createElement("li");
line.className = "drop-line";

function dropTarget(e) {
  if (S.drag?.type === "tab") {
    const laterRow = e.target.closest(".later-row");
    if (laterRow) return { laterRow };
    const list = e.target.closest(".theme")?.querySelector("ul.tabs:not(.done-list)");
    if (!list) return null;
    const rows = [...list.querySelectorAll(":scope > .tab")].filter((r) => Number(r.dataset.tabId) !== S.drag.id);
    return { list, rows };
  }
  if (S.drag?.type === "theme") {
    // Letting go on a section label counts too: it lands at the top of that section.
    const label = e.target.closest("[data-zone]"); // a section label, or the fixed "make it #1" bar
    const list = label ? $(label.dataset.zone) : e.target.closest(".theme-list");
    if (!list) return null;
    const rows = [...list.querySelectorAll(":scope > .theme")].filter((r) => Number(r.dataset.themeId) !== S.drag.id);
    return { list, rows, index: label ? 0 : null };
  }
  return null;
}

document.addEventListener("dragstart", (e) => {
  const handle = e.target.closest?.("[data-drag=theme]");
  const row = e.target.closest?.(".tab[draggable=true]");
  if (handle) {
    const card = handle.closest(".theme");
    S.drag = { type: "theme", id: Number(card.dataset.themeId), el: card };
    const chip = document.createElement("div");
    chip.className = "drag-chip";
    chip.textContent = card.dataset.themeName;
    document.body.appendChild(chip);
    e.dataTransfer.setDragImage(chip, 14, 14);
    S.drag.chip = chip;
    // Collapse cards to their headers so the whole list fits on screen. Deferred: changing the
    // layout inside dragstart itself makes Chrome cancel the drag.
    setTimeout(() => {
      const before = card.getBoundingClientRect().top;
      document.body.classList.add("reordering");
      window.scrollBy(0, card.getBoundingClientRect().top - before); // keep it under the cursor
    }, 0);
  } else if (row) {
    S.drag = { type: "tab", id: Number(row.dataset.tabId), el: row };
  } else {
    return;
  }
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", String(S.drag.id));
  requestAnimationFrame(() => S.drag?.el.classList.add("dragging"));
});

function edgeScrollLoop() {
  if (!S.drag) return;
  if (S.drag.speed) window.scrollBy(0, S.drag.speed);
  requestAnimationFrame(edgeScrollLoop);
}

document.addEventListener("dragover", (e) => {
  if (S.drag) {
    S.drag.speed = edgeScrollSpeed(e.clientY, innerHeight);
    if (!S.drag.scrolling) {
      S.drag.scrolling = true;
      requestAnimationFrame(edgeScrollLoop);
    }
  }
  const target = dropTarget(e);
  for (const r of document.querySelectorAll(".later-row.drop-hover")) r.classList.remove("drop-hover");
  if (S.drag) S.drag.laterId = null;
  if (!target) return;
  e.preventDefault();
  if (target.laterRow) {
    line.remove();
    target.laterRow.classList.add("drop-hover");
    S.drag.list = null;
    S.drag.laterId = Number(target.laterRow.closest("[data-theme-id]").dataset.themeId);
    return;
  }
  const i = target.index ?? dropIndex(target.rows.map((r) => { const b = r.getBoundingClientRect(); return b.top + b.height / 2; }), e.clientY);
  S.drag.index = i;
  S.drag.list = target.list;
  const before = target.rows[i];
  before ? target.list.insertBefore(line, before) : target.list.appendChild(line);
});

document.addEventListener("drop", (e) => {
  const d = S.drag;
  if (d?.type === "tab" && d.laterId != null) {
    e.preventDefault();
    const dest = S.board.later_themes.find((t) => t.id === d.laterId);
    if (dest) {
      act(() => api("POST", `/api/tabs/${d.id}/move`, { theme: dest.name, index: 0 }));
      toast(`Moved to “${dest.name}” (in Later).`);
    }
    return;
  }
  if (!d?.list) return;
  e.preventDefault();
  line.remove();
  if (d.type === "tab") {
    const dest = d.list.dataset.themeName;
    const src = d.el.closest("ul.tabs").dataset.themeName;
    act(() => api("POST", `/api/tabs/${d.id}/move`, { theme: dest === src ? null : dest, index: d.index }));
  } else {
    const all = [...S.board.themes, ...S.board.snoozed_themes, ...S.board.later_themes];
    const visibleRanked = S.board.themes.filter((t) => t.ranked).map((t) => t.id);
    const ids = rankedOrder(all, visibleRanked, d.id, d.index, d.list.id === "ranked");
    act(() => api("POST", "/api/themes/reorder", { ids })).then(() => {
      document.querySelector(`.theme[data-theme-id="${d.id}"]`)?.scrollIntoView({ block: "start" });
      window.scrollBy(0, -16); // a little air above the card's header
    });
  }
});

document.addEventListener("dragend", () => {
  line.remove();
  document.body.classList.remove("reordering");
  S.drag?.chip?.remove();
  S.drag?.el.classList.remove("dragging");
  S.drag = null;
});

// --- boot ---------------------------------------------------------------------------------

chrome.storage.onChanged.addListener((changes) => {
  if (changes.lastSweep || changes.lastMemory) refresh();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
});
refresh();
