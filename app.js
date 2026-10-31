const authView = document.querySelector("#auth-view");
const dashboardView = document.querySelector("#dashboard-view");
const authForm = document.querySelector("#auth-form");
const notice = document.querySelector("#notice");
const submitButton = document.querySelector("#submit-button");
const passwordInput = document.querySelector("#password");
const emailInput = document.querySelector("#email");
const passwordToggle = document.querySelector("#password-toggle");
const agreementCheckbox = document.querySelector("#agree-to-policies");
const agreementRow = document.querySelector("#agreement-row");
const resendVerificationButton = document.querySelector("#resend-verification");
const toast = document.querySelector("#toast");
const welcomeDialog = document.querySelector("#welcome-dialog");
const recoveryDialog = document.querySelector("#recovery-dialog");

let isRegisterMode = false;
let toastTimer;
let currentUser = null;
let workspace = {
  schedule: [], units: [], academicSettings: { academicYear: "", semester: "", yearOfStudy: 0 },
  attendance: [], classSessions: [], examSessions: [], files: [], inbox: [], storageUsedBytes: 0, storageQuotaBytes: 500 * 1024 * 1024
};
let calendarDate = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let editingScheduleId = null;
let editingUnitId = null;
let editingAttendanceId = null;
const timetableDrafts = { class: null, exam: null };
let reminderTimer;
let examCountdownTimer;
let inboxRefreshTimer;
const sentReminders = new Set();
const dismissedAnnouncementIds = new Set();

function showNotice(message, success = false) {
  notice.textContent = message;
  notice.classList.toggle("success", success);
  notice.hidden = false;
}

function clearNotice() {
  notice.hidden = true;
  notice.textContent = "";
  notice.classList.remove("success");
}

function showToast(message, error = false) {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.toggle("error", error);
  toast.hidden = false;
  toastTimer = window.setTimeout(() => { toast.hidden = true; }, 3500);
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
    credentials: "same-origin"
  });
  const result = response.headers.get("content-type")?.includes("application/json") ? await response.json() : {};
  if (!response.ok) throw new Error(result.error || "Something went wrong. Please try again.");
  return result;
}

function setMode(register) {
  isRegisterMode = register;
  document.querySelector("#form-eyebrow").textContent = register ? "YOUR NEW SPACE STARTS HERE" : "WELCOME BACK";
  document.querySelector("#form-title").textContent = register ? "Create your account" : "Sign in to your hub";
  document.querySelector("#form-description").textContent = register
    ? "Create your private workspace. A hub administrator must approve your account before you can sign in."
    : "Enter your email and password to continue.";
  document.querySelector("#submit-label").textContent = register ? "Create account" : "Sign in";
  document.querySelector("#switch-prompt").textContent = register ? "Already have an account?" : "New to Obadian Hub?";
  document.querySelector("#switch-mode").textContent = register ? "Sign in" : "Create an account";
  document.querySelector("#password-hint").hidden = !register;
  document.querySelector("#password-strength").hidden = !register;
  document.querySelector("#forgot-password").hidden = register;
  resendVerificationButton.hidden = true;
  agreementRow.hidden = !register;
  agreementCheckbox.disabled = !register;
  agreementCheckbox.required = register;
  passwordInput.autocomplete = register ? "new-password" : "current-password";
  passwordInput.minLength = register ? 10 : 1;
  clearNotice();
}

function initials(email) {
  return (email.split("@")[0].trim().charAt(0) || "O").toUpperCase();
}

function updatePasswordStrength(input, output) {
  const password = input.value;
  if (!password) {
    output.textContent = "";
    return;
  }
  const categories = [/[a-z]/.test(password), /[A-Z]/.test(password), /\d/.test(password), /[^A-Za-z0-9]/.test(password)]
    .filter(Boolean).length;
  const strength = password.length < 10 || categories < 2
    ? "Weak"
    : password.length >= 14 && categories >= 3 ? "Strong" : "Fair";
  output.textContent = `Strength: ${strength}. Use 10+ characters and mix character types.`;
}

function setAvatarElement(containerId, user) {
  const container = document.querySelector(containerId);
  container.replaceChildren();
  if (!user.hasAvatar) {
    container.textContent = initials(user.email);
    return;
  }
  const image = element("img", "avatar-image");
  image.src = `/api/avatar?v=${Date.now()}`;
  image.alt = "Profile photo";
  image.addEventListener("error", () => { container.textContent = initials(user.email); }, { once: true });
  container.append(image);
}

function formatDate(value, options = { dateStyle: "medium", timeStyle: "short" }) {
  return new Intl.DateTimeFormat(undefined, options).format(new Date(value));
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function emptyState(message, actionLabel, view) {
  const state = element("div", "empty-state-panel");
  state.append(element("p", "", message));
  const action = element("button", "subtle-button", actionLabel);
  action.type = "button";
  action.addEventListener("click", () => showView(view));
  state.append(action);
  return state;
}

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function occurrenceDate(item, index) {
  const base = new Date(item.date);
  if (item.repeat === "daily") {
    return new Date(base.getFullYear(), base.getMonth(), base.getDate() + index, base.getHours(), base.getMinutes());
  }
  if (item.repeat === "weekly") {
    return new Date(base.getFullYear(), base.getMonth(), base.getDate() + index * 7, base.getHours(), base.getMinutes());
  }
  if (item.repeat === "monthly") {
    const firstOfMonth = new Date(base.getFullYear(), base.getMonth() + index, 1, base.getHours(), base.getMinutes());
    const lastDay = new Date(firstOfMonth.getFullYear(), firstOfMonth.getMonth() + 1, 0).getDate();
    firstOfMonth.setDate(Math.min(base.getDate(), lastDay));
    return firstOfMonth;
  }
  return base;
}

function getOccurrences(item, rangeStart, rangeEnd) {
  const base = new Date(item.date);
  const start = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), rangeStart.getDate());
  const end = new Date(rangeEnd.getFullYear(), rangeEnd.getMonth(), rangeEnd.getDate(), 23, 59, 59, 999);
  if (item.repeat === "none") return base >= start && base <= end ? [base] : [];
  let firstIndex = 0;
  if (item.repeat === "daily") {
    firstIndex = Math.max(0, Math.ceil((start - new Date(base.getFullYear(), base.getMonth(), base.getDate())) / 86400000));
  } else if (item.repeat === "weekly") {
    firstIndex = Math.max(0, Math.ceil((start - new Date(base.getFullYear(), base.getMonth(), base.getDate())) / (7 * 86400000)));
  } else if (item.repeat === "monthly") {
    firstIndex = Math.max(0, (start.getFullYear() - base.getFullYear()) * 12 + start.getMonth() - base.getMonth());
    if (occurrenceDate(item, firstIndex) < start) firstIndex += 1;
  }
  const occurrences = [];
  for (let index = firstIndex; index < firstIndex + 400; index += 1) {
    const date = occurrenceDate(item, index);
    if (date > end) break;
    if (date >= start) occurrences.push(date);
    if (item.repeat === "none") break;
  }
  return occurrences;
}

function dateFromKey(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}

function dateInNairobi(value) {
  return new Date(`${value}T12:00:00+03:00`);
}

function nairobiDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Nairobi", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function examCountdownText(exam, now = new Date()) {
  if (!exam.examDate) return "Date TBC";
  const today = nairobiDateKey(now);
  if (exam.examDate < today) return "Done";
  const start = exam.examDateTime ? new Date(exam.examDateTime)
    : exam.examTime ? new Date(`${exam.examDate}T${exam.examTime}:00+03:00`) : null;
  const end = start && Number.isInteger(exam.duration) && exam.duration > 0
    ? new Date(start.getTime() + exam.duration * 60000) : null;
  if (exam.examDate === today) {
    if (end && now >= end) return "Done";
    if (start && now >= start) return "In progress";
    return "Today";
  }
  if (!exam.examTime || !start || Number.isNaN(start.getTime())) {
    const days = Math.round((dateFromKey(exam.examDate) - dateFromKey(today)) / 86400000);
    return `${days} day${days === 1 ? "" : "s"} · Time TBC`;
  }
  const hoursRemaining = Math.max(0, Math.floor((start.getTime() - now.getTime()) / 3600000));
  const days = Math.floor(hoursRemaining / 24);
  const hours = hoursRemaining % 24;
  return days ? `${days} day${days === 1 ? "" : "s"}, ${hours} hour${hours === 1 ? "" : "s"}`
    : `${hours} hour${hours === 1 ? "" : "s"}`;
}

function shortExamCountdownText(exam) {
  const text = examCountdownText(exam);
  if (["Today", "In progress", "Done", "Date TBC"].includes(text)) return text;
  const daysHours = /^(\d+) days?, (\d+) hours?$/.exec(text);
  if (daysHours) return `${daysHours[1]}d ${daysHours[2]}h`;
  const hours = /^(\d+) hours?$/.exec(text);
  if (hours) return `${hours[1]}h`;
  const days = /^(\d+) days? · Time TBC$/.exec(text);
  return days ? `${days[1]}d · TBC` : text;
}

function sortedExamSessions() {
  return [...workspace.examSessions].sort((a, b) => {
    const aDone = examCountdownText(a) === "Done";
    const bDone = examCountdownText(b) === "Done";
    if (aDone !== bDone) return aDone ? 1 : -1;
    const aTime = a.examDateTime ? Date.parse(a.examDateTime) : a.examDate ? Date.parse(`${a.examDate}T23:59:00+03:00`) : Infinity;
    const bTime = b.examDateTime ? Date.parse(b.examDateTime) : b.examDate ? Date.parse(`${b.examDate}T23:59:00+03:00`) : Infinity;
    return aTime - bTime;
  });
}

function occurrenceIsDone(item, date) {
  return (item.completedDates || []).includes(dateKey(date));
}

function categoryClass(category) {
  return `category-${String(category || "General").toLowerCase()}`;
}

