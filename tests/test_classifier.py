import json
import sys
import time
from pathlib import Path

import pytest

from server.classifier import (
    UNSORTED,
    ClaudeRunner,
    SortError,
    apply_rules,
    build_prompt,
    sort_pending,
)
from server.store import Store

FAKE = Path(__file__).with_name("fake_claude.py")


@pytest.fixture
def home(tmp_path, monkeypatch):
    h = tmp_path / "home"
    h.mkdir()
    monkeypatch.setenv("HOME", str(h))
    return h


@pytest.fixture
def claude_bin(tmp_path):
    exe = tmp_path / "claude"
    exe.write_text(f"#!{sys.executable}\n" + FAKE.read_text())
    exe.chmod(0o755)
    return exe


@pytest.fixture
def runner(claude_bin):
    return ClaudeRunner(claude_path=str(claude_bin), timeout=2)


def set_mode(home, mode):
    (home / "mode").write_text(mode)


def set_output(home, out):
    (home / "output.json").write_text(json.dumps(out))


def calls(home):
    f = home / "calls.jsonl"
    return [json.loads(l) for l in f.read_text().splitlines()] if f.exists() else []


def prompt_calls(home):
    return [c for c in calls(home) if "stdin" in c]


TABS = [
    {"id": 1, "url": "https://github.com/acme/api/pull/12", "title": "Fix auth #12", "text": None, "group_hint": None},
    {"id": 2, "url": "https://github.com/acme/web/pull/7", "title": "Add dashboard #7", "text": None, "group_hint": None},
    {"id": 3, "url": "https://acme.test/blog/sql", "title": "What is SQL", "text": "SQL is...", "group_hint": "SQL"},
]


# --- apply_rules ---------------------------------------------------------------

def test_existing_theme_matched_case_insensitively():
    out = {"assignments": [{"id": 3, "theme": "sql research"}]}
    assert apply_rules(TABS[2:], out, active=["SQL Research"]) == {3: "SQL Research"}


def test_new_theme_needs_two_tabs():
    one = {"assignments": [{"id": 1, "theme": "Team PRs"}, {"id": 3, "theme": "SQL"}]}
    assert apply_rules(TABS, one, active=[]) == {1: UNSORTED, 2: UNSORTED, 3: UNSORTED}
    two = {"assignments": [{"id": 1, "theme": "Team PRs"}, {"id": 2, "theme": "Team PRs"},
                           {"id": 3, "theme": "SQL"}]}
    assert apply_rules(TABS, two, active=[]) == {1: "Team PRs", 2: "Team PRs", 3: UNSORTED}


def test_new_themes_capped_at_15_active_largest_first():
    active = [f"T{i}" for i in range(14)]
    tabs = [{"id": i, "url": f"https://x/{i}", "title": str(i)} for i in range(5)]
    out = {"assignments": [
        {"id": 0, "theme": "Small"}, {"id": 1, "theme": "Small"},
        {"id": 2, "theme": "Big"}, {"id": 3, "theme": "Big"}, {"id": 4, "theme": "Big"},
    ]}
    assert apply_rules(tabs, out, active=active) == {
        0: UNSORTED, 1: UNSORTED, 2: "Big", 3: "Big", 4: "Big",
    }


def test_unknown_ids_ignored_and_missing_tabs_unsorted():
    out = {"assignments": [{"id": 99, "theme": "X"}, {"id": 3, "theme": "SQL"}]}
    assert apply_rules(TABS[2:], out, active=["SQL"]) == {3: "SQL"}
    assert apply_rules(TABS[:1], {"assignments": []}, active=[]) == {1: UNSORTED}


def test_ai_cannot_invent_unsorted_variants():
    out = {"assignments": [{"id": 1, "theme": "unsorted"}]}
    assert apply_rules(TABS[:1], out, active=[]) == {1: UNSORTED}


# --- build_prompt --------------------------------------------------------------

def test_prompt_contains_tabs_themes_and_corrections():
    corrections = [{"kind": "move", "detail": {"title": "Fix auth #12", "url": "u", "from": "Misc", "to": "Team PRs"}}]
    p = build_prompt(TABS, active={"Team PRs": ["Old PR"]}, corrections=corrections)
    assert '"id": 1' in p and "Fix auth #12" in p
    assert "Team PRs" in p and "Old PR" in p
    assert "Misc" in p  # correction shown
    assert '"group": "SQL"' in p


def test_prompt_truncates_page_text_to_1500_chars():
    tab = {**TABS[2], "text": "x" * 5000}
    p = build_prompt([tab], active={}, corrections=[])
    assert "x" * 1500 in p and "x" * 1501 not in p


# --- ClaudeRunner ------------------------------------------------------------------

def test_success_returns_output_and_model_used(home, runner):
    set_output(home, {"assignments": [{"id": 1, "theme": "PRs"}]})
    out, model = runner.run("prompt text", schema={"type": "object"}, model="sonnet", fallback="haiku")
    assert out == {"assignments": [{"id": 1, "theme": "PRs"}]}
    assert model == "claude-sonnet-5-5"
    (call,) = prompt_calls(home)
    argv = call["argv"]
    assert argv[argv.index("--model") + 1] == "sonnet"
    assert argv[argv.index("--fallback-model") + 1] == "haiku"
    assert argv[argv.index("--tools") + 1] == ""
    assert argv[argv.index("--setting-sources") + 1] == ""
    assert call["stdin"] == "prompt text"


def test_child_env_never_carries_api_keys(home, runner, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "tok")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "http://proxy")
    runner.run("p", schema={}, model="sonnet", fallback="haiku")
    for c in calls(home):
        assert not any(k.startswith("ANTHROPIC_") for k in c["env"]), c["env"]


