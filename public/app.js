const state = {
  profile: {},
  resumeText: "",
  targetCompanies: [],
  availableCompanies: [],
  companyRequests: [],
  companyScanJobs: [],
  jobs: [],
  jobFeedback: {},
  statuses: {},
  scanRuns: [],
  activeScanRuns: [],
  feedbackEntries: [],
  emailDigest: {},
  emailDigestStatus: {},
  recommendations: [],
  lastScrapeAt: null,
  lastScrapeSummary: null,
  view: "overview",
  companiesTab: "watchlist",
  selectedCompanyId: null,
  selectedCompanyJobId: null,
  jobTitleSort: "relevance",
  jobTitleSortDirection: "desc",
  jobTitleSearch: "",
  jobPaneScroll: {
    companies: 0,
    titles: 0,
    detail: 0
  },
  scannerOpenRunIds: new Set(),
  activeScan: null
};

if (window.location.protocol === "file:") {
  window.location.replace("http://127.0.0.1:4173/");
}

const apiBase = "";

const els = {
  navButtons: document.querySelectorAll(".nav-button"),
  views: document.querySelectorAll(".view"),
  viewTitle: document.querySelector("#viewTitle"),
  scanNow: document.querySelector("#scanNow"),
  lastScrape: document.querySelector("#lastScrape"),
  checkLlm: document.querySelector("#checkLlm"),
  llmStatus: document.querySelector("#llmStatus"),
  currentUserEmail: document.querySelector("#currentUserEmail"),
  logoutButton: document.querySelector("#logoutButton"),
  watchCompanyMetric: document.querySelector("#watchCompanyMetric"),
  companyJobMetric: document.querySelector("#companyJobMetric"),
  shortlistMetric: document.querySelector("#shortlistMetric"),
  appliedMetric: document.querySelector("#appliedMetric"),
  jobsViewCompanyMetric: document.querySelector("#jobsViewCompanyMetric"),
  jobsViewJobMetric: document.querySelector("#jobsViewJobMetric"),
  jobsViewShortlistMetric: document.querySelector("#jobsViewShortlistMetric"),
  jobsViewAppliedMetric: document.querySelector("#jobsViewAppliedMetric"),
  scannerRunMetric: document.querySelector("#scannerRunMetric"),
  scannerJobMetric: document.querySelector("#scannerJobMetric"),
  scannerLlmMetric: document.querySelector("#scannerLlmMetric"),
  scannerIssueMetric: document.querySelector("#scannerIssueMetric"),
  scannerCurrent: document.querySelector("#scannerCurrent"),
  scannerRunList: document.querySelector("#scannerRunList"),
  scannerScanNow: document.querySelector("#scannerScanNow"),
  companyTabButtons: document.querySelectorAll(".company-tab-button"),
  companyTabPanels: document.querySelectorAll(".company-tab-panel"),
  presetCompanySelect: document.querySelector("#presetCompanySelect"),
  selectAllPresetCompanies: document.querySelector("#selectAllPresetCompanies"),
  addPresetCompanies: document.querySelector("#addPresetCompanies"),
  companyRequestForm: document.querySelector("#companyRequestForm"),
  clearCompanyRequestForm: document.querySelector("#clearCompanyRequestForm"),
  watchCompanyCount: document.querySelector("#watchCompanyCount"),
  watchCompanyList: document.querySelector("#watchCompanyList"),
  companyRequestCount: document.querySelector("#companyRequestCount"),
  companyRequestList: document.querySelector("#companyRequestList"),
  adminCompanyHealth: document.querySelector("#adminCompanyHealth"),
  companyHealthCount: document.querySelector("#companyHealthCount"),
  companyHealthList: document.querySelector("#companyHealthList"),
  companyJobCount: document.querySelector("#companyJobCount"),
  jobListLastScanned: document.querySelector("#jobListLastScanned"),
  companyJobTable: document.querySelector("#companyJobTable"),
  profileForm: document.querySelector("#profileForm"),
  resumeForm: document.querySelector("#resumeForm"),
  resumeText: document.querySelector("#resumeText"),
  resumeUpload: document.querySelector("#resumeUpload"),
  resumeUploadStatus: document.querySelector("#resumeUploadStatus"),
  recommendationList: document.querySelector("#recommendationList"),
  adminPanel: document.querySelector("#adminPanel"),
  userForm: document.querySelector("#userForm"),
  userList: document.querySelector("#userList"),
  emailDigestForm: document.querySelector("#emailDigestForm"),
  emailTimeZone: document.querySelector("#emailTimeZone"),
  emailDigestConfigured: document.querySelector("#emailDigestConfigured"),
  emailDigestStatus: document.querySelector("#emailDigestStatus"),
  emailDigestMeta: document.querySelector("#emailDigestMeta"),
  sendTestEmail: document.querySelector("#sendTestEmail"),
  feedbackForm: document.querySelector("#feedbackForm"),
  feedbackText: document.querySelector("#feedbackText"),
  feedbackCount: document.querySelector("#feedbackCount"),
  feedbackList: document.querySelector("#feedbackList"),
  pipeline: document.querySelector("#pipeline")
};

const viewTitles = {
  overview: "Overview",
  companies: "Company Watchlist",
  scanner: "Scanner Activity",
  jobs: "Job Board",
  profile: "Your Profile",
  email: "Email Digest",
  feedback: "Feedback",
  pipeline: "Application Pipeline"
};

const commonTimeZones = [
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Toronto",
  "Europe/London",
  "Europe/Paris",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "UTC"
];

function viewFromHash() {
  const view = window.location.hash.replace("#", "");
  return viewTitles[view] ? view : "overview";
}

async function api(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const raw = await response.text();
  let data = {};
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      const isHtml = /^\s*</.test(raw);
      throw new Error(isHtml
        ? "The app returned a web page instead of data. Refresh the page, sign in again, and make sure the app server was restarted."
        : "The app returned a response I could not read.");
    }
  }
  if (response.status === 401) {
    window.location.href = "/login.html";
    throw new Error("Sign in required.");
  }
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function updateState(next) {
  Object.assign(state, next);
  syncSelections();
  render();
}

function dateLabel(value) {
  if (!value) return "Unknown date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function numberLabel(value) {
  if (value === null || value === undefined || value === "") return "unlimited";
  return Number(value || 0).toLocaleString();
}

