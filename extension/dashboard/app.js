// Tab Triage dashboard. Server data in, DOM out; every action is an API call followed by a refresh.

import { api } from "../lib/api.js";
import { snoozePresets, ago, dayLabel } from "../lib/time.js";
import { dropIndex, rankedOrder } from "../lib/dnd.js";
import { markSeen } from "../lib/seen.js";
import { isLoaded } from "../lib/rules.js";

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
  windows: 0,
  lastSweep: null,
  offline: false,
  expandedDone: new Set(),
  selected: new Set(),
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
      lastSweep: local.lastSweep ?? null, offline: false,
      windows: wins.filter((w) => !w.incognito).length,
    });
  } catch (e) {
    console.error(e);
    S.offline = true;
  }
  render();
  if (before) flip(before);
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
  const views = { themes: renderThemes, snoozed: renderSnoozed, completed: renderCompleted };
  $("main").innerHTML = (views[S.view] || renderThemes)();
  const present = new Set([...document.querySelectorAll("[data-tab-id]")].map((r) => Number(r.dataset.tabId)));
  for (const id of S.selected) if (!present.has(id)) S.selected.delete(id);
  renderBulkBar();
}

function renderDateline() {
  const parts = [new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })];
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
  const { chrome_bytes: used, cap_bytes: cap } = S.memory;
  const soft = 1024 ** 3;
  const memCls = used > cap ? "over" : used > soft ? "warn" : "";
  const pct = Math.min(100, (used / cap) * 100);
  const tabPct = Math.min(100, (S.liveTabs / LIVE_TAB_BUDGET) * 100);
  const mode = modeInfo();
  $("instruments").innerHTML = `
    <div class="gauge">
      <div class="label"><span>Mode</span></div>
      <div class="value"><span class="pill ${mode.cls}">${esc(mode.label)}</span></div>
    </div>
    <div class="gauge" title="Sum of all Chrome processes (RSS). Soft target 1 GB, cap ${gb(cap)} GB.">
      <div class="label"><span>Chrome memory</span><span>cap ${+(cap / 1024 ** 3).toFixed(2)} GB</span></div>
      <div class="value">${gb(used)} GB</div>
      <div class="meter ${memCls}"><i style="width:${pct}%"></i><span class="tick" style="left:${(soft / cap) * 100}%"></span></div>
    </div>
    <div class="gauge" title="Loaded tabs across all windows">
      <div class="label"><span>Live tabs</span><span>budget ${LIVE_TAB_BUDGET}</span></div>
      <div class="value">${S.liveTabs}</div>
      <div class="meter ${S.liveTabs > LIVE_TAB_BUDGET ? "over" : ""}"><i style="width:${tabPct}%"></i></div>
    </div>
    <div class="gauge" title="Normal Chrome windows. Tidy windows gathers tabs into a work window and an inbox window.">
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
  const counts = S.offline ? {} : {
    themes: S.board.themes.length,
    snoozed: S.board.snoozed_tabs.length + S.board.snoozed_themes.length,
    completed: S.completed.length,
  };
  for (const b of $("views").querySelectorAll("button")) {
    const v = b.dataset.view;
    b.setAttribute("aria-current", v === S.view ? "page" : "false");
    b.innerHTML = `${esc(v[0].toUpperCase() + v.slice(1))}${counts[v] != null ? `<span class="count">${counts[v]}</span>` : ""}`;
  }
}

function tabRow(t, { theme = null, done = false } = {}) {
  const sub = [esc(t.domain), done ? `done ${hhmm(t.completed_at)}` : `saved ${ago(t.captured_at, Date.now())}`];
  if (theme) sub.unshift(`<span class="theme-chip">${esc(theme)}</span>`);
  if (t.pending_close) sub.push(`<span class="open-dot">● still open in Chrome</span>`);
  if (t.snoozed_until) sub.push(`wakes ${dayLabel(t.snoozed_until, Date.now())} ${hhmm(t.snoozed_until)}`);
  const tools = t.snoozed_until
    ? `<button class="tool" data-action="wake-tab">Wake now</button>`
    : done ? "" : `<button class="tool" data-action="snooze-tab">Snooze</button>`;
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
      <div class="rank" draggable="true" data-drag="theme" title="Drag to reprioritize">
        <b>${th.ranked ? String(i + 1).padStart(2, "0") : "—"}</b><span class="grip">⋮⋮</span>
      </div>
      <div class="theme-body">
        <div class="theme-head">
          <h2 class="theme-name" data-action="rename" title="Click to rename">${esc(th.name)}</h2>
          ${badges}
          <span class="theme-meta">${open.length} open${done.length ? ` · ${done.length} done` : ""}</span>
          <div class="theme-tools">
            <button class="tool" data-action="open-theme">Open ${Math.min(6, open.length)}</button>
            <button class="tool" data-action="snooze-theme">Snooze</button>
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
  if (!themes.length) {
    return `<div class="empty-state"><b>Nothing here yet</b>${
      S.state.mode === "first-run" ? "Run the first sweep to sort your open tabs into themes." : "The 19:00 sweep will file stale tabs here."
    }</div>`;
  }
  const ranked = themes.filter((t) => t.ranked);
  const unranked = themes.filter((t) => !t.ranked);
  return `
    <div class="zone-label">Your priorities</div>
    <ol class="theme-list ${ranked.length ? "" : "empty"}" id="ranked">${ranked.map(themeCard).join("")}</ol>
    ${unranked.length ? `
      <div class="zone-label">Unranked · drag up to prioritize</div>
      <ol class="theme-list" id="unranked">${unranked.map((t, i) => themeCard(t, i)).join("")}</ol>` : ""}
    ${S.board.pending_sort ? `<p class="footnote">${S.board.pending_sort} tabs waiting to be sorted.</p>` : ""}`;
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
    return `<div class="empty-state"><b>Nothing completed yet</b>Tick a tab when you're done with it. It stays here for 45 days.</div>`;
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
    <p class="footnote">Completed tabs are deleted 45 days after you tick them. Untick to bring one back.</p>
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
function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
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
  pop.style.top = `${Math.min(r.bottom + 6, innerHeight - pop.offsetHeight - 10)}px`;
  pop.style.left = `${Math.max(10, Math.min(r.right - w, innerWidth - w - 10))}px`;
  pop.onclick = (e) => {
    const b = e.target.closest("[data-choice]");
    if (!b) return;
    const value = b.dataset.choice === "date" ? pop.querySelector("input[type=date]").value : b.dataset.choice;
    if (b.dataset.choice === "date" && !value) return;
    closePopover();
    onClick(value);
  };
}

