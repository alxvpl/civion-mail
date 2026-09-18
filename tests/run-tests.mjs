import { readFileSync } from "node:fs";
import { analyzeMessage } from "../modules/analyzer.mjs";
import { FINDING_TYPES } from "../modules/temporal-context.mjs";
import { buildCivionMailEnvelope } from "../modules/federation.mjs";
import { validateAnalysisResult } from "../modules/providers/provider-contract.mjs";
import { sourceState, recordMatchesSourceFilter, availableSourceRecords } from "../modules/source-state.mjs";
import { describeNarrowing, emptyResultText, narrowingText } from "../modules/view-filters.mjs";
import { evaluateJunkAdmission, collectPriorEvidence, ADMISSION_PATHS, MIN_PRIOR_RECORDS } from "../modules/junk-admission.mjs";
import { buildDocumentArchivePlans, DOCUMENT_ARCHIVE_ROOT } from "../modules/document-archive.mjs";
import { ARCHIVE_BACKFILL_EXCLUDED_SPECIAL_USES, isNormalArchiveFolder } from "../modules/archive-backfill.mjs";
import { deriveTrust, deriveSenderReview } from "../action-center/views-identity.mjs";
import {
  deriveJunkWatch,
  deriveUncertain,
  deriveUnreadable,
  deriveMarkedIncorrect,
  deriveRejected,
  deriveNewRules
} from "../action-center/views-review.mjs";
import { deriveDates, countDates, DATE_FILTERS } from "../action-center/views-dates.mjs";
import {
  summarise as summariseToday,
  decisionReason as decisionReasonToday,
  attentionReason as attentionReasonToday
} from "../action-center/views-today.mjs";
import {
  DISCONNECT_REASONS,
  MAIL_RUNTIME_CONTRACT_VERSION,
  MailRuntimeDisconnectedError,
  MailRuntimeProtocolError,
  MailRuntimeTimeoutError,
  classifyDisconnect,
  createCorrelationId,
  createMailRuntime,
  isValidCorrelationId,
  sanitizeDisconnectDetail
} from "../modules/mail-runtime.mjs";
import { BRIDGE_STATES, deriveBridgeState } from "../modules/bridge-state.mjs";
import { bridgeCheck } from "../modules/diagnostics.mjs";

