const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

test("admin controls, email outcomes, announcements, academic imports, and student data export", async (t) => {
  const dataDirectory = mkdtempSync(path.join(os.tmpdir(), "obadian-admin-test-"));
  const port = 31000 + Math.floor(Math.random() * 20000);
  const origin = `http://127.0.0.1:${port}`;
  const adminEmail = "console-test@example.test";
  const adminPassword = "test-admin-password-16";
  let startupOutput = "";
  let cookie = "";
  let db;
  db = new DatabaseSync(path.join(dataDirectory, "obadian-hub.sqlite"));
  db.exec(`CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password_hash TEXT NOT NULL,
    created_at TEXT, agreement_version TEXT, agreement_accepted_at TEXT, profile_name TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '', school TEXT NOT NULL DEFAULT '', email_verified INTEGER NOT NULL DEFAULT 1,
    course TEXT NOT NULL DEFAULT '', suspended INTEGER NOT NULL DEFAULT 0,
    storage_quota_bytes INTEGER NOT NULL DEFAULT 524288000
  )`);
  const addUser = (email, password, emailVerified = 1, school = "", course = "") => {
    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = crypto.scryptSync(password, salt, 64).toString("hex");
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO users (id, email, salt, password_hash, created_at, email_verified, school, course)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, email, salt, passwordHash, new Date().toISOString(), emailVerified, school, course);
    return id;
  };
  const studentPassword = "student-password-123";
  const suspendedId = addUser("suspended@example.test", studentPassword, 1, "North Campus", "Geography");
  const deleteId = addUser("delete@example.test", "delete-password-123", 1, "South Campus", "Geography");
  addUser("email-success@example.test", "success-password-123", 0);
  addUser("email-failure@example.test", "failure-password-123", 0);
  db.close();
  db = null;
  const mockFetchFile = path.join(dataDirectory, "mock-fetch.cjs");
  writeFileSync(mockFetchFile, [
    "const originalFetch = globalThis.fetch;",
    "globalThis.fetch = async (input, options = {}) => {",
    "  if (String(input) !== 'https://api.resend.com/emails') return originalFetch(input, options);",
    "  const recipient = JSON.parse(options.body).to[0];",
    "  if (recipient === 'email-failure@example.test') throw new Error('simulated network failure');",
    "  return new Response('{}', { status: 200 });",
    "};"
  ].join("\n"));
  const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    cwd: __dirname,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), DATA_DIRECTORY: dataDirectory, ADMIN_EMAIL: adminEmail, ADMIN_PASSWORD: adminPassword,
      RESEND_API_KEY: "test-resend-key", RESEND_FROM_EMAIL: "Obadian Hub <test@example.test>",
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${mockFetchFile}`].filter(Boolean).join(" ") },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => { startupOutput += chunk.toString(); });
  child.stderr.on("data", (chunk) => { startupOutput += chunk.toString(); });
  let childError = "";
  child.on("error", (error) => { childError = error.message; });
  t.after(async () => {
    if (db) db.close();
    child.kill();
    if (child.exitCode === null) await new Promise((resolve) => child.once("close", resolve));
    rmSync(dataDirectory, { recursive: true, force: true });
  });

  let ready = false;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      await fetch(`${origin}/api/admin/session`);
      ready = true;
      break;
    } catch { await new Promise((resolve) => setTimeout(resolve, 125)); }
    if (child.exitCode !== null) break;
  }
  assert.equal(ready, true, `test server should start (exit ${child.exitCode}, signal ${child.signalCode}): ${startupOutput} ${childError}`);

  db = new DatabaseSync(path.join(dataDirectory, "obadian-hub.sqlite"));
  db.exec("PRAGMA foreign_keys = ON");
  const unitId = crypto.randomUUID();
  db.prepare("INSERT INTO units (id, user_id, code, title, created_at) VALUES (?, ?, 'TEST101', 'Test Unit', ?)")
    .run(unitId, deleteId, new Date().toISOString());
  db.prepare("INSERT INTO academic_settings (user_id, academic_year, semester, year_of_study) VALUES (?, '2026', '1', 1)").run(deleteId);
  const scheduleId = crypto.randomUUID();
  db.prepare("INSERT INTO schedule (id, user_id, title, date) VALUES (?, ?, 'Example schedule', ?)").run(scheduleId, deleteId, new Date().toISOString());
  db.prepare("INSERT INTO schedule_completions (schedule_id, occurrence_date, completed_at) VALUES (?, '2026-10-30', ?)").run(scheduleId, new Date().toISOString());
  db.prepare(`INSERT INTO attendance_records (id, user_id, unit_id, session_date, status, created_at, updated_at)
    VALUES (?, ?, ?, '2026-10-30', 'present', ?, ?)`).run(crypto.randomUUID(), deleteId, unitId, new Date().toISOString(), new Date().toISOString());
  db.prepare(`INSERT INTO class_sessions (id, user_id, unit_id, created_at) VALUES (?, ?, ?, ?)`)
    .run(crypto.randomUUID(), deleteId, unitId, new Date().toISOString());
  db.prepare(`INSERT INTO exam_sessions (id, user_id, unit_id, created_at) VALUES (?, ?, ?, ?)`)
    .run(crypto.randomUUID(), deleteId, unitId, new Date().toISOString());
  db.prepare("INSERT INTO files (id, user_id, name, mime, size, created_at, content) VALUES (?, ?, 'private.pdf', 'application/pdf', 6, ?, ?)")
    .run(crypto.randomUUID(), deleteId, new Date().toISOString(), Buffer.from("%PDF-x"));
  const inboxId = crypto.randomUUID();
  db.prepare("INSERT INTO inbox (id, user_id, type, sender, text, created_at) VALUES (?, ?, 'message', 'user', 'Help', ?)")
    .run(inboxId, deleteId, new Date().toISOString());
  db.prepare("INSERT INTO support_status (inbox_id, status) VALUES (?, 'unread')").run(inboxId);
  db.prepare("INSERT INTO account_tokens (token_hash, user_id, type, expires_at, created_at) VALUES ('test-token-hash', ?, 'reset', ?, ?)")
    .run(deleteId, new Date(Date.now() + 60000).toISOString(), new Date().toISOString());
  db.prepare("INSERT INTO activity (email, action, created_at) VALUES ('delete@example.test', 'Test action', ?)").run(new Date().toISOString());
  db.prepare("INSERT INTO profile_avatars (user_id, mime, content, updated_at) VALUES (?, 'image/png', X'89504e47', ?)")
    .run(deleteId, new Date().toISOString());
  db.close();
  db = null;

  const anonymous = await fetch(`${origin}/api/admin/users`);
  assert.equal(anonymous.status, 401, "non-admin API request must be rejected");
  const anonymousApproval = await fetch(`${origin}/api/admin/student-action`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "approval-test@example.test", action: "approve" })
  });
  assert.equal(anonymousApproval.status, 401, "non-admins must not approve student accounts");

  const login = await fetch(`${origin}/api/admin/login`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ email: adminEmail, password: adminPassword })
  });
  assert.equal(login.status, 200);
  cookie = login.headers.getSetCookie()[0].split(";")[0];

  const adminPost = (route, payload) => fetch(`${origin}${route}`, {
    method: "POST",
    headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const registration = await fetch(`${origin}/api/register`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "approval-test@example.test",
      password: "student-chosen-password-123",
      agreeToPolicies: true
    })
  });
  assert.equal(registration.status, 201, "registration should not depend on verification-email delivery");
  assert.equal((await registration.json()).approvalRequired, true);
  const blockedLogin = await fetch(`${origin}/api/login`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "approval-test@example.test", password: "student-chosen-password-123" })
  });
  assert.equal(blockedLogin.status, 403, "new accounts must not sign in before administrator approval");
  assert.match((await blockedLogin.json()).error, /waiting for administrator approval/i);
  const pendingAccountsResponse = await fetch(`${origin}/api/admin/users?status=pending`, { headers: { Cookie: cookie } });
  assert.equal(pendingAccountsResponse.status, 200);
  const pendingAccounts = await pendingAccountsResponse.json();
  const pendingAccount = pendingAccounts.users.find((user) => user.email === "approval-test@example.test");
  assert.ok(pendingAccount, "admin student list should show pending registrations");
  assert.equal(pendingAccount.approved, false);
  const approvalOverview = await fetch(`${origin}/api/admin/overview`, { headers: { Cookie: cookie } });
  assert.equal((await approvalOverview.json()).pendingApprovals, 1, "admin overview should report pending registrations");
  const approval = await adminPost("/api/admin/student-action", { email: "approval-test@example.test", action: "approve" });
  assert.equal(approval.status, 200);
  const duplicateApproval = await adminPost("/api/admin/student-action", { email: "approval-test@example.test", action: "approve" });
  assert.equal(duplicateApproval.status, 409, "an already approved account cannot be approved twice");
  db = new DatabaseSync(path.join(dataDirectory, "obadian-hub.sqlite"));
  const approvedAccount = db.prepare("SELECT approved, email_verified AS emailVerified FROM users WHERE email = ?").get("approval-test@example.test");
  assert.equal(approvedAccount.approved, 1);
  assert.equal(approvedAccount.emailVerified, 1, "admin approval should complete email verification");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM admin_audit WHERE action = 'Approved student account and verified email' AND target = ?")
    .get("approval-test@example.test").count, 1, "approval should be written to the admin audit log");
  db.close();
  db = null;
  const approvedLogin = await fetch(`${origin}/api/login`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "approval-test@example.test", password: "student-chosen-password-123" })
  });
  assert.equal(approvedLogin.status, 200, "approved student should sign in with their own chosen password");
  const approvedCookie = approvedLogin.headers.getSetCookie()[0].split(";")[0];
  assert.equal((await fetch(`${origin}/api/workspace`, { headers: { Cookie: approvedCookie } })).status, 200);
  assert.equal((await (await fetch(`${origin}/api/admin/overview`, { headers: { Cookie: cookie } })).json()).pendingApprovals, 0);

  const signOutLogin = await fetch(`${origin}/api/login`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "suspended@example.test", password: studentPassword })
  });
  assert.equal(signOutLogin.status, 200);
  const signOutCookie = signOutLogin.headers.getSetCookie()[0].split(";")[0];
  const signOutResult = await adminPost("/api/admin/student-action", { email: "suspended@example.test", action: "logout" });
  assert.equal(signOutResult.status, 200);
  assert.equal((await fetch(`${origin}/api/workspace`, { headers: { Cookie: signOutCookie } })).status, 401,
    "administrator sign-out should invalidate the student's active session");
  const canStillLogin = await fetch(`${origin}/api/login`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "suspended@example.test", password: studentPassword })
  });
  assert.equal(canStillLogin.status, 200, "sign-out must not suspend the account");

  const initialEmailAttempt = await adminPost("/api/admin/student-action", {
    email: "email-success@example.test", action: "resend-verification"
  });
  assert.equal(initialEmailAttempt.status, 200);
  const successfulOverview = await fetch(`${origin}/api/admin/overview`, { headers: { Cookie: cookie } });
  const successfulEmailStatus = (await successfulOverview.json()).health.email;
  assert.equal(successfulEmailStatus.status, "sent");

  const failedEmailAttempt = await adminPost("/api/admin/student-action", {
    email: "email-failure@example.test", action: "resend-verification"
  });
  assert.equal(failedEmailAttempt.status, 502);
  const failedOverview = await fetch(`${origin}/api/admin/overview`, { headers: { Cookie: cookie } });
  const failedEmailStatus = (await failedOverview.json()).health.email;
  assert.match(failedEmailStatus.status, /failed: simulated network failure/);
  assert.ok(failedEmailStatus.sentAt >= successfulEmailStatus.sentAt, "latest email attempt should replace the earlier success");
  db = new DatabaseSync(path.join(dataDirectory, "obadian-hub.sqlite"));
  const persistedEmailStatus = db.prepare("SELECT value, updated_at FROM admin_runtime_state WHERE key = 'last_email_send'").get();
  assert.equal(persistedEmailStatus.value, failedEmailStatus.status, "latest failure should persist to the database");
  assert.equal(persistedEmailStatus.updated_at, failedEmailStatus.sentAt);
  db.close();
  db = null;

  const unmatchedAnnouncement = await adminPost("/api/admin/announcements", {
    audience: "student", target: "missing@example.test", message: "Must not be sent"
  });
  assert.equal(unmatchedAnnouncement.status, 422);
  assert.match((await unmatchedAnnouncement.json()).error, /No students match/);
  let announcementList = await fetch(`${origin}/api/admin/announcements`, { headers: { Cookie: cookie } });
  assert.equal((await announcementList.json()).announcements.length, 0, "unmatched targets must not create sent announcements");

  const partialAnnouncement = await adminPost("/api/admin/announcements", {
    audience: "school", target: "North Campus", message: "Partial audience"
  });
  assert.equal(partialAnnouncement.status, 201);
  const fullAnnouncement = await adminPost("/api/admin/announcements", {
    audience: "course", target: "Geography", message: "Full audience"
  });
  assert.equal(fullAnnouncement.status, 201);
  announcementList = await fetch(`${origin}/api/admin/announcements`, { headers: { Cookie: cookie } });
  const sentAnnouncements = (await announcementList.json()).announcements;
  assert.equal(sentAnnouncements.length, 2);
  assert.ok(sentAnnouncements.every((item) => item.status === "sent" && item.sentAt), "matched audiences should be marked sent");
  db = new DatabaseSync(path.join(dataDirectory, "obadian-hub.sqlite"));
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM inbox WHERE text = 'Partial audience'").get().count, 1,
    "partially matched audience should notify only its matching student");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM inbox WHERE text = 'Full audience'").get().count, 2,
    "fully matched audience should notify every matching student");
  db.close();
  db = null;
  const delayedAnnouncement = await adminPost("/api/admin/announcements", {
    audience: "school", target: "North Campus", message: "Audience changed",
    scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
  });
  assert.equal(delayedAnnouncement.status, 201);
  const delayedResult = await delayedAnnouncement.json();
  assert.equal(delayedResult.status, "scheduled");
  assert.equal(delayedResult.recipientCount, 1);
  const dueAnnouncement = await adminPost("/api/admin/announcements", {
    audience: "student", target: "suspended@example.test", message: "Scheduled delivery test",
    scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
  });
  assert.equal(dueAnnouncement.status, 201);
  assert.equal((await dueAnnouncement.json()).status, "scheduled");
  db = new DatabaseSync(path.join(dataDirectory, "obadian-hub.sqlite"));
  db.prepare("UPDATE users SET school = 'Changed Campus' WHERE email = 'suspended@example.test'").run();
  db.prepare("UPDATE admin_announcements SET scheduled_at = ? WHERE message = 'Audience changed'")
    .run(new Date(Date.now() - 1000).toISOString());
  db.prepare("UPDATE admin_announcements SET scheduled_at = ? WHERE message = 'Scheduled delivery test'")
    .run(new Date(Date.now() - 1000).toISOString());
  db.close();
  db = null;
  announcementList = await fetch(`${origin}/api/admin/announcements`, { headers: { Cookie: cookie } });
  const scheduleStatuses = (await announcementList.json()).announcements;
  const noRecipientStatus = scheduleStatuses.find((item) => item.message === "Audience changed");
  assert.equal(noRecipientStatus.status, "no_recipients");
  assert.equal(noRecipientStatus.sentAt, null, "an announcement losing its audience must not be marked sent");
  assert.match(noRecipientStatus.error, /No students match/);
  const dueStatus = scheduleStatuses.find((item) => item.message === "Scheduled delivery test");
  assert.equal(dueStatus.status, "sent");
  assert.ok(dueStatus.sentAt);

  const courseResponse = await adminPost("/api/admin/academic", { action: "course", name: "Course, of Geography" });
  assert.equal(courseResponse.status, 201);
  const duplicatePayload = {
    action: "unit", course: "Course, of Geography", code: "DUP101", name: "Duplicate test",
    yearOfStudy: 4, semester: "1", creditHours: 3
  };
  assert.equal((await adminPost("/api/admin/academic", duplicatePayload)).status, 201);
  const duplicateResponse = await adminPost("/api/admin/academic", duplicatePayload);
  assert.equal(duplicateResponse.status, 409);
  assert.match((await duplicateResponse.json()).error, /DUP101.*already exists/);

  const csvImportContent = "\uFEFFcourse,code,name,year,semester,credit hours\r\n"
    + '"Course, of Geography",CSV101,"Field ""Methods"", advanced\r\nand practice",4,1,3.5\r\n'
    + '"Course, of Geography",CSV102,LF line,4,1,3\n'
    + ",CSV_EMPTY,Empty course,4,1,3\r\n"
    + '"Course, of Geography",BAD"CODE,Malformed quote,4,1,3\r\n'
    + '"Course, of Geography",CSV103,Trailing newline,4,1,3\r\n';
  const importResponse = await adminPost("/api/admin/academic", { action: "csv-import", csv: csvImportContent });
  assert.equal(importResponse.status, 200);
  const importResult = await importResponse.json();
  assert.equal(importResult.imported, 3, "quoted commas, escaped quotes, CRLF/LF, and trailing newlines should parse");
  assert.deepEqual(importResult.errors.map((error) => error.row), [4, 5]);
  db = new DatabaseSync(path.join(dataDirectory, "obadian-hub.sqlite"));
  const multilineUnit = db.prepare("SELECT name FROM master_units WHERE code = 'CSV101'").get();
  assert.equal(multilineUnit.name, 'Field "Methods", advanced\r\nand practice');
  db.close();
  db = null;
  const malformedCsv = await adminPost("/api/admin/academic", {
    action: "csv-import", csv: "course,code,name,year,semester,credit hours\nCourse,UNCLOSED,\"Broken,4,1,3"
  });
  const malformedResult = await malformedCsv.json();
  assert.equal(malformedResult.imported, 0);
  assert.deepEqual(malformedResult.errors, [{ row: 2, reason: "Quoted field was not closed before the end of the file." }]);

  db = new DatabaseSync(path.join(dataDirectory, "obadian-hub.sqlite"));
  db.exec(`CREATE TRIGGER force_master_unit_failure BEFORE INSERT ON master_units
    BEGIN SELECT RAISE(ABORT, 'unexpected insert failure'); END`);
  db.close();
  db = null;
  const unexpectedUnitError = await adminPost("/api/admin/academic", {
    ...duplicatePayload, code: "TRIGGER101"
  });
  assert.equal(unexpectedUnitError.status, 500, "non-unique database errors should still surface as server errors");
  db = new DatabaseSync(path.join(dataDirectory, "obadian-hub.sqlite"));
  db.exec("DROP TRIGGER force_master_unit_failure");
  db.close();
  db = null;

  const anonymousExport = await fetch(`${origin}/api/account/export`);
  assert.equal(anonymousExport.status, 401, "data export requires an authenticated student session");
  db = new DatabaseSync(path.join(dataDirectory, "obadian-hub.sqlite"));
  const ownUnitId = crypto.randomUUID();
  db.prepare("INSERT INTO units (id, user_id, code, title, created_at) VALUES (?, ?, 'OWN101', 'Own unit', ?)")
    .run(ownUnitId, suspendedId, new Date().toISOString());
  db.prepare("INSERT INTO files (id, user_id, name, mime, size, created_at, content) VALUES (?, ?, 'own.txt', 'text/plain', 4, ?, ?)")
    .run(crypto.randomUUID(), suspendedId, new Date().toISOString(), Buffer.from("own!"));
  db.prepare("INSERT INTO inbox (id, user_id, type, sender, text, created_at) VALUES (?, ?, 'notification', 'admin', 'Own notice', ?)")
    .run(crypto.randomUUID(), suspendedId, new Date().toISOString());
  db.close();
  db = null;

  const activeStudentLogin = await fetch(`${origin}/api/login`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "suspended@example.test", password: studentPassword })
  });
  assert.equal(activeStudentLogin.status, 200);
  const studentCookie = activeStudentLogin.headers.getSetCookie()[0].split(";")[0];
  const studentWorkspace = await fetch(`${origin}/api/workspace`, { headers: { Cookie: studentCookie } });
  assert.equal(studentWorkspace.status, 200);
  const studentInboxData = await studentWorkspace.json();
  assert.ok(studentInboxData.inbox.some((item) => item.type === "announcement" && item.text === "Partial audience"));
  assert.ok(studentInboxData.inbox.some((item) => item.type === "announcement" && item.text === "Full audience"));
  assert.ok(studentInboxData.inbox.some((item) => item.type === "announcement" && item.text === "Scheduled delivery test"));
  const ownDataResponse = await fetch(`${origin}/api/account/export?email=delete@example.test`, { headers: { Cookie: studentCookie } });
  assert.equal(ownDataResponse.status, 200);
  assert.match(ownDataResponse.headers.get("content-disposition"), /obadian-hub-data\.json/);
  const ownData = await ownDataResponse.json();
  assert.equal(ownData.profile.email, "suspended@example.test", "export must always use the authenticated student's identity");
  assert.ok(ownData.units.some((unit) => unit.code === "OWN101"));
  assert.equal(Buffer.from(ownData.files.find((file) => file.name === "own.txt").contentBase64, "base64").toString(), "own!");
  assert.ok(ownData.inbox.some((item) => item.text === "Own notice"));
  assert.doesNotMatch(JSON.stringify(ownData), /delete@example\.test/, "export must not include another student's data");
  assert.doesNotMatch(JSON.stringify(ownData), /passwordHash|password_hash|"salt"/i, "export must not include password verification data");
  const suspension = await adminPost("/api/admin/student-action", { email: "suspended@example.test", action: "suspend" });
  assert.equal(suspension.status, 200);
  const suspendedSession = await fetch(`${origin}/api/workspace`, { headers: { Cookie: studentCookie } });
  assert.equal(suspendedSession.status, 401, "suspending a student must invalidate active sessions");
  const suspendedExport = await fetch(`${origin}/api/account/export`, { headers: { Cookie: studentCookie } });
  assert.equal(suspendedExport.status, 401, "suspended sessions must not retain data-export access");
  const studentLogin = await fetch(`${origin}/api/login`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "suspended@example.test", password: studentPassword })
  });
  assert.equal(studentLogin.status, 403, "suspended student login must be denied");

  const deletion = await adminPost("/api/admin/student-action", {
    email: "delete@example.test", action: "delete", confirmEmail: "delete@example.test"
  });
  assert.equal(deletion.status, 200);
  db = new DatabaseSync(path.join(dataDirectory, "obadian-hub.sqlite"));
  for (const table of ["users", "academic_settings", "units", "schedule", "attendance_records", "class_sessions", "exam_sessions", "files", "inbox", "support_status", "account_tokens", "profile_avatars"]) {
    const column = table === "users" ? "id" : table === "support_status" ? "inbox_id" : "user_id";
    const value = table === "support_status" ? inboxId : deleteId;
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`).get(value);
    assert.equal(row.count, 0, `deletion should cascade through ${table}`);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM schedule_completions").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM activity WHERE email = 'delete@example.test'").get().count, 0);
  const auditCount = db.prepare("SELECT COUNT(*) AS count FROM admin_audit WHERE action LIKE '%Deleted student%'").get().count;
  assert.equal(auditCount, 1, "deletion should leave an audit entry");
  db.close();
  db = null;

  const csv = await fetch(`${origin}/api/admin/students.csv`, { headers: { Cookie: cookie } });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-type"), /text\/csv/);
  const csvText = await csv.text();
  assert.match(csvText, /Email/);
  assert.match(csvText, /suspended@example\.test/);
  assert.doesNotMatch(csvText, /password_hash|student-password-123/);
});
