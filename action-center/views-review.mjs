// CIVION Mail — Review.
//
// Five queues, joins of things this module does not own: the record set, the identity
// snapshot, the junk admission projection and the review state. No messenger call, no
// queue state, no second copy of anything.
//
// Three queues are derivable from the records alone and two are backed by runtime
// state the background owns. Uncertain reading is built from the very rows Dates builds,
// through deriveDates, so the two screens cannot end up describing the same reading
// differently — the identity is recordId + findingId in both.
//
// Junk watch follows the line decision r002 section 3 draws. A message that failed the
// admission gate received no verdict, so it is not listed here — it exists only as a
// counter, and the panel says why. Listing it would turn silence into a spam judgement,
// which is the one thing the gate refuses to produce.

import { deriveSenderReview, dispositionButtons } from "./views-identity.mjs";
import { deriveDates } from "./views-dates.mjs";

const $ = (id) => document.getElementById(id);

const PATH_LABEL = {
  registry_identity: "protected identity",
  proven_history: "proven personal history"
};

/**
 * What Junk watch shows: the admitted records, each with the path that admitted it and
 * the conditions actually evaluated. An admitted record whose reasoning predates the
 * projection is kept and marked, never given an invented ladder.
 */
export function deriveJunkWatch(records, junk) {
  const byId = new Map((Array.isArray(records) ? records : []).map((record) => [record.id, record]));
  const admitted = (junk?.admitted || []).map((entry) => ({
    ...entry,
    record: byId.get(entry.recordId) || null,
    pathLabel: PATH_LABEL[entry.admission?.path] || "unknown path"
  }));
  return {
    admitted,
    notAdmittedCount: junk?.notAdmitted?.messageCount ?? 0,
    withoutReasoning: junk?.admittedWithoutReasoning ?? 0,
    overridesSupported: junk?.userOverrides?.supported === true
  };
}

/**
 * The readings the machine could not settle. Built from the Dates rows so that a finding
 * marked unsettled there is the same finding here, addressed the same way.
 */
export function deriveUncertain(records, now, rejectedKeys = new Set()) {
  return deriveDates(records, now)
    .filter((row) => row.unsettled && !row.closed && !rejectedKeys.has(row.id))
    .map((row) => ({
      key: row.id,
      recordId: row.recordId,
      findingId: row.findingId,
      sender: row.sender,
      subject: row.subject,
      roleLabel: row.roleLabel,
      iso: row.iso,
      evidence: row.evidence,
      ambiguous: row.ambiguous
    }));
}

/** Messages the analysis could not read at all, or whose original has gone. */
export function deriveUnreadable(records) {
  return (Array.isArray(records) ? records : [])
    .filter((record) => !CLOSED.has(record.status))
    .filter((record) => record.analysisError || record.messageAvailable === false)
    .map((record) => ({
      key: record.id,
      recordId: record.id,
      sender: record.sender || "Unknown sender",
      subject: record.subject || "(no subject)",
      reason: record.analysisError
        ? "the analysis failed on this message"
        : "the original message is no longer available"
    }));
}

/** What you told the analysis it got wrong. A record, not a queue of work. */
export function deriveMarkedIncorrect(records) {
  return (Array.isArray(records) ? records : [])
    .filter((record) => record.markedIncorrect === true)
    .map((record) => ({
      key: record.id,
      recordId: record.id,
      sender: record.sender || "Unknown sender",
      subject: record.subject || "(no subject)",
      status: record.status || "New"
    }));
}

/** Readings you rejected. The rejection lives in the background; this only reads it. */
export function deriveRejected(records, review) {
  const byId = new Map((Array.isArray(records) ? records : []).map((record) => [record.id, record]));
  return (review?.rejections || []).map((entry) => {
    const record = byId.get(entry.recordId) || null;
    return {
      key: entry.key,
      recordId: entry.recordId,
      findingId: entry.findingId,
      rejectedAt: entry.rejectedAt,
      sender: record?.sender || "record no longer held",
      subject: record?.subject || "",
      present: Boolean(record)
    };
  });
}

/** Analyser identities this mailbox has records from that you have not acknowledged. */
export function deriveNewRules(review) {
  return (review?.rules || []).filter((rule) => !rule.acknowledged);
}

const CLOSED = new Set(["Completed", "Dismissed", "Archived"]);

// ---------------------------------------------------------------- rendering

