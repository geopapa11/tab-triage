import json
import threading
import urllib.error
import urllib.request

import pytest

from server.app import make_server, sweep_mode
from server.memory import chrome_memory
from server.store import DAY, Store

from .test_store import Clock

# --- pure helpers --------------------------------------------------------------

PS_OUTPUT = """\
  700000 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
  300000 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/154/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer --lang=en-US --renderer-client-id=12
  200000 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/154/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer --extension-process --lang=en-US
  100000 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/154/Helpers/Google Chrome Helper (GPU).app/Contents/MacOS/Google Chrome Helper (GPU) --type=gpu-process --gpu-preferences=x
   50000 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/154/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper --type=utility --utility-sub-type=network.mojom.NetworkService
  400000 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/154/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer --renderer-client-id=40
  999999 /Applications/Slack.app/Contents/MacOS/Slack --type=renderer
     100 /usr/bin/ps
"""


def test_chrome_memory_splits_tabs_from_the_rest():
    kb = 1024
    assert chrome_memory(PS_OUTPUT) == {
        "total": (700000 + 300000 + 200000 + 100000 + 50000 + 400000) * kb,
        "tabs": (300000 + 400000) * kb,
    }


@pytest.mark.parametrize("days_since_first_run, mode, warn", [
    (None, "first-run", False),
    (0, "dry-run", False),
    (5.9, "dry-run", False),
    (6.1, "dry-run", True),
    (7.0, "live", False),
])
def test_sweep_mode_follows_first_run_date(days_since_first_run, mode, warn):
    now = 1_800_000_000.0
    done = None if days_since_first_run is None else now - days_since_first_run * DAY
    assert sweep_mode(done, now) == {"mode": mode, "auto_close_tomorrow": warn}


# --- HTTP ----------------------------------------------------------------------

@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def env(tmp_path, clock):
    store = Store(tmp_path / "t.db", now=clock)
    sorted_calls = []

    def sort_fn(include_unsorted=False):
        sorted_calls.append(include_unsorted)
        for t in store.pending_sort():
            store.assign(t["id"], "Sorted")

    srv = make_server(store, sort_fn=sort_fn, memory_fn=lambda: {"total": 2_000_000_000, "tabs": 900_000_000}, port=0,
                      background=False)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield {"store": store, "port": srv.server_address[1], "sorted": sorted_calls, "clock": clock}
    srv.shutdown()


def call(env, method, path, body=None, headers=None):
    port = env["port"]
    h = {"Host": f"127.0.0.1:{port}", "X-Tab-Triage": "1", "Content-Type": "application/json"}
    h.update(headers or {})
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}", method=method, headers=h,
        data=None if body is None else json.dumps(body).encode(),
    )
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, None


def sweep(env, tabs, **kw):
    return call(env, "POST", "/api/sweep", {"tabs": tabs, **kw})


def tab(url, title=None, **kw):
    return {"url": url, "title": title or url, **kw}


def themes(env):
    return {t["name"]: [x["title"] for x in t["tabs"]] for t in call(env, "GET", "/api/board")[1]["themes"]}


def test_health(env):
    assert call(env, "GET", "/health") == (200, {"ok": True})


def test_rejects_foreign_host_header(env):
    assert call(env, "GET", "/api/board", headers={"Host": "evil.example:80"})[0] == 403


def test_rejects_web_page_origin(env):
    assert call(env, "GET", "/api/board", headers={"Origin": "https://evil.example"})[0] == 403


def test_allows_extension_origin(env):
    assert call(env, "GET", "/api/board", headers={"Origin": "chrome-extension://abc"})[0] == 200


def test_writes_require_custom_header(env):
    assert call(env, "POST", "/api/resort", {}, headers={"X-Tab-Triage": ""})[0] == 403


def test_first_sweep_stores_sorts_and_holds_tabs_for_approval(env):
    status, body = sweep(env, [tab("https://a"), tab("https://b")])
    assert status == 200
    assert body["close_now"] is False
    assert body["mode"] == "first-run"
    assert themes(env) == {"Sorted": ["https://b", "https://a"]}
    pending = call(env, "GET", "/api/pending-close")[1]
    assert pending["urls"] == ["https://a", "https://b"]
    assert [p["url"] for p in pending["tabs"]] == ["https://a", "https://b"]


