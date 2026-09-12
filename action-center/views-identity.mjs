// CIVION Mail — Trust, and the derivations the Review sender queue is built from.
//
// Trust is derived. There is no sender database in the Action Center: a row is
// what the record set says about a domain, joined with the identity snapshot the
// background publishes. Nothing here calls messenger, and nothing here writes. A change
// is asked for with a civion:identity-command event; the background decides, and the next
// snapshot is what these screens show.
//
// Provenance travels with every disposition, because "you allowed this" and "the corpus
// has seen this domain" are different facts and only the first is a decision.

const $ = (id) => document.getElementById(id);

const DISPOSITION_LABEL = {
  "allow:user": "allowed by you",
  "block:user": "blocked by you",
  "allow:observed": "observed service domain",
  "block:built-in": "known phishing-only domain",
  none: "no disposition"
};

/** The domain a record's sender belongs to, normalised the same way the background does. */
export function senderDomain(record) {
  const address = String(record?.senderAddress || record?.sender || "");
  const at = address.lastIndexOf("@");
  const raw = at >= 0 ? address.slice(at + 1) : "";
  return raw.trim().toLowerCase().replace(/^[.<]+|[.>]+$/gu, "");
}

function indexIdentity(identity) {
  const allow = new Map();
  const block = new Map();
  const protectedBy = new Map();
  for (const entry of identity?.allowlistedDomains || []) allow.set(entry.domain, entry.provenance);
  for (const entry of identity?.blockedDomains || []) block.set(entry.domain, entry.provenance);
  for (const item of identity?.protectedIdentities || []) {
    for (const domain of item.domains || []) protectedBy.set(domain, item);
  }
  return { allow, block, protectedBy };
}

/**
 * One row per sender domain the records have actually seen. A domain that is only on a
 * list and has sent nothing is not a row: Trust describes the mail that arrived, and the
 * lists themselves are shown as counts beside it.
 */
export function deriveTrust(records, identity) {
  const { allow, block, protectedBy } = indexIdentity(identity);
  const rows = new Map();

  for (const record of Array.isArray(records) ? records : []) {
    const domain = senderDomain(record);
    if (!domain) continue;
    let row = rows.get(domain);
    if (!row) {
      row = {
        domain,
        records: 0,
        openRecords: 0,
        lastSeen: null,
        verified: 0,
        failed: 0,
        unverified: 0,
        senders: new Set()
      };
      rows.set(domain, row);
    }
    row.records += 1;
    if (!["Completed", "Dismissed", "Archived"].includes(record.status)) row.openRecords += 1;
    const received = Date.parse(record.receivedAt || 0);
    if (Number.isFinite(received) && (row.lastSeen === null || received > row.lastSeen)) row.lastSeen = received;
    const verdict = record?.senderTrust?.authentication?.verdict;
    if (verdict === "pass" || verdict === "verified") row.verified += 1;
    else if (verdict === "failed" || verdict === "conflict") row.failed += 1;
    else row.unverified += 1;
    if (record.sender) row.senders.add(record.sender);
  }

  return [...rows.values()]
    .map((row) => {
      const blockedBy = block.get(row.domain);
      const allowedBy = allow.get(row.domain);
      // A block outranks an allow: the two cannot both be a user decision, because the
      // background removes one when the other is set.
      const disposition = blockedBy ? "block" : allowedBy ? "allow" : "none";
      const provenance = blockedBy || allowedBy || null;
      return {
        ...row,
        senders: [...row.senders],
        disposition,
        provenance,
        dispositionLabel: DISPOSITION_LABEL[provenance ? `${disposition}:${provenance}` : "none"],
        protectedIdentity: protectedBy.get(row.domain) || null
      };
    })
    .sort((a, b) => b.openRecords - a.openRecords || b.records - a.records || a.domain.localeCompare(b.domain));
}

/**
 * The sender queue inside Review: the records whose sender disposition is a decision the
 * person has not made. Derived from the same two inputs, never a second queue with its
 * own state.
 */