function unitLabel(unitId) {
  const unit = workspace.units.find((item) => item.id === unitId);
  return unit ? `${unit.code} · ${unit.title}` : "";
}

function populateUnitSelect(select, emptyLabel) {
  const currentValue = select.value;
  select.replaceChildren(new Option(emptyLabel, ""));
  for (const unit of workspace.units) {
    select.add(new Option(`${unit.code} · ${unit.title}`, unit.id));
  }
  select.value = workspace.units.some((unit) => unit.id === currentValue) ? currentValue : "";
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function localDateTimeValue(value) {
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function renderCalendar() {
  const grid = document.querySelector("#calendar-grid");
  grid.replaceChildren();
  document.querySelector("#calendar-month").textContent = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(calendarDate);
  const year = calendarDate.getFullYear();
  const month = calendarDate.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay();
  const firstDate = new Date(year, month, 1 - firstWeekday);
  const lastDate = new Date(firstDate.getFullYear(), firstDate.getMonth(), firstDate.getDate() + 41);
  const events = [
    ...workspace.examSessions.filter((exam) => exam.examDate).map((exam) => ({
      type: "exam",
      exam,
      date: new Date(`${exam.examDate}T12:00:00`)
    })).filter((event) => event.date >= firstDate && event.date <= lastDate),
    ...workspace.schedule.flatMap((item) =>
      getOccurrences(item, firstDate, lastDate).map((date) => ({ type: "schedule", item, date }))
    )
  ];
  for (let index = 0; index < 42; index += 1) {
    const date = new Date(firstDate.getFullYear(), firstDate.getMonth(), firstDate.getDate() + index);
    const key = dateKey(date);
    const cell = element("div", `calendar-day${date.getMonth() !== month ? " outside-month" : ""}${key === dateKey(new Date()) ? " today" : ""}`);
    cell.dataset.date = key;
    cell.append(element("span", "calendar-day-number", String(date.getDate())));
    cell.addEventListener("dragover", (event) => {
      event.preventDefault();
      cell.classList.add("drop-target");
    });
    cell.addEventListener("dragleave", (event) => {
      if (!cell.contains(event.relatedTarget)) cell.classList.remove("drop-target");
    });
    cell.addEventListener("drop", async (event) => {
      event.preventDefault();
      cell.classList.remove("drop-target");
      const itemId = event.dataTransfer.getData("text/plain");
      const item = workspace.schedule.find((entry) => entry.id === itemId);
      if (!item || dateKey(new Date(item.date)) === key) return;
      const oldDate = new Date(item.date);
      const movedDate = new Date(date.getFullYear(), date.getMonth(), date.getDate(), oldDate.getHours(), oldDate.getMinutes());
      try {
        await request(`/api/schedule/${encodeURIComponent(item.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ date: movedDate.toISOString() })
        });
        await loadWorkspace();
        showToast(`Moved "${item.title}" to ${formatDate(movedDate, { month: "short", day: "numeric" })}.`);
      } catch (error) { showToast(error.message, true); }
    });
    const dayEvents = events.filter((event) => dateKey(event.date) === key);
    for (const occurrence of dayEvents.slice(0, 3)) {
      if (occurrence.type === "exam") {
        const unit = workspace.units.find((item) => item.id === occurrence.exam.unitId);
        const label = `${unit ? unit.code : "Exam"} ${shortExamCountdownText(occurrence.exam)}`;
        const chip = element("button", "calendar-event calendar-exam", label);
        chip.type = "button";
        chip.title = `${unit ? `${unit.code} · ${unit.title}` : "Exam"} · ${occurrence.exam.examTime || "Time TBC"} · ${occurrence.exam.venue || "Venue TBC"} · ${examCountdownText(occurrence.exam)}`;
        chip.addEventListener("click", () => showView("academics"));
        cell.append(chip);
        continue;
      }
      const { item, date: eventDate } = occurrence;
      const chip = element("button", `calendar-event ${categoryClass(item.category)}${occurrenceIsDone(item, eventDate) ? " completed" : ""}`, item.title);
      chip.type = "button";
      chip.draggable = true;
      chip.title = `${item.title}${unitLabel(item.unitId) ? ` · ${unitLabel(item.unitId)}` : ""} · ${formatDate(eventDate)}${item.repeat !== "none" ? ` · Repeats ${item.repeat}` : ""}`;
      chip.addEventListener("click", () => editSchedule(item));
      chip.addEventListener("dragstart", (event) => {
        event.dataTransfer.setData("text/plain", item.id);
        event.dataTransfer.effectAllowed = "move";
        chip.classList.add("dragging");
      });
      chip.addEventListener("dragend", () => chip.classList.remove("dragging"));
      cell.append(chip);
    }
    if (dayEvents.length > 3) cell.append(element("span", "calendar-more", `+${dayEvents.length - 3} more`));
    grid.append(cell);
  }
}

function showView(name) {
  document.querySelectorAll(".hub-view").forEach((view) => { view.hidden = view.id !== `view-${name}`; });
  document.querySelectorAll(".nav-link").forEach((link) => {
    const active = link.dataset.view === name;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  document.querySelector("#breadcrumb-current").textContent = name === "overview" ? "Home" : ({
    schedule: "Schedule", academics: "Academic year & units", files: "School files",
    inbox: "Notifications & messages", settings: "Settings & privacy"
  })[name];
  if (sidebarIsMobile() && dashboardView.classList.contains("sidebar-open")) closeMobileSidebar(true);
}

function sidebarIsMobile() {
  return window.matchMedia("(max-width: 899px)").matches;
}

function openMobileSidebar() {
  dashboardView.classList.add("sidebar-open");
  document.body.classList.add("sidebar-scroll-locked");
  document.querySelector("#dashboard-sidebar").inert = false;
  document.querySelector("#dashboard-sidebar").setAttribute("aria-hidden", "false");
  document.querySelector("#sidebar-backdrop").setAttribute("aria-hidden", "false");
  document.querySelector("#sidebar-toggle").setAttribute("aria-expanded", "true");
  document.querySelector("#sidebar-toggle").setAttribute("aria-label", "Close navigation menu");
  document.querySelector("#sidebar-toggle").title = "Close navigation menu";
  window.requestAnimationFrame(() => document.querySelector(".side-nav .nav-link")?.focus());
}

function closeMobileSidebar(returnFocus = true) {
  dashboardView.classList.remove("sidebar-open");
  document.body.classList.remove("sidebar-scroll-locked");
  document.querySelector("#dashboard-sidebar").inert = true;
  document.querySelector("#dashboard-sidebar").setAttribute("aria-hidden", "true");
  document.querySelector("#sidebar-backdrop").setAttribute("aria-hidden", "true");
  const toggle = document.querySelector("#sidebar-toggle");
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-label", "Open navigation menu");
  toggle.title = "Open navigation menu";
  if (returnFocus && sidebarIsMobile() && !dashboardView.hidden) toggle.focus();
}

function applySavedSidebarState() {
  let collapsed = false;
  try { collapsed = localStorage.getItem("obadianSidebarCollapsed") === "yes"; }
  catch { showToast("Sidebar preference could not be loaded in this browser.", true); }
  collapsed = collapsed && !sidebarIsMobile();
  dashboardView.classList.toggle("sidebar-collapsed", collapsed);
  if (sidebarIsMobile()) {
    closeMobileSidebar(false);
    updateDesktopSidebarToggle(true);
    return;
  }
  updateDesktopSidebarToggle(collapsed);
}

function updateDesktopSidebarToggle(collapsed) {
  const toggle = document.querySelector("#sidebar-toggle");
  const sidebar = document.querySelector("#dashboard-sidebar");
  sidebar.inert = collapsed;
  sidebar.setAttribute("aria-hidden", String(collapsed));
  toggle.setAttribute("aria-expanded", String(!collapsed));
  toggle.setAttribute("aria-label", collapsed ? "Open navigation menu" : "Close navigation menu");
  toggle.title = collapsed ? "Open navigation menu" : "Close navigation menu";
}

document.querySelector("#sidebar-toggle").addEventListener("click", () => {
  if (sidebarIsMobile()) {
    if (dashboardView.classList.contains("sidebar-open")) closeMobileSidebar();
    else openMobileSidebar();
    return;
  }
  const collapsed = !dashboardView.classList.contains("sidebar-collapsed");
  dashboardView.classList.toggle("sidebar-collapsed", collapsed);
  updateDesktopSidebarToggle(collapsed);
  try { localStorage.setItem("obadianSidebarCollapsed", collapsed ? "yes" : "no"); }
  catch { showToast("Sidebar preference could not be saved in this browser.", true); }
});

document.querySelector("#sidebar-backdrop").addEventListener("click", () => closeMobileSidebar());
document.addEventListener("keydown", (event) => {
  if (!dashboardView.classList.contains("sidebar-open")) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeMobileSidebar(true);
    return;
  }
  if (event.key === "Tab") {
    const focusable = [...document.querySelector("#dashboard-sidebar").querySelectorAll('a[href], button:not(:disabled), [tabindex="0"]')]
      .filter((node) => !node.hidden && node.getClientRects().length);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || !document.querySelector("#dashboard-sidebar").contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !document.querySelector("#dashboard-sidebar").contains(document.activeElement))) {
      event.preventDefault();
      first.focus();
    }
  }
});
window.matchMedia("(max-width: 899px)").addEventListener("change", (event) => {
  if (!event.matches) closeMobileSidebar(false);
  applySavedSidebarState();
});

function renderSchedule() {
  const sorted = [...workspace.schedule].sort((a, b) => a.date.localeCompare(b.date));
  const list = document.querySelector("#schedule-list");
  const preview = document.querySelector("#upcoming-preview");
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekEnd = new Date(todayStart.getFullYear(), todayStart.getMonth(), todayStart.getDate() + 7);
  const nextOccurrences = sorted.flatMap((item) =>
    getOccurrences(item, todayStart, new Date(todayStart.getFullYear(), todayStart.getMonth(), todayStart.getDate() + 60))
      .map((date) => ({ item, date }))
  ).filter(({ item, date }) => date >= now && !occurrenceIsDone(item, date))
    .sort((left, right) => left.date - right.date);
  const todayCount = sorted.reduce((total, item) =>
    total + getOccurrences(item, todayStart, todayStart).filter((date) => !occurrenceIsDone(item, date)).length, 0);
  const weekCount = sorted.reduce((total, item) =>
    total + getOccurrences(item, todayStart, weekEnd).filter((date) => date >= todayStart && !occurrenceIsDone(item, date)).length, 0);
  renderCalendar();
  list.replaceChildren();
  preview.replaceChildren();
  if (!sorted.length) list.append(emptyState("Your calendar is ready for a first activity.", "Add an activity →", "schedule"));
  if (!nextOccurrences.length) preview.append(emptyState("Nothing scheduled soon.", "Open your schedule →", "schedule"));
  for (const occurrence of nextOccurrences.slice(0, 3)) {
    const { item, date } = occurrence;
    const row = element("article", `hub-item ${categoryClass(item.category)}`);
    const details = element("div", "hub-item-copy");
    details.append(element("strong", "", item.title), element("small", "", `${formatDate(date)} · ${item.category}${unitLabel(item.unitId) ? ` · ${unitLabel(item.unitId)}` : ""}${item.repeat !== "none" ? ` · Repeats ${item.repeat}` : ""}`));
    if (item.details) details.append(element("p", "", item.details));
    row.append(details);
    preview.append(row);
  }
  for (const item of sorted) {
    const nextDate = getOccurrences(item, todayStart, new Date(todayStart.getFullYear(), todayStart.getMonth(), todayStart.getDate() + 365))
      .find((date) => !occurrenceIsDone(item, date));
    const row = element("article", `hub-item${!nextDate ? " completed" : ""}`);
    row.dataset.scheduleId = item.id;
    const details = element("div", "hub-item-copy");
    details.append(element("strong", "", item.title), element("small", "", `${nextDate ? formatDate(nextDate) : formatDate(item.date)} · ${item.category}${unitLabel(item.unitId) ? ` · ${unitLabel(item.unitId)}` : ""}${item.repeat !== "none" ? ` · Repeats ${item.repeat}` : ""}`));
    if (item.details) details.append(element("p", "", item.details));
    row.append(details);
    const actions = element("div", "item-actions");
    if (nextDate) {
      const done = element("button", "item-action", "Mark done");
      done.type = "button";
      done.addEventListener("click", async () => {
        try {
          await request(`/api/schedule/${encodeURIComponent(item.id)}`, {
            method: "PATCH",
            body: JSON.stringify({ occurrenceDate: dateKey(nextDate), done: true })
          });
          await loadWorkspace();
          showToast("Activity marked as done.");
        } catch (error) { showToast(error.message, true); }
      });
      actions.append(done);
    } else if (item.repeat === "none" && item.completedDates.length) {
      const undo = element("button", "item-action", "Undo done");
      undo.type = "button";
      undo.addEventListener("click", async () => {
        try {
          await request(`/api/schedule/${encodeURIComponent(item.id)}`, {
            method: "PATCH",
            body: JSON.stringify({ occurrenceDate: item.completedDates[0], done: false })
          });
          await loadWorkspace();
          showToast("Activity marked as not done.");
        } catch (error) { showToast(error.message, true); }
      });
      actions.append(undo);
    }
    const edit = element("button", "item-action", "Edit");
    edit.type = "button";
    edit.addEventListener("click", () => editSchedule(item));
    actions.append(edit);
    const remove = element("button", "item-action", "Remove");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${item.title}`);
    remove.addEventListener("click", async () => {
      try {
        await request(`/api/schedule/${encodeURIComponent(item.id)}`, { method: "DELETE" });
        await loadWorkspace();
        showToast("Activity removed.");
      } catch (error) { showToast(error.message, true); }
    });
    actions.append(remove);
    row.append(actions);
    list.append(row);
  }
  document.querySelector("#today-total").textContent = String(todayCount);
  document.querySelector("#week-total").textContent = String(weekCount);
  document.querySelector("#today-note").textContent = todayCount === 1 ? "One class or study session" : "Classes and study sessions";
}

function editSchedule(item) {
  const form = document.querySelector("#schedule-form");
  editingScheduleId = item.id;
  form.elements.title.value = item.title;
  form.elements.date.value = localDateTimeValue(item.date);
  populateUnitSelect(form.elements.unitId, "No unit selected");
  form.elements.unitId.value = item.unitId || "";
  form.elements.category.value = item.category || "General";
  form.elements.repeat.value = item.repeat || "none";
  form.elements.reminderMinutes.value = String(item.reminderMinutes || 0);
  form.elements.details.value = item.details || "";
  document.querySelector("#schedule-form-heading").textContent = "Edit activity";
  document.querySelector("#schedule-submit").textContent = "Save changes";
  document.querySelector("#schedule-cancel").hidden = false;
  form.scrollIntoView({ behavior: "smooth", block: "start" });
  form.elements.title.focus();
}

function resetScheduleForm() {
  const form = document.querySelector("#schedule-form");
  form.reset();
  editingScheduleId = null;
  document.querySelector("#schedule-form-heading").textContent = "Add an activity";
  document.querySelector("#schedule-submit").textContent = "Save activity";
  document.querySelector("#schedule-cancel").hidden = true;
}

function resetUnitForm() {
  const form = document.querySelector("#unit-form");
  form.reset();
  editingUnitId = null;
  document.querySelector("#unit-form-heading").textContent = "Add a unit";
  document.querySelector("#unit-submit").textContent = "Add unit";
  document.querySelector("#unit-cancel").hidden = true;
}

function resetAttendanceForm() {
  const form = document.querySelector("#attendance-form");
  form.reset();
  editingAttendanceId = null;
  document.querySelector("#attendance-date").value = dateKey(new Date());
  document.querySelector("#attendance-submit").textContent = "Record attendance";
  document.querySelector("#attendance-cancel").hidden = true;
}

function currentAcademicPeriod(settings = workspace.academicSettings) {
  const parts = [];
  if (settings.yearOfStudy) parts.push(`Year ${settings.yearOfStudy}`);
  if (settings.academicYear) parts.push(settings.academicYear);
  if (settings.semester) parts.push(settings.semester);
  return parts.join(" · ") || "Academic period not set";
}

function editUnit(unit) {
  const form = document.querySelector("#unit-form");
  editingUnitId = unit.id;
  form.elements.code.value = unit.code;
  form.elements.title.value = unit.title;
  form.elements.instructor.value = unit.instructor || "";
  document.querySelector("#unit-form-heading").textContent = `Edit ${unit.code}`;
  document.querySelector("#unit-submit").textContent = "Save unit";
  document.querySelector("#unit-cancel").hidden = false;
  form.scrollIntoView({ behavior: "smooth", block: "start" });
  form.elements.code.focus();
}

function editAttendance(record) {
  const form = document.querySelector("#attendance-form");
  editingAttendanceId = record.id;
  populateUnitSelect(form.elements.unitId, "Choose a unit");
  form.elements.unitId.value = record.unitId;
  form.elements.sessionDate.value = record.sessionDate;
  form.elements.status.value = record.status;
  form.elements.notes.value = record.notes;
  document.querySelector("#attendance-submit").textContent = "Save attendance";
  document.querySelector("#attendance-cancel").hidden = false;
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function formatWeekday(day) {
  return Number.isInteger(day) && day >= 0 && day <= 6
    ? new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(new Date(2024, 0, 7 + day))
    : "Day TBC";
}

function renderExamCountdowns() {
  const list = document.querySelector("#exam-countdowns");
  if (!list) return;
  list.replaceChildren();
  const exams = sortedExamSessions();
  if (!exams.length) {
    list.append(element("p", "empty-state", "No confirmed exam timetable yet. Upload and confirm it in Academic year & units."));
    return;
  }
  for (const exam of exams) {
    const unit = workspace.units.find((item) => item.id === exam.unitId);
    const row = element("article", "exam-countdown-item");
    const details = element("div", "hub-item-copy");
    details.append(element("strong", "", unit ? `${unit.code} · ${unit.title}` : "Exam"));
    const dateLabel = exam.examDate
      ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "Africa/Nairobi" })
        .format(dateInNairobi(exam.examDate))
      : "Date TBC";
    details.append(element("small", "", `${dateLabel} · ${exam.examTime || "Time TBC"} · ${exam.venue || "Venue TBC"}`));
    const countdown = element("span", `exam-countdown${examCountdownText(exam) === "Done" ? " exam-done" : ""}`, examCountdownText(exam));
    row.append(details, countdown);
    list.append(row);
  }
}

function renderSavedTimetables() {
  const classList = document.querySelector("#class-sessions-list");
  classList.replaceChildren();
  if (!workspace.classSessions.length) {
    classList.append(element("p", "empty-state", "No confirmed class sessions yet."));
  }
  for (const session of workspace.classSessions) {
    const unit = workspace.units.find((item) => item.id === session.unitId);
    const row = element("article", "hub-item timetable-saved-item");
    const detail = element("div", "hub-item-copy");
    const time = session.startTime && session.endTime ? `${session.startTime}–${session.endTime}`
      : session.startTime || session.endTime || "Time TBC";
    detail.append(element("strong", "", unit ? `${unit.code} · ${unit.title}` : "Class session"));
    detail.append(element("small", "", `${formatWeekday(session.dayOfWeek)} · ${time} · ${session.venue || "Venue TBC"}${session.lecturer ? ` · ${session.lecturer}` : ""}`));
    row.append(detail);
    classList.append(row);
  }

  const examList = document.querySelector("#exam-sessions-list");
  examList.replaceChildren();
  if (!workspace.examSessions.length) {
    examList.append(element("p", "empty-state", "No confirmed exam sessions yet."));
  }
  for (const exam of sortedExamSessions()) {
    const unit = workspace.units.find((item) => item.id === exam.unitId);
    const row = element("article", "hub-item timetable-saved-item");
    const detail = element("div", "hub-item-copy");
    const dateLabel = exam.examDate
      ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "Africa/Nairobi" }).format(dateInNairobi(exam.examDate))
      : "Date TBC";
    detail.append(element("strong", "", unit ? `${unit.code} · ${unit.title}` : "Exam"));
    detail.append(element("small", "", `${dateLabel} · ${exam.examTime || "Time TBC"} · ${exam.venue || "Venue TBC"} · ${examCountdownText(exam)}`));
    row.append(detail);
    examList.append(row);
  }
}

const weekdayOptions = [
  ["", "Day TBC"], ["0", "Sunday"], ["1", "Monday"], ["2", "Tuesday"],
  ["3", "Wednesday"], ["4", "Thursday"], ["5", "Friday"], ["6", "Saturday"]
];

function makeTimetableField(type, row, field, rowIndex) {
  let control;
  if (field === "unitId") {
    control = document.createElement("select");
    control.add(new Option("Choose unit", ""));
    for (const unit of workspace.units) control.add(new Option(`${unit.code} · ${unit.title}`, unit.id));
    control.value = row.unitId || "";
  } else if (field === "dayOfWeek") {
    control = document.createElement("select");
    for (const [value, label] of weekdayOptions) control.add(new Option(label, value));
    control.value = row.dayOfWeek === null || row.dayOfWeek === "" ? "" : String(row.dayOfWeek);
  } else {
    control = document.createElement("input");
    control.type = ({
      startTime: "time", endTime: "time", examDate: "date", examTime: "time", duration: "number"
    })[field] || "text";
    control.value = row[field] === null ? "" : row[field] || "";
    if (field === "duration") {
      control.min = "1";
      control.max = "600";
      control.step = "1";
      control.placeholder = "Minutes";
    }
    if (field === "venue") control.maxLength = 120;
    if (field === "lecturer") control.maxLength = 120;
  }
  control.setAttribute("aria-label", `${type === "class" ? "Class" : "Exam"} row ${rowIndex + 1}: ${field.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`)}`);
  control.addEventListener("change", () => {
    if (field === "dayOfWeek") row[field] = control.value === "" ? null : Number(control.value);
    else if (field === "duration") row[field] = control.value === "" ? null : Number(control.value);
    else row[field] = control.value;
  });
  return control;
}

function renderTimetableReview(type) {
  const review = document.querySelector(`#${type}-timetable-review`);
  const draft = timetableDrafts[type];
  review.replaceChildren();
  review.hidden = !draft;
  if (!draft) return;
  review.append(element("h3", "", `Review ${type} timetable${draft.name ? ` · ${draft.name}` : ""}`));
  if (draft.warning) review.append(element("p", "timetable-warning", draft.warning));
  if (draft.unmatchedCodes.length) {
    review.append(element("p", "timetable-warning", `Codes not matched to your saved units (ignored): ${draft.unmatchedCodes.join(", ")}`));
  }
  if (!draft.rows.length) review.append(element("p", "empty-state", "No matching rows were found. Add each timetable entry manually below."));

  if (draft.rows.length) {
    const wrapper = element("div", "timetable-table-wrap");
    const table = element("table", "timetable-table");
    const headers = type === "class"
      ? ["Unit", "Day", "Start", "End", "Venue", "Lecturer", "Action"]
      : ["Unit", "Exam date", "Time", "Venue", "Duration (min)", "Action"];
    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    for (const header of headers) headerRow.append(element("th", "", header));
    thead.append(headerRow);
    const tbody = document.createElement("tbody");
    draft.rows.forEach((row, index) => {
      const tr = document.createElement("tr");
      const fields = type === "class"
        ? ["unitId", "dayOfWeek", "startTime", "endTime", "venue", "lecturer"]
        : ["unitId", "examDate", "examTime", "venue", "duration"];
      for (const field of fields) {
        const cell = document.createElement("td");
        cell.append(makeTimetableField(type, row, field, index));
        tr.append(cell);
      }
      const actions = document.createElement("td");
      const remove = element("button", "item-action danger-action", "Delete");
      remove.type = "button";
      remove.addEventListener("click", () => {
        draft.rows.splice(index, 1);
        renderTimetableReview(type);
      });
      actions.append(remove);
      tr.append(actions);
      tbody.append(tr);
    });
    table.append(thead, tbody);
    wrapper.append(table);
    review.append(wrapper);
  }

  const actions = element("div", "form-actions timetable-review-actions");
  const add = element("button", "item-action", "Add row manually");
  add.type = "button";
  add.disabled = !workspace.units.length;
  add.addEventListener("click", () => {
    const defaultUnit = workspace.units[0];
    draft.rows.push(type === "class"
      ? { unitId: defaultUnit?.id || "", dayOfWeek: null, startTime: "", endTime: "", venue: "", lecturer: "" }
      : { unitId: defaultUnit?.id || "", examDate: "", examTime: "", venue: "", duration: null });
    renderTimetableReview(type);
  });
  const confirm = element("button", "new-project-button", "Confirm and replace saved timetable");
  confirm.type = "button";
  confirm.disabled = !draft.rows.length;
  confirm.addEventListener("click", async () => {
    try {
      await request("/api/timetable/confirm", {
        method: "POST",
        body: JSON.stringify({ type, rows: draft.rows })
      });
      timetableDrafts[type] = null;
      await loadWorkspace();
      showToast(`${type === "class" ? "Class" : "Exam"} timetable confirmed.`);
    } catch (error) {
      showToast(error.message, true);
    }
  });
  const discard = element("button", "item-action", "Discard review");
  discard.type = "button";
  discard.addEventListener("click", () => {
    timetableDrafts[type] = null;
    renderTimetableReview(type);
  });
  actions.append(add, confirm, discard);
  review.append(actions);
}

function renderTimetableReviews() {
  renderTimetableReview("class");
  renderTimetableReview("exam");
}

function renderAcademic() {
  const settings = workspace.academicSettings || { academicYear: "", semester: "", yearOfStudy: 0 };
  document.querySelector("#year-of-study-input").value = String(settings.yearOfStudy || 0);
  document.querySelector("#academic-year-input").value = settings.academicYear || "";
  document.querySelector("#academic-semester-input").value = settings.semester || "";
  document.querySelector("#attendance-period-label").textContent =
    `Current period: ${currentAcademicPeriod()}. Attendance is grouped by the period active when each record is created.`;
  populateUnitSelect(document.querySelector("#schedule-unit"), "No unit selected");
  populateUnitSelect(document.querySelector("#attendance-unit"), "Choose a unit");
  renderSavedTimetables();
  renderTimetableReviews();

  const unitList = document.querySelector("#academic-unit-list");
  unitList.replaceChildren();
  if (!workspace.units.length) {
    unitList.append(element("p", "empty-state", "No units yet. Add your first unit above."));
  }
  for (const unit of workspace.units) {
    const row = element("article", "hub-item academic-unit-item");
    const details = element("div", "hub-item-copy");
    details.append(element("strong", "", `${unit.code} · ${unit.title}`));
    if (unit.instructor) details.append(element("small", "", `Lecturer: ${unit.instructor}`));
    const actions = element("div", "item-actions");
    const edit = element("button", "item-action", "Edit");
    edit.type = "button";
    edit.addEventListener("click", () => editUnit(unit));
    const remove = element("button", "item-action danger-action", "Remove");
    remove.type = "button";
    remove.addEventListener("click", async () => {
      if (!window.confirm(`Remove ${unit.code} · ${unit.title}? Its attendance records will also be deleted, and scheduled activities will be unlinked.`)) return;
      try {
        await request(`/api/units/${encodeURIComponent(unit.id)}`, { method: "DELETE" });
        await loadWorkspace();
        showToast("Unit removed.");
      } catch (error) { showToast(error.message, true); }
    });
    actions.append(edit, remove);
    row.append(details, actions);
    unitList.append(row);
  }

  const periodAttendance = workspace.attendance.filter((record) =>
    record.yearOfStudy === settings.yearOfStudy
    && record.academicYear === (settings.academicYear || "")
    && record.semester === (settings.semester || "")
  );
  const present = periodAttendance.filter((record) => record.status === "present").length;
  const late = periodAttendance.filter((record) => record.status === "late").length;
  const absent = periodAttendance.filter((record) => record.status === "absent").length;
  const excused = periodAttendance.filter((record) => record.status === "excused").length;
  const counted = present + late + absent;
  const rate = counted ? Math.round((present + late) / counted * 100) : 0;
  const summary = document.querySelector("#attendance-summary");
  summary.replaceChildren();
  for (const [label, value] of [
    ["Attendance rate", `${rate}%`], ["Attended", String(present + late)],
    ["Absent", String(absent)], ["Excused", String(excused)]
  ]) {
    const card = element("div", "attendance-stat");
    card.append(element("span", "", label), element("strong", "", value));
    summary.append(card);
  }

  const attendanceList = document.querySelector("#attendance-list");
  attendanceList.replaceChildren();
  if (!periodAttendance.length) {
    attendanceList.append(element("p", "empty-state", "No class attendance recorded for this academic period yet."));
  }
  for (const record of periodAttendance) {
    const row = element("article", "hub-item attendance-item");
    const details = element("div", "hub-item-copy");
    const unit = workspace.units.find((item) => item.id === record.unitId);
    const unitText = unit ? `${unit.code} · ${unit.title}` : "Unit unavailable";
    const dateText = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(`${record.sessionDate}T12:00:00`));
    details.append(element("strong", "", unitText), element("small", "", `${dateText} · ${record.status[0].toUpperCase()}${record.status.slice(1)}`));
    if (record.notes) details.append(element("p", "", record.notes));
    const actions = element("div", "item-actions");
    const edit = element("button", "item-action", "Edit");
    edit.type = "button";
    edit.addEventListener("click", () => editAttendance(record));
    const remove = element("button", "item-action danger-action", "Delete");
    remove.type = "button";
    remove.addEventListener("click", async () => {
      if (!window.confirm(`Delete attendance record for ${unitText} on ${dateText}?`)) return;
      try {
        await request(`/api/attendance/${encodeURIComponent(record.id)}`, { method: "DELETE" });
        await loadWorkspace();
        showToast("Attendance record deleted.");
      } catch (error) { showToast(error.message, true); }
    });
    actions.append(edit, remove);
    row.append(details, actions);
    attendanceList.append(row);
  }
}

