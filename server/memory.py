"""Chrome's memory, split into what the memory guard can act on (tab renderers) and the rest.

RSS double-counts pages shared between Chrome processes, so `total` reads higher than Chrome's
Task Manager. `tabs` (web-page renderers only — not extensions, GPU, network or the browser
process) is what the guard compares with its budget, since unloading tabs only shrinks that part.
"""

import subprocess


def chrome_memory(ps_output=None):
    if ps_output is None:
        ps_output = subprocess.run(
            ["/bin/ps", "-axo", "rss=,command="], capture_output=True, text=True, check=True
        ).stdout
    total_kb = tabs_kb = 0
    for line in ps_output.splitlines():
        rss, _, command = line.strip().partition(" ")
        if not rss.isdigit() or "/Google Chrome" not in command:
            continue
        total_kb += int(rss)
        if "--type=renderer" in command and "--extension-process" not in command:
            tabs_kb += int(rss)
    return {"total": total_kb * 1024, "tabs": tabs_kb * 1024}
