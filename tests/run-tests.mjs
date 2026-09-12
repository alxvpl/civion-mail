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
import {
  MAIL_RUNTIME_CONTRACT_VERSION,
  MailRuntimeDisconnectedError,
  MailRuntimeProtocolError,
  MailRuntimeTimeoutError,
  createCorrelationId,
  createMailRuntime,
  isValidCorrelationId
} from "../modules/mail-runtime.mjs";

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
const markup = readFileSync(new URL("../action-center/index.html", import.meta.url), "utf8");

check("T21 the 'ready' empty state is suppressed whenever records are held",
  /elements\.emptyState\.hidden = records\.length !== 0 \|\| holdsRecords;/u.test(actionCenter)
  && /elements\.filteredEmptyState\.hidden = records\.length !== 0 \|\| !holdsRecords;/u.test(actionCenter));

check("T22 clearing filters returns the source filter to its default rather than widening it",
  /function clearFilters\(\)[\s\S]*?elements\.sourceFilter\.value = "available";/u.test(actionCenter)
  && /function showAllRetainedRecords\(\)[\s\S]*?elements\.sourceFilter\.value = "all";/u.test(actionCenter));

check("T23 the disclosure bar announces changes to assistive technology",
  /<div aria-live="polite" class="filter-status"/u.test(markup));

const topbarButtons = [...markup.matchAll(/<button class="([a-z-]+)" id="(civionExportButton|historicalScanButton|exportButton|diagnosticsButton|settingsButton)"/gu)]
  .reduce((acc, match) => ({ ...acc, [match[2]]: match[1] }), {});
check("T24 topbar commands carry three distinct weights",
  topbarButtons.civionExportButton === "primary-button"
  && topbarButtons.historicalScanButton === "menu-item"
  && topbarButtons.exportButton === "menu-item"
  && topbarButtons.diagnosticsButton === "quiet-button"
  && topbarButtons.settingsButton === "quiet-button",
  JSON.stringify(topbarButtons));

const styles = readFileSync(new URL("../action-center/styles.css", import.meta.url), "utf8");
check("T25 the third button weight is defined and uses existing tokens only",
  /\.quiet-button \{/u.test(styles)
  && !/#[0-9a-f]{3,6}/iu.test(styles.slice(styles.indexOf(".quiet-button {"), styles.indexOf(".topbar-divider"))));

// cacheElements() throws on the first missing id and takes the whole panel down with it,
// so every id it requests must exist exactly once in the markup.
const cacheBlock = actionCenter.slice(actionCenter.indexOf("function cacheElements()"));
const requestedIds = [...cacheBlock.slice(0, cacheBlock.indexOf("]")).matchAll(/"([A-Za-z][\w-]*)"/gu)].map((m) => m[1]);
const markupIds = [...markup.matchAll(/\sid="([^"]+)"/gu)].map((m) => m[1]);
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

check("T40 an unevaluable gate fails closed rather than admitting",
  /let admission = \{ admitted: false/u.test(bg)
  && /JUNK_ADMISSION_EVALUATION_FAILED/u.test(bg));

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
  manifest.version === "0.8.2"
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

check("T58 all-account scope is fixed to recommended normal folders with no date or message limit",
  /accounts\.flatMap\(\(account\) => account\.folders[\s\S]*?\.filter\(\(folder\) => folder\.recommended\)/u.test(bg)
  && /No date or message limit\./u.test(actionCenter));

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
    drop() { for (const fn of listeners.disconnect) fn(); }
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
  && !/means no limit/u.test(markup));

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

// Every chip app.js builds must carry the r005 base class and a tone, or the record rows
// render as bare text under the r005 stylesheet.
check("T126 every chip carries the r005 base class and a tone",
  /if \(!parts\.includes\("chip"\)\) parts\.push\("chip"\)/u.test(actionCenter)
  && /const CHIP_TONE = \{/u.test(actionCenter));

// A panel can be reached two ways now: the Operations menu, and navigating to it. Both
// have to load the same data, so loading is separate from opening and the shell fires
// "show" on arrival. Without this, System → Historical Scan showed an empty folder tree.
check("T127 panels load their data on arrival, not only when opened from the menu",
  /async function loadHistoricalScanPanel\(\)/u.test(actionCenter)
  && /async function loadArchiveExistingPanel\(\)/u.test(actionCenter)
  && (actionCenter.match(/addEventListener\("show"/gu) || []).length === 3
  && /dispatchEvent\(new Event\("show"\)\)/u.test(shellSource));

check("T128 the manifest opens the r005 shell",
  manifest.options_ui.page === "action-center/index.r005.html");

// The shell must not grow a second copy of the record logic. It routes and it themes.

check("T124 the shell owns navigation only — no record state, no messenger calls",
  !/messenger\./u.test(shellSource) && !/records/u.test(shellSource.replace(/data-screen="records"|go\("records"\)|"records"/gu, "")));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
