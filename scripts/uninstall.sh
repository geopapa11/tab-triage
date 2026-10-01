#!/bin/bash
# Stop and remove the launchd agent. Your saved tabs (the SQLite file) are left in place.
set -euo pipefail
LABEL="local.tab-triage"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
[ -f "$PLIST" ] && trash "$PLIST"
echo "Removed $LABEL. Data kept in ~/Library/Application Support/tab-triage/"