function isPreviewable(mime) {
  return mime === "application/pdf" || mime.startsWith("image/") || mime.startsWith("video/");
}

function openFilePreview(file) {
  const dialog = document.querySelector("#file-preview-dialog");
  const content = document.querySelector("#file-preview-content");
  const source = `/api/files/${encodeURIComponent(file.id)}/preview`;
  file.openedAt = new Date().toISOString();
  renderRecentFiles();
  content.replaceChildren();
  document.querySelector("#file-preview-title").textContent = file.name;
  if (file.mime.startsWith("image/")) {
    const image = element("img", "preview-image");
    image.src = source;
    image.alt = file.name;
    content.append(image);
  } else if (file.mime.startsWith("video/")) {
    const video = element("video", "preview-video");
    video.controls = true;
    video.preload = "metadata";
    video.src = source;
    content.append(video);
  } else {
    const frame = element("iframe", "preview-pdf");
    frame.src = source;
    frame.title = `PDF preview: ${file.name}`;
    content.append(frame);
  }
  if (typeof dialog.showModal === "function") dialog.showModal();
}

function renderFiles() {
  const list = document.querySelector("#files-list");
  const folderSelect = document.querySelector("#folder-filter");
  const currentFolder = folderSelect.value;
  const search = document.querySelector("#file-search-input").value.trim().toLowerCase();
  const folders = [...new Set(workspace.files.map((file) => file.folder).filter(Boolean))].sort();
  folderSelect.replaceChildren(new Option("All folders", ""));
  folders.forEach((folder) => folderSelect.add(new Option(folder, folder)));
  folderSelect.value = folders.includes(currentFolder) ? currentFolder : "";
  const selectedFolder = folderSelect.value;
  list.replaceChildren();
  const files = workspace.files.filter((file) =>
    (!selectedFolder || file.folder === selectedFolder)
    && (!search || `${file.name} ${file.folder} ${file.mime}`.toLowerCase().includes(search))
  );
  if (!files.length) list.append(element("p", "empty-state", "No files in this folder yet."));
  for (const file of files) {
    const row = element("article", "hub-item");
    row.dataset.fileId = file.id;
    const details = element("div", "hub-item-copy");
    const title = element("strong", "", file.name);
    const folderLabel = file.folder ? ` · ${file.folder}` : "";
    details.append(title, element("small", "", `${file.mime.split("/")[0]} · ${formatBytes(file.size)}${folderLabel} · ${formatDate(file.createdAt)}`));
    const actions = element("div", "item-actions");
    if (isPreviewable(file.mime)) {
      const preview = element("button", "item-action", "Preview");
      preview.type = "button";
      preview.addEventListener("click", () => openFilePreview(file));
      actions.append(preview);
    }
    const organize = element("button", "item-action", "Rename / move");
    organize.type = "button";
    organize.addEventListener("click", () => openFileEdit(file));
    const download = element("a", "item-action", "Download");
    download.href = `/api/files/${encodeURIComponent(file.id)}`;
    download.setAttribute("aria-label", `Download ${file.name}`);
    download.addEventListener("click", () => {
      file.openedAt = new Date().toISOString();
      renderRecentFiles();
    });
    const remove = element("button", "item-action danger-action", "Delete");
    remove.type = "button";
    remove.addEventListener("click", async () => {
      if (!window.confirm(`Delete "${file.name}"?`)) return;
      try {
        await request(`/api/files/${encodeURIComponent(file.id)}`, { method: "DELETE" });
        await loadWorkspace();
        showToast("File deleted.");
      } catch (error) { showToast(error.message, true); }
    });
    actions.append(organize, download, remove);
    row.append(details, actions);
    list.append(row);
  }
  document.querySelector("#files-total").textContent = String(workspace.files.length);
  document.querySelector("#files-note").textContent = `${formatBytes(workspace.storageUsedBytes)} of ${formatBytes(workspace.storageQuotaBytes)} used`;
  const percentage = workspace.storageQuotaBytes
    ? Math.min(100, Math.round(workspace.storageUsedBytes / workspace.storageQuotaBytes * 100))
    : 0;
  document.querySelector("#storage-label").textContent = `${formatBytes(workspace.storageUsedBytes)} of ${formatBytes(workspace.storageQuotaBytes)} used`;
  document.querySelector("#storage-percent").textContent = `${percentage}%`;
  const storageTrack = document.querySelector(".storage-track");
  storageTrack.setAttribute("aria-valuenow", String(percentage));
  document.querySelector("#storage-fill").style.width = `${percentage}%`;
  renderRecentFiles();
}

