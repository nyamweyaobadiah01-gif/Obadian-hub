const loginView = document.querySelector("#admin-login-view");
const dashboardView = document.querySelector("#admin-dashboard-view");
const notice = document.querySelector("#admin-notice");
const loginForm = document.querySelector("#admin-login-form");
const submitButton = document.querySelector("#admin-submit");
const PAGE_TITLES = {
  overview: "Overview", students: "Students", support: "Support inbox",
  announcements: "Announcements", academic: "Academic data", storage: "Storage",
  audit: "Audit & security", data: "Data tools"
};
let currentPage = "overview";
let studentPage = 1;
let selectedEmail = "";
let searchTimer;
let knownPendingApprovals = null;
let pendingApprovalTimer;

function showNotice(message, success = false) {
  notice.textContent = message;
  notice.classList.toggle("success", success);
  notice.hidden = false;
  window.clearTimeout(showNotice.timer);
  showNotice.timer = window.setTimeout(() => { notice.hidden = true; }, 5000);
}

function clearNotice() {
  notice.hidden = true;
  notice.textContent = "";
  notice.classList.remove("success");
}

async function request(path, options = {}) {
  const headers = { ...options.headers };
  if (options.body && !(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
  const response = await fetch(path, { ...options, headers, credentials: "same-origin" });
  const type = response.headers.get("content-type") || "";
  const result = type.includes("application/json") ? await response.json() : {};
  if (!response.ok) throw new Error(result.error || "Something went wrong. Please try again.");
  return result;
}

function node(tag, className = "", text = "") {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== null && text !== undefined) item.textContent = String(text);
  return item;
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ["KiB", "MiB", "GiB"];
  let amount = value / 1024;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index += 1; }
  return `${amount.toFixed(1)} ${units[index]}`;
}

function emptyRow(tbody, columns, message) {
  const row = node("tr");
  const cell = node("td", "admin-empty", message);
  cell.colSpan = columns;
  row.append(cell);
  tbody.replaceChildren(row);
}

function appendAction(parent, label, action, className = "table-action") {
  const button = node("button", className, label);
  button.type = "button";
  button.addEventListener("click", action);
  parent.append(button);
  return button;
}

