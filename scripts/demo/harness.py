"""Serve the real dashboard outside Chrome, with invented data, for the README screenshots.

    PYTHONPATH=. uv run python scripts/demo/seed.py /tmp/demo.db
    uv run python -m server --port 8799 --db /tmp/demo.db &
    uv run python scripts/demo/harness.py &
    # then run scripts/demo/capture_dashboard.mjs (see its header) to write docs/images/.

It stubs chrome.*, draws letter favicons, returns fixed memory numbers and forces the color scheme.
"""
import http.server, urllib.request, urllib.error, urllib.parse, pathlib, re, json, hashlib
EXT = pathlib.Path(__file__).resolve().parents[2] / "extension"
CSS = (EXT / "dashboard/style.css").read_text()
DARK = re.search(r"@media \(prefers-color-scheme: dark\) \{\s*:root \{(.*?)\}\s*\}", CSS, re.S).group(1)
LIGHT = re.search(r":root \{(.*?)\}", CSS, re.S).group(1)
STUB = """<script>
const T = (id, url, o = {}) => ({ id, url, title: url, discarded: false, status: 'complete', windowId: 1, ...o });
window.chrome = {
  tabs: { query: async () => [
      T(1, 'https://github.com/acme-shop/web/pull/415'), T(2, 'https://www.figma.com/file/demo/checkout-v3'),
      T(3, 'https://mail.google.com/mail/u/0/#inbox'), T(4, 'https://calendar.google.com/calendar/u/0/r'),
      T(5, 'https://docs.stripe.com/payments/elements'), T(6, 'https://linear.app/acme/active', { discarded: true }),
    ], create: async () => {}, remove: async () => {}, update: async () => ({}) },
  windows: { create: async () => ({}), getAll: async () => [{ id: 1, incognito: false }, { id: 2, incognito: false }], update: async () => {} },
  storage: { local: { get: async () => ({ lastSweep: { at: Date.now() - 7200000, saved: 4, dropped: 2, mode: 'live' } }) }, onChanged: { addListener() {} } },
  runtime: { sendMessage: async () => ({ ok: true, result: {} }) },
};
</script>"""
MEMORY = {"chrome_bytes": int(1.62 * 1024**3), "tabs_bytes": int(0.74 * 1024**3), "tab_cap_bytes": 2 * 1024**3, "over": False}
PALETTE = ["#2f6b4f", "#c2410c", "#1f5fa8", "#7a4fb3", "#b7791f", "#0f766e", "#9d2f5b", "#4a463f"]
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, body, ct):
        self.send_response(code); self.send_header("Content-Type", ct); self.send_header("Cache-Control", "no-store"); self.end_headers(); self.wfile.write(body)
    def _proxy(self):
        path = self.path[len("/proxy"):]
        if path.startswith("/api/memory"): return self._send(200, json.dumps(MEMORY).encode(), "application/json")
        n = int(self.headers.get("Content-Length") or 0)
        req = urllib.request.Request("http://127.0.0.1:8799" + path, method=self.command, data=self.rfile.read(n) if n else None,
              headers={"Host": "127.0.0.1:8799", "X-Tab-Triage": "1", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req) as r: code, body, ct = r.status, r.read(), r.headers["Content-Type"]
        except urllib.error.HTTPError as e: code, body, ct = e.code, e.read(), "application/json"
        self._send(code, body, ct)
    def do_GET(self):
        if self.path.startswith("/proxy"): return self._proxy()
        u = urllib.parse.urlparse(self.path)
        if u.path.startswith("/_favicon/"):
            host = urllib.parse.urlparse(urllib.parse.parse_qs(u.query).get("pageUrl", [""])[0]).hostname or "?"
            name = host.removeprefix("www.").removeprefix("docs.")
            color = PALETTE[int(hashlib.md5(name.encode()).hexdigest(), 16) % len(PALETTE)]
            svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="{color}"/><text x="16" y="22" text-anchor="middle" font-family="-apple-system,Helvetica" font-size="18" font-weight="700" fill="#fff">{name[0].upper()}</text></svg>'
            return self._send(200, svg.encode(), "image/svg+xml")
        f = EXT / u.path.lstrip("/")
        if not f.is_file(): return self._send(404, b"", "text/plain")
        body = f.read_bytes()
        if u.path == "/lib/api.js": body = body.replace(b'"http://127.0.0.1:8765"', b'"/proxy"')
        if u.path == "/dashboard/index.html":
            extra = STUB + "<style>:root {" + (DARK if "dark=1" in u.query else LIGHT) + "}</style>"
            body = body.replace(b"</head>", extra.encode() + b"</head>")
        ct = {"js": "text/javascript", "css": "text/css", "html": "text/html"}.get(u.path.rsplit(".", 1)[-1], "application/octet-stream")
        self._send(200, body, ct)
    do_POST = do_PATCH = _proxy
http.server.ThreadingHTTPServer(("127.0.0.1", 8791), H).serve_forever()
