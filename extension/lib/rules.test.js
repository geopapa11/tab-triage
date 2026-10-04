import { test } from "node:test";
import assert from "node:assert/strict";
import {
  matchesAny,
  isLoginUrl,
  dropReason,
  gmailKind,
  planSweep,
  effectiveLastAccessed,
  textAllowed,
  unloadOrder,
  nextSweepAt,
  sweepDue,
  memoryCheckDue,
  closeSelection,
  isLoaded,
} from "./rules.js";

const H = 3600_000;
const D = 24 * H;
const NOW = Date.UTC(2026, 8, 30, 18, 0);
const KEEP = [
  "https://mail.google.com/mail/u/*/#inbox",
  "https://calendar.google.com/*",
  "https://linear.app/*",
];
const NEVER = ["*://mail.google.com/*", "*://docs.google.com/*", "*bank*"];

let nextId = 1;
const tab = (url, o = {}) => ({
  id: nextId++, url, title: url, pinned: false, active: false, audible: false,
  lastAccessed: NOW - 5 * D, ...o,
});
const ctx = (o = {}) => ({ now: NOW, staleMs: 96 * H, mode: "live", keepOpen: KEEP, busyIds: new Set(), ...o });
const urls = (list) => list.map((t) => t.url);

// --- matching ------------------------------------------------------------------

test("glob patterns match with * wildcards and nothing else", () => {
  assert.ok(matchesAny("https://mail.google.com/mail/u/1/#inbox", KEEP));
  assert.ok(!matchesAny("https://mail.google.com/mail/u/1/#inbox/AbCdEfGhIjKlMnOpQrStUvWxYz012345", KEEP));
  assert.ok(matchesAny("https://linear.app/acme/issue/K-1", KEEP));
  assert.ok(!matchesAny("https://notlinear.app/x", KEEP));
  assert.ok(matchesAny("https://www.examplebank.test/login", ["*bank*"]));
  assert.ok(!matchesAny("https://example.com/a.b", ["https://example.com/a?b"]));
});

test("login and sign-in pages are recognised", () => {
  for (const u of [
    "https://www.shop.test/login?g=%2Fconsole",
    "https://us-east-1.signin.aws.amazon.com/oauth?x=1",
    "https://accounts.google.com/v3/signin/identifier",
    "https://app.example.com/sso/start",
    "https://gitlab.com/users/sign_in",
  ]) assert.ok(isLoginUrl(u), u);
  for (const u of [
    "https://github.com/authors/x",
    "https://acme.test/blog/sql-tutorial",
    "https://supabase.com/docs/guides/auth",
    "https://firebase.google.com/docs/auth",
    "https://github.com/o/r/tree/main/src/auth",
  ])
    assert.ok(!isLoginUrl(u), u);
});

// --- drop rules ----------------------------------------------------------------

test("junk tabs have a drop reason", () => {
  assert.equal(dropReason("chrome://newtab/"), "internal");
  assert.equal(dropReason("chrome-extension://abc/x.html"), "internal");
  assert.equal(dropReason("https://www.google.com/search?q=best+hiking+boots"), "search");
  assert.equal(dropReason("https://mail.google.com/mail/u/0/#search/invoice"), "search");
  assert.equal(dropReason("https://meet.google.com/home?authuser=1"), "meet");
  assert.equal(dropReason("https://www.shop.test/login?g=x"), "login");
  assert.equal(dropReason("https://github.com/acme/api/pull/12"), null);
  assert.equal(dropReason("https://docs.google.com/search-tips"), null);
});

test("gmail urls are inbox, thread, or other", () => {
  assert.equal(gmailKind("https://mail.google.com/mail/u/1/#inbox"), "inbox");
  assert.equal(gmailKind("https://mail.google.com/mail/u/1/#inbox/AbCdEfGhIjKlMnOpQrStUvWxYz012345"), "thread");
  assert.equal(gmailKind("https://mail.google.com/mail/u/1/#search/invoice/AbCdEfGhIjKlMnOpQrStUvWxYz012345"), "thread");
  assert.equal(gmailKind("https://mail.google.com/mail/u/1/#search/report/ZyXwVuTsRqPoNmLkJiHgFeDcBa987654?projector=1"), "thread");
  assert.equal(gmailKind("https://mail.google.com/mail/u/1/#label/Receipts"), "other");
  assert.equal(gmailKind("https://github.com"), null);
});

