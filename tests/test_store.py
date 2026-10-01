import pytest

from server.store import DAY, Store


class Clock:
    def __init__(self, t=1_800_000_000.0):
        self.t = t

    def __call__(self):
        return self.t

    def advance(self, days):
        self.t += days * DAY


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def store(tmp_path, clock):
    return Store(tmp_path / "t.db", now=clock)


def cap(url, title=None, **kw):
    return {"url": url, "title": title or url, **kw}


def board_theme(board, name):
    return next(t for t in board["themes"] if t["name"] == name)


def open_titles(theme):
    return [t["title"] for t in theme["tabs"] if t["status"] == "open"]


def add_to_theme(store, theme, *urls):
    ids = store.capture([cap(u) for u in urls])
    for i in ids:
        store.assign(i, theme)
    return ids


# --- capture & ordering -------------------------------------------------------

def test_newly_assigned_tab_lands_at_top_of_theme(store):
    add_to_theme(store, "SQL", "https://a")
    add_to_theme(store, "SQL", "https://b")
    assert open_titles(board_theme(store.board(), "SQL")) == ["https://b", "https://a"]


def test_recapturing_same_url_updates_instead_of_duplicating(store, clock):
    (first,) = add_to_theme(store, "SQL", "https://a")
    clock.advance(2)
    (again,) = store.capture([cap("https://a", "A renamed")])
    assert again == first
    tabs = board_theme(store.board(), "SQL")["tabs"]
    assert len(tabs) == 1
    assert tabs[0]["title"] == "A renamed"
    assert tabs[0]["last_seen_at"] == clock()


def test_uncaptured_tabs_are_pending_until_assigned(store):
    ids = store.capture([cap("https://a"), cap("https://b")])
    assert [t["id"] for t in store.pending_sort()] == ids
    store.assign(ids[0], "SQL")
    assert [t["id"] for t in store.pending_sort()] == [ids[1]]


def test_reorder_within_theme_persists(store):
    a, b, c = add_to_theme(store, "SQL", "https://a", "https://b", "https://c")
    # board order is c, b, a — move a to the top
    store.move_tab(a, theme=None, index=0)
    assert open_titles(board_theme(store.board(), "SQL")) == ["https://a", "https://c", "https://b"]


# --- completion ----------------------------------------------------------------

def test_checked_tab_goes_to_bottom_as_done(store, clock):
    a, b = add_to_theme(store, "SQL", "https://a", "https://b")
    store.check(b)
    tabs = board_theme(store.board(), "SQL")["tabs"]
    assert [(t["title"], t["status"]) for t in tabs] == [("https://a", "open"), ("https://b", "done")]
    assert tabs[1]["completed_at"] == clock()


def test_done_tabs_in_theme_most_recent_first(store, clock):
    a, b, c = add_to_theme(store, "SQL", "https://a", "https://b", "https://c")
    store.check(a)
    clock.advance(1)
    store.check(b)
    tabs = board_theme(store.board(), "SQL")["tabs"]
    assert [t["title"] for t in tabs] == ["https://c", "https://b", "https://a"]


def test_unchecked_tab_returns_to_top_of_open_tabs(store):
    a, b, c = add_to_theme(store, "SQL", "https://a", "https://b", "https://c")
    store.check(a)
    store.uncheck(a)
    assert open_titles(board_theme(store.board(), "SQL")) == ["https://a", "https://c", "https://b"]


def test_fully_completed_theme_leaves_board_but_stays_in_completed(store):
    (a,) = add_to_theme(store, "SQL", "https://a")
    store.check(a)
    assert "SQL" not in [t["name"] for t in store.board()["themes"]]
    assert [(t["title"], t["theme"]) for t in store.completed()] == [("https://a", "SQL")]


def test_completed_is_newest_first(store, clock):
    a, b = add_to_theme(store, "SQL", "https://a", "https://b")
    store.check(a)
    clock.advance(1)
    store.check(b)
    assert [t["title"] for t in store.completed()] == ["https://b", "https://a"]


def test_purge_removes_done_tabs_after_45_days_only(store, clock):
    a, b = add_to_theme(store, "SQL", "https://a", "https://b")
    store.check(a)
    clock.advance(1)
    store.check(b)
    clock.advance(44.5)  # a is 45.5 days old, b is 44.5
    store.purge()
    assert [t["title"] for t in store.completed()] == ["https://b"]


# --- snooze ----------------------------------------------------------------------

def test_snoozed_tab_hidden_then_returns_on_top_marked_back(store, clock):
    a, b = add_to_theme(store, "SQL", "https://a", "https://b")
    store.snooze_tab(a, until=clock() + 2 * DAY)
    assert open_titles(board_theme(store.board(), "SQL")) == ["https://b"]
    clock.advance(3)
    tabs = board_theme(store.board(), "SQL")["tabs"]
    assert [(t["title"], t["back"]) for t in tabs] == [("https://a", True), ("https://b", False)]


