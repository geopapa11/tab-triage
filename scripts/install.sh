#!/bin/bash
# Install the Tab Triage server as a launchd agent that starts at login and stays up.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="local.tab-triage"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/tab-triage.log"
UV="$(command -v uv)"
PORT=8765

[ -x "$HOME/.local/bin/claude" ] || { echo "claude CLI not found at ~/.local/bin/claude" >&2; exit 1; }

(cd "$REPO" && "$UV" sync --quiet)

mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$UV</string><string>run</string><string>--project</string><string>$REPO</string>
    <string>python</string><string>-m</string><string>server</string><string>--port</string><string>$PORT</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
PLIST
plutil -lint "$PLIST" >/dev/null

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

for _ in $(seq 1 30); do
  if curl -fsS -H "Host: 127.0.0.1:$PORT" "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo "Tab Triage server running on http://127.0.0.1:$PORT"
    tail -n 2 "$LOG"
    exit 0
  fi
  sleep 1
done
echo "Server did not come up; see $LOG" >&2
exit 1
