#!/bin/zsh
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
db_path="$repo_dir/data/app.db"
backup_dir="${AI_JOB_TRACKER_BACKUP_DIR:-$HOME/Documents/Codex/backups/ai-job-tracker}"
timestamp="$(date +%Y%m%d-%H%M%S)"
target="$backup_dir/app-$timestamp.db"

if [[ ! -f "$db_path" ]]; then
  echo "Missing database: $db_path"
  exit 1
fi

mkdir -p "$backup_dir"

if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$db_path" ".backup '$target'"
  echo "SQLite backup written to $target"
else
  cp "$db_path" "$target"
  [[ -f "$db_path-wal" ]] && cp "$db_path-wal" "$target-wal"
  [[ -f "$db_path-shm" ]] && cp "$db_path-shm" "$target-shm"
  echo "sqlite3 CLI not found; copied database files to $backup_dir"
fi
