import { test } from "node:test";
import assert from "node:assert/strict";
import { extractTitle, menuItems, parseMenuId } from "./addmenu.js";

test("title comes from the page's <title>, decoded and tidied", () => {
  const html = "<html><head><title>\n  Pricing &amp; Plans &#8211; Acme  </title></head></html>";
  assert.equal(extractTitle(html, "https://acme.test/pricing"), "Pricing & Plans – Acme");
});

test("without a title, the address stands in", () => {
  assert.equal(extractTitle("<html><body>hi</body></html>", "https://www.acme.test/blog/sql?x=1"), "acme.test/blog/sql");
  assert.equal(extractTitle("", "https://acme.test/"), "acme.test");
});

test("the right-click menu offers add-and-close and add-keep-open, each with every theme", () => {
  const items = menuItems([{ id: 3, name: "Team PRs" }, { id: 9, name: "SQL research" }]);
  const under = (parent) => items.filter((i) => i.parentId === parent).map((i) => i.title ?? "—");
  assert.deepEqual(under(undefined), ["Add this page to Tab Triage"]);
  assert.deepEqual(under("tt-root"), ["Add & close", "Add, keep open"]);
  assert.deepEqual(under("tt-close"), ["Let Claude choose", "—", "Team PRs", "SQL research"]);
  assert.deepEqual(under("tt-keep"), ["Let Claude choose", "—", "Team PRs", "SQL research"]);
});

test("menu ids round-trip to an action", () => {
  const items = menuItems([{ id: 3, name: "Team PRs" }]);
  const ids = items.filter((i) => i.parentId === "tt-close" && i.type !== "separator").map((i) => i.id);
  assert.deepEqual(ids.map(parseMenuId), [{ close: true, themeId: null }, { close: true, themeId: 3 }]);
  assert.deepEqual(parseMenuId("tt-add|keep|3"), { close: false, themeId: 3 });
  assert.equal(parseMenuId("something-else"), null);
});
