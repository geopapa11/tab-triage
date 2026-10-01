// Our own record of when each URL was last looked at. Chrome resets tab.lastAccessed when it
// restores a session; this survives that. Shared by the background worker and the dashboard.
const SEEN_TTL_MS = 30 * 24 * 3600_000;

export async function markSeen(urls) {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  if (!list.length) return;
  const { seen = {} } = await chrome.storage.local.get("seen");
  const now = Date.now();
  for (const u of list) seen[u] = now;
  for (const [u, t] of Object.entries(seen)) if (now - t > SEEN_TTL_MS) delete seen[u];
  await chrome.storage.local.set({ seen });
}
