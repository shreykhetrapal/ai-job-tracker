#!/bin/zsh
set -euo pipefail

uid="$(id -u)"
services=(
  "com.ai-job-tracker.ollama"
  "com.ai-job-tracker.dashboard"
  "com.ai-job-tracker.cloudflared"
)

for label in "${services[@]}"; do
  if launchctl print "gui/$uid/$label" >/dev/null 2>&1; then
    echo "$label: loaded"
  else
    echo "$label: not loaded"
  fi
done

echo
echo "Processes:"
pgrep -fl "ollama|server.js|cloudflared" || true

echo
echo "Health checks:"
if curl -fsS --max-time 5 http://127.0.0.1:4173/ >/dev/null; then
  echo "dashboard: ok"
else
  echo "dashboard: not reachable at http://127.0.0.1:4173/"
fi

if curl -fsS --max-time 5 http://127.0.0.1:11434/api/tags >/dev/null; then
  echo "ollama: ok"
else
  echo "ollama: not reachable at http://127.0.0.1:11434"
fi

echo
echo "Recent logs:"
for file in \
  /tmp/ai-job-tracker-dashboard.err \
  /tmp/ai-job-tracker-ollama.err \
  /tmp/ai-job-tracker-cloudflared.err; do
  echo "--- $file"
  if [[ -f "$file" ]]; then
    tail -n 8 "$file"
  else
    echo "missing"
  fi
done
