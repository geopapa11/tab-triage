import { test } from "node:test";
import assert from "node:assert/strict";
import { planTidy } from "./tidy.js";

const KEEP = ["https://mail.google.com/mail/u/*/#inbox", "https://calendar.google.com/*"];
const DASH = "chrome-extension://x/dashboard/index.html";
const win = (id, tabs, o = {}) => ({ id, type: "normal", incognito: false, focused: false, tabs, ...o });
const t = (id, url, o = {}) => ({ id, url, pinned: false, groupId: -1, ...o });
const plan = (windows) => planTidy(windows, { keepOpen: KEEP, dashboardUrl: DASH });

test("two windows or fewer are left exactly as they are", () => {
  const windows = [win(1, [t(10, DASH)]), win(2, [t(20, "https://b.com"), t(21, "https://c.com")])];
  assert.deepEqual(plan(windows), { workId: 1, secondId: null, groupMoves: [], tabMoves: [] });
});

test("extra windows fold into the two that stay; inboxes go to the second one", () => {
  const windows = [
    win(1, [t(10, "https://a.com"), t(11, DASH)]),
    win(2, [t(20, "https://b.com"), t(21, "https://mail.google.com/mail/u/0/#inbox")]),
    win(3, [t(30, "https://mail.google.com/mail/u/1/#inbox"), t(31, "https://c.com")]),
    win(4, [t(40, "chrome://newtab/")]),
  ];
  assert.deepEqual(plan(windows), {
    workId: 1,
    secondId: 2,
    groupMoves: [],
    tabMoves: [
      { tabId: 30, windowId: 2 },
      { tabId: 31, windowId: 1 },
      { tabId: 40, windowId: 1 },
    ],
  });
});

test("tabs already in a window that stays never move", () => {
  const windows = [
    win(1, [t(10, DASH), t(11, "https://mail.google.com/mail/u/0/#inbox")]),
    win(2, [t(20, "https://b.com")]),
    win(3, [t(30, "https://c.com")]),
  ];
  const p = plan(windows);
  assert.equal(p.secondId, 2);
  assert.deepEqual(p.tabMoves, [{ tabId: 30, windowId: 1 }]);
});

test("without inboxes elsewhere, the largest other window is the one that stays", () => {
  const windows = [
    win(1, [t(10, DASH)]),
    win(2, [t(20, "https://b.com")]),
    win(3, [t(30, "https://c.com"), t(31, "https://d.com"), t(32, "https://e.com")]),
  ];
  const p = plan(windows);
  assert.equal(p.secondId, 3);
  assert.deepEqual(p.tabMoves, [{ tabId: 20, windowId: 1 }]);
});

test("without the dashboard open, the focused window is the work window", () => {
  const windows = [win(1, [t(10, "https://a.com")]), win(2, [t(20, "https://b.com")], { focused: true }),
    win(3, [t(30, "https://c.com"), t(31, "https://d.com")])];
  const p = plan(windows);
  assert.deepEqual([p.workId, p.secondId], [2, 3]);
  assert.deepEqual(p.tabMoves, [{ tabId: 10, windowId: 2 }]);
});

test("tab groups move whole, and only once", () => {
  const windows = [
    win(1, [t(10, DASH)]),
    win(2, [t(20, "https://x.com"), t(21, "https://y.com"), t(22, "https://z.com")]),
    win(3, [t(30, "https://b.com", { groupId: 7 }), t(31, "https://c.com", { groupId: 7 })]),
  ];
  const p = plan(windows);
  assert.deepEqual(p.groupMoves, [{ groupId: 7, windowId: 1 }]);
  assert.deepEqual(p.tabMoves, []);
});

test("incognito and non-normal windows are left alone and don't count", () => {
  const windows = [
    win(1, [t(10, DASH)]),
    win(2, [t(20, "https://secret.com")], { incognito: true }),
    win(3, [t(30, "https://popup.com")], { type: "popup" }),
    win(4, [t(40, "https://b.com")]),
  ];
  assert.deepEqual(plan(windows).tabMoves, []);
});