// --- planSweep -------------------------------------------------------------------

test("only tabs untouched for 96h are swept in live mode", () => {
  const fresh = tab("https://a.com", { lastAccessed: NOW - 95 * H });
  const stale = tab("https://b.com", { lastAccessed: NOW - 97 * H });
  const plan = planSweep([fresh, stale], ctx());
  assert.deepEqual(urls(plan.candidates), ["https://b.com"]);
  assert.deepEqual(plan.drop, []);
});

test("first run sweeps every unprotected tab regardless of age", () => {
  const fresh = tab("https://a.com", { lastAccessed: NOW - H });
  const plan = planSweep([fresh], ctx({ mode: "first-run" }));
  assert.deepEqual(urls(plan.candidates), ["https://a.com"]);
});

test("protected tabs are never swept or dropped", () => {
  const tabs = [
    tab("https://a.com", { pinned: true }),
    tab("https://b.com", { active: true }),
    tab("https://youtube.com/watch?v=1", { audible: true }),
    tab("https://calendar.google.com/r", {}),
    tab("https://form.com", {}),
    tab("https://meet.google.com/home", { pinned: true }),
  ];
  const busy = new Set([tabs[4].id]);
  const plan = planSweep(tabs, ctx({ mode: "first-run", busyIds: busy }));
  assert.deepEqual(plan.candidates, []);
  assert.deepEqual(plan.drop, []);
});

test("stale junk is dropped not saved", () => {
  const t = tab("https://www.google.com/search?q=x");
  const plan = planSweep([t], ctx());
  assert.deepEqual(plan.candidates, []);
  assert.deepEqual(plan.drop, [{ id: t.id, url: t.url, reason: "search" }]);
});

test("recently used junk is left alone outside the first run", () => {
  const search = tab("https://www.google.com/search?q=x", { lastAccessed: NOW - H });
  const meet = tab("https://meet.google.com/abc-defg-hij", { lastAccessed: NOW - H });
  const login = tab("https://www.shop.test/login", { lastAccessed: NOW - H });
  for (const mode of ["live", "dry-run"]) {
    const plan = planSweep([search, meet, login], ctx({ mode }));
    assert.deepEqual([plan.drop, plan.candidates], [[], []], mode);
  }
  assert.equal(planSweep([search, meet, login], ctx({ mode: "first-run" })).drop.length, 3);
});

test("fresh duplicates are still dropped (the most recent copy stays)", () => {
  const a = tab("https://x.com/doc", { lastAccessed: NOW - 2 * H });
  const b = tab("https://x.com/doc", { lastAccessed: NOW - H });
  assert.deepEqual(planSweep([a, b], ctx()).drop.map((d) => d.id), [a.id]);
});

test("a duplicate holding a half-written form is kept and the other copy dropped", () => {
  const draft = tab("https://github.com/o/r/issues/new", { lastAccessed: NOW - 3 * D });
  const fresh = tab("https://github.com/o/r/issues/new", { lastAccessed: NOW - H });
  const plan = planSweep([draft, fresh], ctx({ busyIds: new Set([draft.id]) }));
  assert.deepEqual(plan.drop.map((d) => d.id), [fresh.id]);
});

test("duplicates keep the most recently used copy", () => {
  const old = tab("https://mail.google.com/mail/u/0/#inbox", { lastAccessed: NOW - 3 * D });
  const recent = tab("https://mail.google.com/mail/u/0/#inbox", { lastAccessed: NOW - D });
  const plan = planSweep([old, recent], ctx());
  assert.deepEqual(plan.drop, [{ id: old.id, url: old.url, reason: "duplicate" }]);
  assert.deepEqual(plan.candidates, []);
});

test("duplicates prefer the protected copy and never drop a protected one", () => {
  const pinned = tab("https://x.com/doc", { pinned: true, lastAccessed: NOW - 9 * D });
  const loose = tab("https://x.com/doc", { lastAccessed: NOW - D });
  const plan = planSweep([pinned, loose], ctx());
  assert.deepEqual(plan.drop.map((d) => d.id), [loose.id]);
});

test("gmail threads are swept as email, inbox stays", () => {
  const thread = tab("https://mail.google.com/mail/u/1/#inbox/AbCdEfGhIjKlMnOpQrStUvWxYz012345");
  const inbox = tab("https://mail.google.com/mail/u/1/#inbox");
  const plan = planSweep([thread, inbox], ctx());
  assert.deepEqual(plan.candidates.map((c) => [c.url, c.kind]), [[thread.url, "email"]]);
});

