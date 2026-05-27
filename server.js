import http from "node:http";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await loadLocalEnv(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIR = path.join(__dirname, "data");
const STORE_PATH = path.join(DATA_DIR, "store.json");
const DB_PATH = path.join(DATA_DIR, "app.db");
const PUBLIC_DIR = path.join(__dirname, "public");
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_JOB_MONTHS = 2;
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 14);
const DAILY_SCAN_LIMIT = Number(process.env.DAILY_SCAN_LIMIT || 20);
const DAILY_LLM_LIMIT = process.env.DAILY_LLM_LIMIT ? Number(process.env.DAILY_LLM_LIMIT) : null;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_SUMMARY_MODEL = process.env.OPENAI_SUMMARY_MODEL || "gpt-5-nano";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const EMAIL_FROM = process.env.EMAIL_FROM || "";
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO || "";
const emailPattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

const jobMatchResponseFormat = {
  type: "json_schema",
  name: "job_match_summary",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: {
        type: "string",
        description: "Two to three concise sentences about the job responsibilities, domain, and requirements."
      },
      relevanceScore: {
        type: "integer",
        minimum: 0,
        maximum: 10,
        description: "Personalized fit score from 0 to 10."
      },
      scoreRange: {
        type: "object",
        additionalProperties: false,
        properties: {
          low: { type: "integer", minimum: 0, maximum: 10 },
          high: { type: "integer", minimum: 0, maximum: 10 }
        },
        required: ["low", "high"]
      },
      confidence: {
        type: "string",
        enum: ["High", "Medium", "Low"],
        description: "Confidence in the relevance score."
      },
      locationMatchesProfile: {
        type: "string",
        enum: ["Yes", "No"],
        description: "Whether the job location matches the candidate's profile locations. Use Yes when no profile location is supplied."
      },
      relevanceBucket: {
        type: "string",
        enum: ["Excellent", "Strong", "Possible", "Weak", "Low"]
      },
      fitReasons: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 5
      },
      concerns: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 5
      },
      matchedSignals: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 8
      }
    },
    required: [
      "summary",
      "relevanceScore",
      "scoreRange",
      "confidence",
      "locationMatchesProfile",
      "relevanceBucket",
      "fitReasons",
      "concerns",
      "matchedSignals"
    ]
  }
};

