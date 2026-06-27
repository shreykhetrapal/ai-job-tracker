#!/bin/zsh
set -euo pipefail

label="com.ai-job-tracker.dashboard"
uid="$(id -u)"

if launchctl print "gui/$uid/$label" >/dev/null 2>&1; then
  launchctl kickstart -k "gui/$uid/$label"
  echo "Restarted $label"
else
  echo "$label is not loaded. Run scripts/install-local-services.sh first."
  exit 1
fi
