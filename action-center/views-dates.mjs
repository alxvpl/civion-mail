// CIVION Mail — Dates.
//
// A pure projection over the records already published. There is no date store, no second
// owner and no navigation-triggered loading: `civion:state` in, rows out.
//
// The rules this file exists to hold, all of them from the accepted decisions:
//
//   - one record can produce more than one date, so a row is a finding, not a record;
//   - the structured finding is the source, never the display text;
//   - a deadline is not every recognised date. Roles stay distinct: deadline, cancellation
//     window, appointment, delivery, renewal, information;
//   - "obliging" means a proven obligation and nothing else;
//   - an optional cancellation window never becomes an obligation;
//   - overdue is derived from a proven operational date and stays visible;
//   - a date still awaiting verification is not promoted to an operational date on an
//     assumption — it stays in Review and is marked here;
//   - a failure or an unknown is never rendered as "No Action".
//
// `now` is an argument, never read inside, so every derivation is deterministic.

const $ = (id) => document.getElementById(id);

const DAY = 86400000;

const ROLE_LABEL = {
  deadline: "deadline",
  payment: "payment",
  cancellation_window: "cancellation window",
  appointment: "appointment",
  delivery: "delivery",
  renewal: "renewal",
  information: "information"
};

// Only these two roles can carry an obligation at all, and even then only when the finding
// itself says the action is required. A cancellation window is an opportunity: missing it
// costs you the option, not compliance, so it is never counted as obliging.
const CAN_OBLIGE = new Set(["deadline", "payment"]);

const CLOSED = new Set(["Completed", "Dismissed", "Archived"]);

function parseDay(value) {
  if (!value) return null;
  const time = Date.parse(`${String(value).slice(0, 10)}T00:00:00`);
  return Number.isFinite(time) ? time : null;
}

function recordFindings(record) {
  const findings = Array.isArray(record?.typedFindings) ? record.typedFindings : [];
  if (findings.length) return findings;
  // A record analysed before typed findings existed still has its resolved deadline. It is
  // shown as the one finding it is, with the role it actually had, rather than dropped.
  if (record?.deadline?.date) {
    return [{
      id: `legacy-deadline:${record.deadline.date}`,
      type: record.deadline.role === "cancellation_window" ? "cancellation_window" : "deadline",
      temporalRole: record.deadline.role || "due_by",
      date: record.deadline.date,
      dateRaw: record.deadline.raw || "",
      actionRequired: record.deadline.role !== "cancellation_window",
      needsVerification: false,
      evidence: record.deadline.raw || "",
      legacy: true
    }];
  }
  return [];
}

/**
 * One row per dated finding. The row id is the record and the finding together, so a row
 * survives re-analysis and never depends on a position in an array.
 */
export function deriveDates(records, now) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const startOfDay = today.getTime();
  const rows = [];

  for (const record of Array.isArray(records) ? records : []) {
    const closed = CLOSED.has(record?.status);
    for (const finding of recordFindings(record)) {
      const date = parseDay(finding?.date);
      if (date === null) continue; // an undated finding is not a date

      const role = ROLE_LABEL[finding.type] ? finding.type : "information";
      // A record-level verification flag names what is unsettled — "deadline", say — so it
      // marks that finding and not every date in the same message. An information date in a
      // record with an unsettled deadline is still information.
      const recordNeeds = Array.isArray(record.needsVerification) ? record.needsVerification.map(String) : [];
      const unsettled = finding.needsVerification === true
        || recordNeeds.includes(finding.type)
        || recordNeeds.includes(finding.temporalRole);

      // An obligation has to be proven: the right role, the finding itself saying the
      // action is required, and nothing still awaiting a person's confirmation.
      const obliging = CAN_OBLIGE.has(role) && finding.actionRequired === true && !unsettled;

      // Overdue is a property of a proven operational date. An optional window that has
      // passed is expired, which is a different thing and never counted as overdue.
      const past = date < startOfDay;
      const overdue = obliging && past && !closed;

      rows.push({
        id: `${record.id}::${finding.id || `${finding.type}:${finding.date}`}`,
        recordId: record.id,
        findingId: finding.id || null,
        date,
        iso: String(finding.date).slice(0, 10),
        daysFromToday: Math.round((date - startOfDay) / DAY),
        role,
        roleLabel: ROLE_LABEL[role],
        temporalRole: finding.temporalRole || null,
        obliging,
        optional: role === "cancellation_window",
        unsettled,
        overdue,
        expired: role === "cancellation_window" && past,
        closed,
        // Kept verbatim from the finding, never rebuilt from display text.
        evidence: finding.evidence || finding.dateRaw || "",
        marker: finding.evidenceMarker || "",
        ambiguous: Array.isArray(finding.dateAlternatives) && finding.dateAlternatives.length > 0,
        legacy: finding.legacy === true,
        sender: record.sender || "Unknown sender",
        subject: record.subject || "(no subject)",
        status: record.status || "New",
        analysisError: Boolean(record.analysisError)
      });
    }
  }

  return rows.sort((a, b) => a.date - b.date || a.id.localeCompare(b.id));
}

