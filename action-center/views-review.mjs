// CIVION Mail — Review.
//
// Two queues, both joins of things this module does not own: the record set, the identity
// snapshot, and the junk admission projection. No messenger call, no queue state, no
// second copy of anything.
//
// Junk watch follows the line decision r002 section 3 draws. A message that failed the
// admission gate received no verdict, so it is not listed here — it exists only as a
// counter, and the panel says why. Listing it would turn silence into a spam judgement,
// which is the one thing the gate refuses to produce.

import { deriveSenderReview, dispositionButtons } from "./views-identity.mjs";

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

// ---------------------------------------------------------------- rendering

let lastRecords = [];
let lastIdentity = null;
let lastJunk = null;

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
}
