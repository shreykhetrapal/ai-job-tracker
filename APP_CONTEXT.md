# AI Job Tracker - App Context and Design Decisions

Last updated: May 31, 2026

This document is the durable product and engineering reference for the AI Job Tracker app. It explains what the app does, how the major workflows work, why key design decisions were made, and what tradeoffs are currently accepted.

Use this before making product, parser, matching, email, cache, auth, or deployment changes.

## 1. Product Goal

The app is a private, multi-user job tracking dashboard for people who want to monitor specific companies, scan their job boards, rank jobs against their profile and resume, and track applications.

The intended workflow is:

1. Select supported companies from the approved company catalog.
2. Request a company if it is not available yet.
3. Add profile details, target roles, skills, locations, avoid words, and resume text.
4. Run scans manually or let the server run daily scans while it is running.
5. Review jobs in Job Board by company, title, relevance, date, location, and status.
6. Shortlist or apply to promising roles.
7. Receive daily email digests with new relevant openings.

The app intentionally focuses on specific companies instead of searching the entire internet. This gives better control over parser quality, avoids noisy search results, and makes relevance ranking easier to debug.

## 2. Current Stack

- Runtime: Node.js, native `http` server.
- Frontend: static HTML/CSS/JavaScript under `public/`.
- Storage: Supabase Postgres through `DATABASE_URL`.
- LLM provider: OpenAI Responses API.
- Email provider: Resend.
- Local default host: `http://127.0.0.1:4173`, using the Supabase dev project.
- Public hosting: Render runs the Node service against the Supabase prod project.

### Why keep this simple stack instead of React and a backend framework?

Current decision: keep plain HTML/CSS/JS and a single Node server.

Tradeoffs:

- Pros:
  - Very low dependency surface.
  - Easy local startup with `npm start`.
  - Fewer moving parts while scanner and parser logic is evolving quickly.
  - Easy to deploy as one Render web service.
- Cons:
  - `public/app.js` and `server.js` are large.
  - UI state management is manual.
  - Component reuse is weaker than React.

The current decision is pragmatic for this phase. A React migration may make sense later if the UI grows substantially, but it should be treated as a separate frontend refactor, not mixed with scanner or matching changes.

## 3. User Roles

There are two roles:

- Regular user:
  - Can edit their own profile and resume.
  - Can select approved companies.
  - Can request new companies.
  - Can scan their own watchlist.
  - Can review jobs, mark relevance, shortlist, apply, or mark not interested.
  - Can configure their own email digest.
  - Sees a simplified Scanner view.

- Admin:
  - Can create and remove users.
  - Can see user usage stats.
  - Can review user company requests.
  - Can test requested companies.
  - Can approve companies into the global catalog.
  - Can test parser health for approved companies.
  - Can see detailed scanner/debug logs and failed scans across users.

### Why do regular users request companies instead of adding arbitrary URLs directly?

Company pages often need site-specific extraction rules. Letting users add arbitrary URLs directly creates a false expectation that any page will work. The current flow routes new companies through admin review so the admin can test the URL, inspect whether jobs are actually parsed, and approve it only when it is usable for everyone.

## 4. Data Storage

The app uses Supabase Postgres for persistent state. Local development and
production should use separate Supabase projects.

Main database tables:

- `users`: user accounts, admin flag, disabled flag.
- `sessions`: login sessions.
- `user_stores`: per-user JSON store for app-specific state.
- `usage_events`: scans and LLM call usage.
- `feedback_entries`: plain-text user feedback.
- `company_catalog`: approved global companies.
- `company_requests`: user requests for new companies.
- `email_digest_sends`: sent job records used to avoid emailing the same job again.

Per-user app state is stored as JSONB in `user_stores.data`. It includes:

- `profile`
- `resumeText`
- `targetCompanies`
- `companyScanJobs`
- `jobs`
- `jobFeedback`
- `jobDetailCache`
- `statuses`
- `emailDigest`
- `lastScrapeAt`
- `lastScrapeSummary`
- `scanRuns`

### Why keep user app state as JSONB inside Postgres?

Current decision: relational tables for account/global/shared concerns; JSONB
for evolving per-user dashboard state.

Tradeoffs:

- Pros:
  - Fast iteration while the product shape is still changing.
  - Avoids a migration for every job field or UI state tweak.
  - Keeps each user's dashboard state isolated.