def test_email_tabs_go_straight_to_email_follow_ups(env):
    sweep(env, [tab("https://mail.google.com/mail/u/1/#inbox/AbCdEfG", "Re: pricing", kind="email")])
    assert themes(env) == {"Email follow-ups": ["Re: pricing"]}


def test_first_run_seeds_themes_from_tab_groups(env):
    sweep(env, [tab("https://a", group_hint="Travel planning")])
    assert "Travel planning" in call(env, "GET", "/api/state")[1]["theme_names"]


def test_closed_tabs_leave_pending_list(env):
    sweep(env, [tab("https://a"), tab("https://b")])
    call(env, "POST", "/api/closed", {"urls": ["https://a"]})
    assert call(env, "GET", "/api/pending-close")[1]["urls"] == ["https://b"]


def test_completing_first_run_starts_dry_run_then_live(env):
    sweep(env, [tab("https://a")])
    call(env, "POST", "/api/first-run/complete", {})
    assert call(env, "GET", "/api/state")[1]["mode"] == "dry-run"
    assert sweep(env, [tab("https://b")])[1]["close_now"] is False
    env["clock"].advance(7)
    assert call(env, "GET", "/api/state")[1]["mode"] == "live"
    assert sweep(env, [tab("https://c")])[1]["close_now"] is True


def test_tab_actions_round_trip(env):
    sweep(env, [tab("https://a"), tab("https://b")])
    board = call(env, "GET", "/api/board")[1]
    a = next(t for t in board["themes"][0]["tabs"] if t["title"] == "https://a")
    assert call(env, "POST", f"/api/tabs/{a['id']}/check", {})[0] == 200
    assert [t["title"] for t in call(env, "GET", "/api/completed")[1]["tabs"]] == ["https://a"]
    call(env, "POST", f"/api/tabs/{a['id']}/uncheck", {})
    call(env, "POST", f"/api/tabs/{a['id']}/move", {"theme": "Other", "index": 0})
    assert themes(env) == {"Sorted": ["https://b"], "Other": ["https://a"]}


def test_theme_actions_round_trip(env):
    sweep(env, [tab("https://a")])
    tid = call(env, "GET", "/api/board")[1]["themes"][0]["id"]
    call(env, "POST", f"/api/themes/{tid}/rename", {"name": "Renamed"})
    assert list(themes(env)) == ["Renamed"]
    assert call(env, "POST", f"/api/themes/{tid}/rename", {"name": ""})[0] == 400


def test_snooze_hides_tab(env, clock):
    sweep(env, [tab("https://a")])
    tid = call(env, "GET", "/api/board")[1]["themes"][0]["tabs"][0]["id"]
    call(env, "POST", f"/api/tabs/{tid}/snooze", {"until": clock() + DAY})
    assert themes(env) == {}


def test_resort_requests_unsorted_retry(env):
    call(env, "POST", "/api/resort", {})
    assert env["sorted"][-1] is True


def test_settings_only_accept_known_keys(env):
    assert call(env, "PATCH", "/api/settings", {"model": "opus"})[0] == 200
    assert call(env, "GET", "/api/state")[1]["settings"]["model"] == "opus"
    assert call(env, "PATCH", "/api/settings", {"evil": 1})[0] == 400
    assert call(env, "PATCH", "/api/settings", {"max_themes": 30})[1]["max_themes"] == 30


def test_memory_guard_compares_tab_memory_with_tab_budget(env):
    assert call(env, "GET", "/api/memory")[1] == {
        "chrome_bytes": 2_000_000_000, "tabs_bytes": 900_000_000,
        "tab_cap_bytes": 2048 * 1024 * 1024, "over": False,
    }
    call(env, "PATCH", "/api/settings", {"tab_memory_cap_mb": 512})
    assert call(env, "GET", "/api/memory")[1]["over"] is True


def test_markdown_export_lists_themes(env):
    sweep(env, [tab("https://a", "Alpha")])
    req = urllib.request.Request(f"http://127.0.0.1:{env['port']}/api/export.md")
    with urllib.request.urlopen(req) as r:
        text = r.read().decode()
    assert "## Sorted" in text and "- [ ] [Alpha](https://a)" in text