let lastRecords = [];
let lastIdentity = null;
let lastJunk = null;
let lastReview = null;

function reviewCommand(detail) {
  document.dispatchEvent(new CustomEvent("civion:review-command", { detail }));
}

function actionButton(label, detail, primary = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = primary ? "btn small primary" : "btn small";
  button.textContent = label;
  button.addEventListener("click", () => reviewCommand(detail));
  return button;
}

/** One row: what it is, why it is here, and what you can do about it. */
function queueRow(title, help, controls) {
  const row = document.createElement("div");
  row.className = "setrow";
  const left = document.createElement("div");
  const label = document.createElement("div");
  label.className = "lbl";
  label.textContent = title;
  const note = document.createElement("p");
  note.className = "help";
  note.textContent = help;
  left.append(label, note);
  const ctl = document.createElement("div");
  ctl.className = "ctl";
  for (const control of controls) ctl.append(control);
  row.append(left, ctl);
  return row;
}

function fillQueue(listId, countId, emptyId, rows) {
  const list = $(listId);
  if (!list) return;
  list.replaceChildren();
  $(countId).textContent = String(rows.length);
  $(emptyId).hidden = rows.length > 0;
  for (const row of rows) list.append(row);
}

function renderRecordQueues() {
  const rejectedKeys = new Set((lastReview?.rejections || []).map((entry) => entry.key));

  fillQueue("reviewUncertainList", "reviewUncertainCount", "reviewUncertainEmpty",
    deriveUncertain(lastRecords, Date.now(), rejectedKeys).map((item) => queueRow(
      `${item.sender} — ${item.roleLabel} on ${item.iso}`,
      `${item.evidence || "no quoted evidence was recorded"}${item.ambiguous ? " The written date is ambiguous and was not resolved by assumption." : ""} Subject: ${item.subject}`,
      [actionButton("Reject this reading", { type: "reject-finding", recordId: item.recordId, findingId: item.findingId })]
    )));

  fillQueue("reviewUnreadableList", "reviewUnreadableCount", "reviewUnreadableEmpty",
    deriveUnreadable(lastRecords).map((item) => queueRow(
      item.sender, `${item.reason}. Subject: ${item.subject}`, []
    )));

  fillQueue("reviewIncorrectList", "reviewIncorrectCount", "reviewIncorrectEmpty",
    deriveMarkedIncorrect(lastRecords).map((item) => queueRow(
      item.sender, `You marked this analysis incorrect. Status: ${item.status}. Subject: ${item.subject}`, []
    )));
}

function renderStateQueues() {
  fillQueue("reviewRejectedList", "reviewRejectedCount", "reviewRejectedEmpty",
    deriveRejected(lastRecords, lastReview).map((item) => queueRow(
      item.sender,
      `${item.findingId || "reading"} rejected${item.rejectedAt ? ` on ${new Date(item.rejectedAt).toLocaleDateString()}` : ""}. ${item.present ? `Subject: ${item.subject}` : "The record is no longer held; the rejection is kept so it is not silently undone."}`,
      [actionButton("Restore", { type: "restore-finding", recordId: item.recordId, findingId: item.findingId })]
    )));

  fillQueue("reviewRulesList", "reviewRulesCount", "reviewRulesEmpty",
    deriveNewRules(lastReview).map((rule) => queueRow(
      rule.label || rule.id,
      `${rule.recordCount} record${rule.recordCount === 1 ? "" : "s"} in this mailbox were analysed by this rule set, first on ${rule.firstSeenAt ? new Date(rule.firstSeenAt).toLocaleDateString() : "an unknown date"}. Acknowledging it does not change any record.`,
      [actionButton("Acknowledge", { type: "acknowledge-rule", ruleId: rule.id }, true)]
    )));
}

function renderSenderQueue() {
  const list = $("reviewSenderList");
  if (!list) return;
  const items = deriveSenderReview(lastRecords, lastIdentity);
  list.replaceChildren();
  $("reviewSenderCount").textContent = String(items.length);
  $("reviewSenderEmpty").hidden = items.length > 0;

  for (const item of items) {
    const row = document.createElement("div");
    row.className = "setrow";

    const left = document.createElement("div");
    const label = document.createElement("div");
    label.className = "lbl";
    label.textContent = item.record.sender || item.domain;
    const help = document.createElement("p");
    help.className = "help";
    help.textContent = `${item.domain} — ${item.reason}. Subject: ${item.record.subject || "(no subject)"}`;
    left.append(label, help);

    const controls = document.createElement("div");
    controls.className = "ctl";
    controls.append(dispositionButtons({ domain: item.domain, provenance: null }));

    row.append(left, controls);
    list.append(row);
  }
}

