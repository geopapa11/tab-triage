"""Sort captured tabs into themes with `claude -p`, on the Claude subscription only.

Subscription guard (no path can bill an API key):
  1. The child gets a minimal env — no ANTHROPIC_* variables ever reach it.
  2. `claude auth status` must report a claude.ai login before any prompt is sent.
  3. The call's init event must report apiKeySource == "none"; otherwise the process is
     killed before a result is produced.
"""

import json
import os
import signal
import subprocess
import tempfile
import threading
import time
from collections import Counter
from pathlib import Path

UNSORTED = "Unsorted"
SPECIAL_THEMES = {UNSORTED, "Email follow-ups"}
MAX_THEMES = 15
BATCH_SIZE = 40
TEXT_LIMIT = 1500
DEFAULT_CLAUDE = str(Path.home() / ".local/bin/claude")

OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "assignments": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"id": {"type": "integer"}, "theme": {"type": "string"}},
                "required": ["id", "theme"],
            },
        },
        "merge_suggestions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "from": {"type": "string"},
                    "into": {"type": "string"},
                    "reason": {"type": "string"},
                },
                "required": ["from", "into", "reason"],
            },
        },
    },
    "required": ["assignments"],
}


class SortError(Exception):
    """kind: auth | model | timeout | bad_output | failed"""

    def __init__(self, kind, message):
        super().__init__(message)
        self.kind = kind


