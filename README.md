# Job Application Dashboard

A private local dashboard for scanning specific company career pages, reviewing found jobs, and tracking applications.

## Run

```bash
npm start
```

Open `http://127.0.0.1:4173`.

## How It Works

- Save your target roles, skills, locations, seniority, and avoid words in the Profile view.
- Select approved companies in the Companies view.
- Request a new company if it is not available yet; admins can test the parser and approve it into the shared company catalog.
- Use Scan all companies from the sidebar to fetch current openings from those company pages.
- Use Scan on a company card to refresh one company individually.
- Use the Scanner view to start a scan and inspect live scan progress, company fetches, jobs found, LLM calls, and scan errors.
- Company watchlist pages are checked on the daily scan cadence while the server is running.
- Review scanned jobs in the Job Board view and expand a row for resume tweaks.
- Use the company / title / job-detail columns in Job Board to drill into one company's roles.
- Mark jobs as Relevant or Not relevant so future scans can prioritize roles with similar language.
- When LLM summaries are enabled, each scanned job gets a personalized 0-10 relevance score, fit reasons, concerns, and matched signals using your profile, resume text, and prior relevance feedback.
- Move jobs through New, Shortlisted, Applied, or Passed from the company results table.
- Upload or paste resume text in the Profile view to get targeted edit recommendations.

## LLM Summaries

Create a local `.env` file to generate LLM-written job summaries without typing your API key every time:

```bash
cp .env.example .env
```

Then edit `.env` and replace `sk-your-api-key-here` with your OpenAI API key. By default, summaries use `gpt-5-nano`, OpenAI's smallest GPT-5 option for low-cost summarization. Optional: change `OPENAI_SUMMARY_MODEL` to choose another model. Without an API key, the app uses extracted posting text as a fallback.

The app checks for a fresh scrape when the server starts and then checks hourly whether a new daily scrape is due. The server needs to be running for automatic daily scans.

## Email Digest

The Email Digest tab can send one morning email per user with new relevant jobs that have not already been emailed.

Add these values to `.env` and restart the app:

```bash
RESEND_API_KEY=re_your_resend_api_key_here
EMAIL_FROM="AI Job Tracker <jobs@ai-job-tracker.com>"
EMAIL_REPLY_TO="you@example.com"
```

Replace `re_your_resend_api_key_here` with your real Resend API key. Do not paste the key into `server.js` or any frontend file.

`EMAIL_FROM` can be either a plain verified sender such as `jobs@ai-job-tracker.com` or a named sender such as `AI Job Tracker <jobs@ai-job-tracker.com>`. The domain or sender must be verified in Resend. If you use Resend's starter sender, set `EMAIL_FROM=onboarding@resend.dev` while testing.

Verify `ai-job-tracker.com` in Resend and add the DNS records in Cloudflare before enabling digests. The app checks hourly and sends once per day after each user's configured send time in their selected timezone.

## Data

User accounts, sent digest history, usage, and feedback are stored locally in `data/app.db`. Each user's profile, resume text, companies, scanned jobs, and application statuses are stored separately under `data/users/`.