- Cons:
  - Harder to query individual job fields across all users.
  - Harder to enforce field-level constraints.
  - Future analytics may require normalization.

This is acceptable for a small private app. If usage grows, `companyScanJobs`,
`statuses`, and `jobDetailCache` are candidates for normalized tables.

## 5. Authentication and Account Safety

Passwords are hashed with PBKDF2 SHA-256 using a random salt and 210,000 iterations.

Sessions are stored server-side and exposed to the browser through an `HttpOnly`, `SameSite=Lax` cookie. The cookie is marked `Secure` when the request indicates HTTPS through `x-forwarded-proto`.

Admins can create users and delete users. Deleting a user removes:

- sessions
- usage events
- feedback
- company requests
- email sent history
- user store
- user row
- active scan entries for that user

### Why provide admin-created usernames/passwords instead of self-signup?

The app currently uses the owner's OpenAI and Resend credentials. Open public signup would let unknown users spend API quota and email volume. Admin-created accounts are the simplest safe model for sharing with friends.

## 6. Companies and Company Catalog

There is a global approved company catalog. Users add companies to their own watchlist from this catalog.

Default approved companies currently include:

- Apple
- Meta
- Netflix
- Anthropic
- OpenAI
- Microsoft
- Google
- Walmart

The catalog is seeded on server startup. It is also deduplicated by URL/name and normalized so company sharing works across users.

When an admin approves a company request, it is inserted into `company_catalog`. It then becomes available to all users.

### Parser Health

Admins can test approved company parsers from the Companies page. Parser health test results include:

- parser name
- last parser check time
- raw jobs found
- saved jobs found
- LLM calls
- issues
- sample jobs
- recent calls/log lines

Parser health checks are diagnostic. They are not the same as a user's daily job scan.

## 7. Supported Parser Strategies

The scanner chooses the parser based on the company URL and page content.

Known parser paths:

- Apple:
  - Uses Apple careers pages and Apple job detail hydration data.
  - Apple pages often show poor body text without JavaScript, so detail extraction uses embedded hydration data where available.

- Meta:
  - Uses Meta Careers GraphQL search.
  - Normalizes job URLs to `/profile/job_details/{id}/` because `/jobs/{id}` links can be dead.

- Netflix and other Eightfold boards:
  - Reads Eightfold embedded positions.
  - Runs profile-derived query pages plus a landing-page pass.

- Anthropic and other Greenhouse boards:
  - Uses Greenhouse board API with `content=true`.

- OpenAI:
  - Tries OpenAI careers page.
  - Falls back to OpenAI's Ashby-backed board if the public page blocks server fetching.

- Microsoft:
  - Uses Microsoft Careers API search.
  - Uses profile-derived search queries.

- Google:
  - Uses Google careers search result pages.
  - Extracts job cards from returned HTML.

- Walmart:
  - Uses Walmart careers API/search behavior and Walmart job detail extraction.

- Ashby generic:
  - Extracts job board app data from Ashby pages.

- Generic link parser:
  - Scans links from the supplied careers page and keeps links that look like jobs or contain profile terms.

### Why maintain site-specific parsers?

Generic HTML scraping is not reliable enough for modern career pages. Many sites use APIs, embedded JSON, or JavaScript-rendered content. Site-specific parsers reduce false negatives and improve job detail quality.

Tradeoff: every parser can break when the company changes its site. That is why admin parser health exists.

## 8. Scan Flow

Scan scopes include:

- `manual all`
- `single company`
- `daily`
- `email digest`
- parser test scopes

Scan flow:

1. Create a `scanRun` with totals and per-company logs.
2. For each watchlist company:
   - fetch careers page
   - choose parser
   - extract raw jobs
   - filter by recent posted/updated date where possible
   - fetch job details as needed
   - run LLM summary/scoring unless cached or no API key
3. Deduplicate jobs.
4. Annotate jobs with relevance, location status, feedback memory, and sort score.
5. Merge results into the existing job board.
6. Store scan run, summary, cache, and updated company metadata.

Only the last 12 scan runs are stored per user. Admin failed-scan view collects recent failures across users and shows up to 80.

### Why merge scan results instead of replacing the whole board?

Earlier behavior caused previous successful jobs to disappear when a later scan failed. The current merge strategy replaces jobs only for companies that scanned successfully. If a company fails, its previous jobs remain visible. This is more useful and less destructive.

Tradeoff: stale jobs may stay visible after a company fails. That is preferable to wiping the board because of one transient parser or network failure.