def minimal_env():
    env = {k: os.environ[k] for k in ("HOME", "USER", "LOGNAME", "TMPDIR", "LANG") if k in os.environ}
    env["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"
    return env


class ClaudeRunner:
    def __init__(self, claude_path=DEFAULT_CLAUDE, timeout=300):
        self.claude_path = claude_path
        self.timeout = timeout

    def check_auth(self):
        try:
            proc = subprocess.run(
                [self.claude_path, "auth", "status"], env=minimal_env(), capture_output=True,
                text=True, timeout=30, cwd=tempfile.gettempdir(),
            )
            status = json.loads(proc.stdout)
        except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError) as e:
            raise SortError("auth", f"could not read Claude login status: {e}") from e
        if not status.get("loggedIn") or status.get("authMethod") != "claude.ai":
            raise SortError(
                "auth",
                f"Claude is not logged in with a claude.ai subscription "
                f"(authMethod={status.get('authMethod')!r}). Run `claude auth login`.",
            )
        return status

    def run(self, prompt, schema, model, fallback):
        """Returns (structured_output, model_used). Raises SortError."""
        self.check_auth()
        cmd = [
            self.claude_path, "-p", "--setting-sources", "", "--model", model, "--fallback-model", fallback,
            "--tools", "", "--strict-mcp-config", "--no-session-persistence",
            "--output-format", "stream-json", "--verbose", "--json-schema", json.dumps(schema),
        ]
        with tempfile.TemporaryFile() as stderr:
            proc = subprocess.Popen(
                cmd, env=minimal_env(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=stderr, text=True, cwd=tempfile.gettempdir(), start_new_session=True,
            )
            timed_out = threading.Event()

            def kill():
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    # macOS reports EPERM, not ESRCH, once only zombies remain in the group.
                    pass

            def on_timeout():
                timed_out.set()
                kill()

            timer = threading.Timer(self.timeout, on_timeout)
            timer.start()
            init, result = {}, None
            try:
                proc.stdin.write(prompt)
                proc.stdin.close()
                for line in proc.stdout:
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if event.get("type") == "system" and event.get("subtype") == "init":
                        init = event
                        if event.get("apiKeySource") != "none":
                            kill()
                            raise SortError(
                                "auth",
                                f"claude would use an API key ({event.get('apiKeySource')}); aborted.",
                            )
                    elif event.get("type") == "result":
                        result = event
                proc.wait()
            finally:
                timer.cancel()
                kill()

        if timed_out.is_set():
            raise SortError("timeout", f"claude did not answer within {self.timeout}s")
        if not init:
            raise SortError("auth", "claude sent no init event, so its auth source is unknown; result discarded")
        if result is None:
            raise SortError("failed", f"claude exited with code {proc.returncode} and no result")
        if result.get("is_error"):
            message = str(result.get("result", ""))
            kind = "model" if "selected model" in message else "failed"
            raise SortError(kind, message)
        output = result.get("structured_output")
        if not isinstance(output, dict) or not isinstance(output.get("assignments"), list):
            raise SortError("bad_output", "claude returned no structured assignments")
        model_used = next(iter(result.get("modelUsage") or {}), init.get("model", model))
        return output, model_used


def build_prompt(tabs, active, corrections, text_limit=TEXT_LIMIT, min_tabs=2):
    """active: {theme name: [sample tab titles]}"""
    lines = [
        "You sort someone's saved browser tabs into themes. A theme is a task or project, "
        "e.g. 'Team PR reviews', 'Trip to Lisbon', 'Laptops to compare'.",
        "",
        "Rules:",
        "- Reuse an existing theme whenever one fits. Use its exact name.",
        f"- Only invent a new theme when at least {min_tabs} tab(s) in this batch belong to it.",
        f"- A tab that fits nowhere goes to \"{UNSORTED}\".",
        "- Theme names are short (2-5 words) and describe the task, not the website.",
        "- A tab's \"group\" is a Chrome tab-group name the person chose; treat it as a strong hint.",
        "- Optionally suggest merges between existing themes that clearly overlap.",
        "- Return an assignment for every tab id.",
        "",
        "Existing themes with sample tabs:",
        json.dumps(active, ensure_ascii=False, indent=1) if active else "(none yet)",
        "",
    ]
    if corrections:
        lines.append("Recent corrections by the person (learn from these):")
        for c in corrections:
            d = c["detail"]
            if c["kind"] == "move":
                lines.append(f"- moved \"{d['title']}\" from \"{d['from']}\" to \"{d['to']}\"")
            elif c["kind"] == "rename":
                lines.append(f"- renamed theme \"{d['from']}\" to \"{d['to']}\"")
            elif c["kind"] == "merge":
                lines.append(f"- merged theme \"{d['from']}\" into \"{d['into']}\"")
            elif c["kind"] == "dissolve":
                lines.append(f"- dissolved theme \"{d['theme']}\" (a bad grouping: do not create it again)")
        lines.append("")
    lines.append("Tabs:")
    for t in tabs:
        entry = {"id": t["id"], "title": t["title"], "url": t["url"]}
        if t.get("group_hint"):
            entry["group"] = t["group_hint"]
        if t.get("text"):
            entry["text"] = t["text"][:text_limit]
        lines.append(json.dumps(entry, ensure_ascii=False))
    return "\n".join(lines)


MIN_TABS_NEW_THEME = 2


def apply_rules(tabs, output, active, max_themes=MAX_THEMES, min_tabs=MIN_TABS_NEW_THEME):
    """Map every tab id to a final theme name, enforcing the theme rules."""
    ids = [t["id"] for t in tabs]
    canon = {name.lower(): name for name in active}
    proposed = {}
    for a in output.get("assignments", []):
        if a.get("id") in ids and isinstance(a.get("theme"), str) and a["theme"].strip():
            proposed[a["id"]] = a["theme"].strip()

    result, new_names, new_counts = {}, {}, Counter()
    for tid in ids:
        name = proposed.get(tid)
        if not name or name.lower() == UNSORTED.lower():
            result[tid] = UNSORTED
        elif name.lower() in canon:
            result[tid] = canon[name.lower()]
        else:
            key = new_names.setdefault(name.lower(), name).lower()
            new_counts[key] += 1

    slots = max_themes - len([n for n in active if n not in SPECIAL_THEMES])
    allowed = set()
    for key, count in new_counts.most_common():
        if count >= min_tabs and slots > 0:
            allowed.add(key)
            slots -= 1

    for tid in ids:
        if tid in result:
            continue
        key = proposed[tid].lower()
        result[tid] = new_names[key] if key in allowed else UNSORTED
    return result


def _active_with_samples(store):
    return {
        name: [t["title"] for t in store.tabs_in_theme(name)[:3]]
        for name in store.sortable_theme_names()
        if name != UNSORTED
    }


def sort_pending(store, runner, include_unsorted=False):
    tabs = store.pending_sort()
    if include_unsorted:
        tabs += store.tabs_in_theme(UNSORTED)
    if not tabs:
        return
    model = store.get_setting("model", "sonnet")
    max_themes = store.get_setting("max_themes", MAX_THEMES)
    batch_size = store.get_setting("batch_size", BATCH_SIZE)
    text_limit = store.get_setting("text_chars", TEXT_LIMIT)
    min_tabs = store.get_setting("min_tabs_new_theme", MIN_TABS_NEW_THEME)
    fallback = store.get_setting("fallback_model", "haiku")
    batches = [tabs[i:i + batch_size] for i in range(0, len(tabs), batch_size)]
    for n, batch in enumerate(batches):
        active = _active_with_samples(store)
        prompt = build_prompt(batch, active, store.corrections(limit=20), text_limit=text_limit,
                              min_tabs=min_tabs)
        try:
            output, model_used = runner.run(prompt, OUTPUT_SCHEMA, model, fallback)
        except SortError as e:
            for rest in batches[n:]:
                for t in rest:
                    store.assign(t["id"], UNSORTED)
            store.set_setting("sort_error", {"kind": e.kind, "message": str(e), "at": time.time()})
            return
        rules = apply_rules(batch, output, list(active), max_themes=max_themes, min_tabs=min_tabs)
        for tid, theme in rules.items():
            store.assign(tid, theme)
        store.set_setting("last_model", model_used)
        existing = set(store.active_theme_names())
        store.set_setting("merge_suggestions", [
            m for m in output.get("merge_suggestions", [])
            if m["from"] in existing and m["into"] in existing and m["from"] != m["into"]
        ])
    store.set_setting("sort_error", None)