function dateTimeLabel(value) {
  if (!value) return "Not scanned yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not scanned yet";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function relativeLabel(value) {
  if (!value) return "No scan yet";
  const diff = Date.now() - new Date(value).getTime();
  const hours = Math.max(0, Math.round(diff / (60 * 60 * 1000)));
  if (hours < 1) return "Scanned just now";
  if (hours < 24) return `Scanned ${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `Scanned ${days} day${days === 1 ? "" : "s"} ago`;
}

function durationLabel(startedAt, finishedAt) {
  if (!startedAt) return "";
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "";
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function statusText(value) {
  return String(value || "unknown").replaceAll("_", " ");
}

function localActiveScanRun() {
  if (!state.activeScan) return null;
  return {
    id: "local-active-scan",
    scope: "starting",
    status: "running",
    startedAt: state.activeScan.startedAt,
    finishedAt: null,
    totals: {
      companies: state.activeScan.companies.length,
      rawJobsFound: 0,
      jobsFound: 0,
      pageFetches: 0,
      detailFetches: 0,
      metaApiCalls: 0,
      llmCalls: 0,
      llmSucceeded: 0,
      llmFailed: 0,
      errors: 0
    },
    companies: state.activeScan.companies.map((company) => ({
      id: company.id,
      name: company.name,
      careersUrl: company.careersUrl,
      status: "queued",
      extractor: "Waiting for scanner",
      rawJobsFound: 0,
      jobsFound: 0,
      llmCalls: 0,
      errors: [],
      calls: []
    }))
  };
}

function runIssueCount(run) {
  const totals = run.totals || {};
  const companyErrors = (run.companies || []).reduce((count, company) => count + (company.errors?.length || 0), 0);
  return Math.max(totals.errors || 0, companyErrors);
}

function runFailureSummary(run) {
  const totals = run.totals || {};
  const issues = runIssueCount(run);
  const failedCompanies = (run.companies || []).filter((company) => company.status === "failed").length;
  const apiFailures = (run.companies || []).reduce((count, company) => {
    return count + (company.calls || []).filter((call) => call.status === "error" && /api|fetch|detail|page|scan/i.test(`${call.type} ${call.message}`)).length;
  }, 0);
  const parts = [];
  if (issues) parts.push(`${issues} issue${issues === 1 ? "" : "s"}`);
  if (failedCompanies) parts.push(`${failedCompanies} company failure${failedCompanies === 1 ? "" : "s"}`);
  if (apiFailures) parts.push(`${apiFailures} fetch/API failure${apiFailures === 1 ? "" : "s"}`);
  if (totals.llmFailed) parts.push(`${totals.llmFailed} LLM failure${totals.llmFailed === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" · ") : "No failures";
}

function completedCompanyCount(run) {
  return (run.companies || []).filter((company) => ["completed", "completed_with_issues", "failed"].includes(company.status)).length;
}

function scanProgressValues(run) {
  const totals = run.totals || {};
  const companyCount = Math.max(1, totals.companies || (run.companies || []).length || 1);
  const completedCompanies = completedCompanyCount(run);
  const active = run.status === "running";
  const rawJobs = Number(totals.rawJobsFound || 0);
  const savedJobs = Number(totals.jobsFound || 0);
  const remainingCompanies = Math.max(0, companyCount - completedCompanies);
  const jobTarget = active
    ? Math.max(rawJobs + remainingCompanies * 10, rawJobs, savedJobs, 1)
    : Math.max(rawJobs, savedJobs, 1);
  const llmDone = Number(totals.llmSucceeded || 0) + Number(totals.llmFailed || 0) + Number(totals.llmCacheHits || 0);
  const llmTarget = Math.max(rawJobs, savedJobs, llmDone, 1);
  return {
    jobsPercent: active ? Math.min(100, Math.round((rawJobs / jobTarget) * 100)) : (rawJobs || savedJobs ? 100 : 0),
    llmPercent: active ? Math.min(100, Math.round((llmDone / llmTarget) * 100)) : (llmTarget > 1 ? 100 : 0),
    rawJobs,
    savedJobs,
    llmDone,
    llmTarget,
    completedCompanies,
    companyCount
  };
}

function scannerLogLine(call) {
  const timestamp = call.at ? new Date(call.at) : null;
  const time = timestamp && !Number.isNaN(timestamp.getTime())
    ? `${String(timestamp.getHours()).padStart(2, "0")}:${String(timestamp.getMinutes()).padStart(2, "0")}:${String(timestamp.getSeconds()).padStart(2, "0")}.${String(timestamp.getMilliseconds()).padStart(3, "0")}`
    : "--:--:--.---";
  const status = String(call.status || "ok").toUpperCase().padEnd(5, " ");
  const count = call.count === null || call.count === undefined ? "" : ` (${call.count})`;
  const target = call.target ? ` ${call.target}` : "";
  const message = call.message ? ` - ${call.message}` : "";
  return `[${time}] ${status} ${call.type || "scan"}${count}${target}${message}`;
}

function scrollScannerLogsToLatest() {
  const scroll = () => {
    for (const logView of document.querySelectorAll(".scanner-log-view")) {
      logView.scrollTop = logView.scrollHeight;
    }
  };
  requestAnimationFrame(() => {
    scroll();
    setTimeout(scroll, 0);
    setTimeout(scroll, 80);
  });
}

function statusFor(job) {
  return state.statuses[job.id]?.status || "new";
}

function relevanceFor(job) {
  return state.jobFeedback?.[job.id]?.relevance || job.relevance || null;
}

function manualRelevanceScoreFor(job) {
  const score = Number(state.jobFeedback?.[job.id]?.manualRelevanceScore ?? job.manualRelevanceScore);
  return Number.isFinite(score) ? score : null;
}

function relevanceScoreLabel(job) {
  return Number.isFinite(Number(job.relevanceScore)) ? `${Number(job.relevanceScore)}/10` : `${job.priority} · ${job.score}`;
}

function scoreRangeLabel(job) {
  const low = Number(job.scoreRange?.low);
  const high = Number(job.scoreRange?.high);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return "";
  return `${Math.min(low, high)}-${Math.max(low, high)}/10`;
}

function locationMatchesLabel(job) {
  if (job.locationMatchesProfile === "Yes") return "Location match: Yes";
  if (job.locationMatchesProfile === "No") return "Location match: No";
  return "";
}

function browserTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Los_Angeles";
}

function renderTimeZoneOptions(selectedValue = browserTimeZone()) {
  if (!els.emailTimeZone) return;
  const selected = selectedValue || browserTimeZone();
  const zones = [...new Set([selected, browserTimeZone(), ...commonTimeZones])].filter(Boolean);
  els.emailTimeZone.replaceChildren();
  for (const zone of zones) {
    const option = document.createElement("option");
    option.value = zone;
    option.textContent = zone.replace(/_/g, " ");
    option.selected = zone === selected;
    els.emailTimeZone.append(option);
  }
}

function jobsByCompany() {
  const grouped = new Map();
  for (const company of state.targetCompanies) grouped.set(company.id, []);
  for (const job of companySiteJobs()) {
    const key = job.companyId || state.targetCompanies.find((company) => company.name === job.company)?.id || job.company;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(job);
  }
  return grouped;
}

function selectedCompanyJobs() {
  const query = String(state.jobTitleSearch || "").trim().toLowerCase();
  const direction = state.jobTitleSortDirection === "asc" ? 1 : -1;
  const jobs = [...(jobsByCompany().get(state.selectedCompanyId) || [])]
    .filter((job) => !query || String(job.title || "").toLowerCase().includes(query));

  if (state.jobTitleSort === "date") {
    return jobs.sort((a, b) => direction * (new Date(a.postedAt || 0) - new Date(b.postedAt || 0)) || (b.relevanceScore || 0) - (a.relevanceScore || 0));
  }

  return jobs.sort((a, b) => direction * ((Number(a.relevanceScore || 0) - Number(b.relevanceScore || 0)) || (Number(a.score || 0) - Number(b.score || 0))) || new Date(b.postedAt || 0) - new Date(a.postedAt || 0));
}

function nextSortDirection(sortKey) {
  if (state.jobTitleSort !== sortKey) return "desc";
  return state.jobTitleSortDirection === "desc" ? "asc" : "desc";
}

function sortArrow(sortKey) {
  if (state.jobTitleSort !== sortKey) return "";
  return state.jobTitleSortDirection === "asc" ? " ↑" : " ↓";
}

function jobTitleMetaLabel(job) {
  const relevance = relevanceFor(job);
  const parts = [];
  if (relevance === "relevant") parts.push("Relevant");
  if (relevance === "not_relevant") parts.push("Not relevant");
  parts.push(`${relevanceScoreLabel(job)} relevance`);
  parts.push(`Posted ${dateLabel(job.postedAt)}`);
  return parts.join(" · ");
}

function captureJobPaneScroll() {
  const panes = els.companyJobTable?.querySelectorAll(".folder-pane, .job-detail-pane") || [];
  if (panes[0]) state.jobPaneScroll.companies = panes[0].scrollTop;
  if (panes[1]) state.jobPaneScroll.titles = panes[1].scrollTop;
  if (panes[2]) state.jobPaneScroll.detail = panes[2].scrollTop;
}

function restoreJobPaneScroll() {
  const panes = els.companyJobTable?.querySelectorAll(".folder-pane, .job-detail-pane") || [];
  if (panes[0]) panes[0].scrollTop = state.jobPaneScroll.companies || 0;
  if (panes[1]) panes[1].scrollTop = state.jobPaneScroll.titles || 0;
  if (panes[2]) panes[2].scrollTop = state.jobPaneScroll.detail || 0;
}

function selectCompanyInJobPane(companyId) {
  if (!companyId) return;
  state.selectedCompanyId = companyId;
  state.selectedCompanyJobId = selectedCompanyJobs()[0]?.id || null;
  state.jobPaneScroll = { companies: 0, titles: 0, detail: 0 };
}

function syncSelections() {
  const companies = state.targetCompanies || [];
  const groups = jobsByCompany();
  if (!state.selectedCompanyId || !companies.some((company) => company.id === state.selectedCompanyId)) {
    state.selectedCompanyId = companies[0]?.id || null;
  }
  const jobs = groups.get(state.selectedCompanyId) || [];
  if (!state.selectedCompanyJobId || !jobs.some((job) => job.id === state.selectedCompanyJobId)) {
    state.selectedCompanyJobId = jobs[0]?.id || null;
  }
}

function renderMetrics() {
  const jobs = companySiteJobs();
  const companies = state.targetCompanies.length;
  const shortlisted = jobs.filter((job) => statusFor(job) === "shortlisted").length;
  const applied = jobs.filter((job) => statusFor(job) === "applied").length;
  for (const el of [els.watchCompanyMetric, els.jobsViewCompanyMetric]) el.textContent = companies;
  for (const el of [els.companyJobMetric, els.jobsViewJobMetric]) el.textContent = jobs.length;
  for (const el of [els.shortlistMetric, els.jobsViewShortlistMetric]) el.textContent = shortlisted;
  for (const el of [els.appliedMetric, els.jobsViewAppliedMetric]) el.textContent = applied;
}

function scanResultFor(company) {
  return state.lastScrapeSummary?.targetCompanyResults?.find((item) => item.id === company.id);
}

function canonicalCompanyUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return String(value || "").trim().replace(/\/$/, "").toLowerCase();
  }
}