function setPage(name) {
  if (!PAGE_TITLES[name]) return;
  currentPage = name;
  document.querySelector("#admin-page-title").textContent = PAGE_TITLES[name];
  document.querySelectorAll(".admin-page-panel").forEach((panel) => { panel.hidden = panel.dataset.panel !== name; });
  document.querySelectorAll(".admin-nav-link").forEach((button) => {
    const active = button.dataset.page === name;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  const menuWasOpen = dashboardView.classList.contains("menu-open");
  dashboardView.classList.remove("menu-open");
  const toggle = document.querySelector("#admin-menu-toggle");
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-label", "Open admin navigation");
  setAdminMenuHidden(isNarrowAdminViewport());
  if (menuWasOpen && isNarrowAdminViewport()) toggle.focus();
  loadPage(name).catch((error) => showNotice(error.message));
}

function isNarrowAdminViewport() {
  return window.matchMedia("(max-width: 760px)").matches;
}

function setAdminMenuHidden(hidden) {
  const sidebar = document.querySelector("#admin-sidebar");
  sidebar.inert = hidden;
  sidebar.setAttribute("aria-hidden", String(hidden));
  document.querySelector("#admin-sidebar-backdrop").setAttribute("aria-hidden", String(hidden));
}

async function loadPage(name) {
  if (name === "overview") return loadOverview();
  if (name === "students") return loadStudents();
  if (name === "support") return loadSupport();
  if (name === "announcements") return loadAnnouncements();
  if (name === "academic") return loadAcademic();
  if (name === "storage") return loadStorage();
  if (name === "audit") return loadAudit();
}

function renderMetricGrid(metrics) {
  const grid = document.querySelector("#overview-metrics");
  grid.replaceChildren();
  for (const [label, value, note] of metrics) {
    const card = node("article", "admin-metric-card");
    card.append(node("span", "admin-metric-label", label), node("strong", "admin-metric-value", value), node("small", "", note));
    grid.append(card);
  }
}

function drawChart(canvasId, values) {
  const canvas = document.querySelector(`#${canvasId}`);
  const context = canvas.getContext("2d");
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(260, canvas.clientWidth);
  const height = 180;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  context.scale(ratio, ratio);
  context.clearRect(0, 0, width, height);
  const max = Math.max(1, ...values.map((entry) => Number(entry.count) || 0));
  const left = 28;
  const bottom = height - 24;
  const chartWidth = width - left - 12;
  const chartHeight = height - 42;
  context.font = "11px sans-serif";
  context.textBaseline = "middle";
  context.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--border") || "#35323f";
  context.fillStyle = "#9995a5";
  for (let tick = 0; tick <= 4; tick += 1) {
    const y = bottom - chartHeight * tick / 4;
    context.beginPath(); context.moveTo(left, y); context.lineTo(width - 8, y); context.stroke();
    context.fillText(String(Math.round(max * tick / 4)), 2, y);
  }
  if (!values.length) {
    context.fillText("No data recorded yet", left + 10, bottom - chartHeight / 2);
    return;
  }
  const points = values.map((entry, index) => ({
    x: left + (values.length === 1 ? chartWidth / 2 : chartWidth * index / (values.length - 1)),
    y: bottom - (Number(entry.count) || 0) / max * chartHeight
  }));
  context.strokeStyle = "#a58aef";
  context.lineWidth = 2;
  context.beginPath();
  points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
  context.stroke();
  context.fillStyle = "#cbb8fb";
  for (const point of points) { context.beginPath(); context.arc(point.x, point.y, 3, 0, Math.PI * 2); context.fill(); }
}

async function loadOverview() {
  const data = await request("/api/admin/overview");
  updatePendingApprovalBadge(data.pendingApprovals, true);
  renderMetricGrid([
    ["Total students", data.students, "Registered accounts"],
    ["Verified / unverified", `${data.verified} / ${data.unverified}`, "Email verification"],
    ["Pending approvals", data.pendingApprovals, "New accounts awaiting review"],
    ["New this week", data.newThisWeek, "Created in the last 7 days"],
    ["Active now", data.activeNow, "Activity in last 15 minutes"],
    ["Storage used", formatBytes(data.storageUsedBytes), `${data.uploadCount} stored files`],
    ["Unread messages", data.unreadMessages, `${data.totalMessages} support messages`]
  ]);
  drawChart("signup-chart", data.signups);
  drawChart("active-chart", data.dailyActive);
  const health = document.querySelector("#system-health");
  health.replaceChildren();
  for (const [label, value] of [
    ["Database size", formatBytes(data.health.databaseBytes)],
    ["Stored uploads", data.health.uploadCount],
    ["Last email result", data.health.email.status],
    ["Last email time", formatDate(data.health.email.sentAt)]
  ]) {
    const row = node("div", "admin-data-row");
    row.append(node("span", "", label), node("strong", "", value));
    health.append(row);
  }
}

function studentQuery() {
  const query = new URLSearchParams({
    page: String(studentPage), pageSize: "25",
    q: document.querySelector("#student-search").value.trim(),
    verified: document.querySelector("#student-verified-filter").value,
    status: document.querySelector("#student-status-filter").value
  });
  return `/api/admin/users?${query}`;
}

function updatePendingApprovalBadge(count, notify = false) {
  const pending = Number(count) || 0;
  const badge = document.querySelector("#pending-approval-badge");
  badge.textContent = String(pending);
  badge.hidden = pending === 0;
  badge.setAttribute("aria-label", `${pending} account${pending === 1 ? "" : "s"} awaiting approval`);
  if (notify && (knownPendingApprovals === null ? pending > 0 : pending > knownPendingApprovals)) {
    showNotice(`${pending} new account${pending === 1 ? " is" : "s are"} waiting for approval.`, false);
  }
  knownPendingApprovals = pending;
}

function startPendingApprovalPolling() {
  window.clearInterval(pendingApprovalTimer);
  pendingApprovalTimer = window.setInterval(async () => {
    if (dashboardView.hidden || document.hidden) return;
    try {
      await loadOverview();
      if (currentPage === "students") await loadStudents();
    } catch (error) {
      showNotice(error.message);
    }
  }, 30000);
}

async function loadStudents() {
  const data = await request(studentQuery());
  const tbody = document.querySelector("#student-rows");
  tbody.replaceChildren();
  if (!data.users.length) emptyRow(tbody, 8, "No students match these filters.");
  for (const user of data.users) {
    const row = node("tr");
    row.append(node("td", "admin-email-cell", user.email));
    row.append(node("td", "", [user.school, user.course].filter(Boolean).join(" · ") || "—"));
    row.append(node("td", "", user.yearOfStudy || "—"));
    row.append(node("td", user.emailVerified ? "session-online" : "session-offline", user.emailVerified ? "Verified" : "Unverified"));
    row.append(node("td", !user.approved ? "session-offline" : user.suspended ? "session-offline" : user.online ? "session-online" : "",
      !user.approved ? "Awaiting approval" : user.suspended ? "Suspended" : user.online ? "Active" : "Signed out"));
    row.append(node("td", "", formatDate(user.lastActive)));
    const storage = node("td", user.storageQuotaBytes && user.storageUsed / user.storageQuotaBytes >= .8 ? "storage-warning" : "",
      `${formatBytes(user.storageUsed)} / ${formatBytes(user.storageQuotaBytes)}`);
    row.append(storage);
    const action = node("td");
    appendAction(action, "View", () => { selectedEmail = user.email; renderStudentDetail(user); });
    if (!user.approved) appendAction(action, "Approve", () => runStudentAction(user, "approve"), "admin-logout");
    if (user.online && !user.suspended) {
      appendAction(action, "Sign out", () => runStudentAction(user, "logout"), "admin-logout");
    }
    row.append(action);
    tbody.append(row);
  }
  const start = data.total ? (data.page - 1) * data.pageSize + 1 : 0;
  const end = Math.min(data.total, data.page * data.pageSize);
  document.querySelector("#student-page-info").textContent = `Showing ${start}–${end} of ${data.total}`;
  document.querySelector("#student-prev").disabled = studentPage <= 1;
  document.querySelector("#student-next").disabled = end >= data.total;
  if (selectedEmail) {
    const selected = data.users.find((user) => user.email === selectedEmail);
    if (selected) renderStudentDetail(selected);
  }
}

function renderStudentDetail(user) {
  const panel = document.querySelector("#student-detail");
  panel.replaceChildren(node("h2", "", user.profileName || user.email), node("p", "", "Profile information and administrator actions. Passwords and private file contents are never available here."));
  const list = node("div", "admin-data-list");
  for (const [label, value] of [
    ["Email", user.email], ["School", user.school || "Not set"], ["Course", user.course || "Not set"],
    ["Year / semester", `${user.yearOfStudy || "—"} / ${user.semester || "—"}`],
    ["Account created", formatDate(user.createdAt)], ["Last active", formatDate(user.lastActive)],
    ["Approval", user.approved ? "Approved" : "Awaiting administrator review"],
    ["Verification", user.emailVerified ? "Verified" : "Unverified"],
    ["Storage", `${formatBytes(user.storageUsed)} of ${formatBytes(user.storageQuotaBytes)}`]
  ]) {
    const row = node("div", "admin-data-row");
    row.append(node("span", "", label), node("strong", "", value));
    list.append(row);
  }
  panel.append(list);
  const actions = node("div", "admin-student-actions");
  appendAction(actions, "Sign out", () => runStudentAction(user, "logout"));
  appendAction(actions, user.suspended ? "Reactivate" : "Suspend", () => runStudentAction(user, user.suspended ? "reactivate" : "suspend"), "admin-logout");
  if (!user.approved) {
    appendAction(actions, "Approve account", () => runStudentAction(user, "approve"), "admin-logout");
  } else if (!user.emailVerified) {
    appendAction(actions, "Resend verification", () => runStudentAction(user, "resend-verification"));
    appendAction(actions, "Manually verify", () => runStudentAction(user, "verify"));
  }
  appendAction(actions, "Send password reset", () => runStudentAction(user, "password-reset"));
  appendAction(actions, "Adjust quota", () => runStudentAction(user, "quota"));
  appendAction(actions, "Delete account", () => runStudentAction(user, "delete"), "admin-danger");
  panel.append(actions);
}

async function runStudentAction(user, action) {
  let body = { email: user.email, action };
  if (action === "suspend" && !window.confirm(`Suspend ${user.email}? Existing sessions will stop working.`)) return;
  if (action === "logout" && !window.confirm(`Sign out all sessions for ${user.email}?`)) return;
  if (action === "approve" && !window.confirm(`Approve ${user.email}? This confirms the student's identity, verifies this email address, and lets them sign in with the password they chose.`)) return;
  if (action === "verify" && !window.confirm(`Manually verify ${user.email}?`)) return;
  if (action === "password-reset" && !window.confirm(`Send a password reset email to ${user.email}?`)) return;
  if (action === "quota") {
    const currentGiB = (user.storageQuotaBytes / 1024 ** 3).toFixed(2);
    const value = window.prompt("New storage quota in GiB (from 0.001 to 10):", currentGiB);
    if (value === null) return;
    const bytes = Math.round(Number(value) * 1024 ** 3);
    if (!Number.isFinite(bytes)) { showNotice("Enter a valid quota amount."); return; }
    body.bytes = bytes;
  }
  if (action === "delete") {
    const confirmation = window.prompt(`This permanently deletes ${user.email} and all associated data. Type the exact email to confirm:`);
    if (confirmation === null) return;
    body.confirmEmail = confirmation;
  }
  try {
    await request("/api/admin/student-action", { method: "POST", body: JSON.stringify(body) });
    showNotice(action === "delete" ? "Student account and associated data deleted."
      : action === "approve" ? "Account approved. The student can now sign in with their chosen password."
        : "Student action completed.", true);
    if (action === "delete") { selectedEmail = ""; document.querySelector("#student-detail").replaceChildren(node("h2", "", "Student details"), node("p", "", "The selected student was deleted.")); }
    if (action === "approve") { selectedEmail = ""; document.querySelector("#student-detail").replaceChildren(node("h2", "", "Student details"), node("p", "", "The selected account was approved.")); }
    await loadStudents();
    if (action === "approve" || action === "delete") await loadOverview();
  } catch (error) { showNotice(error.message); }
}

async function loadSupport() {
  const data = await request("/api/admin/support");
  const minutes = Number(data.averageResponseMinutes);
  document.querySelector("#support-response-time").textContent = minutes ? `Average first reply: ${minutes.toFixed(1)} minutes` : "No replies have been recorded yet.";
  const list = document.querySelector("#support-messages");
  list.replaceChildren();
  if (!data.messages.length) { list.append(node("p", "admin-empty-state", "No support messages yet.")); return; }
  for (const item of data.messages) {
    const card = node("article", "admin-message");
    const head = node("div", "admin-message-head");
    head.append(node("strong", "", item.email), node("span", `admin-status-pill status-${item.status}`, item.status));
    card.append(head, node("p", "", item.text), node("small", "", formatDate(item.createdAt)));
    const controls = node("div", "admin-message-controls");
    const status = document.createElement("select");
    status.setAttribute("aria-label", `Status for support message from ${item.email}`);
    for (const value of ["unread", "open", "resolved"]) status.add(new Option(value[0].toUpperCase() + value.slice(1), value));
    status.value = item.status;
    status.addEventListener("change", async () => {
      try { await request("/api/admin/support-action", { method: "POST", body: JSON.stringify({ id: item.id, action: "status", status: status.value }) }); await loadSupport(); }
      catch (error) { showNotice(error.message); }
    });
    controls.append(status);
    const form = document.createElement("form");
    form.className = "admin-reply-form";
    const canned = document.createElement("select");
    canned.setAttribute("aria-label", "Choose a canned support reply");
    canned.add(new Option("Canned reply…", ""));
    canned.add(new Option("Thanks for contacting support. We are looking into this.", "Thanks for contacting support. We are looking into this."));
    canned.add(new Option("Please sign out and back in, then try again.", "Please sign out and back in, then try again."));
    canned.add(new Option("Your email is not verified yet. Please use the verification link we sent.", "Your email is not verified yet. Please use the verification link we sent."));
    const input = document.createElement("textarea");
    input.rows = 2; input.maxLength = 1000; input.required = true; input.placeholder = "Write a reply";
    input.setAttribute("aria-label", `Reply to ${item.email}`);
    canned.addEventListener("change", () => { if (canned.value) input.value = canned.value; });
    const button = node("button", "admin-logout", "Send reply"); button.type = "submit";
    form.append(canned, input, button);
    form.addEventListener("submit", async (event) => {
      event.preventDefault(); button.disabled = true;
      try {
        await request("/api/admin/support-action", { method: "POST", body: JSON.stringify({ id: item.id, action: "reply", message: input.value }) });
        showNotice("Reply sent.", true); await loadSupport();
      } catch (error) { showNotice(error.message); button.disabled = false; }
    });
    controls.append(form); card.append(controls); list.append(card);
  }
}

async function loadAnnouncements() {
  const data = await request("/api/admin/announcements");
  const tbody = document.querySelector("#announcement-rows");
  tbody.replaceChildren();
  if (!data.announcements.length) { emptyRow(tbody, 5, "No announcements yet."); return; }
  for (const item of data.announcements) {
    const row = node("tr");
    row.append(node("td", "", item.audience), node("td", "", item.target || "—"), node("td", "admin-message-preview", item.message),
      node("td", "", formatDate(item.scheduledAt)), node("td", "", item.status === "no_recipients"
        ? "No recipients found" : item.sentAt ? `Sent ${formatDate(item.sentAt)}` : "Scheduled"));
    if (item.error) row.lastChild.title = item.error;
    tbody.append(row);
  }
}

async function loadAcademic() {
  const data = await request("/api/admin/academic");
  const courses = new Set(data.courses.map((course) => course.name));
  const tbody = document.querySelector("#academic-rows");
  tbody.replaceChildren();
  if (!data.units.length) emptyRow(tbody, 6, "No master units have been added.");
  for (const unit of data.units) {
    courses.add(unit.course);
    const row = node("tr");
    row.append(node("td", "", unit.course), node("td", "", unit.code), node("td", "", unit.name),
      node("td", "", unit.yearOfStudy), node("td", "", unit.semester), node("td", "", unit.creditHours));
    tbody.append(row);
  }
  const courseInput = document.querySelector('#unit-form [name="course"]');
  courseInput.setAttribute("list", "admin-course-options");
  let options = document.querySelector("#admin-course-options");
  if (!options) { options = document.createElement("datalist"); options.id = "admin-course-options"; courseInput.after(options); }
  options.replaceChildren(...[...courses].sort().map((course) => { const option = document.createElement("option"); option.value = course; return option; }));
  const calendar = document.querySelector("#academic-calendar-list");
  calendar.replaceChildren(node("h3", "", "Calendar periods"));
  for (const event of data.calendar) calendar.append(node("p", "", `${event.title}: ${event.startDate} – ${event.endDate} (${event.type})`));
  const grading = document.querySelector("#grading-list");
  grading.replaceChildren(node("h3", "", "Grading ranges"));
  for (const range of data.grading) grading.append(node("p", "", `${range.label}: ${range.minimumScore}–${range.maximumScore}`));
}

async function loadStorage() {
  const data = await request("/api/admin/storage");
  const students = document.querySelector("#storage-students");
  students.replaceChildren();
  if (!data.students.length) emptyRow(students, 5, "No student storage data.");
  for (const user of data.students) {
    const row = node("tr", user.percent >= 80 ? "storage-warning-row" : "");
    row.append(node("td", "", user.email), node("td", "", user.school || "—"), node("td", "", formatBytes(user.storageUsed)),
      node("td", "", formatBytes(user.quota)), node("td", "", `${user.percent}%${user.percent >= 80 ? " · Review" : ""}`));
    students.append(row);
  }
  const files = document.querySelector("#storage-files");
  files.replaceChildren();
  if (!data.files.length) { emptyRow(files, 6, "No files are stored."); return; }
  for (const file of data.files) {
    const row = node("tr");
    row.append(node("td", "", file.email), node("td", "", file.name), node("td", "", file.mime),
      node("td", "", formatBytes(file.size)), node("td", "", formatDate(file.createdAt)));
    const action = node("td");
    appendAction(action, "Remove", async () => {
      if (!window.confirm(`Remove metadata entry for “${file.name}” from ${file.email}?`)) return;
      const reason = window.prompt("Required policy reason for removing this file:");
      if (!reason || !reason.trim()) return;
      try {
        await request("/api/admin/storage", { method: "DELETE", body: JSON.stringify({ id: file.id, reason }) });
        showNotice("File removed and action audited.", true); await loadStorage();
      } catch (error) { showNotice(error.message); }
    }, "admin-danger");
    row.append(action); files.append(row);
  }
}

async function loadAudit() {
  const query = encodeURIComponent(document.querySelector("#audit-search").value.trim());
  const data = await request(`/api/admin/audit?q=${query}`);
  const rows = document.querySelector("#audit-rows");
  rows.replaceChildren();
  if (!data.entries.length) emptyRow(rows, 4, "No matching audit entries.");
  for (const item of data.entries) {
    const row = node("tr");
    row.append(node("td", "", item.adminEmail), node("td", "", item.action), node("td", "", item.target || "—"), node("td", "", formatDate(item.createdAt)));
    rows.append(row);
  }
  const signins = document.querySelector("#admin-signins");
  signins.replaceChildren();
  if (!data.signins.length) emptyRow(signins, 3, "No administrator sign-ins recorded.");
  for (const item of data.signins) {
    const row = node("tr");
    row.append(node("td", "", item.adminEmail), node("td", "", item.ipAddress), node("td", "", formatDate(item.createdAt)));
    signins.append(row);
  }
}

function formDataObject(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function bindJsonForm(id, endpoint, action, onSuccess) {
  const form = document.querySelector(`#${id}`);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"],button:not([type])');
    if (button) button.disabled = true;
    try {
      await request(endpoint, { method: "POST", body: JSON.stringify({ action, ...formDataObject(form) }) });
      form.reset(); showNotice("Changes saved.", true); await onSuccess();
    } catch (error) { showNotice(error.message); }
    finally { if (button) button.disabled = false; }
  });
}

document.querySelectorAll(".admin-nav-link").forEach((button) => button.addEventListener("click", () => setPage(button.dataset.page)));
document.querySelector("#admin-menu-toggle").addEventListener("click", () => {
  const open = !dashboardView.classList.contains("menu-open");
  dashboardView.classList.toggle("menu-open", open);
  document.querySelector("#admin-menu-toggle").setAttribute("aria-expanded", String(open));
  document.querySelector("#admin-menu-toggle").setAttribute("aria-label", open ? "Close admin navigation" : "Open admin navigation");
  setAdminMenuHidden(isNarrowAdminViewport() && !open);
  if (open) window.requestAnimationFrame(() => document.querySelector(".admin-nav-link.active")?.focus());
});
document.querySelector("#admin-sidebar-backdrop").addEventListener("click", () => {
  dashboardView.classList.remove("menu-open");
  setAdminMenuHidden(true);
  document.querySelector("#admin-menu-toggle").setAttribute("aria-expanded", "false");
  document.querySelector("#admin-menu-toggle").focus();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && dashboardView.classList.contains("menu-open")) {
    dashboardView.classList.remove("menu-open");
    setAdminMenuHidden(true);
    document.querySelector("#admin-menu-toggle").setAttribute("aria-expanded", "false");
    document.querySelector("#admin-menu-toggle").focus();
  }
});
window.matchMedia("(max-width: 760px)").addEventListener("change", (event) => {
  dashboardView.classList.remove("menu-open");
  document.querySelector("#admin-menu-toggle").setAttribute("aria-expanded", "false");
  setAdminMenuHidden(event.matches);
});
document.querySelector("#admin-refresh").addEventListener("click", () => loadPage(currentPage).catch((error) => showNotice(error.message)));

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault(); clearNotice(); submitButton.disabled = true;
  document.querySelector("#admin-submit-label").textContent = "Signing in…";
  try {
    await request("/api/admin/login", { method: "POST", body: JSON.stringify({
      email: document.querySelector("#admin-email").value, password: document.querySelector("#admin-password").value
    }) });
    loginView.hidden = true; dashboardView.hidden = false; setPage("overview"); startPendingApprovalPolling();
  } catch (error) { showNotice(error.message); }
  finally { submitButton.disabled = false; document.querySelector("#admin-submit-label").textContent = "Sign in securely"; }
});

