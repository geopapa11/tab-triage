"""A scriptable stand-in for the `claude` CLI, driven by files in $HOME.

$HOME/mode         one of: ok, no_init, logged_out, api_key_auth, api_key_source, bad_model, hang, garbage
$HOME/output.json  structured_output to return in `ok` mode (default: {"assignments": []})
$HOME/calls.jsonl  one line per invocation: argv, env keys, stdin; "result_emitted" markers
"""

import json
import os
import sys
import time
from pathlib import Path

home = Path(os.environ["HOME"])
mode = (home / "mode").read_text().strip() if (home / "mode").exists() else "ok"
log = home / "calls.jsonl"


def record(entry):
    with log.open("a") as f:
        f.write(json.dumps(entry) + "\n")


def emit(event):
    print(json.dumps(event), flush=True)


args = sys.argv[1:]

if args[:2] == ["auth", "status"]:
    record({"argv": args, "env": sorted(os.environ)})
    status = {"loggedIn": True, "authMethod": "claude.ai", "subscriptionType": "pro"}
    if mode == "logged_out":
        status = {"loggedIn": False}
    elif mode == "api_key_auth":
        status = {"loggedIn": True, "authMethod": "api_key"}
    emit(status)
    sys.exit(0)

stdin = sys.stdin.read()
record({"argv": args, "env": sorted(os.environ), "stdin": stdin})
model = args[args.index("--model") + 1]
source = "ANTHROPIC_API_KEY" if mode == "api_key_source" else "none"
emit({"type": "system", "subtype": "hook_started"})
if mode != "no_init":
    emit({"type": "system", "subtype": "init", "model": model, "apiKeySource": source})

if mode == "api_key_source":
    time.sleep(3)
    record({"result_emitted": True})
elif mode == "hang":
    time.sleep(30)
elif mode == "bad_model":
    emit({"type": "result", "subtype": "success", "is_error": True,
          "result": f"There's an issue with the selected model ({model}). It may not exist."})
    sys.exit(1)
elif mode == "garbage":
    emit({"type": "result", "subtype": "success", "is_error": False, "result": "not json"})
else:
    out_file = home / "output.json"
    out = json.loads(out_file.read_text()) if out_file.exists() else {"assignments": []}
    emit({"type": "result", "subtype": "success", "is_error": False,
          "structured_output": out, "modelUsage": {"claude-sonnet-5-5": {}}})