@pytest.mark.parametrize("mode", ["logged_out", "api_key_auth"])
def test_non_subscription_login_blocks_before_any_prompt(home, runner, mode):
    set_mode(home, mode)
    with pytest.raises(SortError) as e:
        runner.run("p", schema={}, model="sonnet", fallback="haiku")
    assert e.value.kind == "auth"
    assert prompt_calls(home) == []


def test_api_key_source_kills_call_before_result(home, runner):
    set_mode(home, "api_key_source")
    t0 = time.monotonic()
    with pytest.raises(SortError) as e:
        runner.run("p", schema={}, model="sonnet", fallback="haiku")
    assert e.value.kind == "auth"
    assert time.monotonic() - t0 < 2.5
    time.sleep(3.2)  # give a surviving process time to write its marker
    assert not any(c.get("result_emitted") for c in calls(home))


def test_unavailable_model_reported_as_model_error(home, runner):
    set_mode(home, "bad_model")
    with pytest.raises(SortError) as e:
        runner.run("p", schema={}, model="sonnet-9", fallback="haiku")
    assert e.value.kind == "model"


def test_hanging_call_times_out(home, runner):
    set_mode(home, "hang")
    t0 = time.monotonic()
    with pytest.raises(SortError) as e:
        runner.run("p", schema={}, model="sonnet", fallback="haiku")
    assert e.value.kind == "timeout"
    assert time.monotonic() - t0 < 4


def test_missing_structured_output_is_bad_output(home, runner):
    set_mode(home, "garbage")
    with pytest.raises(SortError) as e:
        runner.run("p", schema={}, model="sonnet", fallback="haiku")
    assert e.value.kind == "bad_output"


# --- sort_pending (store + runner) ------------------------------------------------

@pytest.fixture
def store(tmp_path):
    return Store(tmp_path / "t.db")


def open_by_theme(store):
    return {t["name"]: sorted(x["title"] for x in t["tabs"]) for t in store.board()["themes"]}


def test_sort_pending_assigns_and_records_model(home, runner, store):
    ids = store.capture([{"url": f"https://x/{i}", "title": f"t{i}"} for i in range(3)])
    set_output(home, {"assignments": [{"id": ids[0], "theme": "A"}, {"id": ids[1], "theme": "A"},
                                      {"id": ids[2], "theme": "B"}]})
    sort_pending(store, runner)
    assert open_by_theme(store) == {"A": ["t0", "t1"], UNSORTED: ["t2"]}
    assert store.get_setting("last_model") == "claude-sonnet-5-5"
    assert store.get_setting("sort_error") is None


def test_sort_pending_uses_model_setting(home, runner, store):
    store.capture([{"url": "https://x/1", "title": "t"}])
    store.set_setting("model", "opus")
    sort_pending(store, runner)
    argv = prompt_calls(home)[0]["argv"]
    assert argv[argv.index("--model") + 1] == "opus"


def test_sort_failure_moves_tabs_to_unsorted_and_records_error(home, runner, store):
    store.capture([{"url": "https://x/1", "title": "t1"}])
    set_mode(home, "logged_out")
    sort_pending(store, runner)
    assert open_by_theme(store) == {UNSORTED: ["t1"]}
    assert store.get_setting("sort_error")["kind"] == "auth"


def test_resort_retries_unsorted_and_clears_error(home, runner, store):
    (i,) = store.capture([{"url": "https://x/1", "title": "t1"}])
    set_mode(home, "logged_out")
    sort_pending(store, runner)
    set_mode(home, "ok")
    (j,) = store.capture([{"url": "https://x/2", "title": "t2"}])
    set_output(home, {"assignments": [{"id": i, "theme": "Pair"}, {"id": j, "theme": "Pair"}]})
    sort_pending(store, runner, include_unsorted=True)
    assert open_by_theme(store) == {"Pair": ["t1", "t2"]}
    assert store.get_setting("sort_error") is None


def test_large_sweeps_are_batched_by_40(home, runner, store):
    store.capture([{"url": f"https://x/{i}", "title": f"t{i}"} for i in range(90)])
    sort_pending(store, runner)
    sizes = [p["stdin"].count('"url"') for p in prompt_calls(home)]
    assert sizes == [40, 40, 10]


def test_merge_suggestions_saved_only_for_existing_themes(home, runner, store):
    for name in ("Skills A", "Skills B"):
        (i,) = store.capture([{"url": f"https://{name}", "title": name}])
        store.assign(i, name)
    store.capture([{"url": "https://new", "title": "n"}])
    set_output(home, {"assignments": [], "merge_suggestions": [
        {"from": "Skills A", "into": "Skills B", "reason": "same topic"},
        {"from": "Ghost", "into": "Skills B", "reason": "x"},
    ]})
    sort_pending(store, runner)
    assert store.get_setting("merge_suggestions") == [
        {"from": "Skills A", "into": "Skills B", "reason": "same topic"}
    ]


def test_single_tab_may_join_seeded_tab_group_theme(home, runner, store):
    store.create_theme("Travel planning")
    (i,) = store.capture([{"url": "https://linkedin.com/in/x", "title": "Jane"}])
    set_output(home, {"assignments": [{"id": i, "theme": "Travel planning"}]})
    sort_pending(store, runner)
    assert open_by_theme(store) == {"Travel planning": ["Jane"]}
    assert "Travel planning" in prompt_calls(home)[0]["stdin"]


def test_missing_init_event_is_rejected(home, runner):
    set_mode(home, "no_init")
    with pytest.raises(SortError) as e:
        runner.run("p", schema={}, model="sonnet", fallback="haiku")
    assert e.value.kind == "auth"