document.querySelector("#student-search").addEventListener("input", () => {
  window.clearTimeout(searchTimer); searchTimer = window.setTimeout(() => { studentPage = 1; loadStudents().catch((error) => showNotice(error.message)); }, 200);
});
for (const id of ["student-verified-filter", "student-status-filter"]) {
  document.querySelector(`#${id}`).addEventListener("change", () => { studentPage = 1; loadStudents().catch((error) => showNotice(error.message)); });
}
document.querySelector("#student-prev").addEventListener("click", () => { studentPage = Math.max(1, studentPage - 1); loadStudents().catch((error) => showNotice(error.message)); });
document.querySelector("#student-next").addEventListener("click", () => { studentPage += 1; loadStudents().catch((error) => showNotice(error.message)); });
document.querySelector("#audit-search").addEventListener("input", () => {
  window.clearTimeout(searchTimer); searchTimer = window.setTimeout(() => loadAudit().catch((error) => showNotice(error.message)), 200);
});

document.querySelector("#announcement-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = formDataObject(event.currentTarget);
  const date = data.scheduledAt ? new Date(data.scheduledAt) : new Date();
  if (data.audience === "all" && !window.confirm("Send this announcement to every student?")) return;
  try {
    const result = await request("/api/admin/announcements", { method: "POST", body: JSON.stringify({ ...data, scheduledAt: date.toISOString() }) });
    event.currentTarget.reset();
    if (result.status === "sent") showNotice(`Announcement sent to ${result.recipientCount} student${result.recipientCount === 1 ? "" : "s"}.`, true);
    else showNotice(`Announcement scheduled for ${formatDate(result.scheduledAt)} for ${result.recipientCount} student${result.recipientCount === 1 ? "" : "s"}. It will appear on the student page at that time while this server is running.`, true);
    await loadAnnouncements();
  } catch (error) { showNotice(error.message); }
});

