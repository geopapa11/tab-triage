import { test } from "node:test";
import assert from "node:assert/strict";
import { planTidy } from "./tidy.js";

const KEEP = ["https://mail.google.com/mail/u/*/#inbox", "https://calendar.google.com/*"];
const DASH = "chrome-extension://x/dashboard/index.html";
const win = (id, tabs, o = {}) => ({ id, type: "normal", incognito: false, focused: false, tabs, ...o });
const t = (id, url, o = {}) => ({ id, url, pinned: false, groupId: -1, ...o });

test("everything gathers into the dashboard's window; inboxes into a second window", () => {
  const windows = [
    win(1, [t(10, "https://a.com"), t(11, DASH)]),
    win(2, [t(20, "https://b.com"), t(21, "https://mail.google.com/mail/u/0/#inbox")]),
    win(3, [t(30, "https://mail.google.com/mail/u/1/#inbox"), t(31, "https://c.com")]),
    win(4, [t(40, "chrome://newtab/")]),
  ];
  assert.deepEqual(planTidy(windows, { keepOpen: KEEP, dashboardUrl: DASH }), {
    workId: 1,
    commsId: 2,
    groupMoves: [],
    tabMoves: [
      { tabId: 20, windowId: 1 },
      { tabId: 30, windowId: 2 },
      { tabId: 31, windowId: 1 },
      { tabId: 40, windowId: 1 },
    ],
  });
});

test("without the dashboard open, the focused window is the work window", () => {
  const windows = [win(1, [t(10, "https://a.com")]), win(2, [t(20, "https://b.com")], { focused: true })];
  assert.deepEqual(planTidy(windows, { keepOpen: KEEP, dashboardUrl: DASH }).tabMoves, [{ tabId: 10, windowId: 2 }]);
});

test("inboxes already in the work window stay there; no second window is needed", () => {
  const windows = [
    win(1, [t(10, DASH), t(11, "https://mail.google.com/mail/u/0/#inbox")]),
    win(2, [t(20, "https://b.com")]),
  ];
  const plan = planTidy(windows, { keepOpen: KEEP, dashboardUrl: DASH });
  assert.equal(plan.commsId, null);
  assert.deepEqual(plan.tabMoves, [{ tabId: 20, windowId: 1 }]);
});

test("tab groups move whole, and only once", () => {
  const windows = [
    win(1, [t(10, DASH)]),
    win(2, [t(20, "https://b.com", { groupId: 7 }), t(21, "https://c.com", { groupId: 7 }), t(22, "https://d.com")]),
  ];
  const plan = planTidy(windows, { keepOpen: KEEP, dashboardUrl: DASH });
  assert.deepEqual(plan.groupMoves, [{ groupId: 7, windowId: 1 }]);
  assert.deepEqual(plan.tabMoves, [{ tabId: 22, windowId: 1 }]);
});

test("incognito and non-normal windows are left alone", () => {
  const windows = [
    win(1, [t(10, DASH)]),
    win(2, [t(20, "https://secret.com")], { incognito: true }),
    win(3, [t(30, "https://popup.com")], { type: "popup" }),
  ];
  assert.deepEqual(planTidy(windows, { keepOpen: KEEP, dashboardUrl: DASH }).tabMoves, []);
});

test("an already tidy layout plans no moves", () => {
  const windows = [win(1, [t(10, DASH), t(11, "https://a.com")]), win(2, [t(20, "https://calendar.google.com/r")])];
  const plan = planTidy(windows, { keepOpen: KEEP, dashboardUrl: DASH });
  assert.deepEqual([plan.commsId, plan.tabMoves, plan.groupMoves], [2, [], []]);
});