## 9. Recency Filtering

The scanner keeps jobs posted or updated in the last 2 months when a parser can determine a posted/updated date.

Implementation constant:

- `RECENT_JOB_MONTHS = 2`

If a job board does not expose a reliable date, the app may use the current scan time as a fallback. This keeps potentially relevant jobs visible, but the date is less authoritative.

### Why last 2 months instead of a fixed job count cap?

The app previously had practical caps such as 25 jobs per company. That missed valid roles at larger companies. Date-based filtering is a better product rule because it expresses actual freshness.

Tradeoff: companies with hundreds of recent jobs can still produce many results and LLM calls. The cache and profile-derived searches mitigate this, but large companies can still be expensive.

## 10. Job Detail Cache

The per-user `jobDetailCache` avoids refetching and rescoring identical jobs unnecessarily.

Cache key:

```text
company id/name | external job identity | posted/updated date
```

External identity is extracted from common URL patterns such as:

- `/careers/job/{id}`
- `/job_details/{id}`
- `/jobs/{id}`
- `/details/{id}`
- `/job/{id}`
- query params such as `jobId`, `job_id`, `gh_jid`, `pid`, `reqId`, `requisitionId`

If no identity is found, the URL or job ID is hashed.

Cache entry stores:

- posting content
- summary
- LLM/source metadata
- relevance score
- role relevance score
- score range
- confidence
- location status
- listing/detail locations
- fit reasons
- concerns
- matched signals
- scoring input hash
- fetched/used timestamps

### Cache behavior

- Same job identity, same date, same scoring inputs:
  - Reuse posting content and LLM score.

- Same job identity, same date, changed profile/resume/feedback:
  - Reuse posting content.
  - Refresh personalized LLM score.

- Job ID same but posted/updated date changed:
  - Treat as a fresh cache key because the posting may have changed.

The cache is pruned after 3,000 entries, preserving active jobs and most recently used entries.

### Why include scoring inputs in the cache?

The posting content can be reused across profile changes, but the personalized score cannot. The scoring input hash includes:

- scoring schema version
- profile
- resume text
- job feedback

Tradeoff: any feedback/resume/profile change can invalidate LLM scores for cached postings. This costs more LLM calls, but it prevents stale personalization.

## 11. LLM Job Summaries and Matching

The app uses OpenAI Responses API when `OPENAI_API_KEY` is configured.

Default model:

```text
gpt-5-nano
```

The LLM call requests strict JSON using a JSON schema with:

- `summary`
- `relevanceScore`
- `scoreRange`
- `confidence`
- `locationMatchesProfile`
- `relevanceBucket`
- `fitReasons`
- `concerns`
- `matchedSignals`

The prompt instructs the model:

- summarize only the job posting
- do not summarize the candidate in the `summary`
- score role fit from 0 to 10
- do not reduce relevance score because of location
- use location as a separate signal
- use High only for 8-10, Medium for 5-7, Low for 0-4
- cap unrelated functions/domains even if they mention transferable skills

If there is no OpenAI key or no posting content, the app falls back to extracted posting text and heuristic scoring.

### Why strict JSON schema?

Free-form LLM output is hard to parse and debug. Strict schema gives the frontend stable fields and makes scanner failures more actionable.

Tradeoff: schema-constrained calls can fail if the provider or model has issues. The app records LLM failures in scanner logs and keeps the job with fallback data where possible.

## 12. Relevance Scoring

Relevance means role fit, not location eligibility.

Buckets:

- High: 8-10
- Medium: 5-7
- Low: 0-4

Sources of relevance:

1. Manual user score, if set.
2. Guarded LLM role score.
3. Guarded heuristic score.
4. Feedback token memory adjustment for ordering.

Manual score wins over LLM and heuristic relevance. If a user enters 10/10, the role relevance displays as 10/10 High.

### Role-family cap

The app applies a guardrail so unrelated roles cannot score too high simply because they mention generic transferable skills.

If the job title/posting does not match the user's target role family:

- cap score at 4 when the profile has domain-specific target tokens
- cap score at 6 when the profile is too generic

Example:

- A data/analytics candidate should not see a camera hardware engineering job as 7/10 simply because the LLM mentions analytical thinking or Python.

### Why separate relevance from location?

A job can be a strong role fit but ineligible because of location. Earlier versions mixed these into one score, causing valid role-fit feedback to be hidden.

Current rule:

- `relevanceScore` is role fit.
- `locationStatus` controls location eligibility.

Tradeoff: the UI needs to show both signals clearly. This is better than hiding location problems inside a low score.

## 13. Location Matching

Location fields:

- `listingLocation`: location from the listing/search feed.
- `detailLocation`: location extracted from the detail page.
- `locationMatchesProfile`: `Yes` or `No`.
- `locationStatus`: `match`, `mismatch`, `conflict`, or `unknown`.

Decision rules:

- If the candidate has no profile locations, location is treated as a match.
- Listing location is primary.
- Detail page location is secondary.
- If listing and detail conflict, status is `conflict`.
- If location does not match the profile, status is `mismatch`.

Shortlisting and email digest eligibility require location to be eligible. Manual 10/10 relevance does not override location mismatch or conflict.

### Why prefer listing location over detail page location?

Some career platforms embed stale or incorrect detail metadata. Netflix/Eightfold provided an example where the listing said `USA - Remote` while detail-page metadata said Panama. The listing feed is usually closer to what the job board intends users to see in search results.

Tradeoff: listing feeds can also be incomplete. Conflicts are surfaced rather than silently resolved.

## 14. Feedback Memory

Users can provide feedback in two ways:

- binary relevance: Relevant / Not relevant
- manual 0-10 relevance score

Feedback affects future ranking by:

- adding positive token weights from relevant/high-scored jobs
- adding negative token weights from not relevant/low-scored jobs
- including recent examples in the LLM prompt
- using manual score directly when the same job appears again

Manual score interpretation for memory:

- 7 or above: relevant example
- 3 or below: not relevant example
- 4-6: neutral/mild signal

### Why not train a model?

There is not enough data per user for model training. Lightweight memory is transparent, cheap, and easy to reset or reason about.

Tradeoff: token-based memory is less sophisticated than embeddings or model training. It is sufficient for a small personalized scanner and easier to debug.

## 15. Job Board

Job Board uses a three-pane layout:

1. Companies
2. Job titles
3. Job detail

Job title controls:

- search by title text
- filter by relevance bucket: High, Medium, Low
- default starts with High
- if no High jobs exist, auto-falls back to Medium, then Low
- sort by relevance or posted/updated date
- sort buttons toggle descending/ascending

Job row visual states:

- viewed
- shortlisted
- applied
- not interested
- selected

Clicking a job marks it viewed and stores `viewedAt`.

### Why use a folder-style Job Board?

The user wanted a file-browser-like workflow: pick company, then title, then inspect detail. It reduces cognitive load compared with one long table containing every job and makes per-company debugging easier.

## 16. Pipeline

Pipeline intentionally shows only:

- Shortlisted
- Applied

Jobs with no status stay only in Job Board. Jobs marked Not Interested are hidden from Pipeline.

Internal status values:

- `shortlisted`
- `applied`
- `rejected`

The UI displays `rejected` as `Not Interested`.

### Why keep internal status as `rejected`?

This avoided a migration and preserved existing stored data while improving the UI wording.

## 17. Resume and Profile

Profile fields:

- name
- seniority
- target job titles
- skills and keywords
- locations
- words to avoid
- profile notes

Resume input supports:

- direct text paste
- TXT
- MD
- DOC
- DOCX
- RTF
- HTML
- HTM
- ODT

DOC/DOCX/RTF/HTML/ODT extraction uses macOS `/usr/bin/textutil`.

PDF extraction is not supported yet. The app asks users to upload DOCX/TXT or paste text.

Resume features:

- global resume recommendations based on profile and current top jobs
- job-specific resume tweaks in the Job Board detail pane
- suggested add/keep/remove/tailor bullet guidance

### Why keep resume edits as recommendations only?

The user wanted control over final resume edits. The app should guide changes, not rewrite or submit resumes automatically.

## 18. Email Digest

Email is sent through Resend.

Required environment variables:

```text
RESEND_API_KEY
EMAIL_FROM
EMAIL_REPLY_TO optional
PUBLIC_APP_URL optional
```

Digest settings per user:

- enabled
- email address
- send time
- time zone
- minimum relevance score
- max jobs per email, clamped 1-50

The server checks email digests hourly while running. A digest sends once per local date after the user's configured send time.

Digest flow:

1. Run an email-digest scan for that user.
2. Apply scan result to the user's Job Board.
3. Exclude jobs already sent to that user using `email_digest_sends`.
4. Exclude jobs below min relevance score.
5. Exclude location-ineligible jobs.
6. Exclude applied and not interested jobs.
7. Sort by relevance, internal score, then posted date.
8. Send up to the user's configured max jobs.
9. Record sent jobs to avoid duplicates.
10. Add email digest stats to the scanner activity.

Email includes:

- grouped jobs by company
- role title
- location
- relevance bucket and score
- posting summary
- top fit reasons
- job link
- dashboard link when more jobs were eligible than sent

### Why scan again before sending the email?

The digest should represent fresh openings at send time, not only whatever was last manually scanned.

Tradeoff: email digests can use API calls and parser resources even if the user did not manually scan. Scanner activity now shows email runs so this cost is visible.

### Why record sent jobs?

The product promise is "new relevant openings." Without sent-history, users would receive the same jobs repeatedly.

Sent history uses the same stable job key as the cache: company, external identity, and date.

## 19. Scanner UI and Diagnostics

Regular users see a simplified Scanner:

- scan button
- running status
- last scan time
- jobs found/saved
- companies scanned
- issue count
- friendly company issue list
- progress bars for finding jobs and matching jobs

Admins see detailed scanner diagnostics:

- raw logs
- parser/extractor names
- per-company fetch details
- API/fetch internals
- LLM calls
- cache hits
- detail fetch counts
- failed scan tab across users

The `/api/scanner` response is sanitized for non-admin users so raw internals are not exposed through browser dev tools.

### Why have two Scanner experiences?

Most users need confidence that scans are running and enough issue context to report a problem. Admins need raw parser details to debug broken company pages. Showing the admin view to everyone creates unnecessary complexity and exposes internal URLs/logs.

## 20. Usage Limits

Default daily scan limit:

```text
DAILY_SCAN_LIMIT = 20
```

Default daily LLM limit:

```text
DAILY_LLM_LIMIT = null
```

Manual scan endpoints enforce the daily scan limit. LLM limit is only enforced if configured as a finite positive value.

Usage events track:

- scan count
- LLM call count

Admins can see per-user usage.

### Why keep LLM limit optional?

During development and testing, hard LLM caps interfered with validating parser and matching behavior. The app still tracks LLM calls so an admin can monitor usage. A production deployment with many users should set `DAILY_LLM_LIMIT`.

## 21. UI Structure

Current sidebar order:

1. Overview
2. Companies
3. Job Board
4. Pipeline
5. Profile
6. Email Digest
7. Scanner
8. Feedback

The latest UI direction is a bluish operational dashboard:

- navy sidebar
- grouped navigation
- sticky page header on desktop
- compact metric cards
- restrained blue active states
- cleaner table and panel styling
- mobile-safe layouts with horizontal table scroll inside containers

### Why bluish and operational instead of colorful/marketing style?

This is a work tool used repeatedly. Dense, scannable, low-distraction UI is more appropriate than a landing-page or decorative design.

## 22. Public Access and Render

The hosted app runs as a Render Node web service. Supabase Postgres stores
persistent app data.

Important operational fact:

- Render hosts the Node process and serves the static frontend.
- Render must use `HOST=0.0.0.0` and the Render-provided `PORT`.
- Render production should use the Supabase prod project.
- Local development should use the Supabase dev project.

### Why Render + Supabase?

It removes the dependency on a personal Mac staying awake and gives the app a
managed server plus managed database. The tradeoff is more environment and
migration discipline.

## 23. Environment Variables

Common environment variables:

```text
PORT=4173
HOST=0.0.0.0
DATABASE_URL=...
DATABASE_SSL=require
SESSION_DAYS=14
DAILY_SCAN_LIMIT=20
DAILY_LLM_LIMIT=
OPENAI_API_KEY=...
OPENAI_SUMMARY_MODEL=gpt-5-nano
RESEND_API_KEY=...
EMAIL_FROM="AI Job Tracker <jobs@ai-job-tracker.com>"
EMAIL_REPLY_TO=...
PUBLIC_APP_URL=https://ai-job-tracker.com/#jobs
ADMIN_EMAIL=...
ADMIN_PASSWORD=...
```

`.env` is intentionally ignored by git.

## 24. Important API Endpoints

Auth:

- `POST /api/login`
- `POST /api/logout`

State:

- `GET /api/health`
- `GET /api/state`
- `GET /api/scanner`
- `GET /api/llm-status`

Users/admin:

- `POST /api/users`
- `DELETE /api/users/:id`