function renderRecentFiles() {
  const list = document.querySelector("#recent-files-preview");
  const recent = workspace.files.filter((file) => file.openedAt)
    .sort((left, right) => right.openedAt.localeCompare(left.openedAt)).slice(0, 3);
  list.replaceChildren();
  if (!recent.length) {
    list.append(emptyState("Your recently opened files will appear here.", "Browse school files →", "files"));
    return;
  }
  for (const file of recent) {
    const row = element("button", "recent-file-row", file.name);
    row.type = "button";
    row.title = `Open ${file.name}`;
    row.addEventListener("click", () => {
      showView("files");
      document.querySelector("#folder-filter").value = file.folder || "";
      renderFiles();
      const fileRow = document.querySelector(`[data-file-id="${CSS.escape(file.id)}"]`);
      fileRow?.scrollIntoView({ behavior: "smooth", block: "center" });
      if (isPreviewable(file.mime)) openFilePreview(file);
    });
    list.append(row);
  }
}

function openFileEdit(file) {
  document.querySelector("#file-edit-id").value = file.id;
  document.querySelector("#file-edit-name").value = file.name;
  document.querySelector("#file-edit-folder").value = file.folder || "";
  document.querySelector("#file-edit-dialog").showModal();
}

function renderInbox() {
  const list = document.querySelector("#inbox-list");
  list.replaceChildren();
  if (!workspace.inbox.length) list.append(element("p", "empty-state", "Your inbox is empty. Send a message if you need help."));
  for (const item of workspace.inbox) {
    const row = element("article", "hub-item inbox-item");
    const details = element("div", "hub-item-copy");
    details.append(element("strong", "", item.type === "message" ? "Your message to the admin"
      : item.type === "announcement" ? "Administrator announcement" : "Obadian Hub support"));
    details.append(element("p", "", item.text));
    details.append(element("small", "", formatDate(item.createdAt)));
    row.append(details);
    list.append(row);
  }
  const announcements = workspace.inbox.filter((item) => item.type === "announcement"
    || (item.type === "notification" && item.sender === "admin"));
  const banner = document.querySelector("#announcement-banner");
  const bannerList = document.querySelector("#announcement-banner-list");
  bannerList.replaceChildren();
  const dismissedIds = getDismissedAnnouncementIds();
  for (const item of announcements) {
    if (dismissedIds.has(item.id)) continue;
    const row = element("article", "announcement-banner-item");
    row.dataset.announcementId = item.id;
    const copy = element("div", "announcement-banner-copy");
    copy.append(element("p", "", item.text), element("small", "", formatDate(item.createdAt)));
    const dismiss = element("button", "announcement-dismiss", "Dismiss");
    dismiss.type = "button";
    dismiss.setAttribute("aria-label", "Dismiss this announcement");
    dismiss.addEventListener("click", () => dismissAnnouncement(item.id, row));
    row.append(copy, dismiss);
    let pointerStart = null;
    row.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) return;
      pointerStart = { x: event.clientX, y: event.clientY };
    });
    row.addEventListener("pointerup", (event) => {
      if (!pointerStart) return;
      const deltaX = event.clientX - pointerStart.x;
      const deltaY = event.clientY - pointerStart.y;
      pointerStart = null;
      if (deltaX < -60 && Math.abs(deltaX) > Math.abs(deltaY)) dismissAnnouncement(item.id, row);
    });
    row.addEventListener("pointercancel", () => { pointerStart = null; });
    bannerList.append(row);
  }
  banner.hidden = bannerList.childElementCount === 0;
  const count = workspace.inbox.filter((item) => (item.type === "notification" || item.type === "announcement")
    && !dismissedIds.has(item.id)).length;
  document.querySelector("#inbox-count").textContent = String(count);
}

