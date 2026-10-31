# Obadian Hub

A dark, responsive workspace for schedules, school documents, images, and videos. Users can create accounts, manage a personal calendar and file library, receive administrator notifications, and contact support. The server is built with Node.js built-in modules and uses `pdf-parse` to extract timetable text from uploaded PDFs.

The schedule supports categories, academic-unit links, daily/weekly/monthly repeats, completion tracking, calendar drag-and-drop, and optional browser notifications. Students can set their year of study, academic year, and semester, manage their unit list, and track attendance by unit and semester, including present, absent, late, and excused records. The file library supports previews, search, folder filtering, rename/move, and a 500 MiB per-account quota with a 20 MiB per-file limit. Browser reminders require notification permission and Obadian Hub to remain open in the browser.

Students can upload class and exam timetable PDFs from **Academic year & units**. PDFs must be no larger than 10 MiB and are parsed on the server; only rows matching units saved to that account are offered for confirmation. Review extracted entries, edit or delete them, or add entries manually before confirming. Confirmation replaces the saved timetable entries; the uploaded PDF itself is not retained. The dashboard search matches confirmed unit codes/names and shows class days, times, venues, and lecturers. Confirmed exam sessions appear in the calendar and are listed with a live countdown using Africa/Nairobi time. Scanned PDFs without selectable text require manual entry. Changing the academic period prompts the student to upload timetables for the new period; existing rows remain until a replacement is confirmed.

## Run locally