Profile/resume:

- `POST /api/profile`
- `POST /api/resume`
- `POST /api/resume/upload`

Companies:

- `POST /api/companies`
- `DELETE /api/companies/:id`
- `POST /api/companies/:id/scan`
- `POST /api/companies/:id/reset`
- `POST /api/company-requests`
- `POST /api/company-requests/:id/test`
- `POST /api/company-requests/:id/approve`
- `POST /api/company-requests/:id/reject`
- `POST /api/company-catalog/:id/test`

Scanning:

- `POST /api/scrape`

Jobs:

- `POST /api/jobs/:id`
- `POST /api/jobs/:id/viewed`
- `POST /api/jobs/:id/feedback`

Email:

- `POST /api/email-digest/settings`
- `POST /api/email-digest/test`

Feedback:

- `POST /api/feedback`

## 25. Key Product Decisions and Interview-Style Answers

### Why focus on company-specific scanning instead of broad internet search?

Broad job search is noisy, duplicative, and hard to debug. Company-specific scanning gives the user control over their target list and lets us build reliable parsers for known sources.

### Why require admin approval for new companies?

Because a careers URL is not enough. Different platforms need different parsing rules. Admin approval prevents users from thinking a new URL will automatically work when the parser is not ready.

### Why keep previous jobs when a scan fails?

A failed scan is often transient. Removing previous results because a parser failed would destroy useful state and make the app feel unreliable. The app now updates only successfully scanned companies.

### Why use LLMs at all?

Raw job pages are inconsistent. The LLM normalizes summaries and provides personalized fit reasons, concerns, matched signals, confidence, and score range. This is useful when a user is reviewing many roles.

### Why not trust the LLM completely?

The app applies deterministic guardrails:

- strict JSON schema
- role-family score caps
- location computed outside the LLM
- manual scores override model scores
- cache invalidation includes scoring schema version
- fallback summaries reject candidate-centric wording

### Why can manual 10/10 coexist with location mismatch?

Manual score means role fit. Location is eligibility. A user can say a role is a perfect role match while still being unable or unwilling to apply because of location.

### Why exclude applied and not interested jobs from email digest?

The digest should surface jobs needing attention. Applied and not interested roles are already resolved.

### Why include email digest runs in Scanner?

Email digests can trigger scans, cache hits, and LLM calls. Showing them in Scanner makes usage visible and helps debug "why did I get this email?" or "why did email cost API calls?"

### Why store sent email history separately?

Sent history needs a durable uniqueness constraint per user/job. Storing it in `email_digest_sends` avoids repeated emails and works even if the user's current job board changes.

### Why keep scanner internals hidden from regular users?

Raw parser/API logs are useful to admins but overwhelming to users. Sanitizing `/api/scanner` also prevents internals from being exposed through network inspection.

### Why keep admin-controlled users instead of public signup?

The app still uses the owner's OpenAI and Resend credentials. Admin-created
accounts avoid uncontrolled API/email usage while allowing friends to use the
hosted app independently.

## 26. Current Known Limitations

- App availability depends on Render web service uptime and Supabase database availability.
- Parser health depends on external company websites that can change without notice.
- Some company pages do not expose reliable posted dates.
- PDF resume extraction is not implemented.
- Per-user JSON store makes cross-user analytics harder.
- There is no background job queue; scans run inside the server process.
- Email scheduling checks hourly, not minute-exact.
- LLM cost can grow with large companies and changed scoring inputs.

## 27. Good Future Improvements

Practical next improvements:

- Move long-running scans to a background queue.
- Add per-user API usage budgets and admin cost reporting.
- Normalize jobs/cache/statuses into relational tables if data grows.
- Add parser unit tests with saved HTML/API fixtures.
- Add hosted deployment with process supervision.
- Add PDF text extraction using a reliable local or server-side parser.
- Add embeddings or better similarity memory once there is enough feedback data.
- Add per-company parser versioning so cache invalidation can respond to parser changes.

## 28. Git and Secrets Policy

Safe to commit:

- `server.js`
- `public/`
- `README.md`
- `APP_CONTEXT.md`
- non-secret config examples

Do not commit:

- `.env`
- `data/app.db`
- `data/*.db-wal`
- `data/*.db-shm`
- `data/admin-login.txt`
- Supabase connection strings
- API keys
- passwords
- user databases

The current `.gitignore` is designed to protect these local secrets and data files.
