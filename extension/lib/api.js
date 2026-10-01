// Tiny client for the local server. The X-Tab-Triage header is required for writes.
export const API_BASE = "http://127.0.0.1:8765";

export async function api(method, path, body) {
  const res = await fetch(API_BASE + path, {
    method,
    headers: { "Content-Type": "application/json", "X-Tab-Triage": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return path.endsWith(".md") ? res.text() : res.json();
}