/**
 * The four tabs are four filters over the one array above, so a counter and its list can
 * never disagree.
 */
export const DATE_FILTERS = Object.freeze({
  all: () => true,
  obliging: (row) => row.obliging && !row.closed,
  optional: (row) => row.optional && !row.closed,
  overdue: (row) => row.overdue
});

export function countDates(rows) {
  return Object.fromEntries(
    Object.entries(DATE_FILTERS).map(([key, filter]) => [key, rows.filter(filter).length])
  );
}

// ---------------------------------------------------------------- rendering

let lastRows = [];
let activeView = "all";

function monthLabel(time) {
  return new Date(time).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function stateChip(row) {
  const chip = document.createElement("span");
  if (row.analysisError) {
    chip.className = "chip alert";
    chip.textContent = "analysis failed";
  } else if (row.overdue) {
    chip.className = "chip alert";
    chip.textContent = `overdue by ${Math.abs(row.daysFromToday)} d`;
  } else if (row.unsettled) {
    chip.className = "chip suggested";
    chip.textContent = "awaiting your confirmation";
  } else if (row.closed) {
    chip.className = "chip neutral";
    chip.textContent = row.status.toLowerCase();
  } else if (row.expired) {
    chip.className = "chip neutral";
    chip.textContent = "window has passed";
  } else if (row.obliging) {
    chip.className = "chip confirmed";
    chip.textContent = row.daysFromToday === 0 ? "due today" : `in ${row.daysFromToday} d`;
  } else {
    chip.className = "chip neutral";
    chip.textContent = row.optional ? "optional" : "for information";
  }
  return chip;
}

function renderDates() {
  const body = $("datesRows");
  if (!body) return;
  const counts = countDates(lastRows);
  for (const [key, count] of Object.entries(counts)) {
    const badge = $(`datesCount-${key}`);
    if (badge) badge.textContent = String(count);
  }

  const rows = lastRows.filter(DATE_FILTERS[activeView] || DATE_FILTERS.all);
  body.replaceChildren();
  $("datesEmpty").hidden = rows.length > 0;

  let month = null;
  for (const row of rows) {
    const rowMonth = monthLabel(row.date);
    if (rowMonth !== month) {
      month = rowMonth;
      const rule = document.createElement("tr");
      rule.className = "month-rule";
      const cell = document.createElement("td");
      cell.colSpan = 5;
      cell.textContent = rowMonth;
      rule.append(cell);
      body.append(rule);
    }

    const tr = document.createElement("tr");
    if (row.closed) tr.className = "low";
    tr.dataset.rowId = row.id;

    const when = document.createElement("td");
    when.className = "num";
    when.textContent = new Date(row.date).toLocaleDateString(undefined, { day: "2-digit", month: "2-digit" });

    const role = document.createElement("td");
    const roleChip = document.createElement("span");
    roleChip.className = `chip ${row.obliging ? "confirmed" : row.optional ? "suggested" : "neutral"}`;
    roleChip.textContent = row.roleLabel;
    role.append(roleChip);

    const who = document.createElement("td");
    const name = document.createElement("span");
    name.className = "wrap-name";
    name.textContent = row.sender;
    const sub = document.createElement("small");
    sub.className = "sub-line";
    sub.textContent = row.subject;
    who.append(name, sub);

    const evidence = document.createElement("td");
    const quote = document.createElement("span");
    quote.textContent = row.evidence || "no quoted evidence was recorded";
    evidence.append(quote);
    if (row.ambiguous) {
      const note = document.createElement("small");
      note.className = "sub-line";
      note.textContent = "the written date is ambiguous; it was not resolved by assumption";
      evidence.append(note);
    }
    if (row.legacy) {
      const note = document.createElement("small");
      note.className = "sub-line";
      note.textContent = "analysed before typed findings; only the resolved date is known";
      evidence.append(note);
    }

    const state = document.createElement("td");
    state.append(stateChip(row));

    tr.append(when, role, who, evidence, state);
    body.append(tr);
  }

  const unsettled = lastRows.filter((row) => row.unsettled && !row.closed).length;
  $("datesNote").textContent = unsettled
    ? `${unsettled} date${unsettled === 1 ? " still needs" : "s still need"} your confirmation and ${unsettled === 1 ? "is" : "are"} not treated as operational. ${unsettled === 1 ? "It stays" : "They stay"} in Review until you settle ${unsettled === 1 ? "it" : "them"}.`
    : "Every date shown here comes from a structured finding, not from the displayed text. A cancellation window is an opportunity, never an obligation.";
}

const hasDocument = typeof document !== "undefined";

if (hasDocument) {
  document.addEventListener("civion:state", (event) => {
    lastRows = deriveDates(event.detail?.records, Date.now());
    renderDates();
  });
  const strip = document.querySelector('.screen[data-screen="dates"] .tabs');
  if (strip) {
    strip.addEventListener("click", (event) => {
      const tab = event.target.closest("[data-view]");
      if (!tab) return;
      activeView = tab.dataset.view;
      renderDates();
    });
  }
}
