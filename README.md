# Tab Triage

Keeps Chrome at ~2 windows / ~12 live tabs / ≤ 1.5 GB by sweeping tabs you haven't touched in
96 hours into a themed, prioritized checklist — sorted by Claude on your **subscription only**.

- **Extension** (`extension/`): decides what's stale, grabs page text, closes/unloads tabs, and
  hosts the dashboard (toolbar button).
- **Server** (`server/`): Python stdlib + SQLite on `127.0.0.1:8765`, runs `claude -p` to sort,
  measures Chrome memory. Runs as a launchd agent; ~15 MB RAM.

Design and decisions: [docs/PLAN.md](docs/PLAN.md).

## Install

```bash
scripts/install.sh
```

Then in Chrome: `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → pick
the `extension/` folder. Pin the Tab Triage icon and click it to open the dashboard.

## First run

1. Dashboard → **Run first sweep**. Every unprotected tab is saved and sorted; nothing closes.
2. Fix anything misplaced (drag tabs between themes, rename, merge), drag themes into
   **Your priorities**.
3. **Approve & close**. A 7-day dry-run starts (sweeps save but don't close); on day 8 the 19:00
   sweep closes stale tabs automatically.

Never closed: pinned, active, playing audio, half-filled forms, and the keep-open list
(Gmail inbox, Calendar, Linear — editable in ⚙ Settings).

## Everyday

- 19:00 sweep (or **Sweep now**); catches up when Chrome next opens if the laptop slept.
- Tick a tab when done → greyed at the bottom of its theme, listed under **Completed** for 45 days.
- Snooze tabs or themes; they come back marked "back".
- **Open N** opens a theme's top 6 tabs in a new window.
- **Merge windows** gathers every tab into one work window (where the dashboard is) plus one
  inbox window for keep-open tabs. Tab groups move whole; nothing is closed.
- Click a tab row's empty space to select it; the bar offers Done / Move to / Snooze / Delete.
  A theme's ⋯ menu has Mark all done, Dissolve (re-sort its tabs) and Delete (gone for good).
- Memory guard: every 5 min and after each page load, if Chrome > cap, least-recently-used tabs
  are *unloaded* (not closed); keep-open tabs last.

## Claude login

Sorting only ever uses your claude.ai subscription: the child process gets no `ANTHROPIC_*`
env, `claude auth status` must say `claude.ai`, and the call is killed if it reports any API-key
source. If the dashboard shows "Claude isn't logged in", run `claude auth login`, then **Re-sort**.

## Develop

```bash
uv run pytest                 # server
node --test 'extension/**/*.test.js'   # extension logic
```

Logs: `~/Library/Logs/tab-triage.log`. Data: `~/Library/Application Support/tab-triage/tabs.db`.
Restart: `launchctl kickstart -k gui/$(id -u)/local.tab-triage`. Remove:
`scripts/uninstall.sh` (keeps your data).
