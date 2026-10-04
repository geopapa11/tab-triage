"""Every user-editable setting: its default and what values are accepted.

Kept apart from the HTTP layer so storage and sorting can read the defaults too.
"""

import re

DEFAULT_SETTINGS = {
    "model": "sonnet",
    "fallback_model": "haiku",
    "tab_memory_cap_mb": 1024,
    "max_themes": 15,
    "keep_open": [
        "https://mail.google.com/mail/u/*/#inbox",
        "https://calendar.google.com/*",
        "https://linear.app/*",
    ],
    "never_read": [
        "*://mail.google.com/*",
        "*://drive.google.com/*",
        "*://docs.google.com/*",
        "*://*.aws.amazon.com/*",
        "*://*.amazonaws.com/*",
        "*://www.linkedin.com/messaging/*",
        "*bank*",
        "*://*.paypal.com/*",
        "*://*.revolut.com/*",
    ],
    # everyday
    "stale_hours": 96,            # a tab is swept after this long untouched
    "sweep_time": "19:00",        # daily sweep, local time
    "done_retention_days": 45,    # Completed history
    "snooze_time": "08:00",       # when snoozed items wake
    "open_tabs_max": 6,           # "Open N" on a theme
    "unload_idle_hours": 24,      # memory guard never unloads tabs used more recently
    # advanced
    "theme_stale_days": 7,        # "Stale — drop it?" badge
    "memory_check_minutes": 5,
    "min_tabs_new_theme": 2,
    "text_chars": 1500,           # page text sent to Claude per tab
    "batch_size": 40,             # tabs per Claude call
}

# Whole-number settings and their inclusive limits.
RANGES = {
    "tab_memory_cap_mb": (256, 65536),
    "max_themes": (5, 60),
    "stale_hours": (1, 720),
    "done_retention_days": (1, 365),
    "open_tabs_max": (1, 12),
    "unload_idle_hours": (0, 168),
    "theme_stale_days": (1, 90),
    "memory_check_minutes": (1, 60),
    "min_tabs_new_theme": (1, 10),
    "text_chars": (0, 2000),
    "batch_size": (5, 50),
}
TIMES = {"sweep_time", "snooze_time"}
LISTS = {"keep_open", "never_read"}
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def validate(key, value):
    """Return the value to store, or raise ValueError saying what is wrong."""
    if key not in DEFAULT_SETTINGS:
        raise ValueError(f"unknown setting {key!r}")
    if key in RANGES:
        low, high = RANGES[key]
        if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
            raise ValueError(f"{key} must be a whole number from {low} to {high}")
        return value
    if key in TIMES:
        if not isinstance(value, str) or not TIME_RE.match(value):
            raise ValueError(f"{key} must be a time like 19:00")
        return value
    if key in LISTS:
        if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
            raise ValueError(f"{key} must be a list of patterns")
        return [v.strip() for v in value if v.strip()]
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} must be a non-empty name")
    return value.strip()


def get(store, key):
    return store.get_setting(key, DEFAULT_SETTINGS[key])
