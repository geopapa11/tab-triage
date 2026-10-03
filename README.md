# Tab Triage

If you keep dozens of tabs open because each one is a task you don't want to forget, Tab Triage
takes them off Chrome's hands. Once a day it saves the tabs you haven't touched in 4 days into a
dashboard, sorts them into themes (one theme per task or project), and closes them. You work
from the dashboard: prioritize themes, open the tabs for one task, tick them off when done.

The result is a couple of Chrome windows with a handful of live tabs, a task list that doesn't
depend on tabs staying open, and far less memory use.

Sorting is done by Claude through the Claude Code CLI on your **claude.ai subscription**. No API
key is used, ever.

- [What you need](#what-you-need)
- [Install](#install)
- [First run](#first-run)
- [How it runs day to day](#how-it-runs-day-to-day)
- [Using the dashboard](#using-the-dashboard)
- [What gets closed, kept and dropped](#what-gets-closed-kept-and-dropped)
- [Memory guard](#memory-guard)
- [Privacy: what is sent to Claude](#privacy-what-is-sent-to-claude)
- [Settings](#settings)
- [Troubleshooting](#troubleshooting)
- [Updating and uninstalling](#updating-and-uninstalling)
- [How it's built](#how-its-built)

## What you need

- **macOS** and **Google Chrome**. The server runs as a macOS login job; other systems aren't
  supported.
- **[uv](https://docs.astral.sh/uv/)**, which runs the server (it fetches Python 3.12+ itself).
- **[Claude Code](https://claude.com/claude-code)** installed at `~/.local/bin/claude` and logged
  in with a claude.ai subscription. Check with `claude auth status`: it should say
  `"authMethod": "claude.ai"`.
- Node.js is only needed to run the extension's tests.

## Install

1. Clone the repo and start the server:

   ```bash
   git clone https://github.com/geopapa11/tab-triage.git
   cd tab-triage
   scripts/install.sh
   ```

   This installs a login job (`local.tab-triage`) that starts the server at every login and
   restarts it if it stops. It prints `Tab Triage server running on http://127.0.0.1:8765` and
   `claude login ok` when it works.

2. Load the extension in Chrome:
   1. Open `chrome://extensions`.
   2. Turn on **Developer mode** (top right).
   3. Click **Load unpacked** and pick the repo's `extension/` folder.
   4. Open the puzzle-piece menu in Chrome's toolbar and pin **Tab Triage**.

3. Click the Tab Triage icon. The dashboard opens.

Keep Developer mode on; Chrome disables unpacked extensions without it.

## First run

Nothing closes until you approve.

1. Click **Run first sweep**. Every tab that isn't protected (see
   [below](#what-gets-closed-kept-and-dropped)) is saved, whatever its age, and Claude sorts them
   into themes. About 40 tabs take 20 seconds; a few hundred take a couple of minutes. Chrome tab
   groups become themes with the same names.
2. Look the themes over. Drag tabs between themes, rename or merge themes, and drag the ones that
   matter most into **Your priorities**.
3. Click **Approve & close**. The saved tabs close, along with duplicates and junk.
4. Click **Merge windows** if you're left with several nearly empty windows.

After you approve, a **7-day dry-run** starts: the daily sweep saves stale tabs to the dashboard
but leaves them open, and offers **Close them now**. From day 8 the sweep closes them itself. The
dashboard warns you the day before.

## How it runs day to day

You don't start anything.

| | |
|---|---|
| **Every day at 19:00** | Tabs untouched for 96 hours are saved, sorted and (after the dry-run week) closed. |
| **Laptop asleep at 19:00** | The sweep runs when it wakes. |
| **Chrome closed or laptop off at 19:00** | The sweep runs when you next open Chrome, if none ran in the last 24 hours. |
| **After a restart** | The server starts at login; the extension loads with Chrome. |
| **Any time** | **Sweep now** sweeps immediately and **ignores the 96 hours**: every tab that isn't protected is saved (and, after the dry-run week, closed). It shows a count and asks first. |

The sweep only runs while Chrome is open.

## Using the dashboard

Open it with the toolbar icon. Pin the dashboard tab if you want it always there; pinned tabs
are never swept.

**The header** shows the mode (First run / Dry-run / Live), tab memory against its budget, how
many tabs are loaded, and how many windows are open.

**Themes** are listed in priority order, with unranked ones below.

| To do this | Do this |
|---|---|
| Open a saved tab | Click its title. |
| Work on a theme | **Open N** opens its top 6 tabs in a new window. |
| Remove a tab you no longer need | Hover over it and click **Remove**. It leaves the list without going to Completed, and closes in Chrome if it's open there. **Undo** in the message that appears brings it back. |
| Add a page you're on | Right-click the page (or the Tab Triage toolbar icon) → **Add this page to Tab Triage** → **Add & close** or **Add, keep open** → a theme, or **Let Claude choose**. |
| Add a link | **+ Add link** on a theme card, paste the URL, press Enter. The page's title is filled in. |
| Mark a tab done | Tick its box. It greys out, drops to the bottom of the theme and appears under **Completed** for 45 days, then is deleted. Untick it to bring it back. |
| Prioritize themes | Drag a theme by its number. While you drag, cards collapse to headers and a "Drop here to make it #1" bar appears at the top. Or use **⋯ → Move to top / up / down**. |
| Reorder or move tabs | Drag a tab within its theme or onto another theme. |
| Act on several tabs | Click the empty space in a tab's row to select it; shift-click selects a range. A bar offers **Done**, **Move to…**, **Snooze** and **Remove**. Esc clears. |
| Hide something until a date | **Snooze** a tab or a theme (tomorrow, next Monday, in a week, or a date). It returns marked "Back". |
| Put a theme aside with no date | **Later** collapses it to one line at the bottom. Click the line to bring it back to its place. |
| Rename a theme | Click its name. |
| Combine themes | **⋯ → Merge into…** |
| Finish a whole theme | **⋯ → Mark all done**. Reversible for 45 days. |
| Undo a grouping you don't like | **⋯ → Dissolve**. Its tabs go back to Claude to be re-sorted, and Claude is told not to recreate that theme. |
| Remove a theme | **⋯ → Delete theme**. Its open tabs are deleted for good; tabs you had already ticked keep their history in Completed. |
| Reduce the number of windows | **Merge windows** brings you down to two windows: the dashboard's window and one other (the one with your inboxes, else the largest) stay as they are, and tabs from every other window move into them. With two or fewer windows it does nothing. Nothing is closed. |
| Keep a copy | **Export .md** downloads the list as Markdown. |

A theme nobody has touched for 7 days shows **Stale — drop it?**; clicking it marks all its tabs
done. When Claude thinks two themes overlap, the card shows a **Merge** suggestion you can accept
or dismiss.

**Done vs Remove:** tick a tab when you've finished with it; it's kept in Completed for 45 days
as a record. Remove it when it turned out not to be useful; it leaves no history.

Your corrections (moving a tab to another theme, renaming, merging, dissolving) are passed to
Claude on later sweeps so it stops repeating the same mistake.

## What gets closed, kept and dropped

A tab is **stale** when you haven't looked at it for 96 hours. The automatic 19:00 sweep only
takes stale tabs; **Sweep now** and the first run take every tab that isn't protected.

**Never closed:**
- pinned tabs
- the tab you're on in each window
- tabs playing audio
- tabs with a half-filled form or a chosen upload (if the check can't run on a page, the tab is
  left open)
- the keep-open list: Gmail inbox, Google Calendar and Linear by default (one copy of each;
  extra copies count as duplicates)
- any tab you used after it was saved

**Saved to the dashboard, then closed:** every other stale tab. Gmail threads go to an
"Email follow-ups" theme by subject line only.

**Closed without saving:**
- exact duplicates of another open tab, at any age (the most recently used copy stays)
- and, once stale (or at any age in the first run):
  - Google, Bing and DuckDuckGo search results, and Gmail searches
  - Google Meet pages
  - sign-in pages
  - `chrome://` and other internal pages

Right before closing anything, the extension re-reads your tabs: a tab that navigated elsewhere
or was touched since the sweep started stays open.

**Themes:** Claude reuses an existing theme when one fits and creates a new one only when at
least 2 tabs belong to it. Leftovers go to **Unsorted**, which is always listed last; its **Re-sort**
button asks Claude to try those tabs again. New themes stop being created at the maximum set in
Settings.

## Memory guard

Every 5 minutes, and after a page finishes loading, the extension checks how much memory Chrome's
tabs use. Above the **tab memory budget** (1 GB by default) it *unloads* the two least recently
used tabs, and repeats until it is under. Unloaded tabs stay in the tab strip and reload when you
click them. The tab you're on, any tab you used in the last 30 minutes, tabs playing audio
and tabs with half-filled forms are never unloaded; keep-open and pinned tabs go last.

The header also shows Chrome's total. That figure includes Chrome itself, the GPU process and
extensions, which unloading tabs can't reduce, and it over-counts memory that Chrome's processes
share, so it reads higher than Chrome's own Task Manager.

## Privacy: what is sent to Claude

Everything is stored locally in `~/Library/Application Support/tab-triage/tabs.db`. The only
thing that leaves your machine is the sorting request to Claude, through the `claude` CLI:

- each swept tab's **title**, **URL** and Chrome tab-group name
- up to **1,500 characters of page text**, only for tabs that are loaded at sweep time
- your existing theme names with a few sample titles, and your recent corrections

Page text is **never read** on the never-read list (Gmail, Google Drive and Docs, AWS, LinkedIn
messaging, PayPal, Revolut, anything with "bank" in the address, by default) or on sign-in
pages. For those, only the title and URL are sent.

**Subscription only.** Before each sorting call the server checks that `claude` is logged in with
claude.ai, runs it with no `ANTHROPIC_*` environment variables and without your Claude Code
settings, and kills the call if it reports any API-key source. If the login is wrong, nothing is
sent and the dashboard says so.

The server listens on `127.0.0.1` only and refuses requests from web pages.

## Settings

The ⚙ button on the dashboard:

| Setting | Default | What it does |
|---|---|---|
| Sorting model | `sonnet` | A Claude Code model alias, so it follows new versions. Falls back to `haiku` if unavailable. |
| Tab memory budget | 1024 MB | Above this, the memory guard unloads tabs. |
| Maximum themes | 15 | Claude stops creating themes at this count. Raise it if you have many Chrome tab groups: each becomes a theme and counts. |
| Keep open | Gmail inbox, Calendar, Linear | URL patterns never closed. One per line; `*` matches anything. |
| Never read page text | see [Privacy](#privacy-what-is-sent-to-claude) | URL patterns whose page text is never sent. |

Fixed in code: the 96-hour staleness, the 19:00 sweep, the 7-day dry-run and the 45-day
Completed history.

## Troubleshooting

| You see | Do this |
|---|---|
| **"Can't reach the local server"** | Run `scripts/install.sh` again. Check `~/Library/Logs/tab-triage.log`. |
| **"Sorting failed … Claude isn't logged in"** | Run `claude auth login`, then click **Re-sort**. The tabs were saved to Unsorted; nothing is lost. |
| Most tabs land in **Unsorted** | Raise **Maximum themes** in Settings, then click **Re-sort** on the Unsorted card. |
| The dashboard looks out of date after an update | Click reload (↻) on the Tab Triage card in `chrome://extensions`, then refresh the dashboard. |
| The 19:00 sweep saved 0 tabs | Normal: nothing has been untouched for 96 hours yet. Use **Sweep now** to clear everything unprotected anyway. |
| Chrome's total memory stays high | Quit and reopen Chrome, and check Chrome's Task Manager (⋮ → More tools) for heavy tabs and extensions. |
| Tab Triage disappeared from Chrome | Developer mode was turned off. Turn it on and load the `extension/` folder again; your saved tabs are still in the database. |

To see what the extension is doing, click **service worker** on its card in `chrome://extensions`.

## Updating and uninstalling

**Update:**

```bash
git pull
launchctl kickstart -k gui/$(id -u)/local.tab-triage
```

Then click reload (↻) on the Tab Triage card in `chrome://extensions` and refresh the dashboard.

**Uninstall:** run `scripts/uninstall.sh` and remove the extension in `chrome://extensions`. Your
saved tabs stay in `~/Library/Application Support/tab-triage/`; delete that folder to remove them.

## How it's built

- **`extension/`** — a Chrome extension (Manifest V3). It decides which tabs are stale, reads
  page text, closes and unloads tabs, and hosts the dashboard. The decision logic is in
  `extension/lib/` as plain functions.
- **`server/`** — a local server on `127.0.0.1:8765` using only Python's standard library and
  SQLite. It stores everything, runs `claude -p` to sort, and measures Chrome's memory. About
  15 MB of RAM.

Design decisions and how each part was verified are in [docs/PLAN.md](docs/PLAN.md).

**Tests:**

```bash
uv run pytest
node --test 'extension/**/*.test.js'
```