test("candidates carry tab group titles as hints", () => {
  const t = tab("https://a.com", { groupId: 7 });
  const plan = planSweep([t], ctx({ groupTitles: new Map([[7, "Travel planning"]]) }));
  assert.equal(plan.candidates[0].group_hint, "Travel planning");
});

// --- last access ------------------------------------------------------------------

test("restored tabs use our older activation record", () => {
  const t = tab("https://a.com", { lastAccessed: NOW - H });
  assert.equal(effectiveLastAccessed(t, { "https://a.com": NOW - 6 * D }), NOW - 6 * D);
  assert.equal(effectiveLastAccessed(t, {}), NOW - H);
  assert.equal(effectiveLastAccessed({ ...t, lastAccessed: undefined }, {}), 0);
});

test("planSweep uses the activation record", () => {
  const t = tab("https://a.com", { lastAccessed: NOW - H });
  const plan = planSweep([t], ctx({ seen: { "https://a.com": NOW - 6 * D } }));
  assert.deepEqual(urls(plan.candidates), ["https://a.com"]);
});

// --- page text --------------------------------------------------------------------

test("page text is never read on sensitive or login pages", () => {
  assert.ok(textAllowed("https://github.com/x", NEVER));
  assert.ok(!textAllowed("https://mail.google.com/mail/u/0/#inbox/abc", NEVER));
  assert.ok(!textAllowed("https://docs.google.com/document/d/1", NEVER));
  assert.ok(!textAllowed("https://online.mybank.test/", NEVER));
  assert.ok(!textAllowed("https://www.shop.test/login", NEVER));
  assert.ok(!textAllowed("chrome://settings", NEVER));
});

// --- memory guard -------------------------------------------------------------------

test("unload order: ordinary tabs LRU first, keep-open and pinned last, never active/audible/busy", () => {
  const a = tab("https://a.com", { lastAccessed: NOW - 1 * H });
  const b = tab("https://b.com", { lastAccessed: NOW - 3 * H });
  const gmail = tab("https://mail.google.com/mail/u/0/#inbox", { lastAccessed: NOW - 9 * H });
  const pinned = tab("https://p.com", { pinned: true, lastAccessed: NOW - 2 * H });
  const active = tab("https://act.com", { active: true, lastAccessed: NOW - 9 * D });
  const music = tab("https://yt.com", { audible: true, lastAccessed: NOW - 9 * D });
  const busy = tab("https://form.com", { lastAccessed: NOW - 9 * D });
  const gone = tab("https://gone.com", { discarded: true, lastAccessed: NOW - 9 * D });
  const order = unloadOrder([a, b, gmail, pinned, active, music, busy, gone], {
    keepOpen: KEEP, busyIds: new Set([busy.id]),
  });
  assert.deepEqual(order, [b.id, a.id, gmail.id, pinned.id]);
});

test("memory checks are debounced to once per 30s", () => {
  assert.ok(memoryCheckDue(null, NOW));
  assert.ok(!memoryCheckDue(NOW - 29_000, NOW));
  assert.ok(memoryCheckDue(NOW - 30_000, NOW));
});

// --- scheduling -----------------------------------------------------------------------

test("next sweep is today 19:00 local if not passed, else tomorrow", () => {
  const morning = new Date(2026, 8, 30, 9, 0).getTime();
  assert.equal(nextSweepAt(morning, "19:00"), new Date(2026, 8, 30, 19, 0).getTime());
  const evening = new Date(2026, 8, 30, 19, 30).getTime();
  assert.equal(nextSweepAt(evening, "19:00"), new Date(2026, 9, 1, 19, 0).getTime());
  assert.equal(nextSweepAt(morning, "07:30"), new Date(2026, 9, 1, 7, 30).getTime());
  assert.equal(nextSweepAt(morning, "09:45"), new Date(2026, 8, 30, 9, 45).getTime());
});

test("a sweep is due on startup if none ran in the last 24h", () => {
  assert.ok(sweepDue(null, NOW));
  assert.ok(sweepDue(NOW - 25 * H, NOW));
  assert.ok(!sweepDue(NOW - 23 * H, NOW));
});

// --- approval close ---------------------------------------------------------------------

const CAPTURED = NOW - D; // when the server saved the URL