def test_merging_themes_dismisses_matching_suggestion(env):
    store = env["store"]
    for name in ("Skills A", "Skills B"):
        (i,) = store.capture([{"url": f"https://{name}", "title": name}])
        store.assign(i, name)
    store.set_setting("merge_suggestions", [{"from": "Skills A", "into": "Skills B", "reason": "x"}])
    ids = {t["name"]: t["id"] for t in call(env, "GET", "/api/board")[1]["themes"]}
    call(env, "POST", f"/api/themes/{ids['Skills A']}/merge", {"into": ids["Skills B"]})
    assert list(themes(env)) == ["Skills B"]
    assert call(env, "GET", "/api/state")[1]["merge_suggestions"] == []


def test_sorter_survives_unexpected_errors_and_reports_them():
    from server.app import Sorter
    import time as _t
    errors, runs = [], []

    def boom(include_unsorted=False):
        runs.append(include_unsorted)
        if len(runs) == 1:
            _t.sleep(0.2)
            raise BrokenPipeError("claude went away")

    s = Sorter(boom, background=True, on_error=errors.append)
    s.request()
    s.request(include_unsorted=True)  # queued while the first run is failing
    for _ in range(50):
        if not s.running:
            break
        _t.sleep(0.05)
    assert s.running is False
    assert runs == [False, True]
    assert "claude went away" in str(errors[0])
    s.request()
    _t.sleep(0.2)
    assert len(runs) == 3


# --- bulk & theme actions ---------------------------------------------------------

def ids_by_title(env):
    return {t["title"]: t["id"] for th in call(env, "GET", "/api/board")[1]["themes"] for t in th["tabs"]}


def test_bulk_done_and_delete(env):
    sweep(env, [tab("https://a"), tab("https://b"), tab("https://c")])
    ids = ids_by_title(env)
    assert call(env, "POST", "/api/tabs/bulk", {"ids": [ids["https://a"], ids["https://b"]], "action": "check"})[0] == 200
    assert sorted(t["title"] for t in call(env, "GET", "/api/completed")[1]["tabs"]) == ["https://a", "https://b"]
    call(env, "POST", "/api/tabs/bulk", {"ids": [ids["https://a"], ids["https://c"]], "action": "remove"})
    assert [t["title"] for t in call(env, "GET", "/api/completed")[1]["tabs"]] == ["https://b"]
    assert themes(env) == {}


def test_bulk_move_keeps_selection_order_at_top(env):
    sweep(env, [tab("https://a"), tab("https://b"), tab("https://c")])
    ids = ids_by_title(env)
    call(env, "POST", "/api/tabs/bulk", {"ids": [ids["https://a"], ids["https://c"]], "action": "move", "theme": "Picked"})
    assert themes(env) == {"Sorted": ["https://b"], "Picked": ["https://a", "https://c"]}


def test_bulk_snooze(env, clock):
    sweep(env, [tab("https://a"), tab("https://b")])
    ids = ids_by_title(env)
    call(env, "POST", "/api/tabs/bulk", {"ids": [ids["https://a"]], "action": "snooze", "until": clock() + DAY})
    assert themes(env) == {"Sorted": ["https://b"]}


def test_bulk_rejects_unknown_action(env):
    assert call(env, "POST", "/api/tabs/bulk", {"ids": [1], "action": "explode"})[0] == 400


def test_theme_done_and_delete(env):
    sweep(env, [tab("https://a"), tab("https://b")])
    tid = call(env, "GET", "/api/board")[1]["themes"][0]["id"]
    call(env, "POST", f"/api/themes/{tid}/done", {})
    assert len(call(env, "GET", "/api/completed")[1]["tabs"]) == 2
    call(env, "POST", f"/api/themes/{tid}/delete", {})
    assert len(call(env, "GET", "/api/completed")[1]["tabs"]) == 2  # history survives the delete
    assert themes(env) == {}