def test_snoozed_theme_hidden_then_returns_marked_back(store, clock):
    add_to_theme(store, "SQL", "https://a")
    tid = board_theme(store.board(), "SQL")["id"]
    store.snooze_theme(tid, until=clock() + DAY)
    assert "SQL" not in [t["name"] for t in store.board()["themes"]]
    assert [t["name"] for t in store.board()["snoozed_themes"]] == ["SQL"]
    clock.advance(2)
    assert board_theme(store.board(), "SQL")["back"] is True


def test_acting_on_a_back_tab_clears_the_marker(store, clock):
    (a,) = add_to_theme(store, "SQL", "https://a")
    store.snooze_tab(a, until=clock() + DAY)
    clock.advance(2)
    store.board()
    store.move_tab(a, theme=None, index=0)
    assert board_theme(store.board(), "SQL")["tabs"][0]["back"] is False


# --- staleness ------------------------------------------------------------------

def test_theme_untouched_for_7_days_is_stale(store, clock):
    add_to_theme(store, "SQL", "https://a")
    clock.advance(6.9)
    assert board_theme(store.board(), "SQL")["stale"] is False
    clock.advance(0.2)
    assert board_theme(store.board(), "SQL")["stale"] is True


@pytest.mark.parametrize("action", ["check", "snooze", "opened", "added"])
def test_touching_a_theme_resets_staleness(store, clock, action):
    a, b = add_to_theme(store, "SQL", "https://a", "https://b")
    clock.advance(8)
    if action == "check":
        store.check(a)
    elif action == "snooze":
        store.snooze_tab(a, until=clock() + DAY)
    elif action == "opened":
        store.mark_opened([a])
    else:
        add_to_theme(store, "SQL", "https://c")
    assert board_theme(store.board(), "SQL")["stale"] is False


# --- themes & corrections -------------------------------------------------------

def test_ai_created_themes_are_unranked_with_suggestion(store):
    store.create_theme("Team PRs", position=0)
    store.create_theme("SQL research", suggested_position=1)
    add_to_theme(store, "Team PRs", "https://a")
    add_to_theme(store, "SQL research", "https://b")
    board = store.board()
    assert [(t["name"], t["ranked"]) for t in board["themes"]] == [
        ("Team PRs", True),
        ("SQL research", False),
    ]
    assert board_theme(board, "SQL research")["suggested_position"] == 1


def test_reorder_themes_ranks_them(store):
    add_to_theme(store, "A", "https://a")
    add_to_theme(store, "B", "https://b")
    ids = {t["name"]: t["id"] for t in store.board()["themes"]}
    store.reorder_themes([ids["B"], ids["A"]])
    assert [(t["name"], t["ranked"]) for t in store.board()["themes"]] == [("B", True), ("A", True)]


def test_reorder_themes_unranks_themes_left_out(store):
    add_to_theme(store, "A", "https://a")
    add_to_theme(store, "B", "https://b")
    ids = {t["name"]: t["id"] for t in store.board()["themes"]}
    store.reorder_themes([ids["A"], ids["B"]])
    store.reorder_themes([ids["B"]])
    assert [(t["name"], t["ranked"]) for t in store.board()["themes"]] == [("B", True), ("A", False)]


def test_moving_tab_across_themes_records_correction(store):
    (a,) = add_to_theme(store, "Misc", "https://github.com/x/pr/1")
    add_to_theme(store, "Team PRs", "https://b")
    store.move_tab(a, theme="Team PRs", index=0)
    assert open_titles(board_theme(store.board(), "Team PRs"))[0] == "https://github.com/x/pr/1"
    (c,) = store.corrections()
    assert c["kind"] == "move"
    assert c["detail"] == {"title": "https://github.com/x/pr/1", "url": "https://github.com/x/pr/1",
                           "from": "Misc", "to": "Team PRs"}


def test_rename_theme_records_correction(store):
    add_to_theme(store, "Misc", "https://a")
    tid = board_theme(store.board(), "Misc")["id"]
    store.rename_theme(tid, "Garden ideas")
    assert [t["name"] for t in store.board()["themes"]] == ["Garden ideas"]
    assert store.corrections()[0]["detail"] == {"from": "Misc", "to": "Garden ideas"}


def test_merge_moves_tabs_and_removes_source(store):
    add_to_theme(store, "Skills A", "https://a")
    add_to_theme(store, "Skills B", "https://b")
    ids = {t["name"]: t["id"] for t in store.board()["themes"]}
    store.merge_themes(ids["Skills A"], into=ids["Skills B"])
    board = store.board()
    assert [t["name"] for t in board["themes"]] == ["Skills B"]
    assert sorted(open_titles(board_theme(board, "Skills B"))) == ["https://a", "https://b"]
    assert store.corrections()[0]["kind"] == "merge"


def test_corrections_newest_first_and_limited(store):
    add_to_theme(store, "T0", "https://a")
    tid = board_theme(store.board(), "T0")["id"]
    for i in range(1, 26):
        store.rename_theme(tid, f"T{i}")
    got = store.corrections(limit=20)
    assert len(got) == 20
    assert got[0]["detail"]["to"] == "T25"


