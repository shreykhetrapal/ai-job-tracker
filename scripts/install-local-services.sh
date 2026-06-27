#!/bin/zsh
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
launch_agents_dir="$HOME/Library/LaunchAgents"
uid="$(id -u)"

services=(
  "com.ai-job-tracker.dashboard"
  "com.ai-job-tracker.cloudflared"
)

if [[ "${1:-}" == "--with-ollama" ]]; then
  services=(
    "com.ai-job-tracker.ollama"
    "com.ai-job-tracker.dashboard"
    "com.ai-job-tracker.cloudflared"
  )
fi

mkdir -p "$launch_agents_dir"

echo "Installing launchd service plists..."
for label in "${services[@]}"; do
  src="$repo_dir/ops/$label.plist"
  dest="$launch_agents_dir/$label.plist"
  if [[ ! -f "$src" ]]; then
    echo "Missing $src"
    exit 1
  fi
  cp "$src" "$dest"
done

echo "Loading services..."
for label in "${services[@]}"; do
  dest="$launch_agents_dir/$label.plist"
  launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$uid" "$dest"
  launchctl enable "gui/$uid/$label"
  launchctl kickstart -k "gui/$uid/$label"
done

echo "Installed services:"
for label in "${services[@]}"; do
  echo "- $label"
done

echo
echo "Run scripts/service-status.sh to verify the dashboard, Ollama, and Cloudflare tunnel."
echo "Ollama launchd service is skipped by default. Use --with-ollama only if Ollama Desktop auto-start is disabled."
