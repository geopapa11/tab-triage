import { test } from "node:test";
import assert from "node:assert/strict";
import { numberError, isDirty } from "./settingsform.js";

test("a number inside its range is accepted", () => {
  assert.equal(numberError("6", 1, 12), null);
  assert.equal(numberError("1", 1, 12), null);
  assert.equal(numberError("12", 1, 12), null);
});

test("out-of-range, fractional and empty values are explained", () => {
  assert.equal(numberError("13", 1, 12), "Enter a whole number from 1 to 12.");
  assert.equal(numberError("0", 1, 12), "Enter a whole number from 1 to 12.");
  assert.equal(numberError("2.5", 1, 12), "Enter a whole number from 1 to 12.");
  assert.equal(numberError("", 1, 12), "Enter a whole number from 1 to 12.");
  assert.equal(numberError("abc", 0, 2000), "Enter a whole number from 0 to 2000.");
});

test("the form is dirty only when a value differs from what was saved", () => {
  const saved = { stale_hours: 96, keep_open: ["a", "b"], sweep_time: "19:00" };
  assert.equal(isDirty(saved, { stale_hours: 96, keep_open: ["a", "b"], sweep_time: "19:00" }), false);
  assert.equal(isDirty(saved, { stale_hours: 48, keep_open: ["a", "b"], sweep_time: "19:00" }), true);
  assert.equal(isDirty(saved, { stale_hours: 96, keep_open: ["a"], sweep_time: "19:00" }), true);
});