function getDismissedAnnouncementIds() {
  if (!currentUser) return new Set();
  const ids = new Set(dismissedAnnouncementIds);
  try {
    const storedIds = JSON.parse(localStorage.getItem(`obadianDismissedAnnouncements:${currentUser.email}`) || "[]");
    if (Array.isArray(storedIds)) {
      for (const id of storedIds) if (typeof id === "string") ids.add(id);
    }
  } catch {
    return ids;
  }
  return ids;
}

function dismissAnnouncement(id, row) {
  dismissedAnnouncementIds.add(id);
  const dismissedIds = getDismissedAnnouncementIds();
  dismissedIds.add(id);
  row.classList.add("announcement-dismissing");
  window.setTimeout(() => {
    row.remove();
    const banner = document.querySelector("#announcement-banner");
    banner.hidden = document.querySelector("#announcement-banner-list").childElementCount === 0;
    const remaining = workspace.inbox.filter((item) => (item.type === "notification" || item.type === "announcement")
      && !dismissedIds.has(item.id)).length;
    document.querySelector("#inbox-count").textContent = String(remaining);
  }, 220);
  try {
    localStorage.setItem(`obadianDismissedAnnouncements:${currentUser.email}`, JSON.stringify([...dismissedIds]));
  } catch {
    showToast("Announcement dismissed, but this browser could not save the dismissal.", true);
  }
}

