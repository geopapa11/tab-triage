"""Local HTTP API on 127.0.0.1 for the Chrome extension and its dashboard page.

Hardening against other web pages reaching localhost:
  - Host header must be 127.0.0.1/localhost (blocks DNS rebinding).
  - A browser Origin, when present, must be a chrome-extension:// origin.
  - Writes need the X-Tab-Triage header, which forces a CORS preflight that we never grant.
"""

import json
import re
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .classifier import UNSORTED
from .settings import DEFAULT_SETTINGS, validate
from .store import DAY

EMAIL_THEME = "Email follow-ups"
DRY_RUN_DAYS = 7



def sweep_mode(first_run_done_at, now):
    if first_run_done_at is None:
        return {"mode": "first-run", "auto_close_tomorrow": False}
    elapsed = now - first_run_done_at
    if elapsed < DRY_RUN_DAYS * DAY:
        return {"mode": "dry-run", "auto_close_tomorrow": elapsed >= (DRY_RUN_DAYS - 1) * DAY}
    return {"mode": "live", "auto_close_tomorrow": False}


class Sorter:
    """Runs sort_fn off the request thread; coalesces requests that arrive mid-sort."""

    def __init__(self, sort_fn, background=True, on_error=None):
        self.sort_fn = sort_fn
        self.on_error = on_error or (lambda e: None)
        self.background = background
        self.running = False
        self._again = None
        self._lock = threading.Lock()

    def request(self, include_unsorted=False):
        if not self.background:
            self.sort_fn(include_unsorted=include_unsorted)
            return
        with self._lock:
            if self.running:
                self._again = bool(self._again) or include_unsorted
                return
            self.running = True
        threading.Thread(target=self._loop, args=(include_unsorted,), daemon=True).start()

    def _loop(self, include_unsorted):
        while True:
            try:
                self.sort_fn(include_unsorted=include_unsorted)
            except Exception as e:  # never let one bad run wedge `running` forever
                self.on_error(e)
            finally:
                with self._lock:
                    if self._again is None:
                        self.running = False
                        return
                    include_unsorted, self._again = self._again, None


def _md_title(tab):
    return tab["title"].replace("[", "(").replace("]", ")")


def export_markdown(board, now, kept=()):
    out = [f"# Tab Triage — {datetime.fromtimestamp(now):%Y-%m-%d %H:%M}", ""]
    for theme in board["themes"]:
        out.append(f"## {theme['name']}")
        for t in theme["tabs"]:
            if t["status"] == "kept":
                continue  # listed once, in their own section below
            box = "x" if t["status"] == "done" else " "
            out.append(f"- [{box}] [{_md_title(t)}]({t['url']})")
        out.append("")
    if kept:
        out.append("## Kept")
        out += [f"- [{_md_title(t)}]({t['url']}) ({t['theme']})" for t in kept]
        out.append("")
    return "\n".join(out)


class BadRequest(Exception):
    pass