let passed = 0;
const failures = [];
function check(name, condition, detail = "") {
  if (condition) { passed += 1; console.log(`PASS  ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

const now = new Date("2026-09-04T10:00:00Z");
const daysAgo = (n) => new Date(now.getTime() - n * 86400000);

const HISTORICAL_BODY = [
  "Geachte heer,",
  "U bent verplicht het openstaande bedrag te betalen.",
  "Betaal uiterlijk 15 januari 2026 het bedrag van EUR 240,00.",
  "Let op: betaal direct, anders volgen maatregelen."
].join("\n");

const historical = analyzeMessage({
  subject: "Aanmaning betaling",
  body: HISTORICAL_BODY,
  sender: "invordering@example.org",
  language: "nl",
  headers: {},
  attachments: [],
  referenceDate: daysAgo(300),
  currentDate: now
});

check("T1 historical deadline is classified historical_expired",
  historical.deadline?.temporalState === "historical_expired",
  `temporalState=${historical.deadline?.temporalState}`);

check("T2 historical deadline is not currently actionable",
  historical.deadline?.currentlyActionable === false,
  `currentlyActionable=${historical.deadline?.currentlyActionable}`);

check("T3 historical expired obligation never yields Critical or High priority",
  !["Critical", "High"].includes(historical.priority),
  `priority=${historical.priority}`);

// F3 regression: with a non-Low risk level the v0.6.4 guard was bypassed and a stale
// deadline produced Critical through the `daysRemaining <= 1` branch.
const historicalAtRisk = analyzeMessage({
  subject: "Aanmaning betaling",
  body: `${HISTORICAL_BODY}\nOns nieuwe rekeningnummer is NL91ABNA0417164300.`,
  sender: "invordering@example.org",
  language: "nl",
  headers: {},
  attachments: [],
  referenceDate: daysAgo(300),
  currentDate: now
});

check("T4 stale deadline yields no deadline-driven priority even at elevated risk",
  historicalAtRisk.risk?.level !== "Low"
  && historicalAtRisk.priority !== "Critical"
  && !historicalAtRisk.priorityReasons?.some((reason) => /deadline/iu.test(reason)),
  `risk=${historicalAtRisk.risk?.level} priority=${historicalAtRisk.priority}`);

const recent = analyzeMessage({
  subject: "Aanmaning betaling",
  body: HISTORICAL_BODY.replace("15 januari 2026", "20 augustus 2026"),
  sender: "invordering@example.org",
  language: "nl",
  headers: {},
  attachments: [],
  referenceDate: daysAgo(20),
  currentDate: now
});

check("T5 recent overdue obligation stays actionable",
  recent.deadline?.currentlyActionable !== false && recent.deadline?.temporalState === "recently_overdue",
  `temporalState=${recent.deadline?.temporalState}`);

check("T6 recent overdue obligation retains raised priority",
  ["Critical", "High", "Medium"].includes(recent.priority),
  `priority=${recent.priority}`);

check("T7 sourceState maps deleted and trash to missing",
  sourceState({ sourceState: "deleted" }) === "missing"
  && sourceState({ sourceState: "trash" }) === "missing"
  && sourceState({ messageAvailable: false }) === "missing"
  && sourceState({ messageAvailable: true, sourceState: "available" }) === "available");

check("T8 default source filter hides missing records, 'all' retains them",
  recordMatchesSourceFilter({ sourceState: "deleted" }, "available") === false
  && recordMatchesSourceFilter({ sourceState: "deleted" }, "missing") === true
  && recordMatchesSourceFilter({ sourceState: "deleted" }, "all") === true);

check("T9 availableSourceRecords excludes unavailable originals",
  availableSourceRecords([
    { id: 1, sourceState: "available" },
    { id: 2, sourceState: "trash" },
    { id: 3, messageAvailable: false }
  ]).length === 1);

const background = readFileSync(new URL("../background.js", import.meta.url), "utf8");

check("T10 badge counter excludes unavailable originals",
  /availableSourceRecords\(records\)\s*\n?\s*\.filter\(\(record\) => !CLOSED_STATUSES\.has\(record\.status\)/.test(background));

check("T11 external deletion refreshes the badge",
  /if \(count\) await updateActionCenterBadge\(\);\s*\n\s*await recordOperationalEvent\("deletedBatch"/.test(background));

check("T12 external move to Trash refreshes the badge",
  /if \(matchedCount\) await updateActionCenterBadge\(\);\s*\n\s*await recordOperationalEvent\("movedBatch"/.test(background));

// ---- v0.6.6: narrowed-view disclosure and split empty states ----

const defaultView = describeNarrowing({ source: "available" }, 0);
check("T14 an unfiltered view with nothing hidden is not reported as narrowed",
  defaultView.narrowed === false
  && defaultView.clearable === false
  && defaultView.canShowRetained === false);

const hidingDeleted = describeNarrowing({ source: "available" }, 4);
check("T15 the default source filter is disclosed once it actually hides records",
  hidingDeleted.narrowed === true
  && hidingDeleted.hiddenOriginals === 4
  && hidingDeleted.canShowRetained === true
  && hidingDeleted.clearable === false
  && /hiding 4/u.test(narrowingText(hidingDeleted)),
  narrowingText(hidingDeleted));

const filtered = describeNarrowing({ priority: "Critical", search: "belasting", source: "available" }, 0);
check("T16 active filters are named and clearable",
  filtered.narrowed === true
  && filtered.fieldCount === 2
  && filtered.clearable === true
  && filtered.canShowRetained === false
  && filtered.labels.includes("Priority")
  && filtered.labels.includes("Search"));

const missingOnly = describeNarrowing({ source: "missing" }, 4);
check("T17 the deleted-only view is clearable back to the default",
  missingOnly.narrowed === true && missingOnly.clearable === true && missingOnly.canShowRetained === false);

const allRetained = describeNarrowing({ source: "all" }, 4);
check("T18 showing all retained records clears the hidden-originals disclosure",
  allRetained.canShowRetained === false && allRetained.hiddenOriginals === 0 && allRetained.clearable === true);

check("T19 whitespace-only search is not treated as a filter",
  describeNarrowing({ search: "   ", source: "available" }, 0).narrowed === false);

check("T20 the filtered empty state states that records are held, not that none exist",
  /12 records are held/u.test(emptyResultText(filtered, 12))
  && /exclude all of them/u.test(emptyResultText(filtered, 12)),
  emptyResultText(filtered, 12));

const actionCenter = readFileSync(new URL("../action-center/app.js", import.meta.url), "utf8");
// The markup the manifest opens. The pre-r005 wrapper, action-center/index.html, left
// the package in 0.8.4: nothing referenced it and it would have shown neither the
// Settings hydration nor the Bridge tab. T24 and T25, which described its topbar and its
// stylesheet, went with it.
const markup = readFileSync(new URL("../action-center/index.r005.html", import.meta.url), "utf8");

check("T21 the 'ready' empty state is suppressed whenever records are held",
  /elements\.emptyState\.hidden = records\.length !== 0 \|\| holdsRecords;/u.test(actionCenter)
  && /elements\.filteredEmptyState\.hidden = records\.length !== 0 \|\| !holdsRecords;/u.test(actionCenter));

check("T22 clearing filters returns the source filter to its default rather than widening it",
  /function clearFilters\(\)[\s\S]*?elements\.sourceFilter\.value = "available";/u.test(actionCenter)
  && /function showAllRetainedRecords\(\)[\s\S]*?elements\.sourceFilter\.value = "all";/u.test(actionCenter));

check("T23 the disclosure bar announces changes to assistive technology",
  /<div aria-live="polite" class="filter-status"/u.test(markup));

// cacheElements() throws on the first missing id and takes the whole panel down with it,
// so every id it requests must exist exactly once in the markup the manifest opens —
// index.r005.html since 0.8.3, which is what T128 pins.
const liveMarkup = readFileSync(new URL("../action-center/index.r005.html", import.meta.url), "utf8");
const cacheBlock = actionCenter.slice(actionCenter.indexOf("function cacheElements()"));
const requestedIds = [...cacheBlock.slice(0, cacheBlock.indexOf("]")).matchAll(/"([A-Za-z][\w-]*)"/gu)].map((m) => m[1]);
const markupIds = [...liveMarkup.matchAll(/\sid="([^"]+)"/gu)].map((m) => m[1]);
const missingIds = requestedIds.filter((id) => !markupIds.includes(id));
const duplicateIds = markupIds.filter((id, index) => markupIds.indexOf(id) !== index);
check("T26 every element cacheElements requests exists exactly once in the markup",
  requestedIds.length > 60 && missingIds.length === 0 && duplicateIds.length === 0,
  `requested=${requestedIds.length} missing=${missingIds.join(",")} duplicate=${duplicateIds.join(",")}`);

// ---- v0.6.7: junk admission gate (decision r002 section 3) ----

const JUNK = new Set(["junk-1"]);
const verifiedPrior = (id, folderId = "inbox-1") => ({ id, folderId, authenticationVerdict: "verified" });
const unverifiedPrior = (id, folderId = "inbox-1") => ({ id, folderId, authenticationVerdict: "none" });

check("T28 Path A admits an authenticated protected identity",
  (() => {
    const r = evaluateJunkAdmission({ signals: { domain: "belastingdienst.nl", verifiedIdentity: true } });
    return r.admitted === true && r.path === ADMISSION_PATHS.registryIdentity;
  })());

check("T29 a blocked domain is barred before either path",
  (() => {
    const r = evaluateJunkAdmission({
      signals: { domain: "cjib.nl", verifiedIdentity: true, userBlockedDomain: true }
    });
    return r.admitted === false && r.path === null;
  })());

check("T30 an undeterminable sender domain fails closed",
  evaluateJunkAdmission({ signals: { domain: "", verifiedIdentity: true } }).admitted === false);

check("T31 Path B admits on two non-junk priors with one verified",
  (() => {
    const r = evaluateJunkAdmission({
      signals: { domain: "denhaag.nl", authenticationVerdict: "verified" },
      priorRecords: [verifiedPrior("a"), unverifiedPrior("b")],
      junkFolderIds: JUNK
    });
    return r.admitted === true && r.path === ADMISSION_PATHS.provenHistory;
  })());

check("T32 Path B requires the evaluated message to pass authentication itself",
  evaluateJunkAdmission({
    signals: { domain: "denhaag.nl", authenticationVerdict: "none" },
    priorRecords: [verifiedPrior("a"), verifiedPrior("b")],
    junkFolderIds: JUNK
  }).admitted === false);

check(`T33 Path B requires at least ${MIN_PRIOR_RECORDS} qualifying priors`,
  evaluateJunkAdmission({
    signals: { domain: "denhaag.nl", authenticationVerdict: "verified" },
    priorRecords: [verifiedPrior("a")],
    junkFolderIds: JUNK
  }).admitted === false);

check("T34 Path B requires at least one prior to have passed authentication",
  evaluateJunkAdmission({
    signals: { domain: "denhaag.nl", authenticationVerdict: "verified" },
    priorRecords: [unverifiedPrior("a"), unverifiedPrior("b")],
    junkFolderIds: JUNK
  }).admitted === false);

// The load-bearing condition: spam that once reached the Inbox must not open its own gate.
check("T35 priors sitting in a junk folder are not evidence",
  evaluateJunkAdmission({
    signals: { domain: "spam.example", authenticationVerdict: "verified" },
    priorRecords: [verifiedPrior("a", "junk-1"), verifiedPrior("b", "junk-1")],
    junkFolderIds: JUNK
  }).admitted === false);

check("T36 a blocked record anywhere in the domain history bars the domain",
  evaluateJunkAdmission({
    signals: { domain: "denhaag.nl", authenticationVerdict: "verified" },
    priorRecords: [verifiedPrior("a"), verifiedPrior("b"), { id: "c", folderId: "inbox-1", risk: { hardBlock: true } }],
    junkFolderIds: JUNK
  }).admitted === false);

check("T37 a prior with no resolvable folder is not counted",
  (() => {
    const evidence = collectPriorEvidence([
      verifiedPrior("a"), { id: "b", authenticationVerdict: "verified" }
    ], JUNK);
    return evidence.qualifyingCount === 1;
  })());

check("T38 refusal carries reasons and never a spam verdict",
  (() => {
    const r = evaluateJunkAdmission({
      signals: { domain: "denhaag.nl", authenticationVerdict: "verified" },
      priorRecords: [], junkFolderIds: JUNK
    });
    return r.admitted === false
      && r.reasons.length > 0
      && !r.reasons.some((reason) => /spam|junk mail|illegit/iu.test(reason));
  })());

const bg = readFileSync(new URL("../background.js", import.meta.url), "utf8");

check("T39 the gate runs before analysis and storage in the scan loop",
  bg.indexOf("evaluateJunkMessage(message, job)") < bg.indexOf("const record = await processMessage(message.folder || null, message, {")
  && /if \(!admission\.admitted\) \{[\s\S]*?job\.junkNotAdmitted \+= 1;[\s\S]*?continue;/u.test(bg));

// The declaration moved out of the if-block when the admission result started travelling
// onto the record, so the pattern is written against the assignment rather than the
// declaration. What it guards is unchanged: both junk paths start at not-admitted, and a
// gate that throws is logged and leaves that default standing.
check("T40 an unevaluable gate fails closed rather than admitting",
  (bg.match(/admission = \{ admitted: false, reasons: \["The admission gate could not be evaluated\."\] \};/gu) || []).length === 2
  && (bg.match(/let admission = null;/gu) || []).length === 2
  && /JUNK_ADMISSION_EVALUATION_FAILED/u.test(bg)
  && !/catch[\s\S]{0,200}admitted: true/u.test(bg));

check("T41 Path B evidence excludes junk folders across the whole account tree",
  /allJunkFolderIds:/u.test(bg) && /job\.config\.allJunkFolderIds/u.test(bg));

check("T42 the gate reads headers only and does not run message analysis",
  (() => {
    const fn = bg.slice(bg.indexOf("async function evaluateJunkMessage"), bg.indexOf("function senderDomainOf"));
    return /getFull\(message\.id, \{ decodeHeaders: true \}\)/u.test(fn)
      && !/analyzeMessage\(/u.test(fn)
      && !/extractMessageData\(/u.test(fn);
  })());

check("T43 the scan reports non-admission without calling it a spam verdict",
  /not analyzed is not a spam verdict/u.test(actionCenter));

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
check("T44 manifest version and extension identity are intact",
  manifest.version === "0.8.4"
  && manifest.browser_specific_settings.gecko.id === "mail-sentinel@local.invalid"
  && !("host_permissions" in manifest),
  `version=${manifest.version}`);

// ---- v0.6.8: automatic local document archive ----

const shopInvoice = analyzeMessage({
  subject: "Your invoice INV-42",
  body: "Thank you for your order.",
  sender: "Example Shop <billing@example-shop.nl>",
  language: "en",
  headers: { "list-unsubscribe": ["<mailto:unsubscribe@example-shop.nl>"] },
  attachments: [{ name: "invoice-INV-42.pdf", contentType: "application/pdf", size: 1024, partName: "1.2" }],
  referenceDate: now,
  currentDate: now
});
check("T45 an explicit shop invoice is not downgraded to marketing",
  shopInvoice.documentType === "Invoice", `documentType=${shopInvoice.documentType}`);

const invoicePlans = buildDocumentArchivePlans(shopInvoice, [
  { name: "invoice-INV-42.pdf", contentType: "application/pdf", size: 1024, partName: "1.2" }
]);
check("T46 a shop invoice receives the approved purchases path",
  invoicePlans.length === 1
  && invoicePlans[0].relativePath.startsWith("02_PURCHASES/Example Shop/2026/Invoices/")
  && invoicePlans[0].relativePath.endsWith(".pdf"),
  invoicePlans[0]?.relativePath || "no plan");

const officialPlans = buildDocumentArchivePlans({
  ...shopInvoice,
  subject: "Beschikking 2026-17",
  relationshipClass: "Government & Public Administration",
  relationship: { confidence: 0.98 },
  categories: ["Official"],
  documentType: "Decision",
  documentClassification: { type: "Decision", confidence: 0.88 },
  risk: { level: "Low", hardBlock: false }
}, [{ name: "besluit-2026-17.pdf", contentType: "application/pdf", size: 2048, partName: "1.3" }]);
check("T47 an official decision receives the approved official path",
  officialPlans[0]?.relativePath.startsWith("04_OFFICIAL/Example Shop/2026/Decisions/"),
  officialPlans[0]?.relativePath || "no plan");

check("T48 high-risk mail is never automatically archived",
  buildDocumentArchivePlans({ ...shopInvoice, risk: { level: "High", hardBlock: true } }, [
    { name: "invoice.pdf", contentType: "application/pdf", partName: "1.2" }
  ]).length === 0);

check("T49 archive transport uses Native Messaging and no Downloads fallback",
  /sendNativePackage\(DOCUMENT_ARCHIVE_CONTRACT/u.test(bg)
  && /messages\.getAttachmentFile/u.test(bg)
  && /ARCHIVE_ROOT_UNAVAILABLE/u.test(bg)
  && !/downloadArchivedFile|downloads\.download[\s\S]{0,500}DOCUMENT_ARCHIVE/u.test(bg)
  && DOCUMENT_ARCHIVE_ROOT === "F:\\01_ARCHIVE\\CIVION");

check("T50 archive status and manual retry are visible",
  /id="detailArchive"/u.test(markup)
  && /id="retryArchiveButton"/u.test(markup)
  && /id="settingDocumentArchive"/u.test(markup)
  && /retryDocumentArchive/u.test(actionCenter));

check("T51 uncertain sender relationships route to review",
  buildDocumentArchivePlans({
    ...shopInvoice,
    relationshipClass: "Unknown / Review",
    relationship: { confidence: 0.35 },
    risk: { level: "Low", hardBlock: false }
  }, [{ name: "invoice-INV-42.pdf", contentType: "application/pdf", partName: "1.2" }])
    [0]?.relativePath.startsWith("90_REVIEW/"));

check("T52 manual archive remains available when automation is disabled",
  /archiveRecordDocuments\(record, message, null, \{ force: true, verifyExisting: true \}\)/u.test(bg)
  && /\(!options\.force && settings\.automaticDocumentArchive === false\)/u.test(bg));

check("T53 partial archive records are eligible for automatic retry",
  /\["pending", "partial"\]\.includes\(record\.documentArchive\?\.state\)/u.test(bg)
  && /\["pending", "partial"\]\.includes\(refreshed\?\.documentArchive\?\.state\)/u.test(bg));

check("T54 archive backfill excludes every non-normal system folder",
  ["Trash", "JUNK", "sent", "Drafts", "templates", "outbox"].every((specialUse) =>
    !isNormalArchiveFolder({ id: specialUse, specialUse: [specialUse] }))
  && ARCHIVE_BACKFILL_EXCLUDED_SPECIAL_USES.length === 6);

check("T55 archive backfill includes ordinary and archive folders but not virtual folders",
  isNormalArchiveFolder({ id: "inbox", specialUse: ["inbox"] })
  && isNormalArchiveFolder({ id: "archive", specialUse: ["archives"] })
  && !isNormalArchiveFolder({ id: "unified", isUnified: true, specialUse: [] })
  && !isNormalArchiveFolder({ id: "virtual", isVirtual: true, specialUse: [] }));

const archiveBatch = bg.slice(bg.indexOf("async function processArchiveExistingBatch"), bg.indexOf("async function runArchiveExisting"));
check("T56 bulk archive filters for PDF attachments before full message analysis",
  archiveBatch.indexOf("messages.listAttachments") < archiveBatch.indexOf("processMessage(message.folder")
  && /if \(!pdfAttachments\.length\)/u.test(archiveBatch));

check("T57 bulk archive bypasses the live automatic setting only for its explicit command",
  /force: true,[\s\S]*?verifyExisting: true/u.test(archiveBatch)
  && /archiveDocuments: false/u.test(archiveBatch));

// The folder scope is still fixed to recommended normal folders and the interface still
// says so. What changed with decision r001 section 3 is the rest of it: the run now
// carries a date window and a count ceiling, so the text no longer claims neither.
check("T58 all-account scope is fixed to recommended normal folders, and the run is bounded",
  /accounts\.flatMap\(\(account\) => account\.folders[\s\S]*?\.filter\(\(folder\) => folder\.recommended\)/u.test(bg)
  && /The folder scope is fixed; the date window and the message ceiling are set below\./u.test(actionCenter));

check("T59 bulk archive supports stop and safe continuation after interruption",
  /cancelArchiveExisting/u.test(bg)
  && /reconcileInterruptedArchiveExistingState/u.test(bg)
  && /Continue is safe because SHA-256 deduplication prevents duplicate files/u.test(bg)
  && /Continue safely/u.test(actionCenter));

check("T60 Historical Scan and bulk archive cannot run concurrently",
  /Stop Historical Scan before starting the document archive/u.test(bg)
  && /Stop the existing-document archive before starting Historical Scan/u.test(bg));

check("T61 bulk archive scope and progress are visible in Action Center",
  /id="archiveExistingButton"/u.test(markup)
  && /id="archiveExistingDialog"/u.test(markup)
  && /id="archiveExistingExamined"/u.test(markup)
  && /id="archiveExistingArchived"/u.test(markup)
  && /id="archiveExistingPending"/u.test(markup));

check("T62 explicit archive passes revalidate already-indexed files through the host",
  /!options\.verifyExisting[\s\S]*?prior\?\.sha256 === digest/u.test(bg)
  && /verifyExisting: true/u.test(archiveBatch));

check("T63 an unavailable drive or host pauses the bulk pass at the first affected document",
  /\["ARCHIVE_ROOT_UNAVAILABLE", "ARCHIVE_HOST_UNAVAILABLE"\]\.includes\(file\.errorCode\)/u.test(archiveBatch)
  && /job\.pauseReason = file\.errorCode/u.test(archiveBatch)
  && /job\.status = job\.pauseReason \? "paused"/u.test(bg)
  && /Connect drive F: or reinstall the local host, then choose Continue safely/u.test(actionCenter));

// ---- v0.7.0: persistent CIVION Mail Runtime — behaviour, not source text ----
//
// These drive modules/mail-runtime.mjs through a fake native port and manual
// timers. Each one is a property whose absence would be silent in production:
// a wrong pairing reports the wrong package as spooled, a lost package looks
// like a quiet day.

function fakePort() {
  const listeners = { message: [], disconnect: [] };
  return {
    posted: [],
    disconnected: false,
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
    onDisconnect: { addListener: (fn) => listeners.disconnect.push(fn) },
    postMessage(message) { this.posted.push(message); },
    disconnect() { this.disconnected = true; },
    answer(message) { for (const fn of listeners.message) fn(message); },
    // Thunderbird hands the port to the listener with `error` set when the connection
    // ended in error and null when the host just closed its end.
    drop(error = null) { this.error = error; for (const fn of listeners.disconnect) fn(this); }
  };
}

function fakeTimers() {
  let next = 0;
  const timers = new Map();
  return {
    set: (fn) => { next += 1; timers.set(next, fn); return next; },
    clear: (id) => { timers.delete(id); },
    fire(id) { const fn = timers.get(id); timers.delete(id); if (fn) fn(); },
    fireAll() { for (const id of [...timers.keys()]) this.fire(id); },
    size: () => timers.size
  };
}

function harness({ connect } = {}) {
  const ports = [];
  const timers = fakeTimers();
  const events = [];
  let counter = 0;
  const runtime = createMailRuntime({
    connect: connect || (() => { const port = fakePort(); ports.push(port); return port; }),
    timeoutMs: 1000,
    onEvent: (event) => events.push(event),
    newId: () => `civion-test-${++counter}`,
    setTimer: timers.set,
    clearTimer: timers.clear
  });
  return { runtime, ports, timers, events, last: () => ports[ports.length - 1] };
}

const envelopeOf = (index) => ({
  contract: "CIVION_DESKTOP_MAIL_NATIVE",
  filename: `pkg-${index}.json`,
  packageJson: `{"n":${index}}`,
  packageSha256: "a".repeat(64)
});

async function settled(promise) {
  try { return { ok: true, value: await promise }; }
  catch (error) { return { ok: false, error }; }
}

{
  const h = harness();
  h.runtime.ensureOpen();
  h.runtime.ensureOpen();
  check("T64 the runtime opens one native session and reuses it",
    h.ports.length === 1 && h.runtime.isOpen(), `ports=${h.ports.length}`);
}

{
  const h = harness();
  const first = h.runtime.send(envelopeOf(1));
  const second = h.runtime.send(envelopeOf(2));
  const third = h.runtime.send(envelopeOf(3));
  const port = h.last();
  check("T65 every request carries a correlation id and contract version 2",
    port.posted.length === 3
    && port.posted.every((m) => isValidCorrelationId(m.message_id) && m.contract_version === MAIL_RUNTIME_CONTRACT_VERSION)
    && new Set(port.posted.map((m) => m.message_id)).size === 3,
    JSON.stringify(port.posted.map((m) => [m.message_id, m.contract_version])));
  // Answer out of order; each answer must land on its own package.
  port.answer({ ok: true, state: "spooled", message_id: port.posted[2].message_id, tag: "third" });
  port.answer({ ok: true, state: "spooled", message_id: port.posted[0].message_id, tag: "first" });
  port.answer({ ok: true, state: "already_spooled", message_id: port.posted[1].message_id, tag: "second" });
  const results = await Promise.all([first, second, third]);
  check("T66 many packages travel over one session and each answer reaches its own package",
    h.ports.length === 1
    && results[0].tag === "first" && results[1].tag === "second" && results[2].tag === "third"
    && results[1].state === "already_spooled" && h.runtime.pendingCount() === 0,
    JSON.stringify(results.map((r) => r.tag)));
}

{
  const h = harness();
  const pendingA = settled(h.runtime.send(envelopeOf(1)));
  const pendingB = settled(h.runtime.send(envelopeOf(2)));
  h.last().answer({ ok: true, state: "spooled" });
  const [a, b] = await Promise.all([pendingA, pendingB]);
  check("T67 an acknowledgement with no correlation id is a protocol error, never attributed to a pending package",
    !a.ok && !b.ok
    && a.error instanceof MailRuntimeProtocolError && b.error instanceof MailRuntimeProtocolError
    && !h.runtime.isOpen() && h.last().disconnected
    && h.events.some((e) => e.type === "protocol-error" && e.messageId === null),
    `${a.error?.name} ${b.error?.name} open=${h.runtime.isOpen()}`);
}

{
  const h = harness();
  const pending = settled(h.runtime.send(envelopeOf(1)));
  h.last().answer({ ok: true, state: "spooled", message_id: "civion-nobody-asked" });
  const result = await pending;
  check("T68 an acknowledgement for an unknown correlation id is a protocol error and fails the session",
    !result.ok && result.error instanceof MailRuntimeProtocolError && !h.runtime.isOpen()
    && h.events.some((e) => e.type === "protocol-error" && e.messageId === "civion-nobody-asked"),
    `${result.error?.name} open=${h.runtime.isOpen()}`);
}

{
  const h = harness();
  const pending = settled(h.runtime.send(envelopeOf(1)));
  h.last().drop();
  const result = await pending;
  check("T69 an unexpected host disconnect fails the outstanding package legibly and leaves the runtime OFF",
    !result.ok && result.error instanceof MailRuntimeDisconnectedError
    && !h.runtime.isOpen() && h.runtime.pendingCount() === 0
    && h.events.some((e) => e.type === "disconnected"),
    `${result.error?.name} open=${h.runtime.isOpen()}`);

  // Lazy recovery: the next outgoing package opens a new native session and is
  // delivered there. The disconnected package was reported, not retried.
  const next = h.runtime.send(envelopeOf(2));
  const fresh = h.last();
  check("T70 after a disconnect the next package opens a new session and is delivered there, not lost",
    h.ports.length === 2 && fresh !== h.ports[0]
    && fresh.posted.length === 1 && fresh.posted[0].filename === "pkg-2.json"
    && h.ports[0].posted.length === 1,
    `ports=${h.ports.length} posted=${fresh.posted.length}`);
  fresh.answer({ ok: true, state: "spooled", message_id: fresh.posted[0].message_id });
  const delivered = await next;
  check("T71 the package sent over the recovered session is acknowledged normally",
    delivered.state === "spooled" && h.runtime.isOpen() && h.runtime.pendingCount() === 0);
}

{
  const h = harness();
  const slow = settled(h.runtime.send(envelopeOf(1)));
  const port = h.last();
  const slowId = port.posted[0].message_id;
  h.timers.fireAll();
  const timedOut = await slow;
  // A late answer to a package that already timed out is expected: dropped, logged, not a protocol error.
  port.answer({ ok: true, state: "spooled", message_id: slowId });
  const later = h.runtime.send(envelopeOf(2));
  port.answer({ ok: true, state: "spooled", message_id: port.posted[1].message_id });
  const laterResult = await later;
  check("T72 an unacknowledged package times out, and a late answer for it is dropped without failing the session",
    !timedOut.ok && timedOut.error instanceof MailRuntimeTimeoutError
    && h.events.some((e) => e.type === "timeout" && e.messageId === slowId)
    && h.events.some((e) => e.type === "late-acknowledgement" && e.messageId === slowId)
    && !h.events.some((e) => e.type === "protocol-error")
    && laterResult.state === "spooled" && h.runtime.isOpen(),
    `${timedOut.error?.name} events=${h.events.map((e) => e.type).join(",")}`);
}

{
  const h = harness({ connect: () => { throw new Error("Thunderbird Native Messaging is unavailable"); } });
  let opened = true;
  try { h.runtime.ensureOpen(); } catch (error) { opened = false; }
  const result = await settled(Promise.resolve().then(() => h.runtime.send(envelopeOf(1))));
  check("T73 an unavailable native port fails the package and leaves the runtime OFF rather than pretending",
    !opened && !result.ok && !h.runtime.isOpen());
}

{
  // A port can throw synchronously on the way out — Thunderbird tearing the
  // connection down between the check and the call. Every request on that
  // port is finished, not just the one that noticed.
  const h = harness();
  const first = settled(h.runtime.send(envelopeOf(1)));
  const second = settled(h.runtime.send(envelopeOf(2)));
  const port = h.last();
  port.postMessage = () => { throw new Error("Attempt to postMessage on disconnected port"); };
  const third = settled(h.runtime.send(envelopeOf(3)));
  const [a, b, c] = await Promise.all([first, second, third]);
  check("T76 a port that throws on send fails the whole session, not one package",
    !a.ok && !b.ok && !c.ok
    && [a, b, c].every((r) => r.error instanceof MailRuntimeDisconnectedError)
    && h.runtime.pendingCount() === 0
    && !h.runtime.isOpen()
    && port.disconnected
    && h.events.some((e) => e.type === "send-failed"),
    `${a.error?.name}/${b.error?.name}/${c.error?.name} open=${h.runtime.isOpen()} pending=${h.runtime.pendingCount()}`);

  // Nothing is left waiting for an answer that cannot come.
  check("T77 a failed session leaves no timers behind",
    h.timers.size() === 0, `timers=${h.timers.size()}`);

  // And the next package opens a fresh port rather than posting into the
  // dead one.
  const next = h.runtime.send(envelopeOf(4));
  const fresh = h.last();
  fresh.answer({ ok: true, state: "spooled", message_id: fresh.posted[0].message_id });
  const delivered = await next;
  check("T78 the next send opens a fresh native port",
    h.ports.length === 2 && fresh !== port && delivered.state === "spooled" && h.runtime.isOpen(),
    `ports=${h.ports.length}`);
}

check("T74 correlation ids always satisfy the host's validation rule",
  isValidCorrelationId(createCorrelationId("3f2c1a0e-9b7d-4c5e-8a1f-123456789abc"))
  && isValidCorrelationId(createCorrelationId(undefined))
  && isValidCorrelationId(createCorrelationId("with spaces/and/slashes — and dashes"))
  && createCorrelationId("x".repeat(200)).length <= 64
  && !isValidCorrelationId("has space") && !isValidCorrelationId("") && !isValidCorrelationId(42));

check("T75 background.js speaks only through the runtime module",
  /import \{ createMailRuntime \} from "\.\/modules\/mail-runtime\.mjs"/u.test(bg)
  && /connectNative\(DESKTOP_NATIVE_HOST\)/u.test(bg)
  && !/sendNativeMessage/u.test(bg)
  && /ensureCivionMailRuntime\(\)/u.test(bg.slice(bg.indexOf("async function initialize()"))));


// ---------------------------------------------------------------------------
// CIVION Mail 0.8.0 — typed date and obligation semantics.
// A parsable date is not an obligation: the administrative role of a date is
// proven in the clause it stands in, and only a proven obligation may occupy the
// Deadline category. Local-time construction keeps the reference day identical
// in every timezone.

const TD_REFERENCE = new Date(2026, 8, 7);
const TD_TOMORROW = "2026-09-08";

function td(body, overrides = {}) {
  return analyzeMessage({
    subject: "",
    body,
    sender: "Service Desk <info@example.com>",
    language: "en",
    headers: {},
    attachments: [],
    links: [],
    referenceDate: TD_REFERENCE,
    currentDate: TD_REFERENCE,
    ...overrides
  });
}

const tdFindings = (result, type) => (result.typedFindings || []).filter((item) => item.type === type);
const tdFirst = (result, type) => tdFindings(result, type)[0] || null;

// No deadline anywhere it could leak: the slot, the candidates, the category and
// the obligation.
const tdNoDeadline = (result) => result.deadline === null
  && result.deadlineCandidates.length === 0
  && !result.categories.includes("Deadline")
  && result.obligation.deadline === null;

// Evidence must be a verbatim span of the source, never generated prose.
const tdEvidenceFromSource = (finding, body) => typeof finding?.evidence === "string"
  && finding.evidence.length > 0
  && String(body).replace(/\s+/gu, " ").trim().includes(finding.evidence.replace(/…$/u, ""));

const TD_PAY_BY = "Please pay EUR 83.17 by 31 January 2027.";
const tdPayBy = td(TD_PAY_BY);
check("T79 a payment instruction with a due-by marker is a real deadline",
  tdPayBy.deadline?.date === "2027-01-31"
  && tdPayBy.deadline.role === "deadline"
  && tdPayBy.deadline.actionRequired === true
  && tdPayBy.categories.includes("Deadline")
  && tdPayBy.categories.includes("Payment")
  && tdPayBy.obligation.deadline === "2027-01-31",
  `deadline=${tdPayBy.deadline?.date} role=${tdPayBy.deadline?.role}`);

check("T80 the same message carries typed deadline and payment findings backed by source evidence",
  tdFirst(tdPayBy, "deadline")?.date === "2027-01-31"
  && tdFirst(tdPayBy, "payment")?.actionRequired === true
  && tdFirst(tdPayBy, "payment")?.amount?.value === 83.17
  && tdEvidenceFromSource(tdFirst(tdPayBy, "deadline"), TD_PAY_BY),
  `typed=${(tdPayBy.typedFindings || []).map((f) => f.type).join(",")}`);

const tdReceived = td("Your objection must be received no later than 14 September 2026.");
check("T81 an explicit 'no later than' marker is a real deadline",
  tdReceived.deadline?.date === "2026-09-14" && tdReceived.categories.includes("Deadline"),
  `deadline=${tdReceived.deadline?.date}`);

const tdNl = td("Betaal uiterlijk 31 januari 2027 het bedrag van EUR 83,17.", { language: "nl" });
check("T82 a Dutch imperative payment instruction is payment plus a real deadline",
  tdNl.deadline?.date === "2027-01-31"
  && tdNl.financialChange === true
  && tdNl.categories.includes("Payment")
  && tdFirst(tdNl, "deadline") !== null,
  `deadline=${tdNl.deadline?.date} payment=${tdNl.financialChange}`);

const tdBg = td("Моля, платете сумата до 31 януари 2027 г.", { language: "bg" });
check("T83 a Bulgarian payment instruction with 'до' is payment plus a real deadline",
  tdBg.deadline?.date === "2027-01-31"
  && tdBg.financialChange === true
  && tdBg.action.detected === true,
  `deadline=${tdBg.deadline?.date}`);

const tdBgDefinite = td("Крайният срок за подаване е 14 септември 2026 г.", { language: "bg" });
check("T84 the definite Bulgarian deadline marker is recognised",
  tdBgDefinite.deadline?.date === "2026-09-14" && tdBgDefinite.categories.includes("Deadline"),
  `deadline=${tdBgDefinite.deadline?.date}`);

const tdDe = td("Bitte bezahlen Sie den offenen Betrag bis zum 31. Januar 2027.", { language: "de" });
check("T85 German 'bis zum <Datum>' with a payment instruction does not regress",
  tdDe.deadline?.date === "2027-01-31" && tdDe.financialChange === true,
  `deadline=${tdDe.deadline?.date}`);

const TD_APPOINTMENT = "Your appointment is on 5 March 2027 at 10:00.";
const tdAppointment = td(TD_APPOINTMENT);
check("T86 an appointment date is not a deadline",
  tdNoDeadline(tdAppointment) && tdAppointment.obligation.actionRequired === false,
  `deadline=${tdAppointment.deadline?.date} categories=${tdAppointment.categories.join("/")}`);

check("T87 an appointment date is reported as a typed appointment finding",
  tdFirst(tdAppointment, "appointment")?.date === "2027-03-05"
  && tdFirst(tdAppointment, "appointment")?.actionRequired === false
  && tdFirst(tdAppointment, "appointment")?.temporalRole === "appointment_date"
  && tdEvidenceFromSource(tdFirst(tdAppointment, "appointment"), TD_APPOINTMENT)
  && tdFindings(tdAppointment, "deadline").length === 0,
  `typed=${(tdAppointment.typedFindings || []).map((f) => `${f.type}@${f.date}`).join(",")}`);

const tdAppointmentPlusText = td("Your appointment is on 5 March 2027. Please bring your ID.");
check("T88 an unrelated instruction never converts an appointment date into a deadline",
  tdNoDeadline(tdAppointmentPlusText)
  && tdFirst(tdAppointmentPlusText, "appointment")?.date === "2027-03-05",
  `deadline=${tdAppointmentPlusText.deadline?.date}`);

const tdAppointmentPlusAction = td("Your appointment is on 5 March 2027. Please confirm your attendance.");
check("T89 a detected action in another sentence never promotes the appointment date",
  tdAppointmentPlusAction.action.detected === true
  && tdNoDeadline(tdAppointmentPlusAction)
  && tdFirst(tdAppointmentPlusAction, "appointment")?.date === "2027-03-05"
  && tdFindings(tdAppointmentPlusAction, "deadline").length === 0,
  `action=${tdAppointmentPlusAction.action.detected} deadline=${tdAppointmentPlusAction.deadline?.date}`);

const tdAppointmentNl = td("Uw afspraak is op 5 maart 2027 om 10:00 uur.", { language: "nl" });
check("T90 a Dutch appointment date is not a deadline",
  tdNoDeadline(tdAppointmentNl) && tdFirst(tdAppointmentNl, "appointment")?.date === "2027-03-05",
  `deadline=${tdAppointmentNl.deadline?.date}`);

const tdAppointmentBg = td("Вашият час е насрочен за 5 март 2027 г.", { language: "bg" });
check("T91 a Bulgarian appointment date is not a deadline",
  tdNoDeadline(tdAppointmentBg) && tdFirst(tdAppointmentBg, "appointment")?.date === "2027-03-05",
  `deadline=${tdAppointmentBg.deadline?.date}`);

const tdAvailable = td("The service will be available from tomorrow.");
check("T92 an availability date is information, not a deadline",
  tdNoDeadline(tdAvailable)
  && tdFirst(tdAvailable, "information")?.date === TD_TOMORROW
  && tdFirst(tdAvailable, "information")?.actionRequired === false,
  `typed=${(tdAvailable.typedFindings || []).map((f) => f.type).join(",")}`);

const tdValidUntil = td("The policy is valid until 31 December 2027.");
check("T93 a validity end date is an informational temporal fact, not a deadline",
  tdNoDeadline(tdValidUntil)
  && tdValidUntil.obligation.actionRequired === false
  && tdFirst(tdValidUntil, "information")?.date === "2027-12-31",
  `deadline=${tdValidUntil.deadline?.date}`);

const tdValidityWithPayment = td("Your invoice is valid until 31 December 2027, please pay the outstanding balance.");
check("T94 a validity date survives a payment instruction elsewhere in the same sentence",
  tdNoDeadline(tdValidityWithPayment)
  && tdFirst(tdValidityWithPayment, "information")?.date === "2027-12-31",
  `deadline=${tdValidityWithPayment.deadline?.date}`);

const tdDelivery = td("Your package will be delivered on 12 March 2027.");
check("T95 a delivery date is not a deadline",
  tdNoDeadline(tdDelivery)
  && tdFirst(tdDelivery, "delivery")?.date === "2027-03-12"
  && tdFirst(tdDelivery, "delivery")?.actionRequired === false,
  `typed=${(tdDelivery.typedFindings || []).map((f) => f.type).join(",")}`);

const tdRenewal = td("Your subscription renews on 1 April 2027.");
check("T96 a renewal effective date is not a deadline",
  tdNoDeadline(tdRenewal)
  && tdFirst(tdRenewal, "renewal")?.date === "2027-04-01"
  && tdFirst(tdRenewal, "renewal")?.temporalRole === "renewal_effective_date",
  `typed=${(tdRenewal.typedFindings || []).map((f) => f.type).join(",")}`);

const tdCancelBeforeRenewal = td("Cancel before 1 April 2027 to prevent renewal.");
check("T97 a cancellation instruction before renewal is a cancellation window, not a renewal date",
  tdFirst(tdCancelBeforeRenewal, "cancellation_window")?.date === "2027-04-01"
  && tdFindings(tdCancelBeforeRenewal, "renewal").length === 0,
  `typed=${(tdCancelBeforeRenewal.typedFindings || []).map((f) => f.type).join(",")}`);

const TD_MAY_CANCEL = "You may cancel until 16 May 2027.";
const tdMayCancel = td(TD_MAY_CANCEL);
check("T98 'you may cancel until <date>' keeps the date as an optional window",
  tdFirst(tdMayCancel, "cancellation_window")?.date === "2027-05-16"
  && tdFirst(tdMayCancel, "cancellation_window")?.actionRequired === false
  && tdMayCancel.deadline?.role === "cancellation_window"
  && tdMayCancel.obligation.optionalDeadline === "2027-05-16"
  && tdEvidenceFromSource(tdFirst(tdMayCancel, "cancellation_window"), TD_MAY_CANCEL),
  `role=${tdMayCancel.deadline?.role} optional=${tdMayCancel.obligation.optionalDeadline}`);

check("T99 an optional cancellation window is never presented as an obligation",
  tdMayCancel.obligation.actionRequired === false
  && tdMayCancel.obligation.deadline === null
  && tdMayCancel.action.mandatory === false
  && !tdMayCancel.categories.includes("Deadline")
  && !tdMayCancel.categories.includes("Action Required")
  && !/Deadline:/u.test(tdMayCancel.summary)
  && tdFindings(tdMayCancel, "deadline").length === 0,
  `categories=${tdMayCancel.categories.join("/")} summary=${tdMayCancel.summary}`);

const tdMayCancelNl = td("U kunt tot 16 mei 2027 opzeggen.", { language: "nl" });
check("T100 a Dutch optional cancellation window behaves the same way",
  tdMayCancelNl.deadline?.role === "cancellation_window"
  && !tdMayCancelNl.categories.includes("Deadline")
  && tdMayCancelNl.obligation.deadline === null
  && tdMayCancelNl.obligation.optionalDeadline === "2027-05-16",
  `categories=${tdMayCancelNl.categories.join("/")}`);

const tdMustCancel = td("You must submit the cancellation request by 16 May 2027.");
check("T101 a mandatory cancellation instruction is a real deadline and keeps the Deadline category",
  tdMustCancel.deadline?.date === "2027-05-16"
  && tdMustCancel.deadline.role === "deadline"
  && tdMustCancel.action.mandatory === true
  && tdMustCancel.obligation.actionRequired === true
  && tdMustCancel.obligation.deadline === "2027-05-16"
  && tdMustCancel.categories.includes("Deadline")
  && tdFindings(tdMustCancel, "cancellation_window").length === 0,
  `role=${tdMustCancel.deadline?.role} categories=${tdMustCancel.categories.join("/")}`);

const tdRelativeAppointment = td("Your appointment is tomorrow.");
check("T102 a relative appointment date is an appointment, not a deadline",
  tdNoDeadline(tdRelativeAppointment) && tdFirst(tdRelativeAppointment, "appointment")?.date === TD_TOMORROW,
  `typed=${(tdRelativeAppointment.typedFindings || []).map((f) => f.type).join(",")}`);

const tdRelativeInfo = td("Your package is available from tomorrow.");
check("T103 a relative availability date is information, not a deadline",
  tdNoDeadline(tdRelativeInfo) && tdFirst(tdRelativeInfo, "information")?.date === TD_TOMORROW,
  `typed=${(tdRelativeInfo.typedFindings || []).map((f) => f.type).join(",")}`);

const tdRelativePay = td("Please pay by tomorrow.");
check("T104 a relative payment date is a deadline",
  tdRelativePay.deadline?.date === TD_TOMORROW && tdRelativePay.deadline.role === "deadline",
  `deadline=${tdRelativePay.deadline?.date}`);

const tdRelativeCancel = td("You may cancel by tomorrow.");
check("T105 a relative optional cancellation date is a window, not a deadline category",
  tdFirst(tdRelativeCancel, "cancellation_window")?.date === TD_TOMORROW
  && tdRelativeCancel.obligation.actionRequired === false
  && tdRelativeCancel.obligation.optionalDeadline === TD_TOMORROW
  && !tdRelativeCancel.categories.includes("Deadline"),
  `categories=${tdRelativeCancel.categories.join("/")}`);

const tdBareSubject = td("", { subject: "5 MAART", language: "nl" });
check("T106 a bare date in the subject is not promoted to any operational finding",
  tdNoDeadline(tdBareSubject)
  && tdBareSubject.typedFindings.length === 0
  && !tdBareSubject.needsVerification.includes("deadline_ambiguous_numeric_date"),
  `typed=${tdBareSubject.typedFindings.length} verification=${tdBareSubject.needsVerification.join(",")}`);

const tdBareAmbiguous = td("03/04/2027");
check("T107 a bare ambiguous numeric date does not become an ambiguous deadline",
  tdBareAmbiguous.deadline === null
  && tdBareAmbiguous.deadlineCandidates.length === 0
  && tdBareAmbiguous.needsVerification.length === 0
  && tdBareAmbiguous.typedFindings.length === 0,
  `verification=${tdBareAmbiguous.needsVerification.join(",")}`);

const tdAmbiguousWithContext = td("Please pay by 03/04/2027.");
check("T108 an ambiguous numeric date WITH deadline context still requires verification",
  tdAmbiguousWithContext.deadline === null
  && tdAmbiguousWithContext.needsVerification.includes("deadline_ambiguous_numeric_date")
  && tdAmbiguousWithContext.deadlineCandidates.length > 0
  && tdFirst(tdAmbiguousWithContext, "deadline")?.needsVerification === true
  && tdFirst(tdAmbiguousWithContext, "deadline")?.dateAlternatives.length === 2,
  `verification=${tdAmbiguousWithContext.needsVerification.join(",")}`);

const TD_MIXED = [
  "Your appointment is on 5 March 2027.",
  "Your package will be delivered on 12 March 2027.",
  "Your subscription renews on 1 April 2027.",
  "Please pay EUR 15.00 by 31 January 2027."
].join(" ");
const tdMixed = td(TD_MIXED);
check("T109 every typed finding is machine-readable and uses only the declared types",
  tdMixed.typedFindings.length >= 4
  && tdMixed.typedFindings.every((finding) =>
    FINDING_TYPES.includes(finding.type)
    && typeof finding.actionRequired === "boolean"
    && typeof finding.needsVerification === "boolean"
    && typeof finding.strength === "number"
    && finding.strength >= 0 && finding.strength <= 1
    && (finding.date === null || /^\d{4}-\d{2}-\d{2}$/u.test(finding.date))
    && tdEvidenceFromSource(finding, TD_MIXED))
  && ["appointment", "delivery", "renewal", "deadline", "payment"]
    .every((type) => tdMixed.typedFindings.some((finding) => finding.type === type)),
  `typed=${tdMixed.typedFindings.map((f) => f.type).join(",")}`);

check("T110 in a message of four dates only the obligation-bearing one is a deadline candidate",
  tdMixed.deadlineCandidates.length === 1 && tdMixed.deadline?.date === "2027-01-31",
  `candidates=${tdMixed.deadlineCandidates.length}`);

check("T111 the analysis result declares the 0.8.0 rule identity",
  tdPayBy.analysisVersion === "local-rules-0.8.0" && tdPayBy.analysisMode === "local",
  `analysisVersion=${tdPayBy.analysisVersion}`);

check("T112 typed findings are part of the analysis provider contract",
  (() => {
    try {
      validateAnalysisResult(tdPayBy);
    } catch {
      return false;
    }
    const { typedFindings: _dropped, ...withoutFindings } = tdPayBy;
    try {
      validateAnalysisResult(withoutFindings);
      return false;
    } catch (error) {
      return /typedFindings/u.test(String(error?.message || ""));
    }
  })());

const tdNoDate = td("Thank you for your message.");
check("T113 an analysis without any date still returns an array of typed findings",
  Array.isArray(tdNoDate.typedFindings) && tdNoDate.typedFindings.length === 0);

// Backward compatibility is a property of the migration path, which runs against
// Thunderbird storage; assert it at the source, as T75 does for background.js.
const storageSource = readFileSync(new URL("../modules/storage.mjs", import.meta.url), "utf8");
check("T114 a record written before 0.8.0 opens with an empty typed-findings list",
  /typedFindings: Array\.isArray\(record\.typedFindings\) \? record\.typedFindings : \[\]/u.test(storageSource)
  && /schemaVersion: SCHEMA_VERSION/u.test(storageSource)
  && /export const SCHEMA_VERSION = 6;/u.test(storageSource));

const analyzerSource = readFileSync(new URL("../modules/analyzer.mjs", import.meta.url), "utf8");
check("T115 the analyser adds no network, cloud or model call",
  !/\bfetch\(/u.test(analyzerSource)
  && !/XMLHttpRequest/u.test(analyzerSource)
  && !/WebSocket/u.test(analyzerSource)
  && !/https?:\/\//u.test(analyzerSource.replace(/^\s*\/\/.*$/gmu, "")));

// The permission set is pinned deliberately: a new permission must fail this test and be
// argued for, not slip in. "downloads" was removed once its only consumer was found to be
// unreachable — the add-on writes no files, the Desktop layer does.
check("T116 the extension asks for exactly this permission set and this CSP",
  JSON.stringify(manifest.permissions) === JSON.stringify([
    "accountsRead", "messagesRead", "messagesDelete", "messagesUpdate",
    "messagesTags", "messagesTagsList", "storage", "menus", "nativeMessaging"
  ])
  && manifest.content_security_policy.extension_pages
    === "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'",
  `permissions=${JSON.stringify(manifest.permissions)}`);


// CivionMailIngestion/0.2 fixes the fields of a deadline candidate and the Desktop
// spool refuses a package carrying any other one, so an extra field here is not a
// harmless addition — it rejects the whole package before review. The end-to-end
// proof lives in tests/test_mail_bridge_contract.py, which runs this builder
// against the real spool; this check is the fast one that fails in the same suite
// as the change.
const DEADLINE_CANDIDATE_FIELDS = [
  "assumptions", "basis", "candidate_id", "confidence_score",
  "deadline_type", "source_span", "stated_date", "timezone"
];

const bridgeRecord = {
  ...td("Betaal uiterlijk 31 januari 2027 het bedrag van EUR 83,17.", { language: "nl" }),
  id: "bridge-1",
  accountId: "account-1",
  folderId: "folder-1",
  currentMessageId: "41",
  headerMessageId: "<bridge@example.org>",
  subject: "Aanmaning betaling",
  analyzedAt: "2026-09-07T08:00:00.000Z",
  receivedAt: "2026-09-07T07:00:00.000Z"
};
const bridgeEnvelope = buildCivionMailEnvelope(bridgeRecord, "0.8.0", "2026-09-07T08:00:00.000Z");
const bridgeDeadline = bridgeEnvelope.payload.deadline_candidates[0];

check("T117 the bridge envelope carries a deadline candidate for a stated deadline",
  bridgeEnvelope.payload.deadline_candidates.length === 1 && bridgeDeadline.stated_date === "2027-01-31",
  `candidates=${bridgeEnvelope.payload.deadline_candidates.length} date=${bridgeDeadline?.stated_date}`);

check("T118 the deadline candidate declares only the fields CivionMailIngestion/0.2 allows",
  JSON.stringify(Object.keys(bridgeDeadline).sort()) === JSON.stringify(DEADLINE_CANDIDATE_FIELDS),
  `keys=${Object.keys(bridgeDeadline).sort().join(",")}`);

check("T119 the temporal reading a deadline candidate may carry travels in deadline_type",
  ["Historical", "Explicit", "Inferred"].includes(bridgeDeadline.deadline_type),
  `deadline_type=${bridgeDeadline.deadline_type}`);

// T26 closes one direction of the binding contract: every id cacheElements asks for exists
// in the markup. This closes the other. An element used but never cached is silently
// undefined until the first call reaches it, and then it throws in the middle of a render.
// That is exactly how the observed authserv-id list stopped appearing: elements.
// diagnosticsAuthserv was used three times and cached nowhere, so clearNode(undefined) threw
// and took the rest of renderDiagnostics with it — the checks table, the account coverage and
// the operational counters below it never rendered.
const usedElementNames = [...new Set(
  [...actionCenter.matchAll(/\belements\.([A-Za-z0-9_]+)\b/gu)].map((m) => m[1])
)];
const usedButNotCached = usedElementNames.filter((name) => !requestedIds.includes(name)).sort();

check("T120 every element the code reads is cached, so none of them is undefined at runtime",
  usedElementNames.length > 60 && usedButNotCached.length === 0,
  `used=${usedElementNames.length} uncached=${usedButNotCached.join(",") || "none"}`);

// Decision r001 section 3. The old configuration had two ways to run without a bound:
// maxMessages 0 meant no limit, and two empty dates meant the whole mailbox. Neither may
// come back, and the Action Center must state the resolved window before starting.
const boundedLimit = /const maxMessages = Math\.min\(\s*HISTORICAL_SCAN_MAX_MESSAGES/u.test(bg)
  && !/parsedLimit === 0/u.test(bg)
  && /HISTORICAL_SCAN_DEFAULT_MESSAGES\s*=\s*\d+/u.test(bg);
const boundedWindow = /if \(!fromDate && !toDate\)/u.test(bg)
  && /HISTORICAL_SCAN_DEFAULT_WINDOW_MONTHS/u.test(bg);
check("T121 a Historical Scan always has a count bound and a date window",
  boundedLimit && boundedWindow,
  `limit=${boundedLimit} window=${boundedWindow}`);

check("T122 the Action Center states the resolved bound before the run starts",
  /resolvedHistoricalWindow\(/u.test(actionCenter)
  && /at most \$\{Math\.trunc\(maxMessages\)\} messages between/u.test(actionCenter)
  && !/no limit/u.test(actionCenter)
  // The r005 markup says the opposite of what this used to forbid — "there is no value
  // that means no limit" — so the check is for an offered unlimited value, not the words.
  && !/(?:empty|blank|zero|0) means no limit/iu.test(markup)
  && /There is no value that means no limit/u.test(markup));

// The r005 shell is a second entry point into the same app.js, so it lives or dies by the
// same binding contract. Keeping this here means the two markups can never drift apart.
const markupR005 = readFileSync(new URL("../action-center/index.r005.html", import.meta.url), "utf8");
const r005Ids = [...markupR005.matchAll(/\sid="([^"]+)"/gu)].map((m) => m[1]);
const r005Missing = requestedIds.filter((id) => !r005Ids.includes(id));
const r005Duplicate = r005Ids.filter((id, index) => r005Ids.indexOf(id) !== index);
check("T123 the r005 shell satisfies the same element contract as the shipped markup",
  r005Missing.length === 0 && r005Duplicate.length === 0,
  `missing=${r005Missing.join(",")} duplicate=${r005Duplicate.join(",")}`);

// An Operations menu item carries a label and the note that explains what it does.
// Writing textContent on the button deleted both the first time a run started, and the
// note never came back until the panel was reloaded.
check("T125 running state is written into the menu item label, not over the whole button",
  /function menuItemLabel\(/u.test(actionCenter)
  && !/elements\.(historicalScanButton|archiveExistingButton)\.textContent/u.test(actionCenter)
  && (actionCenter.match(/menuItemLabel\(elements\.\w+\)\.textContent/gu) || []).length === 4);

const shellSource = readFileSync(new URL("../action-center/ui-shell.mjs", import.meta.url), "utf8");
const todaySource = readFileSync(new URL("../action-center/views-today.mjs", import.meta.url), "utf8");
const identitySource = readFileSync(new URL("../action-center/views-identity.mjs", import.meta.url), "utf8");
const reviewSource = readFileSync(new URL("../action-center/views-review.mjs", import.meta.url), "utf8");
const datesSource = readFileSync(new URL("../action-center/views-dates.mjs", import.meta.url), "utf8");
const analyzerSource2 = readFileSync(new URL("../modules/analyzer.mjs", import.meta.url), "utf8");

// Every chip app.js builds must carry the r005 base class and a tone, or the record rows
// render as bare text under the r005 stylesheet.
check("T126 every chip carries the r005 base class and a tone",
  /if \(!parts\.includes\("chip"\)\) parts\.push\("chip"\)/u.test(actionCenter)
  && /const CHIP_TONE = \{/u.test(actionCenter));

// A panel can be reached two ways now: the Operations menu, and navigating to it. Both
// have to load the same data, so loading is separate from opening and the shell fires
// "show" on arrival. Without this, System → Historical Scan showed an empty folder tree.
// 0.8.4 added the fourth: Settings, which showed the HTML defaults on arrival.
check("T127 panels load their data on arrival, not only when opened from the menu",
  /async function loadHistoricalScanPanel\(\)/u.test(actionCenter)
  && /async function loadArchiveExistingPanel\(\)/u.test(actionCenter)
  && (actionCenter.match(/addEventListener\("show"/gu) || []).length === 4
  && /dispatchEvent\(new Event\("show"\)\)/u.test(shellSource));

// The PDF sweep was the half of decision r001 section 3 that had not been done: fixed
// folder scope, but no date window and no count ceiling. It is bounded the same way now,
// and the reconciliation gap the panel used to declare is gone because it is closed.
check("T129 the PDF archive sweep is bounded too",
  /function resolveArchiveExistingBounds\(/u.test(bg)
  && /async function startArchiveExisting\(raw = \{\}\)/u.test(bg)
  && /const config = \{ \.\.\.scope, \.\.\.resolveArchiveExistingBounds\(raw\) \};/u.test(bg)
  && /job\.limitReached = true/u.test(bg)
  && /queryInfo\.fromDate = job\.config\.fromDate/u.test(bg));

check("T130 the sweep states its bound before the run starts, and claims no unlimited scope",
  /at most \$\{Math\.trunc\(maxMessages\)\} messages examined, between/u.test(actionCenter)
  && !/No date or message limit/u.test(actionCenter)
  && !/no date limit and no count limit/iu.test(markupR005));

// Today is derived from the record set. The audit that produced r003 turned on exactly
// this: a queue and a record must not be added together, and a summary figure must come
// from the same data as the list under it. Both are testable without a DOM.
const overdueRecord = { status: "New", deadline: { date: "2026-09-01", overdue: true } };
const bothRecord = { status: "New", needsVerification: ["deadline"], deadline: { date: "2026-09-01", overdue: true } };
const flagged = { status: "New", markedIncorrect: true };
const closed = { status: "Completed", markedIncorrect: true, deadline: { date: "2026-09-01", overdue: true } };
const summary = summariseToday([overdueRecord, bothRecord, flagged, closed], Date.parse("2026-09-12T00:00:00"));

check("T131 a record that needs a decision is not also counted as other attention",
  summary.decisions.length === 1 && summary.attention.length === 2,
  `decisions=${summary.decisions.length} attention=${summary.attention.length}`);

check("T132 a closed record is neither a decision nor an attention item",
  decisionReasonToday(closed) === null && attentionReasonToday(closed, Date.parse("2026-09-12T00:00:00")) === null);

check("T133 the Today figures are the lengths of the lists they head",
  /\$\("todayDecisionBig"\)\.textContent = String\(decisions\.length\)/u.test(todaySource)
  && /\$\("todayOtherBig"\)\.textContent = String\(attention\.length\)/u.test(todaySource)
  && /fillQueue\(\$\("todayDecisionList"\), groupCount\(decisions\)/u.test(todaySource));

check("T134 the derived view reads a published snapshot and owns no record state",
  /document\.dispatchEvent\(new CustomEvent\("civion:state"/u.test(actionCenter)
  && !/messenger\./u.test(todaySource)
  && !/send\(/u.test(todaySource));

// Identity state has one owner. Trust and the sender queue in Review are joins of the
// record set with the snapshot the background publishes — there is no sender database in
// the Action Center, and provenance travels with every disposition because "you allowed
// this" and "the corpus has seen this" are different facts.
const IDENTITY_FIXTURE = {
  trustedAuthservIds: [{ id: "mx.example.invalid", provenance: "user" }],
  allowlistedDomains: [
    { domain: "allowed.example.invalid", provenance: "user" },
    { domain: "observed.example.invalid", provenance: "observed" }
  ],
  blockedDomains: [
    { domain: "blocked.example.invalid", provenance: "user" },
    { domain: "phish.example.invalid", provenance: "built-in" }
  ],
  protectedIdentities: [
    { id: "gemeente", label: "Gemeente", domains: ["allowed.example.invalid"], provenance: "built-in" }
  ]
};
const identityRecord = (domain, over = {}) => ({
  status: "New", sender: domain, senderAddress: `post@${domain}`, receivedAt: "2026-09-10T08:00:00.000Z", ...over
});
const trustRows = deriveTrust([
  identityRecord("allowed.example.invalid"),
  identityRecord("observed.example.invalid"),
  identityRecord("blocked.example.invalid"),
  identityRecord("unknown.example.invalid")
], IDENTITY_FIXTURE);
const byDomain = Object.fromEntries(trustRows.map((row) => [row.domain, row]));

check("T135 a disposition carries its provenance, and observed is not a decision",
  byDomain["allowed.example.invalid"].dispositionLabel === "allowed by you"
  && byDomain["observed.example.invalid"].dispositionLabel === "observed service domain"
  && byDomain["blocked.example.invalid"].dispositionLabel === "blocked by you"
  && byDomain["unknown.example.invalid"].dispositionLabel === "no disposition",
  trustRows.map((row) => `${row.domain}=${row.dispositionLabel}`).join(" "));

check("T136 Trust rows come from the records, not from the lists",
  trustRows.length === 4
  && !trustRows.some((row) => row.domain === "phish.example.invalid")
  && byDomain["allowed.example.invalid"].protectedIdentity?.label === "Gemeente",
  `rows=${trustRows.length}`);

const senderQueue = deriveSenderReview([
  identityRecord("blocked.example.invalid"),
  identityRecord("allowed.example.invalid", { admittedFromJunk: true }),
  identityRecord("phish.example.invalid"),
  identityRecord("observed.example.invalid", { admittedFromJunk: true }),
  identityRecord("failed.example.invalid", { senderTrust: { authentication: { verdict: "failed" } } }),
  identityRecord("closed.example.invalid", { status: "Completed", admittedFromJunk: true })
], IDENTITY_FIXTURE);

check("T137 the sender queue holds only what you have not decided, and never a closed record",
  senderQueue.length === 3
  && senderQueue.some((item) => item.domain === "phish.example.invalid")
  && senderQueue.some((item) => item.domain === "observed.example.invalid")
  && senderQueue.some((item) => item.domain === "failed.example.invalid")
  && !senderQueue.some((item) => ["blocked.example.invalid", "allowed.example.invalid", "closed.example.invalid"].includes(item.domain)),
  senderQueue.map((item) => item.domain).join(" "));

check("T138 the identity snapshot is read-only in the Action Center and asked for once",
  /function deepFreeze\(/u.test(actionCenter)
  && /deepFreeze\(response\.identity\)/u.test(actionCenter)
  && (actionCenter.match(/send\("getIdentityState"\)/gu) || []).length === 1
  && !/messenger\./u.test(identitySource)
  && !/send\(/u.test(identitySource));

check("T139 a view asks for an identity change and never performs one",
  /document\.addEventListener\("civion:identity-command"/u.test(actionCenter)
  && /send\("setDomainDisposition"/u.test(actionCenter)
  && /dispatchEvent\(new CustomEvent\("civion:identity-command"/u.test(identitySource)
  && /type === "getIdentityState"/u.test(bg)
  && /provenance: "observed"/u.test(bg)
  && /provenance: "built-in"/u.test(bg));

// Junk watch is its own read-only projection, and decision r002 section 3 is the line it
// follows: a message that failed the gate received no verdict, so it exists here only as a
// counter. A list of them would be the spam judgement the gate refuses to make.
const junkSnapshot = {
  admitted: [{
    recordId: "r1",
    sender: "Stroomnet Zuid",
    subject: "Jaarafrekening",
    admission: {
      admitted: true,
      path: "proven_history",
      conditions: [{ id: "prior-records", label: "At least 2 prior non-junk records", result: "pass" }],
      evidenceProvenance: { source: "local non-junk history", qualifyingRecords: 4, authenticatedRecords: 2 },
      upstreamMarker: { observedAs: "junk", by: "the mail provider or Thunderbird" }
    }
  }],
  notAdmitted: { messageCount: 12 },
  admittedWithoutReasoning: 3,
  userOverrides: { supported: false }
};
const junkView = deriveJunkWatch([{ id: "r1", sender: "Stroomnet Zuid" }], junkSnapshot);

check("T140 Junk watch shows admitted records and the path that admitted each one",
  junkView.admitted.length === 1
  && junkView.admitted[0].pathLabel === "proven personal history"
  && junkView.admitted[0].record?.id === "r1",
  JSON.stringify(junkView.admitted.map((entry) => entry.pathLabel)));

check("T141 not-admitted messages are a counter and never a list",
  junkView.notAdmittedCount === 12
  && !("notAdmitted" in junkView && Array.isArray(junkView.notAdmitted))
  && !/notAdmitted:\s*\[/u.test(bg)
  && /messageCount: Number\(operational\.junkNotAdmittedMessageCount/u.test(bg)
  && /not a spam verdict/u.test(bg));

check("T142 admitted records without recorded reasoning are counted, not given an invented one",
  junkView.withoutReasoning === 3
  && /admittedWithoutReasoning/u.test(bg)
  && /admittedWithoutReasoning/u.test(reviewSource));

check("T143 the junk projection is separate from identity, read-only, and freed of messenger",
  /type === "getJunkAdmissionState"/u.test(bg)
  && !/junkAdmission/u.test(identitySource)
  && /deepFreeze\(response\.junk\)/u.test(actionCenter)
  && !/messenger\./u.test(reviewSource)
  && !/send\(/u.test(reviewSource));

check("T144 the upstream junk marker is carried as an observation, never as trust",
  /upstreamMarker/u.test(bg)
  && /never evidence of trust/u.test(bg)
  && /never evidence of trust/u.test(bg));

// Dates is a projection over the records, with `now` passed in so every case is
// deterministic. A row is a finding, not a record.
const DATES_NOW = Date.parse("2026-09-12T09:00:00");
const finding = (over) => ({ actionRequired: false, needsVerification: false, dateAlternatives: [], ...over });
const DATE_RECORDS = [
  // One record, two roles: an obligation and an appointment.
  {
    id: "two-roles", status: "New", sender: "Gemeente", subject: "Besluit",
    typedFindings: [
      finding({ id: "deadline:2026-09-30", type: "deadline", temporalRole: "due_by", date: "2026-09-30", actionRequired: true, evidence: "voor 30 september" }),
      finding({ id: "appointment:2026-10-08", type: "appointment", temporalRole: "appointment_date", date: "2026-10-08", evidence: "op 8 oktober" })
    ]
  },
  // An optional cancellation window, even though it is dated and in the future.
  {
    id: "optional", status: "New", sender: "Meander", subject: "Verlenging",
    typedFindings: [finding({ id: "cancellation_window:2026-11-30", type: "cancellation_window", temporalRole: "cancellation_deadline", date: "2026-11-30", evidence: "tot 30 november" })]
  },
  // A proven obligation whose date has passed.
  {
    id: "overdue", status: "In progress", sender: "Kade", subject: "Herinnering",
    typedFindings: [finding({ id: "payment:2026-09-05", type: "payment", temporalRole: "payment_due", date: "2026-09-05", actionRequired: true, evidence: "uiterlijk 5 september" })]
  },
  // An information date, and next to it a deadline the person still has to confirm.
  {
    id: "unsettled", status: "New", sender: "Zorgpolis", subject: "Wijziging",
    needsVerification: ["deadline"],
    typedFindings: [
      finding({ id: "information:2027-01-01", type: "information", temporalRole: "effective_or_informational_date", date: "2027-01-01", evidence: "per 1 januari" }),
      finding({ id: "deadline:2026-12-31", type: "deadline", temporalRole: "due_by", date: "2026-12-31", actionRequired: true, needsVerification: true, dateAlternatives: ["2026-12-31", "2026-03-12"], evidence: "voor 31-12" })
    ]
  },
  // A closed record. Its date stays visible in All and counts nowhere else.
  {
    id: "closed", status: "Completed", sender: "Bibliotheek", subject: "Verlengd",
    typedFindings: [finding({ id: "renewal:2026-08-28", type: "renewal", temporalRole: "renewal_effective_date", date: "2026-08-28", evidence: "per 28 augustus" })]
  },
  // A failed analysis with a date. It must not read as "no action".
  {
    id: "failed", status: "New", sender: "Onbekend", subject: "Onleesbaar", analysisError: true,
    typedFindings: [finding({ id: "deadline:2026-10-01", type: "deadline", temporalRole: "due_by", date: "2026-10-01", actionRequired: true, evidence: "" })]
  },
  // An undated finding is not a date at all.
  {
    id: "undated", status: "New", sender: "Geen datum", subject: "Zonder datum",
    typedFindings: [finding({ id: "payment:none", type: "payment", temporalRole: "payment_due", date: null, actionRequired: true })]
  }
];
const dateRows = deriveDates(DATE_RECORDS, DATES_NOW);
const dateById = Object.fromEntries(dateRows.map((row) => [row.id, row]));
const dateCounts = countDates(dateRows);

check("T145 one record can produce more than one dated row, each with its own role",
  dateRows.filter((row) => row.recordId === "two-roles").length === 2
  && dateById["two-roles::deadline:2026-09-30"].role === "deadline"
  && dateById["two-roles::appointment:2026-10-08"].role === "appointment",
  dateRows.filter((row) => row.recordId === "two-roles").map((row) => row.role).join(" "));

check("T146 an undated finding produces no row",
  !dateRows.some((row) => row.recordId === "undated") && dateRows.length === 8,
  `rows=${dateRows.length}`);

check("T147 a deadline is not every date: only a proven obligation obliges",
  dateById["two-roles::deadline:2026-09-30"].obliging === true
  && dateById["two-roles::appointment:2026-10-08"].obliging === false
  && dateById["unsettled::information:2027-01-01"].obliging === false
  && dateById["closed::renewal:2026-08-28"].obliging === false);

check("T148 an optional cancellation window is never an obligation and never overdue",
  dateById["optional::cancellation_window:2026-11-30"].optional === true
  && dateById["optional::cancellation_window:2026-11-30"].obliging === false
  && dateById["optional::cancellation_window:2026-11-30"].overdue === false);

check("T149 overdue comes from a proven operational date and stays visible",
  dateById["overdue::payment:2026-09-05"].overdue === true
  && dateById["overdue::payment:2026-09-05"].daysFromToday === -7
  && dateCounts.overdue === 1
  && dateRows.some((row) => row.id === "overdue::payment:2026-09-05"));

check("T150 an unsettled date is not promoted to operational, and its neighbour is untouched",
  dateById["unsettled::deadline:2026-12-31"].unsettled === true
  && dateById["unsettled::deadline:2026-12-31"].obliging === false
  && dateById["unsettled::deadline:2026-12-31"].ambiguous === true
  && dateById["unsettled::information:2027-01-01"].unsettled === false,
  `deadline=${dateById["unsettled::deadline:2026-12-31"].unsettled} information=${dateById["unsettled::information:2027-01-01"].unsettled}`);

check("T151 a closed record keeps its date in All and counts in no operational view",
  dateById["closed::renewal:2026-08-28"].closed === true
  && DATE_FILTERS.all(dateById["closed::renewal:2026-08-28"])
  && !DATE_FILTERS.obliging(dateById["closed::renewal:2026-08-28"])
  && !DATE_FILTERS.overdue(dateById["closed::renewal:2026-08-28"]));

check("T152 a failed analysis is marked as a failure, never as no action",
  dateById["failed::deadline:2026-10-01"].analysisError === true
  && /chip\.textContent = "analysis failed"/u.test(datesSource)
  // The phrase appears once, in the header comment that forbids it. It must never be a
  // value the screen writes.
  && (datesSource.match(/No Action/giu) || []).length === 1
  && !/textContent = "No Action"/iu.test(datesSource));

check("T153 the four tabs are four filters over one array, so counts and lists agree",
  dateCounts.all === dateRows.length
  && dateCounts.obliging === dateRows.filter(DATE_FILTERS.obliging).length
  && dateCounts.optional === dateRows.filter(DATE_FILTERS.optional).length
  && dateCounts.overdue === dateRows.filter(DATE_FILTERS.overdue).length
  && dateCounts.obliging === 3 && dateCounts.optional === 1 && dateCounts.overdue === 1,
  JSON.stringify(dateCounts));

check("T154 a row is addressed by record and finding, never by position",
  dateRows.every((row) => row.id === `${row.recordId}::${row.findingId}`)
  && /\$\{record\.id\}::\$\{finding\.id/u.test(datesSource)
  && /id: `\$\{finding\.type\}:\$\{finding\.date \|\| finding\.dateRaw \|\| "none"\}`/u.test(analyzerSource2));

check("T155 Dates takes now as an argument and calls no messenger",
  /export function deriveDates\(records, now\)/u.test(datesSource)
  && !/Date\.now\(\)/u.test(datesSource.slice(0, datesSource.indexOf("---------------------------------------------------------------- rendering")))
  && !/messenger\./u.test(datesSource)
  && !/send\(/u.test(datesSource));

// The rest of Review. Three queues are derivable from the records; two are backed by
// runtime state the background owns. Uncertain reading is built from the Dates rows, so
// the two screens address the same reading the same way and cannot drift apart.
const REVIEW_NOW = Date.parse("2026-09-12T09:00:00");
const REVIEW_RECORDS = [
  {
    id: "unsettled", status: "New", sender: "Zorgpolis", subject: "Wijziging",
    needsVerification: ["deadline"],
    typedFindings: [
      { id: "deadline:2026-12-31", type: "deadline", temporalRole: "due_by", date: "2026-12-31", actionRequired: true, needsVerification: true, dateAlternatives: [], evidence: "voor 31-12" },
      { id: "information:2027-01-01", type: "information", temporalRole: "effective_or_informational_date", date: "2027-01-01", actionRequired: false, needsVerification: false, dateAlternatives: [], evidence: "per 1 januari" }
    ]
  },
  { id: "broken", status: "New", sender: "Onbekend", subject: "Onleesbaar", analysisError: true },
  { id: "gone", status: "New", sender: "Verdwenen", subject: "Weg", messageAvailable: false },
  { id: "flagged", status: "Waiting", sender: "Stroomnet", subject: "Jaarafrekening", markedIncorrect: true },
  { id: "closed-broken", status: "Completed", sender: "Oud", subject: "Afgesloten", analysisError: true }
];
const REVIEW_STATE = {
  rejections: [{ key: "unsettled::deadline:2026-12-31", recordId: "unsettled", findingId: "deadline:2026-12-31", rejectedAt: "2026-09-12T08:00:00.000Z" }],
  rules: [
    { id: "local-rules-0.8.0", label: "Local rules 0.8.0", recordCount: 5, firstSeenAt: "2026-09-04T13:55:00.000Z", acknowledged: false },
    { id: "local-rules-0.7.2", label: "Local rules 0.7.2", recordCount: 1, firstSeenAt: "2026-08-30T10:12:00.000Z", acknowledged: true }
  ]
};

const uncertainOpen = deriveUncertain(REVIEW_RECORDS, REVIEW_NOW, new Set());
check("T156 Uncertain reading is the Dates rows that are unsettled, addressed identically",
  uncertainOpen.length === 1
  && uncertainOpen[0].key === "unsettled::deadline:2026-12-31"
  && uncertainOpen[0].recordId === "unsettled"
  && uncertainOpen[0].findingId === "deadline:2026-12-31"
  && deriveDates(REVIEW_RECORDS, REVIEW_NOW).some((row) => row.id === uncertainOpen[0].key && row.unsettled),
  uncertainOpen.map((item) => item.key).join(" "));

check("T157 a rejected reading leaves Uncertain and is kept, not deleted",
  deriveUncertain(REVIEW_RECORDS, REVIEW_NOW, new Set(["unsettled::deadline:2026-12-31"])).length === 0
  && deriveRejected(REVIEW_RECORDS, REVIEW_STATE).length === 1
  && deriveRejected(REVIEW_RECORDS, REVIEW_STATE)[0].findingId === "deadline:2026-12-31");

check("T158 a rejection whose record is gone is still shown, so it is never silently undone",
  deriveRejected([], REVIEW_STATE)[0].present === false
  && /never silently undone|no longer held/u.test(reviewSource));

const unreadable = deriveUnreadable(REVIEW_RECORDS);
check("T159 Could not be read holds failures and missing originals, and no closed record",
  unreadable.length === 2
  && unreadable.some((item) => item.recordId === "broken")
  && unreadable.some((item) => item.recordId === "gone")
  && !unreadable.some((item) => item.recordId === "closed-broken"),
  unreadable.map((item) => item.recordId).join(" "));

check("T160 Marked incorrect is a record of what you said, not a queue of work",
  deriveMarkedIncorrect(REVIEW_RECORDS).length === 1
  && deriveMarkedIncorrect(REVIEW_RECORDS)[0].recordId === "flagged"
  && /not a queue of work/u.test(reviewSource));

check("T161 Newly acting rule lists only what you have not acknowledged",
  deriveNewRules(REVIEW_STATE).length === 1
  && deriveNewRules(REVIEW_STATE)[0].id === "local-rules-0.8.0"
  && deriveNewRules({ rules: [] }).length === 0);

check("T162 the two state-backed queues are owned by the background and only read here",
  /type === "getReviewState"/u.test(bg)
  && /type === "setReviewRejection"/u.test(bg)
  && /type === "acknowledgeRule"/u.test(bg)
  && /reviewRejections/u.test(bg)
  && /acknowledgedRules/u.test(bg)
  && /deepFreeze\(response\.review\)/u.test(actionCenter)
  && /dispatchEvent\(new CustomEvent\("civion:review-command"/u.test(reviewSource)
  && !/messenger\./u.test(reviewSource)
  && !/send\(/u.test(reviewSource));

check("T163 a rejection is keyed by record and finding, and kept outside the record",
  /REVIEW_REJECTION_KEY = \(recordId, findingId\)/u.test(bg)
  && /metadata\.reviewRejections/u.test(bg)
  && !/record\.reviewRejections/u.test(bg));

check("T128 the manifest opens the r005 shell",
  manifest.options_ui.page === "action-center/index.r005.html");

// The shell must not grow a second copy of the record logic. It routes and it themes.

check("T124 the shell owns navigation only — no record state, no messenger calls",
  !/messenger\./u.test(shellSource) && !/records/u.test(shellSource.replace(/data-screen="records"|go\("records"\)|"records"/gu, "")));

// ---- 0.8.4: Settings shows the stored values on every path (029 §3.1, §5.1–10) ----
//
// The projection is executed, not grepped: the defect was a form that showed the HTML
// defaults whenever Settings was reached by navigation, and the HTML defaults for the
// bridge and the archive are the opposite of the stored ones. The controls below are
// plain objects with the two properties the projection writes; the storage layer is the
// real one, over an in-memory stand-in for messenger.storage.local.

const { hydrateSettings, readSettingsPatch, SETTINGS_CONTROL_IDS } = await import("../action-center/views-settings.mjs");

function memoryStorageArea(initial = {}) {
  const store = { ...initial };
  return {
    store,
    async get(keys) {
      if (typeof keys === "string") return keys in store ? { [keys]: store[keys] } : {};
      if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => key in store).map((key) => [key, store[key]]));
      const out = {};
      for (const [key, fallback] of Object.entries(keys || {})) out[key] = key in store ? store[key] : fallback;
      return out;
    },
    async set(values) { Object.assign(store, values); },
    async remove(keys) { for (const key of [].concat(keys)) delete store[key]; }
  };
}

globalThis.messenger = { storage: { local: memoryStorageArea() } };
const storage = await import("../modules/storage.mjs");

// Fresh controls carry the HTML state: nothing checked, nothing typed. That is what a
// person sees if no projection ever runs.
const freshControls = () => Object.fromEntries(SETTINGS_CONTROL_IDS.map((id) => [id, { checked: false, value: "" }]));

const cleanStoreSettings = (await storage.getState()).settings;
const cleanControls = freshControls();
hydrateSettings(cleanControls, cleanStoreSettings);

check("T164 stored desktopBridgeEnabled=true is shown as enabled",
  (() => { const c = freshControls(); hydrateSettings(c, { desktopBridgeEnabled: true }); return c.settingDesktopBridge.checked === true; })());

check("T165 stored automaticDocumentArchive=true is shown as enabled",
  (() => { const c = freshControls(); hydrateSettings(c, { automaticDocumentArchive: true }); return c.settingDocumentArchive.checked === true; })());

check("T166 stored analyzeJunk=true is shown as enabled",
  (() => { const c = freshControls(); hydrateSettings(c, { analyzeJunk: true }); return c.settingAnalyzeJunk.checked === true; })());

// Save → reload → show, through the real setSettings/getState, for both directions of
// the two settings whose HTML default disagrees with the stored default.
async function saveAndReload(edit) {
  const before = freshControls();
  hydrateSettings(before, (await storage.getState()).settings);
  edit(before);
  await storage.setSettings(readSettingsPatch(before));
  const after = freshControls();
  hydrateSettings(after, (await storage.getState()).settings);
  return after;
}

check("T167 Save false → reload → shown false, for the bridge and the archive",
  await (async () => {
    const c = await saveAndReload((x) => { x.settingDesktopBridge.checked = false; x.settingDocumentArchive.checked = false; });
    return c.settingDesktopBridge.checked === false && c.settingDocumentArchive.checked === false;
  })());

check("T168 Save true → reload → shown true, for the bridge and the archive",
  await (async () => {
    const c = await saveAndReload((x) => { x.settingDesktopBridge.checked = true; x.settingDocumentArchive.checked = true; });
    return c.settingDesktopBridge.checked === true && c.settingDocumentArchive.checked === true;
  })());

// Direct navigation and the legacy showModal() path converge on the same "show" event,
// so there is one place that fills the form and openSettings() only navigates.
check("T169 direct navigation and the legacy showModal() path fill the form the same way",
  /elements\.settingsDialog\.addEventListener\("show", hydrateSettings\)/u.test(actionCenter)
  && /function openSettings\(\) \{\s*elements\.settingsDialog\.showModal\(\);\s*\}/u.test(actionCenter)
  && /function hydrateSettings\(\) \{\s*projectSettings\(elements, state\.settings\);\s*\}/u.test(actionCenter)
  && !/elements\.settingDesktopBridge\.checked = /u.test(actionCenter)
  && /show: \(\) => go\("settings"\)/u.test(shellSource)
  && /dispatchEvent\(new Event\("show"\)\)/u.test(shellSource));

check("T170 the remaining fields are projected: autoTag, retention, max records, diagnostics, authserv-ids",
  (() => {
    const c = freshControls();
    hydrateSettings(c, { autoTag: true, retentionDays: 90, maxRecords: 500, diagnosticLogging: true, trustedAuthservIds: ["mx.a.invalid", "mx.b.invalid"] });
    return c.settingAutoTag.checked === true && c.settingRetention.value === "90" && c.settingMaxRecords.value === "500"
      && c.settingDiagnostics.checked === true && c.settingTrustedAuthserv.value === "mx.a.invalid, mx.b.invalid";
  })());

check("T171 Junk keeps its semantics: only the truth of the control changed",
  /analyzeJunk: settings\.analyzeJunk === true/u.test(storageSource)
  && (() => { const c = freshControls(); hydrateSettings(c, { analyzeJunk: false }); return c.settingAnalyzeJunk.checked === false; })()
  && (() => { const c = freshControls(); hydrateSettings(c, {}); return c.settingAnalyzeJunk.checked === false; })());

// Save leaves the screen (close() is go("records")) and a return in the same session is
// an arrival, which hydrates. The read-back happens before leaving, from the background.
check("T172 Save → leave → return in the same session shows the saved values",
  /await send\("setSettings", \{ patch: readSettingsPatch\(elements\) \}\);[\s\S]*?await loadState\(false\);\s*hydrateSettings\(\);\s*elements\.settingsDialog\.close\(\);/u.test(actionCenter)
  && /hide: \(\) => go\("records"\)/u.test(shellSource)
  && await (async () => {
    // The same sequence executed: what Save stored is what the next hydration shows.
    const edited = freshControls();
    hydrateSettings(edited, (await storage.getState()).settings);
    edited.settingRetention.value = "120";
    edited.settingAutoTag.checked = true;
    await storage.setSettings(readSettingsPatch(edited));
    const returned = freshControls();
    hydrateSettings(returned, (await storage.getState()).settings);
    return returned.settingRetention.value === "120" && returned.settingAutoTag.checked === true;
  })());

check("T173 a clean store shows the semantic defaults, not the empty HTML",
  cleanControls.settingDesktopBridge.checked === true
  && cleanControls.settingDocumentArchive.checked === true
  && cleanControls.settingAnalyzeJunk.checked === false
  && cleanControls.settingRetention.value === "365"
  && cleanControls.settingMaxRecords.value === "2000"
  // The forbidden fix: none of the three inputs carries checked= in the markup.
  && !/id="settingDesktopBridge"[^>]*\schecked/u.test(markupR005)
  && !/id="settingDocumentArchive"[^>]*\schecked/u.test(markupR005)
  && !/id="settingAnalyzeJunk"[^>]*\schecked/u.test(markupR005));

const settingsViewSource = readFileSync(new URL("../action-center/views-settings.mjs", import.meta.url), "utf8");
check("T174 the projection keeps no second copy of the settings",
  !/^(let|var) /mu.test(settingsViewSource)
  && !/^const (?!\{)\w+ = (?!Object\.freeze)/mu.test(settingsViewSource.replace(/export const SETTINGS_CONTROL_IDS[\s\S]*?\]\);/u, ""))
  && /hydrateSettings\(\) \{\s*projectSettings\(elements, state\.settings\)/u.test(actionCenter)
  && !/settingsDraft|settingsCopy|state\.settingsForm/u.test(actionCenter));

// ---- 0.8.4: About, a subview of Settings (029 §3.8), and the LICENSE (029 §3.9) ----

const markupR005Now = readFileSync(new URL("../action-center/index.r005.html", import.meta.url), "utf8");
const actionCenterNow = readFileSync(new URL("../action-center/app.js", import.meta.url), "utf8");
const settingsScreen = markupR005Now.slice(markupR005Now.indexOf('data-screen="settings"'), markupR005Now.indexOf('<div class="status">'));
const aboutPanel = settingsScreen.slice(settingsScreen.indexOf('id="aboutPanel"'));

check("T175 About is a tab inside Settings, not a new rail entry",
  (markupR005Now.match(/class="rail-btn"/gu) || []).length === 7
  && !/data-go="about"/u.test(markupR005Now)
  && /<button[^>]*data-view="about"[^>]*role="tab"/u.test(settingsScreen)
  && /id="aboutPanel"[^>]*role="tabpanel"/u.test(settingsScreen)
  && /id="settingsDialog"[^>]*role="tabpanel"/u.test(settingsScreen));

check("T176 About names the product Insist, for Thunderbird, and nothing else",
  /id="aboutProductName">Insist</u.test(aboutPanel)
  && /id="aboutPlatform">for Thunderbird</u.test(aboutPanel)
  && !/Civion Mail|CIVION Mail|Civion Insist/u.test(aboutPanel));

check("T177 the version on About comes from the manifest, never from a literal",
  /function renderAbout\(\)[\s\S]*?messenger\.runtime\.getManifest\(\)[\s\S]*?aboutVersion/u.test(actionCenterNow)
  && !/\d+\.\d+\.\d+/u.test(aboutPanel)
  && /renderAbout\(\);/u.test(actionCenterNow.slice(actionCenterNow.indexOf("async function initialize()"))));

// The full licence is written into the About panel rather than linked: live testing on
// Thunderbird 156 showed that runtime.getURL("LICENSE") — an extensionless resource — is
// offered for download, and connect-src 'none' rules out reading the file at runtime.
// So the text in the page is pinned to the file, byte for byte after HTML unescaping.
const aboutLicenseInPage = (aboutPanel.match(/<pre id="aboutLicenseText">([\s\S]*?)<\/pre>/u) || [])[1];
const unescapeHtml = (text) => String(text || "").replace(/\r\n/gu, "\n").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&amp;/gu, "&");
check("T178 the copyright line is the canon line and the full licence shown is the packaged LICENSE, verbatim and local",
  /Copyright © 2026 Plamen Alexandrov\. All rights reserved\./u.test(aboutPanel)
  && /proprietary/u.test(aboutPanel)
  && aboutLicenseInPage !== undefined
  && unescapeHtml(aboutLicenseInPage).trim() === readFileSync(new URL("../LICENSE", import.meta.url), "utf8").replace(/\r\n/gu, "\n").trim()
  && !/https?:\/\//u.test(aboutPanel)
  // No "Third-party notices" section: the package carries no third-party material. The
  // licence text itself mentions third-party terms, which is not a section.
  && !/<h2>[^<]*third-party[^<]*<\/h2>|<summary>[^<]*third-party[^<]*<\/summary>/iu.test(aboutPanel)
  && !/tabs\.create|runtime\.getURL\("LICENSE"\)|aboutLicenseLink/u.test(actionCenterNow)
  && /connect-src 'none'/u.test(manifest.content_security_policy.extension_pages));

const licenseText = readFileSync(new URL("../LICENSE", import.meta.url), "utf8").replace(/\r\n/gu, "\n");
check("T179 LICENSE at the root is the standard Civion proprietary notice, warranty clause included",
  licenseText.startsWith("Civion Proprietary License\nCopyright © 2026 Plamen Alexandrov. All rights reserved.\n")
  && /No permission is granted to copy, modify, adapt, merge, publish, distribute, sublicense, sell, lease, make available, or use the source code or other Civion-owned materials without explicit written permission from the copyright holder\./u.test(licenseText)
  && /THE SOFTWARE AND MATERIALS ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND/u.test(licenseText)
  && /Any permission, commercial license or other authorization must be granted explicitly in writing by the copyright holder\./u.test(licenseText)
  && !/\bMIT License|Apache License|GNU General Public|open source/iu.test(licenseText));

// ---- 0.8.4: the transport says why it ended, and the state is named (029 §3.2–3.6, §5.11–18) ----

check("T180 port.error is classified into the closed set, and the platform's text is not kept",
  classifyDisconnect(null) === DISCONNECT_REASONS.DISCONNECT_NO_REASON
  && classifyDisconnect({ error: null }) === DISCONNECT_REASONS.DISCONNECT_NO_REASON
  && classifyDisconnect({ error: { message: "No such native application nl.civion.desktop" } }) === DISCONNECT_REASONS.HOST_NOT_FOUND
  && classifyDisconnect({ message: "No such native application nl.civion.desktop" }) === DISCONNECT_REASONS.HOST_NOT_FOUND
  && classifyDisconnect({ error: { message: "An unexpected error occurred" } }) === DISCONNECT_REASONS.HOST_DISCONNECTED
  && classifyDisconnect({ error: { message: "Native application tried to send a message of 2000000 bytes, which exceeds the limit of 1048576 bytes." } }) === DISCONNECT_REASONS.UNCLASSIFIED
  && classifyDisconnect({ error: { message: "Attempt to postMessage on disconnected port" } }) === DISCONNECT_REASONS.UNCLASSIFIED
  && classifyDisconnect("something nobody has seen before") === DISCONNECT_REASONS.UNCLASSIFIED
  && Object.keys(DISCONNECT_REASONS).length === 4
  && (() => {
    const detail = sanitizeDisconnectDetail(`File at path "C:\\Users\\someone\\AppData\\Roaming\\Thunderbird\\Profiles\\abc.default\\host.exe" does not exist, or is not a normal file ${"x".repeat(400)}`);
    return !/Users|Profiles|AppData|C:\\/u.test(detail) && detail.includes("<path>") && detail.length <= 120;
  })()
  && !/Users|\/home\//u.test(sanitizeDisconnectDetail("Executable not found: /home/someone/.thunderbird/host")));

{
  // Reason and typed code on the error itself; the message carries the reason token,
  // never the platform text.
  const h = harness();
  const pending = settled(h.runtime.send(envelopeOf(1)));
  h.last().drop({ message: 'No such native application nl.civion.desktop C:\\Users\\x\\profile' });
  const result = await pending;
  check("T181 the typed code and the classified reason travel on the error, and the raw text does not",
    !result.ok
    && result.error.code === "MAIL_RUNTIME_DISCONNECTED"
    && result.error.reason === DISCONNECT_REASONS.HOST_NOT_FOUND
    && !/Users|C:\\/u.test(result.error.message)
    && !/Users|C:\\/u.test(result.error.detail)
    && h.events.some((e) => e.type === "disconnected" && e.reason === DISCONNECT_REASONS.HOST_NOT_FOUND)
    && new MailRuntimeTimeoutError("x").code === "MAIL_RUNTIME_TIMEOUT"
    && new MailRuntimeProtocolError("x").code === "MAIL_RUNTIME_PROTOCOL_ERROR"
    && new MailRuntimeDisconnectedError("x", { reason: "made-up" }).reason === DISCONNECT_REASONS.UNCLASSIFIED,
    `${result.error?.code} ${result.error?.reason} ${result.error?.message}`);
}

const bgNow = readFileSync(new URL("../background.js", import.meta.url), "utf8");
check("T182 the typed code reaches the bridge metrics and the metrics shape the host validates is unchanged",
  /function bridgeFailure\(error, fallbackCode\)/u.test(bgNow)
  && /recordBridgeEvent\("failed", \{ \.\.\.bridgeFailure\(error, "STATUS_NATIVE_FAILED"\), probe: true \}\)/u.test(bgNow)
  && /recordBridgeEvent\("failed", bridgeFailure\(error, "RECORD_NATIVE_FAILED"\)\)/u.test(bgNow)
  && /recordBridgeEvent\("failed", bridgeFailure\(error, "BACKFILL_NATIVE_FAILED"\)\)/u.test(bgNow)
  && /error\.code = response\?\.error_code \? String\(response\.error_code\) : "NATIVE_HOST_REJECTED";/u.test(bgNow)
  && (() => {
    const body = bgNow.slice(bgNow.indexOf("function bridgeMetrics(metadata)"), bgNow.indexOf("async function recordBridgeEvent"));
    const keys = [...body.matchAll(/^\s{4}(\w+):/gmu)].map((m) => m[1]);
    return keys.join(",") === "version,emittedCount,backfillCount,failureCount,lastFailureCode";
  })()
  && /context: event\.reason \? `reason=\$\{event\.reason\}` : ""/u.test(bgNow));

check("T183 the startup probe is kept, its projection is recorded, and there is no second probe",
  /messenger\.runtime\?\.onStartup,[\s\S]*?const desktopAvailable = await emitDesktopBridgeStatus\("startup"\);\s*if \(desktopAvailable\) await emitDesktopEvidenceBackfill\("startup"\);/u.test(bgNow)
  && /async function emitDesktopBridgeStatus\(event = "startup"\) \{\s*await recordBridgeEvent\("probe", \{ event \}\);/u.test(bgNow)
  && /await recordBridgeEvent\("probe-ok"\);/u.test(bgNow)
  && (bgNow.match(/async function emitDesktopBridgeStatus/gu) || []).length === 1
  && !/alarms\.|setInterval\(/u.test(bgNow)
  && /bridge\.lastProbeAt = at;[\s\S]*?bridge\.lastProbeOutcome = null;/u.test(bgNow)
  && /bridge\.lastFailureReason = detail\.reason \? String\(detail\.reason\)\.slice\(0, 40\) : null;/u.test(bgNow));

{
  // The port came back from connectNative and died before anything was posted — a
  // missing registration looks exactly like this. The package is failed with the
  // reason, the runtime is OFF, and the next send opens a fresh port.
  let handed = null;
  const h = harness({ connect: () => { handed = fakePort(); return handed; } });
  const pending = settled(h.runtime.send(envelopeOf(1)));
  handed.drop({ message: "No such native application nl.civion.desktop" });
  const result = await pending;
  const firstPort = handed;
  const next = settled(h.runtime.send(envelopeOf(2)));
  check("T184 an immediate disconnect after connectNative returned a port fails the package with its reason and leaves nothing pending",
    !result.ok && result.error.reason === DISCONNECT_REASONS.HOST_NOT_FOUND
    && firstPort.disconnected && handed !== firstPort
    && h.runtime.isOpen() && h.runtime.pendingCount() === 1,
    `${result.error?.reason} open=${h.runtime.isOpen()} pending=${h.runtime.pendingCount()}`);
  handed.answer({ ok: true, state: "spooled", message_id: handed.posted[0].message_id });
  const delivered = await next;
  check("T185 the fresh session after that disconnect is acknowledged normally",
    delivered.ok && delivered.value.state === "spooled");
}

{
  // Isolation: an old port that speaks after its session died cannot touch the new one.
  const h = harness();
  const first = settled(h.runtime.send(envelopeOf(1)));
  const oldPort = h.last();
  const oldId = oldPort.posted[0].message_id;
  oldPort.drop();
  await first;
  const second = settled(h.runtime.send(envelopeOf(2)));
  const newPort = h.last();
  const eventsBefore = h.events.length;
  // The old port answers the id it was never allowed to settle, and then an unknown one.
  oldPort.answer({ ok: true, state: "spooled", message_id: oldId });
  oldPort.answer({ ok: true, state: "spooled", message_id: "civion-stray" });
  check("T186 a dead session's port cannot settle or fail the new session",
    h.runtime.isOpen() && h.runtime.pendingCount() === 1 && !newPort.disconnected
    && h.events.slice(eventsBefore).every((e) => e.type === "protocol-error"),
    `open=${h.runtime.isOpen()} pending=${h.runtime.pendingCount()} events=${h.events.slice(eventsBefore).map((e) => e.type).join(",")}`);
  newPort.answer({ ok: true, state: "spooled", message_id: newPort.posted[0].message_id });
  const delivered = await second;
  check("T187 the new session is acknowledged normally after the old port spoke",
    delivered.ok && delivered.value.state === "spooled" && h.runtime.pendingCount() === 0);
}

{
  // The settledByTimeout boundary. The set remembers the 100 most recent timed-out ids
  // so that a late answer for one of them is dropped quietly. The 101st timeout evicts
  // the oldest. A late answer for an evicted id is then indistinguishable from an
  // answer nobody asked for, and it is treated as one: a protocol error that fails the
  // session, which the next send reopens. That is the deliberate behaviour — bounded
  // memory, and an unattributable answer never guessed at — and this is where it is
  // written down.
  const h = harness();
  const port = h.last() || (h.runtime.ensureOpen(), h.last());
  const ids = [];
  const pendings = [];
  for (let index = 0; index < 101; index += 1) {
    pendings.push(settled(h.runtime.send(envelopeOf(index))));
    ids.push(port.posted[index].message_id);
  }
  h.timers.fireAll();
  const results = await Promise.all(pendings);
  const allTimedOut = results.every((r) => !r.ok && r.error instanceof MailRuntimeTimeoutError);
  // The second-oldest is still remembered: dropped quietly.
  port.answer({ ok: true, state: "spooled", message_id: ids[1] });
  const quiet = h.runtime.isOpen() && h.events.some((e) => e.type === "late-acknowledgement" && e.messageId === ids[1]);
  // The oldest was evicted by the 101st timeout: a very late answer for it is a
  // protocol error and fails the session.
  port.answer({ ok: true, state: "spooled", message_id: ids[0] });
  const failedAsProtocolError = !h.runtime.isOpen()
    && h.events.some((e) => e.type === "protocol-error" && e.messageId === ids[0]);
  const next = settled(h.runtime.send(envelopeOf(999)));
  const fresh = h.last();
  fresh.answer({ ok: true, state: "spooled", message_id: fresh.posted[0].message_id });
  const recovered = await next;
  check("T188 the timed-out set keeps the 100 most recent ids; a late answer for an evicted id is a protocol error, and the session reopens",
    allTimedOut && quiet && failedAsProtocolError && fresh !== port && recovered.ok && h.runtime.isOpen(),
    `timedOut=${allTimedOut} quiet=${quiet} evicted=${failedAsProtocolError} reopened=${recovered.ok}`);
}

// The four bridge states, derived from the recorded counters, and how Self Check maps them.
const BRIDGE_CASES = {
  never: {},
  inFlight: { lastProbeAt: "2026-09-18T20:00:00.000Z", lastProbeEvent: "startup", lastProbeOutcome: null },
  ok: { lastProbeAt: "2026-09-18T20:00:00.000Z", lastProbeOutcome: "ok", lastContactAt: "2026-09-18T20:00:01.000Z", lastFailureAt: "2026-09-18T19:00:00.000Z", lastFailureCode: "MAIL_RUNTIME_TIMEOUT", emittedCount: 3, failureCount: 1 },
  failed: { lastProbeAt: "2026-09-18T20:00:00.000Z", lastProbeOutcome: "failed", lastContactAt: "2026-09-18T19:00:00.000Z", lastFailureAt: "2026-09-18T20:00:02.000Z", lastFailureCode: "MAIL_RUNTIME_DISCONNECTED", lastFailureReason: "HOST_NOT_FOUND", failureCount: 4 },
  legacy: { emittedCount: 7, lastEmittedAt: "2026-09-13T10:00:00.000Z" },
  attemptedNoOutcome: { lastProbeAt: "not a date", lastProbeOutcome: "ok" }
};

check("T189 the bridge state is one of four named states, and unknown is never success",
  deriveBridgeState(BRIDGE_CASES.never).state === BRIDGE_STATES.NEVER_ATTEMPTED
  && deriveBridgeState(undefined).state === BRIDGE_STATES.NEVER_ATTEMPTED
  && deriveBridgeState(BRIDGE_CASES.inFlight).state === BRIDGE_STATES.INDETERMINATE
  && deriveBridgeState(BRIDGE_CASES.ok).state === BRIDGE_STATES.OK
  && deriveBridgeState(BRIDGE_CASES.ok).since === "2026-09-18T20:00:01.000Z"
  && deriveBridgeState(BRIDGE_CASES.failed).state === BRIDGE_STATES.FAILED
  && deriveBridgeState(BRIDGE_CASES.failed).lastFailureReason === "HOST_NOT_FOUND"
  && deriveBridgeState(BRIDGE_CASES.legacy).state === BRIDGE_STATES.OK
  && deriveBridgeState(BRIDGE_CASES.attemptedNoOutcome).state === BRIDGE_STATES.INDETERMINATE
  && ["confirmed", "alert", "suggested", "suggested"].join() === [BRIDGE_CASES.ok, BRIDGE_CASES.failed, BRIDGE_CASES.never, BRIDGE_CASES.inFlight].map((c) => deriveBridgeState(c).role).join()
  && Object.values(BRIDGE_STATES).every((state) => deriveBridgeState({}).label.length > 0 && typeof state === "string"));

const diagnosticsSource = readFileSync(new URL("../modules/diagnostics.mjs", import.meta.url), "utf8");
check("T190 Self Check has a separate transport check with the four states, and the Thunderbird runtime check is untouched",
  bridgeCheck({ desktopBridge: BRIDGE_CASES.never }).status === "warn"
  && bridgeCheck({ desktopBridge: BRIDGE_CASES.inFlight }).status === "warn"
  && bridgeCheck({ desktopBridge: BRIDGE_CASES.ok }).status === "pass"
  && bridgeCheck({ desktopBridge: BRIDGE_CASES.failed }).status === "fail"
  && bridgeCheck({}).bridgeState === BRIDGE_STATES.NEVER_ATTEMPTED
  && bridgeCheck({ desktopBridge: BRIDGE_CASES.failed }).failureReason === "HOST_NOT_FOUND"
  && bridgeCheck({ desktopBridge: BRIDGE_CASES.failed }).id === "bridge"
  && /checks\.push\(check\("runtime", "Thunderbird runtime", "pass", `\$\{browserInfo\.name \|\| "Thunderbird"\} \$\{browserInfo\.version \|\| "unknown"\}`\)\);/u.test(diagnosticsSource)
  && /checks\.push\(bridgeCheck\(metadata\)\);/u.test(diagnosticsSource));

const bridgeViewSource = readFileSync(new URL("../action-center/views-bridge.mjs", import.meta.url), "utf8");
const systemScreen = markupR005Now.slice(markupR005Now.indexOf('data-screen="system"'), markupR005Now.indexOf('data-screen="settings"'));
check("T191 System → Bridge is a fourth tab fed by the published state, with a text label for every state",
  (systemScreen.match(/role="tab"/gu) || []).length === 4
  && /data-view="bridge"[^>]*role="tab"/u.test(systemScreen)
  && /id="bridgePanel"[^>]*role="tabpanel"/u.test(systemScreen)
  && /id="bridgeStateChip"/u.test(systemScreen)
  && /addEventListener\("civion:state"/u.test(bridgeViewSource)
  && /from "\.\.\/modules\/bridge-state\.mjs"/u.test(bridgeViewSource)
  && !/messenger\./u.test(bridgeViewSource)
  && !/send\(/u.test(bridgeViewSource)
  && /chip\.textContent = bridge\.label/u.test(bridgeViewSource)
  && /Mail domain/u.test(systemScreen.slice(systemScreen.indexOf('id="bridgePanel"')))
  && /views-bridge\.mjs/u.test(markupR005Now));

// ---- 0.8.4: the rename is bounded (029 §3.7) ----

const popupMarkup = readFileSync(new URL("../popup/index.html", import.meta.url), "utf8");
const federationSource = readFileSync(new URL("../modules/federation.mjs", import.meta.url), "utf8");
check("T192 the visible product name is Insist: manifest, actions, command, Action Center title, popup, menus, space",
  manifest.name === "Insist"
  && manifest.action.default_title === "Insist — Open controls"
  && manifest.action.default_label === "Insist"
  && manifest.message_display_action.default_title === "Insist — Analyze this message"
  && manifest.message_display_action.default_label === "Insist"
  && manifest.commands._execute_action.description === "Open Insist controls"
  && /<title>Insist — Action Center<\/title>/u.test(markupR005Now)
  && /<title>Insist<\/title>/u.test(popupMarkup) && /<h1>Insist<\/h1>/u.test(popupMarkup)
  && /title: "Insist — Open Action Center", contexts: \["tools_menu"\]/u.test(bgNow)
  && /title: "Insist — Analyze selected message", contexts: \["message_list"\]/u.test(bgNow)
  && (bgNow.match(/title: "Insist",/gu) || []).length === 2
  && !/CIVION Mail|Civion Mail/u.test(JSON.stringify([manifest.name, manifest.action, manifest.message_display_action, manifest.commands])));

check("T193 the stable identifiers, the tag labels and the contract fields did not move with the name",
  manifest.browser_specific_settings.gecko.id === "mail-sentinel@local.invalid"
  && /const DESKTOP_NATIVE_HOST = "nl\.civion\.desktop";/u.test(bgNow)
  && /const DESKTOP_NATIVE_CONTRACT = "CIVION_DESKTOP_MAIL_NATIVE";/u.test(bgNow)
  && /const DESKTOP_BRIDGE_VERSION = "0\.2";/u.test(bgNow)
  && /exportFormat: "CIVION_MAIL_BRIDGE_STATUS"/u.test(bgNow)
  && /Critical: \{ key: "mail-sentinel-critical", label: "CIVION Mail — Critical"/u.test(bgNow)
  && /"No Action": \{ key: "mail-sentinel-no-action", label: "CIVION Mail — No Action"/u.test(bgNow)
  && /source_project: "CIVION Mail"/u.test(federationSource)
  && /current_module: "CIVION Mail"/u.test(federationSource)
  && /mailSentinelSettings/u.test(storageSource)
  && MAIL_RUNTIME_CONTRACT_VERSION === 2
  && manifest.permissions.join() === "accountsRead,messagesRead,messagesDelete,messagesUpdate,messagesTags,messagesTagsList,storage,menus,nativeMessaging"
  && !("host_permissions" in manifest)
  && manifest.content_security_policy.extension_pages.includes("connect-src 'none'"));

// The rail wordmark is the product identity a person sees on every screen. It shipped as
// "CIVION" in the first 0.8.4 candidate and was caught live (033 §7). The wordmark is
// Insist and the old product-brand wordmark cannot come back; the remaining CIVION
// strings in the live markup are the archive path, the Desktop bridge label and the
// candidate export to the Civion system, and each is named here so a new one is noticed.
const liveMarkupNow = readFileSync(new URL("../action-center/index.r005.html", import.meta.url), "utf8");
const wordmarks = [...liveMarkupNow.matchAll(/<div class="wordmark">([^<]*)<\/div>/gu)].map((m) => m[1].trim());
const visibleCivion = [...liveMarkupNow.replace(/<!--[\s\S]*?-->/gu, "").matchAll(/>([^<]*\bCIVION\b[^<]*)</gu)].map((m) => m[1].trim());
check("T194 the rail wordmark is Insist, and CIVION remains only as a path, the Desktop bridge or the Civion destination",
  wordmarks.length === 1 && wordmarks[0] === "Insist"
  && !/class="wordmark">\s*CIVION/u.test(liveMarkupNow)
  && visibleCivion.length > 0
  && visibleCivion.every((text) => /F:\\01_ARCHIVE\\CIVION|CIVION Desktop bridge|CIVION candidate export/u.test(text))
  && !/CIVION Mail/u.test(liveMarkupNow.replace(/<pre id="aboutLicenseText">[\s\S]*?<\/pre>/u, "")),
  JSON.stringify({ wordmarks, visibleCivion }));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