function checkBrowserReminders() {
  if (!currentUser || !("Notification" in window) || Notification.permission !== "granted") return;
  const now = new Date();
  const rangeEnd = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  for (const item of workspace.schedule) {
    if (!item.reminderMinutes) continue;
    for (const date of getOccurrences(item, now, rangeEnd)) {
      if (occurrenceIsDone(item, date)) continue;
      const reminderAt = new Date(date.getTime() - item.reminderMinutes * 60000);
      if (now < reminderAt || now >= date) continue;
      const key = `obadianReminder:${currentUser.email}:${item.id}:${dateKey(date)}:${date.getHours()}:${date.getMinutes()}`;
      try {
        if (sentReminders.has(key) || localStorage.getItem(key)) continue;
        new Notification(`Coming up: ${item.title}`, {
          body: `${formatDate(date)}${item.category ? ` · ${item.category}` : ""}`,
          tag: key
        });
        sentReminders.add(key);
        localStorage.setItem(key, "sent");
      } catch {
        sentReminders.add(key);
        showToast("A reminder could not be saved in this browser. Keep Obadian Hub open to receive reminders.", true);
      }
    }
  }
}

async function enableBrowserReminders() {
  if (!("Notification" in window)) {
    showToast("This browser does not support desktop notifications.", true);
    return;
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    showToast("Browser notifications were not enabled. You can change this in browser settings.", true);
    return;
  }
  checkBrowserReminders();
  showToast("Browser reminders are enabled while Obadian Hub is open.");
}

function renderWorkspace() {
  renderSchedule();
  renderAcademic();
  renderFiles();
  renderInbox();
  renderExamCountdowns();
  checkBrowserReminders();
}

async function loadWorkspace() {
  const result = await request("/api/workspace");
  currentUser = result.user;
  workspace = {
    schedule: result.schedule,
    units: result.units,
    academicSettings: result.academicSettings,
    attendance: result.attendance,
    classSessions: result.classSessions || [],
    examSessions: result.examSessions || [],
    files: result.files,
    inbox: result.inbox,
    storageUsedBytes: result.storageUsedBytes,
    storageQuotaBytes: result.storageQuotaBytes
  };
  renderWorkspace();
}

async function refreshInbox() {
  if (!currentUser) return;
  const result = await request("/api/workspace");
  workspace.inbox = result.inbox;
  renderInbox();
}

function showDashboard(user, celebrate = false) {
  currentUser = user;
  authView.hidden = true;
  dashboardView.hidden = false;
  const cleanName = (value) => value.replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim();
  const profileName = cleanName(user.profileName || "");
  const fallbackName = cleanName(user.email.split("@")[0]);
  const greetingName = profileName || fallbackName.split(" ")[0] || "there";
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  document.querySelector("#profile-email").textContent = profileName || fallbackName || "Your account";
  document.querySelector("#profile-email-address").textContent = user.email;
  document.querySelector("#profile-email-address").title = user.email;
  document.querySelector("#logout-button").title = `Sign out of ${user.email}`;
  document.querySelector("#settings-email").textContent = user.email;
  document.querySelector("#settings-verified").textContent = user.emailVerified ? "Verified" : "Not verified";
  document.querySelector("#settings-created").textContent = user.createdAt ? formatDate(user.createdAt) : "Not available";
  document.querySelector("#profile-name-input").value = user.profileName || "";
  document.querySelector("#profile-phone-input").value = user.phone || "";
  document.querySelector("#profile-school-input").value = user.school || "";
  document.querySelector("#profile-course-input").value = user.course || "";
  setAvatarElement("#avatar", user);
  setAvatarElement("#topbar-avatar", user);
  const profilePhoto = document.querySelector("#profile-photo-preview");
  profilePhoto.hidden = !user.hasAvatar;
  if (user.hasAvatar) profilePhoto.src = `/api/avatar?v=${Date.now()}`;
  document.querySelector("#welcome-title").textContent = `${greeting}, ${greetingName}`;
  document.querySelector("#today-label").textContent = formatDate(new Date(), { weekday: "short", month: "short", day: "numeric" });
  applySavedSidebarState();
  showView("overview");
  loadWorkspace().then(() => {
    window.clearInterval(reminderTimer);
    reminderTimer = window.setInterval(checkBrowserReminders, 30000);
    window.clearInterval(inboxRefreshTimer);
    inboxRefreshTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") refreshInbox().catch((error) => showToast(error.message, true));
    }, 10000);
    window.clearInterval(examCountdownTimer);
    examCountdownTimer = window.setInterval(() => {
      renderExamCountdowns();
      renderCalendar();
    }, 60000);
  }).catch((error) => showToast(error.message, true));
  if (celebrate && typeof welcomeDialog.showModal === "function") welcomeDialog.showModal();
}

function showAuth() {
  if (welcomeDialog.open) welcomeDialog.close();
  dashboardView.hidden = true;
  authView.hidden = false;
  currentUser = null;
  window.clearInterval(reminderTimer);
  window.clearInterval(inboxRefreshTimer);
  window.clearInterval(examCountdownTimer);
  workspace = {
    schedule: [], units: [], academicSettings: { academicYear: "", semester: "", yearOfStudy: 0 },
    attendance: [], classSessions: [], examSessions: [], files: [], inbox: [], storageUsedBytes: 0, storageQuotaBytes: 500 * 1024 * 1024
  };
  authForm.reset();
  resendVerificationButton.hidden = true;
  setMode(false);
  emailInput.focus();
}

document.querySelector("#year").textContent = new Date().getFullYear();
document.querySelector("#switch-mode").addEventListener("click", () => {
  clearNotice();
  setMode(!isRegisterMode);
});
passwordInput.addEventListener("input", () => updatePasswordStrength(passwordInput, document.querySelector("#password-strength")));
document.querySelector("#new-password-input").addEventListener("input", (event) => updatePasswordStrength(event.currentTarget, document.querySelector("#change-password-strength")));
document.querySelector("#reset-password-input").addEventListener("input", (event) => updatePasswordStrength(event.currentTarget, document.querySelector("#reset-password-strength")));
passwordToggle.addEventListener("click", () => {
  const showPassword = passwordInput.type === "password";
  passwordInput.type = showPassword ? "text" : "password";
  passwordToggle.textContent = showPassword ? "Hide" : "Show";
  passwordToggle.setAttribute("aria-label", showPassword ? "Hide password" : "Show password");
});

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearNotice();
  submitButton.disabled = true;
  document.querySelector("#submit-label").textContent = isRegisterMode ? "Creating account…" : "Signing in…";
  try {
    const result = await request(isRegisterMode ? "/api/register" : "/api/login", {
      method: "POST",
      body: JSON.stringify({
        email: emailInput.value,
        password: passwordInput.value,
        agreeToPolicies: agreementCheckbox.checked,
        rememberMe: document.querySelector("#remember-me").checked
      })
    });
    if (result.approvalRequired) {
      showNotice("Account created. It is waiting for administrator approval. You can sign in with the password you chose after approval.", true);
    } else if (result.verificationRequired) {
      showNotice("Account created. Check your email and follow the verification link before signing in.", true);
      resendVerificationButton.hidden = false;
    } else {
      showDashboard(result.user, true);
    }
  } catch (error) {
    showNotice(error.message);
    if (/verify your email|verification email could not be sent/i.test(error.message)) {
      resendVerificationButton.hidden = false;
    }
  } finally {
    submitButton.disabled = false;
    document.querySelector("#submit-label").textContent = isRegisterMode ? "Create account" : "Sign in";
  }
});

resendVerificationButton.addEventListener("click", async () => {
  try {
    await request("/api/email/resend-verification", {
      method: "POST",
      body: JSON.stringify({ email: emailInput.value })
    });
    showNotice("If your account needs verification, a new link has been sent.", true);
  } catch (error) { showNotice(error.message); }
});

function showRecoveryNotice(message, success = false) {
  const notice = document.querySelector("#recovery-notice");
  notice.textContent = message;
  notice.classList.toggle("success", success);
  notice.hidden = false;
}

document.querySelector("#forgot-password").addEventListener("click", () => {
  document.querySelector("#recovery-title").textContent = "Reset your password";
  document.querySelector("#forgot-password-form").hidden = false;
  document.querySelector("#reset-password-form").hidden = true;
  document.querySelector("#forgot-email").value = emailInput.value;
  document.querySelector("#recovery-notice").hidden = true;
  recoveryDialog.showModal();
});
document.querySelector("#recovery-close").addEventListener("click", () => recoveryDialog.close());
document.querySelector("#forgot-password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = new FormData(event.currentTarget).get("email");
  try {
    await request("/api/password/forgot", { method: "POST", body: JSON.stringify({ email }) });
    showRecoveryNotice("If an account matches that email, a secure reset link has been sent.", true);
  } catch (error) { showRecoveryNotice(error.message); }
});
document.querySelector("#reset-password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await request("/api/password/reset", {
      method: "POST",
      body: JSON.stringify({ token: form.elements.token.value, password: form.elements.password.value })
    });
    recoveryDialog.close();
    showNotice("Password reset. Sign in with your new password.", true);
    form.reset();
    history.replaceState(null, "", location.pathname);
  } catch (error) { showRecoveryNotice(error.message); }
});

