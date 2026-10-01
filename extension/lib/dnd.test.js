import { test } from "node:test";
import assert from "node:assert/strict";
import { dropIndex, rankedOrder } from "./dnd.js";

test("drop index counts rows whose midpoint is above the pointer", () => {
  const mids = [10, 30, 50];
  assert.equal(dropIndex(mids, 0), 0);
  assert.equal(dropIndex(mids, 29), 1);
  assert.equal(dropIndex(mids, 31), 2);
  assert.equal(dropIndex(mids, 99), 3);
  assert.equal(dropIndex([], 5), 0);
});

// all = every theme with its rank (position null = unranked), including snoozed ones
const all = [
  { id: 1, position: 0 }, { id: 9, position: 1 /* snoozed, not on screen */ }, { id: 2, position: 2 },
  { id: 3, position: null },
];

test("ranking a theme keeps snoozed themes' ranks", () => {
  assert.deepEqual(rankedOrder(all, [1, 2], 3, 1, true), [1, 9, 3, 2]);
  assert.deepEqual(rankedOrder(all, [1, 2], 3, 2, true), [1, 9, 2, 3]);
});

test("moving a ranked theme to the top", () => {
  assert.deepEqual(rankedOrder(all, [1, 2], 2, 0, true), [2, 1, 9]);
});

test("dropping a theme into the unranked zone unranks only that theme", () => {
  assert.deepEqual(rankedOrder(all, [1, 2], 1, 0, false), [9, 2]);
});
