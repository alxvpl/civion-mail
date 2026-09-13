// CIVION Mail — the Today screen.
//
// Today is derived, not stored. It reads the record set app.js publishes after every
// render and shows nothing that is not in it. Three rules from the accepted design hold
// here and are what most of this file is about:
//
//   - one event is counted in one column only, so a record that needs a decision is not
//     also counted under "other attention";
//   - a summary figure is derived from the same data as the list beneath it, never
//     written separately;
//   - a queue is work and a record is not, so the two are never added together.
//
// This module owns no state and mutates nothing it is given.

const $ = (id) => document.getElementById(id);

const DAY = 86400000;

function startOfToday() {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now.getTime();
}

function deadlineDate(record) {
  const iso = record?.deadline?.date;
  if (!iso) return null;
  const time = Date.parse(`${String(iso).slice(0, 10)}T00:00:00`);
  return Number.isFinite(time) ? time : null;
}

function isClosed(record) {
  return ["Completed", "Dismissed", "Archived"].includes(record?.status);
}

/** Why this record is waiting on a person, or null when it is not. */
export function decisionReason(record) {
  if (isClosed(record)) return null;
  if (Array.isArray(record.needsVerification) && record.needsVerification.length) {
    return "verification required";
  }
  if (record.analysisError) return "analysis failed";
  if (record.risk?.hardBlock === true) return "sender is blocked";
  return null;
}

/**
 * Why this record wants attention without being a decision. Records that already appear
 * as a decision are excluded by the caller, so nothing is counted twice.
 */
export function attentionReason(record, today) {
  if (isClosed(record)) return null;
  const due = deadlineDate(record);
  if (record.deadline?.overdue === true || (due !== null && due < today)) return "overdue";
  if (record.markedIncorrect === true) return "you marked the analysis incorrect";
  if (record.messageAvailable === false) return "the original message is gone";
  return null;
}