function snoozeMenu(anchor, apply) {
  const p = snoozePresets(Date.now());
  const fmt = (ms) => `${dayLabel(ms / 1000, Date.now())} 08:00`;
  const tomorrow = new Date(Date.now() + DAY_S * 1000).toISOString().slice(0, 10);
  popover(anchor, `
    <button data-choice="${p.tomorrow}">Tomorrow <span class="hint">${fmt(p.tomorrow)}</span></button>
    <button data-choice="${p.nextMonday}">Next Monday <span class="hint">${fmt(p.nextMonday)}</span></button>
    <button data-choice="${p.week}">In a week <span class="hint">${fmt(p.week)}</span></button>
    <hr>
    <label>Pick a date <input type="date" min="${tomorrow}"></label>
    <button data-choice="date">Snooze until that date</button>`,
  (value) => {
    const ms = /^\d{4}-/.test(value)
      ? new Date(`${value}T08:00:00`).getTime()
      : Number(value);
    apply(ms / 1000);
  });
}

function themeById(id) {
  return S.board.themes.find((t) => t.id === id);
}

function renderSettings() {
  const s = S.state.settings;
  const models = ["sonnet", "opus", "haiku"];
  $("settings").innerHTML = `
    <h2>Settings</h2>
    <label for="set-model">Sorting model</label>
    <select id="set-model">${[...new Set([s.model, ...models])].map((m) => `<option ${m === s.model ? "selected" : ""}>${esc(m)}</option>`).join("")}</select>
    <p class="help">An alias always means the newest version. Falls back to <b>${esc(s.fallback_model)}</b> if unavailable. Runs on your Claude subscription only.</p>
    <label for="set-cap">Chrome memory cap (MB)</label>
    <input id="set-cap" type="number" min="512" step="128" value="${s.memory_cap_mb}">
    <p class="help">Above this, least-recently-used tabs are unloaded (not closed), keep-open tabs last.</p>
    <label for="set-themes">Maximum themes</label>
    <input id="set-themes" type="number" min="5" max="60" value="${s.max_themes}">
    <p class="help">New themes stop being created at this count; extra tabs go to Unsorted. Merge themes to make room.</p>
    <label for="set-keep">Keep open — never closed</label>
    <textarea id="set-keep">${esc(s.keep_open.join("\n"))}</textarea>
    <p class="help">One URL pattern per line; <code>*</code> matches anything. Pinned tabs are always kept.</p>
    <label for="set-never">Never read page text</label>
    <textarea id="set-never">${esc(s.never_read.join("\n"))}</textarea>
    <p class="help">Only the title and URL of these go to Claude. Sign-in pages are always excluded.</p>
    <div class="row">
      <button class="btn" data-action="save-settings">Save</button>
      <button class="btn ghost" data-action="toggle-settings">Close</button>
    </div>`;
}