def test_dissolve_resorts_the_tabs(env):
    sweep(env, [tab("https://a"), tab("https://b")])
    tid = call(env, "GET", "/api/board")[1]["themes"][0]["id"]
    env["store"].rename_theme(tid, "Bad grouping")
    call(env, "POST", f"/api/themes/{tid}/dissolve", {})
    assert themes(env) == {"Sorted": ["https://b", "https://a"]}  # fake sorter re-filed them


def test_later_round_trip(env):
    sweep(env, [tab("https://a")])
    tid = call(env, "GET", "/api/board")[1]["themes"][0]["id"]
    call(env, "POST", f"/api/themes/{tid}/later", {"on": True})
    board = call(env, "GET", "/api/board")[1]
    assert (board["themes"], [t["name"] for t in board["later_themes"]]) == ([], ["Sorted"])
    call(env, "POST", f"/api/themes/{tid}/later", {"on": False})
    assert list(themes(env)) == ["Sorted"]


# --- remove / restore / add ---------------------------------------------------------

def test_remove_and_restore_round_trip(env):
    sweep(env, [tab("https://a"), tab("https://b")])
    ids = ids_by_title(env)
    assert call(env, "POST", f"/api/tabs/{ids['https://a']}/remove", {})[0] == 200
    assert themes(env) == {"Sorted": ["https://b"]}
    call(env, "POST", "/api/tabs/restore", {"ids": [ids["https://a"]]})
    assert sorted(themes(env)["Sorted"]) == ["https://a", "https://b"]


def test_bulk_remove(env):
    sweep(env, [tab("https://a"), tab("https://b")])
    ids = ids_by_title(env)
    call(env, "POST", "/api/tabs/bulk", {"ids": list(ids.values()), "action": "remove"})
    assert themes(env) == {}
    assert call(env, "GET", "/api/completed")[1]["tabs"] == []


def test_add_tab_to_a_named_theme(env):
    sweep(env, [tab("https://a")])
    status, body = call(env, "POST", "/api/tabs/add", {"url": "https://new", "title": "New page", "theme": "Sorted"})
    assert status == 200 and body["theme"] == "Sorted"
    assert themes(env)["Sorted"][0] == "New page"


def test_add_tab_without_theme_lets_claude_sort_it(env):
    call(env, "POST", "/api/tabs/add", {"url": "https://new", "title": "New page"})
    assert themes(env) == {"Sorted": ["New page"]}  # fake sorter filed it
    assert env["sorted"]


def test_add_tab_rejects_non_web_urls(env):
    assert call(env, "POST", "/api/tabs/add", {"url": "chrome://settings", "title": "x"})[0] == 400


# --- configurable numbers ------------------------------------------------------------

@pytest.mark.parametrize("key, good, bad", [
    ("done_retention_days", 30, 0),
    ("stale_hours", 48, 0),
    ("theme_stale_days", 14, 0),
    ("unload_idle_hours", 12, 200),
    ("memory_check_minutes", 10, 0),
    ("open_tabs_max", 12, 13),
    ("min_tabs_new_theme", 3, 0),
    ("text_chars", 2000, 2001),
    ("batch_size", 50, 51),
    ("sweep_time", "07:30", "25:00"),
    ("snooze_time", "09:15", "9am"),
])
def test_settings_are_validated_against_their_limits(env, key, good, bad):
    assert call(env, "PATCH", "/api/settings", {key: good})[1][key] == good
    assert call(env, "PATCH", "/api/settings", {key: bad})[0] == 400
    assert call(env, "GET", "/api/state")[1]["settings"][key] == good


def test_defaults(env):
    s = call(env, "GET", "/api/state")[1]["settings"]
    assert {k: s[k] for k in ("done_retention_days", "stale_hours", "theme_stale_days", "unload_idle_hours",
                              "memory_check_minutes", "open_tabs_max", "min_tabs_new_theme", "text_chars",
                              "batch_size", "sweep_time", "snooze_time", "tab_memory_cap_mb")} == {
        "done_retention_days": 60, "stale_hours": 96, "theme_stale_days": 14, "unload_idle_hours": 24,
        "memory_check_minutes": 5, "open_tabs_max": 6, "min_tabs_new_theme": 2, "text_chars": 1500,
        "batch_size": 40, "sweep_time": "19:00", "snooze_time": "08:00", "tab_memory_cap_mb": 2048,
    }