function presetCompanyExists(preset) {
  const presetName = preset.name.toLowerCase();
  const presetUrl = canonicalCompanyUrl(preset.careersUrl);
  return (state.targetCompanies || []).some((company) =>
    String(company.name || "").trim().toLowerCase() === presetName ||
    canonicalCompanyUrl(company.careersUrl) === presetUrl
  );
}

function companySiteJobs() {
  const stored = state.companyScanJobs || [];
  if (stored.length) return stored;
  return state.jobs.filter((job) => job.source === "Company Site");
}

function importantJobTerms(job) {
  const jobText = `${job.title} ${job.description} ${(job.tags || []).join(" ")}`.toLowerCase();
  const skills = state.profile?.skills || [];
  return skills.filter((skill) => jobText.includes(String(skill).toLowerCase())).slice(0, 8);
}

function tokenizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9+#.]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !["and", "for", "the", "with", "from", "that", "this", "you", "your", "job", "role"].includes(token));
}

function resumeBullets() {
  return String(state.resumeText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*•]\s*/, "").trim())
    .filter((line) => line.length > 32);
}

function jobSignalTerms(job) {
  return [...new Set([
    ...tokenizeText(job.title),
    ...importantJobTerms(job).flatMap(tokenizeText),
    ...(job.matchedSignals || []).flatMap(tokenizeText)
  ])].slice(0, 24);
}

function bulletOverlapScore(bullet, terms) {
  const text = bullet.toLowerCase();
  return terms.reduce((score, term) => score + (text.includes(term.toLowerCase()) ? 1 : 0), 0);
}

function resumeTweaksForJob(job) {
  const resume = String(state.resumeText || "");
  const resumeLower = resume.toLowerCase();
  const terms = importantJobTerms(job);
  const missingTerms = terms.filter((term) => !resumeLower.includes(String(term).toLowerCase()));
  const bullets = resumeBullets();
  const signalTerms = jobSignalTerms(job);
  const scoredBullets = bullets
    .map((bullet) => ({ bullet, score: bulletOverlapScore(bullet, signalTerms) }))
    .sort((a, b) => a.score - b.score);
  const strongestBullet = [...scoredBullets].sort((a, b) => b.score - a.score)[0];
  const weakestBullet = scoredBullets.find((item) => item.score === 0) || scoredBullets[0];
  const tweaks = [];

  if (!resume.trim()) {
    return [
      { action: "Add", detail: "Paste your resume text in the Resume tab to get job-specific bullet-level tweaks here." },
      { action: "Add", detail: `For this role, start by mirroring the title "${job.title}" near the top if it is truthful for your background.` }
    ];
  }

  if (!resumeLower.includes(job.title.toLowerCase())) {
    tweaks.push({ action: "Add", detail: `Add or adjust the headline/summary toward "${job.title}" for this application.` });
  }

  if (missingTerms.length) {
    tweaks.push({ action: "Add", detail: `Add these missing keywords where truthful: ${missingTerms.join(", ")}.` });
  }

  if (!/\d+%|\$\d+|\d+x|\b\d+\+/.test(resume)) {
    tweaks.push({ action: "Add", detail: "Add one measurable result near the top: scale, revenue, time saved, adoption, accuracy, or team size." });
  }

  if (strongestBullet?.score > 0) {
    tweaks.push({ action: "Keep", detail: `Keep and move higher if space is tight: "${strongestBullet.bullet}"` });
  }

  if (weakestBullet && bullets.length > 3) {
    tweaks.push({ action: "Remove or replace", detail: `This bullet is least connected to the posting language: "${weakestBullet.bullet}"` });
  }

  const addBulletTerms = (missingTerms.length ? missingTerms : terms).slice(0, 3).join(", ");
  tweaks.push({
    action: "Add",
    detail: `Add a role-specific bullet if truthful: "Built or improved ${addBulletTerms || job.title} work that drove [metric/result] across [stakeholders/system]."`
  });
  tweaks.push({ action: "Tailor", detail: `Use ${job.company}'s posting language in one bullet, especially around ${terms.slice(0, 4).join(", ") || job.title}.` });
  return tweaks;
}

