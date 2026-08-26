#!/usr/bin/env bash
# Installs the checker as a launchd agent that fires every 3 minutes.
# The script itself decides whether the current time is inside ICP_WINDOWS,
# so the agent can run all day without hammering the site.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.peinsold.cita-checker"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="$(command -v node)"

[ -f "$DIR/.env" ] || { echo "Create $DIR/.env first (cp .env.example .env)"; exit 1; }

mkdir -p "$HOME/Library/LaunchAgents" "$DIR/logs"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$DIR/run.sh</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>StartInterval</key><integer>180</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$DIR/logs/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$DIR/logs/launchd.err.log</string>
</dict>
</plist>
PLISTEOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "Loaded $LABEL (every 180s, active only inside ICP_WINDOWS)."
echo "  logs:      tail -f $DIR/logs/checker.log"
echo "  uninstall: launchctl unload $PLIST && rm $PLIST"
