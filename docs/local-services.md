# Local Services

This app is currently designed to run from your Mac with Cloudflare Tunnel exposing `ai-job-tracker.com`.

The service setup keeps three local processes alive:

1. `com.ai-job-tracker.dashboard` runs the Node dashboard on `127.0.0.1:4173`.
2. `com.ai-job-tracker.ollama` runs Ollama/Qwen on `127.0.0.1:11434`.
3. `com.ai-job-tracker.cloudflared` runs the Cloudflare tunnel named `ai-job-tracker`.

## What You Need To Maintain

- `.env` stays local and contains API keys, email config, admin credentials, and app runtime settings.
- `data/app.db` stays local and is the SQLite source of truth.
- Your Mac must be awake and online for the public domain, scans, and email digests to run.
- Only one Cloudflare tunnel process should run for this domain.
- Do not run both Ollama Desktop auto-start and the launchd Ollama service at the same time.

## Install

From the repo root:

```bash
chmod +x scripts/*.sh
scripts/install-local-services.sh
scripts/service-status.sh
```

The installer copies the dashboard and Cloudflared service files to `~/Library/LaunchAgents` and starts them:

```text
ops/com.ai-job-tracker.dashboard.plist
ops/com.ai-job-tracker.cloudflared.plist
```

It skips the Ollama launchd service by default because Ollama Desktop may already be running. To install Ollama as a launchd service too, first disable Ollama Desktop auto-start, then run:

```bash
scripts/install-local-services.sh --with-ollama
```

That additionally installs:

```text
ops/com.ai-job-tracker.ollama.plist
```

## Restart After Code Changes

After pulling or editing code, restart the dashboard service:

```bash
scripts/restart-dashboard.sh
```

You normally do not need to restart Ollama or Cloudflared after dashboard code changes.

## Status And Logs

```bash
scripts/service-status.sh
```

Logs are written to:

```text
/tmp/ai-job-tracker-dashboard.log
/tmp/ai-job-tracker-dashboard.err
/tmp/ai-job-tracker-ollama.log
/tmp/ai-job-tracker-ollama.err
/tmp/ai-job-tracker-cloudflared.log
/tmp/ai-job-tracker-cloudflared.err
```

Direct checks:

```bash
curl http://127.0.0.1:4173/
curl http://127.0.0.1:11434/api/tags
cloudflared tunnel list
```

## Stop Services

```bash
launchctl bootout gui/$(id -u)/com.ai-job-tracker.dashboard
launchctl bootout gui/$(id -u)/com.ai-job-tracker.ollama
launchctl bootout gui/$(id -u)/com.ai-job-tracker.cloudflared
```

## Database Backup

Run:

```bash
scripts/backup-db.sh
```

Default backup location:

```text
~/Documents/Codex/backups/ai-job-tracker
```

You can override it:

```bash
AI_JOB_TRACKER_BACKUP_DIR=/path/to/backups scripts/backup-db.sh
```

## Cloudflare Tunnel Assumption

The Cloudflared service uses:

```bash
cloudflared tunnel run ai-job-tracker
```

That assumes the named tunnel credentials already exist under your Cloudflare config directory, usually `~/.cloudflared`, and that the DNS route for `ai-job-tracker.com` already points at that tunnel.

If the tunnel name changes, update:

```text
ops/com.ai-job-tracker.cloudflared.plist
```

## Removing An Old Root Cloudflared Service

If `scripts/service-status.sh` shows both of these at the same time:

```text
/opt/homebrew/bin/cloudflared tunnel run ai-job-tracker
/opt/homebrew/bin/cloudflared tunnel run --token ...
```

then an older system-level Cloudflared service is still running. The new service can still work, but it is cleaner to run only the named user service.

Check:

```bash
launchctl print system/com.cloudflare.cloudflared
```

Stop and disable the old root service:

```bash
sudo launchctl bootout system /Library/LaunchDaemons/com.cloudflare.cloudflared.plist
sudo launchctl disable system/com.cloudflare.cloudflared
```

Then verify:

```bash
scripts/service-status.sh
```

## Runtime Assumption

The dashboard service uses the current Node binary:

```text
/Users/shrey/.nvm/versions/node/v22.21.1/bin/node
```

If you upgrade Node and remove that version, update:

```text
ops/com.ai-job-tracker.dashboard.plist
```