function renderWatchCompanies() {
  const companies = state.targetCompanies || [];
  renderPresetCompanies();
  els.watchCompanyCount.textContent = `${companies.length} compan${companies.length === 1 ? "y" : "ies"}`;
  els.watchCompanyList.replaceChildren();

  if (!companies.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Select approved companies above. They will be checked during each daily scan.";
    els.watchCompanyList.append(empty);
    return;
  }

  const tableWrap = document.createElement("div");
  tableWrap.className = "company-watch-table-wrap";
  const table = document.createElement("table");
  table.className = "company-watch-table";
  table.innerHTML = `
    <thead>
      <tr>
        <th>Company</th>
        <th>Careers URL</th>
        <th>Last scan</th>
        <th>Notes</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector("tbody");

  for (const company of companies) {
    const result = scanResultFor(company);
    const row = document.createElement("tr");
    const lastChecked = result?.checkedAt || company.lastCheckedAt;
    const found = result?.found ?? company.lastFoundCount ?? 0;
    const error = result?.error || company.lastError;
    row.innerHTML = `
      <td><strong class="company-table-name"></strong></td>
      <td><span class="company-url"></span></td>
      <td><span class="company-scan-meta"></span></td>
      <td><span class="company-notes"></span></td>
      <td>
        <div class="company-table-actions">
        <a class="ghost-button" target="_blank" rel="noreferrer">Open</a>
        <button type="button" data-action="scan">Scan</button>
        <button type="button" data-action="reset">Reset jobs</button>
        <button type="button" data-action="delete">Remove</button>
        </div>
      </td>
    `;
    row.querySelector(".company-table-name").textContent = company.name;
    row.querySelector(".company-url").textContent = company.careersUrl;
    row.querySelector(".company-scan-meta").textContent = error
      ? `Last scan issue: ${error}`
      : `${lastChecked ? `Last checked ${dateTimeLabel(lastChecked)}` : "Not checked yet"} · ${found} matching link${found === 1 ? "" : "s"} found`;
    row.querySelector(".company-notes").textContent = company.notes || "—";
    row.querySelector("a").href = company.careersUrl;
    row.querySelector('[data-action="scan"]').addEventListener("click", (event) => scanCompany(company.id, event.currentTarget));
    row.querySelector('[data-action="reset"]').addEventListener("click", () => resetCompanyJobs(company.id, company.name));
    row.querySelector('[data-action="delete"]').addEventListener("click", () => deleteCompany(company.id));
    tbody.append(row);
  }

  tableWrap.append(table);
  els.watchCompanyList.append(tableWrap);
}

function renderPresetCompanies() {
  if (!els.presetCompanySelect) return;
  els.presetCompanySelect.replaceChildren();
  for (const preset of state.availableCompanies || []) {
    const exists = presetCompanyExists(preset);
    const option = document.createElement("option");
    option.value = preset.id;
    option.disabled = exists;
    option.textContent = `${preset.name} · ${exists ? "already added" : preset.scanner || "approved parser"}`;
    els.presetCompanySelect.append(option);
  }
}

function renderCompanyTabs() {
  const isAdmin = Boolean(state.currentUser?.isAdmin);
  if (!isAdmin && state.companiesTab === "parser") {
    state.companiesTab = "watchlist";
  }

  els.companyTabButtons.forEach((button) => {
    const adminOnly = button.dataset.adminOnly === "true";
    const active = button.dataset.companyTab === state.companiesTab;
    button.hidden = adminOnly && !isAdmin;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });

  els.companyTabPanels.forEach((panel) => {
    const adminOnly = panel.dataset.adminOnly === "true";
    const active = panel.dataset.companyPanel === state.companiesTab;
    panel.hidden = (adminOnly && !isAdmin) || !active;
    panel.classList.toggle("active", active);
  });
}

function requestStatusLabel(request) {
  const labels = {
    pending: "Pending",
    tested: "Tested",
    test_failed: "Test failed",
    approved: "Approved",
    rejected: "Rejected"
  };
  return labels[request.status] || request.status || "Pending";
}

function parserTestLabel(summary) {
  if (!summary) return "Not tested";
  const issueText = summary.error ? ` · ${summary.error}` : "";
  const parserText = summary.extractor ? `${summary.extractor} · ` : "";
  const reasonText = summary.failureReason ? ` · ${summary.failureReason}` : issueText;
  return `${parserText}${summary.jobsFound || 0} saved · ${summary.rawJobsFound || 0} raw · ${summary.llmCalls || 0} LLM · ${summary.errors || 0} issues${reasonText}`;
}

function requestTestLabel(request) {
  return parserTestLabel(request.testSummary);
}

function scannerLogText(call) {
  const time = call.at ? dateTimeLabel(call.at) : "Unknown time";
  const status = String(call.status || "ok").toUpperCase();
  const count = call.count === null || call.count === undefined ? "" : ` (${call.count})`;
  const target = call.target ? ` ${call.target}` : "";
  const message = call.message ? ` - ${call.message}` : "";
  return `[${time}] ${status} ${call.type || "scan"}${count}${target}${message}`;
}

function renderParserTestResult(cell, summary) {
  cell.textContent = parserTestLabel(summary);
  if (!summary?.calls?.length) return;

  const details = document.createElement("details");
  details.className = "request-test-log";
  details.innerHTML = `<summary>Test log</summary><pre></pre>`;
  details.querySelector("pre").textContent = summary.calls.map(scannerLogText).join("\n");
  cell.append(details);
}

function renderRequestTestResult(cell, request) {
  renderParserTestResult(cell, request.testSummary);
}

function renderCompanyParserHealth() {
  if (!els.adminCompanyHealth || !els.companyHealthList) return;
  const isAdmin = Boolean(state.currentUser?.isAdmin);
  if (!isAdmin) return;

  const companies = state.availableCompanies || [];
  els.companyHealthCount.textContent = `${companies.length} compan${companies.length === 1 ? "y" : "ies"}`;
  els.companyHealthList.replaceChildren();

  if (!companies.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No approved companies yet.";
    els.companyHealthList.append(empty);
    return;
  }

  const table = document.createElement("table");
  table.className = "company-request-table parser-health-table";
  table.innerHTML = `
    <thead>
      <tr>
        <th>Company</th>
        <th>Parser</th>
        <th>Last parser check</th>
        <th>Result</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector("tbody");
  for (const company of companies) {
    const summary = company.testSummary || null;
    const status = company.testStatus || (summary ? (summary.rawJobsFound > 0 ? "passed" : "failed") : "not_tested");
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>
        <strong></strong>
        <a target="_blank" rel="noreferrer"></a>
        <p></p>
      </td>
      <td></td>
      <td></td>
      <td></td>
      <td><div class="company-table-actions request-actions"></div></td>
    `;
    row.querySelector("strong").textContent = company.name;
    row.querySelector("a").href = company.careersUrl;
    row.querySelector("a").textContent = company.careersUrl;
    row.querySelector("p").textContent = company.notes || "No notes";
    const cells = row.querySelectorAll("td");
    cells[1].innerHTML = `<span class="request-status-pill"></span>`;
    const pill = cells[1].querySelector(".request-status-pill");
    pill.textContent = company.scanner || summary?.extractor || "Generic parser";
    pill.dataset.status = status === "passed" ? "approved" : status === "failed" ? "test_failed" : "pending";
    cells[2].textContent = company.lastTestedAt || summary?.testedAt
      ? dateTimeLabel(company.lastTestedAt || summary.testedAt)
      : "Not tested yet";
    renderParserTestResult(cells[3], summary);

    const testButton = document.createElement("button");
    testButton.type = "button";
    testButton.textContent = "Test";
    testButton.addEventListener("click", () => testCompanyCatalog(company.id, testButton));
    row.querySelector(".request-actions").append(testButton);
    tbody.append(row);
  }
  els.companyHealthList.append(table);
}

function renderCompanyRequests() {
  if (!els.companyRequestList) return;
  const requests = state.companyRequests || [];
  els.companyRequestCount.textContent = `${requests.length} request${requests.length === 1 ? "" : "s"}`;
  els.companyRequestList.replaceChildren();

  if (!requests.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No company requests yet.";
    els.companyRequestList.append(empty);
    return;
  }

  const table = document.createElement("table");
  table.className = "company-request-table";
  table.innerHTML = `
    <thead>
      <tr>
        <th>Company</th>
        <th>Requested by</th>
        <th>Status</th>
        <th>Test result</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector("tbody");
  for (const request of requests) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>
        <strong></strong>
        <a target="_blank" rel="noreferrer"></a>
        <p></p>
      </td>
      <td></td>
      <td><span class="request-status-pill"></span></td>
      <td></td>
      <td><div class="company-table-actions request-actions"></div></td>
    `;
    row.querySelector("strong").textContent = request.name;
    row.querySelector("a").href = request.careersUrl;
    row.querySelector("a").textContent = request.careersUrl;
    row.querySelector("p").textContent = request.notes || "No notes";
    const cells = row.querySelectorAll("td");
    cells[1].textContent = state.currentUser?.isAdmin ? request.userEmail || "Unknown user" : "You";
    row.querySelector(".request-status-pill").textContent = requestStatusLabel(request);
    row.querySelector(".request-status-pill").dataset.status = request.status || "pending";
    renderRequestTestResult(cells[3], request);

    const actions = row.querySelector(".request-actions");
    if (state.currentUser?.isAdmin && !["approved", "rejected"].includes(request.status)) {
      const testButton = document.createElement("button");
      testButton.type = "button";
      testButton.textContent = "Test";
      testButton.addEventListener("click", () => testCompanyRequest(request.id, testButton));
      actions.append(testButton);

      const approveButton = document.createElement("button");
      approveButton.type = "button";
      approveButton.className = "primary-button";
      approveButton.textContent = "Approve";
      approveButton.addEventListener("click", () => approveCompanyRequest(request.id));
      actions.append(approveButton);

      const rejectButton = document.createElement("button");
      rejectButton.type = "button";
      rejectButton.className = "danger-button";
      rejectButton.textContent = "Reject";
      rejectButton.addEventListener("click", () => rejectCompanyRequest(request.id));
      actions.append(rejectButton);
    } else {
      const note = document.createElement("span");
      note.className = "muted-note";
      note.textContent = request.status === "approved"
        ? "Available to all users"
        : request.status === "rejected"
          ? request.adminNotes || "Rejected"
          : "Waiting for admin";
      actions.append(note);
    }
    tbody.append(row);
  }
  els.companyRequestList.append(table);
}

function renderCompanyJobResults() {
  const jobs = companySiteJobs();
  els.companyJobCount.textContent = `${jobs.length} job${jobs.length === 1 ? "" : "s"}`;
  els.jobListLastScanned.textContent = `Last scanned ${dateTimeLabel(state.lastScrapeAt)}`;
  els.companyJobTable.replaceChildren();

  if (!jobs.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No company-site jobs found in the latest scan.";
    els.companyJobTable.append(empty);
    return;
  }

  const groups = jobsByCompany();
  const selectedJobs = selectedCompanyJobs();
  const selectedJob = selectedJobs.find((job) => job.id === state.selectedCompanyJobId) || selectedJobs[0];
  const browser = document.createElement("div");
  browser.className = "folder-browser";

  const companyPane = document.createElement("section");
  companyPane.className = "folder-pane";
  companyPane.innerHTML = `<h4>Companies</h4>`;
  for (const company of state.targetCompanies) {
    const count = groups.get(company.id)?.length || 0;
    const button = document.createElement("button");
    button.type = "button";
    button.className = company.id === state.selectedCompanyId ? "folder-row active" : "folder-row";
    button.innerHTML = `<span></span><strong></strong>`;
    button.querySelector("span").textContent = company.name;
    button.querySelector("strong").textContent = count;
    button.addEventListener("click", () => {
      captureJobPaneScroll();
      state.selectedCompanyId = company.id;
      state.selectedCompanyJobId = selectedCompanyJobs()[0]?.id || null;
      state.jobPaneScroll.titles = 0;
      state.jobPaneScroll.detail = 0;
      render();
    });
    companyPane.append(button);
  }

  const titlePane = document.createElement("section");
  titlePane.className = "folder-pane";
  titlePane.innerHTML = `
    <div class="folder-pane-heading">
      <h4>Job titles</h4>
      <div class="job-sort-toggle" aria-label="Sort job titles">
        <button type="button" data-sort="date">Posted date</button>
        <button type="button" data-sort="relevance">Relevance</button>
      </div>
    </div>
    <div class="job-title-search">
      <input type="search" placeholder="Search job titles" aria-label="Search job titles" />
    </div>
  `;
  for (const button of titlePane.querySelectorAll("[data-sort]")) {
    button.className = state.jobTitleSort === button.dataset.sort ? "active" : "";
    button.textContent = `${button.textContent}${sortArrow(button.dataset.sort)}`;
    button.addEventListener("click", () => {
      captureJobPaneScroll();
      state.jobTitleSortDirection = nextSortDirection(button.dataset.sort);
      state.jobTitleSort = button.dataset.sort;
      const sortedJobs = selectedCompanyJobs();
      state.selectedCompanyJobId = sortedJobs[0]?.id || null;
      state.jobPaneScroll.titles = 0;
      state.jobPaneScroll.detail = 0;
      renderCompanyJobResults();
    });
  }
  const searchInput = titlePane.querySelector(".job-title-search input");
  searchInput.value = state.jobTitleSearch || "";
  searchInput.addEventListener("input", () => {
    captureJobPaneScroll();
    state.jobTitleSearch = searchInput.value;
    state.selectedCompanyJobId = selectedCompanyJobs()[0]?.id || null;
    state.jobPaneScroll.titles = 0;
    state.jobPaneScroll.detail = 0;
    renderCompanyJobResults();
    const nextInput = els.companyJobTable.querySelector(".job-title-search input");
    if (nextInput) {
      nextInput.focus();
      const cursor = nextInput.value.length;
      nextInput.setSelectionRange(cursor, cursor);
    }
  });
  if (!selectedJobs.length) {
    const empty = document.createElement("p");
    empty.className = "muted-note";
    empty.textContent = state.jobTitleSearch ? "No matching job titles for this company." : "No jobs found for this company yet.";
    titlePane.append(empty);
  }
  for (const job of selectedJobs) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = job.id === selectedJob?.id ? "title-row active" : "title-row";
    const relevance = relevanceFor(job);
    button.innerHTML = `<span></span><small></small>`;
    button.querySelector("span").textContent = job.title;
    button.querySelector("small").textContent = jobTitleMetaLabel(job);
    button.addEventListener("click", () => {
      captureJobPaneScroll();
      state.selectedCompanyJobId = job.id;
      state.jobPaneScroll.detail = 0;
      renderCompanyJobResults();
    });
    titlePane.append(button);
  }

  const detailPane = document.createElement("section");
  detailPane.className = "job-detail-pane";
  if (!selectedJob) {
    detailPane.innerHTML = `<h4>Job</h4><p class="muted-note">Select a company and job title to review details.</p>`;
  } else {
    detailPane.append(renderSelectedJobDetail(selectedJob));
  }

  browser.append(companyPane, titlePane, detailPane);
  els.companyJobTable.append(browser);
  restoreJobPaneScroll();
}

function renderSelectedJobDetail(job) {
  const wrapper = document.createElement("article");
  wrapper.className = "selected-job-detail";
  const relevance = relevanceFor(job);
  wrapper.innerHTML = `
    <div class="job-detail-heading">
      <div>
        <p class="eyebrow"></p>
        <h3></h3>
      </div>
      <a class="ghost-button" target="_blank" rel="noreferrer">Open job</a>
    </div>
    <p class="job-score-line"></p>
    <section>
      <h4>Posting summary</h4>
      <p class="job-detail-summary"></p>
    </section>
    <section class="fit-panel">
      <h4>Personalized relevance</h4>
      <div class="fit-score-row">
        <strong></strong>
        <span></span>
      </div>
      <div class="fit-grid">
        <div>
          <h5>Why it fits</h5>
          <ul class="fit-reasons"></ul>
        </div>
        <div>
          <h5>Watch-outs</h5>
          <ul class="fit-concerns"></ul>
        </div>
      </div>
      <div class="matched-signals"></div>
    </section>
    <section>
      <h4>Relevance</h4>
      <div class="manual-score-control">
        <label>
          <span>Your score</span>
          <input type="number" min="0" max="10" step="1" />
        </label>
        <button type="button" data-action="save-score">Save score</button>
        <button type="button" data-action="clear-score">Clear score</button>
      </div>
      <div class="relevance-actions"></div>
    </section>
    <section>
      <h4>Tracking</h4>
      <div class="company-job-actions"></div>
    </section>
    <section class="resume-tweak-panel">
      <h4>Resume tweaks for selected job</h4>
      <ul></ul>
    </section>
  `;
  wrapper.querySelector(".eyebrow").textContent = job.company;
  wrapper.querySelector("h3").textContent = job.title;
  wrapper.querySelector("a").href = job.url;
  const summaryLabel = job.summarySource === "llm" ? "LLM summary" : job.summarySource === "extracted" ? "Extracted summary" : "Summary";
  wrapper.querySelector(".job-score-line").textContent = `${relevanceScoreLabel(job)} relevance · ${job.relevanceBucket || job.priority} · ${job.detailFetchedAt ? `${summaryLabel} fetched ${dateTimeLabel(job.detailFetchedAt)}` : "Summary fallback"}`;
  wrapper.querySelector(".job-detail-summary").textContent = job.description || "No summary available from this posting.";

  wrapper.querySelector(".fit-score-row strong").textContent = relevanceScoreLabel(job);
  const rangeText = scoreRangeLabel(job);
  const locationText = locationMatchesLabel(job);
  wrapper.querySelector(".fit-score-row span").textContent = manualRelevanceScoreFor(job) !== null
    ? "Your saved score"
    : [job.relevanceBucket, rangeText ? `range ${rangeText}` : "", job.confidence ? `${job.confidence} confidence` : "", locationText].filter(Boolean).join(" · ") || "Waiting for next LLM scan";
  const reasonList = wrapper.querySelector(".fit-reasons");
  const concernList = wrapper.querySelector(".fit-concerns");
  const reasons = job.fitReasons?.length ? job.fitReasons : ["Run a fresh scan to generate personalized fit reasons for this role."];
  const concerns = job.concerns?.length ? job.concerns : ["No specific concerns captured yet."];
  for (const reason of reasons) {
    const item = document.createElement("li");
    item.textContent = reason;
    reasonList.append(item);
  }
  for (const concern of concerns) {
    const item = document.createElement("li");
    item.textContent = concern;
    concernList.append(item);
  }
  const signalWrap = wrapper.querySelector(".matched-signals");
  for (const signal of job.matchedSignals || []) {
    const chip = document.createElement("span");
    chip.textContent = signal;
    signalWrap.append(chip);
  }

  const relevanceActions = wrapper.querySelector(".relevance-actions");
  const scoreInput = wrapper.querySelector(".manual-score-control input");
  const manualScore = manualRelevanceScoreFor(job);
  scoreInput.value = manualScore !== null ? manualScore : (Number.isFinite(Number(job.relevanceScore)) ? Number(job.relevanceScore) : "");
  wrapper.querySelector('[data-action="save-score"]').addEventListener("click", () => setJobManualRelevance(job.id, scoreInput.value));
  wrapper.querySelector('[data-action="clear-score"]').addEventListener("click", () => setJobManualRelevance(job.id, null));
  for (const [value, label] of [["relevant", "Relevant"], ["not_relevant", "Not relevant"], [null, "Clear"]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.className = relevance === value ? "active" : "";
    button.addEventListener("click", () => setJobRelevance(job.id, value));
    relevanceActions.append(button);
  }

  const statusActions = wrapper.querySelector(".company-job-actions");
  for (const [nextStatus, label] of [["shortlisted", "Shortlist"], ["applied", "Applied"], ["rejected", "Pass"]]) {
    const statusButton = document.createElement("button");
    statusButton.type = "button";
    statusButton.textContent = label;
    statusButton.className = statusFor(job) === nextStatus ? "active" : "";
    if (nextStatus === "shortlisted" && job.locationMatchesProfile === "No") {
      statusButton.disabled = true;
      statusButton.title = "This job does not match your profile location.";
    } else {
      statusButton.addEventListener("click", () => setJobStatus(job.id, nextStatus));
    }
    statusActions.append(statusButton);
  }

  const list = wrapper.querySelector(".resume-tweak-panel ul");
  for (const tweak of resumeTweaksForJob(job)) {
    const item = document.createElement("li");
    if (typeof tweak === "string") {
      item.textContent = tweak;
    } else {
      item.innerHTML = `<strong></strong><span></span>`;
      item.querySelector("strong").textContent = tweak.action;
      item.querySelector("span").textContent = tweak.detail;
    }
    list.append(item);
  }
  return wrapper;
}

function renderLastScrape() {
  const summary = state.lastScrapeSummary;
  const errors = summary?.errors?.length ? ` ${summary.errors.length} source issue${summary.errors.length === 1 ? "" : "s"}.` : "";
  els.lastScrape.textContent = `${relativeLabel(state.lastScrapeAt)} · ${dateTimeLabel(state.lastScrapeAt)}${summary ? ` · ${summary.totalFetched} company jobs found across ${state.targetCompanies.length} companies.` : ""}${errors}`;
}

function renderScannerRunCard(run, active = false, index = 0) {
  const card = active ? document.createElement("article") : document.createElement("details");
  card.className = `scanner-run-card${active ? " active-scan" : ""}`;
  if (!active) {
    card.open = state.scannerOpenRunIds.has(run.id);
    card.addEventListener("toggle", () => {
      if (card.open) {
        state.scannerOpenRunIds.add(run.id);
        scrollScannerLogsToLatest();
      } else {
        state.scannerOpenRunIds.delete(run.id);
      }
    });
  }
  const totals = run.totals || {};
  const issueCount = runIssueCount(run);

  if (!active) {
    const summary = document.createElement("summary");
    summary.className = "scanner-run-summary";
    summary.innerHTML = `
      <div>
        <p class="eyebrow"></p>
        <h3></h3>
        <p></p>
      </div>
      <div class="scanner-summary-metrics">
        <span></span>
        <span></span>
        <span></span>
      </div>
    `;
    summary.querySelector(".eyebrow").textContent = `${run.scope || "scan"} · ${durationLabel(run.startedAt, run.finishedAt)}`;
    summary.querySelector("h3").textContent = dateTimeLabel(run.startedAt);
    summary.querySelector("p").textContent = runFailureSummary(run);
    const summaryMetrics = summary.querySelectorAll(".scanner-summary-metrics span");
    summaryMetrics[0].textContent = `${totals.jobsFound || 0} jobs`;
    summaryMetrics[1].textContent = `${issueCount} failures`;
    summaryMetrics[2].textContent = `${totals.detailCacheHits || 0} cached`;
    card.append(summary);
  }

  const body = document.createElement("div");
  body.className = "scanner-run-body";
  body.innerHTML = `
    <div class="scanner-run-heading">
      <div>
        <p class="eyebrow"></p>
        <h3></h3>
        <p></p>
      </div>
      <span class="scanner-status"></span>
    </div>
    <div class="scanner-stat-strip">
      <span></span>
      <span></span>
      <span></span>
      <span></span>
      <span></span>
    </div>
    <div class="scan-progress-panel">
      <p>Personalizing jobs found using resume and LLM matching</p>
      <div class="scan-progress-row">
        <div>
          <span>Jobs found</span>
          <strong data-progress-label="jobs"></strong>
        </div>
        <div class="scan-progress-track"><span data-progress-bar="jobs"></span></div>
      </div>
      <div class="scan-progress-row">
        <div>
          <span>LLM matching</span>
          <strong data-progress-label="llm"></strong>
        </div>
        <div class="scan-progress-track"><span data-progress-bar="llm"></span></div>
      </div>
    </div>
    <div class="scanner-company-list"></div>
  `;
  body.querySelector(".eyebrow").textContent = `${active ? "Running now" : "Details"} · ${durationLabel(run.startedAt, run.finishedAt)}`;
  body.querySelector("h3").textContent = active ? `${statusText(run.scope)} scan` : `Run details`;
  body.querySelector(".scanner-run-heading p:last-child").textContent = active
    ? `Started ${dateTimeLabel(run.startedAt)}`
    : `${dateTimeLabel(run.startedAt)} to ${dateTimeLabel(run.finishedAt)}`;
  body.querySelector(".scanner-status").textContent = statusText(run.status);

  const statSpans = body.querySelectorAll(".scanner-stat-strip span");
  statSpans[0].textContent = `${totals.companies || 0} companies`;
  statSpans[1].textContent = `${totals.rawJobsFound || 0} raw jobs`;
  statSpans[2].textContent = `${totals.jobsFound || 0} saved jobs`;
  statSpans[3].textContent = `${totals.llmCalls || 0} LLM calls (${totals.llmSucceeded || 0} ok, ${totals.llmFailed || 0} failed, ${totals.llmCacheHits || 0} cached)`;
  statSpans[4].textContent = `${issueCount} failures · ${totals.pageFetches || 0} page fetches · ${totals.metaApiCalls || 0} API · ${totals.detailFetches || 0} details · ${totals.detailCacheHits || 0} cached details`;

  const progress = scanProgressValues(run);
  body.querySelector('[data-progress-label="jobs"]').textContent = `${progress.rawJobs} raw jobs · ${progress.completedCompanies}/${progress.companyCount} companies`;
  body.querySelector('[data-progress-label="llm"]').textContent = `${progress.llmDone}/${progress.llmTarget} jobs personalized`;
  body.querySelector('[data-progress-bar="jobs"]').style.width = `${progress.jobsPercent}%`;
  body.querySelector('[data-progress-bar="llm"]').style.width = `${progress.llmPercent}%`;

  const companyList = body.querySelector(".scanner-company-list");
  for (const company of run.companies || []) {
    const companyNode = document.createElement("section");
    companyNode.className = `scanner-company-card ${company.status === "failed" ? "has-error" : ""}`;
    companyNode.innerHTML = `
      <div class="scanner-company-top">
        <div>
          <h4></h4>
          <p></p>
        </div>
        <span></span>
      </div>
      <div class="scanner-stat-strip small">
        <span></span>
        <span></span>
        <span></span>
        <span></span>
      </div>
      <pre class="scanner-log-view" aria-label="Scanner log"></pre>
    `;
    companyNode.querySelector("h4").textContent = company.name;
    companyNode.querySelector(".scanner-company-top p").textContent = `${company.extractor || "Scanner"} · ${company.careersUrl}`;
    companyNode.querySelector(".scanner-company-top span").textContent = statusText(company.status);
    const companyStats = companyNode.querySelectorAll(".scanner-stat-strip.small span");
    companyStats[0].textContent = `${company.rawJobsFound || 0} raw jobs`;
    companyStats[1].textContent = `${company.jobsFound || 0} saved`;
    companyStats[2].textContent = `${company.llmCalls || 0} LLM · ${company.detailCacheHits || 0} cached`;
    companyStats[3].textContent = `${company.errors?.length || 0} issues`;

    const logView = companyNode.querySelector(".scanner-log-view");
    const visibleCalls = active ? company.calls || [] : (company.calls || []).filter((call) => call.status === "error");
    logView.textContent = visibleCalls.length
      ? visibleCalls.map(scannerLogLine).join("\n")
      : (active ? "[waiting] Waiting for this company to start." : "[ok] No fetch or API failures logged for this company.");
    companyList.append(companyNode);
  }

  card.append(body);
  return card;
}

function renderScanner() {
  const runs = state.scanRuns || [];
  const localActive = localActiveScanRun();
  const activeRuns = state.activeScanRuns?.length ? state.activeScanRuns : localActive ? [localActive] : [];
  const latest = runs[0];
  const metricRun = activeRuns[0] || latest;
  const latestTotals = metricRun?.totals || {};
  els.scannerRunMetric.textContent = activeRuns.length ? "Running" : runs.length;
  els.scannerJobMetric.textContent = latestTotals.jobsFound || 0;
  els.scannerLlmMetric.textContent = latestTotals.llmCalls || 0;
  els.scannerIssueMetric.textContent = latestTotals.errors || 0;
  if (els.scannerScanNow) {
    els.scannerScanNow.disabled = Boolean(activeRuns.length);
    els.scannerScanNow.textContent = activeRuns.length ? "Scanning..." : "Scan all companies";
  }
  els.scannerCurrent.replaceChildren();
  els.scannerRunList.replaceChildren();

  for (const run of activeRuns) {
    els.scannerCurrent.append(renderScannerRunCard(run, true));
  }

  if (!runs.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No scan runs logged yet. Start a company scan to see fetches, job counts, LLM calls, and errors here.";
    els.scannerRunList.append(empty);
    scrollScannerLogsToLatest();
    return;
  }

  for (const run of runs) {
    els.scannerRunList.append(renderScannerRunCard(run));
  }
  scrollScannerLogsToLatest();
}

function renderProfile() {
  const profile = state.profile || {};
  for (const field of els.profileForm.elements) {
    if (!field.name) continue;
    const value = profile[field.name];
    field.value = Array.isArray(value) ? value.join("\n") : value || "";
  }
  els.currentUserEmail.textContent = state.currentUser?.email || "Signed in";
  els.adminPanel.hidden = !state.currentUser?.isAdmin;
  els.userList.replaceChildren();
  if (!state.currentUser?.isAdmin) return;

  const users = state.users || [];
  if (!users.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No users yet.";
    els.userList.append(empty);
    return;
  }

  const table = document.createElement("table");
  table.className = "user-table";
  table.innerHTML = `
    <thead>
      <tr>
        <th>User</th>
        <th>Today</th>
        <th>All time</th>
        <th>Saved data</th>
        <th>Last scan</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector("tbody");
  for (const user of users) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>
        <strong></strong>
        <span></span>
      </td>
      <td></td>
      <td></td>
      <td></td>
      <td></td>
      <td><button type="button" class="danger-button">Remove user</button></td>
    `;
    row.querySelector("strong").textContent = user.email;
    row.querySelector("span").textContent = `${user.isAdmin ? "Admin" : "User"} · Created ${dateLabel(user.createdAt)}${user.id === state.currentUser?.id ? " · Current account" : ""}`;
    const cells = row.querySelectorAll("td");
    cells[1].textContent = `${numberLabel(user.usage?.today?.scans)}/${numberLabel(user.usage?.today?.scanLimit)} scans · ${numberLabel(user.usage?.today?.llmCalls)}/${numberLabel(user.usage?.today?.llmLimit)} LLM`;
    cells[2].textContent = `${numberLabel(user.usage?.total?.scans)} scans · ${numberLabel(user.usage?.total?.llmCalls)} LLM`;
    cells[3].textContent = `${numberLabel(user.stats?.companies)} companies · ${numberLabel(user.stats?.jobs)} jobs · ${numberLabel(user.stats?.scanRuns)} runs`;
    cells[4].textContent = user.stats?.lastScrapeAt ? dateTimeLabel(user.stats.lastScrapeAt) : "Not scanned";
    const removeButton = row.querySelector(".danger-button");
    removeButton.disabled = user.id === state.currentUser?.id;
    removeButton.title = removeButton.disabled ? "You cannot remove your own signed-in account." : `Remove ${user.email}`;
    removeButton.addEventListener("click", () => deleteUser(user));
    tbody.append(row);
  }
  els.userList.append(table);
}

function renderResume() {
  els.resumeText.value = state.resumeText || "";
  els.recommendationList.replaceChildren();
  for (const item of state.recommendations || []) {
    const node = document.createElement("article");
    node.className = "recommendation-item";
    node.innerHTML = `<h4></h4><p></p>`;
    node.querySelector("h4").textContent = item.title;
    node.querySelector("p").textContent = item.detail;
    els.recommendationList.append(node);
  }
}

function renderPipeline() {
  const columns = [
    ["new", "New"],
    ["shortlisted", "Shortlisted"],
    ["applied", "Applied"],
    ["rejected", "Passed"]
  ];
  els.pipeline.replaceChildren();
  for (const [status, title] of columns) {
    const column = document.createElement("section");
    column.className = "pipeline-column";
    const jobs = companySiteJobs().filter((job) => statusFor(job) === status);
    column.innerHTML = `<h3>${title} (${jobs.length})</h3>`;
    if (!jobs.length) {
      const empty = document.createElement("p");
      empty.textContent = "Nothing here yet.";
      column.append(empty);
    }
    for (const job of jobs) {
      const card = document.createElement("article");
      card.className = "pipeline-card";
      card.innerHTML = `<strong></strong><p></p><a class="ghost-button" target="_blank" rel="noreferrer">Open</a>`;
      card.querySelector("strong").textContent = job.title;
      card.querySelector("p").textContent = `${job.company} · ${relevanceScoreLabel(job)} relevance · ${dateLabel(job.postedAt)}`;
      card.querySelector("a").href = job.url;
      column.append(card);
    }
    els.pipeline.append(column);
  }
}

function renderEmailDigest() {
  if (!els.emailDigestForm) return;
  const settings = state.emailDigest || {};
  const status = state.emailDigestStatus || {};
  els.emailDigestForm.elements.enabled.checked = Boolean(settings.enabled);
  els.emailDigestForm.elements.email.value = settings.email || state.currentUser?.email || "";
  els.emailDigestForm.elements.sendTime.value = settings.sendTime || "08:00";
  renderTimeZoneOptions(settings.timeZone || browserTimeZone());
  els.emailDigestForm.elements.minRelevanceScore.value = settings.minRelevanceScore ?? 7;
  els.emailDigestForm.elements.maxJobs.value = settings.maxJobs ?? 10;
  els.emailDigestConfigured.textContent = status.configured ? "Email connected" : "Provider not configured";
  els.emailDigestStatus.textContent = settings.lastDigestStatus || status.lastDigestStatus || "Not sent yet.";
  const parts = [];
  if (settings.lastDigestSentAt) parts.push(`Last sent ${dateTimeLabel(settings.lastDigestSentAt)}`);
  if (settings.sendTime) parts.push(`Scheduled ${settings.sendTime} ${settings.timeZone || browserTimeZone()}`);
  if (status.from) parts.push(`From ${status.from}`);
  if (status.replyTo) parts.push(`Replies to ${status.replyTo}`);
  if (Array.isArray(status.issues) && status.issues.length) {
    parts.push(status.issues.join(" "));
  } else if (!status.configured) {
    parts.push("Add RESEND_API_KEY and EMAIL_FROM to .env, then restart.");
  }
  els.emailDigestMeta.textContent = parts.join(" · ");
  if (els.sendTestEmail) {
    els.sendTestEmail.disabled = !status.configured;
    els.sendTestEmail.title = status.configured ? "" : "Set RESEND_API_KEY and EMAIL_FROM first.";
  }
}

function renderFeedback() {
  if (!els.feedbackList) return;
  const entries = state.feedbackEntries || [];
  els.feedbackCount.textContent = `${entries.length} entr${entries.length === 1 ? "y" : "ies"}`;
  els.feedbackList.replaceChildren();

  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No feedback yet.";
    els.feedbackList.append(empty);
    return;
  }

  const table = document.createElement("table");
  table.className = "feedback-table";
  table.innerHTML = `
    <thead>
      <tr>
        <th>Date</th>
        <th>User</th>
        <th>Feedback</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector("tbody");
  for (const entry of entries) {
    const row = document.createElement("tr");
    row.innerHTML = `<td></td><td></td><td></td>`;
    const cells = row.querySelectorAll("td");
    cells[0].textContent = dateTimeLabel(entry.createdAt);
    cells[1].textContent = state.currentUser?.isAdmin ? entry.userEmail || "Unknown user" : "You";
    cells[2].textContent = entry.message;
    tbody.append(row);
  }
  els.feedbackList.append(table);
}

function renderView() {
  els.navButtons.forEach((button) => button.classList.toggle("active", button.dataset.view === state.view));
  els.views.forEach((view) => view.classList.toggle("active", view.id === `${state.view}View`));
  els.viewTitle.textContent = viewTitles[state.view];
}

function render() {
  renderView();
  renderMetrics();
  renderWatchCompanies();
  renderCompanyRequests();
  renderCompanyParserHealth();
  renderCompanyTabs();
  renderCompanyJobResults();
  renderLastScrape();
  renderScanner();
  renderProfile();
  renderResume();
  renderPipeline();
  renderEmailDigest();
  renderFeedback();
}

function clearCompanyRequestForm() {
  els.companyRequestForm.reset();
}

async function setJobStatus(id, status) {
  captureJobPaneScroll();
  updateState(await api(`/api/jobs/${encodeURIComponent(id)}`, {
    method: "POST",
    body: JSON.stringify({ status })
  }));
}

async function setJobRelevance(id, relevance) {
  captureJobPaneScroll();
  updateState(await api(`/api/jobs/${encodeURIComponent(id)}/feedback`, {
    method: "POST",
    body: JSON.stringify({ relevance })
  }));
}

async function setJobManualRelevance(id, manualRelevanceScore) {
  captureJobPaneScroll();
  const score = manualRelevanceScore === null || manualRelevanceScore === "" ? null : Number(manualRelevanceScore);
  if (score !== null && (!Number.isFinite(score) || score < 0 || score > 10)) {
    alert("Use a relevance score from 0 to 10.");
    return;
  }
  updateState(await api(`/api/jobs/${encodeURIComponent(id)}/feedback`, {
    method: "POST",
    body: JSON.stringify({ manualRelevanceScore: score })
  }));
}

async function deleteCompany(id) {
  updateState(await api(`/api/companies/${encodeURIComponent(id)}`, { method: "DELETE" }));
}

async function resetCompanyJobs(id, name) {
  const confirmed = window.confirm(`Reset fetched jobs for ${name}? This clears scanned jobs and tracking for this company, but keeps the company in your watchlist.`);
  if (!confirmed) return;
  try {
    updateState(await api(`/api/companies/${encodeURIComponent(id)}/reset`, {
      method: "POST",
      body: "{}"
    }));
  } catch (error) {
    alert(error.message);
  }
}

async function deleteUser(user) {
  const confirmed = window.confirm(`Remove ${user.email}? This will delete their profile, resume, companies, scan history, job feedback, pipeline, sessions, and usage history.`);
  if (!confirmed) return;
  try {
    updateState(await api(`/api/users/${encodeURIComponent(user.id)}`, { method: "DELETE" }));
  } catch (error) {
    alert(error.message);
  }
}

function selectedPresetCompanies() {
  const selected = Array.from(els.presetCompanySelect.selectedOptions).map((option) => option.value);
  return (state.availableCompanies || []).filter((preset) => selected.includes(preset.id) && !presetCompanyExists(preset));
}

async function addSelectedPresetCompanies() {
  const selected = selectedPresetCompanies();
  if (!selected.length) {
    alert("Choose at least one company that is not already in your watchlist.");
    return;
  }

  els.addPresetCompanies.disabled = true;
  els.selectAllPresetCompanies.disabled = true;
  const originalText = els.addPresetCompanies.textContent;
  els.addPresetCompanies.textContent = "Adding...";
  try {
    let nextState = null;
    for (const company of selected) {
      nextState = await api("/api/companies", {
        method: "POST",
        body: JSON.stringify({ catalogId: company.id })
      });
    }
    if (nextState) updateState(nextState);
  } catch (error) {
    alert(error.message);
  } finally {
    els.addPresetCompanies.disabled = false;
    els.selectAllPresetCompanies.disabled = false;
    els.addPresetCompanies.textContent = originalText;
  }
}

async function submitCompanyRequest() {
  const data = Object.fromEntries(new FormData(els.companyRequestForm).entries());
  try {
    updateState(await api("/api/company-requests", {
      method: "POST",
      body: JSON.stringify(data)
    }));
    clearCompanyRequestForm();
  } catch (error) {
    alert(error.message);
  }
}

async function testCompanyRequest(id, button) {
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = "Testing...";
  try {
    updateState(await api(`/api/company-requests/${encodeURIComponent(id)}/test`, {
      method: "POST",
      body: "{}"
    }));
    await refreshScannerState();
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function testCompanyCatalog(id, button) {
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = "Testing...";
  try {
    updateState(await api(`/api/company-catalog/${encodeURIComponent(id)}/test`, {
      method: "POST",
      body: "{}"
    }));
    await refreshScannerState();
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function approveCompanyRequest(id) {
  try {
    updateState(await api(`/api/company-requests/${encodeURIComponent(id)}/approve`, {
      method: "POST",
      body: "{}"
    }));
  } catch (error) {
    alert(error.message);
  }
}

async function rejectCompanyRequest(id) {
  const adminNotes = window.prompt("Optional rejection note for the requester:", "") || "";
  try {
    updateState(await api(`/api/company-requests/${encodeURIComponent(id)}/reject`, {
      method: "POST",
      body: JSON.stringify({ adminNotes })
    }));
  } catch (error) {
    alert(error.message);
  }
}

async function scanCompany(id, button) {
  const company = state.targetCompanies.find((item) => item.id === id);
  state.activeScan = {
    label: company ? `Scanning ${company.name}` : "Scanning company",
    startedAt: new Date().toISOString(),
    companies: company ? [company] : []
  };
  state.view = "scanner";
  window.location.hash = "#scanner";
  render();
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = "Scanning...";
  const poll = setInterval(() => {
    refreshScannerState();
  }, 1200);
  try {
    const nextState = await api(`/api/companies/${encodeURIComponent(id)}/scan`, {
      method: "POST",
      body: "{}"
    });
    updateState(nextState);
    selectCompanyInJobPane(id);
    await refreshScannerState();
  } catch (error) {
    alert(error.message);
  } finally {
    clearInterval(poll);
    state.activeScan = null;
    button.disabled = false;
    button.textContent = originalText;
    render();
  }
}

async function refreshScannerState() {
  try {
    const scanner = await api("/api/scanner");
    state.activeScanRuns = scanner.activeScanRuns || [];
    state.scanRuns = scanner.scanRuns || state.scanRuns || [];
    if (state.activeScanRuns.length) state.activeScan = null;
    renderScanner();
  } catch {
    // Scanner polling is diagnostic only; the main dashboard can keep working.
  }
}

function shouldPollScanner() {
  return state.view === "scanner" || state.activeScan || (state.activeScanRuns || []).length;
}

async function startScanAll(buttons = []) {
  const scanButtons = buttons.filter(Boolean);
  state.activeScan = {
    label: "Scanning all companies",
    startedAt: new Date().toISOString(),
    companies: state.targetCompanies || []
  };
  state.view = "scanner";
  window.location.hash = "#scanner";
  render();
  for (const button of scanButtons) {
    button.disabled = true;
    button.textContent = "Scanning...";
  }
  const poll = setInterval(() => {
    refreshScannerState();
  }, 1200);
  try {
    updateState(await api("/api/scrape", { method: "POST", body: "{}" }));
    await refreshScannerState();
  } catch (error) {
    alert(error.message);
  } finally {
    clearInterval(poll);
    state.activeScan = null;
    for (const button of scanButtons) {
      button.disabled = false;
      button.textContent = "Scan all companies";
    }
    render();
  }
}

els.navButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.view = button.dataset.view;
    render();
  });
});

els.companyTabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.companiesTab = button.dataset.companyTab || "watchlist";
    render();
  });
});

