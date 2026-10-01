"""Run the Tab Triage server: `uv run python -m server [--port 8765] [--db PATH]`."""

import argparse
import threading
import time
from pathlib import Path

from .app import make_server
from .classifier import ClaudeRunner, SortError, sort_pending
from .memory import chrome_rss_bytes
from .store import Store

DEFAULT_DB = Path.home() / "Library/Application Support/tab-triage/tabs.db"
HOUSEKEEPING_EVERY = 6 * 3600


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    args = parser.parse_args()

    store = Store(args.db)
    runner = ClaudeRunner()

    # Subscription guard at startup: surface a login problem on the dashboard right away.
    try:
        status = runner.check_auth()
        if (store.get_setting("sort_error") or {}).get("kind") == "auth":
            store.set_setting("sort_error", None)
        print(f"claude login ok: {status.get('subscriptionType')} via {status.get('authMethod')}", flush=True)
    except SortError as e:
        store.set_setting("sort_error", {"kind": e.kind, "message": str(e), "at": time.time()})
        print(f"claude login problem: {e}", flush=True)

    def sort_fn(include_unsorted=False):
        sort_pending(store, runner, include_unsorted=include_unsorted)

    def housekeeping():
        while True:
            store.purge()
            time.sleep(HOUSEKEEPING_EVERY)

    threading.Thread(target=housekeeping, daemon=True).start()
    server = make_server(store, sort_fn=sort_fn, memory_fn=chrome_rss_bytes, port=args.port)
    print(f"tab-triage listening on http://127.0.0.1:{args.port} (db: {args.db})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
