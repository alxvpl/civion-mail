import { buildCivionMailPackage } from "../modules/federation.mjs";
import { availableSourceRecords, recordMatchesSourceFilter, sourceState } from "../modules/source-state.mjs";
import { describeNarrowing, emptyResultText, narrowingText } from "../modules/view-filters.mjs";
const CLOSED_STATUSES = new Set(["Completed", "Dismissed"]);
const URGENT_PRIORITIES = new Set(["Critical", "High"]);
const PRIORITY_ORDER = new Map([
  ["Critical", 0],
  ["High", 1],
  ["Medium", 2],
  ["Low", 3],
  ["No Action", 4]
]);

const STATUS_ORDER = new Map([
  ["New", 0],
  ["In Progress", 1],
  ["Waiting", 2],
  ["Reviewed", 3],
  ["Completed", 4],
  ["Dismissed", 5]
]);

const SORT_STORAGE_KEY = "mailSentinelActionCenterSort";
const COLUMN_WIDTH_STORAGE_KEY = "mailSentinelActionCenterColumnWidths";
const DENSITY_STORAGE_KEY = "mailSentinelActionCenterDensity";
const HIDDEN_COLUMNS_STORAGE_KEY = "mailSentinelActionCenterHiddenColumns";
const ADVANCED_FILTERS_STORAGE_KEY = "mailSentinelActionCenterAdvancedFilters";
const TABLE_COLUMNS = Object.freeze([
  { key: "deadline", label: "Deadline" },
  { key: "received", label: "Date" },
  { key: "priority", label: "Priority" },
  { key: "sender", label: "Sender" },
  { key: "subject", label: "Subject" },
  { key: "action", label: "Required action" },
  { key: "categories", label: "Categories" },
  { key: "status", label: "Status" }
]);
// Categories repeats what the detail dialog already shows and costs scan width, so it is
// off by default. Sender and Subject cannot be hidden: a row without them is unreadable.
const DEFAULT_HIDDEN_COLUMNS = Object.freeze(["categories"]);
const LOCKED_COLUMNS = new Set(["sender", "subject"]);
const COLUMN_MIN_WIDTHS = Object.freeze({
  deadline: 90,
  received: 112,
  priority: 96,
  sender: 170,
  subject: 180,
  action: 220,
  categories: 150,
  status: 116
});

const CATEGORY_LABELS = Object.freeze({
  "Action Required": "Action Required",
  "Deadline": "Deadline",
  "Payment": "Payment",
  "Official": "Official",
  "Reply Expected": "Reply Expected",
  "Commercial": "Commercial",
  "Suspicious": "Suspicious",
  "Personal": "Personal",
  "Information Only": "Information Only",
  "Unknown": "Unknown"
});

const PRIORITY_LABELS = Object.freeze({
  "Critical": "Critical",
  "High": "High",
  "Medium": "Medium",
  "Low": "Low",
  "No Action": "No Action"
});

const STATUS_LABELS = Object.freeze({
  "New": "New",
  "Reviewed": "Reviewed",
  "In Progress": "In Progress",
  "Waiting": "Waiting",
  "Completed": "Completed",
  "Dismissed": "Dismissed"
});

const RELATIONSHIP_LABELS = Object.freeze({
  "Government & Public Administration": "Government & Public Administration",
  "Pension & Social Security": "Pension & Social Security",
  "Healthcare": "Healthcare",
  "Employment & Salary": "Employment & Salary",
  "Banking & Finance": "Banking & Finance",
  "Insurance": "Insurance",
  "Housing": "Housing",
  "Energy & Utilities": "Energy & Utilities",
  "Telecom & Internet": "Telecom & Internet",
  "Transport & Mobility": "Transport & Mobility",
  "Subscriptions & Digital Services": "Subscriptions & Digital Services",
  "Purchases & Retail": "Purchases & Retail",
  "Professional & Business Services": "Professional & Business Services",
  "Personal": "Personal",
  "Marketing": "Marketing",
  "Unknown / Review": "Unknown / Review"
});

const DOCUMENT_TYPE_LABELS = Object.freeze({
  "Invoice": "Invoice", "Receipt": "Receipt", "Statement": "Statement", "Decision": "Decision",
  "Notification": "Notification", "Reminder": "Reminder", "Contract / Contract change": "Contract / Contract change",
  "Renewal": "Renewal", "Cancellation": "Cancellation", "Delivery notice": "Delivery notice",
  "Security alert": "Security alert", "Correspondence": "Correspondence", "Marketing message": "Marketing message", "Other": "Other"
});

const RETENTION_LABELS = Object.freeze({
  "Keep": "Keep", "Keep temporarily": "Keep temporarily", "Reference only": "Reference only",
  "Disposable": "Disposable", "Review manually": "Review manually"
});

const displayCategory = (value) => CATEGORY_LABELS[value] || value;
const displayPriority = (value) => PRIORITY_LABELS[value] || value;
const displayStatus = (value) => STATUS_LABELS[value] || value;
const displayRelationship = (value) => RELATIONSHIP_LABELS[value] || value;
const displayDocumentType = (value) => DOCUMENT_TYPE_LABELS[value] || value;
const displayRetention = (value) => RETENTION_LABELS[value] || value;

const MANUAL_FIELD_LABELS = Object.freeze({
  requiredAction: "action",
  priority: "priority",
  status: "status",
  deadline: "deadline",
  categories: "categories",
  markedIncorrect: "incorrect-analysis flag",
  userNotes: "user notes",
  legacy: "legacy manual changes"
});

const state = {
  quickFilter: "",
  hiddenColumns: new Set(DEFAULT_HIDDEN_COLUMNS),
  density: "comfortable",
  records: [],
  settings: {},
  accountLabels: {},
  categories: [],
  relationshipClasses: [],
  documentTypes: [],
  retentionClasses: [],
  priorities: [],
  statuses: [],
  selectedRecordId: null,
  metadata: {},
  listenerState: {},
  version: "0.5.0",
  provider: null,
  recovery: null,
  diagnosticReport: null,
  historicalScope: [],
  historicalScan: null,
  archiveExisting: null,
  archiveExistingScope: null,
  sort: { key: null, direction: null }
};

const elements = {};
let toastTimer = null;
let refreshTimer = null;
let historicalScanTimer = null;
let archiveExistingTimer = null;

