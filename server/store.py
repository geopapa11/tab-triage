"""SQLite storage for swept tabs, themes, corrections and settings.

Times are epoch seconds. `now` is injectable so tests control the clock.
"""

import json
import sqlite3
import threading
import time
from pathlib import Path
from urllib.parse import urlparse

DAY = 86_400.0
DONE_RETENTION = 45 * DAY
STALE_AFTER = 7 * DAY

SCHEMA = """
CREATE TABLE IF NOT EXISTS themes (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    position INTEGER,
    suggested_position INTEGER,
    created_at REAL NOT NULL,
    touched_at REAL NOT NULL,
    snoozed_until REAL,
    back INTEGER NOT NULL DEFAULT 0,
    later INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tabs (
    id INTEGER PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    theme_id INTEGER REFERENCES themes(id),
    position INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open',
    captured_at REAL NOT NULL,
    last_seen_at REAL NOT NULL,
    last_accessed_at REAL,
    completed_at REAL,
    snoozed_until REAL,
    back INTEGER NOT NULL DEFAULT 0,
    in_chrome INTEGER NOT NULL DEFAULT 0,
    pending_close INTEGER NOT NULL DEFAULT 0,
    text TEXT,
    group_hint TEXT
);
CREATE TABLE IF NOT EXISTS corrections (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    detail TEXT NOT NULL,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

TAB_FIELDS = (
    "id", "url", "title", "status", "captured_at", "last_seen_at", "last_accessed_at",
    "completed_at", "snoozed_until", "in_chrome", "pending_close", "group_hint",
)


def _domain(url):
    return urlparse(url).netloc.removeprefix("www.")


class Store:
    def __init__(self, path, now=time.time):
        self.now = now
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA foreign_keys = ON")
        self._db.executescript(SCHEMA)
        self._migrate()
        self._lock = threading.RLock()

    def _migrate(self):
        theme_cols = {r[1] for r in self._db.execute("PRAGMA table_info(themes)")}
        if "later" not in theme_cols:
            with self._db:
                self._db.execute("ALTER TABLE themes ADD COLUMN later INTEGER NOT NULL DEFAULT 0")

    # --- helpers ----------------------------------------------------------------

    def _q(self, sql, *args):
        return self._db.execute(sql, args).fetchall()

    def _one(self, sql, *args):
        return self._db.execute(sql, args).fetchone()

    def _top_position(self, theme_id):
        row = self._one(
            "SELECT MIN(position) FROM tabs WHERE theme_id IS ? AND status = 'open'", theme_id
        )
        return 0 if row[0] is None else row[0] - 1

    def _touch(self, theme_id):
        if theme_id is not None:
            self._db.execute(
                "UPDATE themes SET touched_at = ?, back = 0 WHERE id = ?", (self.now(), theme_id)
            )

    def _theme_id(self, tab_id):
        return self._one("SELECT theme_id FROM tabs WHERE id = ?", tab_id)[0]

    def _theme_name(self, theme_id):
        row = self._one("SELECT name FROM themes WHERE id = ?", theme_id)
        return row[0] if row else None

    def _record(self, kind, detail):
        self._db.execute(
            "INSERT INTO corrections (kind, detail, created_at) VALUES (?, ?, ?)",
            (kind, json.dumps(detail), self.now()),
        )

    def _wake(self):
        now = self.now()
        for row in self._q(
            "SELECT id, theme_id FROM tabs WHERE snoozed_until IS NOT NULL AND snoozed_until <= ?", now
        ):
            self._db.execute(
                "UPDATE tabs SET snoozed_until = NULL, back = 1, position = ? WHERE id = ?",
                (self._top_position(row["theme_id"]), row["id"]),
            )
        self._db.execute(
            "UPDATE themes SET snoozed_until = NULL, back = 1 "
            "WHERE snoozed_until IS NOT NULL AND snoozed_until <= ?",
            (now,),
        )

    # --- capture & sorting ------------------------------------------------------

    def capture(self, items, pending_close=False):
        """Upsert swept tabs by URL. Returns tab ids in input order."""
        now = self.now()
        ids = []
        with self._lock, self._db:
            for it in items:
                row = self._one("SELECT id, status, theme_id FROM tabs WHERE url = ?", it["url"])
                if row and row["status"] == "done":
                    # Reopened after being ticked done: it's live work again.
                    self._db.execute(
                        "UPDATE tabs SET status = 'open', completed_at = NULL, position = ? WHERE id = ?",
                        (self._top_position(row["theme_id"]), row["id"]),
                    )
                if row:
                    self._db.execute(
                        "UPDATE tabs SET title = ?, last_seen_at = ?, "
                        "last_accessed_at = COALESCE(?, last_accessed_at), "
                        "text = COALESCE(?, text), group_hint = COALESCE(?, group_hint), "
                        "in_chrome = 0, pending_close = ? WHERE id = ?",
                        (it["title"], now, it.get("last_accessed_at"), it.get("text"),
                         it.get("group_hint"), int(pending_close), row["id"]),
                    )
                    ids.append(row["id"])
                else:
                    cur = self._db.execute(
                        "INSERT INTO tabs (url, title, captured_at, last_seen_at, last_accessed_at, "
                        "text, group_hint, pending_close) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                        (it["url"], it["title"], now, now, it.get("last_accessed_at"),
                         it.get("text"), it.get("group_hint"), int(pending_close)),
                    )
                    ids.append(cur.lastrowid)
        return ids

    def pending_sort(self):
        with self._lock:
            rows = self._q(
                "SELECT id, url, title, text, group_hint FROM tabs WHERE theme_id IS NULL ORDER BY id"
            )
        return [dict(r) for r in rows]

    def tabs_in_theme(self, name):
        with self._lock:
            rows = self._q(
                "SELECT t.id, t.url, t.title, t.text, t.group_hint FROM tabs t "
                "JOIN themes th ON th.id = t.theme_id WHERE th.name = ? AND t.status = 'open' "
                "ORDER BY t.id",
                name,
            )
        return [dict(r) for r in rows]

    def create_theme(self, name, position=None, suggested_position=None):
        now = self.now()
        with self._lock, self._db:
            row = self._one("SELECT id FROM themes WHERE name = ?", name)
            if row:
                return row["id"]
            if position is not None:
                self._db.execute(
                    "UPDATE themes SET position = position + 1 WHERE position >= ?", (position,)
                )
            cur = self._db.execute(
                "INSERT INTO themes (name, position, suggested_position, created_at, touched_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (name, position, suggested_position, now, now),
            )
            return cur.lastrowid

    def assign(self, tab_id, theme_name):
        theme_id = self.create_theme(theme_name)
        with self._lock, self._db:
            self._db.execute(
                "UPDATE tabs SET theme_id = ?, position = ? WHERE id = ?",
                (theme_id, self._top_position(theme_id), tab_id),
            )
            self._touch(theme_id)

    # --- user actions -----------------------------------------------------------

    def check(self, tab_id):
        with self._lock, self._db:
            self._db.execute(
                "UPDATE tabs SET status = 'done', completed_at = ?, back = 0 WHERE id = ?",
                (self.now(), tab_id),
            )
            self._touch(self._theme_id(tab_id))

    def uncheck(self, tab_id):
        with self._lock, self._db:
            theme_id = self._theme_id(tab_id)
            self._db.execute(
                "UPDATE tabs SET status = 'open', completed_at = NULL, back = 0, position = ? "
                "WHERE id = ?",
                (self._top_position(theme_id), tab_id),
            )
            self._touch(theme_id)

    def move_tab(self, tab_id, theme=None, index=0):
        """Move a tab to `index` among the visible open tabs of `theme` (None = its own theme)."""
        with self._lock, self._db:
            row = self._one("SELECT url, title, theme_id FROM tabs WHERE id = ?", tab_id)
            src = row["theme_id"]
            dst = src if theme is None else self.create_theme(theme)
            if dst != src:
                self._record("move", {"title": row["title"], "url": row["url"],
                                      "from": self._theme_name(src), "to": self._theme_name(dst)})
            order = [
                r["id"] for r in self._q(
                    "SELECT id FROM tabs WHERE theme_id IS ? AND status = 'open' "
                    "AND snoozed_until IS NULL AND id != ? ORDER BY position, id",
                    dst, tab_id,
                )
            ]
            order.insert(max(0, min(index, len(order))), tab_id)
            for pos, tid in enumerate(order):
                self._db.execute("UPDATE tabs SET position = ? WHERE id = ?", (pos, tid))
            self._db.execute("UPDATE tabs SET theme_id = ?, back = 0 WHERE id = ?", (dst, tab_id))
            self._db.execute("UPDATE themes SET back = 0 WHERE id IN (?, ?)", (src, dst))

    def mark_opened(self, tab_ids):
        with self._lock, self._db:
            for tid in tab_ids:
                self._db.execute(
                    "UPDATE tabs SET in_chrome = 1, pending_close = 0, back = 0 WHERE id = ?", (tid,)
                )
                self._touch(self._theme_id(tid))

    def mark_closed(self, urls):
        with self._lock, self._db:
            for url in urls:
                self._db.execute(
                    "UPDATE tabs SET in_chrome = 0, pending_close = 0 WHERE url = ?", (url,)
                )

    def pending_close(self):
        with self._lock:
            rows = self._q("SELECT url, last_seen_at FROM tabs WHERE pending_close = 1 ORDER BY id")
        return [dict(r) for r in rows]

    def pending_close_urls(self):
        with self._lock:
            return [r[0] for r in self._q("SELECT url FROM tabs WHERE pending_close = 1")]

    def snooze_tab(self, tab_id, until):
        with self._lock, self._db:
            self._db.execute(
                "UPDATE tabs SET snoozed_until = ?, back = 0 WHERE id = ?", (until, tab_id)
            )
            self._touch(self._theme_id(tab_id))

    def unsnooze_tab(self, tab_id):
        self.snooze_tab(tab_id, None)

    def snooze_theme(self, theme_id, until):
        with self._lock, self._db:
            self._touch(theme_id)
            self._db.execute(
                "UPDATE themes SET snoozed_until = ? WHERE id = ?", (until, theme_id)
            )

    def set_later(self, theme_id, on):
        """Park a theme in the collapsed Later list; its rank is kept for when it comes back."""
        with self._lock, self._db:
            self._db.execute("UPDATE themes SET later = ? WHERE id = ?", (int(bool(on)), theme_id))
            if not on:
                self._touch(theme_id)

    def reorder_themes(self, theme_ids):
        """`theme_ids` is the complete ranked list; any theme left out becomes unranked."""
        with self._lock, self._db:
            self._db.execute("UPDATE themes SET position = NULL")
            for pos, tid in enumerate(theme_ids):
                self._db.execute(
                    "UPDATE themes SET position = ?, back = 0 WHERE id = ?", (pos, tid)
                )

    def rename_theme(self, theme_id, new_name):
        with self._lock, self._db:
            old = self._theme_name(theme_id)
            if self._one("SELECT 1 FROM themes WHERE name = ? AND id != ?", new_name, theme_id):
                raise ValueError(f"theme {new_name!r} already exists")
            self._db.execute(
                "UPDATE themes SET name = ?, back = 0 WHERE id = ?", (new_name, theme_id)
            )
            self._record("rename", {"from": old, "to": new_name})

    def merge_themes(self, theme_id, into):
        with self._lock, self._db:
            src, dst = self._theme_name(theme_id), self._theme_name(into)
            self._db.execute("UPDATE tabs SET theme_id = ? WHERE theme_id = ?", (into, theme_id))
            self._db.execute("DELETE FROM themes WHERE id = ?", (theme_id,))
            self._touch(into)
            self._record("merge", {"from": src, "into": dst})

    def delete_tabs(self, tab_ids):
        """Gone for good: no Completed history. Themes left with no tabs are removed too."""
        with self._lock, self._db:
            theme_ids = {self._theme_id(tid) for tid in tab_ids
                         if self._one("SELECT 1 FROM tabs WHERE id = ?", tid)}
            self._db.executemany("DELETE FROM tabs WHERE id = ?", [(tid,) for tid in tab_ids])
            for th in theme_ids - {None}:
                if not self._one("SELECT 1 FROM tabs WHERE theme_id = ?", th):
                    self._db.execute("DELETE FROM themes WHERE id = ?", (th,))

    def delete_theme(self, theme_id):
        with self._lock, self._db:
            self._db.execute("DELETE FROM tabs WHERE theme_id = ?", (theme_id,))
            self._db.execute("DELETE FROM themes WHERE id = ?", (theme_id,))

    def mark_theme_done(self, theme_id):
        with self._lock, self._db:
            self._db.execute(
                "UPDATE tabs SET status = 'done', completed_at = ?, back = 0 "
                "WHERE theme_id = ? AND status = 'open'",
                (self.now(), theme_id),
            )
            self._touch(theme_id)

    def dissolve_theme(self, theme_id):
        """Drop the grouping, keep the tabs: open ones go back to be sorted again; ticked ones
        keep their Completed history under Unsorted."""
        with self._lock:
            name = self._theme_name(theme_id)
            has_done = self._one("SELECT 1 FROM tabs WHERE theme_id = ? AND status = 'done'", theme_id)
            unsorted = self.create_theme("Unsorted") if has_done else None
            with self._db:
                self._db.execute(
                    "UPDATE tabs SET theme_id = NULL, back = 0 WHERE theme_id = ? AND status = 'open'",
                    (theme_id,),
                )
                self._db.execute("UPDATE tabs SET theme_id = ? WHERE theme_id = ?", (unsorted, theme_id))
                self._db.execute("DELETE FROM themes WHERE id = ?", (theme_id,))
                self._record("dissolve", {"theme": name})

    def purge(self):
        with self._lock, self._db:
            self._db.execute(
                "DELETE FROM tabs WHERE status = 'done' AND completed_at < ?",
                (self.now() - DONE_RETENTION,),
            )
            self._db.execute(
                "DELETE FROM themes WHERE id NOT IN (SELECT DISTINCT theme_id FROM tabs "
                "WHERE theme_id IS NOT NULL) AND touched_at < ?",
                (self.now() - DAY,),
            )

    # --- reads ------------------------------------------------------------------

    def _tab_dict(self, r):
        d = {k: r[k] for k in TAB_FIELDS}
        d["back"] = bool(r["back"])
        d["in_chrome"] = bool(r["in_chrome"])
        d["pending_close"] = bool(r["pending_close"])
        d["domain"] = _domain(r["url"])
        return d

    def _theme_dict(self, th, tabs):
        return {
            "id": th["id"],
            "name": th["name"],
            "ranked": th["position"] is not None,
            "position": th["position"],
            "suggested_position": th["suggested_position"],
            "stale": self.now() - th["touched_at"] >= STALE_AFTER,
            "back": bool(th["back"]),
            "snoozed_until": th["snoozed_until"],
            "later": bool(th["later"]),
            "tabs": tabs,
        }

    def _ordered_themes(self):
        return self._q(
            "SELECT * FROM themes ORDER BY name = 'Unsorted', position IS NULL, position, "
            "suggested_position IS NULL, suggested_position, created_at, id"
        )

    def board(self):
        with self._lock, self._db:
            self._wake()
            themes, snoozed_themes, later_themes = [], [], []
            for th in self._ordered_themes():
                open_rows = self._q(
                    "SELECT * FROM tabs WHERE theme_id = ? AND status = 'open' "
                    "AND snoozed_until IS NULL ORDER BY position, id",
                    th["id"],
                )
                if not open_rows:  # nothing to act on: all done, all snoozed, or empty
                    continue
                done_rows = self._q(
                    "SELECT * FROM tabs WHERE theme_id = ? AND status = 'done' "
                    "ORDER BY completed_at DESC, id DESC",
                    th["id"],
                )
                tabs = [self._tab_dict(r) for r in [*open_rows, *done_rows]]
                target = (snoozed_themes if th["snoozed_until"] is not None
                          else later_themes if th["later"] else themes)
                target.append(self._theme_dict(th, tabs))
            snoozed_tabs = [
                {**self._tab_dict(r), "theme": r["theme_name"]}
                for r in self._q(
                    "SELECT t.*, th.name AS theme_name FROM tabs t "
                    "LEFT JOIN themes th ON th.id = t.theme_id "
                    "WHERE t.snoozed_until IS NOT NULL AND t.status = 'open' "
                    "ORDER BY t.snoozed_until"
                )
            ]
            n_pending = self._one("SELECT COUNT(*) FROM tabs WHERE theme_id IS NULL")[0]
        return {
            "themes": themes,
            "snoozed_themes": snoozed_themes,
            "later_themes": later_themes,
            "snoozed_tabs": snoozed_tabs,
            "pending_sort": n_pending,
        }

    def completed(self):
        with self._lock:
            rows = self._q(
                "SELECT t.*, th.name AS theme_name FROM tabs t "
                "LEFT JOIN themes th ON th.id = t.theme_id WHERE t.status = 'done' "
                "ORDER BY t.completed_at DESC, t.id DESC"
            )
        return [{**self._tab_dict(r), "theme": r["theme_name"]} for r in rows]

    def active_theme_names(self):
        with self._lock:
            return [
                th["name"] for th in self._ordered_themes()
                if self._one(
                    "SELECT 1 FROM tabs WHERE theme_id = ? AND status = 'open'", th["id"]
                )
            ]

    def sortable_theme_names(self):
        """Themes the classifier may reuse: those with open tabs, plus empty seeded ones."""
        with self._lock:
            return [
                th["name"] for th in self._ordered_themes()
                if self._one(
                    "SELECT 1 FROM tabs WHERE theme_id = ? AND status = 'open'", th["id"]
                ) or not self._one("SELECT 1 FROM tabs WHERE theme_id = ?", th["id"])
            ]

    def theme_name(self, theme_id):
        with self._lock:
            return self._theme_name(theme_id)

    def theme_names(self):
        with self._lock:
            return [th["name"] for th in self._ordered_themes()]

    def corrections(self, limit=20):
        with self._lock:
            rows = self._q(
                "SELECT kind, detail, created_at FROM corrections ORDER BY id DESC LIMIT ?", limit
            )
        return [{"kind": r["kind"], "detail": json.loads(r["detail"]),
                 "created_at": r["created_at"]} for r in rows]

    # --- settings ---------------------------------------------------------------

    def get_setting(self, key, default=None):
        with self._lock:
            row = self._one("SELECT value FROM settings WHERE key = ?", key)
        return default if row is None else json.loads(row[0])

    def set_setting(self, key, value):
        with self._lock, self._db:
            self._db.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, json.dumps(value)),
            )
