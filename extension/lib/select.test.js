import { test } from "node:test";
import assert from "node:assert/strict";
import { rangeIds, pickerThemes, filterThemes, openTabRows } from "./select.js";

const rows = [11, 12, 13, 14, 15];

test("shift-click selects everything between the anchor and the clicked row", () => {
  assert.deepEqual(rangeIds(rows, 12, 14), [12, 13, 14]);
});

test("works upward too", () => {
  assert.deepEqual(rangeIds(rows, 15, 13), [13, 14, 15]);
});

test("without a visible anchor only the clicked row is selected", () => {
  assert.deepEqual(rangeIds(rows, null, 13), [13]);
  assert.deepEqual(rangeIds(rows, 99, 13), [13]);
});

// pickerThemes: every theme a tab can be moved to / a theme merged into, wherever it sits.
const board = {
  themes: [{ id: 1, name: "Team PRs" }, { id: 2, name: "Unsorted" }],
  later_themes: [{ id: 3, name: "Home repairs" }],
  snoozed_themes: [{ id: 4, name: "Taxes" }],
};

test("the picker lists visible, Later and snoozed themes, labelled", () => {
  assert.deepEqual(pickerThemes(board), [
    { id: 1, name: "Team PRs", note: "" },
    { id: 2, name: "Unsorted", note: "" },
    { id: 3, name: "Home repairs", note: "Later" },
    { id: 4, name: "Taxes", note: "Snoozed" },
  ]);
});

test("the picker can leave one theme out (you can't merge a theme into itself)", () => {
  assert.deepEqual(pickerThemes(board, 3).map((t) => t.id), [1, 2, 4]);
});

test("filtering the picker matches any part of the name, ignoring case", () => {
  const all = pickerThemes(board);
  assert.deepEqual(filterThemes(all, "repair").map((t) => t.id), [3]);
  assert.deepEqual(filterThemes(all, "  PRS ").map((t) => t.id), [1]);
  assert.equal(filterThemes(all, "").length, 4);
});

// openTabRows: Chrome's open tabs as rows for the dashboard's "Open tabs" view.
test("open tabs are listed with where they are already saved, web pages only", () => {
  const DASH = "chrome-extension://x/dashboard/index.html";
  const chromeTabs = [
    { id: 1, url: DASH, title: "Tab Triage" },
    { id: 2, url: "https://a.com/x", title: "A", active: true },
    { id: 3, url: "chrome://extensions", title: "Extensions" },
    { id: 4, url: "https://b.com", title: "B" },
    { id: 5, url: "https://a.com/x", title: "A again" },
  ];
  const saved = {
    themes: [{ name: "Team PRs", tabs: [{ url: "https://b.com", status: "open" }, { url: "https://a.com/x", status: "done" }] }],
    later_themes: [], snoozed_themes: [], snoozed_tabs: [],
  };
  assert.deepEqual(openTabRows(chromeTabs, saved, DASH), [
    { id: 2, url: "https://a.com/x", title: "A", savedIn: null },
    { id: 4, url: "https://b.com", title: "B", savedIn: "Team PRs" },
  ]);
});