window.addEventListener("hashchange", () => {
  state.view = viewFromHash();
  render();
});

els.companyRequestForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await submitCompanyRequest();
});

els.clearCompanyRequestForm.addEventListener("click", clearCompanyRequestForm);

els.selectAllPresetCompanies.addEventListener("click", () => {
  const options = Array.from(els.presetCompanySelect.options).filter((option) => !option.disabled);
  const shouldSelectAll = options.some((option) => !option.selected);
  for (const option of options) option.selected = shouldSelectAll;
});

els.addPresetCompanies.addEventListener("click", addSelectedPresetCompanies);

els.profileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(els.profileForm).entries());
  updateState(await api("/api/profile", {
    method: "POST",
    body: JSON.stringify(data)
  }));
});

els.userForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(els.userForm).entries());
  data.isAdmin = Boolean(data.isAdmin);
  try {
    updateState(await api("/api/users", {
      method: "POST",
      body: JSON.stringify(data)
    }));
    els.userForm.reset();
  } catch (error) {
    alert(error.message);
  }
});

els.feedbackForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = els.feedbackText.value.trim();
  if (!message) {
    alert("Add feedback before submitting.");
    return;
  }
  try {
    updateState(await api("/api/feedback", {
      method: "POST",
      body: JSON.stringify({ message })
    }));
    els.feedbackForm.reset();
  } catch (error) {
    alert(error.message);
  }
});