1. Install Node.js 22.5 or later (the app uses Node's built-in SQLite module).
2. Open a terminal in this folder and run `npm install`.
3. Run `npm.cmd start` in PowerShell (or `npm start` in Command Prompt).
4. Open [http://127.0.0.1:3000](http://127.0.0.1:3000) in your browser.
5. Choose **Create an account**, review and accept the Terms of Service and Privacy Policy, then register with your email and a password of at least 10 characters. New accounts remain locked until an administrator approves them.

When you open this folder in VS Code, its **Obadian Hub: start and open** task starts the server and opens the site in your browser. If VS Code asks permission to run automatic tasks, allow it for this workspace. You can also start the task yourself from **Terminal > Run Task**. Keep the VS Code task running while you use the site.

## Temporary public testing link

The local Cloudflare Quick Tunnel can provide a temporary HTTPS link for testing from outside your Wi-Fi. Start Obadian Hub, then run `& "$env:LOCALAPPDATA\ObadianHub\cloudflared.exe" tunnel --url http://127.0.0.1:3000 --no-autoupdate` in PowerShell. Cloudflare prints a `https://…trycloudflare.com` link; it only works while both Obadian Hub and the tunnel command are running, and a new tunnel may have a different link. Keep `PUBLIC_BASE_URL` in `.env` set to the current HTTPS tunnel URL and restart the app when the link changes so verification and password-reset emails use the current address. This is a temporary testing tunnel, not a permanent domain or a production hosting service; anyone with the link can reach the site.

User records, schedules, completed schedule occurrences, academic units, attendance, confirmed class and exam sessions, file details and contents, inbox messages, notifications, and recent account activity are stored in the SQLite database at `data/obadian-hub.sqlite`. Existing `data/users.json` and `data/hub.json` files are migrated automatically when present. Password hashes use Node.js scrypt and are never stored as plain text. Uploaded files are checked against supported extensions and file signatures, limited to 20 MiB each and 500 MiB total per account, and served only to their owner after sign-in. Timetable PDF parsing checks the PDF signature and enforces a 10 MiB upload and 60-page limit; timetable rows are scoped to the signed-in user and saved only after confirmation. API write requests require a same-origin `Origin` header and are rate limited. Sessions are held in server memory and expire after 12 hours by default or seven days when **Remember me** is selected; all sessions expire when the server restarts.

## Account approval, email verification, and recovery

New registrations do not depend on email delivery. They remain locked until an administrator reviews and approves the account in **Admin > Students**. The admin dashboard shows a pending-approval count and checks for new registrations while the administrator is signed in. Approval also marks the email as verified, so administrators must approve only people whose identity and email address they have checked. Students then sign in with the password they chose at registration. Do not share a temporary password between users.

Password reset and verification links for existing unverified accounts are sent through [Resend](https://resend.com/). To configure local email delivery:

1. Create a Resend account, add and verify a sending domain, and create an API key in the Resend dashboard.
2. In PowerShell, copy the example settings: `Copy-Item .env.example .env`.
3. Open `.env` and set `RESEND_API_KEY` to your Resend API key and `RESEND_FROM_EMAIL` to an address on your verified domain (for example, `Obadian Hub <accounts@yourdomain.com>`).
4. Keep `PUBLIC_BASE_URL=http://127.0.0.1:3000` for local use, and restart Obadian Hub. The recipient must open a local verification or reset link on the same computer that runs the server. Use your deployed HTTPS site URL after deployment.

The server loads settings from `.env` at startup. `.env` is ignored by Git; never commit it or paste your API key into chat. You can also set these environment variables directly in the terminal before starting the server.

Without these settings, account creation and administrator approval still work, but password recovery and verification emails are unavailable. Existing accounts are kept approved during database migration. Verification and reset tokens are one-time links that expire after one hour. Users can change their password, upload a private profile photo, download a JSON copy of their own account data, and delete their account and associated workspace data from **Settings & privacy**. The export is scoped to the signed-in account and includes uploaded file and profile-photo contents as Base64, but excludes password hashes, salts, and account tokens. Notifications delivered to the inbox are included; the app does not currently track whether each notification was read, and it has no separate assignment-submission feature.

## Private admin page

Configure administrator credentials in the same terminal before starting the server:

```powershell
$env:ADMIN_EMAIL = Read-Host "Admin email"
$securePassword = Read-Host "Admin password (at least 16 characters)" -AsSecureString
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
$env:ADMIN_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
npm.cmd start
```

Keep the terminal open while using the server, then open [http://127.0.0.1:3000/admin](http://127.0.0.1:3000/admin). The admin console at `/admin` includes Overview, Students, Support inbox, Announcements, Academic data, Storage, Audit & security, and Data tools. It provides student search and filters, pending-registration approval, account verification and suspension controls, support replies and status tracking, announcement history and scheduling, academic reference-data forms, storage metadata and policy removal, an admin audit log, and CSV/PDF/SQLite downloads. Destructive account deletion requires typing the student's email to confirm.

Every admin API operation (apart from sign-in and session status) checks the separate admin session on the server. Admin sessions use an HTTP-only cookie and expire after eight hours or when the server restarts. Student suspension blocks sign-in and invalidates their existing sessions. Admin actions are recorded in the audit log. The console displays account and file metadata, not private file contents. The SQLite backup is sanitized: password hashes, salts, private file contents, and avatar contents are removed. A restored sanitized backup therefore requires users to reset their passwords.

The admin credentials must be set as environment variables before starting the server; do not put credentials in source files or share them in chat. The PowerShell commands above prompt for them without echoing the password. Admin functionality tests run with `node --test admin.test.js`; tests use a temporary data directory.

## Planned / Not yet implemented

- **Student data requests:** Students do not yet have a request queue for export or deletion that administrators can review. This would need a request table with requester, request type, status, timestamps, and resolution notes; authenticated student create/status endpoints; admin review and resolution endpoints with audit entries; and matching request forms and status views in Settings and the admin console. Direct self-service export and account deletion are available now.
- **Policy-version acceptance:** The database contains policy-version records, but there is no publication workflow or prompt that asks existing students to accept updated Terms or Privacy versions. This would need an admin publish/current-version action, per-account acceptance records or reliable version fields, a student endpoint to record acceptance, and a blocking or deferrable acceptance dialog before continued workspace use.
- **Course-wide timetable publishing:** Students can upload and confirm their own class and exam timetables, but administrators cannot publish official timetables to a course/year/semester cohort. This would need shared timetable and session records keyed to the academic cohort, admin upload/review/publish APIs and UI, and student views that match the published entries to their profile without exposing other cohorts' data.

The included policies are starter copy for this demo. Review and adapt them to your organization and applicable requirements before using this site publicly.

## Production notes

For public deployment, set `HOST=0.0.0.0` if your host needs the server to listen on its network interface, use HTTPS, and set `NODE_ENV=production` so session cookies are marked `Secure`. Also configure a process manager, backups for the user data and uploads, and a production database before serving a large or multi-instance application. The built-in in-memory sessions are intended for a small single-server starter.

For a single-instance Ubuntu VM deployment that preserves SQLite and uploaded files, see the [free VM deployment guide](./deploy/README.md). Free cloud resources can be reclaimed and need independent backups; a free hostname does not guarantee Google Search visibility.
