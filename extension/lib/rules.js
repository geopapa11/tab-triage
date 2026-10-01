// Pure decision logic for the sweep and memory guard. No chrome.* here — tested with `node --test`.
// Times are epoch milliseconds (Chrome's convention); the server gets seconds.

const DAY = 24 * 3600_000;
const HTTP = /^https?:\/\//i;
// A sign-in page has one of these as its first path segment (/login, /sso/start), or ends in a
// sign-in word (/users/sign_in). Deeper "auth" segments are usually docs (/docs/guides/auth).
const LOGIN_FIRST = new Set(["login", "signin", "sign-in", "sign_in", "oauth", "sso", "auth", "authorize"]);
const LOGIN_LAST = new Set(["login", "signin", "sign-in", "sign_in"]);
const GMAIL_THREAD_ID = /^[A-Za-z0-9]{20,}$/;

export function globToRegExp(pattern) {
  const body = pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${body}$`, "i");
}

export function matchesAny(url, patterns = []) {
  return patterns.some((p) => globToRegExp(p).test(url));
}

function parse(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function isLoginUrl(url) {
  const u = parse(url);
  if (!u || !HTTP.test(url)) return false;
  const host = u.hostname.toLowerCase();
  if (host === "accounts.google.com" || /(^|\.)(signin|login|auth|sso)\./.test(host)) return true;
  const segs = u.pathname.toLowerCase().split("/").filter(Boolean);
  return LOGIN_FIRST.has(segs[0]) || LOGIN_LAST.has(segs.at(-1));
}

export function gmailKind(url) {
  const u = parse(url);
  if (!u || u.hostname !== "mail.google.com") return null;
  const segments = u.hash.replace(/^#/, "").split("?")[0].split("/").filter(Boolean);
  if (segments.length >= 2 && GMAIL_THREAD_ID.test(segments.at(-1))) return "thread";
  if (segments[0] === "search") return "search";
  if (segments.length === 0 || (segments.length === 1 && segments[0] === "inbox")) return "inbox";
  return "other";
}

export function dropReason(url) {
  if (!HTTP.test(url)) return /^(chrome|chrome-extension|about|edge|devtools):/i.test(url) ? "internal" : null;
  const u = parse(url);
  if (!u) return null;
  const host = u.hostname.toLowerCase();
  if (/(^|\.)google\.[a-z.]+$/.test(host) && u.pathname === "/search") return "search";
  if (/(^|\.)bing\.com$/.test(host) && u.pathname === "/search") return "search";
  if (/(^|\.)duckduckgo\.com$/.test(host) && u.searchParams.has("q")) return "search";
  if (gmailKind(url) === "search") return "search";
  if (host === "meet.google.com") return "meet";
  if (isLoginUrl(url)) return "login";
  return null;
}

export function effectiveLastAccessed(tab, seen = {}) {
  const values = [tab.lastAccessed, seen[tab.url]].filter(Number.isFinite);
  return values.length ? Math.min(...values) : 0;
}

export function isKeepOpen(tab, keepOpen) {
  return matchesAny(tab.url, keepOpen) || gmailKind(tab.url) === "inbox";
}

// 2 = never touched (pinned/active/audible/busy form), 1 = keep-open (one copy stays), 0 = normal
function protection(tab, c) {
  if (tab.pinned || tab.active || tab.audible || c.busyIds.has(tab.id)) return 2;
  return isKeepOpen(tab, c.keepOpen) ? 1 : 0;
}

export function planSweep(tabs, options) {
  const c = { seen: {}, groupTitles: new Map(), busyIds: new Set(), keepOpen: [], ...options };
  const lastUse = (t) => effectiveLastAccessed(t, c.seen);
  const keeperOf = new Map();
  for (const t of tabs) {
    const best = keeperOf.get(t.url);
    const better =
      !best ||
      protection(t, c) > protection(best, c) ||
      (protection(t, c) === protection(best, c) && lastUse(t) > lastUse(best));
    if (better) keeperOf.set(t.url, t);
  }

  const candidates = [];
  const drop = [];
  for (const t of tabs) {
    const level = protection(t, c);
    if (level === 2) continue;
    if (keeperOf.get(t.url) !== t) {
      drop.push({ id: t.id, url: t.url, reason: "duplicate" });
      continue;
    }
    if (level === 1) continue;
    const used = lastUse(t);
    // Outside the first run (which you approve by hand), only stale tabs are touched — junk included.
    if (c.mode !== "first-run" && c.now - used < c.staleMs) continue;
    const reason = dropReason(t.url);
    if (reason) {
      drop.push({ id: t.id, url: t.url, reason });
      continue;
    }
    const kind = ["thread", "other"].includes(gmailKind(t.url)) ? "email" : "page";
    const candidate = { id: t.id, url: t.url, title: t.title || t.url, kind, last_accessed_at: used / 1000 };
    const group = c.groupTitles.get(t.groupId);
    if (group) candidate.group_hint = group;
    candidates.push(candidate);
  }
  return { candidates, drop };
}

export function textAllowed(url, neverRead = []) {
  return HTTP.test(url) && !matchesAny(url, neverRead) && !isLoginUrl(url);
}

// Chrome restores sessions lazily: those tabs report status "unloaded" without being discarded.
export function isLoaded(tab) {
  return !tab.discarded && tab.status !== "unloaded";
}

export function unloadOrder(tabs, { keepOpen = [], busyIds = new Set() } = {}) {
  const tier = (t) => (t.pinned || isKeepOpen(t, keepOpen) ? 1 : 0);
  return tabs
    .filter((t) => !t.active && !t.audible && isLoaded(t) && !busyIds.has(t.id) && HTTP.test(t.url))
    .sort((a, b) => tier(a) - tier(b) || (a.lastAccessed ?? 0) - (b.lastAccessed ?? 0))
    .map((t) => t.id);
}

export function memoryCheckDue(lastCheckAt, now, gapMs = 30_000) {
  return lastCheckAt == null || now - lastCheckAt >= gapMs;
}

export function nextSweepAt(now, hour) {
  const d = new Date(now);
  const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, 0, 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at.getTime();
}

export function sweepDue(lastSweepAt, now) {
  return lastSweepAt == null || now - lastSweepAt >= DAY;
}

// Final check right before closing. saved: Map(url -> ms when the server saved it);
// drops: Map(tab id -> url it had when planned). A tab used after it was saved, or a planned
// drop that has since navigated elsewhere, is left open.
export function closeSelection(tabs, saved, drops, { seen = {}, busyIds = new Set() } = {}) {
  const lastTouched = (t) => Math.max(t.lastAccessed ?? 0, seen[t.url] ?? 0);
  return tabs
    .filter((t) => !t.pinned && !t.active && !t.audible && !busyIds.has(t.id))
    .filter((t) => (saved.has(t.url) && lastTouched(t) <= saved.get(t.url)) || drops.get(t.id) === t.url)
    .map((t) => t.id);
}
