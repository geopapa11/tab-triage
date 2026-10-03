// Adding pages to Tab Triage: the right-click menu ("Add & close" / "Add, keep open" → theme)
// and reading a pasted link's title. Pure — background.js and the dashboard do the I/O.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function extractTitle(html, url) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html || "");
  const title = m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : "";
  if (title) return title;
  try {
    const u = new URL(url);
    return (u.hostname.replace(/^www\./, "") + u.pathname).replace(/\/$/, "");
  } catch {
    return url;
  }
}

// Items for chrome.contextMenus.create, in order. themes: [{id, name}] in priority order.
export function menuItems(themes) {
  const items = [{ id: "tt-root", title: "Add this page to Tab Triage" }];
  for (const [mode, title] of [["close", "Add & close"], ["keep", "Add, keep open"]]) {
    const parentId = `tt-${mode}`;
    items.push({ id: parentId, parentId: "tt-root", title });
    items.push({ id: `tt-add|${mode}|auto`, parentId, title: "Let Claude choose" });
    items.push({ id: `tt-add|${mode}|unsorted`, parentId, title: "On its own (Unsorted)" });
    items.push({ id: `tt-sep|${mode}`, parentId, type: "separator" });
    for (const t of themes) items.push({ id: `tt-add|${mode}|${t.id}`, parentId, title: t.name });
  }
  return items;
}

export function parseMenuId(id) {
  const m = /^tt-add\|(close|keep)\|(auto|unsorted|\d+)$/.exec(String(id));
  if (!m) return null;
  const named = /^\d+$/.test(m[2]);
  return { close: m[1] === "close", themeId: named ? Number(m[2]) : null, unsorted: m[2] === "unsorted" };
}