function $(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing UI element: ${id}`);
  return element;
}

function cacheElements() {
  for (const id of [
    "statActive", "statUrgent", "statDueSoon", "statNew", "searchInput",
    "statActiveButton", "statUrgentButton", "statDueSoonButton", "statNewButton",
    "operationsMenu", "columnsMenu", "columnsPanel", "densityButton", "moreFiltersButton",
    "advancedFilters", "advancedFilterCount", "filterChips",
    "priorityFilter", "statusFilter", "categoryFilter", "relationshipFilter", "documentTypeFilter", "retentionFilter", "sourceFilter", "dateFilter", "dateRangeFields", "dateFrom", "dateTo", "refreshButton",
    "clearClosedButton", "recordsTable", "recordsBody", "emptyState", "recordCount", "versionLabel",
    "filterStatus", "filterStatusText", "clearFiltersButton", "showAllRetainedButton",
    "filteredEmptyState", "filteredEmptyDetail", "filteredClearFiltersButton", "filteredShowAllRetainedButton",
    "runtimePill", "modePill", "exportButton", "civionExportButton", "storageWarning", "settingsButton", "detailDialog", "detailForm", "detailSender", "detailSubject",
    "detailHeaderChips", "detailModeNotice", "detailSummary", "detailAction", "detailPriority", "detailStatus", "detailDeadline",
    "detailActionSource", "detailPrioritySource", "detailStatusSource", "detailDeadlineSource", "detailCategoriesSource", "detailNotesSource",
    "detailDeadlineEvidence", "detailNotes", "detailCategories", "detailIncorrect", "detailAccount", "detailFolder", "detailRecipients", "detailReceived", "detailLanguage",
    "detailAnalyzed", "detailAnalysisMode", "detailManualState", "detailConfidence", "detailPriorityReasons", "detailConfidenceReasons", "detailVerification", "detailDeadlineCandidates", "detailTypedFindings",
    "detailAmounts", "detailReply", "detailMandatory", "detailActionEvidence",
    "detailAvailability", "detailRelationship", "detailClaimedRelationship", "detailDocumentType", "detailRetention", "detailRetentionReason", "detailCivicMap", "detailAuthenticationVerdict", "detailAuthenticationMethods", "detailRisk", "detailRiskReasons", "detailNextStep",
    "detailAttachments", "detailArchive", "detailArchiveFiles", "retryArchiveButton", "openOriginalButton", "deleteOriginalButton", "reanalyzeButton", "removeRecordButton",
    "saveDetailButton", "settingsDialog", "settingsForm", "settingAutoTag", "settingTrustedAuthserv", "settingDesktopBridge", "settingDocumentArchive",
    "settingAnalyzeJunk", "settingRetention", "settingMaxRecords", "settingDiagnostics",
    "saveSettingsButton", "diagnosticsButton", "diagnosticsDialog", "diagnosticsSummary",
    "diagnosticsStatus", "diagnosticsGenerated", "diagAddon", "diagThunderbird", "diagPlatform",
    "diagCompatibility", "diagProvider", "diagNewMailListener", "diagMovedListener", "diagDeletedListener", "diagnosticsAuthserv", "diagnosticsChecks",
    "diagAcceptanceStatus", "diagAcceptanceReset", "diagAcceptanceGates", "diagBackgroundActivations", "diagFilteredFolderEvents", "diagJunkExcluded", "diagJunkAnalyzed",
    "diagnosticsAccountsBody", "diagNewMailEvents", "diagMessagesSeen", "diagMessagesHandled",
    "diagAnalysisFailures", "diagMovedEvents", "diagDeletedEvents", "diagStorageRecords",
    "diagStoragePressure", "diagRecoveryEntries", "diagMigrationStatus", "runSelfCheckButton", "exportDiagnosticsButton", "exportRecoveryButton", "resetAcceptanceButton",
    "historicalScanButton", "historicalScanDialog", "historicalScope", "historicalRecommendedButton", "historicalAllButton", "historicalNoneButton",
    "historicalDateFrom", "historicalDateTo", "historicalMaxMessages", "historicalReanalyze", "historicalApplyTags",
    "historicalProgress", "historicalStatus", "historicalProcessed", "historicalAnalyzed", "historicalSkipped", "historicalFailed", "historicalJunkAdmitted", "historicalJunkNotAdmitted", "historicalCurrentFolder", "historicalProgressNote",
    "historicalCancelButton", "historicalStartButton",
    "archiveExistingButton", "archiveExistingDialog", "archiveExistingScope", "archiveExistingProgress", "archiveExistingStatus",
    "archiveExistingDateFrom", "archiveExistingDateTo", "archiveExistingMaxMessages",
    "archiveExistingExamined", "archiveExistingPdfMessages", "archiveExistingRecognized", "archiveExistingArchived", "archiveExistingAlready",
    "archiveExistingSkipped", "archiveExistingPending", "archiveExistingFailed", "archiveExistingCurrentFolder", "archiveExistingNote",
    "archiveExistingCancelButton", "archiveExistingStartButton", "recordContextMenu", "toast"
  ]) {
    elements[id] = $(id);
  }
}

async function send(type, payload = {}) {
  const response = await messenger.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error || "The operation could not be completed.");
  return response;
}

function showToast(message, isError = false) {
  if (toastTimer) clearTimeout(toastTimer);
  elements.toast.textContent = String(message);
  elements.toast.hidden = false;
  elements.toast.dataset.kind = isError ? "error" : "success";
  toastTimer = setTimeout(() => {
    elements.toast.hidden = true;
  }, 3600);
}

// An Operations menu item is a label plus the note that says what the operation does.
// Writing textContent on the button itself deletes both and leaves a bare word for the
// rest of the session, so state changes are written into the label alone.
function menuItemLabel(button) {
  return button.querySelector(".lbl, .menu-item-label") || button;
}

function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function senderParts(record) {
  const sender = String(record?.sender || "");
  const bracket = sender.match(/<([^<>\s]+@[^<>\s]+)>/u);
  const plain = sender.match(/(?:^|\s)([^<>\s]+@[^<>\s]+)(?:$|\s)/u);
  const address = String(bracket?.[1] || plain?.[1] || "").trim().replace(/[>,;]+$/gu, "");
  const at = address.lastIndexOf("@");
  const domain = at >= 0 ? address.slice(at + 1).toLowerCase().replace(/^\.+|\.+$/gu, "") : "";
  return { address, domain };
}

function closeRecordContextMenu() {
  if (!elements.recordContextMenu) return;
  elements.recordContextMenu.hidden = true;
  elements.recordContextMenu.replaceChildren();
  elements.recordContextMenu.removeAttribute("data-record-id");
}

function contextMenuButton(label, action, options = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `context-menu-item${options.danger ? " context-menu-danger" : ""}`;
  button.textContent = label;
  if (options.disabled) button.disabled = true;
  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    if (button.disabled) return;
    closeRecordContextMenu();
    try {
      await action();
    } catch (error) {
      showToast(error.message, true);
    }
  });
  return button;
}

function contextSubmenu(label, entries) {
  const wrapper = document.createElement("div");
  wrapper.className = "context-submenu sub";
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "context-menu-item context-submenu-trigger";
  trigger.textContent = label;
  trigger.setAttribute("aria-haspopup", "menu");
  const panel = document.createElement("div");
  panel.className = "context-submenu-panel subpanel";
  panel.setAttribute("role", "menu");
  for (const entry of entries) panel.append(contextMenuButton(entry.label, entry.action, entry));
  wrapper.append(trigger, panel);
  return wrapper;
}

function contextDivider() {
  const divider = document.createElement("div");
  divider.className = "context-menu-divider sep";
  divider.setAttribute("role", "separator");
  return divider;
}

async function copyText(value, label) {
  const text = String(value || "");
  if (!text) throw new Error(`No ${label.toLowerCase()} is available to copy.`);
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
  } else {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    if (!document.execCommand("copy")) throw new Error("Copying is not permitted.");
    area.remove();
  }
  showToast(`${label} copied.`);
}

async function contextOpenOriginal(record) {
  if (record.messageAvailable === false) throw new Error("The original email is no longer available.");
  await send("openOriginal", { recordId: record.id });
}

async function contextDeleteOriginal(record) {
  if (record.messageAvailable === false) throw new Error("The original email is no longer available.");
  if (!window.confirm("Delete the original email? CIVION Mail will not use permanent delete; Thunderbird will apply the standard deletion behavior for this account. The analysis record will be kept.")) return;
  await send("deleteOriginal", { recordId: record.id });
  await loadState(false);
  showToast("The original email was deleted through Thunderbird.");
}

async function contextReanalyze(record) {
  const replaceableFields = manualFields(record)
    .filter((field) => ["legacy", "requiredAction", "priority", "deadline", "categories"].includes(field))
    .map((field) => MANUAL_FIELD_LABELS[field] || field);
  if (record.manualEdited && !window.confirm(
    `Reanalysis will replace manually changed fields: ${replaceableFields.join(", ") || "extracted values"}. Workflow status, notes, and the incorrect-analysis flag will be preserved. Continue?`
  )) return;
  await send("reanalyze", { recordId: record.id });
  await loadState(false);
  showToast("The analysis was updated.");
}

async function contextUpdateRecord(record, patch, message) {
  await send("updateRecord", { recordId: record.id, patch });
  await loadState(false);
  showToast(message);
}

async function contextSetDomain(record, disposition) {
  const { domain } = senderParts(record);
  if (!domain) throw new Error("The sender domain could not be determined.");
  const verb = disposition === "allow" ? "added to the allowlist" : disposition === "block" ? "blocked" : "removed from the local lists";
  const warning = disposition === "allow"
    ? `Add the exact domain “${domain}” to the local allowlist? This does NOT make it automatically safe and does not override Institution Hard Block or authentication checks.`
    : disposition === "block"
      ? `Block the exact domain “${domain}” in CIVION Mail? After reanalysis, messages from it will receive a Hard Block.`
      : `Remove the domain “${domain}” from the manual allowlist/blocklist?`;
  if (!window.confirm(warning)) return;
  await send("setDomainDisposition", { domain, disposition });
  await send("reanalyze", { recordId: record.id });
  await loadState(false);
  showToast(`${domain} was ${verb}.`);
}

function showRecordContextMenu(event, record) {
  event.preventDefault();
  event.stopPropagation();
  closeRecordContextMenu();
  const menu = elements.recordContextMenu;
  menu.dataset.recordId = record.id;
  menu.setAttribute("role", "menu");

  menu.append(contextMenuButton("Open original email", () => contextOpenOriginal(record), { disabled: record.messageAvailable === false }));
  menu.append(contextMenuButton("Reanalyze", () => contextReanalyze(record), { disabled: record.messageAvailable === false }));
  menu.append(contextDivider());

  menu.append(contextSubmenu("Status ▶", state.statuses.map((status) => ({
    label: `${record.status === status ? "✓ " : ""}${displayStatus(status)}`,
    action: () => contextUpdateRecord(record, { status }, "Status updated.")
  }))));
  menu.append(contextSubmenu("Priority ▶", state.priorities.map((priority) => ({
    label: `${record.priority === priority ? "✓ " : ""}${displayPriority(priority)}`,
    action: () => contextUpdateRecord(record, { priority }, "Priority updated.")
  }))));

  menu.append(contextMenuButton(record.markedIncorrect ? "Clear “analysis is incorrect” flag" : "Mark analysis as incorrect",
    () => contextUpdateRecord(record, { markedIncorrect: !record.markedIncorrect }, "Analysis feedback updated.")));

  const parts = senderParts(record);
  menu.append(contextSubmenu("Copy ▶", [
    { label: "Sender", action: () => copyText(record.sender, "Sender") },
    { label: "Email address", action: () => copyText(parts.address, "Email address"), disabled: !parts.address },
    { label: "Domain", action: () => copyText(parts.domain, "Domain"), disabled: !parts.domain },
    { label: "Subject", action: () => copyText(record.subject, "Subject") }
  ]));

  if (parts.domain) {
    const allowlisted = (state.settings.userAllowlistedDomains || []).includes(parts.domain);
    const blocked = (state.settings.userBlockedDomains || []).includes(parts.domain);
    menu.append(contextSubmenu("Identity ▶", [
      {
        label: allowlisted ? `Remove ${parts.domain} from allowlist` : `Add ${parts.domain} to allowlist`,
        action: () => contextSetDomain(record, allowlisted ? "clear" : "allow")
      },
      {
        label: blocked ? `Unblock ${parts.domain}` : `Block ${parts.domain} in Sentinel`,
        action: () => contextSetDomain(record, blocked ? "clear" : "block"),
        danger: !blocked
      }
    ]));
  }

  if (record.risk?.hardBlock === true) {
    menu.append(contextMenuButton("Show block reason", () => { openDetail(record.id); }));
  }

  menu.append(contextDivider());
  menu.append(contextMenuButton("Delete email", () => contextDeleteOriginal(record), { danger: true, disabled: record.messageAvailable === false }));

  menu.hidden = false;
  menu.style.left = "0px";
  menu.style.top = "0px";
  const rect = menu.getBoundingClientRect();
  const pad = 8;
  const x = Math.max(pad, Math.min(event.clientX, window.innerWidth - rect.width - pad));
  const y = Math.max(pad, Math.min(event.clientY, window.innerHeight - rect.height - pad));
  menu.dataset.submenuSide = x + rect.width + 260 > window.innerWidth ? "left" : "right";
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
}

function appendOption(select, value, label = value) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  select.append(option);
}

function fillSelect(select, values, preserveFirst = false, labelFor = (value) => value) {
  const first = preserveFirst ? select.querySelector("option")?.cloneNode(true) : null;
  clearNode(select);
  if (first) select.append(first);
  for (const value of values) appendOption(select, value, labelFor(value));
}

function normalizeSearch(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase();
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("bg-BG", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function formatDeadline(deadline) {
  if (!deadline?.date) return "—";
  const date = new Date(`${deadline.date}T00:00:00`);
  if (Number.isNaN(date.getTime())) return deadline.date;
  const formatted = new Intl.DateTimeFormat("bg-BG", { dateStyle: "medium" }).format(date);
  if (deadline.overdue) return `${formatted} · overdue`;
  if (Number.isFinite(deadline.daysRemaining)) {
    if (deadline.daysRemaining === 0) return `${formatted} · today`;
    if (deadline.daysRemaining === 1) return `${formatted} · tomorrow`;
    if (deadline.daysRemaining > 1 && deadline.daysRemaining <= 7) {
      return `${formatted} · in ${deadline.daysRemaining} days`;
    }
  }
  return formatted;
}

function formatRelativePeriod(estimated) {
  const period = estimated?.relativePeriod;
  if (!period) return "Review deadline";
  return `${period.count} ${period.unit} — verify start date`;
}

function formatDeadlineCandidate(candidate) {
  if (!candidate) return "";
  if (candidate.ambiguous && Array.isArray(candidate.alternatives)) {
    return `${candidate.raw || "Date"} — ambiguous: ${candidate.alternatives.join(" / ")}`;
  }
  const marker = candidate.marker ? `; marker: ${candidate.marker}` : "";
  return `${candidate.date || candidate.raw || "Unknown date"}${marker}`;
}

// v0.8.0: read-only visibility for typed administrative findings. The analyser
// owns the semantics; this only renders what it decided.
const TYPED_FINDING_LABELS = {
  deadline: "Deadline",
  payment: "Payment",
  appointment: "Appointment",
  delivery: "Delivery",
  renewal: "Renewal",
  information: "Information",
  cancellation_window: "Cancellation window"
};

function formatTypedFinding(finding) {
  if (!finding || !finding.type) return "";
  const label = TYPED_FINDING_LABELS[finding.type] || finding.type;
  const date = finding.date || finding.dateRaw || "";
  const parts = [date ? `${label}: ${date}` : label];
  parts.push(finding.actionRequired ? "action required" : "no action required");
  if (finding.needsVerification) parts.push("verify");
  const evidence = finding.evidenceMarker || finding.evidence || "";
  return `${parts.join(" · ")}${evidence ? ` — ${evidence}` : ""}`;
}

function verificationText(record) {
  const items = Array.isArray(record.needsVerification) ? record.needsVerification : [];
  if (!items.length) return "No additional verification requirement was recorded.";
  const labels = {
    deadline: "The deadline was not selected automatically.",
    deadline_ambiguous_numeric_date: "The numeric date format is ambiguous.",
    deadline_multiple_equal_candidates: "There are multiple equally ranked deadline candidates.",
    relative_deadline_anchor: "The deadline is relative: the start date has not been verified.",
    analysis_error: "Automatic analysis failed.",
    sender_authentication_conflict: "Mail authentication results conflict.",
    sender_authentication_failed: "A trusted mail authentication result indicates failure.",
    reply_to_domain_mismatch: "The Reply-To domain does not match the From domain."
  };
  return [...new Set(items.map((item) => labels[item] || String(item)))].join(" ");
}

function authenticationVerdictText(record) {
  const auth = record?.senderTrust?.authentication || {};
  const labels = {
    verified: "VERIFIED DOMAIN",
    failed: "AUTHENTICATION FAIL",
    conflict: "CONFLICTING RESULTS",
    untrusted_results: "RESULTS FROM UNTRUSTED AUTHSERV",
    observed_untrusted: "OBSERVED — AUTHSERV NOT TRUSTED",
    no_results: "NO AUTHENTICATION-RESULTS",
    unverified: "UNVERIFIED"
  };
  const verdict = labels[auth.verdict] || "UNVERIFIED";
  const method = auth.verificationMethod && auth.verificationMethod !== "none"
    ? ` · via ${String(auth.verificationMethod).toUpperCase()}`
    : "";
  const identity = record?.senderTrust?.verifiedIdentity ? " · protected identity matches" : "";
  return `${verdict}${method}${identity}`;
}

function authenticationMethodLines(record) {
  const auth = record?.senderTrust?.authentication || {};
  const lines = [];
  const methodLine = (label, value) => {
    if (!value?.present) return `${label}: no trusted result`;
    const evidence = Array.isArray(value.evidence) ? value.evidence : [];
    const domains = [...new Set(evidence.map((item) => item.domain).filter(Boolean))];
    const alignments = [...new Set(evidence.map((item) => item.alignment).filter(Boolean))];
    const suffix = [domains.length ? `domain ${domains.join(", ")}` : "", alignments.length ? `alignment ${alignments.join(", ")}` : ""]
      .filter(Boolean).join(" · ");
    return `${label}: ${String(value.result || "unknown").toUpperCase()}${suffix ? ` · ${suffix}` : ""}`;
  };
  lines.push(methodLine("DMARC", auth.dmarc));
  lines.push(methodLine("DKIM", auth.dkim));
  lines.push(methodLine("SPF", auth.spf));
  if (auth.replyTo?.domain) lines.push(`Reply-To: ${auth.replyTo.domain} · ${auth.replyTo.alignment || "unknown"}`);
  if (auth.returnPath?.domain) lines.push(`Return-Path: ${auth.returnPath.domain} · ${auth.returnPath.alignment || "unknown"}`);
  const trustedIds = Array.isArray(auth.authservIds)
    ? auth.authservIds.filter((item) => item.trust === "trusted").map((item) => item.id)
    : [];
  if (trustedIds.length) lines.push(`Trusted authserv-id: ${[...new Set(trustedIds)].join(", ")}`);
  else if (auth.present) lines.push("No trusted authserv-id is configured for these results.");
  return lines;
}

function priorityClass(priority) {
  return `priority-${String(priority || "low").toLowerCase().replace(/\s+/gu, "-")}`;
}

function amountText(amount) {
  if (!amount || !Number.isFinite(Number(amount.value))) return "";
  try {
    return new Intl.NumberFormat("bg-BG", {
      style: "currency",
      currency: amount.currency || "EUR",
      maximumFractionDigits: 2
    }).format(Number(amount.value));
  } catch {
    return `${amount.currency || ""} ${amount.value}`.trim();
  }
}

function manualFields(record) {
  if (Array.isArray(record?.manualFields)) return record.manualFields;
  return record?.manualEdited ? ["legacy"] : [];
}

function manualFieldText(record) {
  const fields = manualFields(record);
  if (!fields.length) return "None";
  return fields.map((field) => MANUAL_FIELD_LABELS[field] || field).join(", ");
}

function accountLabel(record) {
  return state.accountLabels?.[record?.accountId] || record?.accountId || "—";
}

function sourceText(record) {
  return [accountLabel(record), record?.folderName].filter((value) => value && value !== "—").join(" · ") || "Source unavailable";
}

function recordWarnings(record) {
  const warnings = [];
  if (record.risk?.hardBlock === true) warnings.push({ label: "BLOCKED", kind: "blocked" });
  const authVerdict = record?.senderTrust?.authentication?.verdict;
  if (authVerdict === "failed") warnings.push({ label: "AUTH FAIL", kind: "error" });
  if (authVerdict === "conflict") warnings.push({ label: "AUTH CONFLICT", kind: "warning" });
  if (record.analysisError) warnings.push({ label: "Analysis error", kind: "error" });
  if (record.messageAvailable === false) warnings.push({ label: "Original missing", kind: "error" });
  if (Array.isArray(record.needsVerification) && record.needsVerification.length) {
    warnings.push({ label: "Review required", kind: "warning" });
  } else if (Number.isFinite(Number(record.confidence)) && Number(record.confidence) < 0.6) {
    warnings.push({ label: "Low confidence", kind: "warning" });
  }
  return warnings;
}

function deadlineEvidenceText(record) {
  const deadline = record.deadline || record.estimatedDeadline;
  if (!deadline) return "No deadline evidence was selected.";
  if (deadline.raw === "manual" || deadline.manuallySet === true) return "The deadline was set manually by the user.";
  const parts = [];
  if (deadline.raw) parts.push(`Text: ${deadline.raw}`);
  if (deadline.marker) parts.push(`Marker: ${deadline.marker}`);
  if (deadline.date) parts.push(`ISO: ${deadline.date}`);
  if (Number.isFinite(Number(deadline.evidenceStrength))) {
    parts.push(`Evidence strength: ${Math.round(Number(deadline.evidenceStrength) * 100)}%`);
  }
  if (deadline.anchorResolved === false) parts.push("The start date of the relative deadline has not been verified.");
  return parts.join(" · ") || "No textual evidence was recorded.";
}

function setProvenanceBadge(element, record, field) {
  if (field === "userNotes") {
    element.textContent = "User";
    element.dataset.source = "user";
    element.title = "This field is intended only for local user notes.";
    return;
  }
  const isManual = manualFields(record).includes(field) || manualFields(record).includes("legacy");
  element.textContent = isManual ? "Manual" : "Analysis";
  element.dataset.source = isManual ? "manual" : "analysis";
  element.title = isManual
    ? "The current value was changed by the user."
    : "The current value comes from local analysis.";
}

function setText(element, value, fallback = "—") {
  const text = value === null || value === undefined || value === "" ? fallback : String(value);
  element.textContent = text;
}

function defaultRecordSort(a, b) {
  const aClosed = CLOSED_STATUSES.has(a.status) ? 1 : 0;
  const bClosed = CLOSED_STATUSES.has(b.status) ? 1 : 0;
  if (aClosed !== bClosed) return aClosed - bClosed;
  const priorityDifference = (PRIORITY_ORDER.get(a.priority) ?? 9) - (PRIORITY_ORDER.get(b.priority) ?? 9);
  if (priorityDifference !== 0) return priorityDifference;
  const aDeadline = a.deadline?.date ? Date.parse(`${a.deadline.date}T00:00:00Z`) : Number.POSITIVE_INFINITY;
  const bDeadline = b.deadline?.date ? Date.parse(`${b.deadline.date}T00:00:00Z`) : Number.POSITIVE_INFINITY;
  if (aDeadline !== bDeadline) return aDeadline - bDeadline;
  return Number(new Date(b.receivedAt || 0)) - Number(new Date(a.receivedAt || 0));
}

function compareText(a, b) {
  return String(a || "").localeCompare(String(b || ""), "bg", { sensitivity: "base", numeric: true });
}

function compareDeadline(a, b, direction) {
  const aValue = a.deadline?.date ? Date.parse(`${a.deadline.date}T00:00:00Z`) : null;
  const bValue = b.deadline?.date ? Date.parse(`${b.deadline.date}T00:00:00Z`) : null;
  if (aValue === null && bValue === null) return 0;
  if (aValue === null) return 1;
  if (bValue === null) return -1;
  return direction === "desc" ? bValue - aValue : aValue - bValue;
}

function compareReceived(a, b, direction) {
  const aValue = Number(new Date(a.receivedAt || 0));
  const bValue = Number(new Date(b.receivedAt || 0));
  if (!Number.isFinite(aValue) && !Number.isFinite(bValue)) return 0;
  if (!Number.isFinite(aValue)) return 1;
  if (!Number.isFinite(bValue)) return -1;
  return direction === "desc" ? bValue - aValue : aValue - bValue;
}

function recordMatchesDateFilter(record) {
  const mode = elements.dateFilter.value;
  if (!mode) return true;
  const received = new Date(record.receivedAt || 0);
  const receivedMs = received.getTime();
  if (!Number.isFinite(receivedMs)) return false;

  const now = new Date();
  const startToday = new Date(now);
  startToday.setHours(0, 0, 0, 0);

  if (mode === "today") return receivedMs >= startToday.getTime();
  if (mode === "7d") {
    const start = new Date(startToday);
    start.setDate(start.getDate() - 6);
    return receivedMs >= start.getTime();
  }
  if (mode === "30d") {
    const start = new Date(startToday);
    start.setDate(start.getDate() - 29);
    return receivedMs >= start.getTime();
  }
  if (mode === "custom") {
    const from = elements.dateFrom.value ? new Date(`${elements.dateFrom.value}T00:00:00`).getTime() : Number.NEGATIVE_INFINITY;
    const to = elements.dateTo.value ? new Date(`${elements.dateTo.value}T23:59:59.999`).getTime() : Number.POSITIVE_INFINITY;
    return receivedMs >= from && receivedMs <= to;
  }
  return true;
}

function columnSort(records) {
  const { key, direction } = state.sort;
  if (!key || !direction) return records.sort(defaultRecordSort);
  const multiplier = direction === "desc" ? -1 : 1;
  return records.sort((a, b) => {
    if (key === "deadline") return compareDeadline(a, b, direction) || defaultRecordSort(a, b);
    if (key === "received") return compareReceived(a, b, direction) || defaultRecordSort(a, b);
    let result = 0;
    if (key === "priority") result = (PRIORITY_ORDER.get(a.priority) ?? 9) - (PRIORITY_ORDER.get(b.priority) ?? 9);
    else if (key === "status") result = (STATUS_ORDER.get(a.status) ?? 9) - (STATUS_ORDER.get(b.status) ?? 9);
    else if (key === "sender") result = compareText(a.sender, b.sender);
    else if (key === "subject") result = compareText(a.subject, b.subject);
    else if (key === "action") result = compareText(a.requiredAction, b.requiredAction);
    else if (key === "categories") result = compareText((a.categories || []).map(displayCategory).join(" · "), (b.categories || []).map(displayCategory).join(" · "));
    if (result !== 0) return result * multiplier;
    return defaultRecordSort(a, b);
  });
}

function loadSortPreference() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SORT_STORAGE_KEY) || "null");
    const allowed = new Set(["deadline", "received", "priority", "sender", "subject", "action", "categories", "status"]);
    if (parsed && allowed.has(parsed.key) && ["asc", "desc"].includes(parsed.direction)) {
      state.sort = { key: parsed.key, direction: parsed.direction };
    }
  } catch {
    state.sort = { key: null, direction: null };
  }
}

function saveSortPreference() {
  if (!state.sort.key) localStorage.removeItem(SORT_STORAGE_KEY);
  else localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(state.sort));
}

function updateSortHeaders() {
  for (const button of document.querySelectorAll(".sort-button")) {
    const active = button.dataset.sortKey === state.sort.key;
    const th = button.closest("th");
    const indicator = button.querySelector(".sort-indicator");
    if (th) th.setAttribute("aria-sort", active ? (state.sort.direction === "asc" ? "ascending" : "descending") : "none");
    if (indicator) indicator.textContent = active ? (state.sort.direction === "asc" ? "▲" : "▼") : "↕";
    button.classList.toggle("sort-active", active);
  }
}

function cycleSort(key) {
  if (state.sort.key !== key) state.sort = { key, direction: "asc" };
  else if (state.sort.direction === "asc") state.sort = { key, direction: "desc" };
  else state.sort = { key: null, direction: null };
  saveSortPreference();
  updateSortHeaders();
  renderRows();
}

function readColumnWidths() {
  try {
    const parsed = JSON.parse(localStorage.getItem(COLUMN_WIDTH_STORAGE_KEY) || "null");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveColumnWidths(widths) {
  localStorage.setItem(COLUMN_WIDTH_STORAGE_KEY, JSON.stringify(widths));
}

function headerCells() {
  return [...elements.recordsTable.querySelectorAll("thead th[data-column-key]")];
}

function freezeCurrentColumnWidths() {
  const stored = readColumnWidths() || {};
  const widths = {};
  for (const th of headerCells()) {
    const key = th.dataset.columnKey;
    if (state.hiddenColumns.has(key)) {
      // A hidden column measures zero. Keep the width it had, so restoring the column
      // does not bring it back collapsed.
      const previous = Number(stored[key]);
      widths[key] = Number.isFinite(previous) ? previous : (COLUMN_MIN_WIDTHS[key] || 80);
      continue;
    }
    const width = Math.round(th.getBoundingClientRect().width);
    widths[key] = Math.max(COLUMN_MIN_WIDTHS[key] || 80, width);
  }
  applyColumnWidths(widths);
  return widths;
}

function applyColumnWidths(widths) {
  let total = 0;
  for (const th of headerCells()) {
    const key = th.dataset.columnKey;
    const raw = Number(widths[key]);
    const width = Number.isFinite(raw) ? Math.max(COLUMN_MIN_WIDTHS[key] || 80, Math.min(900, raw)) : Math.round(th.getBoundingClientRect().width);
    th.style.width = `${width}px`;
    // A hidden column keeps its width for later, but must not claim table space now.
    if (!state.hiddenColumns.has(key)) total += width;
  }
  if (total > 0) elements.recordsTable.style.width = `${Math.ceil(total)}px`;
}

function loadColumnWidths() {
  const widths = readColumnWidths();
  if (!Object.keys(widths).length) return;
  applyColumnWidths(widths);
}

function initializeColumnResize() {
  loadColumnWidths();

  for (const handle of document.querySelectorAll(".column-resizer")) {
    const th = handle.closest("th[data-column-key]");
    if (!th) continue;
    const key = th.dataset.columnKey;

    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const widths = freezeCurrentColumnWidths();
      const startX = event.clientX;
      const startWidth = widths[key];
      handle.dataset.active = "true";
      document.body.classList.add("column-resizing");

      const onMove = (moveEvent) => {
        const delta = moveEvent.clientX - startX;
        widths[key] = Math.max(COLUMN_MIN_WIDTHS[key] || 80, Math.min(900, startWidth + delta));
        applyColumnWidths(widths);
      };
      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);
        delete handle.dataset.active;
        document.body.classList.remove("column-resizing");
        saveColumnWidths(widths);
      };

      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp, { once: true });
      document.addEventListener("pointercancel", onUp, { once: true });
    });

    handle.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      const widths = freezeCurrentColumnWidths();
      const step = event.shiftKey ? 25 : 10;
      const delta = event.key === "ArrowRight" ? step : -step;
      widths[key] = Math.max(COLUMN_MIN_WIDTHS[key] || 80, Math.min(900, widths[key] + delta));
      applyColumnWidths(widths);
      saveColumnWidths(widths);
    });
  }
}

function getFilteredRecords() {
  const query = normalizeSearch(elements.searchInput.value.trim());
  const priority = elements.priorityFilter.value;
  const status = elements.statusFilter.value;
  const category = elements.categoryFilter.value;
  const relationshipClass = elements.relationshipFilter.value;
  const documentType = elements.documentTypeFilter.value;
  const retentionClass = elements.retentionFilter.value;
  const sourceFilter = elements.sourceFilter.value || "available";

  const filtered = state.records
    .filter((record) => {
      if (!matchesQuickFilter(record)) return false;
      if (priority && record.priority !== priority) return false;
      if (status && record.status !== status) return false;
      if (category && !record.categories?.includes(category)) return false;
      if (relationshipClass && record.relationshipClass !== relationshipClass) return false;
      if (documentType && record.documentType !== documentType) return false;
      if (retentionClass && record.retention?.class !== retentionClass) return false;
      if (!recordMatchesSourceFilter(record, sourceFilter)) return false;
      if (!recordMatchesDateFilter(record)) return false;
      if (!query) return true;
      const haystack = normalizeSearch([
        record.sender,
        record.subject,
        record.summary,
        record.requiredAction,
        record.recommendedNextStep,
        record.userNotes,
        record.folderName,
        accountLabel(record),
        record.relationshipClass,
        record.claimedRelationshipClass,
        record.documentType,
        record.retention?.class,
        record.retention?.reason,
        ...(record.categories || [])
      ].join("\n"));
      return haystack.includes(query);
    });
  return columnSort(filtered);
}

// The four counters and the quick filters share one definition, so a number can never
// disagree with the view it opens.
const QUICK_FILTERS = Object.freeze({
  urgent: {
    label: "Critical / High",
    match: (record) => URGENT_PRIORITIES.has(record.priority)
  },
  dueSoon: {
    label: "Due within 3 days",
    match: (record) => {
      const days = record.deadline?.daysRemaining;
      return record.deadline?.currentlyActionable !== false
        && Number.isFinite(days) && days >= 0 && days <= 3;
    }
  },
  new: {
    label: "New",
    match: (record) => record.status === "New"
  }
});

function matchesQuickFilter(record) {
  const quick = QUICK_FILTERS[state.quickFilter];
  if (!quick) return true;
  if (CLOSED_STATUSES.has(record.status)) return false;
  return quick.match(record);
}

function setQuickFilter(value) {
  state.quickFilter = QUICK_FILTERS[value] ? value : "";
  for (const button of [
    elements.statActiveButton, elements.statUrgentButton,
    elements.statDueSoonButton, elements.statNewButton
  ]) {
    button.setAttribute("aria-pressed", String((button.dataset.quick || "") === state.quickFilter));
  }
  renderRows();
}

function renderStats() {
  const active = availableSourceRecords(state.records).filter((record) => !CLOSED_STATUSES.has(record.status));
  elements.statActive.textContent = String(active.length);
  elements.statUrgent.textContent = String(active.filter(QUICK_FILTERS.urgent.match).length);
  elements.statDueSoon.textContent = String(active.filter(QUICK_FILTERS.dueSoon.match).length);
  elements.statNew.textContent = String(active.filter(QUICK_FILTERS.new.match).length);
}

// Every chip carries the r005 base class as well as the 0.8.1 one it was built with, so
// the same call renders correctly under either stylesheet while the port is in progress.
const CHIP_TONE = {
  "blocked-category-chip": "alert",
  "warning-error": "alert",
  "warning-warn": "suggested",
  "priority-critical": "alert",
  "priority-high": "alert",
  "priority-medium": "suggested",
  "priority-low": "neutral",
  "priority-none": "neutral"
};

function createChip(label, className) {
  const chip = document.createElement("span");
  const parts = String(className || "").split(/\s+/u).filter(Boolean);
  const tone = parts.map((part) => CHIP_TONE[part]).find(Boolean) || "neutral";
  if (!parts.includes("chip")) parts.push("chip");
  parts.push(tone);
  chip.className = parts.join(" ");
  chip.textContent = label;
  return chip;
}

function renderRows() {
  closeRecordContextMenu();
  const records = getFilteredRecords();
  clearNode(elements.recordsBody);

  for (const record of records) {
    const row = document.createElement("tr");
    row.dataset.recordId = record.id;
    row.dataset.priority = String(record.priority || "").toLowerCase().replace(/\s+/gu, "-");
    if (record.risk?.hardBlock === true) row.dataset.blocked = "true";

    const deadlineCell = document.createElement("td");
    deadlineCell.className = "deadline-cell num";
    const appendDeadline = (main, note) => {
      const dateLine = document.createElement("span");
      dateLine.className = "deadline-date";
      dateLine.textContent = main;
      deadlineCell.append(dateLine);
      if (note) {
        const noteLine = document.createElement("small");
        noteLine.className = "deadline-note sub-line";
        noteLine.textContent = note;
        deadlineCell.append(noteLine);
      }
    };
    if (record.deadline?.date) {
      const [main, note] = formatDeadline(record.deadline).split(" · ");
      appendDeadline(main, note);
      if (record.deadline.overdue) deadlineCell.classList.add("deadline-overdue");
    } else if (record.estimatedDeadline?.relativePeriod) {
      // Anchor unresolved: show the period, never an assumed calendar date.
      const [main, note] = formatRelativePeriod(record.estimatedDeadline).split(" — ");
      appendDeadline(main, note);
      deadlineCell.classList.add("deadline-verification");
    } else if (record.deadlineCandidates?.length) {
      appendDeadline("Review", "deadline not selected");
      deadlineCell.classList.add("deadline-verification");
    } else {
      deadlineCell.textContent = "—";
      deadlineCell.classList.add("muted");
    }

    const receivedCell = document.createElement("td");
    receivedCell.className = "received-cell num";
    const receivedDate = new Date(record.receivedAt || 0);
    if (Number.isNaN(receivedDate.getTime())) {
      receivedCell.textContent = "—";
      receivedCell.classList.add("muted");
    } else {
      const dateLine = document.createElement("span");
      dateLine.className = "received-date";
      dateLine.textContent = new Intl.DateTimeFormat("bg-BG", { day: "2-digit", month: "2-digit", year: "numeric" }).format(receivedDate);
      const timeLine = document.createElement("small");
      timeLine.className = "received-time sub-line";
      timeLine.textContent = new Intl.DateTimeFormat("bg-BG", { hour: "2-digit", minute: "2-digit" }).format(receivedDate);
      receivedCell.append(dateLine, timeLine);
    }

    const priorityCell = document.createElement("td");
    priorityCell.append(createChip(displayPriority(record.priority || "Unknown"), `chip ${priorityClass(record.priority)}`));

    const senderCell = document.createElement("td");
    senderCell.className = "sender-cell";
    const senderValue = record.sender || "Unknown sender";
    const bracketMatch = senderValue.match(/^(.*?)\s*<([^<>]+)>\s*$/u);
    const senderDisplayName = (bracketMatch ? bracketMatch[1] : senderValue).replace(/^["']+|["']+$/gu, "").trim();
    const senderAddress = bracketMatch ? bracketMatch[2].trim() : "";
    const senderName = document.createElement("span");
    senderName.className = "sender-name wrap-name";
    senderName.textContent = senderDisplayName || senderAddress || "Unknown sender";
    senderName.title = senderValue;
    senderCell.append(senderName);
    if (senderAddress && senderAddress !== senderName.textContent) {
      const addressLine = document.createElement("small");
      addressLine.className = "sender-address sub-line";
      addressLine.textContent = senderAddress;
      addressLine.title = senderAddress;
      senderCell.append(addressLine);
    }
    const senderSource = document.createElement("small");
    senderSource.className = "source-meta sub-line";
    senderSource.textContent = sourceText(record);
    senderCell.append(senderSource);

    const subjectCell = document.createElement("td");
    const subjectButton = document.createElement("button");
    subjectButton.type = "button";
    subjectButton.className = "subject-button wrap-name";
    subjectButton.textContent = record.subject || "(No subject)";
    subjectButton.title = "Open detailed analysis";
    subjectButton.addEventListener("click", (event) => {
      event.stopPropagation();
      openDetail(record.id);
    });
    subjectCell.append(subjectButton);
    const warnings = recordWarnings(record);
    if (warnings.length) {
      const flags = document.createElement("div");
      flags.className = "row-flags hchips";
      for (const warning of warnings) {
        flags.append(createChip(warning.label, `warning-chip warning-${warning.kind}`));
      }
      subjectCell.append(flags);
    }

    const actionCell = document.createElement("td");
    actionCell.className = "action-cell";
    const actionText = document.createElement("span");
    actionText.className = "action-text wrap-name";
    actionText.textContent = record.requiredAction || record.summary || "—";
    actionText.title = record.requiredAction || record.summary || "";
    actionCell.append(actionText);

    const categoriesCell = document.createElement("td");
    categoriesCell.className = "cats";
    if (record.risk?.hardBlock === true) categoriesCell.append(createChip("Blocked", "category-chip blocked-category-chip"));
    for (const categoryName of record.categories || ["Unknown"]) {
      categoriesCell.append(createChip(displayCategory(categoryName), "category-chip"));
    }

    const statusCell = document.createElement("td");
    const statusSelect = document.createElement("select");
    statusSelect.className = "status-select";
    statusSelect.setAttribute("aria-label", `Status for ${record.subject || "message"}`);
    for (const statusName of state.statuses) appendOption(statusSelect, statusName, displayStatus(statusName));
    statusSelect.value = record.status || "New";
    statusSelect.addEventListener("click", (event) => event.stopPropagation());
    statusSelect.addEventListener("keydown", (event) => event.stopPropagation());
    statusSelect.addEventListener("change", async (event) => {
      event.stopPropagation();
      statusSelect.disabled = true;
      try {
        await send("updateRecord", {
          recordId: record.id,
          patch: { status: statusSelect.value }
        });
        await loadState(false);
        showToast("Status updated.");
      } catch (error) {
        statusSelect.value = record.status || "New";
        showToast(error.message, true);
      } finally {
        statusSelect.disabled = false;
      }
    });
    statusCell.append(statusSelect);

    row.tabIndex = 0;
    row.className = "record-row pick";
    row.setAttribute("aria-label", `Open detailed analysis for ${record.subject || "message"}`);
    row.addEventListener("click", (event) => {
      if (event.target.closest("button, select, input, a")) return;
      openDetail(record.id);
    });
    row.addEventListener("keydown", (event) => {
      if (event.target !== row) return;
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault();
        const rect = row.getBoundingClientRect();
        showRecordContextMenu({
          preventDefault() {},
          stopPropagation() {},
          clientX: Math.min(rect.left + 48, window.innerWidth - 20),
          clientY: Math.min(rect.top + 28, window.innerHeight - 20)
        }, record);
        return;
      }
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openDetail(record.id);
    });
    row.addEventListener("contextmenu", (event) => showRecordContextMenu(event, record));

    row.append(deadlineCell, receivedCell, priorityCell, senderCell, subjectCell, actionCell, categoriesCell, statusCell);
    elements.recordsBody.append(row);
  }

  const retainedMissing = state.records.filter((record) => sourceState(record) === "missing").length;
  const narrowing = currentNarrowing(retainedMissing);
  const holdsRecords = state.records.length > 0;

  // Two distinct empty states. "Ready" claims nothing has been analyzed yet and must never
  // appear while records exist but are filtered out of view.
  elements.emptyState.hidden = records.length !== 0 || holdsRecords;
  elements.filteredEmptyState.hidden = records.length !== 0 || !holdsRecords;
  if (!elements.filteredEmptyState.hidden) {
    elements.filteredEmptyDetail.textContent = emptyResultText(narrowing, state.records.length);
    elements.filteredClearFiltersButton.hidden = !narrowing.clearable;
    elements.filteredShowAllRetainedButton.hidden = !narrowing.canShowRetained;
  }

  renderFilterStatus(narrowing);

  elements.recordCount.textContent = retainedMissing
    ? `${records.length} shown · ${retainedMissing} deleted/unavailable retained in history`
    : `${records.length} records`;
}

function currentNarrowing(retainedMissing) {
  return describeNarrowing({
    search: elements.searchInput.value,
    priority: elements.priorityFilter.value,
    status: elements.statusFilter.value,
    category: elements.categoryFilter.value,
    relationship: elements.relationshipFilter.value,
    documentType: elements.documentTypeFilter.value,
    retention: elements.retentionFilter.value,
    date: elements.dateFilter.value,
    source: elements.sourceFilter.value || "available"
  }, retainedMissing);
}

// ---------- Active-filter chips, drawer, columns and density (v0.6.11) ----------

function activeFilterChips() {
  const chips = [];
  const push = (key, label, value, clear) => { if (value) chips.push({ key, label, value, clear }); };
  if (state.quickFilter && QUICK_FILTERS[state.quickFilter]) {
    chips.push({
      key: "View",
      label: QUICK_FILTERS[state.quickFilter].label,
      clear: () => setQuickFilter("")
    });
  }
  push("Search", elements.searchInput.value.trim(), elements.searchInput.value.trim(),
    () => { elements.searchInput.value = ""; renderRows(); });
  const selects = [
    ["Priority", elements.priorityFilter, displayPriority],
    ["Status", elements.statusFilter, displayStatus],
    ["Category", elements.categoryFilter, displayCategory],
    ["Relationship", elements.relationshipFilter, (value) => value],
    ["Document type", elements.documentTypeFilter, (value) => value],
    ["Retention", elements.retentionFilter, (value) => value],
    ["Date", elements.dateFilter, (value) => value]
  ];
  for (const [key, select, label] of selects) {
    if (!select.value) continue;
    chips.push({
      key,
      label: label(select.value),
      clear: () => {
        select.value = "";
        if (select === elements.dateFilter) elements.dateRangeFields.hidden = true;
        renderRows();
      }
    });
  }
  if ((elements.sourceFilter.value || "available") !== "available") {
    chips.push({
      key: "Original",
      label: elements.sourceFilter.selectedOptions[0]?.textContent || elements.sourceFilter.value,
      clear: () => { elements.sourceFilter.value = "available"; renderRows(); }
    });
  }
  return chips;
}

function renderFilterChips() {
  const chips = activeFilterChips();
  clearNode(elements.filterChips);
  for (const chip of chips) {
    const node = document.createElement("span");
    node.className = "filter-chip fchip";
    const key = document.createElement("span");
    key.className = "chip-key";
    key.textContent = chip.key;
    const label = document.createElement("span");
    label.textContent = chip.label;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "chip-remove";
    remove.textContent = "\u00d7";
    remove.setAttribute("aria-label", `Remove ${chip.key} filter`);
    remove.addEventListener("click", chip.clear);
    node.append(key, label, remove);
    elements.filterChips.append(node);
  }
  const advanced = [
    elements.categoryFilter, elements.relationshipFilter, elements.documentTypeFilter,
    elements.retentionFilter, elements.dateFilter
  ].filter((select) => Boolean(select.value)).length
    + (((elements.sourceFilter.value || "available") !== "available") ? 1 : 0);
  elements.advancedFilterCount.hidden = advanced === 0;
  elements.advancedFilterCount.textContent = String(advanced);
  return chips.length > 0;
}

function setAdvancedFiltersOpen(open) {
  elements.advancedFilters.hidden = !open;
  elements.moreFiltersButton.setAttribute("aria-expanded", String(open));
  try {
    localStorage.setItem(ADVANCED_FILTERS_STORAGE_KEY, open ? "open" : "closed");
  } catch {
    // A blocked storage write must never prevent the drawer from opening.
  }
}

function applyDensity(density) {
  state.density = density === "compact" ? "compact" : "comfortable";
  document.body.dataset.density = state.density;
  elements.densityButton.setAttribute("aria-pressed", String(state.density === "compact"));
  elements.densityButton.textContent = state.density === "compact" ? "Comfortable" : "Compact";
  try {
    localStorage.setItem(DENSITY_STORAGE_KEY, state.density);
  } catch {
    // Preference only; the toggle still applies for this session.
  }
}

function applyHiddenColumns() {
  const hidden = [...state.hiddenColumns].filter((key) => !LOCKED_COLUMNS.has(key));
  elements.recordsTable.dataset.hidden = hidden.join(" ");
  const stored = readColumnWidths();
  if (stored) applyColumnWidths(stored);
  try {
    localStorage.setItem(HIDDEN_COLUMNS_STORAGE_KEY, JSON.stringify(hidden));
  } catch {
    // Preference only.
  }
}

function renderColumnsPanel() {
  clearNode(elements.columnsPanel);
  for (const column of TABLE_COLUMNS) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !state.hiddenColumns.has(column.key);
    input.disabled = LOCKED_COLUMNS.has(column.key);
    input.addEventListener("change", () => {
      if (input.checked) state.hiddenColumns.delete(column.key);
      else state.hiddenColumns.add(column.key);
      applyHiddenColumns();
    });
    const text = document.createElement("span");
    text.textContent = column.label;
    label.append(input, text);
    elements.columnsPanel.append(label);
  }
}

function loadViewPreferences() {
  try {
    applyDensity(localStorage.getItem(DENSITY_STORAGE_KEY) || "comfortable");
  } catch {
    applyDensity("comfortable");
  }
  try {
    const parsed = JSON.parse(localStorage.getItem(HIDDEN_COLUMNS_STORAGE_KEY) || "null");
    if (Array.isArray(parsed)) {
      const allowed = new Set(TABLE_COLUMNS.map((column) => column.key));
      state.hiddenColumns = new Set(parsed
        .filter((key) => allowed.has(key) && !LOCKED_COLUMNS.has(key)));
    }
  } catch {
    state.hiddenColumns = new Set(DEFAULT_HIDDEN_COLUMNS);
  }
  applyHiddenColumns();
  renderColumnsPanel();
  try {
    setAdvancedFiltersOpen(localStorage.getItem(ADVANCED_FILTERS_STORAGE_KEY) === "open");
  } catch {
    setAdvancedFiltersOpen(false);
  }
}

function closeMenus(except = null) {
  for (const menu of [elements.operationsMenu, elements.columnsMenu]) {
    if (menu !== except) menu.open = false;
  }
}

function renderFilterStatus(narrowing) {
  const hasChips = renderFilterChips();
  elements.filterStatus.hidden = !narrowing.narrowed && !hasChips;
  if (!narrowing.narrowed) {
    elements.filterStatusText.textContent = "";
    elements.clearFiltersButton.hidden = !hasChips;
    elements.showAllRetainedButton.hidden = true;
    return;
  }
  elements.filterStatusText.textContent = narrowingText(narrowing);
  elements.clearFiltersButton.hidden = !narrowing.clearable;
  elements.showAllRetainedButton.hidden = !narrowing.canShowRetained;
}

function clearFilters() {
  elements.searchInput.value = "";
  for (const select of [
    elements.priorityFilter, elements.statusFilter, elements.categoryFilter,
    elements.relationshipFilter, elements.documentTypeFilter, elements.retentionFilter,
    elements.dateFilter
  ]) {
    select.value = "";
  }
  elements.dateFrom.value = "";
  elements.dateTo.value = "";
  elements.dateRangeFields.hidden = true;
  // The default view is available mail; clearing returns to the default, it does not widen
  // beyond it. Revealing retained originals is a separate, explicit action.
  elements.sourceFilter.value = "available";
  setQuickFilter("");
}

function showAllRetainedRecords() {
  elements.sourceFilter.value = "all";
  renderRows();
}

// Identity state is owned by the background. This is the bridge and the only place that
// asks for it: the snapshot is frozen before it is published, so a screen that tries to
// keep or edit its own copy of the sender lists fails loudly instead of drifting.
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

async function publishIdentityState() {
  try {
    const response = await send("getIdentityState");
    document.dispatchEvent(new CustomEvent("civion:identity-state", {
      detail: deepFreeze(response.identity)
    }));
  } catch (error) {
    // A screen keeps the snapshot it already has rather than showing a half-empty one.
    showToast(`Identity state could not be read: ${error.message}`, true);
  }
}

// Review's two state-backed queues: a reading you rejected, and a rule that has only just
// started acting. Both are runtime facts rather than message facts, so they arrive the
// same way — read-only, frozen, owned by the background.
async function publishReviewState() {
  try {
    const response = await send("getReviewState");
    document.dispatchEvent(new CustomEvent("civion:review-state", {
      detail: deepFreeze(response.review)
    }));
  } catch (error) {
    showToast(`Review state could not be read: ${error.message}`, true);
  }
}

// A view asks; the background decides; the next snapshot is what the view shows.
document.addEventListener("civion:review-command", (event) => {
  const detail = event.detail || {};
  void (async () => {
    try {
      if (detail.type === "reject-finding" || detail.type === "restore-finding") {
        await send("setReviewRejection", {
          recordId: detail.recordId,
          findingId: detail.findingId,
          rejected: detail.type === "reject-finding",
          reason: detail.reason || ""
        });
        showToast(detail.type === "reject-finding"
          ? "The reading is marked as rejected. It stays visible and is not treated as operational."
          : "The reading is no longer rejected.");
      } else if (detail.type === "acknowledge-rule") {
        await send("acknowledgeRule", { ruleId: detail.ruleId });
        showToast("Rule acknowledged.");
      } else {
        return;
      }
      await loadState(false);
    } catch (error) {
      showToast(error.message, true);
    }
  })();
});

// Junk admission is its own read-only contract, not part of identity: identity is about
// domains the person decided on, this is about what the gate did to individual messages.
async function publishJunkAdmissionState() {
  try {
    const response = await send("getJunkAdmissionState");
    document.dispatchEvent(new CustomEvent("civion:junk-admission-state", {
      detail: deepFreeze(response.junk)
    }));
  } catch (error) {
    showToast(`Junk admission state could not be read: ${error.message}`, true);
  }
}

// A view asks for a change; it never performs one. The background decides and the next
// snapshot is what the view sees, so Trust and Review cannot disagree with the runtime.
document.addEventListener("civion:identity-command", (event) => {
  const { domain, disposition } = event.detail || {};
  void (async () => {
    try {
      await send("setDomainDisposition", { domain, disposition });
      await loadState(false);
      showToast(disposition === "clear"
        ? `Cleared the disposition for ${domain}.`
        : `${domain} is now ${disposition === "allow" ? "allowlisted" : "blocked"}.`);
    } catch (error) {
      showToast(error.message, true);
    }
  })();
});

// The derived screens read the record set; they do not own it and never write it back.
// One event after every render is the whole contract between app.js and them, so a view
// can be added or removed without app.js knowing anything about it.
function publishState() {
  document.dispatchEvent(new CustomEvent("civion:state", {
    detail: {
      records: state.records,
      accountLabels: state.accountLabels,
      metadata: state.metadata,
      settings: state.settings,
      version: state.version
    }
  }));
}

function render() {
  renderStats();
  renderRows();
  publishState();
  elements.versionLabel.textContent = `v${state.version}`;
  const runtimeActive = state.listenerState.newMail === true;
  elements.runtimePill.textContent = runtimeActive ? "ACTIVE" : "ERROR";
  elements.runtimePill.dataset.status = runtimeActive ? "active" : "error";
  elements.runtimePill.title = runtimeActive
    ? "The background process is active and listening for new messages."
    : "The new-mail listener is not registered. Open Diagnostics.";

  const autoTag = state.settings.autoTag === true;
  elements.modePill.textContent = autoTag ? "AUTO TAG" : "PREVIEW";
  elements.modePill.dataset.mode = autoTag ? "active" : "preview";
  const scanRunning = state.historicalScan?.status === "running";
  const archiveRunning = state.archiveExisting?.status === "running";
  elements.historicalScanButton.dataset.status = scanRunning ? "running" : "idle";
  menuItemLabel(elements.historicalScanButton).textContent = scanRunning ? "Historical Scan · running" : "Historical Scan";
  elements.historicalScanButton.disabled = archiveRunning;
  elements.archiveExistingButton.dataset.status = archiveRunning ? "running" : "idle";
  menuItemLabel(elements.archiveExistingButton).textContent = archiveRunning ? "Archive PDFs · running" : "Archive existing PDFs";
  elements.archiveExistingButton.disabled = scanRunning;

  const storagePressure = state.metadata.storagePressure === true;
  elements.storageWarning.hidden = !storagePressure;
  if (storagePressure) {
    elements.storageWarning.textContent = `Storage pressure: ${state.metadata.activeRecordCount || state.records.length} active records above the soft limit. Active records were not deleted.`;
  }
}

function configureControls() {
  fillSelect(elements.priorityFilter, state.priorities, true, displayPriority);
  fillSelect(elements.statusFilter, state.statuses, true, displayStatus);
  fillSelect(elements.categoryFilter, state.categories, true, displayCategory);
  fillSelect(elements.relationshipFilter, state.relationshipClasses, true, displayRelationship);
  fillSelect(elements.documentTypeFilter, state.documentTypes, true, displayDocumentType);
  fillSelect(elements.retentionFilter, state.retentionClasses, true, displayRetention);
  fillSelect(elements.detailPriority, state.priorities, false, displayPriority);
  fillSelect(elements.detailStatus, state.statuses, false, displayStatus);

  clearNode(elements.detailCategories);
  for (const category of state.categories) {
    const label = document.createElement("label");
    label.className = "check-line";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = category;
    checkbox.dataset.category = category;
    const text = document.createElement("span");
    text.textContent = category;
    label.append(checkbox, text);
    elements.detailCategories.append(label);
  }
}

async function loadState(reconfigure = true) {
  const response = await send("getState");
  state.records = Array.isArray(response.records) ? response.records : [];
  state.settings = response.settings || {};
  state.accountLabels = response.accountLabels || {};
  state.categories = Array.isArray(response.categories) ? response.categories : [];
  state.relationshipClasses = Array.isArray(response.relationshipClasses) ? response.relationshipClasses : [];
  state.documentTypes = Array.isArray(response.documentTypes) ? response.documentTypes : [];
  state.retentionClasses = Array.isArray(response.retentionClasses) ? response.retentionClasses : [];
  state.priorities = Array.isArray(response.priorities) ? response.priorities : [];
  state.statuses = Array.isArray(response.statuses) ? response.statuses : [];
  state.metadata = response.metadata || {};
  state.listenerState = response.listenerState || {};
  state.historicalScan = response.historicalScan || null;
  state.archiveExisting = response.archiveExisting || null;
  state.version = response.version || "0.1.15";
  if (reconfigure) configureControls();
  render();
  // Every refresh republishes the two read-only snapshots too, so a change to the allow or
  // block list, or a newly admitted junk message, reaches Trust and Review on the same tick
  // as the records, without a reload.
  void publishIdentityState();
  void publishJunkAdmissionState();
  void publishReviewState();
}

function selectedRecord() {
  return state.records.find((record) => record.id === state.selectedRecordId) || null;
}

function fillList(list, values, emptyText = "None") {
  clearNode(list);
  const normalized = Array.isArray(values) ? values.filter(Boolean) : [];
  if (!normalized.length) {
    const item = document.createElement("li");
    item.textContent = emptyText;
    item.className = "muted dim";
    list.append(item);
    return;
  }
  for (const value of normalized) {
    const item = document.createElement("li");
    item.textContent = String(value?.name || value?.filename || value);
    list.append(item);
  }
}

function renderDetail(record) {
  state.selectedRecordId = record.id;

  setText(elements.detailSender, record.sender, "Unknown sender");
  setText(elements.detailSubject, record.subject, "(No subject)");
  clearNode(elements.detailHeaderChips);
  elements.detailHeaderChips.append(
    createChip(displayPriority(record.priority || "Unknown"), `chip ${priorityClass(record.priority)}`),
    createChip(displayStatus(record.status || "New"), "category-chip")
  );
  for (const category of (record.categories || []).slice(0, 3)) {
    elements.detailHeaderChips.append(createChip(displayCategory(category), "category-chip"));
  }
  for (const warning of recordWarnings(record)) {
    elements.detailHeaderChips.append(createChip(warning.label, `warning-chip warning-${warning.kind}`));
  }

  const overwriteFields = manualFields(record)
    .filter((field) => ["legacy", "requiredAction", "priority", "deadline", "categories"].includes(field));
  const manualNotice = overwriteFields.length
    ? `Manually changed fields: ${overwriteFields.map((field) => MANUAL_FIELD_LABELS[field] || field).join(", ")}. Reanalysis may replace them; workflow status and notes are preserved.`
    : "Automatic local analysis. The original message is not modified.";
  setText(elements.detailModeNotice, manualNotice);
  elements.detailModeNotice.dataset.manual = overwriteFields.length ? "true" : "false";

  setText(elements.detailSummary, record.summary);
  elements.detailAction.value = record.requiredAction || "";
  elements.detailPriority.value = record.priority || "Low";
  elements.detailStatus.value = record.status || "New";
  elements.detailDeadline.value = record.deadline?.date || "";
  elements.detailNotes.value = record.userNotes || "";
  elements.detailIncorrect.checked = record.markedIncorrect === true;

  setProvenanceBadge(elements.detailActionSource, record, "requiredAction");
  setProvenanceBadge(elements.detailPrioritySource, record, "priority");
  setProvenanceBadge(elements.detailStatusSource, record, "status");
  setProvenanceBadge(elements.detailDeadlineSource, record, "deadline");
  setProvenanceBadge(elements.detailCategoriesSource, record, "categories");
  setProvenanceBadge(elements.detailNotesSource, record, "userNotes");
  setText(elements.detailDeadlineEvidence, deadlineEvidenceText(record));

  for (const checkbox of elements.detailCategories.querySelectorAll("input[type='checkbox']")) {
    checkbox.checked = record.categories?.includes(checkbox.value) || false;
  }

  setText(elements.detailAccount, accountLabel(record));
  setText(elements.detailFolder, record.folderName || record.folderId);
  setText(elements.detailRecipients, Array.isArray(record.recipients) ? record.recipients.join(", ") : "");
  setText(elements.detailReceived, formatDateTime(record.receivedAt));
  setText(elements.detailAnalyzed, formatDateTime(record.analyzedAt || record.updatedAt));
  const provider = record.analysisProvider || {};
  const providerText = `${provider.label || provider.id || "Local Rules"} · contract v${provider.contractVersion || "?"}`;
  setText(elements.detailAnalysisMode, `${record.analysisMode || "local"} · ${record.analysisVersion || "unknown"} · ${providerText}`);
  setText(elements.detailManualState, manualFieldText(record));
  setText(elements.detailLanguage, record.language || record.languageDetection?.language || "und");
  const confidence = Number(record.confidence);
  const confidenceText = Number.isFinite(confidence)
    ? `${record.confidenceLabel || ""} ${Math.round(confidence * 100)}%`.trim()
    : "—";
  setText(elements.detailConfidence, confidenceText);
  fillList(elements.detailPriorityReasons, record.priorityReasons, "No reasons recorded.");
  fillList(elements.detailConfidenceReasons, record.confidenceReasons, "No reasons recorded.");
  setText(elements.detailVerification, verificationText(record));
  fillList(
    elements.detailDeadlineCandidates,
    (record.deadlineCandidates || []).map(formatDeadlineCandidate),
    "No additional date candidates."
  );
  fillList(
    elements.detailTypedFindings,
    (record.typedFindings || []).map(formatTypedFinding).filter(Boolean),
    "No typed administrative findings were extracted."
  );
  const amounts = (record.amounts || []).map(amountText).filter(Boolean);
  setText(elements.detailAmounts, amounts.join(", "));
  setText(elements.detailReply, record.replyExpected ? "Yes" : "No");
  setText(elements.detailMandatory, record.mandatoryAction ? "Yes" : "No");
  fillList(
    elements.detailActionEvidence,
    (record.action?.evidence || record.actionEvidence || []).map((item) => {
      const strength = Number.isFinite(Number(item?.strength)) ? ` · ${Math.round(Number(item.strength) * 100)}% evidence` : "";
      return `${item?.sentence || item?.matched || "Unknown evidence"}${strength}`;
    }),
    "No specific action evidence was found."
  );
  const availability = record.messageAvailable === false
    ? "Original deleted or unavailable"
    : record.headerMessageIdCollision
      ? "Available; duplicate Message-ID detected"
      : "Original available";
  setText(elements.detailAvailability, availability);
  setText(elements.detailRelationship, displayRelationship(record.relationshipClass || "Unknown / Review"));
  setText(elements.detailClaimedRelationship, record.claimedRelationshipClass ? displayRelationship(record.claimedRelationshipClass) : "—");
  setText(elements.detailDocumentType, displayDocumentType(record.documentType || "Other"));
  setText(elements.detailRetention, displayRetention(record.retention?.class || "Review manually"));
  setText(elements.detailRetentionReason, record.retention?.reason || "—");
  const civic = record.civicMapReference || {};
  setText(elements.detailCivicMap, civic.eligible ? `${civic.status || "candidate"} · ${civic.route || "CIVION Civic"}` : "Not applicable");
  setText(elements.detailAuthenticationVerdict, authenticationVerdictText(record));
  fillList(elements.detailAuthenticationMethods, authenticationMethodLines(record), "No mail authentication data.");
  setText(elements.detailRisk, record.risk?.hardBlock === true
    ? `BLOCKED · ${record.risk?.claimedInstitutionLabel || "official institution"} · ${record.risk?.actualDomain || "unknown domain"}`
    : `${record.risk?.level || "Low"} · rule indicator ${Number(record.risk?.score || 0)}/100`);
  fillList(elements.detailRiskReasons, record.risk?.reasons, "No indicators detected.");
  setText(elements.detailNextStep, record.recommendedNextStep);
  fillList(elements.detailAttachments, record.importantAttachments, "No important attachments flagged.");
  const archive = record.documentArchive;
  const archiveLabels = {
    archived: "Archived in F:\\01_ARCHIVE\\CIVION",
    partial: "Partly archived; one or more documents are pending",
    pending: "Pending — archive drive or local host is unavailable",
    failed: "Not archived — validation failed",
    not_applicable: "No recognized PDF document to archive"
  };
  setText(elements.detailArchive, archiveLabels[archive?.state] || "Not evaluated yet");
  fillList(
    elements.detailArchiveFiles,
    (archive?.files || []).map((file) => file.relativePath
      ? `${file.state}: F:\\01_ARCHIVE\\CIVION\\${String(file.relativePath).replaceAll("/", "\\")}`
      : `${file.state}: ${file.originalFilename || "document"}`),
    "No archived files."
  );

  elements.openOriginalButton.disabled = record.messageAvailable === false;
  elements.deleteOriginalButton.disabled = record.messageAvailable === false;
  elements.retryArchiveButton.disabled = record.messageAvailable === false;
  elements.deleteOriginalButton.title = record.messageAvailable === false
    ? "The original email is no longer available."
    : "Delete the original email using Thunderbird’s standard behavior for this account.";
  elements.openOriginalButton.title = record.messageAvailable === false
    ? "The original message is no longer available in Thunderbird."
    : "Open the original message in Thunderbird.";
}

function openDetail(recordId) {
  const record = state.records.find((item) => item.id === recordId);
  if (!record) return;
  renderDetail(record);
  if (!elements.detailDialog.open) elements.detailDialog.showModal();
}

async function saveDetail() {
  const record = selectedRecord();
  if (!record) return;
  const categories = [...elements.detailCategories.querySelectorAll("input[type='checkbox']:checked")]
    .map((checkbox) => checkbox.value);
  const dateValue = elements.detailDeadline.value;
  const previousDate = record.deadline?.date || "";
  const deadline = dateValue === previousDate
    ? record.deadline || null
    : dateValue
      ? {
          date: dateValue,
          overdue: Date.parse(`${dateValue}T23:59:59`) < Date.now(),
          daysRemaining: Math.ceil((Date.parse(`${dateValue}T00:00:00`) - Date.now()) / 86400000),
          confidence: 1,
          evidenceStrength: 1,
          manuallySet: true,
          raw: "manual"
        }
      : null;

  elements.saveDetailButton.disabled = true;
  try {
    await send("updateRecord", {
      recordId: record.id,
      patch: {
        requiredAction: elements.detailAction.value.trim(),
        priority: elements.detailPriority.value,
        status: elements.detailStatus.value,
        deadline,
        categories,
        userNotes: elements.detailNotes.value.trim(),
        markedIncorrect: elements.detailIncorrect.checked
      }
    });
    await loadState(false);
    const updated = selectedRecord();
    if (updated) renderDetail(updated);
    showToast("Changes saved.");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    elements.saveDetailButton.disabled = false;
  }
}


function historicalFolderCheckboxes() {
  return [...elements.historicalScope.querySelectorAll("input[data-historical-folder-id]")];
}

function setHistoricalFolderSelection(mode) {
  for (const checkbox of historicalFolderCheckboxes()) {
    if (mode === "all") checkbox.checked = true;
    else if (mode === "none") checkbox.checked = false;
    else checkbox.checked = checkbox.dataset.recommended === "true";
  }
  for (const accountToggle of elements.historicalScope.querySelectorAll("input[data-historical-account-id]")) {
    const accountId = accountToggle.dataset.historicalAccountId;
    const children = historicalFolderCheckboxes().filter((box) => box.dataset.accountId === accountId);
    accountToggle.checked = children.length > 0 && children.every((box) => box.checked);
    accountToggle.indeterminate = children.some((box) => box.checked) && !accountToggle.checked;
  }
}

function syncHistoricalAccountToggle(accountId) {
  const toggle = elements.historicalScope.querySelector(`input[data-historical-account-id="${CSS.escape(accountId)}"]`);
  if (!toggle) return;
  const children = historicalFolderCheckboxes().filter((box) => box.dataset.accountId === accountId);
  toggle.checked = children.length > 0 && children.every((box) => box.checked);
  toggle.indeterminate = children.some((box) => box.checked) && !toggle.checked;
}

function renderHistoricalScope(accounts) {
  clearNode(elements.historicalScope);
  if (!accounts.length) {
    const empty = document.createElement("p");
    empty.className = "muted dim";
    empty.textContent = "No Thunderbird accounts or folders were found.";
    elements.historicalScope.append(empty);
    return;
  }
  for (const account of accounts) {
    const section = document.createElement("section");
    section.className = "historical-account";
    const heading = document.createElement("div");
    heading.className = "historical-account-heading acct";
    const label = document.createElement("label");
    label.className = "check-line";
    const accountToggle = document.createElement("input");
    accountToggle.type = "checkbox";
    accountToggle.dataset.historicalAccountId = account.id;
    const name = document.createElement("strong");
    name.textContent = `${account.name} · ${account.type}`;
    label.append(accountToggle, name);
    const count = document.createElement("span");
    count.className = "muted dim";
    count.textContent = `${account.folders.length} folders`;
    heading.append(label, count);

    const grid = document.createElement("div");
    grid.className = "historical-folder-grid";
    for (const folder of account.folders) {
      const folderLabel = document.createElement("label");
      folderLabel.className = "check-line";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.historicalFolderId = folder.id;
      checkbox.dataset.accountId = account.id;
      checkbox.dataset.recommended = folder.recommended ? "true" : "false";
      checkbox.checked = folder.recommended === true;
      const text = document.createElement("span");
      text.textContent = folder.path || folder.name;
      if (Array.isArray(folder.specialUse) && folder.specialUse.length) {
        const special = document.createElement("small");
        special.className = "historical-special-use tag";
        special.textContent = ` · ${folder.specialUse.join(", ")}`;
        text.append(special);
      }
      checkbox.addEventListener("change", () => syncHistoricalAccountToggle(account.id));
      folderLabel.append(checkbox, text);
      grid.append(folderLabel);
    }
    accountToggle.addEventListener("change", () => {
      for (const box of historicalFolderCheckboxes()) {
        if (box.dataset.accountId === account.id) box.checked = accountToggle.checked;
      }
      syncHistoricalAccountToggle(account.id);
    });
    section.append(heading, grid);
    elements.historicalScope.append(section);
    syncHistoricalAccountToggle(account.id);
  }
}

function historicalStatusLabel(status) {
  return ({
    idle: "Ready to start",
    running: "Scanning…",
    completed: "Completed",
    cancelled: "Stopped by user",
    paused: "Paused — archive unavailable",
    interrupted: "Interrupted on restart",
    failed: "Error"
  })[status] || String(status || "idle");
}

function renderHistoricalScanState(scan = state.historicalScan) {
  const current = scan || { status: "idle", processed: 0, analyzed: 0, skipped: 0, failed: 0 };
  state.historicalScan = current;
  const running = current.status === "running";
  elements.historicalProgress.dataset.status = current.status || "idle";
  setText(elements.historicalStatus, historicalStatusLabel(current.status));
  setText(elements.historicalProcessed, current.processed ?? 0);
  setText(elements.historicalAnalyzed, current.analyzed ?? 0);
  setText(elements.historicalSkipped, current.skipped ?? 0);
  setText(elements.historicalFailed, current.failed ?? 0);
  setText(elements.historicalJunkAdmitted, current.junkAdmitted ?? 0);
  setText(elements.historicalJunkNotAdmitted, current.junkNotAdmitted ?? 0);
  setText(elements.historicalCurrentFolder, current.currentFolder || "—");
  elements.historicalStartButton.disabled = running;
  elements.historicalCancelButton.disabled = !running;
  elements.historicalScanButton.dataset.status = running ? "running" : "idle";
  menuItemLabel(elements.historicalScanButton).textContent = running ? "Historical Scan · running" : "Historical Scan";

  let note = "Historical Scan has not started.";
  if (running) {
    const limit = current.limit ? ` of at most ${current.limit}` : "";
    note = `Processed ${current.processed ?? 0}${limit}. You can leave this view; the scan continues while Thunderbird is running.`;
  } else if (current.status === "completed") {
    const junkNote = (current.junkAdmitted ?? 0) || (current.junkNotAdmitted ?? 0)
      ? ` In Junk folders, ${current.junkAdmitted ?? 0} messages met the admission gate and ${current.junkNotAdmitted ?? 0} were left unanalyzed — not analyzed is not a spam verdict.`
      : "";
    note = `Done: ${current.analyzed ?? 0} newly analyzed, ${current.skipped ?? 0} already present, ${current.failed ?? 0} errors.${current.limitReached ? " The configured limit was reached." : ""}${junkNote}`;
  } else if (current.status === "cancelled") {
    note = `Scanning stopped after ${current.processed ?? 0} processed messages.`;
  } else if (current.status === "interrupted") {
    note = `The previous scan was interrupted by a Thunderbird restart after ${current.processed ?? 0} processed messages and was not resumed automatically.`;
  } else if (current.status === "failed") {
    note = `Historical Scan failed: ${current.error || "unknown error"}`;
  }
  setText(elements.historicalProgressNote, note);
}

function stopHistoricalPolling() {
  if (historicalScanTimer) clearInterval(historicalScanTimer);
  historicalScanTimer = null;
}

function startHistoricalPolling() {
  stopHistoricalPolling();
  historicalScanTimer = setInterval(async () => {
    try {
      const response = await send("getHistoricalScanState");
      renderHistoricalScanState(response.scan);
      if (response.scan?.status !== "running") {
        stopHistoricalPolling();
        await loadState(false);
      }
    } catch {
      // Temporary runtime unavailability should not close the dialog.
    }
  }, 900);
}

// Loading is separate from opening, because the panel can now be reached two ways: the
// Operations menu, and navigating straight to System → Historical Scan. The shell fires a
// show event on arrival; the guard keeps the two routes from fetching the scope twice.
let historicalPanelLoading = false;

async function loadHistoricalScanPanel() {
  if (historicalPanelLoading) return;
  historicalPanelLoading = true;
  elements.historicalScanButton.disabled = true;
  try {
    const response = await send("getHistoricalScanScope");
    state.historicalScope = Array.isArray(response.accounts) ? response.accounts : [];
    renderHistoricalScope(state.historicalScope);
    renderHistoricalScanState(response.scan);
    if (response.scan?.status === "running") startHistoricalPolling();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    historicalPanelLoading = false;
    elements.historicalScanButton.disabled = false;
  }
}

async function openHistoricalScan() {
  elements.historicalScanDialog.showModal();
  await loadHistoricalScanPanel();
}

// Mirrors the resolution the background does, so the confirmation names the same window
// the run will use. Empty dates are the last twelve months; there is no whole-mailbox
// option any more (decision r001 section 3).
const HISTORICAL_DEFAULT_WINDOW_MONTHS = 12;

function resolvedHistoricalWindow(rawFrom, rawTo) {
  const iso = (date) => date.toISOString().slice(0, 10);
  if (!rawFrom && !rawTo) {
    const to = new Date();
    const from = new Date(to.getTime());
    from.setMonth(from.getMonth() - HISTORICAL_DEFAULT_WINDOW_MONTHS);
    return { from: iso(from), to: iso(to) };
  }
  return { from: rawFrom || "the oldest message", to: rawTo || "today" };
}

async function startHistoricalScan() {
  const folderIds = historicalFolderCheckboxes().filter((box) => box.checked).map((box) => box.dataset.historicalFolderId);
  if (!folderIds.length) {
    showToast("Select at least one folder.", true);
    return;
  }
  const maxMessages = Number(elements.historicalMaxMessages.value);
  if (!Number.isFinite(maxMessages) || maxMessages < 1 || maxMessages > 20000) {
    showToast("Maximum messages must be between 1 and 20000.", true);
    return;
  }
  // The dialog states the bound it is about to run under, resolved dates included, so
  // nothing about the run is left implicit at the moment it starts.
  const window12 = resolvedHistoricalWindow(elements.historicalDateFrom.value, elements.historicalDateTo.value);
  const scopeText = `at most ${Math.trunc(maxMessages)} messages between ${window12.from} and ${window12.to}`;
  if (!window.confirm(`Start Historical Scan for ${folderIds.length} selected folders — ${scopeText}? Full message text will not be stored.`)) return;
  elements.historicalStartButton.disabled = true;
  try {
    const response = await send("startHistoricalScan", {
      config: {
        folderIds,
        dateFrom: elements.historicalDateFrom.value,
        dateTo: elements.historicalDateTo.value,
        maxMessages: Math.trunc(maxMessages),
        reanalyzeExisting: elements.historicalReanalyze.checked,
        applyTags: elements.historicalApplyTags.checked
      }
    });
    renderHistoricalScanState(response.scan);
    startHistoricalPolling();
    showToast("Historical Scan started.");
  } catch (error) {
    showToast(error.message, true);
    elements.historicalStartButton.disabled = false;
  }
}

async function cancelHistoricalScan() {
  if (!window.confirm("Stop the current Historical Scan? Existing analysis records will be kept.")) return;
  elements.historicalCancelButton.disabled = true;
  try {
    const response = await send("cancelHistoricalScan");
    renderHistoricalScanState(response.scan);
    showToast("Stop command sent.");
  } catch (error) {
    showToast(error.message, true);
  }
}

function archiveExistingStatusLabel(status) {
  return ({
    idle: "Ready to start",
    running: "Archiving…",
    completed: "Completed",
    cancelled: "Stopped by user",
    interrupted: "Interrupted on restart",
    failed: "Error"
  })[status] || String(status || "idle");
}

function renderArchiveExistingState(archive = state.archiveExisting) {
  const current = archive || {
    status: "idle", examined: 0, pdfMessages: 0, recognizedDocuments: 0,
    archived: 0, alreadyArchived: 0, skipped: 0, pending: 0, failed: 0
  };
  state.archiveExisting = current;
  const running = current.status === "running";
  elements.archiveExistingProgress.dataset.status = current.status || "idle";
  setText(elements.archiveExistingStatus, archiveExistingStatusLabel(current.status));
  setText(elements.archiveExistingExamined, current.examined ?? 0);
  setText(elements.archiveExistingPdfMessages, current.pdfMessages ?? 0);
  setText(elements.archiveExistingRecognized, current.recognizedDocuments ?? 0);
  setText(elements.archiveExistingArchived, current.archived ?? 0);
  setText(elements.archiveExistingAlready, current.alreadyArchived ?? 0);
  setText(elements.archiveExistingSkipped, current.skipped ?? 0);
  setText(elements.archiveExistingPending, current.pending ?? 0);
  setText(elements.archiveExistingFailed, current.failed ?? 0);
  setText(elements.archiveExistingCurrentFolder, current.currentFolder || "—");
  elements.archiveExistingCancelButton.disabled = !running;
  elements.archiveExistingStartButton.disabled = running;
  elements.archiveExistingStartButton.textContent = ["cancelled", "interrupted", "paused", "failed"].includes(current.status)
    ? "Continue safely"
    : current.status === "completed" ? "Scan again" : "Start archive";
  elements.archiveExistingButton.dataset.status = running ? "running" : "idle";
  menuItemLabel(elements.archiveExistingButton).textContent = running ? "Archive PDFs · running" : "Archive existing PDFs";
  elements.historicalScanButton.disabled = running;

  let note = "Existing-document archive has not started.";
  if (running) {
    const limit = current.limit ? ` of at most ${current.limit}` : "";
    note = `Examined ${current.examined ?? 0}${limit} messages. You can leave this view; archiving continues while Thunderbird is running.`;
  } else if (current.status === "completed") {
    note = `Done: ${current.archived ?? 0} newly archived, ${current.alreadyArchived ?? 0} already archived or duplicate, ${current.pending ?? 0} pending, ${current.failed ?? 0} errors.${current.limitReached ? " The configured limit was reached." : ""}`;
  } else if (current.status === "cancelled") {
    note = `Stopped after ${current.examined ?? 0} messages. Continue is safe; existing hashes prevent duplicate files.`;
  } else if (current.status === "interrupted") {
    note = `Interrupted after ${current.examined ?? 0} messages. Continue is safe; already archived documents will be skipped.`;
  } else if (current.status === "paused") {
    note = `${current.error || "The archive is unavailable."} Connect drive F: or reinstall the local host, then choose Continue safely.`;
  } else if (current.status === "failed") {
    note = `Archive scan failed: ${current.error || "unknown error"}. It can be continued after the cause is corrected.`;
  }
  setText(elements.archiveExistingNote, note);
}

function stopArchiveExistingPolling() {
  if (archiveExistingTimer) clearInterval(archiveExistingTimer);
  archiveExistingTimer = null;
}

function startArchiveExistingPolling() {
  stopArchiveExistingPolling();
  archiveExistingTimer = setInterval(async () => {
    try {
      const response = await send("getArchiveExistingState");
      renderArchiveExistingState(response.archive);
      if (response.archive?.status !== "running") {
        stopArchiveExistingPolling();
        await loadState(false);
      }
    } catch {
      // A temporary background restart must not close the progress dialog.
    }
  }, 900);
}

let archivePanelLoading = false;

async function loadArchiveExistingPanel() {
  if (archivePanelLoading) return;
  archivePanelLoading = true;
  elements.archiveExistingButton.disabled = true;
  try {
    const response = await send("getArchiveExistingScope");
    state.archiveExistingScope = response.scope || null;
    setText(
      elements.archiveExistingScope,
      `${response.scope?.folderCount ?? 0} normal folders across ${response.scope?.accountCount ?? 0} mail accounts. The folder scope is fixed; the date window and the message ceiling are set below.`
    );
    renderArchiveExistingState(response.archive);
    if (response.archive?.status === "running") startArchiveExistingPolling();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    archivePanelLoading = false;
    elements.archiveExistingButton.disabled = state.historicalScan?.status === "running";
  }
}

async function openArchiveExisting() {
  elements.archiveExistingDialog.showModal();
  await loadArchiveExistingPanel();
}

async function startArchiveExisting() {
  const scope = state.archiveExistingScope || {};
  if (!scope.folderCount) {
    showToast("No normal mail folders are available.", true);
    return;
  }
  const maxMessages = Number(elements.archiveExistingMaxMessages.value);
  if (!Number.isFinite(maxMessages) || maxMessages < 1 || maxMessages > 20000) {
    showToast("Maximum messages must be between 1 and 20000.", true);
    return;
  }
  const bounds = resolvedHistoricalWindow(
    elements.archiveExistingDateFrom.value,
    elements.archiveExistingDateTo.value
  );
  const message = `Archive recognized PDF documents from all ${scope.folderCount} normal folders in ${scope.accountCount} mail accounts — at most ${Math.trunc(maxMessages)} messages examined, between ${bounds.from} and ${bounds.to}? Trash, Junk, Sent, Drafts, Templates and Outbox are excluded. Files are stored only in F:\\01_ARCHIVE\\CIVION.`;
  if (!window.confirm(message)) return;
  elements.archiveExistingStartButton.disabled = true;
  try {
    const response = await send("startArchiveExisting", {
      config: {
        dateFrom: elements.archiveExistingDateFrom.value,
        dateTo: elements.archiveExistingDateTo.value,
        maxMessages: Math.trunc(maxMessages)
      }
    });
    renderArchiveExistingState(response.archive);
    startArchiveExistingPolling();
    showToast("Existing-document archive started.");
  } catch (error) {
    showToast(error.message, true);
    elements.archiveExistingStartButton.disabled = false;
  }
}

async function cancelArchiveExisting() {
  if (!window.confirm("Stop archiving after the current message? Documents already stored will be kept.")) return;
  elements.archiveExistingCancelButton.disabled = true;
  try {
    const response = await send("cancelArchiveExisting");
    renderArchiveExistingState(response.archive);
    showToast("Stop command sent.");
  } catch (error) {
    showToast(error.message, true);
  }
}

function openSettings() {
  elements.settingAutoTag.checked = state.settings.autoTag === true;
  elements.settingAnalyzeJunk.checked = state.settings.analyzeJunk === true;
  elements.settingDesktopBridge.checked = state.settings.desktopBridgeEnabled !== false;
  elements.settingDocumentArchive.checked = state.settings.automaticDocumentArchive !== false;
  elements.settingRetention.value = String(state.settings.retentionDays || 365);
  elements.settingMaxRecords.value = String(state.settings.maxRecords || 2000);
  elements.settingDiagnostics.checked = state.settings.diagnosticLogging === true;
  elements.settingTrustedAuthserv.value = Array.isArray(state.settings.trustedAuthservIds)
    ? state.settings.trustedAuthservIds.join(", ")
    : "";
  elements.settingsDialog.showModal();
}

async function saveSettings() {
  elements.saveSettingsButton.disabled = true;
  try {
    await send("setSettings", {
      patch: {
        autoTag: elements.settingAutoTag.checked,
        analyzeJunk: elements.settingAnalyzeJunk.checked,
        desktopBridgeEnabled: elements.settingDesktopBridge.checked,
        automaticDocumentArchive: elements.settingDocumentArchive.checked,
        retentionDays: Number(elements.settingRetention.value),
        maxRecords: Number(elements.settingMaxRecords.value),
        diagnosticLogging: elements.settingDiagnostics.checked,
        trustedAuthservIds: elements.settingTrustedAuthserv.value
      }
    });
    await loadState(false);
    elements.settingsDialog.close();
    showToast("Settings saved.");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    elements.saveSettingsButton.disabled = false;
  }
}

function exportJson() {
  const payload = {
    exportFormat: "CIVION_MAIL_JSON",
    exportVersion: 1,
    generatedAt: new Date().toISOString(),
    addonVersion: state.version,
    settings: {
      autoTag: state.settings.autoTag === true,
      analyzeJunk: state.settings.analyzeJunk === true,
      retentionDays: state.settings.retentionDays,
      maxRecords: state.settings.maxRecords
    },
    metadata: state.metadata,
    records: state.records
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `CIVION_MAIL_export_${new Date().toISOString().slice(0, 10)}.json`;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}


function exportCivionMailPackage() {
  const payload = buildCivionMailPackage(state.records, state.version);
  downloadJson(payload, `CIVION_MAIL_candidate_package_${new Date().toISOString().slice(0, 10)}.json`);
}

function diagnosticStatusLabel(status) {
  const labels = {
    pass: "PASS",
    warn: "WARNING",
    fail: "FAILED",
    unknown: "NOT RUN"
  };
  return labels[status] || String(status || "unknown").toUpperCase();
}

function yesNo(value) {
  return value ? "Yes" : "No";
}

function renderDiagnostics(report) {
  state.diagnosticReport = report || null;
  const current = report || {};
  const status = current.overallStatus || "unknown";
  elements.diagnosticsSummary.dataset.status = status;
  setText(elements.diagnosticsStatus, diagnosticStatusLabel(status));
  setText(elements.diagnosticsGenerated, current.generatedAt ? formatDateTime(current.generatedAt) : "—");

  const manifest = current.manifest || {};
  const browser = current.browserInfo || {};
  const platform = current.platformInfo || {};
  const listeners = current.listenerState || {};
  const operational = current.operational || {};
  const storage = current.storage || {};
  const compatibility = current.compatibility || {};
  const provider = current.provider || {};
  const recovery = current.recovery || {};
  const acceptance = current.acceptance || {};

  setText(elements.diagAddon, manifest.version ? `v${manifest.version} · MV${manifest.manifestVersion || "?"}` : "—");
  setText(elements.diagThunderbird, [browser.name || "Thunderbird", browser.version || "unknown"].join(" "));
  setText(elements.diagPlatform, [platform.os, platform.arch].filter(Boolean).join(" · ") || "—");
  setText(elements.diagCompatibility, compatibility.runtimeLine || "—");
  setText(elements.diagProvider, provider.id ? `${provider.label || provider.id} · local · network ${provider.networkAccess ? "enabled" : "disabled"}` : "—");
  setText(elements.diagNewMailListener, yesNo(listeners.newMail));
  setText(elements.diagMovedListener, yesNo(listeners.moved));
  setText(elements.diagDeletedListener, yesNo(listeners.deleted));
  const acceptanceLabels = {
    not_started: "NOT STARTED",
    in_progress: "IN PROGRESS",
    pass: "PASS"
  };
  setText(elements.diagAcceptanceStatus, acceptanceLabels[acceptance.status] || "—");
  setText(elements.diagAcceptanceReset, acceptance.resetAt ? formatDateTime(acceptance.resetAt) : "—");
  setText(elements.diagAcceptanceGates, `${acceptance.completedGateCount ?? 0} / ${acceptance.totalGateCount ?? 8}`);
  setText(elements.diagBackgroundActivations, operational.backgroundActivationCount ?? 0);
  setText(elements.diagFilteredFolderEvents, operational.nonInboxEligibleEventCount ?? 0);
  setText(elements.diagJunkExcluded, operational.junkExcludedEventCount ?? 0);
  setText(elements.diagJunkAnalyzed, operational.junkAnalyzedEventCount ?? 0);

  clearNode(elements.diagnosticsAuthserv);
  const authservCandidates = Array.isArray(current.authservCandidates) ? current.authservCandidates : [];
  if (!authservCandidates.length) {
    const emptyAuthserv = document.createElement("p");
    emptyAuthserv.className = "muted dim";
    emptyAuthserv.textContent = "No identifiers have been observed yet — they are collected while analyzing new messages.";
    elements.diagnosticsAuthserv.append(emptyAuthserv);
  } else {
    for (const candidate of authservCandidates.slice(0, 20)) {
      const line = document.createElement("div");
      line.className = "authserv-line";
      const idSpan = document.createElement("code");
      idSpan.textContent = candidate.id;
      const countSpan = document.createElement("span");
      countSpan.className = "muted dim";
      countSpan.textContent = `${candidate.count} messages`;
      line.append(idSpan, countSpan);
      elements.diagnosticsAuthserv.append(line);
    }
  }

  clearNode(elements.diagnosticsChecks);
  const checks = Array.isArray(current.checks) ? current.checks : [];
  if (!checks.length) {
    const empty = document.createElement("p");
    empty.className = "muted dim";
    empty.textContent = "No checks are available.";
    elements.diagnosticsChecks.append(empty);
  } else {
    for (const item of checks) {
      const row = document.createElement("div");
      row.className = `diagnostics-check diagnostics-check-${item.status || "unknown"} ${{ pass: "pass", warn: "warn", fail: "fail" }[item.status] || "skip"}`;
      const badge = document.createElement("span");
      badge.className = "diagnostics-check-badge mk";
      badge.textContent = diagnosticStatusLabel(item.status);
      const body = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = String(item.label || item.id || "Check");
      const detail = document.createElement("p");
      detail.textContent = String(item.detail || "");
      body.append(title, detail);
      row.append(badge, body);
      elements.diagnosticsChecks.append(row);
    }
  }

  clearNode(elements.diagnosticsAccountsBody);
  const accounts = Array.isArray(current.accounts) ? current.accounts : [];
  if (!accounts.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 7;
    cell.className = "muted dim";
    cell.textContent = "No accounts were found or the check was not run.";
    row.append(cell);
    elements.diagnosticsAccountsBody.append(row);
  } else {
    accounts.forEach((account, index) => {
      const row = document.createElement("tr");
      const values = [
        account.name || account.account || `Account ${index + 1}`,
        account.type || "unknown",
        account.totalFolders ?? 0,
        account.eligibleFolders ?? 0,
        account.observedNewMailEvents ?? 0,
        account.analyzedMessages ?? 0,
        account.coverageStatus === "observed" ? "Observed" : "Not observed"
      ];
      values.forEach((value, valueIndex) => {
        const cell = document.createElement("td");
        cell.textContent = String(value);
        if (valueIndex === 6) cell.className = account.coverageStatus === "observed" ? "coverage-observed" : "muted";
        row.append(cell);
      });
      elements.diagnosticsAccountsBody.append(row);
    });
  }

  setText(elements.diagNewMailEvents, operational.newMailEventCount ?? 0);
  setText(elements.diagMessagesSeen, operational.messagesSeenCount ?? 0);
  setText(elements.diagMessagesHandled, operational.messagesHandledCount ?? 0);
  setText(elements.diagAnalysisFailures, operational.analysisFailureCount ?? 0);
  setText(elements.diagMovedEvents, operational.movedEventCount ?? 0);
  setText(elements.diagDeletedEvents, operational.deletedEventCount ?? 0);
  setText(elements.diagStorageRecords, storage.recordCount ?? 0);
  setText(elements.diagStoragePressure, yesNo(storage.storagePressure));
  setText(elements.diagRecoveryEntries, recovery.entryCount ?? 0);
  setText(elements.diagMigrationStatus, storage.migration?.status || recovery.status || "clean");
}

let diagnosticsRunning = false;

async function runDiagnostics() {
  if (diagnosticsRunning) return;
  diagnosticsRunning = true;
  elements.runSelfCheckButton.disabled = true;
  try {
    const response = await send("runSelfCheck");
    renderDiagnostics(response.report);
    showToast("Diagnostic check completed.");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    diagnosticsRunning = false;
    elements.runSelfCheckButton.disabled = false;
  }
}

async function openDiagnostics() {
  if (!elements.diagnosticsDialog.open) elements.diagnosticsDialog.showModal();
  await runDiagnostics();
}

function downloadJson(payload, filename) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportRecovery() {
  if (!window.confirm("Recovery export may contain subject, sender, and old analysis values. Create a local JSON file?")) return;
  elements.exportRecoveryButton.disabled = true;
  try {
    const response = await send("getRecoverySnapshot");
    downloadJson(response.snapshot, `CIVION_MAIL_recovery_${new Date().toISOString().slice(0, 10)}.json`);
    showToast("Recovery export created locally.");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    elements.exportRecoveryButton.disabled = false;
  }
}

async function exportDiagnostics() {
  elements.exportDiagnosticsButton.disabled = true;
  try {
    const response = await send("getDiagnosticReport");
    const payload = {
      exportFormat: "CIVION_MAIL_DIAGNOSTICS",
      exportVersion: 1,
      ...response.report
    };
    downloadJson(payload, `CIVION_MAIL_diagnostics_${new Date().toISOString().slice(0, 10)}.json`);
    showToast("Diagnostic export created locally.");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    elements.exportDiagnosticsButton.disabled = false;
  }
}

async function resetAcceptanceMetrics() {
  if (!window.confirm("Reset diagnostic logs and acceptance counters? Message analyses will not be deleted.")) return;
  elements.resetAcceptanceButton.disabled = true;
  try {
    const response = await send("resetAcceptanceMetrics");
    renderDiagnostics(response.report);
    showToast("Acceptance counters reset.");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    elements.resetAcceptanceButton.disabled = false;
  }
}

function bindEvents() {
  for (const element of [elements.searchInput, elements.priorityFilter, elements.statusFilter, elements.categoryFilter, elements.relationshipFilter, elements.documentTypeFilter, elements.retentionFilter, elements.sourceFilter]) {
    element.addEventListener(element === elements.searchInput ? "input" : "change", renderRows);
  }
  elements.dateFilter.addEventListener("change", () => {
    elements.dateRangeFields.hidden = elements.dateFilter.value !== "custom";
    renderRows();
  });
  elements.dateFrom.addEventListener("change", renderRows);
  elements.dateTo.addEventListener("change", renderRows);
  for (const button of [elements.clearFiltersButton, elements.filteredClearFiltersButton]) {
    button.addEventListener("click", clearFilters);
  }
  for (const button of [elements.showAllRetainedButton, elements.filteredShowAllRetainedButton]) {
    button.addEventListener("click", showAllRetainedRecords);
  }
  for (const button of document.querySelectorAll(".sort-button")) {
    button.addEventListener("click", () => cycleSort(button.dataset.sortKey));
  }
  for (const button of [
    elements.statActiveButton, elements.statUrgentButton,
    elements.statDueSoonButton, elements.statNewButton
  ]) {
    button.addEventListener("click", () => {
      const requested = button.dataset.quick || "";
      // Pressing the active counter returns to the full view.
      setQuickFilter(requested === state.quickFilter ? "" : requested);
    });
  }
  elements.moreFiltersButton.addEventListener("click", () => {
    setAdvancedFiltersOpen(elements.advancedFilters.hidden);
  });
  elements.densityButton.addEventListener("click", () => {
    applyDensity(state.density === "compact" ? "comfortable" : "compact");
  });
  for (const menu of [elements.operationsMenu, elements.columnsMenu]) {
    // The `toggle` event is queued, so two menus opened in the same task can close each
    // other in the wrong order. Closing siblings on the summary click is deterministic.
    menu.querySelector("summary").addEventListener("click", () => closeMenus(menu));
  }
  for (const button of elements.operationsMenu.querySelectorAll(".menu-item")) {
    button.addEventListener("click", () => { elements.operationsMenu.open = false; });
  }
  document.addEventListener("pointerdown", (event) => {
    for (const menu of [elements.operationsMenu, elements.columnsMenu]) {
      if (menu.open && !menu.contains(event.target)) menu.open = false;
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenus();
  });
  initializeColumnResize();
  document.addEventListener("pointerdown", (event) => {
    if (!elements.recordContextMenu.hidden && !elements.recordContextMenu.contains(event.target)) closeRecordContextMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.recordContextMenu.hidden) closeRecordContextMenu();
  });
  window.addEventListener("resize", closeRecordContextMenu);
  window.addEventListener("scroll", closeRecordContextMenu, true);

  elements.refreshButton.addEventListener("click", async () => {
    elements.refreshButton.disabled = true;
    try {
      await loadState(false);
      showToast("Action Center refreshed.");
    } catch (error) {
      showToast(error.message, true);
    } finally {
      elements.refreshButton.disabled = false;
    }
  });

  elements.clearClosedButton.addEventListener("click", async () => {
    const count = state.records.filter((record) => CLOSED_STATUSES.has(record.status)).length;
    if (!count) {
      showToast("There are no closed records to clear.");
      return;
    }
    if (!window.confirm(`Remove ${count} closed records?`)) return;
    try {
      await send("clearClosed");
      await loadState(false);
      showToast("Closed records removed.");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  elements.exportButton.addEventListener("click", () => {
    try {
      exportJson();
      showToast("JSON export created locally.");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  elements.civionExportButton.addEventListener("click", () => {
    try {
      exportCivionMailPackage();
      showToast("CIVION candidate package created locally.");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  elements.historicalScanButton.addEventListener("click", () => { void openHistoricalScan(); });
  elements.historicalRecommendedButton.addEventListener("click", () => setHistoricalFolderSelection("recommended"));
  elements.historicalAllButton.addEventListener("click", () => setHistoricalFolderSelection("all"));
  elements.historicalNoneButton.addEventListener("click", () => setHistoricalFolderSelection("none"));
  elements.historicalStartButton.addEventListener("click", () => { void startHistoricalScan(); });
  elements.historicalCancelButton.addEventListener("click", () => { void cancelHistoricalScan(); });
  elements.historicalScanDialog.addEventListener("close", () => {
    if (state.historicalScan?.status !== "running") stopHistoricalPolling();
  });
  // Reaching a panel by navigation rather than through the Operations menu has to load
  // the same data. The shell fires "show" when a former dialog becomes visible.
  elements.historicalScanDialog.addEventListener("show", () => { void loadHistoricalScanPanel(); });
  elements.archiveExistingDialog.addEventListener("show", () => { void loadArchiveExistingPanel(); });
  elements.diagnosticsDialog.addEventListener("show", () => { void runDiagnostics(); });

  elements.archiveExistingButton.addEventListener("click", () => { void openArchiveExisting(); });
  elements.archiveExistingStartButton.addEventListener("click", () => { void startArchiveExisting(); });
  elements.archiveExistingCancelButton.addEventListener("click", () => { void cancelArchiveExisting(); });
  elements.archiveExistingDialog.addEventListener("close", () => {
    if (state.archiveExisting?.status !== "running") stopArchiveExistingPolling();
  });

  elements.diagnosticsButton.addEventListener("click", () => { void openDiagnostics(); });
  elements.runSelfCheckButton.addEventListener("click", () => { void runDiagnostics(); });
  elements.exportDiagnosticsButton.addEventListener("click", () => { void exportDiagnostics(); });
  elements.exportRecoveryButton.addEventListener("click", () => { void exportRecovery(); });
  elements.resetAcceptanceButton.addEventListener("click", () => { void resetAcceptanceMetrics(); });

  elements.settingsButton.addEventListener("click", openSettings);
  elements.saveSettingsButton.addEventListener("click", saveSettings);
  elements.saveDetailButton.addEventListener("click", saveDetail);

  elements.openOriginalButton.addEventListener("click", async () => {
    const record = selectedRecord();
    if (!record) return;
    elements.openOriginalButton.disabled = true;
    try {
      await send("openOriginal", { recordId: record.id });
    } catch (error) {
      showToast(error.message, true);
    } finally {
      elements.openOriginalButton.disabled = false;
    }
  });

  elements.deleteOriginalButton.addEventListener("click", async () => {
    const record = selectedRecord();
    if (!record) return;
    if (!window.confirm("Delete the original email? CIVION Mail will not use permanent delete; Thunderbird will apply the standard deletion behavior for this account. The analysis record will be kept.")) return;
    elements.deleteOriginalButton.disabled = true;
    try {
      await send("deleteOriginal", { recordId: record.id });
      await loadState(false);
      const updated = selectedRecord();
      if (updated) renderDetail(updated);
      showToast("The original email was deleted through Thunderbird.");
    } catch (error) {
      showToast(error.message, true);
    } finally {
      const current = selectedRecord();
      elements.deleteOriginalButton.disabled = !current || current.messageAvailable === false;
    }
  });

  elements.reanalyzeButton.addEventListener("click", async () => {
    const record = selectedRecord();
    if (!record) return;
    const replaceableFields = manualFields(record)
      .filter((field) => ["legacy", "requiredAction", "priority", "deadline", "categories"].includes(field))
      .map((field) => MANUAL_FIELD_LABELS[field] || field);
    if (record.manualEdited && !window.confirm(
      `Reanalysis will replace manually changed fields: ${replaceableFields.join(", ") || "extracted values"}. Workflow status, notes, and the incorrect-analysis flag will be preserved. Continue?`
    )) return;
    elements.reanalyzeButton.disabled = true;
    try {
      await send("reanalyze", { recordId: record.id });
      await loadState(false);
      const updated = selectedRecord();
      if (updated) renderDetail(updated);
      showToast("The analysis was updated.");
    } catch (error) {
      showToast(error.message, true);
    } finally {
      elements.reanalyzeButton.disabled = false;
    }
  });

  elements.retryArchiveButton.addEventListener("click", async () => {
    const record = selectedRecord();
    if (!record) return;
    elements.retryArchiveButton.disabled = true;
    try {
      await send("retryDocumentArchive", { recordId: record.id });
      await loadState(false);
      const updated = selectedRecord();
      if (updated) renderDetail(updated);
      showToast(updated?.documentArchive?.state === "archived"
        ? "Documents archived in F:\\01_ARCHIVE\\CIVION."
        : "Archive status updated.");
    } catch (error) {
      showToast(error.message, true);
    } finally {
      const current = selectedRecord();
      elements.retryArchiveButton.disabled = !current || current.messageAvailable === false;
    }
  });

  elements.removeRecordButton.addEventListener("click", async () => {
    const record = selectedRecord();
    if (!record) return;
    if (!window.confirm("Remove only the analysis record? The original email will not be modified.")) return;
    elements.removeRecordButton.disabled = true;
    try {
      await send("removeRecord", { recordId: record.id });
      await loadState(false);
      elements.detailDialog.close();
      showToast("Analysis removed.");
    } catch (error) {
      showToast(error.message, true);
    } finally {
      elements.removeRecordButton.disabled = false;
    }
  });

  messenger.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (!changes.mailSentinelRecords && !changes.mailSentinelSettings && !changes.mailSentinelMetadata && !changes.mailSentinelDiagnostics) return;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      void loadState(false).catch((error) => showToast(error.message, true));
    }, 120);
  });
}

async function initialize() {
  cacheElements();
  loadSortPreference();
  loadViewPreferences();
  updateSortHeaders();
  bindEvents();
  try {
    await loadState(true);
  } catch (error) {
    showToast(`CIVION Mail could not load data: ${error.message}`, true);
  }
}

void initialize();