function groupCount(entries) {
  const counts = new Map();
  for (const reason of entries) counts.set(reason, (counts.get(reason) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function fillQueue(list, grouped, route) {
  list.replaceChildren();
  if (!grouped.length) {
    const item = document.createElement("li");
    item.textContent = "Nothing here.";
    list.append(item);
    return;
  }
  for (const [reason, count] of grouped) {
    const item = document.createElement("li");
    if (route) {
      item.dataset.route = route;
      item.tabIndex = 0;
    }
    const number = document.createElement("b");
    number.textContent = String(count);
    item.append(number, document.createTextNode(reason));
    list.append(item);
  }
}

function miniFigure(label, value, note) {
  const wrapper = document.createElement("div");
  const caption = document.createElement("span");
  caption.textContent = label;
  const figure = document.createElement("b");
  figure.textContent = value;
  const detail = document.createElement("em");
  detail.textContent = note;
  wrapper.append(caption, figure, detail);
  return wrapper;
}

function formatDay(time) {
  return new Date(time).toLocaleDateString(undefined, { day: "numeric", month: "long" });
}

function renderDue(records, today) {
  const open = records.filter((record) => !isClosed(record));
  const dated = open
    .map((record) => ({ record, due: deadlineDate(record) }))
    .filter((entry) => entry.due !== null);
  const overdue = dated.filter((entry) => entry.due < today).sort((a, b) => a.due - b.due);
  const upcoming = dated.filter((entry) => entry.due >= today).sort((a, b) => a.due - b.due);

  const box = $("todayDue");
  box.replaceChildren();

  if (upcoming.length) {
    const next = upcoming[0];
    const days = Math.round((next.due - today) / DAY);
    box.append(miniFigure(
      "Nearest deadline",
      formatDay(next.due),
      `${next.record.sender || "unknown sender"} · ${days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"}`}`
    ));
  } else {
    box.append(miniFigure("Nearest deadline", "—", "no dated obligation is open"));
  }

  if (overdue.length) {
    const oldest = Math.round((today - overdue[0].due) / DAY);
    box.append(miniFigure(
      "Overdue",
      String(overdue.length),
      `oldest ${oldest} day${oldest === 1 ? "" : "s"} late`
    ));
  } else {
    box.append(miniFigure("Overdue", "0", "nothing has passed its date"));
  }

  const undated = open.length - dated.length;
  box.append(miniFigure("Open without a date", String(undated), `${open.length} open in total`));
}

function renderAccounts(records, accountLabels) {
  const strip = $("todayAccounts");
  strip.replaceChildren();
  const open = records.filter((record) => !isClosed(record));
  const perAccount = new Map();
  for (const record of open) {
    const key = record.accountId || "unknown";
    perAccount.set(key, (perAccount.get(key) || 0) + 1);
  }
  const rows = [...perAccount.entries()]
    .map(([id, count]) => [accountLabels?.[id] || id, count])
    .sort((a, b) => b[1] - a[1]);

  for (const [label, count] of rows) {
    const row = document.createElement("div");
    row.className = "acct";
    const name = document.createElement("span");
    name.textContent = label;
    const value = document.createElement("b");
    value.textContent = `${count} open`;
    row.append(name, value);
    strip.append(row);
  }

  const total = document.createElement("div");
  total.className = "acct total";
  const totalName = document.createElement("span");
  totalName.textContent = rows.length === 1 ? "One account" : `${rows.length} accounts`;
  const totalValue = document.createElement("b");
  totalValue.textContent = `${open.length} open`;
  total.append(totalName, totalValue);
  strip.append(total);
}

function renderLatest(records) {
  const body = $("todayRows");
  body.replaceChildren();
  const latest = [...records]
    .sort((a, b) => Date.parse(b.receivedAt || 0) - Date.parse(a.receivedAt || 0))
    .slice(0, 6);
  $("todayEmpty").hidden = latest.length > 0;

  for (const record of latest) {
    const row = document.createElement("tr");
    const when = document.createElement("td");
    when.className = "num";
    when.textContent = record.receivedAt
      ? new Date(record.receivedAt).toLocaleDateString(undefined, { day: "2-digit", month: "2-digit" })
      : "—";
    const sender = document.createElement("td");
    sender.className = "wrap-name";
    sender.textContent = record.sender || "Unknown sender";
    const finding = document.createElement("td");
    finding.textContent = record.requiredAction || record.summary || "—";
    const priority = document.createElement("td");
    const chip = document.createElement("span");
    const tone = { Critical: "alert", High: "alert", Medium: "suggested" }[record.priority] || "neutral";
    chip.className = `chip ${tone}`;
    chip.textContent = record.priority || "None";
    priority.append(chip);
    row.append(when, sender, finding, priority);
    body.append(row);
  }
}

/**
 * The one place the two columns are computed. A record that needs a decision is removed
 * from consideration for the attention column, so no event is counted twice, and both
 * figures are the lengths of the arrays the two lists render.
 */
export function summarise(records, today = startOfToday()) {
  const decisions = [];
  const attention = [];
  for (const record of Array.isArray(records) ? records : []) {
    const decision = decisionReason(record);
    if (decision) { decisions.push(decision); continue; }
    const other = attentionReason(record, today);
    if (other) attention.push(other);
  }
  return { decisions, attention };
}

function renderToday(detail) {
  const records = Array.isArray(detail?.records) ? detail.records : [];
  const today = startOfToday();
  const { decisions, attention } = summarise(records, today);

  // Both figures are counted from the same arrays the two lists below them render.
  $("todayDecisionBig").textContent = String(decisions.length);
  $("todayDecisionCount").textContent = String(decisions.length);
  $("todayOtherBig").textContent = String(attention.length);
  $("todayOtherCount").textContent = String(attention.length);
  $("todayDecisionNote").textContent = decisions.length
    ? "each one needs a person to confirm or correct it"
    : "nothing is waiting on you";

  const railBadge = $("railDecisionCount");
  railBadge.textContent = String(decisions.length);
  railBadge.hidden = decisions.length === 0;

  fillQueue($("todayDecisionList"), groupCount(decisions), "records");
  fillQueue($("todayOtherList"), groupCount(attention), "records");

  renderDue(records, today);
  renderAccounts(records, detail?.accountLabels);
  renderLatest(records);

  const analysed = records
    .map((record) => Date.parse(record.analyzedAt || record.receivedAt || 0))
    .filter(Number.isFinite);
  const newest = analysed.length ? Math.max(...analysed) : null;
  $("todayCoverage").textContent = newest
    ? `${records.length} records held · newest analysis ${new Date(newest).toLocaleString()}`
    : "No analysis has been recorded yet.";
}

// The derivations above are importable on their own so they can be tested without a DOM.
const hasDocument = typeof document !== "undefined";

if (hasDocument) document.addEventListener("civion:state", (event) => renderToday(event.detail));

// A grouped line is a shortcut into the Action Center, not a filter of its own.
for (const id of hasDocument ? ["todayDecisionList", "todayOtherList"] : []) {
  const list = $(id);
  if (!list) continue;
  const open = (target) => {
    const item = target.closest("li[data-route]");
    if (item) document.dispatchEvent(new CustomEvent("civion:go", { detail: { screen: item.dataset.route } }));
  };
  list.addEventListener("click", (event) => open(event.target));
  list.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(event.target); }
  });
}