async function loadLocalEnv(filePath) {
  if (!existsSync(filePath)) return;

  const raw = await readFile(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.replace(/^export\s+/, "").match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    let value = rawValue.trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

const defaultProfile = {
  name: "",
  desiredTitles: ["Product Manager", "Software Engineer", "Data Analyst"],
  skills: ["SQL", "Python", "JavaScript", "React", "analytics"],
  locations: ["Remote", "United States"],
  avoidKeywords: ["unpaid", "commission only"],
  seniority: "",
  notes: ""
};

const defaultStore = {
  profile: defaultProfile,
  resumeText: "",
  targetCompanies: [],
  companyScanJobs: [],
  jobs: [],
  jobFeedback: {},
  jobDetailCache: {},
  statuses: {},
  emailDigest: {
    enabled: false,
    email: "",
    sendTime: "08:00",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Los_Angeles",
    minRelevanceScore: 7,
    maxJobs: 10,
    lastDigestSentAt: null,
    lastDigestStatus: "Not configured yet."
  },
  lastScrapeAt: null,
  lastScrapeSummary: null,
  scanRuns: []
};

const defaultCompanyCatalog = [
  {
    name: "Apple",
    careersUrl: "https://jobs.apple.com/en-us/search?location=united-states-USA",
    notes: "Apple careers search. Uses Apple posting detail extraction for better job summaries.",
    scanner: "Apple careers"
  },
  {
    name: "Meta",
    careersUrl: "https://www.metacareers.com/jobs/",
    notes: "Meta Careers. Uses Meta Careers API search and recent-job filtering.",
    scanner: "Meta Careers API"
  },
  {
    name: "Netflix",
    careersUrl: "https://explore.jobs.netflix.net/careers",
    notes: "Netflix careers. Uses the Eightfold embedded jobs extractor.",
    scanner: "Eightfold jobs"
  },
  {
    name: "Anthropic",
    careersUrl: "https://job-boards.greenhouse.io/anthropic",
    notes: "Anthropic Greenhouse board. Uses the full Greenhouse jobs API.",
    scanner: "Greenhouse jobs"
  },
  {
    name: "OpenAI",
    careersUrl: "https://openai.com/careers/search",
    notes: "OpenAI careers search. Uses OpenAI's Ashby-backed board if the public page blocks server fetching.",
    scanner: "OpenAI careers"
  },
  {
    name: "Microsoft",
    careersUrl: "https://apply.careers.microsoft.com/careers",
    notes: "Microsoft careers. Uses the Microsoft Careers API and recent-job filtering.",
    scanner: "Microsoft Careers API"
  },
  {
    name: "Google",
    careersUrl: "https://www.google.com/about/careers/applications/jobs/results",
    notes: "Google careers. Uses Google careers search pages and job detail pages.",
    scanner: "Google careers"
  },
  {
    name: "Walmart",
    careersUrl: "https://careers.walmart.com/us/en/home",
    notes: "Walmart Careers. Uses the Walmart careers search API and Next.js job detail extraction.",
    scanner: "Walmart careers"
  }
];

const activeScanRuns = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

await mkdir(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS user_stores (
    user_id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS usage_events (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    count INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS feedback_entries (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS company_catalog (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    careers_url TEXT NOT NULL UNIQUE,
    notes TEXT NOT NULL DEFAULT '',
    scanner TEXT NOT NULL DEFAULT '',
    source_request_id TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS company_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    careers_url TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    test_status TEXT,
    test_summary TEXT,
    admin_notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    reviewed_at TEXT,
    reviewed_by TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(reviewed_by) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS email_digest_sends (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    job_key TEXT NOT NULL,
    digest_id TEXT NOT NULL,
    company TEXT NOT NULL,
    title TEXT NOT NULL,
    relevance_score INTEGER,
    sent_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id),
    UNIQUE(user_id, job_key)
  );
`);

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((item) => item.name);
  if (!columns.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn("company_catalog", "test_status", "TEXT");
ensureColumn("company_catalog", "test_summary", "TEXT");
ensureColumn("company_catalog", "last_tested_at", "TEXT");

function userCount() {
  return db.prepare("SELECT COUNT(*) AS count FROM users").get().count;
}

function hashPassword(password) {
  const salt = randomBytes(16).toString("base64url");
  const hash = pbkdf2Sync(String(password), salt, 210000, 32, "sha256").toString("base64url");
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const [salt, hash] = String(storedHash || "").split(":");
  if (!salt || !hash) return false;
  const candidate = pbkdf2Sync(String(password), salt, 210000, 32, "sha256");
  const expected = Buffer.from(hash, "base64url");
  return expected.length === candidate.length && timingSafeEqual(candidate, expected);
}

function createUser(email, password, isAdmin = false) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) throw new Error("Use a valid email address.");
  if (String(password || "").length < 10) throw new Error("Use a password with at least 10 characters.");
  const user = {
    id: `user-${Date.now().toString(36)}-${randomBytes(6).toString("base64url")}`,
    email: normalizedEmail,
    password_hash: hashPassword(password),
    is_admin: isAdmin ? 1 : 0,
    created_at: new Date().toISOString()
  };
  db.prepare("INSERT INTO users (id, email, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(user.id, user.email, user.password_hash, user.is_admin, user.created_at);
  writeStore(user.id, structuredClone(defaultStore));
  return publicUser(user);
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    isAdmin: Boolean(user.is_admin),
    disabled: Boolean(user.disabled),
    createdAt: user.created_at
  };
}

function publicFeedback(row) {
  return {
    id: row.id,
    userId: row.user_id,
    userEmail: row.email,
    message: row.message,
    createdAt: row.created_at
  };
}

function listFeedback(user) {
  const sql = user.isAdmin
    ? `SELECT feedback_entries.*, users.email
       FROM feedback_entries
       JOIN users ON users.id = feedback_entries.user_id
       ORDER BY feedback_entries.created_at DESC`
    : `SELECT feedback_entries.*, users.email
       FROM feedback_entries
       JOIN users ON users.id = feedback_entries.user_id
       WHERE feedback_entries.user_id = ?
       ORDER BY feedback_entries.created_at DESC`;
  const rows = user.isAdmin ? db.prepare(sql).all() : db.prepare(sql).all(user.id);
  return rows.map(publicFeedback);
}

function createFeedback(user, message) {
  const text = cleanText(message).slice(0, 4000);
  if (text.length < 3) throw new Error("Add a little more feedback before submitting.");
  db.prepare("INSERT INTO feedback_entries (id, user_id, message, created_at) VALUES (?, ?, ?, ?)")
    .run(`feedback-${Date.now().toString(36)}-${randomBytes(5).toString("base64url")}`, user.id, text, new Date().toISOString());
}

function listCompanyRequests(user) {
  const sql = user.isAdmin
    ? `SELECT company_requests.*, users.email
       FROM company_requests
       JOIN users ON users.id = company_requests.user_id
       ORDER BY company_requests.created_at DESC`
    : `SELECT company_requests.*, users.email
       FROM company_requests
       JOIN users ON users.id = company_requests.user_id
       WHERE company_requests.user_id = ?
       ORDER BY company_requests.created_at DESC`;
  const rows = user.isAdmin ? db.prepare(sql).all() : db.prepare(sql).all(user.id);
  return rows.map(requestRowToCompanyRequest);
}

function getCompanyRequest(id) {
  const row = db.prepare(`
    SELECT company_requests.*, users.email
    FROM company_requests
    JOIN users ON users.id = company_requests.user_id
    WHERE company_requests.id = ?
  `).get(String(id || ""));
  if (!row) throw new Error("Company request not found.");
  return row;
}

function createCompanyRequest(user, input = {}) {
  const name = cleanText(input.name).slice(0, 160);
  const careersUrl = normalizeUrl(input.careersUrl);
  const notes = cleanText(input.notes).slice(0, 1000);
  if (name.length < 2) throw new Error("Add a company name.");
  if (!careersUrl) throw new Error("Add a valid careers URL.");
  if (findCatalogCompany({ careersUrl })) {
    throw new Error("That company URL is already available. Select it from the available companies list.");
  }
  const existing = db.prepare(`
    SELECT id FROM company_requests
    WHERE user_id = ? AND lower(careers_url) = lower(?) AND status IN ('pending', 'tested', 'test_failed')
  `).get(user.id, careersUrl);
  if (existing) throw new Error("You already have an open request for that careers URL.");
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO company_requests (id, user_id, name, careers_url, notes, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(`company-request-${Date.now().toString(36)}-${randomBytes(5).toString("base64url")}`, user.id, name, careersUrl, notes, now, now);
}

function companyTestSummaryFromResult(company, result) {
  const companyResult = result.summary?.targetCompanyResults?.[0] || {};
  const companyLog = result.scanRun?.companies?.[0] || {};
  const summary = {
    testedAt: new Date().toISOString(),
    careersUrl: company.careersUrl,
    extractor: companyLog.extractor || "Unknown parser",
    scanStatus: companyLog.status || result.scanRun?.status || "unknown",
    rawJobsFound: result.scanRun?.totals?.rawJobsFound || 0,
    jobsFound: result.companyScanJobs?.length || 0,
    llmCalls: result.scanRun?.totals?.llmCalls || 0,
    errors: result.scanRun?.totals?.errors || 0,
    error: companyResult.error || null,
    failureReason: null,
    calls: (companyLog.calls || []).slice(-25).map((call) => ({
      at: call.at,
      type: call.type,
      target: call.target,
      status: call.status,
      count: call.count,
      message: call.message
    })),
    sampleJobs: (result.companyScanJobs || []).slice(0, 5).map((job) => ({
      title: job.title,
      url: job.url,
      postedAt: job.postedAt || job.updatedAt || null
    }))
  };
  if (summary.error) {
    summary.failureReason = `Fetch failed: ${summary.error}`;
  } else if (!summary.rawJobsFound) {
    summary.failureReason = "Landing page fetched, but no job listing/detail links were parsed from the supplied careers URL.";
  } else if (!summary.jobsFound) {
    summary.failureReason = "Job links were parsed, but no job details were saved after detail fetch/enrichment.";
  }
  const passed = !summary.error && summary.rawJobsFound > 0;
  return { summary, passed };
}

async function runCompanyParserTest(company, adminUser, scope = "company parser test", enrich = false) {
  const result = await scrapeJobs(companyRequestTestProfile(), [company], {}, [], scope, "", {}, adminUser.id, { enrich });
  return companyTestSummaryFromResult(company, result);
}

async function testCompanyRequest(requestId, adminUser) {
  const request = getCompanyRequest(requestId);
  const company = normalizeCompany({
    name: request.name,
    careersUrl: request.careers_url,
    notes: request.notes
  });
  const { summary, passed } = await runCompanyParserTest(company, adminUser, "company request test", true);
  db.prepare(`
    UPDATE company_requests
    SET status = ?, test_status = ?, test_summary = ?, updated_at = ?
    WHERE id = ?
  `).run(passed ? "tested" : "test_failed", passed ? "passed" : "failed", JSON.stringify(summary), new Date().toISOString(), request.id);
  return summary;
}

async function testCompanyCatalogCompany(companyId, adminUser) {
  const company = findCatalogCompany({ id: companyId });
  if (!company) throw new Error("Company not found.");
  const { summary, passed } = await runCompanyParserTest(company, adminUser, "company catalog test", false);
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE company_catalog
    SET test_status = ?, test_summary = ?, last_tested_at = ?, updated_at = ?
    WHERE id = ?
  `).run(passed ? "passed" : "failed", JSON.stringify(summary), summary.testedAt || now, now, company.id);
  return summary;
}

function companyRequestTestProfile() {
  return {
    name: "Parser validation",
    desiredTitles: [
      "data",
      "engineer",
      "software",
      "product",
      "manager",
      "analyst",
      "associate",
      "operations",
      "finance",
      "marketing",
      "intern"
    ],
    skills: [
      "sql",
      "python",
      "java",
      "javascript",
      "analytics",
      "customer",
      "operations",
      "product",
      "retail"
    ],
    locations: [],
    avoidKeywords: [],
    seniority: "",
    notes: "Broad diagnostic profile for validating whether a requested company careers URL can produce a job list."
  };
}

function approveCompanyRequest(requestId, adminUser) {
  const request = getCompanyRequest(requestId);
  const catalogCompany = upsertCompanyCatalog({
    name: request.name,
    careersUrl: request.careers_url,
    notes: request.notes
  }, {
    sourceRequestId: request.id,
    createdBy: adminUser.id
  });
  db.prepare(`
    UPDATE company_requests
    SET status = 'approved', reviewed_by = ?, reviewed_at = ?, updated_at = ?
    WHERE id = ?
  `).run(adminUser.id, new Date().toISOString(), new Date().toISOString(), request.id);
  return catalogCompany;
}

function rejectCompanyRequest(requestId, adminUser, adminNotes = "") {
  const request = getCompanyRequest(requestId);
  db.prepare(`
    UPDATE company_requests
    SET status = 'rejected', admin_notes = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ?
    WHERE id = ?
  `).run(cleanText(adminNotes).slice(0, 1000), adminUser.id, new Date().toISOString(), new Date().toISOString(), request.id);
}

function sentJobKeys(userId) {
  return new Set(db.prepare("SELECT job_key FROM email_digest_sends WHERE user_id = ?").all(userId).map((row) => row.job_key));
}

function recordEmailDigestSends(userId, digestId, jobs) {
  const sentAt = new Date().toISOString();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO email_digest_sends (id, user_id, job_key, digest_id, company, title, relevance_score, sent_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const job of jobs) {
    insert.run(
      `email-send-${Date.now().toString(36)}-${randomBytes(5).toString("base64url")}`,
      userId,
      jobDetailCacheKey(job),
      digestId,
      job.company || "",
      job.title || "",
      clampRelevanceScore(job.relevanceScore),
      sentAt
    );
  }
}

function listUsers() {
  return db.prepare("SELECT id, email, is_admin, disabled, created_at FROM users ORDER BY created_at ASC").all().map((user) => ({
    ...publicUser(user),
    usage: {
      today: dailyUsage(user.id),
      total: totalUsage(user.id)
    },
    stats: userStoreStats(user.id)
  }));
}

function deleteUser(userId, actorId) {
  const targetId = String(userId || "");
  if (!targetId) throw new Error("User not found.");
  if (targetId === actorId) throw new Error("You cannot remove your own account while signed in.");
  const target = db.prepare("SELECT id FROM users WHERE id = ?").get(targetId);
  if (!target) throw new Error("User not found.");

  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(targetId);
    db.prepare("DELETE FROM usage_events WHERE user_id = ?").run(targetId);
    db.prepare("DELETE FROM feedback_entries WHERE user_id = ?").run(targetId);
    db.prepare("DELETE FROM company_requests WHERE user_id = ?").run(targetId);
    db.prepare("DELETE FROM email_digest_sends WHERE user_id = ?").run(targetId);
    db.prepare("DELETE FROM user_stores WHERE user_id = ?").run(targetId);
    db.prepare("DELETE FROM users WHERE id = ?").run(targetId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  for (const [scanId, scanRun] of activeScanRuns.entries()) {
    if (scanRun.userId === targetId) activeScanRuns.delete(scanId);
  }
}

async function bootstrapFirstAdmin() {
  if (userCount()) return;

  const email = String(process.env.ADMIN_EMAIL || "admin@example.com").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || randomBytes(18).toString("base64url");
  const admin = createUser(email, password, true);
  if (existsSync(STORE_PATH)) {
    const raw = await readFile(STORE_PATH, "utf8");
    writeStore(admin.id, { ...structuredClone(defaultStore), ...JSON.parse(raw) });
  }
  if (!process.env.ADMIN_PASSWORD) {
    const loginPath = path.join(DATA_DIR, "admin-login.txt");
    await writeFile(loginPath, `Email: ${email}\nPassword: ${password}\n`, "utf8");
    console.log(`Created first admin account. Credentials saved to ${loginPath}`);
  } else {
    console.log(`Created first admin account for ${email}`);
  }
}

await bootstrapFirstAdmin();

function readStore(userId) {
  const row = db.prepare("SELECT data FROM user_stores WHERE user_id = ?").get(userId);
  if (!row) {
    writeStore(userId, structuredClone(defaultStore));
    return structuredClone(defaultStore);
  }
  return normalizeStore({ ...structuredClone(defaultStore), ...JSON.parse(row.data) });
}

function writeStore(userId, store) {
  const normalizedStore = normalizeStore(store);
  db.prepare(`
    INSERT INTO user_stores (user_id, data, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run(userId, JSON.stringify(normalizedStore, null, 2), new Date().toISOString());
}

function parseStoreRow(row) {
  try {
    return normalizeStore({ ...structuredClone(defaultStore), ...JSON.parse(row.data) });
  } catch {
    return structuredClone(defaultStore);
  }
}

function canonicalCompanyUrl(value) {
  const normalized = normalizeUrl(value || "");
  if (!normalized) return "";
  try {
    const url = new URL(normalized);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    if (hostname === "metacareers.com") return "https://www.metacareers.com/jobs";
    if (hostname === "openai.com" && url.pathname.startsWith("/careers")) return "https://openai.com/careers/search";
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    url.hash = "";
    return url.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return normalized.replace(/\/$/, "").toLowerCase();
  }
}

function companyShareKey(company) {
  const name = String(company?.name || "").trim().toLowerCase();
  if (name) return `name:${name}`;
  const url = canonicalCompanyUrl(company?.careersUrl || "");
  return url ? `url:${url}` : "";
}

function mergeCompanyMetadata(primary, duplicate) {
  const primaryTime = safeDate(primary.lastCheckedAt);
  const duplicateTime = safeDate(duplicate.lastCheckedAt);
  const latest = duplicateTime > primaryTime ? duplicate : primary;
  return {
    ...primary,
    notes: primary.notes || duplicate.notes || "",
    lastCheckedAt: latest.lastCheckedAt || primary.lastCheckedAt || duplicate.lastCheckedAt || null,
    lastFoundCount: Math.max(Number(primary.lastFoundCount || 0), Number(duplicate.lastFoundCount || 0)),
    lastError: latest.lastError || null
  };
}

function dedupeTargetCompanies(targetCompanies = []) {
  const seen = new Map();
  for (const company of targetCompanies || []) {
    if (!company?.name && !company?.careersUrl) continue;
    const key = companyShareKey(company) || company.id || company.careersUrl;
    if (!seen.has(key)) {
      seen.set(key, company);
      continue;
    }
    seen.set(key, mergeCompanyMetadata(seen.get(key), company));
  }
  return [...seen.values()];
}

function normalizeStore(store) {
  return {
    ...store,
    statuses: store.statuses || {},
    targetCompanies: dedupeTargetCompanies(store.targetCompanies || [])
  };
}

function parseJsonField(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function catalogRowToCompany(row, includeTest = false) {
  const company = {
    id: row.id,
    name: row.name,
    careersUrl: row.careers_url,
    notes: row.notes || "",
    scanner: row.scanner || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
  if (includeTest) {
    company.testStatus = row.test_status || null;
    company.testSummary = parseJsonField(row.test_summary);
    company.lastTestedAt = row.last_tested_at || company.testSummary?.testedAt || null;
  }
  return company;
}

function requestRowToCompanyRequest(row) {
  const testSummary = parseJsonField(row.test_summary);
  return {
    id: row.id,
    userId: row.user_id,
    userEmail: row.email,
    name: row.name,
    careersUrl: row.careers_url,
    notes: row.notes || "",
    status: row.status,
    testStatus: row.test_status,
    testSummary,
    adminNotes: row.admin_notes || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by
  };
}

function listCompanyCatalog(includeTest = false) {
  return db.prepare("SELECT * FROM company_catalog ORDER BY name COLLATE NOCASE ASC").all()
    .map((row) => catalogRowToCompany(row, includeTest));
}

function findCatalogCompany(input = {}) {
  const id = String(input.catalogId || input.id || "").trim();
  const careersUrl = normalizeUrl(input.careersUrl || "");
  const row = id
    ? db.prepare("SELECT * FROM company_catalog WHERE id = ?").get(id)
    : careersUrl
      ? db.prepare("SELECT * FROM company_catalog WHERE lower(careers_url) = lower(?)").get(careersUrl)
      : null;
  return row ? catalogRowToCompany(row) : null;
}

function upsertCompanyCatalog(input, { sourceRequestId = null, createdBy = null, scanner = "" } = {}) {
  const company = normalizeCompany(input);
  if (!company.name) throw new Error("Add a company name.");
  if (!company.careersUrl) throw new Error("Add a valid careers URL.");
  const now = new Date().toISOString();
  const existing = db.prepare("SELECT * FROM company_catalog WHERE lower(careers_url) = lower(?)").get(company.careersUrl);
  const id = existing?.id || company.id || makeId(company.name || company.careersUrl);
  db.prepare(`
    INSERT INTO company_catalog (id, name, careers_url, notes, scanner, source_request_id, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(careers_url) DO UPDATE SET
      name = excluded.name,
      notes = excluded.notes,
      scanner = CASE WHEN excluded.scanner != '' THEN excluded.scanner ELSE company_catalog.scanner END,
      source_request_id = COALESCE(excluded.source_request_id, company_catalog.source_request_id),
      updated_at = excluded.updated_at
  `).run(
    id,
    company.name,
    company.careersUrl,
    company.notes || "",
    scanner || input.scanner || "",
    sourceRequestId,
    createdBy,
    existing?.created_at || now,
    now
  );
  return findCatalogCompany({ careersUrl: company.careersUrl });
}

function seedCompanyCatalog() {
  for (const company of defaultCompanyCatalog) {
    upsertCompanyCatalog(company, { scanner: company.scanner || "" });
  }
  const rows = db.prepare("SELECT data FROM user_stores").all();
  for (const row of rows) {
    const store = parseStoreRow(row);
    for (const company of store.targetCompanies || []) {
      if (!company?.careersUrl) continue;
      upsertCompanyCatalog(company, { scanner: company.scanner || "" });
    }
  }
  dedupeCompanyCatalog();
}

function dedupeCompanyCatalog() {
  const defaultUrls = new Set(defaultCompanyCatalog.map((company) => normalizeUrl(company.careersUrl).toLowerCase()));
  const rows = db.prepare("SELECT * FROM company_catalog ORDER BY created_at ASC").all()
    .sort((a, b) => {
      const aDefault = defaultUrls.has(normalizeUrl(a.careers_url).toLowerCase()) ? 0 : 1;
      const bDefault = defaultUrls.has(normalizeUrl(b.careers_url).toLowerCase()) ? 0 : 1;
      return aDefault - bDefault || a.name.localeCompare(b.name);
    });
  const seenUrls = new Set();
  const seenNames = new Set();
  const deleteIds = [];
  for (const row of rows) {
    const canonicalUrl = normalizeUrl(row.careers_url).toLowerCase();
    const canonicalName = cleanText(row.name).toLowerCase();
    if (seenUrls.has(canonicalUrl) || seenNames.has(canonicalName)) {
      deleteIds.push(row.id);
      continue;
    }
    seenUrls.add(canonicalUrl);
    seenNames.add(canonicalName);
  }
  for (const id of deleteIds) {
    db.prepare("DELETE FROM company_catalog WHERE id = ?").run(id);
  }
  for (const row of db.prepare("SELECT id, careers_url FROM company_catalog").all()) {
    const canonicalUrl = normalizeUrl(row.careers_url);
    if (canonicalUrl && canonicalUrl !== row.careers_url) {
      db.prepare("UPDATE company_catalog SET careers_url = ?, updated_at = ? WHERE id = ?")
        .run(canonicalUrl, new Date().toISOString(), row.id);
    }
  }
}

function sharedCompanyBase(company) {
  return {
    id: company.id,
    name: company.name,
    careersUrl: company.careersUrl,
    notes: company.notes || "",
    lastCheckedAt: null,
    lastFoundCount: 0,
    lastError: null
  };
}

seedCompanyCatalog();

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf("=");
      return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
    }));
}

function cookieHeader(name, value, options = {}) {
  const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

function createSession(userId) {
  const id = randomBytes(32).toString("base64url");
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * ONE_DAY_MS).toISOString();
  db.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .run(id, userId, createdAt, expiresAt);
  return { id, expiresAt };
}

function authenticatedUser(req) {
  const sessionId = parseCookies(req).sid;
  if (!sessionId) return null;
  const row = db.prepare(`
    SELECT users.id, users.email, users.is_admin, users.disabled, users.created_at, sessions.expires_at
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.id = ?
  `).get(sessionId);
  if (!row || row.disabled || safeDate(row.expires_at) < Date.now()) return null;
  return publicUser(row);
}

function deleteSession(req) {
  const sessionId = parseCookies(req).sid;
  if (sessionId) db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
}

function usageSince(userId, type, sinceIso) {
  const row = db.prepare("SELECT COALESCE(SUM(count), 0) AS total FROM usage_events WHERE user_id = ? AND type = ? AND created_at >= ?")
    .get(userId, type, sinceIso);
  return Number(row?.total || 0);
}

function todayIsoStart() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date.toISOString();
}

function dailyUsage(userId) {
  const since = todayIsoStart();
  return {
    scans: usageSince(userId, "scan", since),
    llmCalls: usageSince(userId, "llm", since),
    scanLimit: DAILY_SCAN_LIMIT,
    llmLimit: DAILY_LLM_LIMIT
  };
}

function totalUsage(userId) {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'scan' THEN count ELSE 0 END), 0) AS scans,
      COALESCE(SUM(CASE WHEN type = 'llm' THEN count ELSE 0 END), 0) AS llmCalls
    FROM usage_events
    WHERE user_id = ?
  `).get(userId);
  return {
    scans: Number(row?.scans || 0),
    llmCalls: Number(row?.llmCalls || 0)
  };
}

function userStoreStats(userId) {
  const store = readStore(userId);
  return {
    companies: store.targetCompanies?.length || 0,
    jobs: store.companyScanJobs?.length || 0,
    scanRuns: store.scanRuns?.length || 0,
    lastScrapeAt: store.lastScrapeAt || null
  };
}

function assertCanScan(userId) {
  const usage = dailyUsage(userId);
  if (usage.scans >= usage.scanLimit) throw new Error(`Daily scan limit reached (${usage.scanLimit}).`);
  if (Number.isFinite(usage.llmLimit) && usage.llmLimit > 0 && usage.llmCalls >= usage.llmLimit) {
    throw new Error(`Daily LLM call limit reached (${usage.llmLimit}).`);
  }
}

function recordUsage(userId, type, count = 1) {
  if (!count) return;
  db.prepare("INSERT INTO usage_events (id, user_id, type, count, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(`usage-${Date.now().toString(36)}-${randomBytes(5).toString("base64url")}`, userId, type, count, new Date().toISOString());
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  return String(value || "")
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function cleanProfileTerm(value) {
  return String(value || "").trim().replace(/^["']+|["']+$/g, "").trim();
}

function normalizeProfile(input) {
  return {
    name: String(input.name || "").trim(),
    desiredTitles: normalizeList(input.desiredTitles).map(cleanProfileTerm).filter(Boolean),
    skills: normalizeList(input.skills).map(cleanProfileTerm).filter(Boolean),
    locations: normalizeList(input.locations).map(cleanProfileTerm).filter(Boolean),
    avoidKeywords: normalizeList(input.avoidKeywords).map(cleanProfileTerm).filter(Boolean),
    seniority: String(input.seniority || "").trim(),
    notes: String(input.notes || "").trim()
  };
}

function normalizeEmailDigest(input = {}, existing = {}, fallbackEmail = "") {
  const minRelevanceScore = clampRelevanceScore(input.minRelevanceScore ?? existing.minRelevanceScore ?? 7);
  const maxJobs = Number(input.maxJobs ?? existing.maxJobs ?? 10);
  const sendTime = String(input.sendTime || existing.sendTime || "08:00").match(/^([01]\d|2[0-3]):[0-5]\d$/)
    ? String(input.sendTime || existing.sendTime || "08:00")
    : "08:00";
  const timeZone = normalizeTimeZone(input.timeZone || existing.timeZone || defaultTimeZone());
  return {
    enabled: Boolean(input.enabled),
    email: String(input.email || existing.email || fallbackEmail || "").trim(),
    sendTime,
    timeZone,
    minRelevanceScore: minRelevanceScore ?? 7,
    maxJobs: Number.isFinite(maxJobs) ? Math.max(1, Math.min(50, Math.round(maxJobs))) : 10,
    lastDigestSentAt: existing.lastDigestSentAt || null,
    lastDigestStatus: existing.lastDigestStatus || "Not sent yet."
  };
}

function defaultTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Los_Angeles";
}

function normalizeTimeZone(value) {
  const timeZone = String(value || "").trim();
  if (!timeZone) return defaultTimeZone();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return defaultTimeZone();
  }
}

function emailDigestStatus(store) {
  const settings = store.emailDigest || {};
  const sender = normalizeEmailSender(EMAIL_FROM);
  const issues = emailConfigIssues();
  return {
    configured: Boolean(RESEND_API_KEY && sender && !issues.length),
    from: sender || EMAIL_FROM || "",
    replyTo: EMAIL_REPLY_TO || "",
    issues,
    lastDigestSentAt: settings.lastDigestSentAt || null,
    lastDigestStatus: settings.lastDigestStatus || "Not sent yet."
  };
}

function normalizeEmailSender(value) {
  const input = String(value || "").trim();
  if (!input) return "";
  if (/^[^<>]+<[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+>$/.test(input)) return input;
  if (emailPattern.test(input)) return input;

  const loose = input.match(/^(.+?)\s+([^\s@<>]+@[^\s@<>]+\.[^\s@<>]+)$/);
  if (loose) return `${loose[1].trim()} <${loose[2].trim()}>`;
  return input;
}

function emailAddressFromSender(value) {
  const input = normalizeEmailSender(value);
  return input.match(/<([^<>@\s]+@[^<>@\s]+\.[^<>@\s]+)>/)?.[1] || (emailPattern.test(input) ? input : "");
}

function emailConfigIssues() {
  const issues = [];
  if (!RESEND_API_KEY) issues.push("Add RESEND_API_KEY to .env.");
  if (RESEND_API_KEY === "re_xxxxxxxxx" || RESEND_API_KEY.includes("your_resend_api_key_here")) {
    issues.push("Replace the placeholder Resend key with your real API key.");
  }
  if (!EMAIL_FROM) {
    issues.push("Add EMAIL_FROM to .env.");
  } else if (!emailAddressFromSender(EMAIL_FROM)) {
    issues.push("Set EMAIL_FROM as jobs@ai-job-tracker.com or AI Job Tracker <jobs@ai-job-tracker.com>.");
  }
  if (EMAIL_REPLY_TO && !emailPattern.test(EMAIL_REPLY_TO)) {
    issues.push("Set EMAIL_REPLY_TO to a plain email address.");
  }
  return issues;
}

function termsFromProfile(profile) {
  return [...profile.desiredTitles, ...profile.skills, profile.seniority]
    .map((term) => cleanProfileTerm(term).toLowerCase())
    .filter((term) => term.length > 1);
}

function makeId(value) {
  const base = String(value || "")
    .toLowerCase()
    .replace(/https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base || "company"}-${Date.now().toString(36)}`;
}

function stableHash(value) {
  return createHash("sha256").update(String(value)).digest("base64url").slice(0, 18);
}

function createScanRun(scope, companies) {
  const startedAt = new Date().toISOString();
  return {
    id: `scan-${Date.now().toString(36)}-${stableHash(`${scope}-${startedAt}`).slice(0, 6)}`,
    scope,
    status: "running",
    startedAt,
    finishedAt: null,
    totals: {
      companies: companies.length,
      rawJobsFound: 0,
      jobsFound: 0,
      pageFetches: 0,
      detailFetches: 0,
      detailCacheHits: 0,
      metaApiCalls: 0,
      llmCalls: 0,
      llmCacheHits: 0,
      llmSucceeded: 0,
      llmFailed: 0,
      errors: 0
    },
    companies: companies.map((company) => ({
      id: company.id,
      name: company.name,
      careersUrl: company.careersUrl,
      status: "pending",
      extractor: null,
      startedAt: null,
      finishedAt: null,
      rawJobsFound: 0,
      jobsFound: 0,
      pageFetches: 0,
      detailFetches: 0,
      detailCacheHits: 0,
      metaApiCalls: 0,
      llmCalls: 0,
      llmCacheHits: 0,
      llmSucceeded: 0,
      llmFailed: 0,
      errors: [],
      calls: []
    }))
  };
}

function companyScanLog(scanRun, company) {
  return scanRun?.companies?.find((item) => item.id === company.id) || null;
}

function incrementScanMetric(scanRun, companyLog, key, amount = 1) {
  if (companyLog && typeof companyLog[key] === "number") companyLog[key] += amount;
  if (scanRun?.totals && typeof scanRun.totals[key] === "number") scanRun.totals[key] += amount;
}

function recordScanCall(scanRun, companyLog, call) {
  if (!companyLog) return;
  const entry = {
    at: new Date().toISOString(),
    type: call.type,
    target: call.target || "",
    status: call.status || "ok",
    count: call.count ?? null,
    message: call.message || ""
  };
  if (companyLog.calls.length < 80) companyLog.calls.push(entry);
  if (entry.status === "error") {
    companyLog.errors.push(entry.message || entry.target || entry.type);
    if (scanRun?.totals) scanRun.totals.errors += 1;
  }
}

function finishScanRun(scanRun, status = "completed") {
  if (!scanRun) return null;
  scanRun.status = status;
  scanRun.finishedAt = new Date().toISOString();
  return scanRun;
}

function addScanRun(store, scanRun) {
  if (!scanRun) return;
  store.scanRuns = [scanRun, ...(store.scanRuns || [])].slice(0, 12);
}

function scanRunIssueCount(scanRun = {}) {
  const totals = scanRun.totals || {};
  const companyIssues = (scanRun.companies || []).reduce((count, company) => {
    const issueCount = Number(company.issueCount ?? company.errors?.length ?? 0);
    return count + (Number.isFinite(issueCount) ? issueCount : 0);
  }, 0);
  return Math.max(Number(totals.errors || 0), companyIssues);
}

function sanitizeScannerRun(scanRun = {}) {
  const totals = scanRun.totals || {};
  const matchedJobs =
    Number(totals.llmSucceeded || 0) +
    Number(totals.llmFailed || 0) +
    Number(totals.llmCacheHits || 0);
  return {
    id: scanRun.id,
    scope: scanRun.scope,
    status: scanRun.status,
    startedAt: scanRun.startedAt,
    finishedAt: scanRun.finishedAt,
    totals: {
      companies: Number(totals.companies || (scanRun.companies || []).length || 0),
      rawJobsFound: Number(totals.rawJobsFound || 0),
      jobsFound: Number(totals.jobsFound || 0),
      matchedJobs,
      errors: scanRunIssueCount(scanRun)
    },
    companies: (scanRun.companies || []).map((company) => ({
      id: company.id,
      name: company.name,
      status: company.status,
      startedAt: company.startedAt,
      finishedAt: company.finishedAt,
      jobsFound: Number(company.jobsFound || 0),
      issueCount: Number(company.errors?.length || 0)
    }))
  };
}

function sanitizeScannerRuns(scanRuns = []) {
  return scanRuns.map(sanitizeScannerRun);
}

function getScannerState(user) {
  const store = readStore(user.id);
  const activeRuns = [...activeScanRuns.values()].filter((run) => run.userId === user.id);
  if (!user.isAdmin) {
    return {
      activeScanRuns: sanitizeScannerRuns(activeRuns),
      scanRuns: sanitizeScannerRuns(store.scanRuns || [])
    };
  }
  return {
    activeScanRuns: activeRuns,
    scanRuns: store.scanRuns || []
  };
}

function normalizeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    url.hash = "";
    if (url.pathname.length > 1) {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }
    return url.toString();
  } catch {
    return "";
  }
}

function normalizeCompany(input, existing = {}) {
  const careersUrl = normalizeUrl(input.careersUrl);
  const name = String(input.name || existing.name || "").trim();
  return {
    id: existing.id || input.id || makeId(name || careersUrl),
    name: name || (careersUrl ? new URL(careersUrl).hostname.replace(/^www\./, "") : ""),
    careersUrl,
    notes: String(input.notes || "").trim(),
    lastCheckedAt: existing.lastCheckedAt || null,
    lastFoundCount: existing.lastFoundCount || 0,
    lastError: existing.lastError || null
  };
}

function safeDate(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function recentJobCutoffTime() {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - RECENT_JOB_MONTHS);
  return cutoff.getTime();
}

function parseJobDate(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" || /^\d+(\.\d+)?$/.test(String(value).trim())) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return null;
    const millis = number > 10_000_000_000 ? number : number * 1000;
    return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
  }

  const parsed = new Date(value);
  const time = parsed.getTime();
  return Number.isFinite(time) ? parsed.toISOString() : null;
}

function isRecentJobDate(value) {
  const parsed = parseJobDate(value);
  return Boolean(parsed && safeDate(parsed) >= recentJobCutoffTime());
}

function postedDateFilterMessage() {
  return `Kept jobs posted or updated in the last ${RECENT_JOB_MONTHS} months`;
}

function externalJobIdentity(job) {
  const url = String(job.url || "");
  const patterns = [
    /\/careers\/job\/([^/?#]+)/i,
    /\/job_details\/([^/?#]+)/i,
    /\/jobs\/([^/?#]+)/i,
    /\/details\/([^/?#]+)/i,
    /\/job\/([^/?#]+)/i,
    /[?&](?:jobId|job_id|gh_jid|pid|reqId|requisitionId)=([^&#]+)/i
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return stableHash(url || job.id || job.title);
}

function metaCareersJobUrl(jobId) {
  return `https://www.metacareers.com/profile/job_details/${encodeURIComponent(jobId)}/`;
}

function normalizeJobOpenUrl(job) {
  const url = String(job.url || "");
  const metaMatch = url.match(/^https:\/\/(?:www\.)?metacareers\.com\/jobs\/([^/?#]+)\/?/i);
  if (metaMatch?.[1]) return metaCareersJobUrl(decodeURIComponent(metaMatch[1]));
  return url;
}

function jobCacheDateKey(job) {
  const parsed = parseJobDate(job.postedAt || job.updatedAt || job.createdAt);
  return parsed || "unknown-date";
}

function jobDetailCacheKey(job) {
  return [job.companyId || job.company, externalJobIdentity(job), jobCacheDateKey(job)]
    .map((part) => String(part || "").toLowerCase())
    .join("|");
}

function jobScoringInputHash(profile, jobFeedback, resumeText) {
  return stableHash(JSON.stringify({
    scoringSchemaVersion: 3,
    profile,
    resumeText,
    jobFeedback
  }));
}

function cachedSummaryResult(entry) {
  return {
    summary: entry.summary,
    source: entry.summarySource || "cache",
    relevanceScore: entry.relevanceScore,
    scoreRange: entry.scoreRange || null,
    confidence: entry.confidence || null,
    locationMatchesProfile: entry.locationMatchesProfile || null,
    relevanceBucket: entry.relevanceBucket,
    fitReasons: entry.fitReasons || [],
    concerns: entry.concerns || [],
    matchedSignals: entry.matchedSignals || [],
    cached: true
  };
}

function writeJobDetailCacheEntry(cache, key, job, postingContent, result, scoringInputHash) {
  if (!cache || !key) return;
  cache[key] = {
    key,
    companyId: job.companyId,
    company: job.company,
    jobIdentity: externalJobIdentity(job),
    title: job.title,
    location: job.location || "",
    url: job.url,
    postedAt: parseJobDate(job.postedAt) || job.postedAt || null,
    tags: Array.isArray(job.tags) ? job.tags : [],
    postingContent,
    summary: result.summary,
    summarySource: result.source,
    relevanceScore: result.relevanceScore,
    scoreRange: result.scoreRange || null,
    confidence: result.confidence || null,
    locationMatchesProfile: result.locationMatchesProfile || null,
    relevanceBucket: result.relevanceBucket,
    fitReasons: result.fitReasons || [],
    concerns: result.concerns || [],
    matchedSignals: result.matchedSignals || [],
    scoringInputHash,
    fetchedAt: new Date().toISOString(),
    usedAt: new Date().toISOString()
  };
}

function markJobDetailCacheUsed(cache, key) {
  if (cache?.[key]) cache[key].usedAt = new Date().toISOString();
}

function pruneJobDetailCache(cache, activeJobs = []) {
  const entries = Object.entries(cache || {});
  if (entries.length <= 3000) return cache || {};
  const activeKeys = new Set(activeJobs.map(jobDetailCacheKey));
  return Object.fromEntries(entries
    .sort(([, a], [, b]) => safeDate(b.usedAt || b.fetchedAt) - safeDate(a.usedAt || a.fetchedAt))
    .filter(([key], index) => activeKeys.has(key) || index < 3000));
}

function uniqJobs(jobs) {
  const seen = new Set();
  return jobs.filter((job) => {
    const key = `${job.title}|${job.company}|${job.url}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqSortedCompanies(jobs) {
  return [...new Set(jobs.map((job) => job.company).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

const feedbackStopWords = new Set([
  "about", "after", "also", "and", "apple", "are", "been", "being", "can", "company", "for", "from", "have",
  "into", "job", "jobs", "more", "our", "role", "that", "the", "this", "with", "will", "work", "you", "your"
]);

const desiredRoleStopWords = new Set([
  "senior", "sr", "junior", "jr", "staff", "principal", "lead", "head", "director", "associate",
  "manager", "specialist", "remote", "global", "strategy", "strategic"
]);

function desiredRoleTokens(profile) {
  return [...new Set((profile.desiredTitles || [])
    .flatMap((title) => cleanProfileTerm(title).toLowerCase().split(/\s+/))
    .map((token) => token.replace(/[^a-z0-9+#.]/g, ""))
    .filter((token) => token.length > 2 && !desiredRoleStopWords.has(token)))];
}

function titleMatchesDesiredRole(title, profile) {
  const tokens = desiredRoleTokens(profile);
  if (!tokens.length) return true;
  const normalizedTitle = cleanProfileTerm(title).toLowerCase();
  return tokens.some((token) => normalizedTitle.includes(token));
}

function hasProfileLocationFilter(profile) {
  return normalizeList(profile?.locations).length > 0;
}

function jobLocationMatchesProfile(job, profile) {
  if (!hasProfileLocationFilter(profile)) return true;
  if (normalizeYesNo(job.locationMatchesProfile) === "No") return false;
  if (normalizeYesNo(job.locationMatchesProfile) === "Yes") return true;

  const haystack = `${job.location || ""} ${job.description || ""} ${(job.tags || []).join(" ")}`.toLowerCase();
  return normalizeList(profile.locations).some((rawLocation) => {
    const location = cleanProfileTerm(rawLocation).toLowerCase();
    return location && haystack.includes(location);
  });
}

function tokensForJob(job) {
  return `${job.title} ${job.description || ""}`
    .toLowerCase()
    .replace(/[^a-z0-9+#.]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !feedbackStopWords.has(token));
}

function feedbackWeightFromManualScore(score) {
  const normalized = clampRelevanceScore(score);
  if (normalized === null) return 0;
  if (normalized >= 7) return Math.min(4, normalized - 5);
  if (normalized <= 3) return Math.max(-4, normalized - 5);
  return 0;
}

function buildFeedbackSignals(jobs, jobFeedback) {
  const weights = new Map();
  const exact = new Map();
  const manualScores = new Map();
  for (const job of jobs || []) {
    const feedback = jobFeedback?.[job.id];
    const manualScore = clampRelevanceScore(feedback?.manualRelevanceScore);
    if (manualScore !== null) manualScores.set(job.id, manualScore);
    const manualWeight = feedbackWeightFromManualScore(manualScore);
    if (manualWeight) {
      for (const token of new Set(tokensForJob(job))) {
        weights.set(token, (weights.get(token) || 0) + manualWeight);
      }
    }
    if (feedback?.relevance) {
      exact.set(job.id, feedback.relevance);
      const weight = feedback.relevance === "relevant" ? 3 : -3;
      for (const token of new Set(tokensForJob(job))) {
        weights.set(token, (weights.get(token) || 0) + weight);
      }
    }
  }
  return { weights, exact, manualScores };
}

function feedbackScore(job, signals) {
  let score = signals.exact.get(job.id) === "relevant" ? 40 : signals.exact.get(job.id) === "not_relevant" ? -40 : 0;
  for (const token of new Set(tokensForJob(job))) {
    score += signals.weights.get(token) || 0;
  }
  return Math.max(-35, Math.min(35, score));
}

function heuristicRelevanceScore(job, profile) {
  const title = job.title.toLowerCase();
  const haystack = `${job.title} ${job.company} ${job.location} ${job.description} ${(job.tags || []).join(" ")}`.toLowerCase();
  if ((profile.avoidKeywords || []).some((term) => cleanProfileTerm(term) && haystack.includes(cleanProfileTerm(term).toLowerCase()))) {
    return 0;
  }

  let score = 0;
  for (const rawDesired of profile.desiredTitles || []) {
    const term = cleanProfileTerm(rawDesired).toLowerCase();
    if (!term) continue;
    const titleWords = term.split(/\s+/).filter((word) => word.length > 2);
    if (title.includes(term)) score = Math.max(score, 9);
    else if (titleWords.length && titleWords.every((word) => title.includes(word))) score = Math.max(score, 8);
    else if (haystack.includes(term)) score = Math.max(score, 6);
  }

  let skillHits = 0;
  for (const rawSkill of profile.skills || []) {
    const skill = cleanProfileTerm(rawSkill).toLowerCase();
    if (skill && haystack.includes(skill)) skillHits += 1;
  }
  if (skillHits >= 4) score = Math.max(score, 8);
  else if (skillHits >= 2) score = Math.max(score, 7);
  else if (skillHits >= 1) score = Math.max(score, 5);

  for (const rawLocation of profile.locations || []) {
    const location = cleanProfileTerm(rawLocation).toLowerCase();
    if (!location) continue;
    if (job.location.toLowerCase().includes(location) || haystack.includes(location)) {
      score = Math.min(10, score + 1);
      break;
    }
  }

  return Math.max(0, Math.min(10, score));
}

function scoreJob(job, profile, feedbackSignals = { weights: new Map(), exact: new Map() }) {
  const title = job.title.toLowerCase();
  const haystack = `${job.title} ${job.company} ${job.location} ${job.description} ${(job.tags || []).join(" ")}`.toLowerCase();
  const avoidHit = profile.avoidKeywords.some((term) => term && haystack.includes(term.toLowerCase()));
  if (avoidHit) return -100;

  const manualRelevance = feedbackSignals.manualScores?.get(job.id);
  const heuristicRelevance = heuristicRelevanceScore(job, profile);
  const llmRelevance = clampRelevanceScore(job.relevanceScore);
  const titleAligned = titleMatchesDesiredRole(job.title, profile);
  const guardedLlmRelevance = titleAligned ? llmRelevance : Math.min(llmRelevance ?? 0, 4);
  const guardedHeuristicRelevance = titleAligned ? heuristicRelevance : Math.min(heuristicRelevance, 4);
  const effectiveRelevance = manualRelevance ?? Math.max(guardedLlmRelevance ?? 0, guardedHeuristicRelevance);
  if (!jobLocationMatchesProfile(job, profile)) {
    return Math.min(20, Math.round(feedbackScore(job, feedbackSignals)));
  }
  if (effectiveRelevance > 0) {
    return Math.round(effectiveRelevance * 10 + feedbackScore(job, feedbackSignals));
  }

  let roleSkillScore = 0;
  let locationScore = 0;
  let contextScore = 0;
  for (const desired of profile.desiredTitles) {
    const term = desired.toLowerCase();
    if (!term) continue;
    const titleWords = term.split(/\s+/).filter((word) => word.length > 2);
    if (title.includes(term)) roleSkillScore += 55;
    else if (titleWords.length && titleWords.every((word) => title.includes(word))) roleSkillScore += 38;
    else if (haystack.includes(term)) roleSkillScore += 18;
  }
  for (const skill of profile.skills) {
    const term = skill.toLowerCase();
    if (!term) continue;
    if (title.includes(term)) roleSkillScore += 10;
    else if (haystack.includes(term)) roleSkillScore += 7;
  }
  for (const location of profile.locations) {
    const term = location.toLowerCase();
    if (!term) continue;
    if (job.location.toLowerCase().includes(term) || haystack.includes(term)) locationScore += 10;
  }
  if (profile.seniority && haystack.includes(profile.seniority.toLowerCase())) contextScore += 8;

  const profileScore = roleSkillScore < 7 || (profile.locations.length && locationScore === 0)
    ? 0
    : roleSkillScore + locationScore + contextScore;
  return Math.round(profileScore + feedbackScore(job, feedbackSignals));
}

function annotateJobs(jobs, profile, jobFeedback = {}, historicalJobs = jobs) {
  const signals = buildFeedbackSignals(historicalJobs, jobFeedback);
  return jobs
    .map((job) => {
      const score = scoreJob(job, profile, signals);
      const relevance = jobFeedback?.[job.id]?.relevance || null;
      const manualRelevanceScore = clampRelevanceScore(jobFeedback?.[job.id]?.manualRelevanceScore);
      const titleAligned = titleMatchesDesiredRole(job.title, profile);
      const llmRelevanceScore = clampRelevanceScore(job.relevanceScore);
      const locationAligned = jobLocationMatchesProfile(job, profile);
      const guardedLlmRelevanceScore = titleAligned ? llmRelevanceScore : Math.min(llmRelevanceScore ?? 0, 4);
      const heuristicRelevanceScoreValue = heuristicRelevanceScore(job, profile);
      const guardedHeuristicRelevanceScore = titleAligned ? heuristicRelevanceScoreValue : Math.min(heuristicRelevanceScoreValue, 4);
      const effectiveRelevanceScore = locationAligned
        ? manualRelevanceScore ?? Math.max(guardedLlmRelevanceScore ?? 0, guardedHeuristicRelevanceScore)
        : Math.min(manualRelevanceScore ?? guardedLlmRelevanceScore ?? guardedHeuristicRelevanceScore, 2);
      return {
        ...job,
        url: normalizeJobOpenUrl(job),
        relevance,
        manualRelevanceScore,
        score,
        relevanceScore: effectiveRelevanceScore,
        locationMatchesProfile: hasProfileLocationFilter(profile) ? (locationAligned ? "Yes" : "No") : "Yes",
        relevanceBucket: locationAligned ? (job.relevanceBucket || relevanceBucketFromScore(effectiveRelevanceScore)) : "Low",
        priority: !locationAligned ? "Low" : score >= 80 ? "Excellent" : score >= 65 ? "Strong" : score >= 45 ? "Possible" : score >= 25 ? "Weak" : "Low"
      };
    })
    .sort((a, b) => b.score - a.score || (b.relevanceScore || 0) - (a.relevanceScore || 0) || safeDate(b.postedAt) - safeDate(a.postedAt));
}

function cleanText(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanResumeText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;|&#34;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function decodeHtml(value) {
  return cleanText(decodeEntities(value));
}

function extractJsonArrayAfter(text, key) {
  const keyIndex = text.indexOf(key);
  if (keyIndex < 0) return null;
  const start = text.indexOf("[", keyIndex);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function titleFromAnchorHtml(anchorHtml) {
  const firstParagraph = anchorHtml.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
  const heading = anchorHtml.match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i);
  return decodeHtml(firstParagraph?.[1] || heading?.[1] || anchorHtml);
}

function locationFromAnchorHtml(anchorHtml) {
  const paragraphs = [...anchorHtml.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((match) => decodeHtml(match[1]));
  return paragraphs[1] || "Company career page";
}

function extractAttribute(tag, attribute) {
  const match = tag.match(new RegExp(`${attribute}=["']([^"']+)["']`, "i"));
  return match ? decodeHtml(match[1]) : "";
}

function extractDateFromAnchorHtml(anchorHtml) {
  const timeTag = anchorHtml.match(/<time\b[^>]*>/i)?.[0] || "";
  const datetime = timeTag ? extractAttribute(timeTag, "datetime") : "";
  if (datetime) return parseJobDate(datetime);

  const decoded = decodeHtml(anchorHtml);
  const absoluteDate = decoded.match(/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2},?\s+\d{4}\b/i)?.[0];
  if (absoluteDate) return parseJobDate(absoluteDate);

  const isoDate = decoded.match(/\b20\d{2}-\d{2}-\d{2}\b/)?.[0];
  if (isoDate) return parseJobDate(isoDate);

  const relative = decoded.match(/\b(\d{1,2})\s+(day|week|month)s?\s+ago\b/i);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const date = new Date();
    if (unit === "day") date.setDate(date.getDate() - amount);
    if (unit === "week") date.setDate(date.getDate() - amount * 7);
    if (unit === "month") date.setMonth(date.getMonth() - amount);
    return date.toISOString();
  }

  return null;
}

function extractJsonObjectAfter(text, key) {
  const keyIndex = text.indexOf(key);
  if (keyIndex < 0) return null;
  const start = text.indexOf("{", keyIndex);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }

  return null;
}

function extractNextData(html) {
  const match = String(html || "").match(/<script\b[^>]*\bid=["']?__NEXT_DATA__["']?[^>]*>([\s\S]*?)<\/script>/i);
  if (!match?.[1]) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    try {
      return JSON.parse(decodeEntities(match[1]));
    } catch {
      return null;
    }
  }
}

function extractMetaDescription(html) {
  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];
  const preferred = [];
  const fallback = [];
  for (const tag of metaTags) {
    const name = extractAttribute(tag, "name").toLowerCase();
    const property = extractAttribute(tag, "property").toLowerCase();
    const content = extractAttribute(tag, "content");
    if (!content) continue;
    if (["og:description", "twitter:description"].includes(property)) preferred.push(content);
    if (name === "description") fallback.push(content);
  }
  return cleanText(preferred[0] || fallback[0] || "");
}

function flattenJsonLd(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(flattenJsonLd);
  if (typeof value !== "object") return [];
  return [value, ...flattenJsonLd(value["@graph"])];
}

function readableJsonValue(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(readableJsonValue).filter(Boolean).join(", ");
  if (typeof value === "object") {
    if (value.address) return readableJsonValue(value.address);
    return [value.name, value.addressLocality, value.addressRegion, value.addressCountry]
      .filter(Boolean)
      .join(", ");
  }
  return String(value);
}

function extractJsonPostingContent(html) {
  const scripts = html.match(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const script of scripts) {
    const body = script.replace(/^<script\b[^>]*>/i, "").replace(/<\/script>$/i, "");
    try {
      const parsed = JSON.parse(decodeHtml(body));
      for (const item of flattenJsonLd(parsed)) {
        const type = readableJsonValue(item["@type"]).toLowerCase();
        const looksLikeJob = type.includes("jobposting") || item.responsibilities || item.qualifications || item.jobDescription;
        if (!looksLikeJob) continue;

        const sections = [
          ["Title", item.title],
          ["Company", item.hiringOrganization],
          ["Location", item.jobLocation],
          ["Employment type", item.employmentType],
          ["Description", item.description || item.jobDescription],
          ["Responsibilities", item.responsibilities],
          ["Qualifications", item.qualifications],
          ["Skills", item.skills],
          ["Experience requirements", item.experienceRequirements],
          ["Education requirements", item.educationRequirements]
        ];
        const content = sections
          .map(([label, value]) => {
            const readable = readableJsonValue(value);
            return readable ? `${label}: ${readable}` : "";
          })
          .filter(Boolean)
          .join("\n");
        if (content) return cleanText(content);
      }
    } catch {
      // Ignore invalid embedded JSON.
    }
  }
  return "";
}

function extractAppleHydrationPostingContent(html) {
  const scripts = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) || [];
  for (const script of scripts) {
    if (!script.includes("__staticRouterHydrationData")) continue;
    const match = script.match(/window\.__staticRouterHydrationData\s*=\s*JSON\.parse\("([\s\S]*?)"\);/);
    if (!match) continue;

    try {
      const hydratedText = JSON.parse(`"${match[1]}"`);
      const hydrated = JSON.parse(hydratedText);
      const jobsData = hydrated?.loaderData?.jobDetails?.jobsData;
      const localized = jobsData?.localizations?.en_US?.posting || jobsData;
      if (!localized) continue;

      const locations = Array.isArray(jobsData.locations)
        ? jobsData.locations.map((location) => location?.name || location?.cityState || location?.storeName).filter(Boolean).join(", ")
        : "";
      const sections = [
        ["Title", localized.postingTitle || jobsData.postingTitle],
        ["Team", Array.isArray(jobsData.teamNames) ? jobsData.teamNames.join(", ") : jobsData.teamNames],
        ["Location", locations],
        ["Employment type", jobsData.employmentType],
        ["Weekly hours", jobsData.standardWeeklyHours],
        ["Summary", localized.jobSummary || jobsData.jobSummary],
        ["Responsibilities", localized.description || jobsData.description],
        ["Minimum qualifications", localized.minimumQualifications || jobsData.minimumQualifications],
        ["Preferred qualifications", localized.preferredQualifications || jobsData.preferredQualifications]
      ];
      const content = sections
        .map(([label, value]) => {
          const readable = readableJsonValue(value);
          return readable ? `${label}: ${readable}` : "";
        })
        .filter(Boolean)
        .join("\n");
      if (content) return cleanText(content);
    } catch {
      // Ignore hydration payloads that do not match Apple's current job schema.
    }
  }
  return "";
}

function extractBodyPostingContent(html, title) {
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(header|footer|nav)\b[\s\S]*?<\/\1>/gi, " ");
  const text = decodeHtml(body);
  const titleIndex = text.toLowerCase().indexOf(String(title || "").toLowerCase());
  const source = titleIndex >= 0 ? text.slice(titleIndex) : text;
  return cleanText(source);
}

function extractPostingContentFromHtml(html, title, fallback) {
  const bodyContent = extractBodyPostingContent(html, title);
  const usableBody = /please enable javascript in your browser/i.test(bodyContent) ? "" : bodyContent;
  const content = extractAppleHydrationPostingContent(html) || extractJsonPostingContent(html) || usableBody || extractMetaDescription(html);
  return cleanText(content).slice(0, 8000) || fallback;
}

function responseText(data) {
  if (typeof data.output_text === "string") return data.output_text;
  const chunks = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") chunks.push(content.text);
    }
  }
  return chunks.join("\n");
}

async function responseJsonOrThrow(response, label) {
  const contentType = response.headers.get("content-type") || "";
  const body = await response.text();
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    const preview = cleanText(body).slice(0, 240);
    const kind = /^\s*</.test(body) ? "an HTML page" : (contentType || "non-JSON content");
    throw new Error(`${label} returned ${kind} instead of JSON${preview ? `: ${preview}` : ""}`);
  }
}

function extractJsonObject(text) {
  const raw = String(text || "").trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function clampRelevanceScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(10, Math.round(number)));
}

function clampScoreRange(value, fallbackScore = null) {
  const low = clampRelevanceScore(value?.low);
  const high = clampRelevanceScore(value?.high);
  if (low !== null && high !== null) {
    return {
      low: Math.min(low, high),
      high: Math.max(low, high)
    };
  }
  const score = clampRelevanceScore(fallbackScore);
  if (score === null) return null;
  return {
    low: Math.max(0, score - 1),
    high: Math.min(10, score + 1)
  };
}

function normalizeConfidence(value) {
  const text = cleanText(value);
  if (/^high$/i.test(text)) return "High";
  if (/^medium$/i.test(text)) return "Medium";
  if (/^low$/i.test(text)) return "Low";
  return null;
}

function normalizeYesNo(value) {
  const text = cleanText(value);
  if (/^yes$/i.test(text)) return "Yes";
  if (/^no$/i.test(text)) return "No";
  return null;
}

function relevanceBucketFromScore(score) {
  if (score >= 9) return "Excellent";
  if (score >= 7) return "Strong";
  if (score >= 5) return "Possible";
  if (score >= 3) return "Weak";
  return "Low";
}

function feedbackMemory(jobFeedback = {}, historicalJobs = []) {
  const jobById = new Map((historicalJobs || []).map((job) => [job.id, job]));
  const relevant = [];
  const notRelevant = [];
  for (const [id, feedback] of Object.entries(jobFeedback || {})) {
    if (!feedback?.relevance && feedback?.manualRelevanceScore === undefined) continue;
    const job = jobById.get(id) || feedback;
    const manualScore = clampRelevanceScore(feedback?.manualRelevanceScore);
    const scoreLabel = manualScore !== null ? `Score ${manualScore}/10. ` : "";
    const item = `${scoreLabel}${job.company || ""} ${job.title || ""}: ${cleanText(job.description || "").slice(0, 220)}`.trim();
    if (!item) continue;
    if (feedback.relevance === "relevant" || manualScore >= 7) relevant.push(item);
    if (feedback.relevance === "not_relevant" || manualScore <= 3) notRelevant.push(item);
  }
  return {
    relevant: relevant.slice(-8),
    notRelevant: notRelevant.slice(-8)
  };
}

async function summarizeWithLLM(job, postingContent, profile, jobFeedback = {}, historicalJobs = [], resumeText = "", scanRun = null, companyLog = null) {
  if (!OPENAI_API_KEY || !postingContent) {
    return { summary: postingContent, source: "extracted" };
  }

  const memory = feedbackMemory(jobFeedback, historicalJobs);
  incrementScanMetric(scanRun, companyLog, "llmCalls");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: OPENAI_SUMMARY_MODEL,
        reasoning: { effort: "low" },
        text: {
          verbosity: "low",
          format: jobMatchResponseFormat
        },
        instructions: "You are a job-application matching assistant. Use only the supplied posting, candidate profile, resume text, and feedback examples. Return strict JSON only. Do not invent requirements or experience.",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: `Company: ${job.company}
Title: ${job.title}
Location: ${job.location}

Candidate profile:
Target titles: ${(profile.desiredTitles || []).join(", ")}
Skills: ${(profile.skills || []).join(", ")}
Locations: ${(profile.locations || []).join(", ")}
Seniority: ${profile.seniority || ""}
Notes: ${profile.notes || ""}

Resume excerpt:
${cleanText(resumeText).slice(0, 3500)}

Historical feedback memory:
Relevant examples:
${memory.relevant.length ? memory.relevant.map((item) => `- ${item}`).join("\n") : "- none yet"}
Not relevant examples:
${memory.notRelevant.length ? memory.notRelevant.map((item) => `- ${item}`).join("\n") : "- none yet"}

Posting content:
${postingContent}

Return strict JSON with this exact shape:
{
  "summary": "2-3 concise sentences about the job responsibilities, domain, and requirements.",
  "relevanceScore": 7,
  "scoreRange": { "low": 6, "high": 8 },
  "confidence": "High|Medium|Low",
  "locationMatchesProfile": "Yes|No",
  "relevanceBucket": "Excellent|Strong|Possible|Weak|Low",
  "fitReasons": ["why this matches the candidate"],
  "concerns": ["why this may not match"],
  "matchedSignals": ["specific title/skill/domain/location signals"]
}
Score relevanceScore from 0 to 10 based on fit for this candidate's target titles: ${(profile.desiredTitles || []).join(", ") || "not specified"}.
Use scoreRange as a confidence interval around the score. Keep it narrow only when the posting text, resume, and profile provide clear matching evidence.
Set locationMatchesProfile to Yes if the job location matches one of the candidate profile locations. Set it to No if the candidate supplied profile locations and the job location does not match any of them. If the candidate profile has no locations, set locationMatchesProfile to Yes and ignore location as a filter.
Use 8-10 only when the job title or core responsibilities closely match the target titles and domain. If the job is mainly a different function, such as software engineering for a finance profile, cap the score at 4 even when it mentions transferable skills like SQL, analytics, or Excel. Use feedback examples to learn preferences.`
              }
            ]
          }
        ],
        max_output_tokens: 700
      })
    });
  } catch (error) {
    incrementScanMetric(scanRun, companyLog, "llmFailed");
    recordScanCall(scanRun, companyLog, {
      type: "OpenAI summary",
      target: job.title,
      status: "error",
      message: error.message
    });
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    incrementScanMetric(scanRun, companyLog, "llmFailed");
    recordScanCall(scanRun, companyLog, {
      type: "OpenAI summary",
      target: job.title,
      status: "error",
      message: `${response.status} ${response.statusText}`
    });
    throw new Error(`LLM summary failed: ${response.status} ${response.statusText}`);
  }
  let data;
  try {
    data = await responseJsonOrThrow(response, "OpenAI");
  } catch (error) {
    incrementScanMetric(scanRun, companyLog, "llmFailed");
    recordScanCall(scanRun, companyLog, {
      type: "OpenAI summary",
      target: job.title,
      status: "error",
      message: error.message
    });
    throw error;
  }
  const text = responseText(data);
  const parsed = extractJsonObject(text);
  const summary = cleanText(parsed?.summary || text).slice(0, 900);
  const relevanceScore = clampRelevanceScore(parsed?.relevanceScore);
  const scoreRange = clampScoreRange(parsed?.scoreRange, relevanceScore);
  const confidence = normalizeConfidence(parsed?.confidence) || "Medium";
  const locationMatchesProfile = normalizeList(profile.locations).length ? (normalizeYesNo(parsed?.locationMatchesProfile) || "No") : "Yes";
  const relevanceBucket = parsed?.relevanceBucket || (relevanceScore !== null ? relevanceBucketFromScore(relevanceScore) : null);
  const fitReasons = Array.isArray(parsed?.fitReasons) ? parsed.fitReasons.map(cleanText).filter(Boolean).slice(0, 5) : [];
  const concerns = Array.isArray(parsed?.concerns) ? parsed.concerns.map(cleanText).filter(Boolean).slice(0, 5) : [];
  const matchedSignals = Array.isArray(parsed?.matchedSignals) ? parsed.matchedSignals.map(cleanText).filter(Boolean).slice(0, 8) : [];
  incrementScanMetric(scanRun, companyLog, "llmSucceeded");
  recordScanCall(scanRun, companyLog, {
    type: "OpenAI summary",
    target: job.title,
    status: "ok",
    message: OPENAI_SUMMARY_MODEL
  });
  return {
    summary: summary || postingContent,
    source: summary ? "llm" : "extracted",
    relevanceScore,
    scoreRange,
    confidence,
    locationMatchesProfile,
    relevanceBucket,
    fitReasons,
    concerns,
    matchedSignals
  };
}

async function checkOpenAIStatus() {
  if (!OPENAI_API_KEY) {
    return {
      configured: false,
      ok: false,
      model: OPENAI_SUMMARY_MODEL,
      message: "OPENAI_API_KEY is not set for this server process."
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let response;
    try {
      response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: OPENAI_SUMMARY_MODEL,
          input: "Reply with OK.",
          max_output_tokens: 16
        })
      });
    } finally {
      clearTimeout(timeout);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        configured: true,
        ok: false,
        model: OPENAI_SUMMARY_MODEL,
        message: data.error?.message || `${response.status} ${response.statusText}`
      };
    }
    return {
      configured: true,
      ok: true,
      model: OPENAI_SUMMARY_MODEL,
      message: cleanText(responseText(data)) || "OK"
    };
  } catch (error) {
    return {
      configured: true,
      ok: false,
      model: OPENAI_SUMMARY_MODEL,
      message: error.message
    };
  }
}

async function fetchPostingSummary(job, profile, jobFeedback = {}, historicalJobs = [], resumeText = "", scanRun = null, companyLog = null, jobDetailCache = {}) {
  const cacheKey = jobDetailCacheKey(job);
  const scoringInputHash = jobScoringInputHash(profile, jobFeedback, resumeText);
  const cached = jobDetailCache?.[cacheKey];
  if (cached?.postingContent) {
    markJobDetailCacheUsed(jobDetailCache, cacheKey);
    if (cached.scoringInputHash === scoringInputHash && cached.summary) {
      incrementScanMetric(scanRun, companyLog, "detailCacheHits");
      incrementScanMetric(scanRun, companyLog, "llmCacheHits");
      recordScanCall(scanRun, companyLog, {
        type: "job cache",
        target: job.title,
        status: "ok",
        message: "Reused posting detail and LLM score"
      });
      return cachedSummaryResult(cached);
    }

    incrementScanMetric(scanRun, companyLog, "detailCacheHits");
    recordScanCall(scanRun, companyLog, {
      type: "job cache",
      target: job.title,
      status: "ok",
      message: "Reused posting detail; refreshed personalized score"
    });
    const refreshed = await summarizeWithLLM(job, cached.postingContent, profile, jobFeedback, historicalJobs, resumeText, scanRun, companyLog);
    writeJobDetailCacheEntry(jobDetailCache, cacheKey, job, cached.postingContent, refreshed, scoringInputHash);
    return refreshed;
  }

  let postingContent = job.description;

  const greenhouse = job.url.match(/(?:job-boards|boards)\.greenhouse\.io\/([^/]+)\/jobs\/(\d+)/i);
  if (greenhouse && !job.postingContentFetched) {
    const [, board, jobId] = greenhouse;
    const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${jobId}`;
    const response = await fetch(apiUrl, { headers: { "User-Agent": "CodexJobDashboard/1.0" } });
    incrementScanMetric(scanRun, companyLog, "detailFetches");
    recordScanCall(scanRun, companyLog, {
      type: "job detail",
      target: job.title,
      status: response.ok ? "ok" : "error",
      message: response.ok ? "Greenhouse detail API" : `${response.status} ${response.statusText}`
    });
    if (response.ok) {
      const data = await response.json();
      const content = cleanText(decodeHtml(data.content || ""));
      if (content) postingContent = content.slice(0, 8000);
    }
  }

  if (postingContent === job.description && /jobs\.ashbyhq\.com\/[^/]+\/[^/?#]+/i.test(job.url)) {
    const response = await fetch(job.url, {
      headers: {
        "Accept": "text/html",
        "User-Agent": "CodexJobDashboard/1.0"
      }
    });
    incrementScanMetric(scanRun, companyLog, "detailFetches");
    recordScanCall(scanRun, companyLog, {
      type: "job detail",
      target: job.title,
      status: response.ok ? "ok" : "error",
      message: response.ok ? "Ashby detail page" : `${response.status} ${response.statusText}`
    });
    if (response.ok) {
      const content = extractAshbyPostingContent(await response.text());
      if (content) postingContent = content;
    }
  }

  if (postingContent === job.description && microsoftJobIdFromUrl(job.url)) {
    const content = await fetchMicrosoftPostingContent(job, scanRun, companyLog);
    if (content) postingContent = content;
  }

  if (postingContent === job.description && walmartJobIdFromUrl(job.url)) {
    const content = await fetchWalmartPostingContent(job, scanRun, companyLog);
    if (content) postingContent = content;
  }

  if (postingContent === job.description) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(job.url, {
        signal: controller.signal,
        headers: { "User-Agent": "CodexJobDashboard/1.0" }
      });
      incrementScanMetric(scanRun, companyLog, "detailFetches");
      recordScanCall(scanRun, companyLog, {
        type: "job detail",
        target: job.title,
        status: response.ok ? "ok" : "error",
        message: response.ok ? "Posting page fetched" : `${response.status} ${response.statusText}`
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const html = await response.text();
      postingContent = extractPostingContentFromHtml(html, job.title, job.description);
    } finally {
      clearTimeout(timeout);
    }
  }

  const result = await summarizeWithLLM(job, postingContent, profile, jobFeedback, historicalJobs, resumeText, scanRun, companyLog);
  writeJobDetailCacheEntry(jobDetailCache, cacheKey, job, postingContent, result, scoringInputHash);
  return result;
}

async function enrichJobSummaries(jobs, profile, jobFeedback = {}, historicalJobs = [], resumeText = "", scanRun = null, companyLog = null, jobDetailCache = {}) {
  const enriched = [];
  for (let index = 0; index < jobs.length; index += 4) {
    const batch = jobs.slice(index, index + 4);
    const results = await Promise.all(batch.map(async (job) => {
      try {
        const result = await fetchPostingSummary(job, profile, jobFeedback, historicalJobs, resumeText, scanRun, companyLog, jobDetailCache);
        return {
          ...job,
          description: result.summary,
          summarySource: result.cached ? "cache" : result.source,
          relevanceScore: result.relevanceScore,
          scoreRange: result.scoreRange || null,
          confidence: result.confidence || null,
          locationMatchesProfile: result.locationMatchesProfile || null,
          relevanceBucket: result.relevanceBucket,
          fitReasons: result.fitReasons || [],
          concerns: result.concerns || [],
          matchedSignals: result.matchedSignals || [],
          detailFetchedAt: new Date().toISOString()
        };
      } catch (error) {
        recordScanCall(scanRun, companyLog, {
          type: "summary",
          target: job.title,
          status: "error",
          message: error.message
        });
        return job;
      }
    }));
    enriched.push(...results);
  }
  return enriched;
}

function extractCompanyJobs(html, company, profile) {
  const terms = termsFromProfile(profile);
  const linkPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const seen = new Set();
  const jobs = [];
  let match;

  while ((match = linkPattern.exec(html))) {
    const href = match[1];
    const label = titleFromAnchorHtml(match[2]);
    const location = locationFromAnchorHtml(match[2]);
    const listedAt = extractDateFromAnchorHtml(match[2]);
    if (listedAt && !isRecentJobDate(listedAt)) continue;
    if (!label || label.length < 4 || label.length > 140) continue;
    if (/^(careers? at\b|work at\b|life at\b|career opportunities$|sales and refunds$|learn more about\b|see full role description$|learn more$|view details$|apply now$)/i.test(label)) continue;

    const searchable = `${label} ${href}`.toLowerCase();
    const hasProfileTerm = terms.some((term) => searchable.includes(term));
    const looksLikeRole = /\b(engineer|manager|analyst|developer|designer|product|data|software|specialist|leader|researcher|scientist|architect|consultant|director|program|operations|marketing|sales|finance|security)\b/i.test(label);
    if (!hasProfileTerm && !looksLikeRole) continue;

    let url;
    try {
      url = new URL(href, company.careersUrl).toString();
    } catch {
      continue;
    }
    const key = `${label}|${url}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    jobs.push({
      id: `company-${company.id}-${stableHash(url)}`,
      companyId: company.id,
      source: "Company Site",
      title: label,
      company: company.name,
      location,
      url,
      postedAt: listedAt || new Date().toISOString(),
      tags: ["Company watchlist"],
      description: `Found on ${company.name}'s careers page. ${company.notes || ""}`.trim()
    });
  }

  return jobs;
}

function greenhouseBoardTokenFromUrl(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (hostname !== "job-boards.greenhouse.io" && hostname !== "boards.greenhouse.io") return "";
    if (url.pathname.startsWith("/embed/job_board")) return cleanText(url.searchParams.get("for") || "");
    return cleanText(url.pathname.split("/").filter(Boolean)[0] || "");
  } catch {
    return "";
  }
}

function isGreenhouseCareersCompany(company) {
  return Boolean(greenhouseBoardTokenFromUrl(company.careersUrl));
}

function greenhouseJobLocation(job) {
  const locations = [];
  if (job.location?.name) locations.push(job.location.name);
  if (Array.isArray(job.offices)) {
    for (const office of job.offices) {
      const label = cleanText(office.location || office.name || "");
      if (label && !locations.includes(label)) locations.push(label);
    }
  }
  return locations.join(" | ") || "Greenhouse job board";
}

async function fetchGreenhouseJobs(company, profile, scanRun = null, companyLog = null) {
  const boardToken = greenhouseBoardTokenFromUrl(company.careersUrl);
  if (!boardToken) return [];
  const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(boardToken)}/jobs?content=true`;
  const response = await fetch(apiUrl, { headers: { "User-Agent": "CodexJobDashboard/1.0" } });
  incrementScanMetric(scanRun, companyLog, "pageFetches");
  recordScanCall(scanRun, companyLog, {
    type: "Greenhouse jobs API",
    target: boardToken,
    status: response.ok ? "ok" : "error",
    message: response.ok ? "Full job board fetched" : `${response.status} ${response.statusText}`
  });
  if (!response.ok) throw new Error(`Greenhouse API ${response.status} ${response.statusText}`);

  const data = await response.json();
  const sourceJobs = Array.isArray(data.jobs) ? data.jobs : [];
  const terms = termsFromProfile(profile);
  const seen = new Set();
  const jobs = [];
  let recentCount = 0;

  for (const item of sourceJobs) {
    const title = cleanText(item.title);
    const jobId = item.id || item.internal_job_id || stableHash(`${title}-${item.absolute_url || ""}`);
    const postedAt = parseJobDate(item.updated_at);
    if (postedAt && !isRecentJobDate(postedAt)) continue;
    recentCount += 1;
    if (!title || title.length < 4 || title.length > 160) continue;

    const url = item.absolute_url || `https://job-boards.greenhouse.io/${encodeURIComponent(boardToken)}/jobs/${encodeURIComponent(jobId)}`;
    const searchable = `${title} ${url} ${greenhouseJobLocation(item)}`.toLowerCase();
    const hasProfileTerm = terms.some((term) => searchable.includes(term));
    const looksLikeRole = /\b(engineer|manager|analyst|developer|designer|product|data|software|specialist|leader|researcher|scientist|architect|consultant|director|program|operations|marketing|sales|finance|security)\b/i.test(title);
    if (!hasProfileTerm && !looksLikeRole) continue;

    const key = String(jobId || url).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const departments = Array.isArray(item.departments) ? item.departments.map((department) => cleanText(department.name)).filter(Boolean) : [];
    const content = cleanText(decodeHtml(item.content || ""));

    jobs.push({
      id: `company-${company.id}-${stableHash(url)}`,
      companyId: company.id,
      source: "Greenhouse",
      title,
      company: company.name,
      location: greenhouseJobLocation(item),
      url,
      postedAt: postedAt || new Date().toISOString(),
      tags: ["Company watchlist", "Greenhouse", ...departments.slice(0, 3)],
      description: content || `Found on ${company.name}'s Greenhouse board. ${company.notes || ""}`.trim(),
      postingContentFetched: Boolean(content)
    });
  }

  recordScanCall(scanRun, companyLog, {
    type: "recent job filter",
    target: company.name,
    status: "ok",
    count: recentCount,
    message: postedDateFilterMessage()
  });
  recordScanCall(scanRun, companyLog, {
    type: "Greenhouse extraction",
    target: company.name,
    status: "ok",
    count: jobs.length,
    message: "Matched jobs from the full Greenhouse board API"
  });
  return jobs;
}

function isOpenAICareersCompany(company) {
  try {
    const url = new URL(company.careersUrl);
    const hostname = url.hostname.toLowerCase();
    return ((hostname === "openai.com" || hostname === "www.openai.com") && url.pathname.startsWith("/careers")) ||
      (hostname === "jobs.ashbyhq.com" && url.pathname.startsWith("/openai"));
  } catch {
    return false;
  }
}

function titleCaseWords(words) {
  return words.map((word) => {
    if (/^(ai|api|b2b|b2c|gtm|it|ml|ux|ui|cpu|aws|edu|apac|emea|latam|dc|tpm|tlm|fde)$/i.test(word)) return word.toUpperCase();
    return word.charAt(0).toUpperCase() + word.slice(1);
  }).join(" ");
}

function titleFromOpenAIJobPath(pathname) {
  const slug = String(pathname || "").split("/").filter(Boolean).pop() || "";
  const words = slug.split("-").filter(Boolean);
  const suffixes = [
    ["san", "francisco"],
    ["new", "york", "city"],
    ["washington", "dc"],
    ["remote", "us"],
    ["india", "remote"],
    ["london", "uk"],
    ["paris", "france"],
    ["munich", "germany"],
    ["tokyo", "japan"],
    ["seoul", "south", "korea"],
    ["sydney", "australia"],
    ["dublin", "ireland"],
    ["singapore"],
    ["seattle"],
    ["locations"]
  ];

  let titleWords = [...words];
  let changed = true;
  while (changed && titleWords.length) {
    changed = false;
    if (/^\d+$/.test(titleWords.at(-2) || "") && titleWords.at(-1) === "locations") {
      titleWords = titleWords.slice(0, -2);
      changed = true;
      continue;
    }
    for (const suffix of suffixes) {
      if (titleWords.length >= suffix.length && suffix.every((part, index) => titleWords[titleWords.length - suffix.length + index] === part)) {
        titleWords = titleWords.slice(0, -suffix.length);
        changed = true;
        break;
      }
    }
  }

  return titleCaseWords(titleWords.length ? titleWords : words);
}

function openAIJobAnchorParts(anchorHtml, pathname = "") {
  const paragraphs = [...anchorHtml.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((match) => decodeHtml(match[1])).filter(Boolean);
  const heading = anchorHtml.match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i);
  const allText = decodeHtml(anchorHtml);
  const pathTitle = titleFromOpenAIJobPath(pathname);
  return {
    title: paragraphs[0] || decodeHtml(heading?.[1] || pathTitle || allText),
    team: paragraphs[1] || "",
    location: paragraphs[2] || paragraphs[1] || "OpenAI careers"
  };
}

function extractOpenAICareersJobs(html, company, profile) {
  const terms = termsFromProfile(profile);
  const linkPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const seen = new Set();
  const jobs = [];
  let match;

  while ((match = linkPattern.exec(html))) {
    const href = match[1];
    let url;
    try {
      url = new URL(href, company.careersUrl);
    } catch {
      continue;
    }
    const hostname = url.hostname.toLowerCase();
    const isOpenAIJobPage = (hostname === "openai.com" || hostname === "www.openai.com") &&
      /^\/careers\/[^/]+\/?$/.test(url.pathname) &&
      !url.pathname.includes("/search");
    if (!isOpenAIJobPage) continue;

    const { title, team, location } = openAIJobAnchorParts(match[2], url.pathname);
    if (!title || title.length < 4 || title.length > 140) continue;
    if (/^(careers? at\b|apply now\b|learn more\b|openai$)/i.test(title)) continue;

    const searchable = `${title} ${team} ${location} ${url.pathname}`.toLowerCase();
    const hasProfileTerm = terms.some((term) => searchable.includes(term));
    const looksLikeRole = /\b(engineer|manager|analyst|developer|designer|product|data|software|specialist|leader|researcher|scientist|architect|consultant|director|program|operations|marketing|sales|finance|security)\b/i.test(title);
    if (terms.length ? !hasProfileTerm : !looksLikeRole) continue;

    const cleanUrl = url.toString();
    if (seen.has(cleanUrl)) continue;
    seen.add(cleanUrl);

    jobs.push({
      id: `company-${company.id}-${stableHash(cleanUrl)}`,
      companyId: company.id,
      source: "OpenAI Careers",
      title: cleanText(title),
      company: company.name,
      location: cleanText(location),
      url: cleanUrl,
      postedAt: new Date().toISOString(),
      tags: ["Company watchlist", cleanText(team)].filter(Boolean),
      description: `Found on OpenAI careers. ${team ? `Team: ${cleanText(team)}.` : ""} ${company.notes || ""}`.trim()
    });
  }

  return jobs;
}

function extractAshbyAppData(html) {
  const raw = extractJsonObjectAfter(html, "window.__appData");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function ashbyBoardNameFromUrl(value) {
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== "jobs.ashbyhq.com") return "";
    return cleanText(url.pathname.split("/").filter(Boolean)[0] || "");
  } catch {
    return "";
  }
}

function ashbyBoardNameFromHtml(html) {
  return cleanText(html.match(/jobs\.ashbyhq\.com\/([^"'?#/\s]+)/i)?.[1] || "");
}

function inferAshbyBoardName(company, html = "") {
  return ashbyBoardNameFromUrl(company.careersUrl) || ashbyBoardNameFromHtml(html);
}

function ashbyPostingToJob(posting, company, boardName, source = "Ashby") {
  const url = `https://jobs.ashbyhq.com/${encodeURIComponent(boardName)}/${encodeURIComponent(posting.id)}`;
  const location = posting.locationName || posting.locationExternalName || (posting.secondaryLocationNames || []).join(", ") || `${company.name} careers`;
  const team = posting.teamName || posting.teamExternalName || posting.departmentName || "";
  const content = cleanText(decodeEntities(posting.descriptionPlainText || posting.descriptionHtml || posting.shortDescription || ""));
  return {
    id: `company-${company.id}-${stableHash(url)}`,
    companyId: company.id,
    source,
    title: cleanText(posting.title),
    company: company.name,
    location: cleanText(location),
    url,
    postedAt: parseJobDate(posting.updatedAt || posting.publishedDate) || new Date().toISOString(),
    tags: ["Company watchlist", "Ashby", cleanText(team)].filter(Boolean),
    description: content || `Found on ${company.name}'s Ashby careers board. ${team ? `Team: ${cleanText(team)}.` : ""} ${company.notes || ""}`.trim(),
    postingContentFetched: Boolean(content)
  };
}

function ashbyPostingToOpenAIJob(posting, company) {
  return {
    ...ashbyPostingToJob(posting, company, "openai", "OpenAI Careers"),
    description: `Found on OpenAI careers. ${(posting.teamName || posting.teamExternalName || posting.departmentName) ? `Team: ${cleanText(posting.teamName || posting.teamExternalName || posting.departmentName)}.` : ""} ${company.notes || ""}`.trim(),
    postingContentFetched: false
  };
}

function extractAshbyJobs(html, company, profile, boardName = inferAshbyBoardName(company, html), source = "Ashby") {
  const data = extractAshbyAppData(html);
  const postings = Array.isArray(data?.jobBoard?.jobPostings) ? data.jobBoard.jobPostings : [];
  const terms = termsFromProfile(profile);
  const seen = new Set();
  const jobs = [];

  for (const posting of postings) {
    if (!posting?.id || !posting?.title || posting.isListed === false) continue;
    const postedAt = parseJobDate(posting.updatedAt || posting.publishedDate);
    if (postedAt && !isRecentJobDate(postedAt)) continue;
    const searchable = [
      posting.title,
      posting.departmentName,
      posting.teamName,
      posting.locationName,
      posting.descriptionPlainText
    ].map(cleanText).join(" ").toLowerCase();
    const hasProfileTerm = terms.some((term) => searchable.includes(term));
    const roleLike = /\b(engineer|manager|analyst|developer|designer|product|data|software|specialist|leader|researcher|scientist|architect|consultant|director|program|operations|marketing|sales|finance|security)\b/i.test(posting.title);
    if (!hasProfileTerm && !roleLike) continue;
    const job = ashbyPostingToJob(posting, company, boardName, source);
    if (seen.has(job.id)) continue;
    seen.add(job.id);
    jobs.push(job);
  }

  return jobs;
}

function extractOpenAIAshbyJobs(html, company, profile) {
  return extractAshbyJobs(html, company, profile, "openai", "OpenAI Careers").map((job) => ({
    ...job,
    tags: job.tags.filter((tag) => tag !== "Ashby"),
    description: `Found on OpenAI careers. ${job.tags.find((tag) => !["Company watchlist"].includes(tag)) ? `Team: ${job.tags.find((tag) => !["Company watchlist"].includes(tag))}.` : ""} ${company.notes || ""}`.trim(),
    postingContentFetched: false
  }));
}

function extractAshbyPostingContent(html) {
  const data = extractAshbyAppData(html);
  const posting = data?.posting;
  const content = posting?.descriptionPlainText || posting?.descriptionHtml || posting?.shortDescription || "";
  return cleanText(decodeEntities(content)).slice(0, 8000);
}

async function fetchOpenAIAshbyJobs(company, profile, scanRun = null, companyLog = null) {
  const url = "https://jobs.ashbyhq.com/openai";
  const response = await fetch(url, {
    headers: {
      "Accept": "text/html",
      "User-Agent": "CodexJobDashboard/1.0"
    }
  });
  incrementScanMetric(scanRun, companyLog, "pageFetches");
  recordScanCall(scanRun, companyLog, {
    type: "OpenAI Ashby board",
    target: url,
    status: response.ok ? "ok" : "error",
    message: response.ok ? "Fetched OpenAI's Ashby-backed job board" : `${response.status} ${response.statusText}`
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const jobs = extractOpenAIAshbyJobs(await response.text(), company, profile);
  recordScanCall(scanRun, companyLog, {
    type: "OpenAI job extraction",
    target: company.name,
    status: "ok",
    count: jobs.length,
    message: "Read OpenAI jobs from Ashby board data"
  });
  return jobs;
}

async function fetchAshbyJobs(company, profile, boardName, scanRun = null, companyLog = null) {
  const url = `https://jobs.ashbyhq.com/${encodeURIComponent(boardName)}`;
  const response = await fetch(url, {
    headers: {
      "Accept": "text/html",
      "User-Agent": "CodexJobDashboard/1.0"
    }
  });
  incrementScanMetric(scanRun, companyLog, "pageFetches");
  recordScanCall(scanRun, companyLog, {
    type: "Ashby board",
    target: url,
    status: response.ok ? "ok" : "error",
    message: response.ok ? "Fetched Ashby-backed job board" : `${response.status} ${response.statusText}`
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const jobs = extractAshbyJobs(await response.text(), company, profile, boardName, "Ashby");
  recordScanCall(scanRun, companyLog, {
    type: "Ashby extraction",
    target: company.name,
    status: "ok",
    count: jobs.length,
    message: "Read jobs from Ashby board data"
  });
  return jobs;
}

function isMicrosoftCareersCompany(company) {
  try {
    const hostname = new URL(company.careersUrl).hostname.toLowerCase();
    return hostname === "apply.careers.microsoft.com";
  } catch {
    return false;
  }
}

function microsoftPositionDate(position) {
  return parseJobDate(position.postedTs || position.creationTs || position.updatedAt || position.createdAt);
}

function microsoftPositionUrl(position) {
  return new URL(position.positionUrl || `/careers/job/${encodeURIComponent(position.id)}`, "https://apply.careers.microsoft.com").toString();
}

function microsoftPositionToJob(position, company) {
  const url = microsoftPositionUrl(position);
  const locations = Array.isArray(position.standardizedLocations) && position.standardizedLocations.length
    ? position.standardizedLocations
    : Array.isArray(position.locations) ? position.locations : [];
  return {
    id: `company-${company.id}-${stableHash(url)}`,
    companyId: company.id,
    source: "Microsoft Careers",
    title: cleanText(position.name),
    company: company.name,
    location: cleanText(locations.join(", ") || "Microsoft careers"),
    url,
    postedAt: microsoftPositionDate(position) || new Date().toISOString(),
    tags: ["Company watchlist", position.department, position.displayJobId].filter(Boolean).map(cleanText),
    description: `Microsoft Careers listing. ${[position.department, position.displayJobId].filter(Boolean).join(" · ")}`.trim()
  };
}

function microsoftSearchQueries(profile) {
  const desired = normalizeList(profile?.desiredTitles).map(cleanProfileTerm).filter(Boolean);
  const skills = normalizeList(profile?.skills).map(cleanProfileTerm).filter(Boolean);
  const queries = [...desired, ...skills]
    .filter((term) => term.length > 2)
    .filter((term, index, list) => list.findIndex((item) => item.toLowerCase() === term.toLowerCase()) === index)
    .slice(0, 8);
  return queries.length ? queries : [""];
}

async function fetchMicrosoftSearchPage(start, num, query = "", scanRun = null, companyLog = null) {
  const url = new URL("https://apply.careers.microsoft.com/api/pcsx/search");
  url.searchParams.set("domain", "microsoft.com");
  url.searchParams.set("start", String(start));
  url.searchParams.set("num", String(num));
  if (query) url.searchParams.set("query", query);
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "CodexJobDashboard/1.0"
    }
  });
  incrementScanMetric(scanRun, companyLog, "pageFetches");
  const body = await response.text();
  recordScanCall(scanRun, companyLog, {
    type: "Microsoft search API",
    target: query ? `${query} · start ${start}` : `start ${start}`,
    status: response.ok ? "ok" : "error",
    message: response.ok ? "Fetched Microsoft jobs page" : `${response.status} ${response.statusText}`
  });
  if (!response.ok) throw new Error(body || `${response.status} ${response.statusText}`);
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    const preview = cleanText(body).slice(0, 240);
    throw new Error(`Microsoft search API returned ${/^\s*</.test(body) ? "an HTML page" : "non-JSON content"} instead of JSON${preview ? `: ${preview}` : ""}`);
  }
  return Array.isArray(data?.data?.positions) ? data.data.positions : [];
}

async function fetchMicrosoftCareersJobs(company, profile, scanRun = null, companyLog = null) {
  const pageSize = 10;
  const maxPages = 40;
  const queries = microsoftSearchQueries(profile);
  const seen = new Set();
  const jobs = [];

  for (const query of queries) {
    for (let page = 0; page < maxPages; page += 1) {
      const start = page * pageSize;
      const positions = await fetchMicrosoftSearchPage(start, pageSize, query, scanRun, companyLog);
      if (!positions.length) break;

      let recentCount = 0;
      let olderCount = 0;
      for (const position of positions) {
        if (!position?.id || !position?.name) continue;
        const postedAt = microsoftPositionDate(position);
        if (postedAt && !isRecentJobDate(postedAt)) {
          olderCount += 1;
          continue;
        }
        const job = microsoftPositionToJob(position, company);
        if (seen.has(job.id)) continue;
        seen.add(job.id);
        jobs.push(job);
        recentCount += 1;
      }
      recordScanCall(scanRun, companyLog, {
        type: "recent job filter",
        target: query ? `${query} · Microsoft page ${page + 1}` : `Microsoft page ${page + 1}`,
        status: "ok",
        count: recentCount,
        message: postedDateFilterMessage()
      });
      if (olderCount === positions.length) break;
    }
  }

  return jobs;
}

function microsoftJobIdFromUrl(url) {
  return String(url || "").match(/apply\.careers\.microsoft\.com\/careers\/job\/([^/?#]+)/i)?.[1] || "";
}

async function fetchMicrosoftPostingContent(job, scanRun = null, companyLog = null) {
  const jobId = microsoftJobIdFromUrl(job.url);
  if (!jobId) return "";
  const apiUrl = `https://apply.careers.microsoft.com/api/pcsx/position_details?domain=microsoft.com&position_id=${encodeURIComponent(jobId)}`;
  const response = await fetch(apiUrl, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "CodexJobDashboard/1.0"
    }
  });
  incrementScanMetric(scanRun, companyLog, "detailFetches");
  const body = await response.text();
  recordScanCall(scanRun, companyLog, {
    type: "job detail",
    target: job.title,
    status: response.ok ? "ok" : "error",
    message: response.ok ? "Microsoft detail API" : `${response.status} ${response.statusText}`
  });
  if (!response.ok) return "";
  try {
    const data = JSON.parse(body);
    const details = data?.data || data;
    return cleanText(decodeEntities([
      details.jobDescription,
      details.responsibilities,
      details.qualifications,
      details.preferredQualifications
    ].filter(Boolean).join(" "))).slice(0, 8000);
  } catch {
    return "";
  }
}

function isWalmartCareersCompany(company) {
  try {
    const hostname = new URL(company.careersUrl).hostname.toLowerCase();
    return hostname === "careers.walmart.com";
  } catch {
    return false;
  }
}

function walmartCanonicalJobId(value) {
  return cleanText(value).replace(/-External$/i, "");
}

function walmartJobIdFromUrl(url) {
  const match = String(url || "").match(/careers\.walmart\.com\/[^?#]*\/jobs\/([^/?#]+)/i);
  return match?.[1] ? walmartCanonicalJobId(decodeURIComponent(match[1])) : "";
}

function walmartJobUrl(jobId) {
  return `https://careers.walmart.com/us/en/jobs/${encodeURIComponent(walmartCanonicalJobId(jobId))}`;
}

function walmartLocaleText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") return value["en-US"] || value.value || value.id || "";
  return String(value);
}

function walmartResultTitle(result) {
  const metadata = result?.metadata || {};
  return cleanText(
    metadata.jobPostingTitle ||
    metadata.title ||
    metadata.jobSelectionDescription ||
    walmartLocaleText(metadata.locale?.title)
  );
}

function walmartResultDate(result) {
  const metadata = result?.metadata || {};
  return parseJobDate(
    metadata.jobPostingStartDate ||
    metadata.recruitingStartDate ||
    metadata.createdAt ||
    metadata.effectiveDate
  );
}

function walmartMetadataLocation(metadata = {}) {
  const payLocation = Array.isArray(metadata.payRange) ? metadata.payRange.find((item) => item?.location)?.location : "";
  const parts = [
    metadata.primaryLocationCity,
    metadata.primaryLocationState,
    metadata.primaryLocationCountry
  ].map(cleanText).filter(Boolean);
  return cleanText(parts.join(", ") || payLocation || "Walmart Careers");
}

function walmartDetailsLocation(details = {}) {
  const primary = details.primaryLocation || {};
  const payLocation = Array.isArray(details.payRange) ? details.payRange.find((item) => item?.location)?.location : "";
  const additional = Array.isArray(details.additionalLocations)
    ? details.additionalLocations.map((location) => cleanText(location?.locationName || location?.city || "")).filter(Boolean)
    : [];
  const parts = [
    primary.city,
    primary.stateCode || primary.state,
    primary.country
  ].map(cleanText).filter(Boolean);
  return cleanText(parts.join(", ") || payLocation || additional.join(", ") || "Walmart Careers");
}

function walmartJobDetailsFromHtml(html) {
  const data = extractNextData(html);
  return data?.props?.pageProps?.jobDetails || null;
}

function walmartPostingContentFromDetails(details) {
  if (!details) return "";
  const sections = [
    details.descriptionSummary,
    details.jobPostingDescription,
    details.description,
    details.additionalDescription,
    details.minimumQualification,
    details.preferredQualification
  ].filter(Boolean);
  return cleanText(decodeEntities(sections.join(" "))).slice(0, 8000);
}

function walmartDetailsToJob(details, company, fallbackUrl = "") {
  const jobId = walmartCanonicalJobId(details?.jobId || details?.jobPostingId || walmartJobIdFromUrl(fallbackUrl));
  const title = cleanText(details?.jobPostingTitle || details?.title);
  if (!jobId || !title) return null;
  const url = fallbackUrl || walmartJobUrl(jobId);
  const content = walmartPostingContentFromDetails(details);
  const employmentTypes = Array.isArray(details.employmentTypes)
    ? details.employmentTypes.map((item) => cleanText(item?.value || item?.id || item)).filter(Boolean)
    : [];
  return {
    id: `company-${company.id}-${stableHash(url)}`,
    companyId: company.id,
    source: "Walmart Careers",
    title,
    company: company.name,
    location: walmartDetailsLocation(details),
    url,
    postedAt: parseJobDate(details.jobPostingStartDate || details.recruitingStartDate || details.createdAt) || new Date().toISOString(),
    tags: ["Company watchlist", details.brand, details.businessSegment?.value, ...employmentTypes].filter(Boolean).map(cleanText),
    description: content || `Walmart Careers listing. ${company.notes || ""}`.trim(),
    postingContentFetched: Boolean(content)
  };
}

function walmartSearchQueries(profile) {
  const terms = [...normalizeList(profile?.desiredTitles), ...normalizeList(profile?.skills)]
    .map(cleanProfileTerm)
    .filter((term) => term.length > 2)
    .filter((term, index, list) => list.findIndex((item) => item.toLowerCase() === term.toLowerCase()) === index);
  return terms.length ? terms.slice(0, 8) : ["engineer", "analyst", "manager"];
}

async function fetchWalmartSearchPage(query, page, size, scanRun = null, companyLog = null) {
  const url = new URL("https://careers.walmart.com/api/ai/search-ai/api/v1/combined/hybrid-search");
  url.searchParams.set("page", String(page));
  url.searchParams.set("size", String(size));
  url.searchParams.set("locale", "en_US");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Origin": "https://careers.walmart.com",
      "Referer": "https://careers.walmart.com/us/en/home",
      "User-Agent": "CodexJobDashboard/1.0"
    },
    body: JSON.stringify({
      query,
      basicSearch: false,
      filter: "",
      locale: "en_US"
    })
  });
  incrementScanMetric(scanRun, companyLog, "pageFetches");
  const body = await response.text();
  recordScanCall(scanRun, companyLog, {
    type: "Walmart search API",
    target: query ? `${query} · page ${page + 1}` : `page ${page + 1}`,
    status: response.ok ? "ok" : "error",
    message: response.ok ? "Fetched Walmart jobs page" : `${response.status} ${response.statusText}`
  });
  if (!response.ok) throw new Error(body || `${response.status} ${response.statusText}`);
  try {
    const data = JSON.parse(body);
    return Array.isArray(data.jobs) ? data.jobs : [];
  } catch {
    const preview = cleanText(body).slice(0, 240);
    throw new Error(`Walmart search API returned ${/^\s*</.test(body) ? "an HTML page" : "non-JSON content"} instead of JSON${preview ? `: ${preview}` : ""}`);
  }
}

function walmartSearchResultToJob(result, company) {
  const metadata = result?.metadata || {};
  const jobId = walmartCanonicalJobId(metadata.jobId || result?.id);
  const title = walmartResultTitle(result);
  if (!jobId || !title) return null;
  const url = walmartJobUrl(jobId);
  const areas = Array.isArray(metadata.areas) ? metadata.areas : [];
  const categories = Array.isArray(metadata.categories) ? metadata.categories : [];
  const skills = Array.isArray(metadata.skills) ? metadata.skills : [];
  const employmentTypes = Array.isArray(metadata.employmentTypes) ? metadata.employmentTypes : [];
  const summary = cleanText(decodeEntities(metadata.descriptionSummary || result?.text || ""));
  return {
    id: `company-${company.id}-${stableHash(url)}`,
    companyId: company.id,
    source: "Walmart Careers",
    title,
    company: company.name,
    location: walmartMetadataLocation(metadata),
    url,
    postedAt: walmartResultDate(result) || new Date().toISOString(),
    tags: ["Company watchlist", metadata.brand, ...areas, ...categories, ...employmentTypes].filter(Boolean).map(cleanText).slice(0, 8),
    description: summary || `Walmart Careers listing. ${company.notes || ""}`.trim(),
    matchedSignals: skills.slice(0, 6).map(cleanText),
    postingContentFetched: false
  };
}

async function fetchWalmartCareersJobs(company, profile, landingHtml = "", scanRun = null, companyLog = null) {
  const landingJobId = walmartJobIdFromUrl(company.careersUrl);
  if (landingJobId) {
    const details = walmartJobDetailsFromHtml(landingHtml);
    const job = walmartDetailsToJob(details, company, company.careersUrl);
    recordScanCall(scanRun, companyLog, {
      type: "Walmart detail page",
      target: landingJobId,
      status: job ? "ok" : "error",
      count: job ? 1 : 0,
      message: job ? "Parsed Walmart job detail page" : "No job details found in Walmart detail page"
    });
    return job ? [job] : [];
  }

  const testMode = scanRun?.scope === "company request test";
  const pageSize = testMode ? 10 : 25;
  const maxPages = testMode ? 1 : 12;
  const queries = walmartSearchQueries(profile).slice(0, testMode ? 2 : 8);
  const seen = new Set();
  const jobs = [];

  for (const query of queries) {
    for (let page = 0; page < maxPages; page += 1) {
      const results = await fetchWalmartSearchPage(query, page, pageSize, scanRun, companyLog);
      if (!results.length) break;

      let recentCount = 0;
      let olderCount = 0;
      let added = 0;
      for (const result of results) {
        const job = walmartSearchResultToJob(result, company);
        if (!job) continue;
        if (job.postedAt && !isRecentJobDate(job.postedAt)) {
          olderCount += 1;
          continue;
        }
        if (seen.has(job.id)) continue;
        seen.add(job.id);
        jobs.push(job);
        recentCount += 1;
        added += 1;
      }
      recordScanCall(scanRun, companyLog, {
        type: "recent job filter",
        target: query ? `${query} · Walmart page ${page + 1}` : `Walmart page ${page + 1}`,
        status: "ok",
        count: recentCount,
        message: postedDateFilterMessage()
      });
      recordScanCall(scanRun, companyLog, {
        type: "Walmart extraction",
        target: query ? `${query} · page ${page + 1}` : `page ${page + 1}`,
        status: "ok",
        count: added,
        message: "Matched Walmart careers jobs from search API"
      });
      if (olderCount === results.length || results.length < pageSize) break;
    }
  }

  return jobs;
}

async function fetchWalmartPostingContent(job, scanRun = null, companyLog = null) {
  const jobId = walmartJobIdFromUrl(job.url);
  if (!jobId) return "";
  const response = await fetch(walmartJobUrl(jobId), {
    headers: {
      "Accept": "text/html",
      "User-Agent": "CodexJobDashboard/1.0"
    }
  });
  incrementScanMetric(scanRun, companyLog, "detailFetches");
  recordScanCall(scanRun, companyLog, {
    type: "job detail",
    target: job.title,
    status: response.ok ? "ok" : "error",
    message: response.ok ? "Walmart detail page" : `${response.status} ${response.statusText}`
  });
  if (!response.ok) return "";
  const details = walmartJobDetailsFromHtml(await response.text());
  return walmartPostingContentFromDetails(details) || "";
}

function isGoogleCareersCompany(company) {
  try {
    const url = new URL(company.careersUrl);
    const hostname = url.hostname.toLowerCase();
    return (hostname === "google.com" || hostname === "www.google.com") &&
      url.pathname.startsWith("/about/careers/applications/jobs/results");
  } catch {
    return false;
  }
}

function googleSearchQueries(profile) {
  return eightfoldSearchQueries(profile).slice(0, 7);
}

function extractGoogleCareersJobs(html, company, profile) {
  const terms = termsFromProfile(profile);
  const chunks = html
    .split(/(?=<li\b[^>]*class=["'][^"']*\blLd3Je\b)/i)
    .filter((chunk) => /^<li\b/i.test(chunk));
  const seen = new Set();
  const jobs = [];

  for (const chunk of chunks) {
    const id = chunk.match(/ssk=['"]\d+:(\d+)['"]/i)?.[1] ||
      chunk.match(/jsdata=["'][^"']*;(\d+);/i)?.[1];
    const rawTitle = chunk.match(/<h3\b[^>]*class=["'][^"']*\bQJPWVe\b[^"']*["'][^>]*>([\s\S]*?)<\/h3>/i)?.[1];
    const title = decodeHtml(rawTitle || "");
    if (!id || !title) continue;

    const locations = [...chunk.matchAll(/<span\b[^>]*class=["'][^"']*\br0wTof\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi)]
      .map((match) => decodeHtml(match[1]).replace(/^;\s*/, ""))
      .filter(Boolean)
      .filter((location, index, list) => list.indexOf(location) === index);
    const searchable = `${title} ${locations.join(" ")}`.toLowerCase();
    const hasProfileTerm = terms.some((term) => searchable.includes(term));
    const roleLike = /\b(engineer|manager|analyst|developer|designer|product|data|software|specialist|leader|researcher|scientist|architect|consultant|director|program|operations|marketing|sales|finance|security)\b/i.test(title);
    if (terms.length ? !hasProfileTerm : !roleLike) continue;

    const url = `https://www.google.com/about/careers/applications/jobs/results/${encodeURIComponent(id)}`;
    if (seen.has(url)) continue;
    seen.add(url);
    jobs.push({
      id: `company-${company.id}-${stableHash(url)}`,
      companyId: company.id,
      source: "Google Careers",
      title,
      company: company.name,
      location: locations.join(", ") || "Google Careers",
      url,
      postedAt: new Date().toISOString(),
      tags: ["Company watchlist"],
      description: `Google Careers listing. ${locations.slice(0, 4).join(", ")}`.trim()
    });
  }

  return jobs;
}

async function fetchGoogleCareersJobs(company, profile, landingHtml, scanRun = null, companyLog = null) {
  const queries = googleSearchQueries(profile);
  const seen = new Set();
  const jobs = [];

  for (const query of queries) {
    let html = landingHtml;
    let target = company.careersUrl;
    if (query) {
      const url = new URL(company.careersUrl);
      url.searchParams.set("q", query);
      target = url.toString();
      const response = await fetch(target, {
        headers: {
          "Accept": "text/html",
          "User-Agent": "CodexJobDashboard/1.0"
        }
      });
      incrementScanMetric(scanRun, companyLog, "pageFetches");
      recordScanCall(scanRun, companyLog, {
        type: "Google careers search",
        target: query,
        status: response.ok ? "ok" : "error",
        message: response.ok ? "Fetched Google careers search page" : `${response.status} ${response.statusText}`
      });
      if (!response.ok) continue;
      html = await response.text();
    }

    const extracted = extractGoogleCareersJobs(html, company, profile);
    let added = 0;
    for (const job of extracted) {
      if (seen.has(job.id)) continue;
      seen.add(job.id);
      jobs.push(job);
      added += 1;
    }
    recordScanCall(scanRun, companyLog, {
      type: "Google job extraction",
      target: query || company.name,
      status: "ok",
      count: added,
      message: "Matched Google job cards from careers HTML"
    });
  }

  return jobs;
}

function isEightfoldCareersCompany(company) {
  try {
    const hostname = new URL(company.careersUrl).hostname.toLowerCase();
    return hostname === "explore.jobs.netflix.net" ||
      hostname.endsWith(".eightfold.ai") ||
      hostname.endsWith(".eightfold.com");
  } catch {
    return false;
  }
}

function looksLikeEightfoldCareersHtml(html) {
  return /&#34;positions&#34;|&quot;positions&quot;|"positions"/.test(html) &&
    (/vscdn\.net|octuple|PCS_PARAMS|smartApply/i.test(html));
}

function eightfoldSearchQueries(profile) {
  const terms = [...normalizeList(profile.desiredTitles), ...normalizeList(profile.skills)]
    .map(cleanProfileTerm)
    .filter((term) => term.length > 2);
  const profileQueries = terms
    .filter((term, index, list) => list.findIndex((item) => item.toLowerCase() === term.toLowerCase()) === index)
    .slice(0, 6);
  return profileQueries.length ? [...profileQueries, ""] : [""];
}

function extractEightfoldPositions(html) {
  const decoded = decodeEntities(html);
  const positionsText = extractJsonArrayAfter(decoded, "\"positions\"");
  if (!positionsText) return [];
  try {
    return JSON.parse(positionsText);
  } catch {
    return [];
  }
}

function dateFromUnixSeconds(value) {
  return parseJobDate(value) || new Date().toISOString();
}

function eightfoldPositionDate(position) {
  return parseJobDate(position.t_update || position.t_create || position.updated_at || position.created_at);
}

function eightfoldPositionToJob(position, company) {
  const url = position.canonicalPositionUrl ||
    (position.id ? new URL(`/careers/job/${encodeURIComponent(position.id)}`, company.careersUrl).toString() : company.careersUrl);
  const locations = Array.isArray(position.locations) ? position.locations : [position.location].filter(Boolean);
  const tags = [
    "Company watchlist",
    position.department,
    position.business_unit,
    position.work_location_option
  ].filter(Boolean);

  return {
    id: `company-${company.id}-${stableHash(url)}`,
    companyId: company.id,
    source: "Company Site",
    title: cleanText(position.posting_name || position.name),
    company: company.name,
    location: cleanText(locations.join(", ") || "Netflix careers"),
    url,
    postedAt: dateFromUnixSeconds(position.t_update || position.t_create),
    tags,
    description: `Found on ${company.name}'s careers page. ${[position.department, position.business_unit].filter(Boolean).join(", ")}`.trim()
  };
}

async function fetchEightfoldCareersJobs(company, profile, landingHtml, scanRun = null, companyLog = null) {
  const seen = new Set();
  const jobs = [];
  const queries = eightfoldSearchQueries(profile);

  for (const query of queries) {
    let html = landingHtml;
    let target = company.careersUrl;

    if (query) {
      const url = new URL(company.careersUrl);
      url.searchParams.set("query", query);
      target = url.toString();
      let timeout = null;
      try {
        const controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), 15000);
        const response = await fetch(target, {
          signal: controller.signal,
          headers: { "User-Agent": "CodexJobDashboard/1.0" }
        });
        incrementScanMetric(scanRun, companyLog, "pageFetches");
        recordScanCall(scanRun, companyLog, {
          type: "Eightfold search page",
          target,
          status: response.ok ? "ok" : "error",
          message: response.ok ? `Search page fetched for "${query}"` : `${response.status} ${response.statusText}`
        });
        if (!response.ok) continue;
        html = await response.text();
      } catch (error) {
        recordScanCall(scanRun, companyLog, {
          type: "Eightfold search page",
          target,
          status: "error",
          message: error.message
        });
        continue;
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }

    const positions = extractEightfoldPositions(html);
    recordScanCall(scanRun, companyLog, {
      type: "Eightfold embedded jobs",
      target: query || company.name,
      status: "ok",
      count: positions.length,
      message: query ? `Read embedded jobs for "${query}"` : "Read embedded jobs from landing page"
    });

    let recentCount = 0;
    for (const position of positions) {
      const title = cleanText(position.posting_name || position.name);
      if (!position?.id || !title) continue;
      const positionDate = eightfoldPositionDate(position);
      if (positionDate && !isRecentJobDate(positionDate)) continue;
      const job = eightfoldPositionToJob(position, company);
      if (seen.has(job.id)) continue;
      seen.add(job.id);
      jobs.push(job);
      recentCount += 1;
    }
    recordScanCall(scanRun, companyLog, {
      type: "recent job filter",
      target: query || company.name,
      status: "ok",
      count: recentCount,
      message: postedDateFilterMessage()
    });
  }

  return jobs;
}

function isMetaCareersCompany(company) {
  try {
    const hostname = new URL(company.careersUrl).hostname.toLowerCase();
    return hostname === "metacareers.com" || hostname.endsWith(".metacareers.com");
  } catch {
    return false;
  }
}

function extractMetaLsdToken(html) {
  return html.match(/\["LSD",\[\],\{"token":"([^"]+)"/)?.[1] ||
    html.match(/"LSD"[\s\S]*?"token":"([^"]+)"/)?.[1] ||
    "";
}

function metaSearchQueries(profile) {
  const desired = normalizeList(profile.desiredTitles).slice(0, 5);
  if (desired.length) return desired;
  const skills = normalizeList(profile.skills).slice(0, 5);
  return skills.length ? skills : [""];
}

function metaResultDate(result) {
  return parseJobDate(
    result.updated_time ||
    result.updated_at ||
    result.created_time ||
    result.created_at ||
    result.posted_at ||
    result.postedAt ||
    result.date_posted ||
    result.datePosted ||
    result.timestamp ||
    result.creation_ts
  );
}

async function fetchMetaCareersResults(searchInput, lsdToken, referer, scanRun = null, companyLog = null) {
  const body = new URLSearchParams();
  body.set("fb_api_req_friendly_name", "CareersJobSearchResultsDataQuery");
  body.set("variables", JSON.stringify({ search_input: searchInput }));
  body.set("doc_id", "29615178951461218");
  body.set("server_timestamps", "true");
  if (lsdToken) body.set("lsd", lsdToken);

  const response = await fetch("https://www.metacareers.com/api/graphql/", {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "Referer": referer,
      "User-Agent": "CodexJobDashboard/1.0",
      ...(lsdToken ? { "x-fb-lsd": lsdToken } : {})
    },
    body
  });

  incrementScanMetric(scanRun, companyLog, "metaApiCalls");
  if (!response.ok) {
    recordScanCall(scanRun, companyLog, {
      type: "Meta job search API",
      target: searchInput.q || "all jobs",
      status: "error",
      message: `${response.status} ${response.statusText}`
    });
    throw new Error(`${response.status} ${response.statusText}`);
  }
  const raw = await response.text();
  const data = JSON.parse(raw.replace(/^for\s*\(;;\);\s*/, ""));
  if (data.errors?.length) {
    const message = data.errors.map((error) => error.message).join("; ");
    recordScanCall(scanRun, companyLog, {
      type: "Meta job search API",
      target: searchInput.q || "all jobs",
      status: "error",
      message
    });
    throw new Error(message);
  }
  const results = data.data?.job_search_with_featured_jobs?.all_jobs || [];
  recordScanCall(scanRun, companyLog, {
    type: "Meta job search API",
    target: searchInput.q || "all jobs",
    status: "ok",
    count: results.length,
    message: "GraphQL job search"
  });
  return results;
}

async function fetchMetaCareersJobs(company, profile, landingHtml, scanRun = null, companyLog = null) {
  const lsdToken = extractMetaLsdToken(landingHtml);
  const queries = metaSearchQueries(profile);
  const seen = new Set();
  const jobs = [];

  for (const query of queries) {
    const results = await fetchMetaCareersResults({
      q: query || null,
      divisions: [],
      offices: [],
      roles: [],
      leadership_levels: [],
      saved_jobs: [],
      saved_searches: [],
      sub_teams: [],
      teams: [],
      is_leadership: false,
      is_remote_only: false,
      sort_by_new: true,
      page: 1,
      results_per_page: null
    }, lsdToken, company.careersUrl, scanRun, companyLog);

    let recentCount = 0;
    for (const result of results) {
      if (!result?.id || !result?.title || seen.has(result.id)) continue;
      const postedAt = metaResultDate(result);
      if (postedAt && !isRecentJobDate(postedAt)) continue;
      seen.add(result.id);
      recentCount += 1;

      const locations = Array.isArray(result.locations) ? result.locations.filter(Boolean) : [];
      const teams = Array.isArray(result.teams) ? result.teams.filter(Boolean) : [];
      const subTeams = Array.isArray(result.sub_teams) ? result.sub_teams.filter(Boolean) : [];
      const url = metaCareersJobUrl(result.id);

      jobs.push({
        id: `company-${company.id}-${stableHash(url)}`,
        companyId: company.id,
        source: "Meta Careers",
        title: cleanText(result.title),
        company: company.name,
        location: locations.join(", ") || "Meta Careers",
        url,
        postedAt: postedAt || new Date().toISOString(),
        tags: ["Company watchlist", ...teams.slice(0, 3), ...subTeams.slice(0, 3)],
        description: `Meta Careers listing. Teams: ${[...teams, ...subTeams].slice(0, 6).join(", ") || "not listed"}. Locations: ${locations.slice(0, 6).join(", ") || "not listed"}.`
      });
    }
    recordScanCall(scanRun, companyLog, {
      type: "recent job filter",
      target: query || company.name,
      status: "ok",
      count: recentCount,
      message: postedDateFilterMessage()
    });
  }

  return jobs;
}

async function fetchTargetCompanyJobs(profile, targetCompanies, jobFeedback = {}, historicalJobs = [], resumeText = "", scanRun = null, jobDetailCache = {}, options = {}) {
  const jobs = [];
  const results = [];
  const enrich = options.enrich !== false;

  for (const company of targetCompanies.filter((item) => item.careersUrl)) {
    const companyLog = companyScanLog(scanRun, company);
    const checkedAt = new Date().toISOString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    if (companyLog) {
      companyLog.status = "scanning";
      companyLog.startedAt = checkedAt;
      companyLog.extractor = isMetaCareersCompany(company)
        ? "Meta Careers API"
        : isOpenAICareersCompany(company)
          ? "OpenAI careers parser"
          : isGreenhouseCareersCompany(company)
            ? "Greenhouse jobs API"
            : isMicrosoftCareersCompany(company)
              ? "Microsoft Careers API"
              : isGoogleCareersCompany(company)
                ? "Google careers parser"
                : isWalmartCareersCompany(company)
                  ? "Walmart careers API"
                  : isEightfoldCareersCompany(company) ? "Eightfold embedded jobs" : "Generic link parser";
    }
    try {
      const response = await fetch(company.careersUrl, {
        signal: controller.signal,
        headers: { "User-Agent": "CodexJobDashboard/1.0" }
      });
      incrementScanMetric(scanRun, companyLog, "pageFetches");
      recordScanCall(scanRun, companyLog, {
        type: "company careers page",
        target: company.careersUrl,
        status: response.ok || isOpenAICareersCompany(company) ? "ok" : "error",
        message: response.ok
          ? "Landing page fetched"
          : isOpenAICareersCompany(company)
            ? `${response.status} ${response.statusText}; using OpenAI Ashby board fallback`
            : `${response.status} ${response.statusText}`
      });
      let html = "";
      if (response.ok) {
        html = await response.text();
      } else if (!isOpenAICareersCompany(company)) {
        throw new Error(`${response.status} ${response.statusText}`);
      }

      const useEightfoldExtractor = Boolean(html) && (isEightfoldCareersCompany(company) || looksLikeEightfoldCareersHtml(html));
      const ashbyBoardName = inferAshbyBoardName(company, html);
      if (companyLog && useEightfoldExtractor) companyLog.extractor = "Eightfold embedded jobs";
      if (companyLog && ashbyBoardName && !isOpenAICareersCompany(company)) companyLog.extractor = "Ashby jobs";
      const extractedJobs = isMetaCareersCompany(company)
        ? await fetchMetaCareersJobs(company, profile, html, scanRun, companyLog)
        : isOpenAICareersCompany(company)
          ? (response.ok ? extractOpenAICareersJobs(html, company, profile) : await fetchOpenAIAshbyJobs(company, profile, scanRun, companyLog))
          : isGreenhouseCareersCompany(company)
            ? await fetchGreenhouseJobs(company, profile, scanRun, companyLog)
            : isMicrosoftCareersCompany(company)
              ? await fetchMicrosoftCareersJobs(company, profile, scanRun, companyLog)
              : isGoogleCareersCompany(company)
                ? await fetchGoogleCareersJobs(company, profile, html, scanRun, companyLog)
                : isWalmartCareersCompany(company)
                  ? await fetchWalmartCareersJobs(company, profile, html, scanRun, companyLog)
                  : ashbyBoardName
                    ? await fetchAshbyJobs(company, profile, ashbyBoardName, scanRun, companyLog)
                    : useEightfoldExtractor
                      ? await fetchEightfoldCareersJobs(company, profile, html, scanRun, companyLog)
                      : extractCompanyJobs(html, company, profile);
      if (isOpenAICareersCompany(company) && response.ok && extractedJobs.length === 0) {
        const ashbyJobs = await fetchOpenAIAshbyJobs(company, profile, scanRun, companyLog);
        extractedJobs.push(...ashbyJobs.filter((job) => !extractedJobs.some((existing) => existing.id === job.id)));
      }
      if (!isMetaCareersCompany(company) && !isGreenhouseCareersCompany(company) && !isMicrosoftCareersCompany(company) && !isGoogleCareersCompany(company) && !isWalmartCareersCompany(company) && !ashbyBoardName && !useEightfoldExtractor) {
        recordScanCall(scanRun, companyLog, {
          type: isOpenAICareersCompany(company) ? "OpenAI job extraction" : "link extraction",
          target: company.name,
          status: "ok",
          count: extractedJobs.length,
          message: isOpenAICareersCompany(company)
            ? "Matched OpenAI-owned job detail pages using profile terms"
            : "Matched links from careers page HTML"
        });
      }
      incrementScanMetric(scanRun, companyLog, "rawJobsFound", extractedJobs.length);
      const found = enrich
        ? await enrichJobSummaries(extractedJobs, profile, jobFeedback, historicalJobs, resumeText, scanRun, companyLog, jobDetailCache)
        : extractedJobs;
      if (companyLog) {
        companyLog.status = "completed";
        companyLog.finishedAt = new Date().toISOString();
      }
      incrementScanMetric(scanRun, companyLog, "jobsFound", found.length);
      jobs.push(...found);
      results.push({
        id: company.id,
        name: company.name,
        careersUrl: company.careersUrl,
        checkedAt,
        found: found.length,
        error: null
      });
    } catch (error) {
      if (companyLog) {
        companyLog.status = "failed";
        companyLog.finishedAt = new Date().toISOString();
      }
      recordScanCall(scanRun, companyLog, {
        type: "company scan",
        target: company.name,
        status: "error",
        message: error.message
      });
      results.push({
        id: company.id,
        name: company.name,
        careersUrl: company.careersUrl,
        checkedAt,
        found: 0,
        error: error.message
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  return { jobs, results };
}

async function scrapeJobs(profile, targetCompanies = [], jobFeedback = {}, historicalJobs = [], scope = "manual", resumeText = "", jobDetailCache = {}, userId = "", options = {}) {
  const scanRun = createScanRun(scope, targetCompanies.filter((item) => item.careersUrl));
  scanRun.userId = userId;
  activeScanRuns.set(scanRun.id, scanRun);
  const errors = [];
  let companyScan;
  try {
    companyScan = await fetchTargetCompanyJobs(profile, targetCompanies, jobFeedback, historicalJobs, resumeText, scanRun, jobDetailCache, options);
  } catch (error) {
    finishScanRun(scanRun, "failed");
    setTimeout(() => activeScanRuns.delete(scanRun.id), 10000);
    throw error;
  }
  const companyJobs = annotateJobs(uniqJobs(companyScan.jobs), profile, jobFeedback, [...historicalJobs, ...companyScan.jobs]);
  for (const result of companyScan.results) {
    if (result.error) errors.push(`${result.name}: ${result.error}`);
  }
  finishScanRun(scanRun, errors.length ? "completed_with_issues" : "completed");
  setTimeout(() => activeScanRuns.delete(scanRun.id), 10000);

  return {
    jobs: companyJobs,
    companyScanJobs: companyJobs,
    jobDetailCache: pruneJobDetailCache(jobDetailCache, companyJobs),
    scanRun,
    summary: {
      totalFetched: companyJobs.length,
      matched: companyJobs.length,
      companiesScanned: uniqSortedCompanies(companyJobs),
      targetCompanyResults: companyScan.results,
      sourcesChecked: ["Company Watchlist"],
      errors,
      scrapedAt: new Date().toISOString()
    }
  };
}

function updateCompaniesFromScan(targetCompanies, scanResults) {
  return targetCompanies.map((company) => {
    const scan = scanResults.find((item) => item.id === company.id);
    if (!scan) return company;
    return {
      ...company,
      lastCheckedAt: scan.checkedAt,
      lastFoundCount: scan.error ? (company.lastFoundCount ?? 0) : scan.found,
      lastError: scan.error
    };
  });
}

function successfulScanKeys(scanResults = []) {
  const ids = new Set();
  const names = new Set();
  for (const scan of scanResults) {
    if (!scan || scan.error) continue;
    if (scan.id) ids.add(scan.id);
    if (scan.name) names.add(scan.name);
  }
  return { ids, names };
}

function rememberLastGoodJobBoard(store) {
  const jobs = store.companyScanJobs || [];
  if (!jobs.length) return;
  store.lastGoodCompanyScanJobs = jobs;
  store.lastGoodScrapeSummary = store.lastScrapeSummary || summarizeCurrentCompanyJobs(store);
  store.lastGoodScrapeAt = store.lastScrapeAt || null;
}

function mergeScannedJobs(existingJobs = [], resultJobs = [], scanResults = [], profile, jobFeedback = {}) {
  const { ids, names } = successfulScanKeys(scanResults);
  if (!ids.size && !names.size) return annotateJobs(uniqJobs(existingJobs), profile, jobFeedback);
  const keptJobs = existingJobs.filter((job) => !ids.has(job.companyId) && !names.has(job.company));
  return annotateJobs(uniqJobs([...keptJobs, ...resultJobs]), profile, jobFeedback);
}

function applyScanResultToStore(store, result) {
  rememberLastGoodJobBoard(store);
  const existingJobs = (store.companyScanJobs || []).length
    ? store.companyScanJobs
    : (store.lastGoodCompanyScanJobs || []);
  store.companyScanJobs = mergeScannedJobs(
    existingJobs,
    result.companyScanJobs || [],
    result.summary?.targetCompanyResults || [],
    store.profile,
    store.jobFeedback || {}
  );
  store.jobs = store.companyScanJobs;
  store.jobDetailCache = pruneJobDetailCache(result.jobDetailCache || store.jobDetailCache || {}, store.companyScanJobs);
  store.targetCompanies = updateCompaniesFromScan(store.targetCompanies, result.summary.targetCompanyResults);
  store.lastScrapeAt = result.summary.scrapedAt;
  store.lastScrapeSummary = mergeCompanyScanSummary(store, result);
}

function mergeCompanyScanSummary(store, result) {
  const previousResults = store.lastScrapeSummary?.targetCompanyResults || [];
  const scannedIds = new Set(result.summary.targetCompanyResults.map((item) => item.id));
  const targetCompanyResults = [
    ...previousResults.filter((item) => !scannedIds.has(item.id)),
    ...result.summary.targetCompanyResults
  ].sort((a, b) => a.name.localeCompare(b.name));
  const scannedNames = new Set(result.summary.targetCompanyResults.map((item) => item.name));
  const previousErrors = store.lastScrapeSummary?.errors || [];
  const errors = [
    ...previousErrors.filter((error) => ![...scannedNames].some((name) => error.startsWith(`${name}:`))),
    ...result.summary.errors
  ];

  return {
    totalFetched: store.companyScanJobs.length,
    matched: store.companyScanJobs.length,
    companiesScanned: uniqSortedCompanies(store.companyScanJobs),
    targetCompanyResults,
    sourcesChecked: ["Company Watchlist"],
    errors,
    scrapedAt: result.summary.scrapedAt
  };
}

function summarizeCurrentCompanyJobs(store) {
  const previous = store.lastScrapeSummary || {};
  const companyIds = new Set(store.targetCompanies.map((company) => company.id));
  return {
    totalFetched: store.companyScanJobs.length,
    matched: store.companyScanJobs.length,
    companiesScanned: uniqSortedCompanies(store.companyScanJobs),
    targetCompanyResults: (previous.targetCompanyResults || []).filter((item) => companyIds.has(item.id)),
    sourcesChecked: ["Company Watchlist"],
    errors: previous.errors || [],
    scrapedAt: previous.scrapedAt || store.lastScrapeAt
  };
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function zonedDateParts(value = new Date(), timeZone = defaultTimeZone()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: normalizeTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute)
  };
}

function localDateKey(value = new Date(), timeZone = defaultTimeZone()) {
  return zonedDateParts(value, timeZone)?.dateKey || "";
}

function shouldRunEmailDigest(settings) {
  if (!settings?.enabled || !settings.email) return false;
  const timeZone = normalizeTimeZone(settings.timeZone || defaultTimeZone());
  if (settings.lastDigestSentAt && localDateKey(settings.lastDigestSentAt, timeZone) === localDateKey(new Date(), timeZone)) return false;
  const [hour, minute] = String(settings.sendTime || "08:00").split(":").map(Number);
  const targetMinutes = (Number.isFinite(hour) ? hour : 8) * 60 + (Number.isFinite(minute) ? minute : 0);
  const nowParts = zonedDateParts(new Date(), timeZone);
  return Boolean(nowParts && nowParts.minutes >= targetMinutes);
}

function digestCandidateJobs(jobs, store, sentKeys) {
  const settings = store.emailDigest || {};
  const minScore = clampRelevanceScore(settings.minRelevanceScore) ?? 7;
  const maxJobs = Number(settings.maxJobs || 10);
  return (jobs || [])
    .filter((job) => !sentKeys.has(jobDetailCacheKey(job)))
    .filter((job) => (clampRelevanceScore(job.relevanceScore) ?? 0) >= minScore)
    .filter((job) => job.locationMatchesProfile !== "No")
    .filter((job) => !["applied", "rejected"].includes(store.statuses?.[job.id]?.status))
    .sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0) || (b.score || 0) - (a.score || 0) || safeDate(b.postedAt) - safeDate(a.postedAt))
    .slice(0, Number.isFinite(maxJobs) ? Math.max(1, Math.min(50, Math.round(maxJobs))) : 10);
}

function renderDigestEmail(user, jobs, settings) {
  const grouped = new Map();
  for (const job of jobs) {
    if (!grouped.has(job.company)) grouped.set(job.company, []);
    grouped.get(job.company).push(job);
  }
  const subject = `${jobs.length} new relevant job${jobs.length === 1 ? "" : "s"} for you`;
  const intro = `Here are new roles from your saved companies with relevance ${settings.minRelevanceScore}/10 or higher.`;
  const textLines = [intro, ""];
  const htmlSections = [];
  for (const [company, companyJobs] of grouped.entries()) {
    textLines.push(company);
    htmlSections.push(`<h2 style="font-size:18px;margin:24px 0 8px;">${escapeHtml(company)}</h2>`);
    for (const job of companyJobs) {
      const reasons = (job.fitReasons || []).slice(0, 2).join("; ");
      textLines.push(`- ${job.title} (${job.location || "Location not listed"})`);
      textLines.push(`  Relevance: ${job.relevanceScore || "?"}/10 · ${job.relevanceBucket || ""}`);
      if (job.description) textLines.push(`  ${cleanText(job.description).slice(0, 260)}`);
      if (reasons) textLines.push(`  Why: ${reasons}`);
      textLines.push(`  ${job.url}`);
      textLines.push("");
      htmlSections.push(`
        <article style="border:1px solid #d6dbe1;border-radius:8px;padding:14px;margin:10px 0;">
          <h3 style="margin:0 0 6px;font-size:16px;">${escapeHtml(job.title)}</h3>
          <p style="margin:0 0 8px;color:#475467;">${escapeHtml(job.location || "Location not listed")} · Relevance ${escapeHtml(job.relevanceScore || "?")}/10 · ${escapeHtml(job.relevanceBucket || "")}</p>
          <p style="margin:0 0 8px;color:#202124;line-height:1.45;">${escapeHtml(cleanText(job.description || "").slice(0, 420))}</p>
          ${reasons ? `<p style="margin:0 0 10px;color:#344054;"><strong>Why it fits:</strong> ${escapeHtml(reasons)}</p>` : ""}
          <a href="${escapeHtml(job.url)}" style="display:inline-block;background:#0f766e;color:#fff;text-decoration:none;border-radius:6px;padding:8px 12px;">Open job</a>
        </article>
      `);
    }
  }
  const html = `
    <div style="font-family:Inter,Arial,sans-serif;color:#202124;max-width:720px;margin:0 auto;">
      <h1 style="font-size:22px;margin:0 0 8px;">${escapeHtml(subject)}</h1>
      <p style="color:#475467;line-height:1.5;">${escapeHtml(intro)}</p>
      ${htmlSections.join("")}
      <p style="color:#667085;font-size:12px;margin-top:24px;">Sent by AI Job Tracker for ${escapeHtml(user.email)}.</p>
    </div>
  `;
  return { subject, text: textLines.join("\n"), html };
}

function resumeRecommendations(profile, resumeText, jobs) {
  const resume = resumeText.toLowerCase();
  const topJobs = jobs.slice(0, 12);
  const topJobText = topJobs.map((job) => `${job.title} ${job.description} ${(job.tags || []).join(" ")}`).join(" ").toLowerCase();
  const missingSkills = profile.skills.filter((skill) => !resume.includes(skill.toLowerCase()));
  const commonJobSkills = profile.skills.filter((skill) => topJobText.includes(skill.toLowerCase()));
  const titleHits = profile.desiredTitles.filter((title) => resume.includes(title.toLowerCase()));
  const recommendations = [];

  if (!resumeText.trim()) {
    recommendations.push({
      title: "Paste your current resume text",
      detail: "The dashboard can compare your resume against your target roles once your resume text is added."
    });
    return recommendations;
  }

  if (missingSkills.length) {
    recommendations.push({
      title: "Add missing target keywords where truthful",
      detail: `Your profile lists ${missingSkills.slice(0, 8).join(", ")} but those words are not visible in the resume text. Add them only where they reflect real experience.`
    });
  }

  if (!titleHits.length && profile.desiredTitles.length) {
    recommendations.push({
      title: "Make the target role obvious near the top",
      detail: `Consider using a headline or summary that directly reflects roles like ${profile.desiredTitles.slice(0, 3).join(", ")}.`
    });
  }

  if (!/\d+%|\$\d+|\d+x|\b\d+\+/.test(resumeText)) {
    recommendations.push({
      title: "Quantify impact",
      detail: "Add metrics such as revenue, time saved, adoption, scale, accuracy, conversion, or team size to make experience easier to evaluate."
    });
  }

  if (commonJobSkills.length) {
    recommendations.push({
      title: "Tailor the skills section to current matches",
      detail: `The strongest current jobs repeatedly point toward ${commonJobSkills.slice(0, 8).join(", ")}. Make sure the most relevant ones are easy to scan.`
    });
  }

  recommendations.push({
    title: "Keep edits specific to each application",
    detail: "For shortlisted jobs, mirror the title, top requirements, and domain language in your summary and first two bullets before applying."
  });

  return recommendations;
}

function getState(user) {
  const store = readStore(user.id);
  const companyScanJobs = annotateJobs(store.companyScanJobs || [], store.profile, store.jobFeedback || {});
  const {
    jobDetailCache,
    lastGoodCompanyScanJobs,
    lastGoodScrapeSummary,
    lastGoodScrapeAt,
    scanRuns,
    ...publicStore
  } = store;
  const publicScanRuns = user.isAdmin ? (scanRuns || []) : sanitizeScannerRuns(scanRuns || []);
  return {
    ...publicStore,
    scanRuns: publicScanRuns,
    emailDigest: normalizeEmailDigest(store.emailDigest || {}, store.emailDigest || {}, user.email),
    emailDigestStatus: emailDigestStatus(store),
    currentUser: user,
    availableCompanies: listCompanyCatalog(user.isAdmin),
    companyRequests: listCompanyRequests(user),
    users: user.isAdmin ? listUsers() : [],
    feedbackEntries: listFeedback(user),
    usage: dailyUsage(user.id),
    jobs: companyScanJobs,
    companyScanJobs,
    jobDetailCacheStats: {
      entries: Object.keys(jobDetailCache || {}).length
    },
    recommendations: resumeRecommendations(store.profile, store.resumeText, companyScanJobs)
  };
}

async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function readRequestBuffer(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function parseMultipartFile(buffer, contentType, fieldName) {
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[1] || contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[2];
  if (!boundary) throw new Error("Upload request is missing a file boundary.");

  const boundaryBuffer = Buffer.from(`--${boundary}`);
  let cursor = buffer.indexOf(boundaryBuffer);
  while (cursor >= 0) {
    const partStart = cursor + boundaryBuffer.length + 2;
    const nextBoundary = buffer.indexOf(boundaryBuffer, partStart);
    if (nextBoundary < 0) break;
    const part = buffer.subarray(partStart, nextBoundary - 2);
    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd < 0) {
      cursor = nextBoundary;
      continue;
    }
    const headers = part.subarray(0, headerEnd).toString("utf8");
    const body = part.subarray(headerEnd + 4);
    const name = headers.match(/name="([^"]+)"/i)?.[1];
    const filename = headers.match(/filename="([^"]*)"/i)?.[1] || "";
    if (name === fieldName && filename) {
      return {
        filename: path.basename(filename).replace(/[^\w.\- ]+/g, "_"),
        contentType: headers.match(/Content-Type:\s*([^\r\n]+)/i)?.[1] || "",
        buffer: body
      };
    }
    cursor = nextBoundary;
  }
  throw new Error("Choose a resume file to upload.");
}

function runCommand(command, args, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Resume extraction timed out."));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"));
      } else {
        reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `${command} failed.`));
      }
    });
  });
}

async function extractResumeText(file) {
  const extension = path.extname(file.filename).toLowerCase();
  if (!file.buffer.length) throw new Error("The uploaded file is empty.");
  if (file.buffer.length > 8 * 1024 * 1024) throw new Error("Resume upload is limited to 8 MB.");

  if ([".txt", ".md", ".text"].includes(extension)) {
    return cleanResumeText(file.buffer.toString("utf8"));
  }

  if ([".doc", ".docx", ".rtf", ".html", ".htm", ".odt"].includes(extension)) {
    const tempDir = await mkdtemp(path.join(tmpdir(), "resume-upload-"));
    const filePath = path.join(tempDir, file.filename);
    try {
      await writeFile(filePath, file.buffer);
      return cleanResumeText(await runCommand("/usr/bin/textutil", ["-convert", "txt", "-stdout", "--", filePath]));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  if (extension === ".pdf") {
    throw new Error("PDF text extraction is not available on this Mac yet. Upload a DOCX/TXT version or paste the resume text.");
  }

  throw new Error("Upload a TXT, MD, DOC, DOCX, RTF, HTML, or ODT resume file.");
}

async function sendEmail({ to, subject, html, text }) {
  const issues = emailConfigIssues();
  const sender = normalizeEmailSender(EMAIL_FROM);
  if (issues.length) {
    throw new Error(`Email is not configured. ${issues.join(" ")}`);
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: sender,
      to: [to],
      ...(EMAIL_REPLY_TO ? { reply_to: EMAIL_REPLY_TO } : {}),
      subject,
      html,
      text
    })
  });
  const raw = await response.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { message: cleanText(raw).slice(0, 300) };
  }
  if (!response.ok) throw new Error(data.message || data.error || `${response.status} ${response.statusText}`);
  return data;
}

async function runEmailDigestForUser(user, { force = false, test = false } = {}) {
  const store = readStore(user.id);
  store.emailDigest = normalizeEmailDigest(store.emailDigest || {}, store.emailDigest || {}, user.email);
  const settings = store.emailDigest;
  if (!test && !force && !shouldRunEmailDigest(settings)) return { skipped: true, reason: "Not scheduled yet." };
  if (!settings.email) throw new Error("Add an email address for the digest.");

  if (test) {
    await sendEmail({
      to: settings.email,
      subject: "AI Job Tracker test email",
      html: `<p>Your AI Job Tracker email digest is connected.</p><p>From: ${escapeHtml(EMAIL_FROM || "not configured")}</p>`,
      text: `Your AI Job Tracker email digest is connected.\nFrom: ${EMAIL_FROM || "not configured"}`
    });
    store.emailDigest.lastDigestStatus = `Test email sent to ${settings.email}.`;
    writeStore(user.id, store);
    return { sent: true, count: 0, test: true };
  }

  const result = await scrapeJobs(store.profile, store.targetCompanies, store.jobFeedback || {}, store.companyScanJobs || [], "email digest", store.resumeText || "", store.jobDetailCache || {}, user.id);
  recordUsage(user.id, "scan", 1);
  recordUsage(user.id, "llm", result.scanRun?.totals?.llmCalls || 0);
  const digestScanJobs = result.companyScanJobs || [];
  applyScanResultToStore(store, result);
  addScanRun(store, result.scanRun);

  const candidates = digestCandidateJobs(digestScanJobs, store, sentJobKeys(user.id));
  if (!candidates.length) {
    store.emailDigest.lastDigestSentAt = new Date().toISOString();
    store.emailDigest.lastDigestStatus = "No new relevant jobs found.";
    writeStore(user.id, store);
    return { sent: false, count: 0 };
  }

  const digestId = `digest-${Date.now().toString(36)}-${randomBytes(5).toString("base64url")}`;
  const message = renderDigestEmail(user, candidates, settings);
  await sendEmail({ to: settings.email, ...message });
  recordEmailDigestSends(user.id, digestId, candidates);
  store.emailDigest.lastDigestSentAt = new Date().toISOString();
  store.emailDigest.lastDigestStatus = `Sent ${candidates.length} job${candidates.length === 1 ? "" : "s"} to ${settings.email}.`;
  writeStore(user.id, store);
  return { sent: true, count: candidates.length };
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

async function maybeDailyScrape() {
  const users = db.prepare("SELECT id FROM users WHERE disabled = 0").all();
  for (const user of users) {
    const store = readStore(user.id);
    if (store.lastScrapeAt && Date.now() - safeDate(store.lastScrapeAt) < ONE_DAY_MS) continue;
    if (!store.targetCompanies?.length) continue;
    const result = await scrapeJobs(store.profile, store.targetCompanies, store.jobFeedback || {}, store.companyScanJobs || [], "daily", store.resumeText || "", store.jobDetailCache || {}, user.id);
    recordUsage(user.id, "scan", 1);
    recordUsage(user.id, "llm", result.scanRun?.totals?.llmCalls || 0);
    applyScanResultToStore(store, result);
    addScanRun(store, result.scanRun);
    writeStore(user.id, store);
  }
}

async function maybeDailyEmailDigests() {
  const users = db.prepare("SELECT id, email, is_admin, disabled, created_at FROM users WHERE disabled = 0").all().map(publicUser);
  for (const user of users) {
    const store = readStore(user.id);
    store.emailDigest = normalizeEmailDigest(store.emailDigest || {}, store.emailDigest || {}, user.email);
    if (!shouldRunEmailDigest(store.emailDigest)) continue;
    try {
      await runEmailDigestForUser(user);
    } catch (error) {
      const latest = readStore(user.id);
      latest.emailDigest = normalizeEmailDigest(latest.emailDigest || {}, latest.emailDigest || {}, user.email);
      latest.emailDigest.lastDigestStatus = `Email failed: ${error.message}`;
      writeStore(user.id, latest);
      console.error(`Email digest failed for ${user.email}:`, error.message);
    }
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "POST" && url.pathname === "/api/login") {
      const body = await parseBody(req);
      const email = String(body.email || "").trim().toLowerCase();
      const userRow = db.prepare("SELECT * FROM users WHERE email = ? AND disabled = 0").get(email);
      if (!userRow || !verifyPassword(body.password || "", userRow.password_hash)) {
        sendJson(res, 401, { error: "Invalid email or password." });
        return;
      }
      const session = createSession(userRow.id);
      res.setHeader("Set-Cookie", cookieHeader("sid", session.id, {
        maxAge: SESSION_DAYS * 24 * 60 * 60,
        secure: req.headers["x-forwarded-proto"] === "https"
      }));
      sendJson(res, 200, { ok: true, user: publicUser(userRow) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/logout") {
      deleteSession(req);
      res.setHeader("Set-Cookie", cookieHeader("sid", "", { maxAge: 0 }));
      sendJson(res, 200, { ok: true });
      return;
    }

    const user = authenticatedUser(req);
    const isPublicAsset = url.pathname === "/login.html" || url.pathname === "/login.js" || url.pathname === "/styles.css";
    if (!user && url.pathname.startsWith("/api/")) {
      sendJson(res, 401, { error: "Sign in required." });
      return;
    }
    if (!user && !isPublicAsset) {
      res.writeHead(302, { Location: "/login.html" });
      res.end();
      return;
    }
    if (user && url.pathname === "/login.html") {
      res.writeHead(302, { Location: "/" });
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      sendJson(res, 200, getState(user));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/llm-status") {
      sendJson(res, 200, await checkOpenAIStatus());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/scanner") {
      sendJson(res, 200, getScannerState(user));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/users") {
      if (!user.isAdmin) {
        sendJson(res, 403, { error: "Only admins can create users." });
        return;
      }
      const body = await parseBody(req);
      createUser(body.email, body.password, Boolean(body.isAdmin));
      sendJson(res, 200, getState(user));
      return;
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/users/")) {
      if (!user.isAdmin) {
        sendJson(res, 403, { error: "Only admins can remove users." });
        return;
      }
      const id = decodeURIComponent(url.pathname.replace("/api/users/", ""));
      deleteUser(id, user.id);
      sendJson(res, 200, getState(user));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/profile") {
      const store = readStore(user.id);
      store.profile = normalizeProfile(await parseBody(req));
      writeStore(user.id, store);
      sendJson(res, 200, getState(user));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/feedback") {
      const body = await parseBody(req);
      createFeedback(user, body.message || body.feedback || "");
      sendJson(res, 200, getState(user));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/company-requests") {
      const body = await parseBody(req);
      createCompanyRequest(user, body);
      sendJson(res, 200, getState(user));
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/company-catalog/") && url.pathname.endsWith("/test")) {
      if (!user.isAdmin) {
        sendJson(res, 403, { error: "Only admins can test company parsers." });
        return;
      }
      const id = decodeURIComponent(url.pathname.replace("/api/company-catalog/", "").replace("/test", ""));
      await testCompanyCatalogCompany(id, user);
      sendJson(res, 200, getState(user));
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/company-requests/") && url.pathname.endsWith("/test")) {
      if (!user.isAdmin) {
        sendJson(res, 403, { error: "Only admins can test company requests." });
        return;
      }
      const id = decodeURIComponent(url.pathname.replace("/api/company-requests/", "").replace("/test", ""));
      await testCompanyRequest(id, user);
      sendJson(res, 200, getState(user));
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/company-requests/") && url.pathname.endsWith("/approve")) {
      if (!user.isAdmin) {
        sendJson(res, 403, { error: "Only admins can approve company requests." });
        return;
      }
      const id = decodeURIComponent(url.pathname.replace("/api/company-requests/", "").replace("/approve", ""));
      approveCompanyRequest(id, user);
      sendJson(res, 200, getState(user));
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/company-requests/") && url.pathname.endsWith("/reject")) {
      if (!user.isAdmin) {
        sendJson(res, 403, { error: "Only admins can reject company requests." });
        return;
      }
      const id = decodeURIComponent(url.pathname.replace("/api/company-requests/", "").replace("/reject", ""));
      const body = await parseBody(req);
      rejectCompanyRequest(id, user, body.adminNotes || body.notes || "");
      sendJson(res, 200, getState(user));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/email-digest/settings") {
      const store = readStore(user.id);
      const body = await parseBody(req);
      store.emailDigest = normalizeEmailDigest(body, store.emailDigest || {}, user.email);
      writeStore(user.id, store);
      sendJson(res, 200, getState(user));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/email-digest/test") {
      await runEmailDigestForUser(user, { test: true });
      sendJson(res, 200, getState(user));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/resume") {
      const store = readStore(user.id);
      const body = await parseBody(req);
      store.resumeText = String(body.resumeText || "");
      writeStore(user.id, store);
      sendJson(res, 200, getState(user));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/resume/upload") {
      const store = readStore(user.id);
      const file = parseMultipartFile(await readRequestBuffer(req), req.headers["content-type"] || "", "resumeFile");
      const resumeText = await extractResumeText(file);
      if (!resumeText) {
        sendJson(res, 400, { error: "I could not find readable text in that resume file." });
        return;
      }
      store.resumeText = resumeText;
      writeStore(user.id, store);
      sendJson(res, 200, {
        ...getState(user),
        resumeUpload: {
          filename: file.filename,
          characters: resumeText.length
        }
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/companies") {
      const store = readStore(user.id);
      const body = await parseBody(req);
      const catalogCompany = findCatalogCompany(body);
      if (!catalogCompany) {
        sendJson(res, 400, { error: "Select an available company. Request a new company if it is not listed." });
        return;
      }
      if (!store.targetCompanies.some((company) => company.id === catalogCompany.id || companyShareKey(company) === companyShareKey(catalogCompany))) {
        store.targetCompanies.push(sharedCompanyBase(catalogCompany));
      }
      writeStore(user.id, store);
      sendJson(res, 200, getState(user));
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/companies/") && url.pathname.endsWith("/reset")) {
      const id = decodeURIComponent(url.pathname.replace("/api/companies/", "").replace("/reset", ""));
      const store = readStore(user.id);
      const company = store.targetCompanies.find((item) => item.id === id);
      if (!company) {
        sendJson(res, 404, { error: "Company not found." });
        return;
      }

      const removedJobs = (store.companyScanJobs || []).filter((job) => job.companyId === id || job.company === company.name);
      const removedJobIds = new Set(removedJobs.map((job) => job.id));
      store.companyScanJobs = (store.companyScanJobs || []).filter((job) => !removedJobIds.has(job.id));
      store.jobs = store.companyScanJobs;
      store.statuses = Object.fromEntries(Object.entries(store.statuses || {}).filter(([jobId]) => !removedJobIds.has(jobId)));
      store.jobFeedback = Object.fromEntries(Object.entries(store.jobFeedback || {}).filter(([jobId]) => !removedJobIds.has(jobId)));
      store.jobDetailCache = Object.fromEntries(Object.entries(store.jobDetailCache || {}).filter(([, entry]) => entry.companyId !== id && entry.company !== company.name));
      store.targetCompanies = store.targetCompanies.map((item) => item.id === id
        ? { ...item, lastFoundCount: 0, lastError: null }
        : item);
      store.lastScrapeSummary = summarizeCurrentCompanyJobs(store);
      writeStore(user.id, store);
      sendJson(res, 200, getState(user));
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/companies/") && url.pathname.endsWith("/scan")) {
      const id = decodeURIComponent(url.pathname.replace("/api/companies/", "").replace("/scan", ""));
      assertCanScan(user.id);
      const store = readStore(user.id);
      const company = store.targetCompanies.find((item) => item.id === id);
      if (!company) {
        sendJson(res, 404, { error: "Company not found." });
        return;
      }

      const result = await scrapeJobs(store.profile, [company], store.jobFeedback || {}, store.companyScanJobs || [], "single company", store.resumeText || "", store.jobDetailCache || {}, user.id);
      recordUsage(user.id, "scan", 1);
      recordUsage(user.id, "llm", result.scanRun?.totals?.llmCalls || 0);
      applyScanResultToStore(store, result);
      addScanRun(store, result.scanRun);
      writeStore(user.id, store);
      sendJson(res, 200, getState(user));
      return;
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/companies/")) {
      const id = decodeURIComponent(url.pathname.replace("/api/companies/", ""));
      const store = readStore(user.id);
      const company = store.targetCompanies.find((item) => item.id === id);
      store.targetCompanies = store.targetCompanies.filter((item) => item.id !== id);
      store.companyScanJobs = (store.companyScanJobs || []).filter((job) => job.companyId !== id && job.company !== company?.name);
      store.jobs = store.companyScanJobs;
      store.lastScrapeSummary = summarizeCurrentCompanyJobs(store);
      writeStore(user.id, store);
      sendJson(res, 200, getState(user));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/scrape") {
      assertCanScan(user.id);
      const store = readStore(user.id);
      const result = await scrapeJobs(store.profile, store.targetCompanies, store.jobFeedback || {}, store.companyScanJobs || [], "manual all", store.resumeText || "", store.jobDetailCache || {}, user.id);
      recordUsage(user.id, "scan", 1);
      recordUsage(user.id, "llm", result.scanRun?.totals?.llmCalls || 0);
      applyScanResultToStore(store, result);
      addScanRun(store, result.scanRun);
      writeStore(user.id, store);
      sendJson(res, 200, getState(user));
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/jobs/")) {
      const isFeedbackRoute = url.pathname.endsWith("/feedback");
      const isViewedRoute = url.pathname.endsWith("/viewed");
      const id = decodeURIComponent(url.pathname.replace("/api/jobs/", "").replace(/\/(feedback|viewed)$/, ""));
      const store = readStore(user.id);
      const body = isViewedRoute ? {} : await parseBody(req);
      store.statuses = store.statuses || {};
      if (isViewedRoute) {
        const existingStatus = store.statuses[id] || {};
        const viewedAt = existingStatus.viewedAt || new Date().toISOString();
        store.statuses[id] = {
          ...existingStatus,
          viewedAt
        };
        writeStore(user.id, store);
        sendJson(res, 200, getState(user));
        return;
      }
      if (isFeedbackRoute) {
        const relevance = body.relevance === "relevant" || body.relevance === "not_relevant" ? body.relevance : null;
        const hasRelevance = Object.prototype.hasOwnProperty.call(body, "relevance");
        const hasManualScore = Object.prototype.hasOwnProperty.call(body, "manualRelevanceScore");
        const manualRelevanceScore = clampRelevanceScore(body.manualRelevanceScore);
        const existingFeedback = store.jobFeedback?.[id] || {};
        const nextFeedback = {
          ...existingFeedback,
          updatedAt: new Date().toISOString()
        };
        if (hasRelevance) {
          if (relevance) nextFeedback.relevance = relevance;
          else delete nextFeedback.relevance;
        }
        if (hasManualScore) {
          if (manualRelevanceScore !== null) nextFeedback.manualRelevanceScore = manualRelevanceScore;
          else delete nextFeedback.manualRelevanceScore;
        }

        const hasAnyFeedback = nextFeedback.relevance || nextFeedback.manualRelevanceScore !== undefined;
        store.jobFeedback = { ...(store.jobFeedback || {}) };
        if (hasAnyFeedback) {
          store.jobFeedback[id] = nextFeedback;
        } else {
          delete store.jobFeedback[id];
        }
        store.companyScanJobs = annotateJobs(store.companyScanJobs || [], store.profile, store.jobFeedback || {});
        store.jobs = store.companyScanJobs;
        writeStore(user.id, store);
        sendJson(res, 200, getState(user));
        return;
      }
      const nextStatus = body.status || "new";
      if (nextStatus === "shortlisted") {
        const job = (store.companyScanJobs || store.jobs || []).find((item) => item.id === id);
        if (job && !jobLocationMatchesProfile(job, store.profile || {})) {
          sendJson(res, 400, { error: "This job does not match your profile location, so it cannot be shortlisted." });
          return;
        }
      }
      const now = new Date().toISOString();
      const existingStatus = store.statuses[id] || {};
      const nextEntry = {
        ...existingStatus,
        status: nextStatus,
        notes: String(body.notes || existingStatus.notes || ""),
        viewedAt: existingStatus.viewedAt || now,
        updatedAt: now
      };
      if (nextStatus === "new") delete nextEntry.status;
      if (nextEntry.status || nextEntry.viewedAt || nextEntry.notes) store.statuses[id] = nextEntry;
      else delete store.statuses[id];
      writeStore(user.id, store);
      sendJson(res, 200, getState(user));
      return;
    }

    await serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Stop the existing dashboard process, then run npm start again.`);
    console.error(`On macOS, you can find it with: lsof -nP -iTCP:${PORT} -sTCP:LISTEN`);
    console.error(`Or start this dashboard on another port with: PORT=4174 npm start`);
    process.exit(1);
  }
  if (error.code === "EPERM") {
    console.error(`Could not listen on http://${HOST}:${PORT}. Stop the existing dashboard process, then run npm start again.`);
    console.error(`On macOS, you can find it with: lsof -nP -iTCP:${PORT} -sTCP:LISTEN`);
    process.exit(1);
  }
  throw error;
});

server.listen(PORT, HOST, () => {
  console.log(`Job dashboard running at http://${HOST}:${PORT}`);
  maybeDailyScrape().catch((error) => console.error("Daily scrape failed:", error.message));
  maybeDailyEmailDigests().catch((error) => console.error("Email digest check failed:", error.message));
  setInterval(() => maybeDailyScrape().catch((error) => console.error("Daily scrape failed:", error.message)), 60 * 60 * 1000);
  setInterval(() => maybeDailyEmailDigests().catch((error) => console.error("Email digest check failed:", error.message)), 60 * 60 * 1000);
});