els.emailDigestForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(els.emailDigestForm).entries());
  data.enabled = els.emailDigestForm.elements.enabled.checked;
  try {
    updateState(await api("/api/email-digest/settings", {
      method: "POST",
      body: JSON.stringify(data)
    }));
  } catch (error) {
    alert(error.message);
  }
});

els.sendTestEmail.addEventListener("click", async () => {
  els.sendTestEmail.disabled = true;
  const originalText = els.sendTestEmail.textContent;
  els.sendTestEmail.textContent = "Sending...";
  try {
    updateState(await api("/api/email-digest/settings", {
      method: "POST",
      body: JSON.stringify({
        email: els.emailDigestForm.elements.email.value,
        enabled: els.emailDigestForm.elements.enabled.checked,
        sendTime: els.emailDigestForm.elements.sendTime.value,
        timeZone: els.emailDigestForm.elements.timeZone.value,
        minRelevanceScore: els.emailDigestForm.elements.minRelevanceScore.value,
        maxJobs: els.emailDigestForm.elements.maxJobs.value
      })
    }));
    updateState(await api("/api/email-digest/test", { method: "POST", body: "{}" }));
  } catch (error) {
    alert(error.message);
  } finally {
    els.sendTestEmail.disabled = false;
    els.sendTestEmail.textContent = originalText;
  }
});

