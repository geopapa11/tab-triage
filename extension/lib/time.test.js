import { test } from "node:test";
import assert from "node:assert/strict";
import { snoozePresets, ago, dayLabel, localISODate, fileStamp } from "./time.js";

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

test("snooze presets land at 08:00 local", () => {
  const wed = at(2026, 9, 30, 15, 20); // Wednesday
  const p = snoozePresets(wed);
  assert.equal(p.tomorrow, at(2026, 10, 1, 8));
  assert.equal(p.nextMonday, at(2026, 10, 5, 8));
  assert.equal(p.week, at(2026, 10, 7, 8));
});

test("next Monday from a Monday is a week later", () => {
  assert.equal(snoozePresets(at(2026, 10, 5, 9)).nextMonday, at(2026, 10, 12, 8));
});

test("next Monday from a Sunday is the following day", () => {
  assert.equal(snoozePresets(at(2026, 10, 4, 22)).nextMonday, at(2026, 10, 5, 8));
});

test("ago formats seconds-based timestamps compactly", () => {
  const now = at(2026, 9, 30, 12);
  const s = (ms) => (now - ms) / 1000;
  assert.equal(ago(s(20_000), now), "just now");
  assert.equal(ago(s(5 * 60_000), now), "5m ago");
  assert.equal(ago(s(3 * 3600_000), now), "3h ago");
  assert.equal(ago(s(2 * 86400_000), now), "2d ago");
  assert.equal(ago(s(15 * 86400_000), now), "2w ago");
  assert.equal(ago(null, now), "—");
});

test("day labels for completed grouping", () => {
  const now = at(2026, 9, 30, 12);
  assert.equal(dayLabel(at(2026, 9, 30, 1) / 1000, now), "Today");
  assert.equal(dayLabel(at(2026, 9, 29, 23) / 1000, now), "Yesterday");
  assert.equal(dayLabel(at(2026, 9, 28, 10) / 1000, now), "Mon 28 Sep");
});

test("local dates and file stamps use the local day, not UTC", () => {
  const lateEvening = new Date(2026, 9, 2, 23, 30).getTime(); // already Oct 3 in UTC west of Greenwich
  assert.equal(localISODate(lateEvening), "2026-10-02");
  assert.equal(fileStamp(lateEvening), "2026-10-02-2330");
});