function conditionLadder(conditions) {
  const list = document.createElement("ul");
  list.className = "ladder";
  for (const condition of conditions || []) {
    const item = document.createElement("li");
    item.className = condition.result === "pass" ? "pass" : condition.result === "fail" ? "fail" : "unk";
    const mark = document.createElement("span");
    mark.className = "mark";
    mark.textContent = condition.result === "pass" ? "✓" : condition.result === "fail" ? "✕" : "?";
    item.append(mark, document.createTextNode(condition.label));
    list.append(item);
  }
  return list;
}

function renderJunkWatch() {
  const body = $("reviewJunkList");
  if (!body) return;
  const view = deriveJunkWatch(lastRecords, lastJunk);
  body.replaceChildren();
  $("reviewJunkCount").textContent = String(view.admitted.length);
  $("reviewJunkEmpty").hidden = view.admitted.length > 0;

  for (const entry of view.admitted) {
    const pane = document.createElement("section");
    pane.className = "pane";

    const header = document.createElement("header");
    header.className = "pane-h";
    const title = document.createElement("h2");
    title.textContent = entry.sender || "Unknown sender";
    const sub = document.createElement("span");
    sub.className = "sub";
    sub.textContent = entry.subject || "(no subject)";
    const right = document.createElement("span");
    right.className = "right";
    const chip = document.createElement("span");
    chip.className = "chip confirmed";
    chip.textContent = `admitted — ${entry.pathLabel}`;
    right.append(chip);
    header.append(title, sub, right);

    const ladder = document.createElement("div");
    ladder.style.padding = "10px 14px";
    ladder.append(conditionLadder(entry.admission?.conditions));

    const provenance = document.createElement("p");
    provenance.className = "pane-note";
    const evidence = entry.admission?.evidenceProvenance || {};
    provenance.textContent = evidence.qualifyingRecords === undefined
      ? `Evidence: ${evidence.source || "not recorded"}.`
      : `Evidence: ${evidence.source} — ${evidence.qualifyingRecords} qualifying records, ${evidence.authenticatedRecords} of them authenticated.`;

    const upstream = document.createElement("p");
    upstream.className = "pane-note";
    const marker = entry.admission?.upstreamMarker;
    upstream.textContent = marker
      ? `Filed as junk by ${marker.by}. ${marker.note}`
      : "No upstream marker was recorded.";

    pane.append(header, ladder, provenance, upstream);
    body.append(pane);
  }

  const notes = [];
  notes.push(view.notAdmittedCount === 1
    ? "1 message was not admitted. Not analysed is not a spam verdict: it was left alone and no judgement about it is stored, which is why there is no list of them here."
    : `${view.notAdmittedCount} messages were not admitted. Not analysed is not a spam verdict: they were left alone and no judgement about them is stored, which is why there is no list of them here.`);
  if (view.withoutReasoning) {
    notes.push(`${view.withoutReasoning} admitted records predate this projection and carry no recorded reasoning. They are not shown above rather than shown with an invented one.`);
  }
  if (!view.overridesSupported) {
    notes.push("There is no per-message override. A domain decision in Trust is the only lever, and it applies to every message from that domain.");
  }
  $("reviewJunkNotes").textContent = notes.join(" ");
}

function renderAll() {
  renderSenderQueue();
  renderRecordQueues();
  renderStateQueues();
  renderJunkWatch();
}

const hasDocument = typeof document !== "undefined";

if (hasDocument) {
  document.addEventListener("civion:state", (event) => {
    lastRecords = Array.isArray(event.detail?.records) ? event.detail.records : [];
    renderAll();
  });
  document.addEventListener("civion:identity-state", (event) => {
    lastIdentity = event.detail || null;
    renderAll();
  });
  document.addEventListener("civion:junk-admission-state", (event) => {
    lastJunk = event.detail || null;
    renderJunkWatch();
  });
  document.addEventListener("civion:review-state", (event) => {
    lastReview = event.detail || null;
    renderRecordQueues();
    renderStateQueues();
  });
}