def test_active_theme_names_exclude_empty_and_completed(store):
    add_to_theme(store, "Live", "https://a")
    (b,) = add_to_theme(store, "Finished", "https://b")
    store.check(b)
    store.create_theme("Empty")
    assert store.active_theme_names() == ["Live"]


def test_sortable_theme_names_include_seeded_empty_but_not_completed(store):
    add_to_theme(store, "Live", "https://a")
    (b,) = add_to_theme(store, "Finished", "https://b")
    store.check(b)
    store.create_theme("Seeded from tab group")
    assert store.sortable_theme_names() == ["Live", "Seeded from tab group"]


def test_theme_names_lists_every_theme(store):
    add_to_theme(store, "Live", "https://a")
    store.create_theme("Seeded")
    assert store.theme_names() == ["Live", "Seeded"]


# --- settings -------------------------------------------------------------------

def test_settings_round_trip_with_default(store):
    assert store.get_setting("model", "sonnet") == "sonnet"
    store.set_setting("model", "opus")
    assert store.get_setting("model", "sonnet") == "opus"
    store.set_setting("keep_open", ["a", "b"])
    assert store.get_setting("keep_open") == ["a", "b"]


def test_unsorted_is_always_listed_last(store):
    add_to_theme(store, "Unsorted", "https://u")
    add_to_theme(store, "Later theme", "https://a")
    assert [t["name"] for t in store.board()["themes"]] == ["Later theme", "Unsorted"]


def test_recaptured_done_tab_is_reopened_at_top(store):
    a, b = add_to_theme(store, "SQL", "https://a", "https://b")
    store.check(a)
    store.capture([cap("https://a")])
    tabs = board_theme(store.board(), "SQL")["tabs"]
    assert [(t["title"], t["status"], t["completed_at"]) for t in tabs] == [
        ("https://a", "open", None), ("https://b", "open", None),
    ]


def test_opening_a_tab_cancels_its_pending_close(store):
    a, b = store.capture([cap("https://a"), cap("https://b")], pending_close=True)
    store.mark_opened([a])
    assert store.pending_close_urls() == ["https://b"]


def test_pending_close_reports_capture_time(store, clock):
    store.capture([cap("https://a")], pending_close=True)
    assert store.pending_close() == [{"url": "https://a", "last_seen_at": clock()}]


# --- bulk & delete ------------------------------------------------------------

def test_delete_tabs_removes_them_everywhere(store):
    a, b = store.capture([cap("https://a"), cap("https://b")], pending_close=True)
    store.assign(a, "SQL")
    store.assign(b, "SQL")
    store.check(b)
    store.delete_tabs([a, b])
    assert store.board()["themes"] == []
    assert store.completed() == []
    assert store.pending_close_urls() == []


def test_deleting_a_themes_last_tab_removes_the_theme(store):
    (a,) = add_to_theme(store, "Old idea", "https://a")
    add_to_theme(store, "Keep", "https://b")
    store.delete_tabs([a])
    assert store.theme_names() == ["Keep"]
    assert store.sortable_theme_names() == ["Keep"]


def test_delete_theme_removes_its_tabs_and_itself(store):
    add_to_theme(store, "Gone", "https://a", "https://b")
    add_to_theme(store, "Keep", "https://c")
    tid = board_theme(store.board(), "Gone")["id"]
    store.delete_theme(tid)
    assert store.theme_names() == ["Keep"]
    assert [t["title"] for t in board_theme(store.board(), "Keep")["tabs"]] == ["https://c"]


def test_mark_theme_done_ticks_every_open_tab(store, clock):
    a, b = add_to_theme(store, "SQL", "https://a", "https://b")
    tid = board_theme(store.board(), "SQL")["id"]
    store.mark_theme_done(tid)
    assert sorted(t["title"] for t in store.completed()) == ["https://a", "https://b"]
    assert all(t["completed_at"] == clock() for t in store.completed())


def test_dissolve_theme_sends_tabs_back_for_sorting(store):
    a, b = add_to_theme(store, "Bad grouping", "https://a", "https://b")
    tid = board_theme(store.board(), "Bad grouping")["id"]
    store.dissolve_theme(tid)
    assert store.theme_names() == []
    assert sorted(t["id"] for t in store.pending_sort()) == [a, b]
    c = store.corrections()[0]
    assert (c["kind"], c["detail"]) == ("dissolve", {"theme": "Bad grouping"})


def test_dissolve_keeps_completed_history(store):
    a, b = add_to_theme(store, "Bad grouping", "https://a", "https://b")
    store.check(a)
    store.dissolve_theme(board_theme(store.board(), "Bad grouping")["id"])
    assert [(t["title"], t["theme"]) for t in store.completed()] == [("https://a", "Unsorted")]
    assert [t["id"] for t in store.pending_sort()] == [b]