async function logout() {
  try {
    await request("/api/logout", { method: "POST", body: "{}" });
    showAuth();
  } catch (error) { showToast(error.message, true); }
}
document.querySelector("#logout-button").addEventListener("click", logout);
document.querySelector("#settings-logout").addEventListener("click", logout);

document.querySelectorAll(".nav-link").forEach((link) => link.addEventListener("click", () => showView(link.dataset.view)));
document.querySelectorAll("[data-open-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.openView)));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && currentUser) {
    refreshInbox().catch((error) => showToast(error.message, true));
  }
});
window.addEventListener("focus", () => {
  if (currentUser) refreshInbox().catch((error) => showToast(error.message, true));
});
document.querySelector("#schedule-cancel").addEventListener("click", resetScheduleForm);
document.querySelector("#unit-cancel").addEventListener("click", resetUnitForm);
document.querySelector("#attendance-cancel").addEventListener("click", resetAttendanceForm);
document.querySelector("#schedule-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const item = {
    title: data.get("title"),
    date: new Date(data.get("date")).toISOString(),
    unitId: data.get("unitId") || null,
    category: data.get("category"),
    repeat: data.get("repeat"),
    reminderMinutes: Number(data.get("reminderMinutes")),
    details: data.get("details")
  };
  const isEditing = Boolean(editingScheduleId);
  try {
    await request(editingScheduleId ? `/api/schedule/${encodeURIComponent(editingScheduleId)}` : "/api/schedule", {
      method: editingScheduleId ? "PATCH" : "POST",
      body: JSON.stringify(item)
    });
    resetScheduleForm();
    await loadWorkspace();
    showToast(isEditing ? "Activity updated." : "Activity saved.");
  } catch (error) { showToast(error.message, true); }
});

async function uploadTimetable(event, type) {
  event.preventDefault();
  const form = event.currentTarget;
  const file = form.elements.file.files[0];
  if (!file) return;
  if (!/\.pdf$/i.test(file.name)) {
    showToast("Choose a PDF timetable.", true);
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    showToast("Timetable PDFs must be 10 MB or smaller.", true);
    return;
  }
  const signature = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  if (String.fromCharCode(...signature) !== "%PDF-") {
    showToast("The selected file is not a valid PDF document.", true);
    return;
  }
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  const originalLabel = button.textContent;
  button.textContent = "Reading PDF…";
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
    }
    const result = await request("/api/timetable/parse", {
      method: "POST",
      body: JSON.stringify({ type, name: file.name, data: `data:application/pdf;base64,${btoa(chunks.join(""))}` })
    });
    timetableDrafts[type] = {
      rows: result.rows || [],
      unmatchedCodes: result.unmatchedCodes || [],
      warning: result.warning || "",
      name: file.name
    };
    form.reset();
    renderTimetableReview(type);
    showToast("Review the extracted rows before confirming.");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

document.querySelector("#class-timetable-upload").addEventListener("submit", (event) => {
  uploadTimetable(event, "class").catch((error) => showToast(error.message, true));
});
document.querySelector("#exam-timetable-upload").addEventListener("submit", (event) => {
  uploadTimetable(event, "exam").catch((error) => showToast(error.message, true));
});

document.querySelector("#academic-settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const previous = workspace.academicSettings;
  const next = {
    yearOfStudy: Number(form.elements.yearOfStudy.value),
    academicYear: form.elements.academicYear.value,
    semester: form.elements.semester.value
  };
  const periodChanged = previous.yearOfStudy !== next.yearOfStudy
    || previous.academicYear !== next.academicYear || previous.semester !== next.semester;
  const hadTimetable = workspace.classSessions.length > 0 || workspace.examSessions.length > 0;
  try {
    await request("/api/academic-settings", {
      method: "PATCH",
      body: JSON.stringify(next)
    });
    await loadWorkspace();
    showToast("Academic period saved.");
    if (periodChanged && hadTimetable && window.confirm("Your academic period changed. Existing timetable rows remain saved. Would you like to re-match them by uploading the timetables for the new period now?")) {
      showView("academics");
      document.querySelector("#class-timetable-upload").scrollIntoView({ behavior: "smooth", block: "center" });
      document.querySelector("#class-timetable-file").focus({ preventScroll: true });
    }
  } catch (error) { showToast(error.message, true); }
});

document.querySelector("#unit-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const isEditing = Boolean(editingUnitId);
  try {
    await request(isEditing ? `/api/units/${encodeURIComponent(editingUnitId)}` : "/api/units", {
      method: isEditing ? "PATCH" : "POST",
      body: JSON.stringify({
        code: form.elements.code.value,
        title: form.elements.title.value,
        instructor: form.elements.instructor.value
      })
    });
    resetUnitForm();
    await loadWorkspace();
    showToast(isEditing ? "Unit updated." : "Unit added.");
  } catch (error) { showToast(error.message, true); }
});

document.querySelector("#attendance-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const isEditing = Boolean(editingAttendanceId);
  try {
    await request(isEditing ? `/api/attendance/${encodeURIComponent(editingAttendanceId)}` : "/api/attendance", {
      method: isEditing ? "PATCH" : "POST",
      body: JSON.stringify({
        unitId: form.elements.unitId.value,
        sessionDate: form.elements.sessionDate.value,
        status: form.elements.status.value,
        notes: form.elements.notes.value
      })
    });
    resetAttendanceForm();
    await loadWorkspace();
    showToast(isEditing ? "Attendance record updated." : "Attendance recorded.");
  } catch (error) { showToast(error.message, true); }
});