export function deriveSenderReview(records, identity) {
  const { allow, block } = indexIdentity(identity);
  const open = (Array.isArray(records) ? records : [])
    .filter((record) => !["Completed", "Dismissed", "Archived"].includes(record.status));

  const items = [];
  for (const record of open) {
    const domain = senderDomain(record);
    if (!domain) continue;
    if (block.get(domain) === "user" || allow.get(domain) === "user") continue;
    const verdict = record?.senderTrust?.authentication?.verdict;
    if (block.has(domain)) {
      items.push({ record, domain, reason: "on the built-in phishing-only list, not yet decided by you" });
    } else if (verdict === "failed" || verdict === "conflict") {
      items.push({ record, domain, reason: "authentication failed and the domain has no disposition" });
    } else if (record.admittedFromJunk === true) {
      items.push({ record, domain, reason: "admitted from Junk and the domain has no disposition" });
    }
  }
  return items;
}

// ---------------------------------------------------------------- rendering

let lastRecords = [];
let lastIdentity = null;

function command(domain, disposition) {
  document.dispatchEvent(new CustomEvent("civion:identity-command", { detail: { domain, disposition } }));
}

export function dispositionButtons(row) {
  const wrap = document.createElement("div");
  wrap.className = "actions";
  wrap.style.margin = "0";
  const make = (label, disposition, primary) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = primary ? "btn small primary" : "btn small";
    button.textContent = label;
    button.addEventListener("click", () => command(row.domain, disposition));
    return button;
  };
  if (row.provenance === "user") {
    wrap.append(make("Clear", "clear"));
  } else {
    wrap.append(make("Allow", "allow"), make("Block", "block"));
  }
  return wrap;
}

function renderTrust() {
  const body = $("trustRows");
  if (!body) return;
  const rows = deriveTrust(lastRecords, lastIdentity);
  body.replaceChildren();
  $("trustEmpty").hidden = rows.length > 0;

  for (const row of rows) {
    const tr = document.createElement("tr");

    const domain = document.createElement("td");
    const name = document.createElement("span");
    name.className = "wrap-name mono";
    name.textContent = row.domain;
    domain.append(name);
    if (row.protectedIdentity) {
      const note = document.createElement("small");
      note.className = "sub-line";
      note.textContent = `protected identity — ${row.protectedIdentity.label}`;
      domain.append(note);
    } else if (row.senders.length) {
      const note = document.createElement("small");
      note.className = "sub-line";
      note.textContent = row.senders.slice(0, 2).join(", ");
      domain.append(note);
    }

    const seen = document.createElement("td");
    seen.className = "num";
    seen.textContent = String(row.records);
    const openCount = document.createElement("small");
    openCount.className = "sub-line";
    openCount.textContent = `${row.openRecords} open`;
    seen.append(openCount);

    const auth = document.createElement("td");
    const tone = row.failed ? "alert" : row.verified ? "confirmed" : "neutral";
    const chip = document.createElement("span");
    chip.className = `chip ${tone}`;
    chip.textContent = row.failed
      ? `${row.failed} failed`
      : row.verified
        ? `${row.verified} verified`
        : "not verified";
    auth.append(chip);

    const state = document.createElement("td");
    const stateChip = document.createElement("span");
    const stateTone = row.disposition === "block"
      ? "alert"
      : row.disposition === "allow" && row.provenance === "user" ? "confirmed" : "neutral";
    stateChip.className = `chip ${stateTone}`;
    stateChip.textContent = row.dispositionLabel;
    state.append(stateChip);

    const last = document.createElement("td");
    last.className = "num";
    last.textContent = row.lastSeen ? new Date(row.lastSeen).toLocaleDateString() : "—";

    const actions = document.createElement("td");
    actions.append(dispositionButtons(row));

    tr.append(domain, seen, auth, state, last, actions);
    body.append(tr);
  }

  const userAllow = (lastIdentity?.allowlistedDomains || []).filter((entry) => entry.provenance === "user").length;
  const userBlock = (lastIdentity?.blockedDomains || []).filter((entry) => entry.provenance === "user").length;
  const observed = (lastIdentity?.allowlistedDomains || []).filter((entry) => entry.provenance === "observed").length;
  const builtIn = (lastIdentity?.blockedDomains || []).filter((entry) => entry.provenance === "built-in").length;
  $("trustSummary").textContent = lastIdentity
    ? `${userAllow} allowed by you · ${userBlock} blocked by you · ${observed} observed service domains · ${builtIn} built-in phishing-only domains · ${(lastIdentity.trustedAuthservIds || []).length} trusted authserv-id`
    : "Identity state has not been read yet.";
}

function renderAll() {
  renderTrust();
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
}