bindJsonForm("course-form", "/api/admin/academic", "course", loadAcademic);
bindJsonForm("unit-form", "/api/admin/academic", "unit", loadAcademic);
bindJsonForm("calendar-form", "/api/admin/academic", "calendar", loadAcademic);
bindJsonForm("grading-form", "/api/admin/academic", "grading", loadAcademic);
document.querySelector("#academic-csv-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = document.querySelector("#academic-csv-file").files[0];
  if (!file) return;
  try {
    const csv = await file.text();
    const result = await request("/api/admin/academic", { method: "POST", body: JSON.stringify({ action: "csv-import", csv }) });
    event.currentTarget.reset();
    const rowErrors = result.errors.map((item) => `Row ${item.row}: ${item.reason}`).join(" ");
    showNotice(`Imported ${result.imported} unit rows.${rowErrors ? ` ${rowErrors}` : ""}`, result.errors.length === 0);
    await loadAcademic();
  } catch (error) { showNotice(error.message); }
});

document.querySelector("#admin-logout-all").addEventListener("click", async () => {
  if (!window.confirm("Sign out every active administrator session? You will need to sign in again.")) return;
  try {
    await request("/api/admin/logout-all", { method: "POST", body: "{}" });
    window.clearInterval(pendingApprovalTimer);
    dashboardView.hidden = true; loginView.hidden = false; loginForm.reset(); showNotice("All administrator sessions were signed out.", true);
  } catch (error) { showNotice(error.message); }
});
document.querySelector("#admin-logout").addEventListener("click", async () => {
  try {
    await request("/api/admin/logout", { method: "POST", body: "{}" });
    window.clearInterval(pendingApprovalTimer);
    dashboardView.hidden = true; loginView.hidden = false; loginForm.reset(); clearNotice();
  } catch (error) { showNotice(error.message); }
});
document.querySelector("#admin-theme-toggle").addEventListener("click", () => {
  const root = document.documentElement;
  const light = root.dataset.theme !== "light";
  root.dataset.theme = light ? "light" : "dark";
  document.querySelector("#admin-theme-toggle").textContent = light ? "☾" : "☼";
  try { localStorage.setItem("obadianAdminTheme", root.dataset.theme); }
  catch { showNotice("Theme changed, but this browser could not save the preference."); }
});

let savedTheme = "dark";
try { savedTheme = localStorage.getItem("obadianAdminTheme") || "dark"; }
catch { showNotice("Theme preference storage is unavailable in this browser."); }
document.documentElement.dataset.theme = savedTheme;
document.querySelector("#admin-theme-toggle").textContent = savedTheme === "light" ? "☾" : "☼";
request("/api/admin/session").then(async (result) => {
  if (!result.configured) {
    const note = document.querySelector("#admin-config-note");
    note.textContent = "Admin access is not configured. Set ADMIN_EMAIL and an ADMIN_PASSWORD of at least 16 characters, then restart the server.";
    note.hidden = false;
  } else if (result.authenticated) {
    loginView.hidden = true; dashboardView.hidden = false; setPage("overview"); startPendingApprovalPolling();
  }
}).catch((error) => showNotice(error.message));
setAdminMenuHidden(isNarrowAdminViewport());

window.addEventListener("resize", () => {
  if (!dashboardView.hidden && currentPage === "overview") loadOverview().catch((error) => showNotice(error.message));
});