def make_server(store, sort_fn, memory_fn, port=8765, background=True):
    def record_sort_crash(e):
        store.set_setting("sort_error", {"kind": "failed", "message": f"sorting crashed: {e!r}",
                                         "at": store.now()})

    sorter = Sorter(sort_fn, background=background, on_error=record_sort_crash)

    def settings():
        return {k: store.get_setting(k, v) for k, v in DEFAULT_SETTINGS.items()}

    def mode():
        return sweep_mode(store.get_setting("first_run_done_at"), store.now())

    # --- handlers: (body, match) -> response object ------------------------------

    def get_state(body, m):
        return {
            **mode(),
            "first_run_done_at": store.get_setting("first_run_done_at"),
            "sorting": sorter.running,
            "sort_error": store.get_setting("sort_error"),
            "last_model": store.get_setting("last_model"),
            "last_sweep": store.get_setting("last_sweep"),
            "merge_suggestions": store.get_setting("merge_suggestions", []),
            "theme_names": store.theme_names(),
            "settings": settings(),
        }

    def post_sweep(body, m):
        tabs = body.get("tabs")
        if not isinstance(tabs, list):
            raise BadRequest("tabs must be a list")
        current = mode()
        live = current["mode"] == "live"
        if current["mode"] == "first-run":
            for hint in {t.get("group_hint") for t in tabs if t.get("group_hint")}:
                store.create_theme(hint)
        emails = [t for t in tabs if t.get("kind") == "email"]
        others = [t for t in tabs if t.get("kind") != "email"]
        for tid in store.capture(emails, pending_close=not live):
            store.assign(tid, EMAIL_THEME)
        store.capture(others, pending_close=not live)
        store.purge()
        store.set_setting("last_sweep", {"at": store.now(), "count": len(tabs), "mode": current["mode"]})
        if others:
            sorter.request()
        return {"mode": current["mode"], "close_now": live, "stored": len(tabs)}

    def post_closed(body, m):
        store.mark_closed(body.get("urls", []))
        return {"ok": True}

    def post_first_run_complete(body, m):
        if store.get_setting("first_run_done_at") is None:
            store.set_setting("first_run_done_at", store.now())
        return mode()

    def tab_action(body, m):
        tid, action = int(m["id"]), m["action"]
        if action == "check":
            store.check(tid)
        elif action == "uncheck":
            store.uncheck(tid)
        elif action == "keep":
            store.keep(tid)
        elif action == "unkeep":
            store.unkeep(tid)
        elif action == "snooze":
            store.snooze_tab(tid, body.get("until"))
        elif action == "move":
            theme = body.get("theme")
            if theme is not None and not str(theme).strip():
                raise BadRequest("theme name required")
            store.move_tab(tid, theme=theme, index=int(body.get("index", 0)))
        elif action == "opened":
            store.mark_opened([tid])
        elif action == "remove":
            store.remove_tabs([tid])
        return {"ok": True}

    def theme_action(body, m):
        tid, action = int(m["id"]), m["action"]
        if action == "rename":
            name = str(body.get("name", "")).strip()
            if not name:
                raise BadRequest("name required")
            try:
                store.rename_theme(tid, name)
            except ValueError as e:
                raise BadRequest(str(e)) from e
        elif action == "merge":
            into = int(body["into"])
            names = {"from": store.theme_name(tid), "into": store.theme_name(into)}
            store.merge_themes(tid, into=into)
            post_dismiss_merge(names, m)
        elif action == "snooze":
            store.snooze_theme(tid, body.get("until"))
        elif action == "done":
            store.mark_theme_done(tid)
        elif action == "delete":
            store.delete_theme(tid)
        elif action == "later":
            store.set_later(tid, bool(body.get("on", True)))
        elif action == "dissolve":
            store.dissolve_theme(tid)
            sorter.request()
        return {"ok": True}

    def post_bulk(body, m):
        ids = [int(i) for i in body.get("ids", [])]
        action = body.get("action")
        if action == "check":
            for tid in ids:
                store.check(tid)
        elif action == "snooze":
            for tid in ids:
                store.snooze_tab(tid, body.get("until"))
        elif action == "move":
            theme = str(body.get("theme") or "").strip()
            if not theme:
                raise BadRequest("theme name required")
            for tid in reversed(ids):  # each lands on top, so reverse keeps the selection order
                store.move_tab(tid, theme=theme, index=0)
        elif action == "remove":
            store.remove_tabs(ids)
        else:
            raise BadRequest(f"unknown bulk action {action!r}")
        return {"ok": True, "count": len(ids)}

    def post_restore(body, m):
        store.restore_tabs([int(i) for i in body.get("ids", [])])
        return {"ok": True}

    def post_add(body, m):
        url = str(body.get("url", "")).strip()
        if not re.match(r"https?://", url):
            raise BadRequest("only http(s) pages can be added")
        title = str(body.get("title") or "").strip() or url
        theme = str(body.get("theme") or "").strip() or None
        (tid,) = store.capture([{"url": url, "title": title, "text": body.get("text") or None}])
        if theme:
            store.assign(tid, theme)
        else:
            sorter.request()  # let Claude pick the theme
        return {"ok": True, "id": tid, "theme": theme}

    def post_reorder_themes(body, m):
        store.reorder_themes([int(i) for i in body.get("ids", [])])
        return {"ok": True}

    def post_opened(body, m):
        store.mark_opened([int(i) for i in body.get("ids", [])])
        return {"ok": True}

    def post_resort(body, m):
        sorter.request(include_unsorted=True)
        return {"ok": True}

    def post_dismiss_merge(body, m):
        keep = [s for s in store.get_setting("merge_suggestions", [])
                if not (s["from"] == body.get("from") and s["into"] == body.get("into"))]
        store.set_setting("merge_suggestions", keep)
        return {"ok": True}

    def patch_settings(body, m):
        try:
            checked = {k: validate(k, v) for k, v in body.items()}  # all or nothing
        except ValueError as e:
            raise BadRequest(str(e)) from e
        for k, v in checked.items():
            store.set_setting(k, v)
        return settings()

    def get_memory(body, m):
        mem = memory_fn()
        cap = settings()["tab_memory_cap_mb"] * 1024 * 1024
        return {"chrome_bytes": mem["total"], "tabs_bytes": mem["tabs"], "tab_cap_bytes": cap,
                "over": mem["tabs"] > cap}

    routes = [
        ("GET", r"/health", lambda b, m: {"ok": True}),
        ("GET", r"/api/state", get_state),
        ("GET", r"/api/board", lambda b, m: store.board()),
        ("GET", r"/api/completed", lambda b, m: {"tabs": store.completed()}),
        ("GET", r"/api/kept", lambda b, m: {"tabs": store.kept()}),
        ("GET", r"/api/pending-close", lambda b, m: {
            "urls": store.pending_close_urls(), "tabs": store.pending_close()}),
        ("GET", r"/api/memory", get_memory),
        ("POST", r"/api/sweep", post_sweep),
        ("POST", r"/api/closed", post_closed),
        ("POST", r"/api/first-run/complete", post_first_run_complete),
        ("POST", r"/api/tabs/(?P<id>\d+)/(?P<action>check|uncheck|keep|unkeep|snooze|move|opened|remove)", tab_action),
        ("POST", r"/api/tabs/bulk", post_bulk),
        ("POST", r"/api/tabs/restore", post_restore),
        ("POST", r"/api/tabs/add", post_add),
        ("POST", r"/api/themes/reorder", post_reorder_themes),
        ("POST", r"/api/themes/(?P<id>\d+)/(?P<action>rename|merge|snooze|done|delete|dissolve|later)", theme_action),
        ("POST", r"/api/opened", post_opened),
        ("POST", r"/api/resort", post_resort),
        ("POST", r"/api/merge-suggestions/dismiss", post_dismiss_merge),
        ("PATCH", r"/api/settings", patch_settings),
    ]
    compiled = [(meth, re.compile(pat + r"$"), fn) for meth, pat, fn in routes]

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            pass

        def _send(self, status, payload, content_type="application/json"):
            data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _allowed(self):
            port = self.server.server_address[1]
            if self.headers.get("Host") not in (f"127.0.0.1:{port}", f"localhost:{port}"):
                return False
            origin = self.headers.get("Origin")
            if origin and not origin.startswith("chrome-extension://"):
                return False
            if self.command != "GET" and self.headers.get("X-Tab-Triage") != "1":
                return False
            return True

        def _dispatch(self):
            if not self._allowed():
                return self._send(403, {"error": "forbidden"})
            path = self.path.split("?", 1)[0]
            if self.command == "GET" and path == "/api/export.md":
                text = export_markdown(store.board(), store.now(), store.kept())
                return self._send(200, text.encode(), "text/markdown; charset=utf-8")
            for meth, pattern, fn in compiled:
                m = pattern.match(path)
                if m and meth == self.command:
                    try:
                        length = int(self.headers.get("Content-Length") or 0)
                        body = json.loads(self.rfile.read(length) or b"{}") if length else {}
                        return self._send(200, fn(body, m.groupdict()))
                    except (BadRequest, json.JSONDecodeError, KeyError, ValueError) as e:
                        return self._send(400, {"error": str(e)})
            return self._send(404, {"error": "not found"})

        do_GET = do_POST = do_PATCH = _dispatch

    return ThreadingHTTPServer(("127.0.0.1", port), Handler)
