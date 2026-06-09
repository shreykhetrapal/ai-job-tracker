# Ollama Qwen Fallback

AI Job Tracker uses OpenAI first for job summaries and personalized scoring. If OpenAI fails, the local app can fall back to Qwen through Ollama.

## Environment

Add these values to `.env`:

```bash
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen2.5:latest
OLLAMA_TIMEOUT_MS=300000
OLLAMA_CONTEXT_LENGTH=4096
OLLAMA_APP_CONCURRENCY=2
```

`OLLAMA_CONTEXT_LENGTH` is also sent to Ollama as `num_ctx` for each fallback request. `OLLAMA_APP_CONCURRENCY` limits how many Qwen fallback calls the dashboard sends at once.

`OLLAMA_NUM_PARALLEL` is different: it must be set in the environment of the Ollama server process itself. The launchd template in `ops/com.ai-job-tracker.ollama.plist` sets it to `2`.

`OLLAMA_MAX_QUEUE=32` is optional. It is useful when many clients may hit Ollama directly, but the dashboard already limits fallback calls before they reach Ollama. For this app, keep the app-side limiter at `2` first and only add a larger server queue if scans are being rejected instead of waiting.

## Easiest Setup

Open the Ollama desktop app and let it run in the background. If you want it to survive restarts, enable Ollama at login in macOS login items.

Verify it is serving:

```bash
curl http://127.0.0.1:11434/api/tags
```

The response should include `qwen2.5:latest`.

## macOS Launchd Setup

Use this only if you are not also auto-starting the Ollama desktop app.

```bash
mkdir -p ~/Library/LaunchAgents
cp ops/com.ai-job-tracker.ollama.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ai-job-tracker.ollama.plist
launchctl enable gui/$(id -u)/com.ai-job-tracker.ollama
launchctl kickstart -k gui/$(id -u)/com.ai-job-tracker.ollama
curl http://127.0.0.1:11434/api/tags
```

To stop the service:

```bash
launchctl bootout gui/$(id -u)/com.ai-job-tracker.ollama
```

Logs are written to:

```text
/tmp/ai-job-tracker-ollama.log
/tmp/ai-job-tracker-ollama.err
```

## Important Notes

- Do not run both Ollama desktop auto-start and this launchd service at the same time.
- Render cannot call Ollama on your Mac at `127.0.0.1:11434`; this fallback is for local/cloudflared hosting.
- Scanner logs will show `Ollama fallback` when Qwen is used after OpenAI fails.
