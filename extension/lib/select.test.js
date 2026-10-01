import { test } from "node:test";
import assert from "node:assert/strict";
import { rangeIds } from "./select.js";

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
