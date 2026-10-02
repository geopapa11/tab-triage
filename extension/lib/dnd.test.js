import { test } from "node:test";
import assert from "node:assert/strict";
import { dropIndex, rankedOrder, nudgeIndex, edgeScrollSpeed } from "./dnd.js";

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

// nudgeIndex: where a theme goes among the visible ranked themes (excluding itself) for a menu move.
test("move up / down / to top for a ranked theme", () => {
  const ranked = [1, 2, 3, 4];
  assert.equal(nudgeIndex(ranked, 3, "up"), 1);
  assert.equal(nudgeIndex(ranked, 3, "down"), 3);
  assert.equal(nudgeIndex(ranked, 3, "top"), 0);
});

test("moves that would go past the ends do nothing", () => {
  assert.equal(nudgeIndex([1, 2], 1, "up"), null);
  assert.equal(nudgeIndex([1, 2], 2, "down"), null);
  assert.equal(nudgeIndex([1, 2], 1, "top"), null);
});

test("an unranked theme moving up joins the end of the priorities", () => {
  assert.equal(nudgeIndex([1, 2], 9, "up"), 2);
  assert.equal(nudgeIndex([1, 2], 9, "top"), 0);
  assert.equal(nudgeIndex([1, 2], 9, "down"), null);
});

test("composes with rankedOrder", () => {
  const all = [{ id: 1, position: 0 }, { id: 2, position: 1 }, { id: 3, position: 2 }];
  assert.deepEqual(rankedOrder(all, [1, 2, 3], 3, nudgeIndex([1, 2, 3], 3, "up"), true), [1, 3, 2]);
});

// edgeScrollSpeed: px per frame to scroll while dragging near the viewport's top/bottom edge.
test("no scrolling in the middle of the viewport", () => {
  assert.equal(edgeScrollSpeed(400, 800), 0);
});

test("scrolls up near the top and down near the bottom, faster closer to the edge", () => {
  assert.ok(edgeScrollSpeed(60, 800) < 0);
  assert.ok(edgeScrollSpeed(10, 800) < edgeScrollSpeed(60, 800));
  assert.ok(edgeScrollSpeed(740, 800) > 0);
  assert.ok(edgeScrollSpeed(795, 800) > edgeScrollSpeed(740, 800));
});

test("speed is capped", () => {
  assert.equal(edgeScrollSpeed(-50, 800), -28);
  assert.equal(edgeScrollSpeed(900, 800), 28);
});
