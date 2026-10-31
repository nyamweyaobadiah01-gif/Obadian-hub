const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { once } = require("node:events");
const { DatabaseSync } = require("node:sqlite");
const { PDFParse } = require("pdf-parse");

const scrypt = promisify(crypto.scrypt);
const ROOT = __dirname;
const ENV_FILE = path.join(ROOT, ".env");
if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIRECTORY = process.env.DATA_DIRECTORY ? path.resolve(process.env.DATA_DIRECTORY) : path.join(ROOT, "data");
const DATABASE_FILE = path.join(DATA_DIRECTORY, "obadian-hub.sqlite");
const USERS_FILE = path.join(DATA_DIRECTORY, "users.json");
const HUB_FILE = path.join(DATA_DIRECTORY, "hub.json");
const UPLOAD_DIRECTORY = path.join(DATA_DIRECTORY, "uploads");
const SESSION_COOKIE = "obadian_session";
const ADMIN_SESSION_COOKIE = "obadian_admin";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const BODY_LIMIT = 16 * 1024;
const MAX_TIMETABLE_PDF_BYTES = 10 * 1024 * 1024;
const MAX_TIMETABLE_BODY_BYTES = 14 * 1024 * 1024;
const MAX_TIMETABLE_CONFIRM_BODY_BYTES = 256 * 1024;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const STORAGE_QUOTA_BYTES = 500 * 1024 * 1024;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT = 10;
const WORKSPACE_RATE_LIMIT = 180;
const AGREEMENT_VERSION = "2026-10-28";
const SCHEDULE_CATEGORIES = new Set(["Class", "Study", "Exam", "Assignment", "Personal", "General"]);
const SCHEDULE_REPEATS = new Set(["none", "daily", "weekly", "monthly"]);
const ATTENDANCE_STATUSES = new Set(["present", "absent", "late", "excused"]);
const FILE_TYPES = new Map([
  [".pdf", { mime: "application/pdf", signature: (buffer) => buffer.subarray(0, 5).toString() === "%PDF-" }],
  [".txt", { mime: "text/plain", signature: (buffer) => !buffer.subarray(0, 4096).includes(0) }],
  [".jpg", { mime: "image/jpeg", signature: (buffer) => buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff }],
  [".jpeg", { mime: "image/jpeg", signature: (buffer) => buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff }],
  [".png", { mime: "image/png", signature: (buffer) => buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) }],
  [".gif", { mime: "image/gif", signature: (buffer) => ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString()) }],
  [".webp", { mime: "image/webp", signature: (buffer) => buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WEBP" }],
  [".mp4", { mime: "video/mp4", signature: (buffer) => buffer.subarray(4, 8).toString() === "ftyp" }],
  [".webm", { mime: "video/webm", signature: (buffer) => buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) }],
  [".mov", { mime: "video/quicktime", signature: (buffer) => buffer.subarray(4, 8).toString() === "ftyp" }],
  [".doc", { mime: "application/msword", signature: (buffer) => buffer.subarray(0, 4).toString() === "\xd0\xcf\x11\xe0" }],
  [".docx", { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", signature: (buffer) => buffer.subarray(0, 2).toString() === "PK" }],
  [".ppt", { mime: "application/vnd.ms-powerpoint", signature: (buffer) => buffer.subarray(0, 4).toString() === "\xd0\xcf\x11\xe0" }],
  [".pptx", { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", signature: (buffer) => buffer.subarray(0, 2).toString() === "PK" }]
]);

const users = new Map();
const sessions = new Map();
const adminSessions = new Map();
const rateLimits = new Map();
let db;
let lastEmailSend = { status: "not sent", sentAt: null };
const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/admin", ["admin.html", "text/html; charset=utf-8"]],
  ["/admin.html", ["admin.html", "text/html; charset=utf-8"]],
  ["/admin.js", ["admin.js", "text/javascript; charset=utf-8"]],
  ["/policies", ["policies.html", "text/html; charset=utf-8"]],
  ["/policies.html", ["policies.html", "text/html; charset=utf-8"]]
]);

function initializeDatabase() {
  fs.mkdirSync(DATA_DIRECTORY, { recursive: true });
  db = new DatabaseSync(DATABASE_FILE);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT,
      agreement_version TEXT,
      agreement_accepted_at TEXT,
      profile_name TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      school TEXT NOT NULL DEFAULT '',
      email_verified INTEGER NOT NULL DEFAULT 1,
      approved INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS academic_settings (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      academic_year TEXT NOT NULL DEFAULT '',
      semester TEXT NOT NULL DEFAULT '',
      year_of_study INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS units (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      title TEXT NOT NULL,
      instructor TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS units_user_code ON units(user_id, code COLLATE NOCASE);
    CREATE TABLE IF NOT EXISTS attendance_records (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      unit_id TEXT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
      session_date TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('present', 'absent', 'late', 'excused')),
      notes TEXT NOT NULL DEFAULT '',
      academic_year TEXT NOT NULL DEFAULT '',
      semester TEXT NOT NULL DEFAULT '',
      year_of_study INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS attendance_user_date ON attendance_records(user_id, session_date);
    CREATE TABLE IF NOT EXISTS class_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      unit_id TEXT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
      day_of_week INTEGER,
      start_time TEXT NOT NULL DEFAULT '',
      end_time TEXT NOT NULL DEFAULT '',
      venue TEXT NOT NULL DEFAULT '',
      lecturer TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS class_sessions_user_day ON class_sessions(user_id, day_of_week, start_time);
    CREATE TABLE IF NOT EXISTS exam_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      unit_id TEXT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
      exam_date TEXT,
      exam_time TEXT NOT NULL DEFAULT '',
      exam_datetime TEXT,
      venue TEXT NOT NULL DEFAULT '',
      duration INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS exam_sessions_user_datetime ON exam_sessions(user_id, exam_datetime);
    CREATE TABLE IF NOT EXISTS schedule (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      unit_id TEXT REFERENCES units(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      date TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'General',
      repeat TEXT NOT NULL DEFAULT 'none',
      reminder_minutes INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS schedule_user_date ON schedule(user_id, date);
    CREATE TABLE IF NOT EXISTS schedule_completions (
      schedule_id TEXT NOT NULL REFERENCES schedule(id) ON DELETE CASCADE,
      occurrence_date TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      PRIMARY KEY (schedule_id, occurrence_date)
    );
    CREATE TABLE IF NOT EXISTS account_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('verify', 'reset')),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS account_tokens_user_type ON account_tokens(user_id, type);
    CREATE TABLE IF NOT EXISTS profile_avatars (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      mime TEXT NOT NULL,
      content BLOB NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      folder TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      opened_at TEXT,
      content BLOB
    );
    CREATE INDEX IF NOT EXISTS files_user_created ON files(user_id, created_at);
    CREATE TABLE IF NOT EXISTS inbox (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      sender TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS inbox_user_created ON inbox(user_id, created_at);
    CREATE TABLE IF NOT EXISTS activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      action TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admin_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_email TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS admin_audit_created ON admin_audit(created_at DESC);
    CREATE TABLE IF NOT EXISTS admin_signins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_email TEXT NOT NULL,
      ip_address TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS support_status (
      inbox_id TEXT PRIMARY KEY REFERENCES inbox(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'unread' CHECK(status IN ('unread', 'open', 'resolved')),
      first_reply_at TEXT,
      resolved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS admin_announcements (
      id TEXT PRIMARY KEY,
      audience TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL,
      scheduled_at TEXT NOT NULL,
      sent_at TEXT,
      status TEXT NOT NULL DEFAULT 'scheduled',
      error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS master_courses (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE
    );
    CREATE TABLE IF NOT EXISTS master_units (
      id TEXT PRIMARY KEY,
      course_id TEXT NOT NULL REFERENCES master_courses(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      year_of_study INTEGER NOT NULL,
      semester TEXT NOT NULL,
      credit_hours REAL NOT NULL DEFAULT 0,
      UNIQUE(course_id, code, year_of_study, semester)
    );
    CREATE TABLE IF NOT EXISTS academic_calendar (
      id TEXT PRIMARY KEY,
      course_id TEXT REFERENCES master_courses(id) ON DELETE CASCADE,
      year_of_study INTEGER,
      semester TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      type TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS grading_scales (
      id TEXT PRIMARY KEY,
      course_id TEXT REFERENCES master_courses(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      minimum_score REAL NOT NULL,
      maximum_score REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS policy_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      terms_version TEXT NOT NULL,
      privacy_version TEXT NOT NULL,
      published_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admin_runtime_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      completed_at TEXT NOT NULL
    );
  `);
  const columns = db.prepare("PRAGMA table_info(users)").all().map((column) => column.name);
  for (const [name, definition] of [
    ["profile_name", "TEXT NOT NULL DEFAULT ''"],
    ["phone", "TEXT NOT NULL DEFAULT ''"],
    ["school", "TEXT NOT NULL DEFAULT ''"],
    ["email_verified", "INTEGER NOT NULL DEFAULT 1"],
    ["approved", "INTEGER NOT NULL DEFAULT 1"],
    ["course", "TEXT NOT NULL DEFAULT ''"],
    ["suspended", "INTEGER NOT NULL DEFAULT 0"],
    ["storage_quota_bytes", `INTEGER NOT NULL DEFAULT ${STORAGE_QUOTA_BYTES}`]
  ]) {
    if (!columns.includes(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
  }
  const scheduleColumns = db.prepare("PRAGMA table_info(schedule)").all().map((column) => column.name);
  if (!scheduleColumns.includes("unit_id")) db.exec("ALTER TABLE schedule ADD COLUMN unit_id TEXT REFERENCES units(id) ON DELETE SET NULL");
  const academicColumns = db.prepare("PRAGMA table_info(academic_settings)").all().map((column) => column.name);
  if (!academicColumns.includes("year_of_study")) db.exec("ALTER TABLE academic_settings ADD COLUMN year_of_study INTEGER NOT NULL DEFAULT 0");
  for (const [name, definition] of [
    ["category", "TEXT NOT NULL DEFAULT 'General'"],
    ["repeat", "TEXT NOT NULL DEFAULT 'none'"],
    ["reminder_minutes", "INTEGER NOT NULL DEFAULT 0"]
  ]) {
    if (!scheduleColumns.includes(name)) db.exec(`ALTER TABLE schedule ADD COLUMN ${name} ${definition}`);
  }
  const fileColumns = db.prepare("PRAGMA table_info(files)").all().map((column) => column.name);
  if (!fileColumns.includes("opened_at")) db.exec("ALTER TABLE files ADD COLUMN opened_at TEXT");
  const announcementColumns = db.prepare("PRAGMA table_info(admin_announcements)").all().map((column) => column.name);
  if (!announcementColumns.includes("status")) db.exec("ALTER TABLE admin_announcements ADD COLUMN status TEXT NOT NULL DEFAULT 'scheduled'");
  if (!announcementColumns.includes("error")) db.exec("ALTER TABLE admin_announcements ADD COLUMN error TEXT NOT NULL DEFAULT ''");
  migrateLegacyJson();
  for (const row of db.prepare("SELECT * FROM users").all()) {
    const user = userFromRow(row);
    users.set(user.email, user);
  }
  const emailStatus = db.prepare("SELECT value, updated_at AS updatedAt FROM admin_runtime_state WHERE key = 'last_email_send'").get();
  if (emailStatus) lastEmailSend = { status: emailStatus.value, sentAt: emailStatus.updatedAt };
}

function userFromRow(row) {
  return {
    id: row.id,
    email: row.email,
    salt: row.salt,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    agreementVersion: row.agreement_version,
    agreementAcceptedAt: row.agreement_accepted_at,
    profileName: row.profile_name || "",
    phone: row.phone || "",
    school: row.school || "",
    course: row.course || "",
    suspended: Boolean(row.suspended),
    storageQuotaBytes: Number(row.storage_quota_bytes) || STORAGE_QUOTA_BYTES,
    emailVerified: Boolean(row.email_verified),
    approved: Boolean(row.approved)
  };
}

function migrateLegacyJson() {
  const userCount = db.prepare("SELECT COUNT(*) AS count FROM users").get().count;
  const insertUser = db.prepare(`INSERT OR IGNORE INTO users
    (id, email, salt, password_hash, created_at, agreement_version, agreement_accepted_at, profile_name, phone, school)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  if (userCount === 0 && fs.existsSync(USERS_FILE)) {
    const storedUsers = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
    if (!Array.isArray(storedUsers)) throw new Error("Legacy user database must contain a JSON array.");
    for (const user of storedUsers) {
      if (!user || typeof user.id !== "string" || typeof user.email !== "string"
        || typeof user.salt !== "string" || typeof user.passwordHash !== "string") {
        throw new Error("Legacy user database contains an invalid user record.");
      }
      insertUser.run(user.id, user.email, user.salt, user.passwordHash, user.createdAt || null,
        user.agreementVersion || null, user.agreementAcceptedAt || null, user.profileName || "", user.phone || "", user.school || "");
    }
  }
  if (db.prepare("SELECT name FROM schema_migrations WHERE name = 'legacy_json'").get()
    || !fs.existsSync(HUB_FILE)) return;
  const storedHub = JSON.parse(fs.readFileSync(HUB_FILE, "utf8"));
  if (!storedHub || typeof storedHub.workspaces !== "object" || !Array.isArray(storedHub.activity)) {
    throw new Error("Legacy workspace database contains invalid data.");
  }
  const insertSchedule = db.prepare("INSERT OR IGNORE INTO schedule (id, user_id, title, date, details) VALUES (?, ?, ?, ?, ?)");
  const insertFile = db.prepare("INSERT OR IGNORE INTO files (id, user_id, name, mime, size, folder, created_at, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const insertInbox = db.prepare("INSERT OR IGNORE INTO inbox (id, user_id, type, sender, text, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  for (const [userId, workspace] of Object.entries(storedHub.workspaces)) {
    if (!db.prepare("SELECT id FROM users WHERE id = ?").get(userId)) continue;
    for (const item of workspace.schedule || []) {
      insertSchedule.run(item.id, userId, item.title, item.date, item.details || "");
    }
    for (const item of workspace.files || []) {
      const oldPath = path.join(UPLOAD_DIRECTORY, item.id);
      const content = fs.existsSync(oldPath) ? fs.readFileSync(oldPath) : null;
      insertFile.run(item.id, userId, item.name, item.mime, item.size, item.folder || "", item.createdAt, content);
    }
    for (const item of workspace.inbox || []) {
      insertInbox.run(item.id, userId, item.type, item.sender || "user", item.text, item.createdAt);
    }
  }
  const insertActivity = db.prepare("INSERT INTO activity (email, action, created_at) VALUES (?, ?, ?)");
  for (const item of storedHub.activity) insertActivity.run(item.email, item.action, item.createdAt);
  db.prepare("INSERT INTO schema_migrations (name, completed_at) VALUES ('legacy_json', ?)").run(new Date().toISOString());
}

function getWorkspace(userId) {
  const schedule = db.prepare(`SELECT id, unit_id AS unitId, title, date, details, category, repeat,
      reminder_minutes AS reminderMinutes
    FROM schedule WHERE user_id = ? ORDER BY date`).all(userId);
  const completedOccurrences = db.prepare(`SELECT schedule_id AS scheduleId, occurrence_date AS occurrenceDate
    FROM schedule_completions
    WHERE schedule_id IN (SELECT id FROM schedule WHERE user_id = ?)`).all(userId);
  const completedById = new Map();
  for (const occurrence of completedOccurrences) {
    const dates = completedById.get(occurrence.scheduleId) || [];
    dates.push(occurrence.occurrenceDate);
    completedById.set(occurrence.scheduleId, dates);
  }
  for (const item of schedule) item.completedDates = completedById.get(item.id) || [];
  const storageUsedBytes = db.prepare("SELECT COALESCE(SUM(size), 0) AS total FROM files WHERE user_id = ?").get(userId).total;
  return {
    schedule,
    units: db.prepare("SELECT id, code, title, instructor FROM units WHERE user_id = ? ORDER BY code COLLATE NOCASE").all(userId),
    academicSettings: db.prepare(`SELECT academic_year AS academicYear, semester, year_of_study AS yearOfStudy
      FROM academic_settings WHERE user_id = ?`).get(userId) || { academicYear: "", semester: "", yearOfStudy: 0 },
    attendance: db.prepare(`SELECT id, unit_id AS unitId, session_date AS sessionDate, status, notes,
      academic_year AS academicYear, semester, year_of_study AS yearOfStudy
      FROM attendance_records WHERE user_id = ? ORDER BY session_date DESC, created_at DESC`).all(userId),
    classSessions: db.prepare(`SELECT id, unit_id AS unitId, day_of_week AS dayOfWeek,
      start_time AS startTime, end_time AS endTime, venue, lecturer
      FROM class_sessions WHERE user_id = ? ORDER BY day_of_week, start_time`).all(userId),
    examSessions: db.prepare(`SELECT id, unit_id AS unitId, exam_date AS examDate,
      exam_time AS examTime, exam_datetime AS examDateTime, venue, duration
      FROM exam_sessions WHERE user_id = ? ORDER BY exam_datetime, exam_date`).all(userId),
    files: db.prepare(`SELECT id, name, mime, size, folder, created_at AS createdAt, opened_at AS openedAt
      FROM files WHERE user_id = ? ORDER BY created_at DESC`).all(userId),
    inbox: db.prepare("SELECT id, type, sender, text, created_at AS createdAt FROM inbox WHERE user_id = ? ORDER BY created_at DESC").all(userId),
    storageUsedBytes
  };
}

async function writeResponseChunk(response, chunk) {
  if (!response.write(chunk)) await once(response, "drain");
}

async function handleStudentDataExport(response, user) {
  recordActivity(user, "Downloaded a copy of account data");
  const account = db.prepare(`SELECT id, agreement_version AS agreementVersion,
      agreement_accepted_at AS agreementAcceptedAt, storage_quota_bytes AS storageQuotaBytes
    FROM users WHERE id = ?`).get(user.id);
  const avatar = db.prepare("SELECT mime, content FROM profile_avatars WHERE user_id = ?").get(user.id);
  const workspace = getWorkspace(user.id);
  const exportedData = {
    exportedAt: new Date().toISOString(),
    profile: { id: account.id, ...publicUser(user), agreementVersion: account.agreementVersion,
      agreementAcceptedAt: account.agreementAcceptedAt, storageQuotaBytes: account.storageQuotaBytes },
    academicSettings: workspace.academicSettings,
    units: workspace.units,
    attendance: workspace.attendance,
    classSessions: workspace.classSessions,
    examSessions: workspace.examSessions,
    schedule: workspace.schedule,
    profilePhoto: avatar ? { mime: avatar.mime, contentBase64: Buffer.from(avatar.content).toString("base64") } : null,
    inbox: workspace.inbox,
    activity: db.prepare("SELECT action, created_at AS createdAt FROM activity WHERE email = ? ORDER BY id")
      .all(user.email),
    storageUsedBytes: workspace.storageUsedBytes
  };
  response.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Disposition": 'attachment; filename="obadian-hub-data.json"',
    "Cache-Control": "no-store"
  });
  await writeResponseChunk(response, `${JSON.stringify(exportedData).slice(0, -1)},"files":[`);
  const fileRows = db.prepare(`SELECT id, name, mime, size, folder, created_at AS createdAt,
      opened_at AS openedAt, content FROM files WHERE user_id = ? ORDER BY created_at DESC`).iterate(user.id);
  let first = true;
  for (const { content, ...file } of fileRows) {
    if (!first) await writeResponseChunk(response, ",");
    await writeResponseChunk(response, JSON.stringify({
      ...file,
      contentBase64: content ? Buffer.from(content).toString("base64") : null
    }));
    first = false;
  }
  await writeResponseChunk(response, "]}");
  response.end();
}

function recordActivity(user, action) {
  db.prepare("INSERT INTO activity (email, action, created_at) VALUES (?, ?, ?)").run(user.email, action, new Date().toISOString());
  db.prepare("DELETE FROM activity WHERE id NOT IN (SELECT id FROM activity ORDER BY id DESC LIMIT 200)").run();
}

function recordInbox(userId, item) {
  const inboxItem = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...item };
  db.prepare("INSERT INTO inbox (id, user_id, type, sender, text, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(inboxItem.id, userId, inboxItem.type, inboxItem.sender, inboxItem.text, inboxItem.createdAt);
  db.prepare("DELETE FROM inbox WHERE user_id = ? AND id NOT IN (SELECT id FROM inbox WHERE user_id = ? ORDER BY created_at DESC LIMIT 200)")
    .run(userId, userId);
}

function saveUser(user) {
  db.prepare(`INSERT INTO users
    (id, email, salt, password_hash, created_at, agreement_version, agreement_accepted_at, profile_name, phone, school, email_verified, approved, course, suspended, storage_quota_bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET email=excluded.email, salt=excluded.salt, password_hash=excluded.password_hash,
    created_at=excluded.created_at, agreement_version=excluded.agreement_version,
    agreement_accepted_at=excluded.agreement_accepted_at, profile_name=excluded.profile_name,
    phone=excluded.phone, school=excluded.school, email_verified=excluded.email_verified, approved=excluded.approved,
    course=excluded.course, suspended=excluded.suspended, storage_quota_bytes=excluded.storage_quota_bytes`)
    .run(user.id, user.email, user.salt, user.passwordHash, user.createdAt || null, user.agreementVersion || null,
      user.agreementAcceptedAt || null, user.profileName || "", user.phone || "", user.school || "", Number(user.emailVerified),
      Number(Boolean(user.approved)), user.course || "", Number(Boolean(user.suspended)), user.storageQuotaBytes || STORAGE_QUOTA_BYTES);
}

function setSecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
}

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  response.end(JSON.stringify(payload));
}

function readJson(request, maxBytes = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const contentType = request.headers["content-type"] || "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      reject(Object.assign(new Error("Send this request as JSON."), { status: 415 }));
      request.resume();
      return;
    }
    let body = "";
    let oversized = false;
    request.on("data", (chunk) => {
      if (oversized) return;
      body += chunk;
      if (Buffer.byteLength(body) > maxBytes) {
        oversized = true;
        reject(Object.assign(new Error("Request is too large."), { status: 413 }));
      }
    });
    request.on("end", () => {
      if (oversized) return;
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(Object.assign(new Error("Request body must be valid JSON."), { status: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function readCookies(request) {
  const cookies = new Map();
  for (const part of (request.headers.cookie || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0) cookies.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  return cookies;
}

function cookieOptions() {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `Path=/; HttpOnly; SameSite=Strict${secure}`;
}

function expireSession(response, cookieName = SESSION_COOKIE) {
  response.setHeader("Set-Cookie", `${cookieName}=; ${cookieOptions()}; Max-Age=0`);
}

function getUserForRequest(request) {
  const token = readCookies(request).get(SESSION_COOKIE);
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  const user = [...users.values()].find((account) => account.id === session.userId) || null;
  if (user?.suspended) {
    sessions.delete(token);
    return null;
  }
  return user;
}

function publicUser(user) {
  return {
    email: user.email,
    createdAt: user.createdAt,
    profileName: user.profileName || "",
    phone: user.phone || "",
    school: user.school || "",
    course: user.course || "",
    emailVerified: user.emailVerified !== false,
    hasAvatar: Boolean(db.prepare("SELECT 1 FROM profile_avatars WHERE user_id = ?").get(user.id))
  };
}

function emailDeliveryConfigured() {
  return typeof process.env.RESEND_API_KEY === "string" && process.env.RESEND_API_KEY.trim().length > 0
    && typeof process.env.RESEND_FROM_EMAIL === "string" && process.env.RESEND_FROM_EMAIL.trim().length > 0;
}

function getPublicBaseUrl() {
  const configured = process.env.PUBLIC_BASE_URL || `http://${HOST}:${PORT}`;
  let base;
  try {
    base = new URL(configured);
  } catch {
    throw new Error("PUBLIC_BASE_URL must be a valid HTTP or HTTPS URL.");
  }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password
    || (process.env.NODE_ENV === "production" && base.protocol !== "https:")) {
    throw new Error("PUBLIC_BASE_URL must be an HTTPS URL in production.");
  }
  return base;
}

function createAccountToken(user, type) {
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  db.prepare("DELETE FROM account_tokens WHERE expires_at <= ?").run(now.toISOString());
  db.prepare("DELETE FROM account_tokens WHERE user_id = ? AND type = ?").run(user.id, type);
  db.prepare(`INSERT INTO account_tokens (token_hash, user_id, type, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)`).run(tokenHash, user.id, type, expiresAt, now.toISOString());
  return token;
}

function updateEmailStatus(status) {
  const now = new Date();
  const previousAttempt = Date.parse(lastEmailSend.sentAt || "");
  if (Number.isFinite(previousAttempt) && now.getTime() <= previousAttempt) now.setTime(previousAttempt + 1);
  lastEmailSend = { status, sentAt: now.toISOString() };
  db.prepare(`INSERT INTO admin_runtime_state (key, value, updated_at) VALUES ('last_email_send', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(lastEmailSend.status, lastEmailSend.sentAt);
}

async function sendAccountEmail(user, type, token) {
  let failurePrefix = "";
  let failureDetail = "";
  try {
    if (!emailDeliveryConfigured()) {
      throw new Error("Email delivery is not configured. Set RESEND_API_KEY and RESEND_FROM_EMAIL before using email verification or password recovery.");
    }
    const baseUrl = getPublicBaseUrl();
    const link = new URL("/", baseUrl);
    link.searchParams.set(type === "verify" ? "verify" : "reset", token);
    const verification = type === "verify";
    const subject = verification ? "Verify your Obadian Hub email" : "Reset your Obadian Hub password";
    const action = verification ? "Verify email address" : "Choose a new password";
    const description = verification
      ? "Confirm your email address to activate your Obadian Hub account."
      : "Use the secure link below to choose a new password for your Obadian Hub account.";
    let response;
    try {
      response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY.trim()}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from: process.env.RESEND_FROM_EMAIL.trim(),
          to: [user.email],
          subject,
          html: `<p>${description}</p><p><a href="${link.toString()}">${action}</a></p><p>This link expires in one hour. If you did not request this, you can ignore this email.</p>`
        })
      });
    } catch (error) {
      failurePrefix = "Email provider network request failed";
      failureDetail = error instanceof Error ? error.message : "Network request failed";
      throw new Error("The email provider could not be reached. Check the network connection and try again.");
    }
    if (!response.ok) {
      failurePrefix = `Email provider returned HTTP ${response.status}`;
      const responseText = await response.text();
      console.error(`Resend rejected an account email (${response.status}): ${responseText.slice(0, 500)}`);
      throw new Error("The email provider could not deliver the message. Check the Resend API key and verified sender address.");
    }
    updateEmailStatus("sent");
  } catch (error) {
    const message = failureDetail || (error instanceof Error ? error.message : "Unknown email delivery error");
    updateEmailStatus(`failed: ${failurePrefix ? `${failurePrefix}: ` : ""}${message.slice(0, 400)}`);
    throw error;
  }
}

function verifyPassword(password, user) {
  return scrypt(password, user.salt, 64).then((attemptedHash) => {
    const storedHash = Buffer.from(user.passwordHash, "hex");
    return storedHash.length === attemptedHash.length && crypto.timingSafeEqual(storedHash, attemptedHash);
  });
}

function issueSession(response, user, rememberMe = false) {
  const token = crypto.randomBytes(32).toString("base64url");
  const ttl = rememberMe ? SESSION_TTL_MS : SESSION_DEFAULT_TTL_MS;
  sessions.set(token, { userId: user.id, expiresAt: Date.now() + ttl });
  const maxAge = rememberMe ? `; Max-Age=${SESSION_TTL_MS / 1000}` : "";
  response.setHeader("Set-Cookie", `${SESSION_COOKIE}=${token}; ${cookieOptions()}${maxAge}`);
}

function hasAdminCredentials() {
  return typeof process.env.ADMIN_EMAIL === "string"
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(process.env.ADMIN_EMAIL.trim())
    && typeof process.env.ADMIN_PASSWORD === "string"
    && process.env.ADMIN_PASSWORD.length >= 16;
}

function getAdminForRequest(request) {
  const token = readCookies(request).get(ADMIN_SESSION_COOKIE);
  if (!token) return null;
  const session = adminSessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    adminSessions.delete(token);
    return null;
  }
  return session;
}

function issueAdminSession(response) {
  const token = crypto.randomBytes(32).toString("base64url");
  adminSessions.set(token, { expiresAt: Date.now() + ADMIN_SESSION_TTL_MS });
  response.setHeader("Set-Cookie", `${ADMIN_SESSION_COOKIE}=${token}; ${cookieOptions()}; Max-Age=${ADMIN_SESSION_TTL_MS / 1000}`);
}

function checkRateLimit(request, response, scope = "account", maxAttempts = RATE_LIMIT) {
  const key = `${scope}:${request.socket.remoteAddress || "unknown"}`;
  const now = Date.now();
  let record = rateLimits.get(key);
  if (!record || record.resetAt <= now) {
    record = { count: 0, resetAt: now + RATE_WINDOW_MS };
  }
  record.count += 1;
  rateLimits.set(key, record);
  if (rateLimits.size > 1000) {
    for (const [address, limit] of rateLimits) {
      if (limit.resetAt <= now) rateLimits.delete(address);
    }
  }
  if (record.count > maxAttempts) {
    sendJson(response, 429, { error: "Too many attempts. Please wait a little while and try again." }, {
      "Retry-After": String(Math.max(1, Math.ceil((record.resetAt - now) / 1000)))
    });
    return false;
  }
  return true;
}

function validateCredentials(payload) {
  if (!payload || typeof payload.email !== "string" || typeof payload.password !== "string") {
    return "Enter an email address and password.";
  }
  const email = payload.email.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return "Enter a valid email address.";
  }
  if (payload.password.length < 10 || payload.password.length > 128) {
    return "Your password must be between 10 and 128 characters.";
  }
  return null;
}

async function handleRegister(request, response) {
  if (!checkRateLimit(request, response)) return;
  const payload = await readJson(request);
  const validationError = validateCredentials(payload);
  if (validationError) return sendJson(response, 400, { error: validationError });
  if (payload.agreeToPolicies !== true) {
    return sendJson(response, 400, { error: "Please agree to the Terms of Service and Privacy Policy before creating an account." });
  }
  const email = payload.email.trim().toLowerCase();
  if (users.has(email)) return sendJson(response, 409, { error: "An account with that email already exists. Try signing in instead." });

  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = (await scrypt(payload.password, salt, 64)).toString("hex");
  const user = {
    id: crypto.randomUUID(),
    email,
    salt,
    passwordHash,
    createdAt: new Date().toISOString(),
    agreementVersion: AGREEMENT_VERSION,
    agreementAcceptedAt: new Date().toISOString(),
    profileName: "",
    phone: "",
    school: "",
    course: "",
    emailVerified: false,
    approved: false
  };
  users.set(email, user);
  try {
    saveUser(user);
  } catch (error) {
    users.delete(email);
    throw error;
  }
  recordActivity(user, "Created an account and requested administrator approval");
  return sendJson(response, 201, { approvalRequired: true });
}

async function handleLogin(request, response) {
  if (!checkRateLimit(request, response)) return;
  const payload = await readJson(request);
  if (!payload || typeof payload.email !== "string" || typeof payload.password !== "string") {
    return sendJson(response, 400, { error: "Enter an email address and password." });
  }
  const email = payload.email.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    || payload.password.length < 1 || payload.password.length > 128) {
    return sendJson(response, 400, { error: "Check your email address and password, then try again." });
  }
  const user = users.get(email);
  if (!user) return sendJson(response, 401, { error: "That email and password combination was not found." });

  if (!await verifyPassword(payload.password, user)) {
    return sendJson(response, 401, { error: "That email and password combination was not found." });
  }
  if (user.suspended) return sendJson(response, 403, { error: "This account is suspended. Contact Obadian Hub support." });
  if (!user.approved) return sendJson(response, 403, { error: "Your account is waiting for administrator approval. Please try again later." });
  if (!user.emailVerified) {
    return sendJson(response, 403, { error: "Verify your email address before signing in. Use Resend verification to get a new link." });
  }
  issueSession(response, user, payload.rememberMe === true);
  recordActivity(user, "Signed in");
  return sendJson(response, 200, { user: publicUser(user) });
}

async function handleResendVerification(request, response) {
  if (!checkRateLimit(request, response, "email-actions", 4)) return;
  const payload = await readJson(request);
  if (!payload || typeof payload.email !== "string" || payload.email.length > 254) {
    return sendJson(response, 400, { error: "Enter the email address used for your account." });
  }
  if (!emailDeliveryConfigured()) {
    return sendJson(response, 503, { error: "Email delivery is not configured. Set RESEND_API_KEY and RESEND_FROM_EMAIL, then restart the app." });
  }
  const email = payload.email.trim().toLowerCase();
  const user = users.get(email);
  if (!user || user.emailVerified) return sendJson(response, 200, { success: true });
  try {
    const token = createAccountToken(user, "verify");
    await sendAccountEmail(user, "verify", token);
  } catch (error) {
    console.error("Verification email resend failed:", error.message);
    return sendJson(response, 502, { error: "The verification email could not be sent. Check the Resend sender configuration and try again." });
  }
  return sendJson(response, 200, { success: true });
}

async function handleVerifyEmail(request, response) {
  const payload = await readJson(request);
  if (!payload || typeof payload.token !== "string" || payload.token.length > 128) {
    return sendJson(response, 400, { error: "This verification link is invalid or expired." });
  }
  const tokenHash = crypto.createHash("sha256").update(payload.token).digest("hex");
  const token = db.prepare(`SELECT user_id AS userId FROM account_tokens
    WHERE token_hash = ? AND type = 'verify' AND expires_at > ?`).get(tokenHash, new Date().toISOString());
  if (!token) return sendJson(response, 400, { error: "This verification link is invalid or expired. Request a new one and try again." });
  db.prepare("UPDATE users SET email_verified = 1 WHERE id = ?").run(token.userId);
  db.prepare("DELETE FROM account_tokens WHERE token_hash = ?").run(tokenHash);
  const user = [...users.values()].find((account) => account.id === token.userId);
  if (user) {
    user.emailVerified = true;
    recordActivity(user, "Verified email address");
  }
  return sendJson(response, 200, { success: true });
}

async function handleForgotPassword(request, response) {
  if (!checkRateLimit(request, response, "email-actions", 4)) return;
  const payload = await readJson(request);
  if (!payload || typeof payload.email !== "string" || payload.email.length > 254) {
    return sendJson(response, 400, { error: "Enter the email address used for your account." });
  }
  if (!emailDeliveryConfigured()) {
    return sendJson(response, 503, { error: "Email delivery is not configured. Set RESEND_API_KEY and RESEND_FROM_EMAIL, then restart the app." });
  }
  const user = users.get(payload.email.trim().toLowerCase());
  if (user) {
    try {
      const token = createAccountToken(user, "reset");
      await sendAccountEmail(user, "reset", token);
    } catch (error) {
      console.error("Password recovery email delivery failed:", error.message);
      return sendJson(response, 502, { error: "The password reset email could not be sent. Check the Resend sender configuration and try again." });
    }
  }
  return sendJson(response, 200, { success: true });
}

async function handleResetPassword(request, response) {
  const payload = await readJson(request);
  if (!payload || typeof payload.token !== "string" || payload.token.length > 128
    || typeof payload.password !== "string" || payload.password.length < 10 || payload.password.length > 128) {
    return sendJson(response, 400, { error: "Use a valid reset link and a password between 10 and 128 characters." });
  }
  const tokenHash = crypto.createHash("sha256").update(payload.token).digest("hex");
  const token = db.prepare(`SELECT user_id AS userId FROM account_tokens
    WHERE token_hash = ? AND type = 'reset' AND expires_at > ?`).get(tokenHash, new Date().toISOString());
  if (!token) return sendJson(response, 400, { error: "This password reset link is invalid or expired. Request another link." });
  const user = [...users.values()].find((account) => account.id === token.userId);
  if (!user) return sendJson(response, 400, { error: "This account no longer exists." });
  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = (await scrypt(payload.password, salt, 64)).toString("hex");
  db.prepare("UPDATE users SET salt = ?, password_hash = ? WHERE id = ?").run(salt, passwordHash, user.id);
  user.salt = salt;
  user.passwordHash = passwordHash;
  db.prepare("DELETE FROM account_tokens WHERE user_id = ?").run(user.id);
  for (const [sessionToken, session] of sessions) {
    if (session.userId === user.id) sessions.delete(sessionToken);
  }
  recordActivity(user, "Reset account password");
  return sendJson(response, 200, { success: true });
}

async function handleChangePassword(request, response, user) {
  const payload = await readJson(request);
  if (!payload || typeof payload.currentPassword !== "string" || typeof payload.newPassword !== "string"
    || payload.newPassword.length < 10 || payload.newPassword.length > 128) {
    return sendJson(response, 400, { error: "Enter your current password and a new password between 10 and 128 characters." });
  }
  if (!await verifyPassword(payload.currentPassword, user)) {
    return sendJson(response, 401, { error: "Your current password is incorrect." });
  }
  if (payload.currentPassword === payload.newPassword) {
    return sendJson(response, 400, { error: "Choose a new password that is different from your current one." });
  }
  const updatedUser = {
    ...user,
    salt: crypto.randomBytes(16).toString("hex")
  };
  updatedUser.passwordHash = (await scrypt(payload.newPassword, updatedUser.salt, 64)).toString("hex");
  saveUser(updatedUser);
  user.salt = updatedUser.salt;
  user.passwordHash = updatedUser.passwordHash;
  const currentToken = readCookies(request).get(SESSION_COOKIE);
  for (const [sessionToken, session] of sessions) {
    if (session.userId === user.id && sessionToken !== currentToken) sessions.delete(sessionToken);
  }
  recordActivity(user, "Changed account password");
  return sendJson(response, 200, { success: true });
}

async function handleDeleteAccount(request, response, user) {
  const payload = await readJson(request);
  if (!payload || typeof payload.password !== "string"
    || !await verifyPassword(payload.password, user)) {
    return sendJson(response, 401, { error: "Enter your correct password to delete this account." });
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM activity WHERE email = ?").run(user.email);
    db.prepare("DELETE FROM users WHERE id = ?").run(user.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  users.delete(user.email);
  for (const [sessionToken, session] of sessions) {
    if (session.userId === user.id) sessions.delete(sessionToken);
  }
  expireSession(response);
  return sendJson(response, 200, { success: true });
}

async function handleAdminLogin(request, response) {
  if (!checkRateLimit(request, response, "admin")) return;
  if (!hasAdminCredentials()) {
    return sendJson(response, 503, { error: "Admin sign-in is not configured. Set ADMIN_EMAIL and an ADMIN_PASSWORD of at least 16 characters, then restart the server." });
  }

  const payload = await readJson(request);
  if (!payload || typeof payload.email !== "string" || typeof payload.password !== "string"
    || payload.email.length > 254 || payload.password.length > 256) {
    return sendJson(response, 400, { error: "Enter the administrator email and password." });
  }

  const suppliedEmail = payload.email.trim().toLowerCase();
  const configuredEmail = process.env.ADMIN_EMAIL.trim().toLowerCase();
  const suppliedEmailHash = crypto.createHash("sha256").update(suppliedEmail).digest();
  const configuredEmailHash = crypto.createHash("sha256").update(configuredEmail).digest();
  const suppliedPasswordHash = crypto.createHash("sha256").update(payload.password).digest();
  const configuredPasswordHash = crypto.createHash("sha256").update(process.env.ADMIN_PASSWORD).digest();
  if (!crypto.timingSafeEqual(suppliedEmailHash, configuredEmailHash)
    || !crypto.timingSafeEqual(suppliedPasswordHash, configuredPasswordHash)) {
    return sendJson(response, 401, { error: "Administrator email or password is incorrect." });
  }

  issueAdminSession(response);
  db.prepare("INSERT INTO admin_signins (admin_email, ip_address, created_at) VALUES (?, ?, ?)")
    .run(configuredEmail, request.socket.remoteAddress || "unknown", new Date().toISOString());
  recordAdminAction("Signed in", request.socket.remoteAddress || "unknown");
  return sendJson(response, 200, { success: true });
}

function recordAdminAction(action, target = "") {
  db.prepare("INSERT INTO admin_audit (admin_email, action, target, created_at) VALUES (?, ?, ?, ?)")
    .run((process.env.ADMIN_EMAIL || "admin").trim().toLowerCase(), action, target, new Date().toISOString());
}

function csvCell(value) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function sendCsv(response, filename, headers, rows) {
  const content = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  response.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store"
  });
  response.end(`\uFEFF${content}`);
}

function adminStudentRows() {
  return db.prepare(`SELECT u.id, u.email, u.created_at AS createdAt, u.profile_name AS profileName,
      u.school, u.course, u.email_verified AS emailVerified, u.approved, u.suspended,
      u.storage_quota_bytes AS storageQuotaBytes, a.year_of_study AS yearOfStudy,
      a.semester, COALESCE(f.storage_used, 0) AS storageUsed,
      (SELECT MAX(created_at) FROM activity WHERE email = u.email) AS lastActive
    FROM users u LEFT JOIN academic_settings a ON a.user_id = u.id
    LEFT JOIN (SELECT user_id, SUM(size) AS storage_used FROM files GROUP BY user_id) f ON f.user_id = u.id`);
}

function handleAdminUsers(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const query = (url.searchParams.get("q") || "").trim().toLowerCase();
  const verified = url.searchParams.get("verified");
  const status = url.searchParams.get("status");
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get("pageSize") || "25", 10) || 25));
  const allAccounts = adminStudentRows().all().map((account) => ({
    ...account,
    emailVerified: Boolean(account.emailVerified),
    approved: Boolean(account.approved),
    suspended: Boolean(account.suspended),
    online: !account.suspended && [...sessions.values()].some((session) => session.userId === account.id && session.expiresAt > Date.now())
  }));
  const filtered = allAccounts.filter((account) =>
    (!query || `${account.email} ${account.profileName} ${account.school} ${account.course}`.toLowerCase().includes(query))
    && (!verified || String(account.emailVerified) === verified)
    && (!status || (status === "pending" ? !account.approved : status === "suspended" ? account.suspended : status === "online" ? account.online : status === "offline" ? (!account.online && !account.suspended) : true))
  ).sort((left, right) => (right.createdAt || "").localeCompare(left.createdAt || ""));
  const messages = [...users.values()].flatMap((user) =>
    getWorkspace(user.id).inbox
      .filter((item) => item.type === "message")
      .map((item) => ({
        ...item,
        email: user.email,
        status: db.prepare("SELECT status FROM support_status WHERE inbox_id = ?").get(item.id)?.status || "unread"
      }))
  ).sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 100);
  return sendJson(response, 200, {
    accountCount: allAccounts.length,
    total: filtered.length,
    page,
    pageSize,
    users: filtered.slice((page - 1) * pageSize, page * pageSize),
    activity: db.prepare("SELECT email, action, created_at AS createdAt FROM activity ORDER BY id DESC LIMIT 80").all(),
    messages,
    audit: db.prepare("SELECT admin_email AS adminEmail, action, target, created_at AS createdAt FROM admin_audit ORDER BY id DESC LIMIT 40").all()
  });
}

function handleAdminOverview(response) {
  const now = new Date();
  const since = new Date(now.getTime() - 7 * 86400000).toISOString();
  const activeSince = new Date(now.getTime() - 15 * 60000).toISOString();
  const counts = db.prepare(`SELECT COUNT(*) AS students,
      SUM(CASE WHEN email_verified = 1 THEN 1 ELSE 0 END) AS verified,
      SUM(CASE WHEN email_verified = 0 THEN 1 ELSE 0 END) AS unverified,
      SUM(CASE WHEN approved = 0 THEN 1 ELSE 0 END) AS pendingApprovals,
      SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS newThisWeek
    FROM users`).get(since);
  const storage = db.prepare(`SELECT COALESCE(SUM(size), 0) AS used,
      (SELECT COUNT(*) FROM files) AS uploadCount FROM files`).get();
  const messages = db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN COALESCE(s.status, 'unread') = 'unread' THEN 1 ELSE 0 END) AS unread
    FROM inbox i JOIN users u ON u.id = i.user_id LEFT JOIN support_status s ON s.inbox_id = i.id
    WHERE i.type = 'message'`).get();
  const signups = db.prepare(`SELECT date(created_at) AS day, COUNT(*) AS count FROM users
    WHERE created_at >= date('now', '-6 days') GROUP BY date(created_at) ORDER BY day`).all();
  const activity = db.prepare(`SELECT date(created_at) AS day, COUNT(DISTINCT email) AS count FROM activity
    WHERE created_at >= date('now', '-6 days') GROUP BY date(created_at) ORDER BY day`).all();
  const activeNow = db.prepare("SELECT COUNT(DISTINCT users.id) AS count FROM users JOIN activity ON activity.email = users.email WHERE activity.created_at >= ?").get(activeSince).count;
  const dbBytes = fs.statSync(DATABASE_FILE).size;
  return sendJson(response, 200, {
    ...counts,
    students: counts.students || 0,
    verified: counts.verified || 0,
    unverified: counts.unverified || 0,
    pendingApprovals: counts.pendingApprovals || 0,
    newThisWeek: counts.newThisWeek || 0,
    activeNow,
    storageUsedBytes: storage.used,
    uploadCount: storage.uploadCount,
    unreadMessages: messages.unread || 0,
    totalMessages: messages.total || 0,
    signups,
    dailyActive: activity,
    health: { databaseBytes: dbBytes, uploadCount: storage.uploadCount, email: lastEmailSend }
  });
}

function findAdminStudent(email) {
  if (typeof email !== "string" || email.length > 254) return null;
  return users.get(email.trim().toLowerCase()) || null;
}

async function handleAdminStudentAction(request, response) {
  const payload = await readJson(request);
  if (!payload || typeof payload.action !== "string") return sendJson(response, 400, { error: "Choose an administrator action." });
  const user = findAdminStudent(payload.email);
  if (!user) return sendJson(response, 404, { error: "That student account was not found." });
  const target = user.email;
  if (payload.action === "logout" || payload.action === "suspend") {
    for (const [token, session] of sessions) if (session.userId === user.id) sessions.delete(token);
    if (payload.action === "suspend") {
      db.prepare("UPDATE users SET suspended = 1 WHERE id = ?").run(user.id);
      user.suspended = true;
      recordAdminAction("Suspended student account", target);
    } else recordAdminAction("Signed out student sessions", target);
    return sendJson(response, 200, { success: true });
  }
  if (payload.action === "reactivate") {
    db.prepare("UPDATE users SET suspended = 0 WHERE id = ?").run(user.id);
    user.suspended = false;
    recordAdminAction("Reactivated student account", target);
    return sendJson(response, 200, { success: true });
  }
  if (payload.action === "approve") {
    if (user.approved) return sendJson(response, 409, { error: "This account has already been approved." });
    db.prepare("UPDATE users SET approved = 1, email_verified = 1 WHERE id = ?").run(user.id);
    db.prepare("DELETE FROM account_tokens WHERE user_id = ? AND type = 'verify'").run(user.id);
    user.approved = true;
    user.emailVerified = true;
    recordAdminAction("Approved student account and verified email", target);
    return sendJson(response, 200, { success: true });
  }
  if (payload.action === "verify") {
    db.prepare("UPDATE users SET email_verified = 1 WHERE id = ?").run(user.id);
    db.prepare("DELETE FROM account_tokens WHERE user_id = ? AND type = 'verify'").run(user.id);
    user.emailVerified = true;
    recordAdminAction("Manually verified student email", target);
    return sendJson(response, 200, { success: true });
  }
  if (payload.action === "resend-verification" || payload.action === "password-reset") {
    const type = payload.action === "resend-verification" ? "verify" : "reset";
    if (type === "verify" && user.emailVerified) return sendJson(response, 409, { error: "This account is already verified." });
    const token = createAccountToken(user, type);
    try {
      await sendAccountEmail(user, type, token);
    } catch (error) {
      console.error("Administrator-triggered account email failed:", error.message);
      return sendJson(response, 502, { error: "The email could not be delivered. Check the email provider configuration." });
    }
    recordAdminAction(type === "verify" ? "Resent verification email" : "Sent password reset email", target);
    return sendJson(response, 200, { success: true });
  }
  if (payload.action === "quota") {
    const bytes = Number(payload.bytes);
    if (!Number.isSafeInteger(bytes) || bytes < 1024 * 1024 || bytes > 10 * 1024 * 1024 * 1024) {
      return sendJson(response, 400, { error: "Storage quota must be between 1 MiB and 10 GiB." });
    }
    db.prepare("UPDATE users SET storage_quota_bytes = ? WHERE id = ?").run(bytes, user.id);
    recordAdminAction("Adjusted student storage quota", `${target} (${bytes} bytes)`);
    return sendJson(response, 200, { success: true });
  }
  if (payload.action === "delete") {
    if (payload.confirmEmail !== target) return sendJson(response, 400, { error: "Type the student's exact email address to confirm deletion." });
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM activity WHERE email = ?").run(target);
      db.prepare("DELETE FROM users WHERE id = ?").run(user.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    users.delete(target);
    for (const [token, session] of sessions) if (session.userId === user.id) sessions.delete(token);
    recordAdminAction("Deleted student account and associated data", target);
    return sendJson(response, 200, { success: true });
  }
  return sendJson(response, 400, { error: "That administrator action is not supported." });
}

function handleAdminSupport(response) {
  const messages = db.prepare(`SELECT i.id, i.user_id AS userId, u.email, i.text, i.created_at AS createdAt,
      COALESCE(s.status, 'unread') AS status, s.first_reply_at AS firstReplyAt, s.resolved_at AS resolvedAt
    FROM inbox i JOIN users u ON u.id = i.user_id LEFT JOIN support_status s ON s.inbox_id = i.id
    WHERE i.type = 'message' ORDER BY i.created_at DESC LIMIT 300`).all();
  const responseStats = db.prepare(`SELECT AVG((julianday(s.first_reply_at) - julianday(i.created_at)) * 24 * 60) AS averageMinutes
    FROM inbox i JOIN support_status s ON s.inbox_id = i.id WHERE i.type = 'message' AND s.first_reply_at IS NOT NULL`).get();
  return sendJson(response, 200, { messages, averageResponseMinutes: responseStats.averageMinutes || 0 });
}

async function handleAdminSupportAction(request, response) {
  const payload = await readJson(request);
  if (!payload || typeof payload.id !== "string" || !/^[0-9a-f-]{36}$/i.test(payload.id)) {
    return sendJson(response, 400, { error: "Choose a valid support message." });
  }
  const message = db.prepare(`SELECT i.id, i.user_id AS userId, u.email FROM inbox i
    JOIN users u ON u.id = i.user_id WHERE i.id = ? AND i.type = 'message'`).get(payload.id);
  if (!message) return sendJson(response, 404, { error: "Support message not found." });
  const now = new Date().toISOString();
  if (payload.action === "status") {
    if (!["unread", "open", "resolved"].includes(payload.status)) return sendJson(response, 400, { error: "Choose a valid message status." });
    db.prepare(`INSERT INTO support_status (inbox_id, status, resolved_at) VALUES (?, ?, ?)
      ON CONFLICT(inbox_id) DO UPDATE SET status = excluded.status, resolved_at = excluded.resolved_at`)
      .run(message.id, payload.status, payload.status === "resolved" ? now : null);
    recordAdminAction(`Changed support status to ${payload.status}`, message.email);
    return sendJson(response, 200, { success: true });
  }
  if (payload.action === "reply") {
    if (typeof payload.message !== "string" || !payload.message.trim() || payload.message.trim().length > 1000) {
      return sendJson(response, 400, { error: "Write a reply of up to 1,000 characters." });
    }
    recordInbox(message.userId, { type: "notification", sender: "admin", text: payload.message.trim() });
    db.prepare(`INSERT INTO support_status (inbox_id, status, first_reply_at) VALUES (?, 'open', ?)
      ON CONFLICT(inbox_id) DO UPDATE SET status = CASE WHEN status = 'resolved' THEN status ELSE 'open' END,
      first_reply_at = COALESCE(first_reply_at, excluded.first_reply_at)`).run(message.id, now);
    recordAdminAction("Replied to support message", message.email);
    return sendJson(response, 201, { success: true });
  }
  return sendJson(response, 400, { error: "Choose a valid support action." });
}

function announcementRecipients(audience, target) {
  if (audience === "all") return [...users.values()];
  if (audience === "student") {
    const user = findAdminStudent(target);
    return user ? [user] : [];
  }
  if (!["course", "school", "year"].includes(audience)) return [];
  return adminStudentRows().all().filter((user) => {
    if (audience === "course") return user.course.toLowerCase() === target.toLowerCase();
    if (audience === "school") return user.school.toLowerCase() === target.toLowerCase();
    return String(user.yearOfStudy) === target;
  }).map((row) => users.get(row.email)).filter(Boolean);
}

function dispatchScheduledAnnouncements() {
  const now = new Date().toISOString();
  const due = db.prepare("SELECT * FROM admin_announcements WHERE sent_at IS NULL AND scheduled_at <= ?").all(now);
  for (const item of due) {
    const recipients = announcementRecipients(item.audience, item.target);
    if (recipients.length === 0) {
      db.prepare("UPDATE admin_announcements SET status = 'no_recipients', error = ? WHERE id = ?")
        .run(`No students match the ${item.audience} target "${item.target}".`, item.id);
      continue;
    }
    for (const user of recipients) recordInbox(user.id, { type: "announcement", sender: "admin", text: item.message });
    db.prepare("UPDATE admin_announcements SET sent_at = ?, status = 'sent', error = '' WHERE id = ?").run(now, item.id);
    recordAdminAction("Dispatched announcement", `${item.audience}:${item.target} (${recipients.length} recipients)`);
  }
}

async function handleAdminAnnouncement(request, response) {
  const payload = await readJson(request);
  if (!payload || !["all", "student", "course", "school", "year"].includes(payload.audience)
    || typeof payload.message !== "string" || !payload.message.trim() || payload.message.trim().length > 1000) {
    return sendJson(response, 400, { error: "Choose an audience and write a message up to 1,000 characters." });
  }
  const target = typeof payload.target === "string" ? payload.target.trim().slice(0, 254) : "";
  if (payload.audience !== "all" && !target) return sendJson(response, 400, { error: "Choose the target for this announcement." });
  const recipients = announcementRecipients(payload.audience, target);
  if (recipients.length === 0) {
    return sendJson(response, 422, { error: `No students match the selected ${payload.audience} audience${target ? ` target "${target}"` : ""}.` });
  }
  if (!Number.isFinite(Date.parse(payload.scheduledAt || new Date().toISOString()))) return sendJson(response, 400, { error: "Enter a valid scheduled time." });
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const scheduledAt = payload.scheduledAt || now;
  db.prepare(`INSERT INTO admin_announcements (id, audience, target, message, scheduled_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id, payload.audience, target, payload.message.trim(), scheduledAt, now);
  dispatchScheduledAnnouncements();
  recordAdminAction("Created announcement", `${payload.audience}:${target}`);
  const saved = db.prepare("SELECT status, sent_at AS sentAt, error FROM admin_announcements WHERE id = ?").get(id);
  return sendJson(response, 201, {
    success: true,
    status: saved.status,
    recipientCount: recipients.length,
    scheduledAt,
    sentAt: saved.sentAt,
    error: saved.error
  });
}

function handleAdminAcademic(response) {
  const courses = db.prepare("SELECT id, name FROM master_courses ORDER BY name").all();
  const units = db.prepare(`SELECT u.id, c.name AS course, u.code, u.name, u.year_of_study AS yearOfStudy,
      u.semester, u.credit_hours AS creditHours FROM master_units u JOIN master_courses c ON c.id = u.course_id ORDER BY c.name, u.year_of_study, u.semester, u.code`).all();
  const calendar = db.prepare(`SELECT id, title, start_date AS startDate, end_date AS endDate, type, semester
    FROM academic_calendar ORDER BY start_date`).all();
  const grading = db.prepare("SELECT id, label, minimum_score AS minimumScore, maximum_score AS maximumScore FROM grading_scales ORDER BY minimum_score DESC").all();
  return sendJson(response, 200, { courses, units, calendar, grading });
}

function parseCsvRecords(input) {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const records = [];
  const errors = [];
  let rowNumber = 1;
  let fields = [];
  let field = "";
  let inQuotes = false;
  let afterQuote = false;
  let rowError = "";

  const finishRecord = () => {
    fields.push(field);
    if (rowError) errors.push({ row: rowNumber, reason: rowError });
    else records.push({ row: rowNumber, fields });
    rowNumber += 1;
    fields = [];
    field = "";
    afterQuote = false;
    rowError = "";
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (afterQuote) {
      if (character === ",") {
        fields.push(field);
        field = "";
        afterQuote = false;
      } else if (character === "\r" || character === "\n") {
        finishRecord();
        if (character === "\r" && text[index + 1] === "\n") index += 1;
      } else {
        if (!rowError) rowError = "Unexpected character after a quoted field.";
        field += character;
        afterQuote = false;
      }
      continue;
    }

    if (character === '"') {
      if (field.length === 0) inQuotes = true;
      else {
        if (!rowError) rowError = "Unexpected quote in an unquoted field.";
        field += character;
      }
    } else if (character === ",") {
      fields.push(field);
      field = "";
    } else if (character === "\r" || character === "\n") {
      finishRecord();
      if (character === "\r" && text[index + 1] === "\n") index += 1;
    } else {
      field += character;
    }
  }

  if (inQuotes) {
    errors.push({ row: rowNumber, reason: "Quoted field was not closed before the end of the file." });
  } else if (field.length > 0 || fields.length > 0 || afterQuote || rowError) {
    finishRecord();
  }

  return { records, errors };
}

function isMasterUnitUniqueConflict(error) {
  return error instanceof Error && /UNIQUE constraint failed: master_units\./.test(error.message);
}

async function handleAdminAcademicAction(request, response) {
  const payload = await readJson(request, 2 * 1024 * 1024);
  if (!payload || typeof payload.action !== "string") return sendJson(response, 400, { error: "Choose an academic data action." });
  if (payload.action === "course") {
    if (typeof payload.name !== "string" || !payload.name.trim() || payload.name.trim().length > 120) return sendJson(response, 400, { error: "Enter a course name." });
    const id = crypto.randomUUID();
    try { db.prepare("INSERT INTO master_courses (id, name) VALUES (?, ?)").run(id, payload.name.trim()); }
    catch (error) { if (String(error.message).includes("UNIQUE")) return sendJson(response, 409, { error: "That course already exists." }); throw error; }
    recordAdminAction("Added master course", payload.name.trim());
    return sendJson(response, 201, { success: true });
  }
  if (payload.action === "unit") {
    const course = db.prepare("SELECT id FROM master_courses WHERE name = ? COLLATE NOCASE").get(payload.course);
    if (!course || typeof payload.code !== "string" || typeof payload.name !== "string" || !payload.code.trim() || !payload.name.trim()
      || !Number.isInteger(Number(payload.yearOfStudy)) || Number(payload.yearOfStudy) < 1 || Number(payload.yearOfStudy) > 10
      || typeof payload.semester !== "string" || !payload.semester.trim()) return sendJson(response, 400, { error: "Enter a course, unit code/name, year, and semester." });
    const code = payload.code.trim();
    const semester = payload.semester.trim();
    const existing = db.prepare(`SELECT 1 FROM master_units
      WHERE course_id = ? AND code = ? AND year_of_study = ? AND semester = ?`)
      .get(course.id, code, Number(payload.yearOfStudy), semester);
    if (existing) return sendJson(response, 409, { error: `Unit ${code} already exists for ${payload.course}, year ${payload.yearOfStudy}, semester ${semester}.` });
    try {
      db.prepare(`INSERT INTO master_units (id, course_id, code, name, year_of_study, semester, credit_hours)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(crypto.randomUUID(), course.id, code, payload.name.trim(),
        Number(payload.yearOfStudy), semester, Number(payload.creditHours) || 0);
    } catch (error) {
      if (isMasterUnitUniqueConflict(error)) return sendJson(response, 409, { error: `Unit ${code} already exists for ${payload.course}, year ${payload.yearOfStudy}, semester ${semester}.` });
      throw error;
    }
    recordAdminAction("Added master unit", `${payload.course} ${payload.code.trim()}`);
    return sendJson(response, 201, { success: true });
  }
  if (payload.action === "csv-import") {
    if (typeof payload.csv !== "string" || payload.csv.length > 1024 * 1024) return sendJson(response, 400, { error: "Choose a CSV under 1 MiB." });
    const parsed = parseCsvRecords(payload.csv);
    const errors = [...parsed.errors];
    let imported = 0;
    const header = parsed.records.find((record) => record.row === 1);
    if (!header) {
      errors.push({ row: 1, reason: "A valid CSV header row is required." });
      return sendJson(response, 200, { success: true, imported, errors });
    }
    if (header.fields.length !== 6) {
      errors.push({ row: 1, reason: `Expected 6 header columns; found ${header.fields.length}.` });
      return sendJson(response, 200, { success: true, imported, errors });
    }

    const insertUnit = db.prepare(`INSERT INTO master_units (id, course_id, code, name, year_of_study, semester, credit_hours)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const record of parsed.records) {
      if (record.row === 1) continue;
      if (record.fields.length !== 6) {
        errors.push({ row: record.row, reason: `Expected 6 columns; found ${record.fields.length}.` });
        continue;
      }
      const [courseName, code, name, year, semester, credits] = record.fields.map((part) => part.trim());
      if (!courseName || !code || !name || !semester || !Number.isInteger(Number(year)) || Number(year) < 1 || Number(year) > 10) {
        errors.push({ row: record.row, reason: "Enter course, code, name, a year from 1 to 10, and semester." });
        continue;
      }
      if (credits && (!Number.isFinite(Number(credits)) || Number(credits) < 0)) {
        errors.push({ row: record.row, reason: "Credit hours must be a non-negative number." });
        continue;
      }
      const course = db.prepare("SELECT id FROM master_courses WHERE name = ? COLLATE NOCASE").get(courseName);
      if (!course) {
        errors.push({ row: record.row, reason: `Course "${courseName}" was not found.` });
        continue;
      }
      try {
        insertUnit.run(crypto.randomUUID(), course.id, code, name, Number(year), semester, Number(credits) || 0);
        imported += 1;
      } catch (error) {
        if (!isMasterUnitUniqueConflict(error)) throw error;
        errors.push({ row: record.row, reason: `Unit ${code} already exists for ${courseName}, year ${year}, semester ${semester}.` });
      }
    }
    errors.sort((left, right) => left.row - right.row);
    recordAdminAction("Imported academic units from CSV", `${imported} rows, ${errors.length} row errors`);
    return sendJson(response, 200, { success: true, imported, errors });
  }
  if (payload.action === "calendar") {
    if (!payload.title || !payload.startDate || !payload.endDate || !payload.type || Date.parse(payload.startDate) > Date.parse(payload.endDate)) {
      return sendJson(response, 400, { error: "Enter a title, type, and valid start/end dates." });
    }
    db.prepare(`INSERT INTO academic_calendar (id, title, start_date, end_date, type, semester)
      VALUES (?, ?, ?, ?, ?, ?)`).run(crypto.randomUUID(), String(payload.title).slice(0, 120), payload.startDate, payload.endDate, String(payload.type).slice(0, 40), String(payload.semester || ""));
    recordAdminAction("Added academic calendar period", payload.title);
    return sendJson(response, 201, { success: true });
  }
  if (payload.action === "grading") {
    const min = Number(payload.minimumScore);
    const max = Number(payload.maximumScore);
    if (typeof payload.label !== "string" || !payload.label.trim() || !Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max > 100 || min > max) {
      return sendJson(response, 400, { error: "Enter a valid grading label and score range from 0 to 100." });
    }
    db.prepare("INSERT INTO grading_scales (id, label, minimum_score, maximum_score) VALUES (?, ?, ?, ?)")
      .run(crypto.randomUUID(), payload.label.trim(), min, max);
    recordAdminAction("Added grading scale", `${payload.label.trim()} ${min}-${max}`);
    return sendJson(response, 201, { success: true });
  }
  return sendJson(response, 400, { error: "That academic data action is not supported." });
}

function handleAdminStorage(response) {
  const rows = adminStudentRows().all().map((user) => ({
    email: user.email,
    school: user.school,
    storageUsed: user.storageUsed,
    quota: user.storageQuotaBytes,
    percent: user.storageQuotaBytes ? Math.round(user.storageUsed / user.storageQuotaBytes * 100) : 0
  })).sort((a, b) => b.percent - a.percent);
  const files = db.prepare(`SELECT f.id, f.user_id AS userId, u.email, f.name, f.mime, f.size, f.created_at AS createdAt
    FROM files f JOIN users u ON u.id = f.user_id ORDER BY f.created_at DESC LIMIT 500`).all();
  return sendJson(response, 200, { students: rows, files });
}

async function handleAdminStorageAction(request, response) {
  const payload = await readJson(request);
  if (!payload || typeof payload.id !== "string" || !/^[0-9a-f-]{36}$/i.test(payload.id)
    || typeof payload.reason !== "string" || !payload.reason.trim() || payload.reason.trim().length > 500) {
    return sendJson(response, 400, { error: "Select a file and provide a removal reason." });
  }
  const file = db.prepare("SELECT id, user_id AS userId, name FROM files WHERE id = ?").get(payload.id);
  if (!file) return sendJson(response, 404, { error: "File not found." });
  db.prepare("DELETE FROM files WHERE id = ?").run(file.id);
  recordAdminAction("Removed student file for policy reason", `${file.name}; ${payload.reason.trim()}`);
  return sendJson(response, 200, { success: true });
}

function handleAdminAudit(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const q = (url.searchParams.get("q") || "").trim();
  const rows = db.prepare(`SELECT admin_email AS adminEmail, action, target, created_at AS createdAt
    FROM admin_audit WHERE admin_email LIKE ? OR action LIKE ? OR target LIKE ?
    ORDER BY id DESC LIMIT 1000`).all(`%${q}%`, `%${q}%`, `%${q}%`);
  if (url.searchParams.get("format") === "csv") {
    recordAdminAction("Exported admin audit log as CSV", `${rows.length} records`);
    return sendCsv(response, "obadian-admin-audit.csv", ["Admin", "Action", "Target", "Time"],
      rows.map((row) => [row.adminEmail, row.action, row.target, row.createdAt]));
  }
  return sendJson(response, 200, {
    entries: rows,
    signins: db.prepare("SELECT admin_email AS adminEmail, ip_address AS ipAddress, created_at AS createdAt FROM admin_signins ORDER BY id DESC LIMIT 100").all()
  });
}

async function handleAdminBackup(response) {
  const backupPath = path.join(DATA_DIRECTORY, `admin-backup-${crypto.randomUUID()}.sqlite`);
  const escapedPath = backupPath.replace(/'/g, "''");
  let backup;
  try {
    db.exec(`VACUUM INTO '${escapedPath}'`);
    const snapshot = new DatabaseSync(backupPath);
    snapshot.exec("UPDATE files SET content = NULL; UPDATE profile_avatars SET content = X''; UPDATE users SET salt = '', password_hash = '';");
    snapshot.close();
    backup = fs.readFileSync(backupPath);
  } finally {
    if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
  }
  recordAdminAction("Downloaded SQLite database backup", `${backup.length} bytes`);
  response.writeHead(200, {
    "Content-Type": "application/vnd.sqlite3",
    "Content-Disposition": `attachment; filename="obadian-hub-backup-${new Date().toISOString().slice(0, 10)}.sqlite"`,
    "Content-Length": backup.length,
    "Cache-Control": "no-store"
  });
  response.end(backup);
}

function makeReportPdf(lines) {
  const escapePdfText = (value) => String(value).replace(/[^\x20-\x7e]/g, "?").replace(/[\\()]/g, "\\$&");
  const commands = ["BT", "/F1 14 Tf", "50 790 Td", `(${escapePdfText(lines[0])}) Tj`, "/F1 10 Tf"];
  for (const line of lines.slice(1)) commands.push("0 -22 Td", `(${escapePdfText(line)}) Tj`);
  commands.push("ET");
  const stream = commands.join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  ];
  let document = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(document));
    document += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(document);
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) document += `${String(offset).padStart(10, "0")} 00000 n \n`;
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(document);
}

function handleAdminReport(response) {
  const overview = {
    students: db.prepare("SELECT COUNT(*) AS count FROM users").get().count,
    verified: db.prepare("SELECT COUNT(*) AS count FROM users WHERE email_verified = 1").get().count,
    activeNow: db.prepare("SELECT COUNT(DISTINCT email) AS count FROM activity WHERE created_at >= ?").get(new Date(Date.now() - 15 * 60000).toISOString()).count,
    storageBytes: db.prepare("SELECT COALESCE(SUM(size), 0) AS total FROM files").get().total,
    unreadMessages: db.prepare(`SELECT COUNT(*) AS count FROM inbox i LEFT JOIN support_status s ON s.inbox_id = i.id
      WHERE i.type = 'message' AND COALESCE(s.status, 'unread') = 'unread'`).get().count
  };
  recordAdminAction("Exported PDF overview report");
  const pdf = makeReportPdf([
    "Obadian Hub - Administrator overview",
    `Generated: ${new Date().toISOString()}`,
    `Total students: ${overview.students}`,
    `Verified students: ${overview.verified}`,
    `Active in last 15 minutes: ${overview.activeNow}`,
    `Unread support messages: ${overview.unreadMessages}`,
    `Stored file metadata total (bytes): ${overview.storageBytes}`,
    "Private file contents are excluded from this report."
  ]);
  response.writeHead(200, {
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="obadian-overview-${new Date().toISOString().slice(0, 10)}.pdf"`,
    "Content-Length": pdf.length,
    "Cache-Control": "no-store"
  });
  response.end(pdf);
}

async function handleSchedule(request, response, user) {
  const payload = await readJson(request);
  if (!payload || typeof payload.title !== "string" || typeof payload.date !== "string"
    || !payload.title.trim() || payload.title.trim().length > 120
    || Number.isNaN(Date.parse(payload.date))) {
    return sendJson(response, 400, { error: "Add a schedule title and a valid date and time." });
  }
  const category = payload.category === undefined ? "General" : payload.category;
  const repeat = payload.repeat === undefined ? "none" : payload.repeat;
  const reminderMinutes = Number(payload.reminderMinutes ?? 0);
  const unitId = payload.unitId === undefined || payload.unitId === "" ? null : payload.unitId;
  if (typeof category !== "string" || !SCHEDULE_CATEGORIES.has(category)
    || typeof repeat !== "string" || !SCHEDULE_REPEATS.has(repeat)
    || ![0, 5, 10, 15, 30, 60].includes(reminderMinutes)
    || (unitId !== null && (typeof unitId !== "string"
      || !db.prepare("SELECT 1 FROM units WHERE id = ? AND user_id = ?").get(unitId, user.id)))) {
    return sendJson(response, 400, { error: "Choose a valid category, repeat option, and reminder time." });
  }
  const item = {
    id: crypto.randomUUID(),
    title: payload.title.trim(),
    date: new Date(payload.date).toISOString(),
    details: typeof payload.details === "string" ? payload.details.trim().slice(0, 500) : "",
    unitId,
    category,
    repeat,
    reminderMinutes
  };
  db.prepare(`INSERT INTO schedule
    (id, user_id, unit_id, title, date, details, category, repeat, reminder_minutes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(item.id, user.id, item.unitId, item.title, item.date, item.details, item.category, item.repeat, item.reminderMinutes);
  recordActivity(user, `Added schedule: ${item.title}`);
  return sendJson(response, 201, { item });
}

async function handleScheduleUpdate(request, response, user, itemId) {
  const payload = await readJson(request);
  if (!payload || typeof payload !== "object") {
    return sendJson(response, 400, { error: "Enter valid activity details." });
  }
  const existing = db.prepare(`SELECT id, unit_id AS unitId, title, date, details, category, repeat, reminder_minutes AS reminderMinutes
    FROM schedule WHERE id = ? AND user_id = ?`).get(itemId, user.id);
  if (!existing) return sendJson(response, 404, { error: "Schedule item not found." });

  if (typeof payload.occurrenceDate === "string" && typeof payload.done === "boolean") {
    const occurrenceDate = payload.occurrenceDate;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(occurrenceDate)
      || new Date(`${occurrenceDate}T00:00:00.000Z`).toISOString().slice(0, 10) !== occurrenceDate
      || !isScheduleOccurrence(existing.date, existing.repeat, occurrenceDate)) {
      return sendJson(response, 400, { error: "Choose a valid date for this activity." });
    }
    if (payload.done) {
      db.prepare(`INSERT INTO schedule_completions (schedule_id, occurrence_date, completed_at)
        VALUES (?, ?, ?) ON CONFLICT(schedule_id, occurrence_date) DO UPDATE SET completed_at = excluded.completed_at`)
        .run(itemId, occurrenceDate, new Date().toISOString());
    } else {
      db.prepare("DELETE FROM schedule_completions WHERE schedule_id = ? AND occurrence_date = ?")
        .run(itemId, occurrenceDate);
    }
    recordActivity(user, payload.done ? `Completed schedule: ${existing.title}` : `Reopened schedule: ${existing.title}`);
    return sendJson(response, 200, { success: true });
  }

  const date = payload.date === undefined ? existing.date : payload.date;
  const title = payload.title === undefined ? existing.title : payload.title;
  const details = payload.details === undefined ? existing.details : payload.details;
  const category = payload.category === undefined ? existing.category : payload.category;
  const repeat = payload.repeat === undefined ? existing.repeat : payload.repeat;
  const reminderMinutes = payload.reminderMinutes === undefined ? existing.reminderMinutes : Number(payload.reminderMinutes);
  const unitId = payload.unitId === undefined ? existing.unitId : (payload.unitId || null);
  if (typeof date !== "string" || Number.isNaN(Date.parse(date))) {
    return sendJson(response, 400, { error: "Choose a valid date and time." });
  }
  if (typeof title !== "string" || !title.trim() || title.trim().length > 120
    || typeof details !== "string" || details.length > 500) {
    return sendJson(response, 400, { error: "Enter an activity title up to 120 characters and notes up to 500 characters." });
  }
  if (typeof category !== "string" || !SCHEDULE_CATEGORIES.has(category)
    || typeof repeat !== "string" || !SCHEDULE_REPEATS.has(repeat)
    || ![0, 5, 10, 15, 30, 60].includes(reminderMinutes)
    || (unitId !== null && (typeof unitId !== "string"
      || !db.prepare("SELECT 1 FROM units WHERE id = ? AND user_id = ?").get(unitId, user.id)))) {
    return sendJson(response, 400, { error: "Choose a valid category, repeat option, and reminder time." });
  }
  db.prepare(`UPDATE schedule SET title = ?, date = ?, details = ?, unit_id = ?, category = ?, repeat = ?, reminder_minutes = ?
    WHERE id = ? AND user_id = ?`)
    .run(title.trim(), new Date(date).toISOString(), details.trim(), unitId, category, repeat, reminderMinutes, itemId, user.id);
  recordActivity(user, payload.date !== undefined ? "Moved or updated a schedule item" : `Updated schedule: ${title.trim()}`);
  return sendJson(response, 200, { success: true });
}

async function handleAcademicSettings(request, response, user) {
  const payload = await readJson(request);
  if (!payload || typeof payload.academicYear !== "string" || typeof payload.semester !== "string"
    || !Number.isInteger(payload.yearOfStudy) || payload.yearOfStudy < 0 || payload.yearOfStudy > 12) {
    return sendJson(response, 400, { error: "Enter a valid year of study, academic year, and semester or term." });
  }
  const academicYear = payload.academicYear.trim();
  const semester = payload.semester.trim();
  if (academicYear.length > 40 || semester.length > 60 || /[\u0000-\u001f]/.test(academicYear + semester)) {
    return sendJson(response, 400, { error: "Keep the academic year under 40 characters and the semester or term under 60 characters." });
  }
  db.prepare(`INSERT INTO academic_settings (user_id, academic_year, semester, year_of_study) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET academic_year = excluded.academic_year,
    semester = excluded.semester, year_of_study = excluded.year_of_study`)
    .run(user.id, academicYear, semester, payload.yearOfStudy);
  recordActivity(user, "Updated academic year, year of study, and semester");
  return sendJson(response, 200, { academicSettings: { academicYear, semester, yearOfStudy: payload.yearOfStudy } });
}

function validateUnitPayload(payload) {
  if (!payload || typeof payload.code !== "string" || typeof payload.title !== "string"
    || (payload.instructor !== undefined && typeof payload.instructor !== "string")) {
    return { error: "Enter a unit code and unit name. Instructor is optional." };
  }
  const code = payload.code.trim();
  const title = payload.title.trim();
  const instructor = typeof payload.instructor === "string" ? payload.instructor.trim() : "";
  if (!code || code.length > 24 || !/^[\p{L}\p{N}][\p{L}\p{N} .&/_-]*$/u.test(code)
    || !title || title.length > 120 || instructor.length > 80
    || /[\u0000-\u001f]/.test(title + instructor)) {
    return { error: "Use a unit code up to 24 characters, a unit name up to 120 characters, and an instructor name up to 80 characters." };
  }
  return { code, title, instructor };
}

async function handleCreateUnit(request, response, user) {
  const payload = await readJson(request);
  const unit = validateUnitPayload(payload);
  if (unit.error) return sendJson(response, 400, { error: unit.error });
  if (db.prepare("SELECT 1 FROM units WHERE user_id = ? AND code = ? COLLATE NOCASE").get(user.id, unit.code)) {
    return sendJson(response, 409, { error: "You already have a unit with that code." });
  }
  const item = { id: crypto.randomUUID(), ...unit };
  db.prepare("INSERT INTO units (id, user_id, code, title, instructor, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(item.id, user.id, item.code, item.title, item.instructor, new Date().toISOString());
  recordActivity(user, `Added academic unit: ${item.code}`);
  return sendJson(response, 201, { unit: item });
}

async function handleUpdateUnit(request, response, user, unitId) {
  const payload = await readJson(request);
  const unit = validateUnitPayload(payload);
  if (unit.error) return sendJson(response, 400, { error: unit.error });
  if (!db.prepare("SELECT 1 FROM units WHERE id = ? AND user_id = ?").get(unitId, user.id)) {
    return sendJson(response, 404, { error: "Academic unit not found." });
  }
  if (db.prepare("SELECT 1 FROM units WHERE user_id = ? AND code = ? COLLATE NOCASE AND id != ?").get(user.id, unit.code, unitId)) {
    return sendJson(response, 409, { error: "You already have another unit with that code." });
  }
  db.prepare("UPDATE units SET code = ?, title = ?, instructor = ? WHERE id = ? AND user_id = ?")
    .run(unit.code, unit.title, unit.instructor, unitId, user.id);
  recordActivity(user, `Updated academic unit: ${unit.code}`);
  return sendJson(response, 200, { unit: { id: unitId, ...unit } });
}

function handleDeleteUnit(response, user, unitId) {
  const result = db.prepare("DELETE FROM units WHERE id = ? AND user_id = ?").run(unitId, user.id);
  if (result.changes === 0) return sendJson(response, 404, { error: "Academic unit not found." });
  recordActivity(user, "Removed an academic unit");
  return sendJson(response, 200, { success: true });
}

function validateAttendancePayload(payload, user, existing) {
  const unitId = payload.unitId === undefined ? existing && existing.unitId : payload.unitId;
  const sessionDate = payload.sessionDate === undefined ? existing && existing.sessionDate : payload.sessionDate;
  const status = payload.status === undefined ? existing && existing.status : payload.status;
  const notes = payload.notes === undefined ? (existing ? existing.notes : "") : payload.notes;
  const validDate = typeof sessionDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sessionDate)
    && !Number.isNaN(Date.parse(`${sessionDate}T00:00:00.000Z`))
    && new Date(`${sessionDate}T00:00:00.000Z`).toISOString().slice(0, 10) === sessionDate;
  if (typeof unitId !== "string" || !db.prepare("SELECT 1 FROM units WHERE id = ? AND user_id = ?").get(unitId, user.id)
    || !validDate || !ATTENDANCE_STATUSES.has(status)
    || typeof notes !== "string" || notes.trim().length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(notes)) {
    return { error: "Choose one of your units, a valid class date and attendance status. Notes must be 500 characters or less." };
  }
  return { unitId, sessionDate, status, notes: notes.trim() };
}

async function handleCreateAttendance(request, response, user) {
  const payload = await readJson(request);
  const attendance = validateAttendancePayload(payload, user, null);
  if (attendance.error) return sendJson(response, 400, { error: attendance.error });
  const period = db.prepare(`SELECT academic_year AS academicYear, semester, year_of_study AS yearOfStudy
    FROM academic_settings WHERE user_id = ?`).get(user.id) || { academicYear: "", semester: "", yearOfStudy: 0 };
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO attendance_records
    (id, user_id, unit_id, session_date, status, notes, academic_year, semester, year_of_study, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, user.id, attendance.unitId, attendance.sessionDate, attendance.status, attendance.notes,
      period.academicYear, period.semester, period.yearOfStudy, now, now);
  recordActivity(user, `Recorded ${attendance.status} attendance`);
  return sendJson(response, 201, { success: true, id });
}

async function handleUpdateAttendance(request, response, user, attendanceId) {
  const payload = await readJson(request);
  const existing = db.prepare(`SELECT unit_id AS unitId, session_date AS sessionDate, status, notes
    FROM attendance_records WHERE id = ? AND user_id = ?`).get(attendanceId, user.id);
  if (!existing) return sendJson(response, 404, { error: "Attendance record not found." });
  const attendance = validateAttendancePayload(payload, user, existing);
  if (attendance.error) return sendJson(response, 400, { error: attendance.error });
  db.prepare(`UPDATE attendance_records SET unit_id = ?, session_date = ?, status = ?, notes = ?, updated_at = ?
    WHERE id = ? AND user_id = ?`)
    .run(attendance.unitId, attendance.sessionDate, attendance.status, attendance.notes,
      new Date().toISOString(), attendanceId, user.id);
  recordActivity(user, "Updated a class attendance record");
  return sendJson(response, 200, { success: true });
}

function handleDeleteAttendance(response, user, attendanceId) {
  const result = db.prepare("DELETE FROM attendance_records WHERE id = ? AND user_id = ?").run(attendanceId, user.id);
  if (result.changes === 0) return sendJson(response, 404, { error: "Attendance record not found." });
  recordActivity(user, "Removed a class attendance record");
  return sendJson(response, 200, { success: true });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unitCodePattern(code) {
  const parts = code.match(/[A-Za-z]+|\d+/g) || [code];
  return new RegExp(`(^|[^A-Za-z0-9])(${parts.map(escapeRegExp).join("[\\s/_-]*")})(?=$|[^A-Za-z0-9])`, "i");
}

function matchUnitInText(text, units) {
  return [...units].sort((a, b) => b.code.length - a.code.length)
    .find((unit) => unitCodePattern(unit.code).test(text)) || null;
}

function parseTimeValues(text) {
  const matches = [...text.matchAll(/\b(\d{1,2})(?::|\.|h)(\d{2})\s*(am|pm)?\b|\b(\d{1,2})\s*(am|pm)\b/gi)];
  const values = [];
  for (const match of matches) {
    let hour = Number(match[1] || match[4]);
    const minute = Number(match[2] || 0);
    const meridiem = (match[3] || match[5] || "").toLowerCase();
    if (minute > 59 || hour > 23 || (!meridiem && hour > 23)) continue;
    if (meridiem) {
      if (hour < 1 || hour > 12) continue;
      hour = hour % 12 + (meridiem === "pm" ? 12 : 0);
    }
    const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    if (!values.includes(time)) values.push(time);
  }
  return values;
}

function parseWeekday(text) {
  const match = /\b(mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/i.exec(text);
  if (!match) return null;
  const day = match[1].slice(0, 3).toLowerCase();
  return ({ sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 })[day];
}

function parseExamDate(text) {
  const iso = /\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/.exec(text);
  let year;
  let month;
  let day;
  if (iso) {
    [, year, month, day] = iso;
  } else {
    const numeric = /\b(\d{1,2})[-/.](\d{1,2})[-/.](20\d{2})\b/.exec(text);
    if (numeric) [, day, month, year] = numeric;
    else {
      const named = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(20\d{2})\b/i.exec(text)
        || /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/i.exec(text);
      if (!named) return "";
      const monthName = named[2] ? named[2] : named[1];
      const dayNumber = named[2] ? named[1] : named[2];
      const parsed = new Date(`${monthName} ${dayNumber}, ${named[3]} 00:00:00 UTC`);
      if (Number.isNaN(parsed.getTime())) return "";
      return `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, "0")}-${String(parsed.getUTCDate()).padStart(2, "0")}`;
    }
  }
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (parsed.getUTCFullYear() !== Number(year) || parsed.getUTCMonth() + 1 !== Number(month)
    || parsed.getUTCDate() !== Number(day)) return "";
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function cleanVenue(value) {
  return value.split(/\b(?:lecturer|instructor|duration)\s*[:=-]/i)[0]
    .replace(/\b\d+(?:\.\d+)?\s*(?:hours?|hrs?|h|minutes?|mins?)\b.*$/i, "")
    .replace(/^[\s,;|:–—-]+|[\s,;|:–—-]+$/g, "")
    .trim().slice(0, 120);
}

function extractVenue(text, unit) {
  const labeled = /\b(?:venue|room|location)\s*[:=-]\s*([^|;\n]+)/i.exec(text);
  if (labeled) return cleanVenue(labeled[1]);
  const explicitLecturer = /\b(?:lecturer|instructor)\s*[:=-]\s*([^|;\n]+)/i.exec(text);
  const columns = text.split(/\s{2,}|\t+|\|/).map((value) => value.trim()).filter(Boolean);
  const candidates = columns.filter((column) => column.length <= 120
    && !unitCodePattern(unit.code).test(column)
    && parseWeekday(column) === null
    && !parseTimeValues(column).length
    && !parseExamDate(column)
    && !/^(?:unit|code|day|date|time|venue|room|lecturer|instructor)$/i.test(column));
  if (candidates.length) return cleanVenue(candidates[candidates.length - 1].replace(/^(?:venue|room|location)\s*[:=-]\s*/i, ""));
  const times = [...text.matchAll(/\b\d{1,2}(?::|\.|h)\d{2}\s*(?:am|pm)?|\b\d{1,2}\s*(?:am|pm)\b/gi)];
  if (times.length) {
    let suffix = text.slice(times[times.length - 1].index + times[times.length - 1][0].length);
    suffix = suffix.split(/\b(?:lecturer|instructor)\s*[:=-]/i)[0]
      .split(/\b(?:duration)\s*[:=-]/i)[0]
      .replace(/\b\d+(?:\.\d+)?\s*(?:hours?|hrs?|h|minutes?|mins?)\b.*$/i, "")
      .replace(/^\s*[-–—,;|:]+\s*/, "").trim();
    if (suffix && suffix.length <= 120 && !unitCodePattern(unit.code).test(suffix)) return suffix;
  }
  if (explicitLecturer) return "";
  return "";
}

function parseTimetableRows(text, type, units) {
  const lines = text.replace(/\f/g, "\n").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const rows = [];
  const unmatchedCodes = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const unit = matchUnitInText(lines[index], units);
    if (!unit) {
      const candidate = /\b[A-Z]{2,}\s*[-/]?\s*\d{2,}\b/i.exec(lines[index]);
      if (candidate) unmatchedCodes.add(candidate[0].replace(/\s+/g, " ").trim().toUpperCase());
      continue;
    }
    let block = lines[index];
    for (let next = index + 1; next < Math.min(lines.length, index + 4); next += 1) {
      if (matchUnitInText(lines[next], units)) break;
      block += `  ${lines[next]}`;
    }
    const times = parseTimeValues(block);
    const venue = extractVenue(block, unit);
    let row;
    if (type === "class") {
      const lecturerMatch = /\b(?:lecturer|instructor)\s*[:=-]\s*([^|;\n]+)/i.exec(block);
      row = {
        unitId: unit.id,
        dayOfWeek: parseWeekday(block),
        startTime: times[0] || "",
        endTime: times[1] || "",
        venue,
        lecturer: lecturerMatch ? cleanVenue(lecturerMatch[1]) : unit.instructor || ""
      };
    } else {
      row = {
        unitId: unit.id,
        examDate: parseExamDate(block),
        examTime: times[0] || "",
        venue,
        duration: (() => {
          const hours = /\b(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/i.exec(block);
          const minutes = /\b(\d{1,3})\s*(?:minutes?|mins?)\b/i.exec(block);
          if (!hours && !minutes) return null;
          return Math.round((hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0));
        })()
      };
    }
    const signature = JSON.stringify(row);
    if (!rows.some((entry) => JSON.stringify(entry) === signature)) rows.push(row);
  }
  return { rows, unmatchedCodes: [...unmatchedCodes].slice(0, 40) };
}

async function handleTimetableParse(request, response, user) {
  if (!checkRateLimit(request, response, "timetable-parse", 5)) return;
  const payload = await readJson(request, MAX_TIMETABLE_BODY_BYTES);
  if (!payload || !["class", "exam"].includes(payload.type)
    || typeof payload.name !== "string" || payload.name.length > 180
    || typeof payload.data !== "string") {
    return sendJson(response, 400, { error: "Choose a PDF timetable and specify whether it is a class or exam timetable." });
  }
  const match = /^data:application\/pdf;base64,([A-Za-z0-9+/]+={0,2})$/i.exec(payload.data);
  if (!match) return sendJson(response, 415, { error: "Upload a PDF file only." });
  const pdf = Buffer.from(match[1], "base64");
  if (!pdf.length || pdf.length > MAX_TIMETABLE_PDF_BYTES) {
    return sendJson(response, 413, { error: "Timetable PDFs must be 10 MB or smaller." });
  }
  if (pdf.subarray(0, 5).toString() !== "%PDF-") {
    return sendJson(response, 415, { error: "The selected file is not a valid PDF document." });
  }
  const units = db.prepare("SELECT id, code, title, instructor FROM units WHERE user_id = ? ORDER BY length(code) DESC").all(user.id);
  if (!units.length) return sendJson(response, 400, { error: "Add your units in Academic year & units before uploading a timetable." });

  const parser = new PDFParse({ data: pdf });
  try {
    const info = await parser.getInfo();
    if (Number.isInteger(info.total) && info.total > 60) {
      return sendJson(response, 413, { error: "Timetable PDFs are limited to 60 pages. Export just the timetable pages and upload again." });
    }
    const extracted = await parser.getText();
    const text = (extracted.text || "").replace(/--\s*\d+\s+of\s+\d+\s*--/gi, "");
    if (!text.trim()) {
      return sendJson(response, 200, {
        rows: [],
        unmatchedCodes: [],
        warning: "This PDF has no selectable text. It may be a scanned image; add the timetable rows manually in the review table."
      });
    }
    const result = parseTimetableRows(text, payload.type, units);
    return sendJson(response, 200, {
      ...result,
      warning: result.rows.length
        ? ""
        : "No timetable rows could be matched to your saved units. Add rows manually below or check that the PDF uses selectable text."
    });
  } catch (error) {
    console.error("Timetable PDF parsing failed:", error.message);
    return sendJson(response, 422, { error: "Could not read this PDF. Try exporting it again, or add the timetable rows manually." });
  } finally {
    await parser.destroy();
  }
}

function normalizeSessionTime(value) {
  if (value === "") return true;
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function validateTimetableRows(rows, type, user) {
  if (!Array.isArray(rows) || rows.length > 250) return { error: "Review and confirm no more than 250 timetable rows at a time." };
  const validUnit = db.prepare("SELECT 1 FROM units WHERE id = ? AND user_id = ?");
  for (const row of rows) {
    if (!row || typeof row.unitId !== "string" || !validUnit.get(row.unitId, user.id)) {
      return { error: "Every confirmed timetable row must be linked to one of your saved units." };
    }
    if (type === "class") {
      if (!(row.dayOfWeek === null || row.dayOfWeek === "" || (Number.isInteger(row.dayOfWeek) && row.dayOfWeek >= 0 && row.dayOfWeek <= 6))
        || !normalizeSessionTime(row.startTime) || !normalizeSessionTime(row.endTime)
        || typeof row.venue !== "string" || row.venue.trim().length > 120
        || typeof row.lecturer !== "string" || row.lecturer.trim().length > 120) {
        return { error: "Check each class row’s day, time, venue, and lecturer." };
      }
    } else {
      const dateValid = row.examDate === "" || (typeof row.examDate === "string"
        && /^\d{4}-\d{2}-\d{2}$/.test(row.examDate)
        && new Date(`${row.examDate}T00:00:00.000Z`).toISOString().slice(0, 10) === row.examDate);
      if (!dateValid || !normalizeSessionTime(row.examTime)
        || typeof row.venue !== "string" || row.venue.trim().length > 120
        || !(row.duration === null || row.duration === "" || (Number.isInteger(row.duration) && row.duration >= 1 && row.duration <= 600))) {
        return { error: "Check each exam row’s date, time, venue, and duration." };
      }
    }
  }
  return { rows };
}

function handleConfirmTimetable(request, response, user, type, draftRows) {
  if (!checkRateLimit(request, response, "timetable-confirm", 20)) return;
  const validated = validateTimetableRows(draftRows, type, user);
  if (validated.error) return sendJson(response, 400, { error: validated.error });
  const rows = validated.rows;
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    if (type === "class") {
      db.prepare("DELETE FROM class_sessions WHERE user_id = ?").run(user.id);
      const insert = db.prepare(`INSERT INTO class_sessions
        (id, user_id, unit_id, day_of_week, start_time, end_time, venue, lecturer, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const row of rows) {
        insert.run(crypto.randomUUID(), user.id, row.unitId,
          row.dayOfWeek === "" ? null : row.dayOfWeek,
          row.startTime, row.endTime, row.venue.trim(), row.lecturer.trim(), now);
      }
    } else {
      db.prepare("DELETE FROM exam_sessions WHERE user_id = ?").run(user.id);
      const insert = db.prepare(`INSERT INTO exam_sessions
        (id, user_id, unit_id, exam_date, exam_time, exam_datetime, venue, duration, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const row of rows) {
        const examDateTime = row.examDate && row.examTime
          ? new Date(`${row.examDate}T${row.examTime}:00+03:00`).toISOString()
          : null;
        insert.run(crypto.randomUUID(), user.id, row.unitId, row.examDate || null, row.examTime,
          examDateTime, row.venue.trim(), row.duration === "" ? null : row.duration, now);
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  recordActivity(user, `Confirmed ${type} timetable (${rows.length} rows)`);
  return sendJson(response, 200, { success: true, count: rows.length });
}

function isScheduleOccurrence(baseDate, repeat, occurrenceDate) {
  const base = new Date(baseDate);
  const target = new Date(`${occurrenceDate}T00:00:00.000Z`);
  const dayDifference = Math.floor((Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate())
    - Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate())) / 86400000);
  if (repeat === "none") return Math.abs(dayDifference) <= 1;
  if (repeat === "daily") return dayDifference >= -1;
  if (repeat === "weekly") {
    const remainder = ((dayDifference % 7) + 7) % 7;
    return dayDifference >= -1 && Math.min(remainder, 7 - remainder) <= 1;
  }
  if (repeat === "monthly") {
    const monthDifference = (target.getUTCFullYear() - base.getUTCFullYear()) * 12
      + target.getUTCMonth() - base.getUTCMonth();
    const monthEnd = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    return monthDifference >= 0 && Math.abs(target.getUTCDate() - Math.min(base.getUTCDate(), monthEnd)) <= 1;
  }
  return false;
}

async function handleProfileUpdate(request, response, user) {
  const payload = await readJson(request);
  const fields = ["profileName", "phone", "school"];
  if (!payload || fields.some((field) => typeof payload[field] !== "string")
    || (payload.course !== undefined && typeof payload.course !== "string")) {
    return sendJson(response, 400, { error: "Enter a valid name, phone number, and school." });
  }
  const profileName = payload.profileName.trim();
  const phone = payload.phone.trim();
  const school = payload.school.trim();
  const course = (payload.course === undefined ? user.course : payload.course).trim();
  if (profileName.length > 80 || phone.length > 40 || school.length > 120 || course.length > 120) {
    return sendJson(response, 400, { error: "Name, phone, or school is longer than allowed." });
  }
  db.prepare("UPDATE users SET profile_name = ?, phone = ?, school = ?, course = ? WHERE id = ?")
    .run(profileName, phone, school, course, user.id);
  user.profileName = profileName;
  user.phone = phone;
  user.school = school;
  user.course = course;
  recordActivity(user, "Updated profile details");
  return sendJson(response, 200, { user: publicUser(user) });
}

async function handleUpload(request, response, user) {
  const payload = await readJson(request, Math.ceil(MAX_UPLOAD_BYTES * 1.4));
  const acceptedTypes = new Set([
    "application/pdf", "text/plain", "image/jpeg", "image/png", "image/gif", "image/webp",
    "video/mp4", "video/webm", "video/quicktime",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  ]);
  if (!payload || typeof payload.name !== "string" || typeof payload.mime !== "string"
    || typeof payload.data !== "string" || !acceptedTypes.has(payload.mime)) {
    return sendJson(response, 400, { error: "Choose a supported school document, image, or video." });
  }
  const dataMatch = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(payload.data);
  const extension = path.extname(payload.name).toLowerCase();
  const fileType = FILE_TYPES.get(extension);
  if (!dataMatch || dataMatch[1] !== payload.mime || !fileType || fileType.mime !== payload.mime) {
    return sendJson(response, 400, { error: "The selected file could not be read." });
  }
  const contents = Buffer.from(dataMatch[2], "base64");
  if (!contents.length || contents.length > MAX_UPLOAD_BYTES) {
    return sendJson(response, 413, { error: "Files must be smaller than 20 MB." });
  }
  if (!fileType.signature(contents)) {
    return sendJson(response, 400, { error: "The file contents do not match the selected file type." });
  }
  const name = payload.name.split(/[\\/]/).pop().replace(/[\u0000-\u001f]/g, "").trim().slice(0, 180);
  const folder = typeof payload.folder === "string" ? payload.folder.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 60) : "";
  if (!name) return sendJson(response, 400, { error: "Give the file a valid name." });
  const storageUsed = db.prepare("SELECT COALESCE(SUM(size), 0) AS total FROM files WHERE user_id = ?").get(user.id).total;
  const quotaBytes = Number(db.prepare("SELECT storage_quota_bytes FROM users WHERE id = ?").get(user.id)?.storage_quota_bytes) || STORAGE_QUOTA_BYTES;
  if (storageUsed + contents.length > quotaBytes) {
    return sendJson(response, 413, { error: "Your storage quota would be exceeded. Delete files you no longer need and try again." });
  }

  const id = crypto.randomUUID();
  const item = { id, name, mime: payload.mime, size: contents.length, folder, createdAt: new Date().toISOString() };
  db.prepare("INSERT INTO files (id, user_id, name, mime, size, folder, created_at, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, user.id, name, payload.mime, contents.length, folder, item.createdAt, contents);
  recordActivity(user, `Uploaded a file: ${name}`);
  return sendJson(response, 201, { item });
}

async function handleFileUpdate(request, response, user, fileId) {
  const payload = await readJson(request);
  if (!payload || typeof payload !== "object") {
    return sendJson(response, 400, { error: "Enter a valid file name and folder." });
  }
  const existing = db.prepare("SELECT name, folder, mime FROM files WHERE id = ? AND user_id = ?").get(fileId, user.id);
  if (!existing) return sendJson(response, 404, { error: "File not found." });
  const name = payload.name === undefined ? existing.name : payload.name;
  const folder = payload.folder === undefined ? existing.folder : payload.folder;
  if (typeof name !== "string" || !name.trim() || name.trim().length > 180
    || name !== name.split(/[\\/]/).pop()
    || /[\u0000-\u001f]/.test(name)
    || typeof folder !== "string" || folder.length > 60 || /[\u0000-\u001f]/.test(folder)) {
    return sendJson(response, 400, { error: "Use a file name up to 180 characters and a folder name up to 60 characters." });
  }
  if (FILE_TYPES.get(path.extname(name).toLowerCase())?.mime !== existing.mime) {
    return sendJson(response, 400, { error: "Keep the file extension consistent with its stored type." });
  }
  db.prepare("UPDATE files SET name = ?, folder = ? WHERE id = ? AND user_id = ?")
    .run(name.trim(), folder.trim(), fileId, user.id);
  recordActivity(user, `Organized a file: ${name.trim()}`);
  return sendJson(response, 200, { success: true });
}

async function handleAvatarUpload(request, response, user) {
  const payload = await readJson(request, 3 * 1024 * 1024);
  if (!payload || typeof payload.mime !== "string" || typeof payload.name !== "string"
    || typeof payload.data !== "string") {
    return sendJson(response, 400, { error: "Choose a PNG, JPG, or WebP profile photo." });
  }
  const allowedExtensions = new Set([".png", ".jpg", ".jpeg", ".webp"]);
  const extension = path.extname(payload.name).toLowerCase();
  const fileType = FILE_TYPES.get(extension);
  if (!allowedExtensions.has(extension) || !fileType || fileType.mime !== payload.mime) {
    return sendJson(response, 400, { error: "Profile photos must be a PNG, JPG, or WebP image." });
  }
  const match = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(payload.data);
  if (!match || match[1] !== payload.mime) return sendJson(response, 400, { error: "The selected photo could not be read." });
  const contents = Buffer.from(match[2], "base64");
  if (!contents.length || contents.length > 2 * 1024 * 1024) {
    return sendJson(response, 413, { error: "Profile photos must be 2 MB or smaller." });
  }
  if (!fileType.signature(contents)) {
    return sendJson(response, 400, { error: "The photo contents do not match the selected image type." });
  }
  db.prepare(`INSERT INTO profile_avatars (user_id, mime, content, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET mime = excluded.mime, content = excluded.content, updated_at = excluded.updated_at`)
    .run(user.id, payload.mime, contents, new Date().toISOString());
  recordActivity(user, "Updated profile photo");
  return sendJson(response, 200, { user: publicUser(user) });
}

async function handleUserMessage(request, response, user) {
  const payload = await readJson(request);
  if (!payload || typeof payload.message !== "string" || !payload.message.trim() || payload.message.trim().length > 1000) {
    return sendJson(response, 400, { error: "Write a message of up to 1,000 characters." });
  }
  const item = { id: crypto.randomUUID(), type: "message", sender: "user", text: payload.message.trim(), createdAt: new Date().toISOString() };
  db.prepare("INSERT INTO inbox (id, user_id, type, sender, text, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(item.id, user.id, item.type, item.sender, item.text, item.createdAt);
  recordActivity(user, "Contacted the administrator");
  return sendJson(response, 201, { item });
}

async function handleAdminAction(request, response, action) {
  if (!getAdminForRequest(request)) {
    return sendJson(response, 401, { error: "Sign in with an administrator account to continue." });
  }
  const payload = await readJson(request);
  if (action === "logout-user") {
    if (!payload || typeof payload.email !== "string") return sendJson(response, 400, { error: "Choose a valid account." });
    const user = users.get(payload.email.trim().toLowerCase());
    if (!user) return sendJson(response, 404, { error: "That account was not found." });
    for (const [token, session] of sessions) {
      if (session.userId === user.id) sessions.delete(token);
    }
    recordActivity(user, "Administrator signed out this user");
    recordAdminAction("Signed out student sessions", user.email);
    return sendJson(response, 200, { success: true });
  }
  if (action === "reply" || action === "notify") {
    const email = action === "reply" ? payload && payload.email : payload && payload.email;
    const message = payload && payload.message;
    if (typeof message !== "string" || !message.trim() || message.trim().length > 1000) {
      return sendJson(response, 400, { error: "Write a message of up to 1,000 characters." });
    }
    if (email !== null && email !== undefined && typeof email !== "string") {
      return sendJson(response, 400, { error: "Choose a valid account or all users." });
    }
    const recipients = email
      ? [...users.values()].filter((user) => user.email === email.trim().toLowerCase())
      : action === "notify" ? [...users.values()] : [];
    if (!recipients.length) return sendJson(response, 404, { error: "No matching account was found." });
    for (const user of recipients) {
      recordInbox(user.id, { type: "notification", sender: "admin", text: message.trim() });
    }
    recordAdminAction(action === "reply" ? "Replied to student" : "Sent notification", email || `all (${recipients.length})`);
    return sendJson(response, 201, { success: true });
  }
  return sendJson(response, 404, { error: "Not found." });
}

async function handleRequest(request, response) {
  setSecurityHeaders(response);
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const route = `${request.method} ${url.pathname}`;
  if (url.pathname.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    let originHost = "";
    try {
      originHost = new URL(request.headers.origin || "").host;
    } catch {
      return sendJson(response, 403, { error: "This request could not be verified. Reload the page and try again." });
    }
    if (!originHost || originHost !== request.headers.host) {
      return sendJson(response, 403, { error: "This request could not be verified. Reload the page and try again." });
    }
    if (!checkRateLimit(request, response, "workspace", WORKSPACE_RATE_LIMIT)) return;
  }

  if (url.pathname.startsWith("/api/admin/") && route !== "GET /api/admin/session" && route !== "POST /api/admin/login") {
    if (!getAdminForRequest(request)) return sendJson(response, 401, { error: "Sign in with an administrator account to continue." });
    if (!checkRateLimit(request, response, "admin-api", 240)) return;
  }

  if (route === "GET /api/session") {
    const user = getUserForRequest(request);
    return sendJson(response, 200, { user: user ? publicUser(user) : null });
  }
  if (route === "POST /api/account/verify-email") return handleVerifyEmail(request, response);
  if (route === "POST /api/email/resend-verification") return handleResendVerification(request, response);
  if (route === "POST /api/password/forgot") return handleForgotPassword(request, response);
  if (route === "POST /api/password/reset") return handleResetPassword(request, response);
  if (route === "GET /api/avatar") {
    const user = getUserForRequest(request);
    if (!user) return sendJson(response, 401, { error: "Sign in to view your profile photo." });
    const avatar = db.prepare("SELECT mime, content FROM profile_avatars WHERE user_id = ?").get(user.id);
    if (!avatar) return sendJson(response, 404, { error: "No profile photo has been uploaded." });
    const content = Buffer.from(avatar.content);
    response.writeHead(200, {
      "Content-Type": avatar.mime,
      "Content-Length": content.length,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff"
    });
    response.end(content);
    return;
  }
  if (route === "POST /api/avatar") {
    const user = getUserForRequest(request);
    return user ? handleAvatarUpload(request, response, user) : sendJson(response, 401, { error: "Sign in to update your profile photo." });
  }
  if (route === "DELETE /api/avatar") {
    const user = getUserForRequest(request);
    if (!user) return sendJson(response, 401, { error: "Sign in to manage your profile photo." });
    db.prepare("DELETE FROM profile_avatars WHERE user_id = ?").run(user.id);
    recordActivity(user, "Removed profile photo");
    return sendJson(response, 200, { user: publicUser(user) });
  }
  if (route === "GET /api/workspace") {
    const user = getUserForRequest(request);
    if (!user) return sendJson(response, 401, { error: "Sign in to view your workspace." });
    const workspace = getWorkspace(user.id);
    return sendJson(response, 200, {
      user: publicUser(user),
      schedule: workspace.schedule,
      units: workspace.units,
      academicSettings: workspace.academicSettings,
      attendance: workspace.attendance,
      classSessions: workspace.classSessions,
      examSessions: workspace.examSessions,
      files: workspace.files,
      inbox: workspace.inbox,
      storageUsedBytes: workspace.storageUsedBytes,
      storageQuotaBytes: user.storageQuotaBytes || STORAGE_QUOTA_BYTES
    });
  }
  if (route === "GET /api/account/export") {
    const user = getUserForRequest(request);
    return user ? handleStudentDataExport(response, user) : sendJson(response, 401, { error: "Sign in to download your account data." });
  }
  if (route === "POST /api/timetable/parse") {
    const user = getUserForRequest(request);
    return user ? handleTimetableParse(request, response, user) : sendJson(response, 401, { error: "Sign in to upload a timetable." });
  }
  if (route === "POST /api/timetable/confirm") {
    const user = getUserForRequest(request);
    if (!user) return sendJson(response, 401, { error: "Sign in to confirm your timetable." });
    const payload = await readJson(request, MAX_TIMETABLE_CONFIRM_BODY_BYTES);
    if (!payload || !["class", "exam"].includes(payload.type)) {
      return sendJson(response, 400, { error: "Choose whether to confirm a class or exam timetable." });
    }
    return handleConfirmTimetable(request, response, user, payload.type, payload.rows);
  }
  if (route === "PATCH /api/profile") {
    const user = getUserForRequest(request);
    return user ? handleProfileUpdate(request, response, user) : sendJson(response, 401, { error: "Sign in to edit your profile." });
  }
  if (route === "PATCH /api/academic-settings") {
    const user = getUserForRequest(request);
    return user ? handleAcademicSettings(request, response, user) : sendJson(response, 401, { error: "Sign in to edit your academic year." });
  }
  if (route === "POST /api/units") {
    const user = getUserForRequest(request);
    return user ? handleCreateUnit(request, response, user) : sendJson(response, 401, { error: "Sign in to manage your academic units." });
  }
  if (route === "POST /api/attendance") {
    const user = getUserForRequest(request);
    return user ? handleCreateAttendance(request, response, user) : sendJson(response, 401, { error: "Sign in to record class attendance." });
  }
  if (request.method === "PATCH" && url.pathname.startsWith("/api/attendance/")) {
    const user = getUserForRequest(request);
    if (!user) return sendJson(response, 401, { error: "Sign in to manage attendance records." });
    const attendanceId = url.pathname.slice("/api/attendance/".length);
    if (!/^[0-9a-f-]{36}$/i.test(attendanceId)) return sendJson(response, 404, { error: "Attendance record not found." });
    return handleUpdateAttendance(request, response, user, attendanceId);
  }
  if (request.method === "DELETE" && url.pathname.startsWith("/api/attendance/")) {
    const user = getUserForRequest(request);
    if (!user) return sendJson(response, 401, { error: "Sign in to manage attendance records." });
    const attendanceId = url.pathname.slice("/api/attendance/".length);
    if (!/^[0-9a-f-]{36}$/i.test(attendanceId)) return sendJson(response, 404, { error: "Attendance record not found." });
    return handleDeleteAttendance(response, user, attendanceId);
  }
  if (request.method === "PATCH" && url.pathname.startsWith("/api/units/")) {
    const user = getUserForRequest(request);
    if (!user) return sendJson(response, 401, { error: "Sign in to manage your academic units." });
    const unitId = url.pathname.slice("/api/units/".length);
    if (!/^[0-9a-f-]{36}$/i.test(unitId)) return sendJson(response, 404, { error: "Academic unit not found." });
    return handleUpdateUnit(request, response, user, unitId);
  }
  if (request.method === "DELETE" && url.pathname.startsWith("/api/units/")) {
    const user = getUserForRequest(request);
    if (!user) return sendJson(response, 401, { error: "Sign in to manage your academic units." });
    const unitId = url.pathname.slice("/api/units/".length);
    if (!/^[0-9a-f-]{36}$/i.test(unitId)) return sendJson(response, 404, { error: "Academic unit not found." });
    return handleDeleteUnit(response, user, unitId);
  }
  if (route === "PATCH /api/password") {
    const user = getUserForRequest(request);
    return user ? handleChangePassword(request, response, user) : sendJson(response, 401, { error: "Sign in to change your password." });
  }
  if (route === "DELETE /api/account") {
    const user = getUserForRequest(request);
    return user ? handleDeleteAccount(request, response, user) : sendJson(response, 401, { error: "Sign in to delete your account." });
  }
  if (route === "POST /api/schedule") {
    const user = getUserForRequest(request);
    return user ? handleSchedule(request, response, user) : sendJson(response, 401, { error: "Sign in to add a schedule." });
  }
  if (route === "POST /api/files") {
    const user = getUserForRequest(request);
    return user ? handleUpload(request, response, user) : sendJson(response, 401, { error: "Sign in to upload files." });
  }
  if (route === "POST /api/messages") {
    const user = getUserForRequest(request);
    return user ? handleUserMessage(request, response, user) : sendJson(response, 401, { error: "Sign in to contact support." });
  }
  if (request.method === "PATCH" && url.pathname.startsWith("/api/schedule/")) {
    const user = getUserForRequest(request);
    if (!user) return sendJson(response, 401, { error: "Sign in to edit your schedule." });
    const itemId = url.pathname.slice("/api/schedule/".length);
    return handleScheduleUpdate(request, response, user, itemId);
  }
  if (request.method === "DELETE" && url.pathname.startsWith("/api/schedule/")) {
    const user = getUserForRequest(request);
    if (!user) return sendJson(response, 401, { error: "Sign in to edit your schedule." });
    const itemId = url.pathname.slice("/api/schedule/".length);
    const result = db.prepare("DELETE FROM schedule WHERE id = ? AND user_id = ?").run(itemId, user.id);
    if (result.changes === 0) return sendJson(response, 404, { error: "Schedule item not found." });
    recordActivity(user, "Removed a schedule item");
    return sendJson(response, 200, { success: true });
  }
  if (request.method === "PATCH" && url.pathname.startsWith("/api/files/")) {
    const user = getUserForRequest(request);
    if (!user) return sendJson(response, 401, { error: "Sign in to manage your files." });
    const fileId = url.pathname.slice("/api/files/".length);
    if (!/^[0-9a-f-]{36}$/i.test(fileId)) return sendJson(response, 404, { error: "File not found." });
    return handleFileUpdate(request, response, user, fileId);
  }
  if (request.method === "DELETE" && url.pathname.startsWith("/api/files/")) {
    const user = getUserForRequest(request);
    if (!user) return sendJson(response, 401, { error: "Sign in to manage your files." });
    const fileId = url.pathname.slice("/api/files/".length);
    const result = db.prepare("DELETE FROM files WHERE id = ? AND user_id = ?").run(fileId, user.id);
    if (result.changes === 0) return sendJson(response, 404, { error: "File not found." });
    recordActivity(user, "Deleted a stored file");
    return sendJson(response, 200, { success: true });
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/files/")) {
    const user = getUserForRequest(request);
    if (!user) return sendJson(response, 401, { error: "Sign in to download your files." });
    const preview = url.pathname.endsWith("/preview");
    const fileId = url.pathname.slice("/api/files/".length, preview ? -"/preview".length : undefined);
    if (!/^[0-9a-f-]{36}$/i.test(fileId)) return sendJson(response, 404, { error: "File not found." });
    const item = db.prepare("SELECT name, mime, content FROM files WHERE id = ? AND user_id = ?").get(fileId, user.id);
    if (!item || !item.content) return sendJson(response, 404, { error: "The stored file is unavailable." });
    const previewTypes = new Set(["application/pdf", "image/jpeg", "image/png", "image/gif", "image/webp", "video/mp4", "video/webm", "video/quicktime"]);
    if (preview && !previewTypes.has(item.mime)) return sendJson(response, 415, { error: "Preview is not available for this file type." });
    db.prepare("UPDATE files SET opened_at = ? WHERE id = ? AND user_id = ?")
      .run(new Date().toISOString(), fileId, user.id);
    const contents = Buffer.from(item.content);
    response.writeHead(200, {
      "Content-Type": item.mime,
      "Content-Length": contents.length,
      "Content-Disposition": `${preview ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(item.name)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff"
    });
    response.end(contents);
    return;
  }
  if (route === "GET /api/admin/session") {
    return sendJson(response, 200, {
      configured: hasAdminCredentials(),
      authenticated: Boolean(getAdminForRequest(request))
    });
  }
  if (route === "POST /api/admin/login") return handleAdminLogin(request, response);
  if (route === "GET /api/admin/overview") return handleAdminOverview(response);
  if (route === "GET /api/admin/users") return handleAdminUsers(request, response);
  if (route === "POST /api/admin/student-action") return handleAdminStudentAction(request, response);
  if (route === "POST /api/admin/logout-user") return handleAdminAction(request, response, "logout-user");
  if (route === "GET /api/admin/support") return handleAdminSupport(response);
  if (route === "POST /api/admin/support-action") return handleAdminSupportAction(request, response);
  if (route === "GET /api/admin/announcements") {
    dispatchScheduledAnnouncements();
    return sendJson(response, 200, { announcements: db.prepare("SELECT audience, target, message, scheduled_at AS scheduledAt, sent_at AS sentAt, status, error, created_at AS createdAt FROM admin_announcements ORDER BY created_at DESC LIMIT 300").all() });
  }
  if (route === "POST /api/admin/announcements") return handleAdminAnnouncement(request, response);
  if (route === "GET /api/admin/academic") return handleAdminAcademic(response);
  if (route === "POST /api/admin/academic") return handleAdminAcademicAction(request, response);
  if (route === "GET /api/admin/storage") return handleAdminStorage(response);
  if (route === "DELETE /api/admin/storage") return handleAdminStorageAction(request, response);
  if (route === "GET /api/admin/audit") return handleAdminAudit(request, response);
  if (route === "GET /api/admin/report.pdf") return handleAdminReport(response);
  if (route === "GET /api/admin/students.csv") {
    const rows = adminStudentRows().all();
    recordAdminAction("Exported student list as CSV", `${rows.length} records`);
    return sendCsv(response, "obadian-students.csv", ["Email", "Name", "School", "Course", "Year", "Semester", "Verified", "Approved", "Suspended", "Created", "Last active", "Storage bytes", "Quota bytes"],
      rows.map((row) => [row.email, row.profileName, row.school, row.course, row.yearOfStudy, row.semester, row.emailVerified ? "Yes" : "No", row.approved ? "Yes" : "No", row.suspended ? "Yes" : "No", row.createdAt, row.lastActive, row.storageUsed, row.storageQuotaBytes]));
  }
  if (route === "GET /api/admin/backup") return handleAdminBackup(response);
  if (route === "POST /api/admin/logout-all") {
    const count = adminSessions.size;
    adminSessions.clear();
    recordAdminAction("Signed out all administrator sessions", `${count} sessions`);
    expireSession(response, ADMIN_SESSION_COOKIE);
    return sendJson(response, 200, { success: true });
  }
  if (route === "POST /api/admin/reply") return handleAdminAction(request, response, "reply");
  if (route === "POST /api/admin/notify") return handleAdminAction(request, response, "notify");
  if (route === "POST /api/admin/logout") {
    const token = readCookies(request).get(ADMIN_SESSION_COOKIE);
    if (token) adminSessions.delete(token);
    recordAdminAction("Signed out", process.env.ADMIN_EMAIL || "admin");
    expireSession(response, ADMIN_SESSION_COOKIE);
    return sendJson(response, 200, { success: true });
  }
  if (route === "POST /api/register") return handleRegister(request, response);
  if (route === "POST /api/login") return handleLogin(request, response);
  if (route === "POST /api/logout") {
    const token = readCookies(request).get(SESSION_COOKIE);
    if (token) sessions.delete(token);
    expireSession(response);
    return sendJson(response, 200, { success: true });
  }
  if (request.method === "GET" && staticFiles.has(url.pathname)) {
    const [fileName, contentType] = staticFiles.get(url.pathname);
    const contents = fs.readFileSync(path.join(ROOT, fileName));
    response.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-cache" });
    response.end(contents);
    return;
  }
  return sendJson(response, 404, { error: "Not found." });
}

initializeDatabase();
dispatchScheduledAnnouncements();
const announcementTimer = setInterval(dispatchScheduledAnnouncements, 30_000);
announcementTimer.unref();
const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    if (response.headersSent || response.destroyed) {
      console.error("Request failed after response began:", error);
      return;
    }
    if (error.status) return sendJson(response, error.status, { error: error.message });
    console.error("Request failed:", error);
    sendJson(response, 500, { error: "Something went wrong on the server. Please try again." });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Obadian Hub is running at http://${HOST}:${PORT}`);
});
