# AI Job Tracker Agent Guide

This file gives coding agents durable context for working on AI Job Tracker.
It is adapted for this repo's architecture and product decisions, with
inspiration from the public agent-guidance style in:
https://github.com/multica-ai/andrej-karpathy-skills/blob/main/CLAUDE.md

## Working Principles

- Read `APP_CONTEXT.md` before changing scanner, matching, cache, email, auth,
  parser, company catalog, or deployment behavior.
- Prefer small, behavior-preserving changes. This app is intended to run on
  Render against Supabase Postgres, so regressions can affect real users.
- Do not edit or commit secrets, local databases, credentials, or generated
  runtime data. Keep `.env`, `data/`, and database WAL/SHM files out of git.
- Do not wipe user job history after a failed scan. Successful companies may
  replace their own prior jobs, but failed companies must leave prior results
  intact.
- Treat admin and regular-user views differently. Admins can see parser and
  scan internals; regular users should see simplified, friendly status.
- Use direct, plain product language in UI. Avoid exposing implementation
  jargon to regular users.

## Current Architecture

- Runtime: Node.js native `http` server in `server.js`.
- Frontend: plain HTML/CSS/JavaScript in `public/`.
- Storage: Supabase Postgres through `DATABASE_URL`, with JSONB user stores
  inside `user_stores.data`.
- LLM provider: OpenAI Responses API, currently configured by
  `OPENAI_SUMMARY_MODEL` and `OPENAI_API_KEY`.
- Email provider: Resend, configured with `RESEND_API_KEY`, `EMAIL_FROM`, and
  `EMAIL_REPLY_TO`.
- Public access: Render web service, usually behind `ai-job-tracker.com`.

Keep this stack unless the user explicitly asks for a larger migration. React,
Express, background queues, or normalized job tables may be useful later, but
they are not part of the current architecture.

## AI Behavior

The app does not currently implement a formal AI Skills runtime. It uses:

- OpenAI Responses API calls for job summaries and personalized relevance.
- A strict JSON schema for LLM output.
- Deterministic backend guardrails around model output.
- User profile, resume text, and relevance feedback as matching context.
- Cached posting content and cached LLM scores to avoid repeated work.

Important scoring decision:

- `relevanceScore` means role fit only.
- Location is separate through `locationMatchesProfile` and `locationStatus`.
- A manual user score is treated as the user's role-fit judgment, not as proof
  that the location is eligible.
- UI buckets are score-derived:
  - High: 8-10
  - Medium: 5-7
  - Low: 0-4

LLM summaries must summarize the job posting only. They must not say things
like "the candidate matches" in the summary field. Fit commentary belongs in
`fitReasons`, `concerns`, and `matchedSignals`.

If the LLM fails, the app should still provide a posting-only extracted summary
from fetched posting content. Do not fall back to generic listing text when
better posting content is available.

## Tool Calling And External Services

There is no model tool-calling loop inside the app today. External calls are
ordinary server-side HTTP calls from `server.js`.

Current external services include:

- Company job sources:
  - Apple careers pages and hydration data
  - Meta Careers GraphQL search
  - Netflix/Eightfold embedded jobs
  - Greenhouse board APIs
  - Ashby board/app data
  - OpenAI careers/Ashby fallback
  - Microsoft Careers API
  - Google careers HTML results
  - Walmart careers APIs and detail pages
- OpenAI Responses API for summaries and relevance.
- Resend API for email digests.
- Render outside the app process for hosting and public routing.

When adding a company parser, first make the parser observable for admins:
parser name, raw jobs, saved jobs, detail fetches, LLM/cache counts, issues, and
sample jobs. Regular users should not see raw parser internals.

## Matching And Cache Rules

- Use stable job identity from company, external job id, and posting date when
  possible.
- Do not use the current scan timestamp as a posting date. That makes the same
  job look new every day.
- Keep `jobDetailCache` useful by storing posting content, extracted summary,
  LLM summary, relevance signals, location fields, and cache timestamps.
- If a cache entry has posting content but the personalized scoring hash is
  stale, reuse the posting content and refresh only the personalized score.
- If that refresh fails, keep the cached or extracted summary and record the
  LLM error for diagnostics.

Role-fit guardrails matter. Avoid high scores for false positives like:

- Datacenter electrical/facilities roles for data-engineering profiles.
- Generic software platform roles with only weak data relevance.
- Manager or operations roles that mention analytics but are not actually data
  analyst, analytics engineer, product analytics, or data engineering roles.

## Email Digest Rules

- Email digests send new relevant openings that have not already been emailed
  to that user.
- Respect the user's Email Digest max jobs setting.
- Exclude applied and not-interested jobs.
- Exclude location-ineligible jobs unless product requirements change.
- Email content should include title, company, location, relevance, summary,
  fit reasons when available, and an open-job link.
- Scanner history should show email digest runs as first-class scan items with
  new matches, sent count, cache counts, LLM calls, and issues.

## UI Rules

- Keep the sidebar order:
  1. Overview
  2. Companies
  3. Job Board
  4. Pipeline
  5. Profile
  6. Email Digest
  7. Scanner
  8. Feedback
- Regular users:
  - Companies page should focus on request companies, approved companies, and
    their watchlist.
  - Scanner page should be simple and friendly.
- Admins:
  - Companies page may show Requests and Parser Health in in-page tabs.
  - Scanner page may show detailed logs and failed scans.
- Job Board should preserve scroll position and visually distinguish viewed,
  shortlisted, applied, and not-interested jobs.

## Before Finishing A Change

Run these checks when touching code:

```bash
node --check server.js
node --check public/app.js
git status --short
```

Also manually verify the relevant hash route when the change is UI-facing:

- `#overview`
- `#companies`
- `#jobs`
- `#pipeline`
- `#scanner`
- `#profile`
- `#email`
- `#feedback`

Do not claim a change is pushed unless `git status --short --branch` confirms
the local branch is even with `origin/main`.