document.querySelector("#upload-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const file = document.querySelector("#file-input").files[0];
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) return showToast("This file is over the 20 MB per-file limit. Choose a smaller file.", true);
  const submit = form.querySelector("button[type=submit]");
  submit.disabled = true;
  try {
    if (!file.type) throw new Error("This file type is not supported. Choose one of the listed formats.");
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Could not read the selected file."));
      reader.readAsDataURL(file);
    });
    const result = await request("/api/files", {
      method: "POST",
      body: JSON.stringify({ name: file.name, mime: file.type, data, folder: document.querySelector("#file-folder").value })
    });
    form.reset();
    await loadWorkspace();
    showToast(`${result.item.name} uploaded.`);
  } catch (error) { showToast(error.message, true); }
  finally { submit.disabled = false; }
});
document.querySelector("#folder-filter").addEventListener("change", renderFiles);
document.querySelector("#file-search-input").addEventListener("input", renderFiles);
document.querySelector("#file-edit-close").addEventListener("click", () => document.querySelector("#file-edit-dialog").close());
document.querySelector("#file-edit-close-secondary").addEventListener("click", () => document.querySelector("#file-edit-dialog").close());
document.querySelector("#file-edit-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.elements.id.value;
  try {
    await request(`/api/files/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ name: form.elements.name.value, folder: form.elements.folder.value })
    });
    document.querySelector("#file-edit-dialog").close();
    await loadWorkspace();
    showToast("File details saved.");
  } catch (error) { showToast(error.message, true); }
});

document.querySelector("#message-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await request("/api/messages", { method: "POST", body: JSON.stringify({ message: new FormData(form).get("message") }) });
    form.reset();
    await loadWorkspace();
    showToast("Your message was sent to the administrator.");
  } catch (error) { showToast(error.message, true); }
});

document.querySelector("#welcome-close").addEventListener("click", () => welcomeDialog.close());
document.querySelector("#welcome-continue").addEventListener("click", () => welcomeDialog.close());
document.querySelector("#file-preview-close").addEventListener("click", () => {
  const dialog = document.querySelector("#file-preview-dialog");
  dialog.close();
  document.querySelector("#file-preview-content").replaceChildren();
});

function applyTheme(theme, persist = true) {
  const activeTheme = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = activeTheme;
  if (persist) {
    try { localStorage.setItem("obadianTheme", activeTheme); }
    catch { showToast("Theme preference could not be saved in this browser.", true); }
  }
  const nextTheme = activeTheme === "dark" ? "light" : "dark";
  const themeToggle = document.querySelector("#theme-toggle");
  const themeAction = `Switch to ${nextTheme} mode`;
  themeToggle.textContent = `${nextTheme === "light" ? "☼" : "☾"} ${nextTheme === "light" ? "Light" : "Dark"} mode`;
  themeToggle.setAttribute("aria-label", themeAction);
  themeToggle.title = themeAction;
  themeToggle.setAttribute("aria-pressed", String(activeTheme === "light"));
  document.querySelector("#theme-toggle-settings").textContent = `Switch to ${nextTheme} mode`;
}

function toggleTheme() {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
}

let savedTheme = null;
try { savedTheme = localStorage.getItem("obadianTheme"); }
catch { showToast("Theme preference storage is unavailable in this browser.", true); }
applyTheme(savedTheme || (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"), Boolean(savedTheme));
if (!savedTheme) {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (event) => {
    let explicitTheme = null;
    try { explicitTheme = localStorage.getItem("obadianTheme"); }
    catch { showToast("Theme preference storage is unavailable in this browser.", true); }
    if (!explicitTheme) applyTheme(event.matches ? "dark" : "light", false);
  });
}
document.querySelector("#theme-toggle").addEventListener("click", toggleTheme);
document.querySelector("#theme-toggle-settings").addEventListener("click", toggleTheme);

document.querySelector("#calendar-prev").addEventListener("click", () => {
  calendarDate = new Date(calendarDate.getFullYear(), calendarDate.getMonth() - 1, 1);
  renderCalendar();
});
document.querySelector("#calendar-next").addEventListener("click", () => {
  calendarDate = new Date(calendarDate.getFullYear(), calendarDate.getMonth() + 1, 1);
  renderCalendar();
});
document.querySelector("#enable-reminders").addEventListener("click", () => {
  enableBrowserReminders().catch((error) => showToast(error.message, true));
});

function renderGlobalSearch() {
  const input = document.querySelector("#global-search-input");
  const results = document.querySelector("#global-search-results");
  const query = input.value.trim().toLowerCase();
  results.replaceChildren();
  if (!query) {
    results.hidden = true;
    return;
  }
  const normalizedQuery = query.replace(/[^a-z0-9]/g, "");
  const timetableMatches = workspace.units.filter((unit) => {
    const classes = workspace.classSessions.filter((session) => session.unitId === unit.id);
    const exams = workspace.examSessions.filter((exam) => exam.unitId === unit.id);
    const searchable = `${unit.code} ${unit.title} ${classes.map((session) =>
      `${formatWeekday(session.dayOfWeek)} ${session.startTime} ${session.endTime} ${session.venue} ${session.lecturer}`).join(" ")} ${exams.map((exam) =>
      `${exam.examDate} ${exam.examTime} ${exam.venue}`).join(" ")}`.toLowerCase();
    const normalized = `${unit.code} ${unit.title}`.toLowerCase().replace(/[^a-z0-9]/g, "");
    return (searchable.includes(query) || (normalizedQuery && normalized.includes(normalizedQuery)))
      && (classes.length || exams.length);
  }).map((unit) => {
    const classes = workspace.classSessions.filter((session) => session.unitId === unit.id)
      .map((session) => `Class: ${formatWeekday(session.dayOfWeek)} ${session.startTime || "TBC"}–${session.endTime || "TBC"}, ${session.venue || "Venue TBC"}${session.lecturer ? `, ${session.lecturer}` : ""}`);
    const exams = workspace.examSessions.filter((exam) => exam.unitId === unit.id)
      .map((exam) => `Exam ${exam.examDate || "Date TBC"} ${exam.examTime || "Time TBC"}, ${exam.venue || "Venue TBC"}`);
    return {
      type: "unit",
      item: unit,
      title: `${unit.code} · ${unit.title}`,
      subtitle: [...classes, ...exams].join(" | ")
    };
  });
  const matches = [
    ...timetableMatches,
    ...workspace.schedule
      .filter((item) => `${item.title} ${item.details} ${item.category} ${unitLabel(item.unitId)}`.toLowerCase().includes(query))
      .map((item) => ({ type: "schedule", item, title: item.title, subtitle: `${unitLabel(item.unitId) ? `${unitLabel(item.unitId)} · ` : ""}${item.category} · ${formatDate(item.date)}` })),
    ...workspace.files
      .filter((file) => `${file.name} ${file.folder} ${file.mime}`.toLowerCase().includes(query))
      .map((file) => ({ type: "file", item: file, title: file.name, subtitle: file.folder || file.mime.split("/")[0] }))
  ].slice(0, 8);
  if (!matches.length) results.append(element("p", "search-empty", "Not found in your timetable."));
  for (const match of matches) {
    const option = element("button", "search-result");
    option.type = "button";
    option.setAttribute("role", "option");
    const typeLabel = match.type === "unit" ? "Timetable" : match.type === "schedule" ? "Schedule" : "File";
    option.append(element("strong", "", match.title), element("small", "", `${typeLabel} · ${match.subtitle}`));
    option.addEventListener("click", () => {
      results.hidden = true;
      input.value = "";
      if (match.type === "unit") {
        showView("academics");
        document.querySelector("#class-sessions-list").scrollIntoView({ behavior: "smooth", block: "center" });
      } else if (match.type === "schedule") {
        showView("schedule");
        const row = document.querySelector(`[data-schedule-id="${CSS.escape(match.item.id)}"]`);
        row?.scrollIntoView({ behavior: "smooth", block: "center" });
      } else {
        showView("files");
        document.querySelector("#folder-filter").value = match.item.folder || "";
        document.querySelector("#file-search-input").value = match.item.name;
        renderFiles();
        const row = document.querySelector(`[data-file-id="${CSS.escape(match.item.id)}"]`);
        row?.scrollIntoView({ behavior: "smooth", block: "center" });
        if (isPreviewable(match.item.mime)) openFilePreview(match.item);
      }
    });
    results.append(option);
  }
  results.hidden = false;
}

document.querySelector("#global-search-input").addEventListener("input", renderGlobalSearch);
document.querySelector("#global-search-input").addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.currentTarget.value = "";
    document.querySelector("#global-search-results").hidden = true;
    event.currentTarget.blur();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && !event.ctrlKey && !event.metaKey
    && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)
    && !dashboardView.hidden) {
    event.preventDefault();
    document.querySelector("#global-search-input").focus();
  }
});

const privacyHeading = document.querySelector(".privacy-heading");
const exportSectionHeading = document.createElement("h2");
exportSectionHeading.textContent = "Your data";
const exportSectionDescription = document.createElement("p");
exportSectionDescription.textContent = "Download a copy of your profile, academic records, messages, activity, and uploaded files.";
const exportDataLink = document.createElement("a");
exportDataLink.className = "new-project-button";
exportDataLink.id = "download-my-data";
exportDataLink.href = "/api/account/export";
exportDataLink.textContent = "Download my data";
privacyHeading.before(exportSectionHeading, exportSectionDescription, exportDataLink);

document.querySelector("#profile-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector("button[type=submit]");
  const data = new FormData(form);
  submit.disabled = true;
  try {
    const result = await request("/api/profile", {
      method: "PATCH",
      body: JSON.stringify({
        profileName: data.get("profileName"),
        phone: data.get("phone"),
        school: data.get("school"),
        course: data.get("course")
      })
    });
    currentUser = result.user;
    const cleanName = (value) => value.replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim();
    const profileName = cleanName(currentUser.profileName || "");
    const fallbackName = cleanName(currentUser.email.split("@")[0]);
    document.querySelector("#profile-email").textContent = profileName || fallbackName || "Your account";
    document.querySelector("#profile-email-address").textContent = currentUser.email;
    document.querySelector("#profile-email-address").title = currentUser.email;
    const greeting = document.querySelector("#welcome-title").textContent.split(",")[0];
    document.querySelector("#welcome-title").textContent = `${greeting}, ${profileName || fallbackName.split(" ")[0] || "there"}`;
    document.querySelector("#logout-button").title = `Sign out of ${currentUser.email}`;
    setAvatarElement("#avatar", currentUser);
    setAvatarElement("#topbar-avatar", currentUser);
    showToast("Profile updated.");
  } catch (error) {
    showToast(error.message, true);
  } finally { submit.disabled = false; }
});

document.querySelector("#avatar-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const file = form.elements.avatar.files[0];
  if (!file) return showToast("Choose a profile photo first.", true);
  if (file.size > 2 * 1024 * 1024) return showToast("Profile photos must be 2 MB or smaller.", true);
  const submit = form.querySelector("button[type=submit]");
  submit.disabled = true;
  try {
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Could not read the selected photo."));
      reader.readAsDataURL(file);
    });
    const result = await request("/api/avatar", {
      method: "POST",
      body: JSON.stringify({ name: file.name, mime: file.type, data })
    });
    currentUser = result.user;
    setAvatarElement("#avatar", currentUser);
    setAvatarElement("#topbar-avatar", currentUser);
    const preview = document.querySelector("#profile-photo-preview");
    preview.src = `/api/avatar?v=${Date.now()}`;
    preview.hidden = false;
    form.reset();
    showToast("Profile photo updated.");
  } catch (error) { showToast(error.message, true); }
  finally { submit.disabled = false; }
});

document.querySelector("#remove-avatar").addEventListener("click", async () => {
  try {
    const result = await request("/api/avatar", { method: "DELETE", body: "{}" });
    currentUser = result.user;
    setAvatarElement("#avatar", currentUser);
    setAvatarElement("#topbar-avatar", currentUser);
    document.querySelector("#profile-photo-preview").hidden = true;
    showToast("Profile photo removed.");
  } catch (error) { showToast(error.message, true); }
});

document.querySelector("#change-password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await request("/api/password", {
      method: "PATCH",
      body: JSON.stringify({
        currentPassword: form.elements.currentPassword.value,
        newPassword: form.elements.newPassword.value
      })
    });
    form.reset();
    document.querySelector("#change-password-strength").textContent = "";
    showToast("Password changed. Other active sessions were signed out.");
  } catch (error) { showToast(error.message, true); }
});

document.querySelector("#delete-account-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!window.confirm("Permanently delete your account and all stored data? This cannot be undone.")) return;
  const form = event.currentTarget;
  try {
    await request("/api/account", {
      method: "DELETE",
      body: JSON.stringify({ password: form.elements.password.value })
    });
    showAuth();
    showNotice("Your account and stored workspace data were deleted.", true);
  } catch (error) { showToast(error.message, true); }
});

const accountActionParams = new URLSearchParams(location.search);
const verificationToken = accountActionParams.get("verify");
const resetToken = accountActionParams.get("reset");
request("/api/session").then(async (result) => {
  if (verificationToken) {
    showAuth();
    history.replaceState(null, "", location.pathname);
    try {
      await request("/api/account/verify-email", {
        method: "POST",
        body: JSON.stringify({ token: verificationToken })
      });
      showNotice("Email verified. You can now sign in.", true);
    } catch (error) { showNotice(error.message); }
  } else if (resetToken) {
    showAuth();
    const form = document.querySelector("#reset-password-form");
    document.querySelector("#recovery-title").textContent = "Choose a new password";
    document.querySelector("#forgot-password-form").hidden = true;
    form.hidden = false;
    form.elements.token.value = resetToken;
    document.querySelector("#recovery-notice").hidden = true;
    history.replaceState(null, "", location.pathname);
    recoveryDialog.showModal();
  } else if (result.user) {
    showDashboard(result.user);
  } else if (sessionStorage.getItem("obadianWelcomeSeen") !== "yes" && typeof welcomeDialog.showModal === "function") {
    sessionStorage.setItem("obadianWelcomeSeen", "yes");
    welcomeDialog.showModal();
  }
}).catch((error) => showNotice(`Could not connect to your workspace: ${error.message}`));