test("closing takes every copy of a saved url plus planned drops, never pinned/active/audible/busy", () => {
  const saved1 = tab("https://a.com", { lastAccessed: NOW - 5 * D });
  const saved2 = tab("https://a.com", { lastAccessed: NOW - 6 * D });
  const junk = tab("https://www.google.com/search?q=x");
  const pinnedSaved = tab("https://b.com", { pinned: true });
  const activeJunk = tab("chrome://newtab/", { active: true });
  const busySaved = tab("https://form.com");
  const unrelated = tab("https://c.com");
  const saved = new Map([["https://a.com", CAPTURED], ["https://b.com", CAPTURED], ["https://form.com", CAPTURED]]);
  const drops = new Map([[junk.id, junk.url], [activeJunk.id, activeJunk.url]]);
  const ids = closeSelection([saved1, saved2, junk, pinnedSaved, activeJunk, busySaved, unrelated], saved, drops,
    { busyIds: new Set([busySaved.id]) });
  assert.deepEqual(ids, [saved1.id, saved2.id, junk.id]);
});

test("a saved tab used after it was saved is not closed", () => {
  const reopened = tab("https://a.com", { lastAccessed: CAPTURED + H });
  const seenLater = tab("https://b.com", { lastAccessed: NOW - 5 * D });
  const saved = new Map([["https://a.com", CAPTURED], ["https://b.com", CAPTURED]]);
  const ids = closeSelection([reopened, seenLater], saved, new Map(), { seen: { "https://b.com": CAPTURED + H } });
  assert.deepEqual(ids, []);
});

test("a planned drop that navigated elsewhere is not closed", () => {
  const moved = tab("https://github.com/o/r/issues/new");
  const ids = closeSelection([moved], new Map(), new Map([[moved.id, "https://www.google.com/search?q=x"]]));
  assert.deepEqual(ids, []);
});

test("tabs restored but never loaded don't count as loaded or as unload targets", () => {
  const live = tab("https://a.com");
  const discarded = tab("https://b.com", { discarded: true });
  const neverLoaded = tab("https://c.com", { status: "unloaded" });
  assert.deepEqual([live, discarded, neverLoaded].map(isLoaded), [true, false, false]);
  assert.deepEqual(unloadOrder([live, discarded, neverLoaded]), [live.id]);
});

// --- manual sweep ignores age ---------------------------------------------------------

test("a manual sweep takes fresh tabs and fresh junk, but still never protected ones", () => {
  const fresh = tab("https://a.com", { lastAccessed: NOW - H });
  const freshSearch = tab("https://www.google.com/search?q=x", { lastAccessed: NOW - H });
  const pinned = tab("https://p.com", { pinned: true, lastAccessed: NOW - H });
  const active = tab("https://act.com", { active: true });
  const inbox = tab("https://mail.google.com/mail/u/0/#inbox");
  const plan = planSweep([fresh, freshSearch, pinned, active, inbox], ctx({ ignoreAge: true }));
  assert.deepEqual(urls(plan.candidates), ["https://a.com"]);
  assert.deepEqual(plan.drop.map((d) => d.id), [freshSearch.id]);
});

test("without ignoreAge the same fresh tabs are left alone", () => {
  const fresh = tab("https://a.com", { lastAccessed: NOW - H });
  assert.deepEqual(planSweep([fresh], ctx()).candidates, []);
});

// --- memory guard never unloads what you were just using --------------------------------

test("tabs used in the last day are never unloaded", () => {
  const justLeft = tab("https://a.com", { lastAccessed: NOW - 2 * D });   // activated 2 days ago, left 1 min ago
  const thisMorning = tab("https://b.com", { lastAccessed: NOW - 10 * H });
  const twoDaysIdle = tab("https://c.com", { lastAccessed: NOW - 2 * D });
  const order = unloadOrder([justLeft, thisMorning, twoDaysIdle], {
    now: NOW, lastActive: { [justLeft.id]: NOW - 60_000 },
  });
  assert.deepEqual(order, [twoDaysIdle.id]);
});

test("a tab becomes unloadable again once it has been idle for a day", () => {
  const t = tab("https://a.com", { lastAccessed: NOW - 3 * D });
  assert.deepEqual(unloadOrder([t], { now: NOW, lastActive: { [t.id]: NOW - 23 * H } }), []);
  assert.deepEqual(unloadOrder([t], { now: NOW, lastActive: { [t.id]: NOW - 25 * H } }), [t.id]);
});
