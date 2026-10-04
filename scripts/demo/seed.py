"""Seed a demo database with invented themes and tabs for the README screenshot."""
import sys, time
from server.store import Store, DAY

path = sys.argv[1]
now = time.time()
clock = {"t": now}
store = Store(path, now=lambda: clock["t"])
H = 3600

def add(theme, items, rank=None, later=False):
    tid = store.create_theme(theme, position=rank)
    for age_h, url, title in reversed(items):          # first item ends up on top
        clock["t"] = now - age_h * H
        (i,) = store.capture([{"url": url, "title": title}])
        store.assign(i, theme)
    clock["t"] = now
    if later:
        store.set_later(tid, True)
    return tid

add("Checkout redesign", [
    (3,  "https://www.figma.com/file/demo/checkout-v3", "Checkout v3 — Figma"),
    (20, "https://github.com/acme-shop/web/pull/412", "feat(checkout): address autocomplete · Pull Request #412 · acme-shop/web"),
    (27, "https://baymard.com/blog/checkout-flow-average-form-fields", "Checkout Optimization: Minimize Form Fields – Baymard Institute"),
    (50, "https://docs.stripe.com/payments/elements", "Stripe Elements | Stripe Documentation"),
    (52, "https://www.notion.so/acme/checkout-funnel-audit", "Checkout funnel audit — Notion"),
], rank=0)
add("Team PR reviews", [
    (5,  "https://github.com/acme-shop/api/pull/231", "fix(orders): retry webhook delivery with backoff · Pull Request #231 · acme-shop/api"),
    (9,  "https://github.com/acme-shop/web/pull/408", "refactor(cart): move totals into a hook · Pull Request #408 · acme-shop/web"),
    (30, "https://github.com/acme-shop/infra/pull/77", "chore(ci): cache pnpm store between jobs · Pull Request #77 · acme-shop/infra"),
], rank=1)
add("Postgres 17 upgrade", [
    (26, "https://www.postgresql.org/docs/17/release-17.html", "PostgreSQL: Documentation: 17: Release Notes"),
    (28, "https://www.postgresql.org/docs/17/pgupgrade.html", "PostgreSQL: Documentation: 17: pg_upgrade"),
    (75, "https://www.notion.so/acme/pg17-runbook", "Postgres 17 upgrade runbook — Notion"),
    (76, "https://github.com/acme-shop/infra/issues/61", "Plan the Postgres 17 upgrade window · Issue #61 · acme-shop/infra"),
], rank=2)
add("Lisbon conference trip", [
    (48, "https://www.google.com/travel/flights/demo", "Flights to Lisbon — Google Flights"),
    (49, "https://www.booking.com/hotel/pt/demo", "Hotels near the venue — Booking.com"),
    (120, "https://conf.example.org/2026/schedule", "Schedule — Example Conf 2026"),
])
add("Distributed systems reading", [
    (100, "https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html", "How to do distributed locking — Martin Kleppmann’s blog"),
    (190, "https://jepsen.io/analyses", "Jepsen: Analyses"),
])
add("Home office setup", [
    (200, "https://www.ikea.com/demo/standing-desk", "Standing desk — IKEA"),
    (210, "https://www.rtings.com/monitor/reviews/best/work", "The best monitors for work — RTINGS.com"),
], later=True)
add("Unsorted", [
    (22, "https://news.ycombinator.com/item?id=1", "Show HN: A tiny SQLite job queue | Hacker News"),
])

# a kept tab and a completed tab in the first theme, and one tab back from snooze
clock["t"] = now - 60 * H
(kept,) = store.capture([{"url": "https://docs.stripe.com/payments/payment-element/design", "title": "Payment Element design guidelines | Stripe Documentation"}])
store.assign(kept, "Checkout redesign")
store.keep(kept)
clock["t"] = now - 30 * H
(done,) = store.capture([{"url": "https://www.nngroup.com/articles/ecommerce-checkout/", "title": "E-Commerce Checkout Usability — Nielsen Norman Group"}])
store.assign(done, "Checkout redesign")
clock["t"] = now - 6 * H
store.check(done)
clock["t"] = now - 40 * H
(snz,) = store.capture([{"url": "https://github.com/acme-shop/api/pull/226", "title": "feat(orders): bulk export endpoint · Pull Request #226 · acme-shop/api"}])
store.assign(snz, "Team PR reviews")
store.snooze_tab(snz, now - 1 * H)
clock["t"] = now
store.board()                                           # wakes the snoozed tab, marks it "back"

store.set_setting("first_run_done_at", now - 9 * DAY)
store.set_setting("last_sweep", {"at": now - 2 * H, "count": 4, "mode": "live"})
store.set_setting("last_model", "claude-sonnet-5-5")
store.set_setting("merge_suggestions", [])
b = store.board()
print([ (t["name"], len(t["tabs"])) for t in b["themes"] ], [t["name"] for t in b["later_themes"]])
