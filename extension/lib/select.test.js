import { test } from "node:test";
import assert from "node:assert/strict";
import { rangeIds, pickerThemes, filterThemes } from "./select.js";

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