els.logoutButton.addEventListener("click", async () => {
  await api("/api/logout", { method: "POST", body: "{}" });
  window.location.href = "/login.html";
});

els.resumeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  updateState(await api("/api/resume", {
    method: "POST",
    body: JSON.stringify({ resumeText: els.resumeText.value })
  }));
  els.resumeUploadStatus.textContent = "Resume text saved.";
});

els.resumeUpload.addEventListener("change", async () => {
  const file = els.resumeUpload.files?.[0];
  if (!file) return;
  const formData = new FormData();
  formData.append("resumeFile", file);
  els.resumeUpload.disabled = true;
  els.resumeUploadStatus.textContent = `Uploading ${file.name}...`;
  try {
    const response = await fetch(`${apiBase}/api/resume/upload`, {
      method: "POST",
      body: formData
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Upload failed");
    updateState(data);
    els.resumeUploadStatus.textContent = `Loaded and saved ${data.resumeUpload.filename} · ${data.resumeUpload.characters.toLocaleString()} characters. Review or edit the text below.`;
  } catch (error) {
    els.resumeUploadStatus.textContent = error.message;
  } finally {
    els.resumeUpload.disabled = false;
    els.resumeUpload.value = "";
  }
});

els.scanNow.addEventListener("click", async () => {
  startScanAll([els.scanNow, els.scannerScanNow]);
});

els.scannerScanNow.addEventListener("click", async () => {
  startScanAll([els.scanNow, els.scannerScanNow]);
});

els.checkLlm.addEventListener("click", async () => {
  els.checkLlm.disabled = true;
  els.checkLlm.textContent = "Checking...";
  els.llmStatus.textContent = "Checking OpenAI connection...";
  try {
    const status = await api("/api/llm-status");
    if (!status.configured) {
      els.llmStatus.textContent = "No API key set for this server.";
    } else if (status.ok) {
      els.llmStatus.textContent = `LLM connected · ${status.model}`;
    } else {
      els.llmStatus.textContent = `LLM error · ${status.message}`;
    }
  } catch (error) {
    els.llmStatus.textContent = `LLM check failed · ${error.message}`;
  } finally {
    els.checkLlm.disabled = false;
    els.checkLlm.textContent = "Check LLM";
  }
});

state.view = viewFromHash();
updateState(await api("/api/state"));
await refreshScannerState();

setInterval(() => {
  if (shouldPollScanner()) refreshScannerState();
}, 2500);
