"""Chrome's total resident memory, summed over all its processes.

RSS double-counts pages shared between Chrome processes, so this reads higher than
Activity Monitor — the cap errs on the strict side.
"""

import subprocess


def chrome_rss_bytes(ps_output=None):
    if ps_output is None:
        ps_output = subprocess.run(
            ["/bin/ps", "-axo", "rss=,comm="], capture_output=True, text=True, check=True
        ).stdout
    total_kb = 0
    for line in ps_output.splitlines():
        rss, _, command = line.strip().partition(" ")
        if "Google Chrome" in command and rss.isdigit():
            total_kb += int(rss)
    return total_kb * 1024