const lines = (id) => $(id).value.split("\n").map((l) => l.trim()).filter(Boolean);

// --- actions --------------------------------------------------------------------------

async function message(type) {
  const res = await chrome.runtime.sendMessage({ type });
  if (!res?.ok) throw new Error(res?.error || "extension did not answer");
  return res.result;
}

const actions = {
  retry: () => refresh(),
  "sweep-now": async (el) => {
    el.disabled = true;
    toast("Sweeping…");
    await act(async () => {
      const r = await message("sweepNow");
      toast(r.closed
        ? `Saved and closed ${r.saved} tabs, dropped ${r.dropped}.`
        : `Saved ${r.saved} tabs${r.dropped ? `, ${r.dropped} to drop` : ""}. Nothing closed yet.`);
    });
  },
  tidy: async (el) => {
    el.disabled = true;
    await act(async () => {
      const r = await message("tidyWindows");
      toast(`Moved ${r.moved} tabs or groups — ${r.windows} window${r.windows === 1 ? "" : "s"} now${r.failed ? ` (${r.failed} couldn't move)` : ""}.`);
    });
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
  "wake-theme": (el) => act(() => api("POST", `/api/themes/${themeId(el)}/snooze`, { until: null })),
  "toggle-done": (el) => {
    const id = themeId(el);
    S.expandedDone.has(id) ? S.expandedDone.delete(id) : S.expandedDone.add(id);
    render();
  },
  "open-theme": async (el) => {
    const th = themeById(themeId(el));
    const top = th.tabs.filter((t) => t.status === "open").slice(0, 6);
    if (!top.length) return;
    await chrome.windows.create({ url: top.map((t) => t.url), focused: true });
    await markSeen(top.map((t) => t.url));
    toast(`Opened ${top.length} tabs in a new window.`);
    act(() => api("POST", "/api/opened", { ids: top.map((t) => t.id) }), { animate: false });
  },
  "drop-theme": async (el) => {
    const th = themeById(themeId(el));
    const open = th.tabs.filter((t) => t.status === "open");
    if (!confirm(`Mark all ${open.length} tabs in “${th.name}” as done? They stay in Completed for 45 days.`)) return;
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
    const others = S.board.themes.filter((t) => t.id !== id);
    const th = themeById(id);
    const open = th.tabs.filter((t) => t.status === "open").length;
    popover(el, `
      <button data-choice="rename">Rename</button>
      <button data-choice="done">Mark all done <span class="hint">kept 45 days</span></button>
      <button data-choice="dissolve">Dissolve <span class="hint">re-sort its tabs</span></button>
      <button data-choice="delete" class="danger">Delete theme <span class="hint">gone for good</span></button>
      ${others.length ? "<hr>" : ""}
      ${others.map((t) => `<button data-choice="merge:${t.id}">Merge into <span class="hint">${esc(t.name)}</span></button>`).join("")}`,
    (choice) => {
      if (choice === "rename") actions.rename(el.closest(".theme").querySelector(".theme-name"));
      else if (choice === "done") {
        act(() => api("POST", `/api/themes/${id}/done`, {}));
        toast(`Marked ${open} tabs done. Untick any of them in Completed within 45 days.`);
      } else if (choice === "dissolve") {
        if (!confirm(`Dissolve “${th.name}”? Its ${open} tabs go back to Claude to be sorted again, and Claude won't recreate this theme.`)) return;
        act(() => api("POST", `/api/themes/${id}/dissolve`, {}));
      } else if (choice === "delete") {
        if (!confirm(`Delete “${th.name}” and all ${th.tabs.length} of its tabs for good? This can't be undone. (Tabs still open in Chrome stay open.)`)) return;
        act(() => api("POST", `/api/themes/${id}/delete`, {}));
      } else act(() => api("POST", `/api/themes/${id}/merge`, { into: Number(choice.split(":")[1]) }));
    });
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
    a.download = `tab-triage-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  },
  "toggle-settings": () => {
    const panel = $("settings");
    if (panel.hidden && S.state) renderSettings();
    panel.hidden = !panel.hidden;
  },
  "save-settings": () => act(async () => {
    await api("PATCH", "/api/settings", {
      model: $("set-model").value,
      memory_cap_mb: Number($("set-cap").value) || 1536,
      max_themes: Number($("set-themes").value) || 15,
      keep_open: lines("set-keep"),
      never_read: lines("set-never"),
    });
    $("settings").hidden = true;
    toast("Settings saved.");
  }, { animate: false }),
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
  // Clicking a tab row's empty space (not its title, tick box or tools) toggles selection.
  const row = e.target.closest(".tab[data-tab-id]");
  if (row && !e.target.closest("a, button, input")) {
    const id = Number(row.dataset.tabId);
    S.selected.has(id) ? S.selected.delete(id) : S.selected.add(id);
    row.classList.toggle("selected", S.selected.has(id));
    renderBulkBar();
  }
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
    <button class="btn small ghost danger" data-bulk="delete">Delete</button>
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
    toast(`Marked ${n} tabs done. They stay in Completed for 45 days.`);
  } else if (kind === "snooze") snoozeMenu(b, (until) => bulk("snooze", { until }));
  else if (kind === "delete") {
    if (confirm(`Delete ${n} tabs for good? This can't be undone. (Tabs still open in Chrome stay open.)`)) bulk("delete");
  } else if (kind === "move") {
    popover(b, `
      ${S.board.themes.map((t) => `<button data-choice="${esc(t.name)}">${esc(t.name)}</button>`).join("")}
      <hr><button data-choice="__new">New theme…</button>`,
    (choice) => {
      const theme = choice === "__new" ? prompt("Name of the new theme:")?.trim() : choice;
      if (theme) bulk("move", { theme });
    });
  }
});

// --- drag and drop ---------------------------------------------------------------------

const line = document.createElement("li");
line.className = "drop-line";

function dropTarget(e) {
  if (S.drag?.type === "tab") {
    const list = e.target.closest(".theme")?.querySelector("ul.tabs:not(.done-list)");
    if (!list) return null;
    const rows = [...list.querySelectorAll(":scope > .tab")].filter((r) => Number(r.dataset.tabId) !== S.drag.id);
    return { list, rows };
  }
  if (S.drag?.type === "theme") {
    const list = e.target.closest(".theme-list");
    if (!list) return null;
    const rows = [...list.querySelectorAll(":scope > .theme")].filter((r) => Number(r.dataset.themeId) !== S.drag.id);
    return { list, rows };
  }
  return null;
}

document.addEventListener("dragstart", (e) => {
  const handle = e.target.closest?.("[data-drag=theme]");
  const row = e.target.closest?.(".tab[draggable=true]");
  if (handle) {
    const card = handle.closest(".theme");
    S.drag = { type: "theme", id: Number(card.dataset.themeId), el: card };
    e.dataTransfer.setDragImage(card, 30, 20);
  } else if (row) {
    S.drag = { type: "tab", id: Number(row.dataset.tabId), el: row };
  } else {
    return;
  }
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", String(S.drag.id));
  requestAnimationFrame(() => S.drag?.el.classList.add("dragging"));
});

document.addEventListener("dragover", (e) => {
  const target = dropTarget(e);
  if (!target) return;
  e.preventDefault();
  const i = dropIndex(target.rows.map((r) => { const b = r.getBoundingClientRect(); return b.top + b.height / 2; }), e.clientY);
  S.drag.index = i;
  S.drag.list = target.list;
  const before = target.rows[i];
  before ? target.list.insertBefore(line, before) : target.list.appendChild(line);
});

document.addEventListener("drop", (e) => {
  const d = S.drag;
  if (!d?.list) return;
  e.preventDefault();
  line.remove();
  if (d.type === "tab") {
    const dest = d.list.dataset.themeName;
    const src = d.el.closest("ul.tabs").dataset.themeName;
    act(() => api("POST", `/api/tabs/${d.id}/move`, { theme: dest === src ? null : dest, index: d.index }));
  } else {
    const all = [...S.board.themes, ...S.board.snoozed_themes];
    const visibleRanked = S.board.themes.filter((t) => t.ranked).map((t) => t.id);
    const ids = rankedOrder(all, visibleRanked, d.id, d.index, d.list.id === "ranked");
    act(() => api("POST", "/api/themes/reorder", { ids }));
  }
});

document.addEventListener("dragend", () => {
  line.remove();
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
