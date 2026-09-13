import { analyzeMessage, CATEGORY_ORDER, PRIORITIES, listAuthservIds, evaluateSenderAdmissionSignals } from "./modules/analyzer.mjs";
import { evaluateJunkAdmission } from "./modules/junk-admission.mjs";
import { RELATIONSHIP_CLASSES, DOCUMENT_TYPES, RETENTION_CLASSES } from "./modules/semantic-model.mjs";
import { buildCivionMailPackage } from "./modules/federation.mjs";
import {
  createLocalRulesProvider,
  executeAnalysisProvider,
  providerState
} from "./modules/providers/provider-contract.mjs";
import { extractMessageData, flattenMessagePages, iterateMessagePages } from "./modules/message-tools.mjs";
import { availableSourceRecords } from "./modules/source-state.mjs";
import { isNormalArchiveFolder } from "./modules/archive-backfill.mjs";
import { createMailRuntime } from "./modules/mail-runtime.mjs";
import {
  DOCUMENT_ARCHIVE_CONTRACT,
  DOCUMENT_ARCHIVE_MAX_BYTES,
  DOCUMENT_ARCHIVE_ROOT,
  buildDocumentArchivePackage,
  buildDocumentArchivePlans
} from "./modules/document-archive.mjs";
import { runSelfCheck, sanitizeDiagnosticReport } from "./modules/diagnostics.mjs";
import {
  SCHEMA_VERSION,
  clearClosedRecords,
  findRecord,
  findMatchingRecord,
  findRecordsByHeaderMessageId,
  getRecords,
  getSettings,
  recordAuthservObservations,
  getAuthservObservations,
  getState,
  logDiagnostic,
  patchRecord,
  patchRecordSystem,
  removeRecord,
  saveRecord,
  setSettings,
  updateTechnicalByIdentity,
  updateMetadata,
  clearDiagnostics,
  getRecoverySnapshot,
  invalidateRuntimeMessageIds
} from "./modules/storage.mjs";

const localRulesProvider = createLocalRulesProvider(analyzeMessage);

const SPACE_NAME = "mail_sentinel_action_center";
const ACTION_CENTER_PATH = "action-center/index.html";
const MENU_IDS = Object.freeze({
  openTools: "mail-sentinel-open-tools",
  analyzeTools: "mail-sentinel-analyze-tools",
  openMessage: "mail-sentinel-open-message",
  analyzeMessage: "mail-sentinel-analyze-message"
});
const CLOSED_STATUSES = new Set(["Completed", "Dismissed"]);
const VALID_STATUSES = new Set(["New", "Reviewed", "In Progress", "Waiting", "Completed", "Dismissed"]);

let accountLabelCache = { at: 0, labels: {} };

const PRIORITY_TAGS = Object.freeze({
  Critical: { key: "mail-sentinel-critical", label: "CIVION Mail — Critical", color: "#B71C1C" },
  High: { key: "mail-sentinel-high", label: "CIVION Mail — High", color: "#D35400" },
  Medium: { key: "mail-sentinel-medium", label: "CIVION Mail — Medium", color: "#C28B00" },
  Low: { key: "mail-sentinel-low", label: "CIVION Mail — Low", color: "#397A46" },
  "No Action": { key: "mail-sentinel-no-action", label: "CIVION Mail — No Action", color: "#667085" }
});

let actionCenterSpaceId = null;
let analysisQueue = Promise.resolve();
let runtimeMessageIdsInvalidated = false;
const listenerState = {
  newMail: false,
  moved: false,
  deleted: false,
  runtimeMessages: false,
  installed: false,
  startup: false,
  action: false,
  menus: false,
  registeredAt: null,
  errors: []
};

const HISTORICAL_SCAN_BATCH_SIZE = 10;
const HISTORICAL_SCAN_MAX_MESSAGES = 50000;
const DESKTOP_NATIVE_HOST = "nl.civion.desktop";
const DESKTOP_NATIVE_INBOX = "mail-native-inbox";
const DESKTOP_BRIDGE_VERSION = "0.2";
const DESKTOP_NATIVE_CONTRACT = "CIVION_DESKTOP_MAIL_NATIVE";
// Base64 and the Native Messaging JSON envelope must remain below the host's
// 25 MiB exact-package boundary, so raw RFC822 evidence is capped at 18 MiB.
const DESKTOP_EVIDENCE_MAX_BYTES = 18 * 1024 * 1024;

function safeBridgeToken(value, fallback = "record") {
  const token = String(value || "").trim().replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return (token || fallback).slice(0, 96);
}

function bridgeTimestamp(value = new Date()) {
  return value.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
}

// The Downloads spool was the pre-0.6.2 transport. Since the Desktop-owned Native
// Messaging host became the transport, nothing called downloadBridgePayload, so the
// extension asked for the downloads permission without ever exercising it. Removing
// the function and the permission makes the write boundary a property of the package:
// the add-on prepares candidates, the Desktop layer validates and writes.
// Action Center exports are unaffected — they use an anchor download, which needs no
// permission at all.

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function sha256Bytes(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes) {
  const view = new Uint8Array(bytes);
  const chunks = [];
  for (let offset = 0; offset < view.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...view.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join(""));
}

// ---------------------------------------------------------------------------
// CIVION Mail Runtime
//
// One native connection serves a whole Thunderbird session: it opens when
// CIVION Mail starts and it ends when Thunderbird closes, at which point the
// host sees the end of its input stream and stops.
//
// The protocol and its failure behaviour live in modules/mail-runtime.mjs so
// that they can be executed and tested; background.js cannot be loaded outside
// Thunderbird. This file only wires the runtime to Thunderbird's native port.
// ---------------------------------------------------------------------------
const civionMailRuntime = createMailRuntime({
  connect: () => {
    if (!messenger.runtime?.connectNative) {
      throw new Error("Thunderbird Native Messaging is unavailable");
    }
    return messenger.runtime.connectNative(DESKTOP_NATIVE_HOST);
  },
  onEvent: (event) => {
    if (event.type === "opened") return;
    void logDiagnostic("warning", `MAIL_RUNTIME_${event.type.replace(/-/gu, "_").toUpperCase()}`, {
      messageId: event.messageId ?? null
    });
  }
});

function ensureCivionMailRuntime() {
  try {
    civionMailRuntime.ensureOpen();
    return true;
  } catch (error) {
    return false;
  }
}

async function sendNativePackage(contract, payload, filename) {
  const packageJson = JSON.stringify(payload, null, 2);
  const packageSha256 = await sha256Hex(packageJson);
  const response = await civionMailRuntime.send({
    contract,
    filename,
    packageJson,
    packageSha256
  });
  return { response, packageSha256 };
}

async function sendNativeBridgePayload(payload, filename) {
  const { response, packageSha256 } = await sendNativePackage(DESKTOP_NATIVE_CONTRACT, payload, filename);
  if (!response || response.ok !== true || response.package_sha256 !== packageSha256) {
    throw new Error(String(response?.error_code || response?.message || "Native host rejected the package"));
  }
  return response;
}

async function sendNativeArchivePayload(payload, filename) {
  let response;
  let packageSha256;
  try {
    ({ response, packageSha256 } = await sendNativePackage(DOCUMENT_ARCHIVE_CONTRACT, payload, filename));
  } catch (cause) {
    const error = new Error(safeError(cause));
    error.code = "ARCHIVE_HOST_UNAVAILABLE";
    throw error;
  }
  if (!response || response.ok !== true || response.package_sha256 !== packageSha256) {
    const error = new Error(String(response?.message || "Native archive host rejected the package"));
    error.code = String(response?.error_code || "ARCHIVE_HOST_REJECTED");
    throw error;
  }
  return response;
}

function archiveErrorState(code) {
  return [
    "ARCHIVE_ROOT_UNAVAILABLE",
    "ARCHIVE_HOST_UNAVAILABLE",
    "ARCHIVE_WRITE_FAILED",
    "ARCHIVE_INDEX_FAILED"
  ].includes(code) ? "pending" : "failed";
}

function archiveOverallState(files) {
  if (!files.length) return "not_applicable";
  const successes = files.filter((file) => ["archived", "already_archived", "restored"].includes(file.state)).length;
  if (successes === files.length) return "archived";
  if (successes) return "partial";
  return files.some((file) => file.state === "pending") ? "pending" : "failed";
}

async function archiveRecordDocuments(record, message, knownAttachments = null, options = {}) {
  const settings = await getSettings();
  if ((!options.force && settings.automaticDocumentArchive === false) || !record || !message?.id) return record;
  let attachments = knownAttachments;
  if (!Array.isArray(attachments)) {
    try {
      const listed = await messenger.messages.listAttachments(message.id);
      attachments = (listed || []).map((attachment) => ({
        name: String(attachment.name || "Unnamed attachment"),
        contentType: String(attachment.contentType || "application/octet-stream"),
        size: Number(attachment.size || 0),
        partName: String(attachment.partName || "")
      }));
    } catch (error) {
      await logDiagnostic("error", "DOCUMENT_ARCHIVE_ATTACHMENT_LIST_FAILED", {
        message: safeError(error), headerMessageId: record.headerMessageId
      });
      return record;
    }
  }
  const plans = buildDocumentArchivePlans(record, attachments);
  if (!plans.length) {
    if (record.documentArchive) return record;
    return await patchRecordSystem(record.id, {
      documentArchive: {
        state: "not_applicable",
        root: DOCUMENT_ARCHIVE_ROOT,
        updatedAt: new Date().toISOString(),
        files: []
      }
    }) || record;
  }

  const previous = new Map((record.documentArchive?.files || []).map((file) => [String(file.partName || ""), file]));
  const results = [];
  for (const plan of plans) {
    const prior = previous.get(plan.attachment.partName);
    try {
      if (!plan.attachment.partName) throw Object.assign(new Error("Attachment part identity is unavailable"), { code: "ARCHIVE_ATTACHMENT_UNAVAILABLE" });
      const file = await messenger.messages.getAttachmentFile(message.id, plan.attachment.partName);
      const bytes = await file.arrayBuffer();
      if (!bytes.byteLength || bytes.byteLength > DOCUMENT_ARCHIVE_MAX_BYTES) {
        throw Object.assign(new Error(`PDF exceeds the ${DOCUMENT_ARCHIVE_MAX_BYTES} byte archive limit`), { code: "ARCHIVE_DOCUMENT_TOO_LARGE" });
      }
      const digest = await sha256Bytes(bytes);
      if (!options.verifyExisting
          && prior?.sha256 === digest
          && ["archived", "already_archived", "restored"].includes(prior.state)) {
        results.push(prior);
        continue;
      }
      const payload = buildDocumentArchivePackage({
        record,
        plan,
        byteLength: bytes.byteLength,
        sha256: digest,
        contentBase64: bytesToBase64(bytes),
        addonVersion: messenger.runtime.getManifest().version
      });
      const response = await sendNativeArchivePayload(
        payload,
        `CIVION_DOCUMENT_${safeBridgeToken(record.id)}_${digest.slice(0, 16)}.json`
      );
      results.push({
        partName: plan.attachment.partName,
        originalFilename: plan.attachment.name,
        state: String(response.state || "archived"),
        sha256: digest,
        relativePath: String(response.relative_path || plan.relativePath),
        errorCode: null
      });
    } catch (error) {
      const code = String(error?.code || "ARCHIVE_DOCUMENT_FAILED");
      results.push({
        partName: plan.attachment.partName,
        originalFilename: plan.attachment.name,
        state: archiveErrorState(code),
        sha256: prior?.sha256 || null,
        relativePath: prior?.relativePath || plan.relativePath,
        errorCode: code
      });
      await logDiagnostic("error", "DOCUMENT_ARCHIVE_FAILED", {
        message: `${code}: ${safeError(error)}`,
        headerMessageId: record.headerMessageId,
        context: plan.attachment.name
      });
    }
  }
  return await patchRecordSystem(record.id, {
    documentArchive: {
      state: archiveOverallState(results),
      root: DOCUMENT_ARCHIVE_ROOT,
      updatedAt: new Date().toISOString(),
      files: results
    }
  }) || record;
}

function bridgeMetrics(metadata) {
  const bridge = metadata?.desktopBridge || {};
  return {
    version: String(bridge.version || "0.1"),
    emittedCount: numberValue(bridge.emittedCount),
    backfillCount: numberValue(bridge.backfillCount),
    failureCount: numberValue(bridge.failureCount),
    lastFailureCode: bridge.lastFailureCode ? String(bridge.lastFailureCode).slice(0, 120) : null
  };
}

async function recordBridgeEvent(event, detail = {}) {
  const at = new Date().toISOString();
  await updateMetadata((metadata) => {
    const bridge = {
      version: DESKTOP_BRIDGE_VERSION,
      emittedCount: 0,
      backfillCount: 0,
      failureCount: 0,
      ...(metadata.desktopBridge || {})
    };
      if (event === "emitted") {
      bridge.emittedCount = numberValue(bridge.emittedCount) + 1;
      bridge.lastEmittedAt = at;
      bridge.lastRecordRef = String(detail.recordRef || "").slice(0, 120);
    } else if (event === "backfill") {
      bridge.backfillCount = numberValue(bridge.backfillCount) + 1;
      bridge.lastBackfillAt = at;
      bridge.lastBackfillAddonVersion = String(detail.addonVersion || "");
      bridge.lastBackfillRecordCount = numberValue(detail.recordCount);
      } else if (event === "failed") {
      bridge.failureCount = numberValue(bridge.failureCount) + 1;
      bridge.lastFailureAt = at;
        bridge.lastFailureCode = String(detail.code || "BRIDGE_EXPORT_FAILED").slice(0, 120);
      }
      bridge.lastTransport = "native_messaging";
    return { ...metadata, desktopBridge: bridge };
  });
}

async function emitDesktopBridgeStatus(event = "startup") {
  const state = await getState();
  const settings = state.settings;
  const addonVersion = messenger.runtime.getManifest().version;
  const payload = {
    exportFormat: "CIVION_MAIL_BRIDGE_STATUS",
    exportVersion: 2,
    generatedAt: new Date().toISOString(),
    addonVersion,
    bridge_version: DESKTOP_BRIDGE_VERSION,
    bridge_enabled: settings.desktopBridgeEnabled !== false,
    transport: "native_messaging_durable_spool",
    relative_spool: DESKTOP_NATIVE_INBOX,
    authority: "candidate_only",
    event: String(event || "startup"),
    source_component: "ThunderbirdExtension",
    bridge_metrics: bridgeMetrics(state.metadata)
  };
  const filename = `CIVION_MAIL_STATUS_${bridgeTimestamp(new Date())}.json`;
  try {
    return await sendNativeBridgePayload(payload, filename);
  } catch (error) {
    await recordBridgeEvent("failed", { code: "STATUS_NATIVE_FAILED" });
    await logDiagnostic("error", "DESKTOP_BRIDGE_STATUS_EXPORT_FAILED", { message: safeError(error) });
    return null;
  }
}

async function emitDesktopBridgeRecord(record) {
  const settings = await getSettings();
  if (settings.desktopBridgeEnabled === false || !record) return null;
  const addonVersion = messenger.runtime.getManifest().version;
  const payload = buildCivionMailPackage([record], addonVersion);
  payload.transport = "native_messaging";
  payload.bridge = {
    bridge_version: DESKTOP_BRIDGE_VERSION,
    delivery: "native_messaging_durable_spool",
    relative_spool: DESKTOP_NATIVE_INBOX,
    authority: "candidate_only"
  };
  const stamp = bridgeTimestamp(new Date());
  const digest = safeBridgeToken(String(record.contentHash || "nohash").slice(0, 16), "nohash");
  const filename = `CIVION_MAIL_${safeBridgeToken(record.id)}_${stamp}_${digest}.json`;
  try {
    const delivery = await sendNativeBridgePayload(payload, filename);
    await recordBridgeEvent("emitted", { recordRef: record.id });
    return delivery;
  } catch (error) {
    await recordBridgeEvent("failed", { code: "RECORD_NATIVE_FAILED" });
    await logDiagnostic("error", "DESKTOP_BRIDGE_RECORD_EXPORT_FAILED", { message: safeError(error) });
    return null;
  }
}

async function emitDesktopSourceEvidence(record, message) {
  const settings = await getSettings();
  if (settings.desktopBridgeEnabled === false || !record || !message?.id) return null;
  if (!messenger.messages?.getRaw) {
    await logDiagnostic("error", "DESKTOP_BRIDGE_SOURCE_EVIDENCE_FAILED", {
      message: "Thunderbird messages.getRaw API is unavailable",
      headerMessageId: record.headerMessageId
    });
    return null;
  }
  try {
    const addonVersion = messenger.runtime.getManifest().version;
    const rawFile = await messenger.messages.getRaw(message.id, {
      data_format: "File",
      decrypt: false
    });
    const bytes = await rawFile.arrayBuffer();
    if (bytes.byteLength > DESKTOP_EVIDENCE_MAX_BYTES) {
      throw new Error(`RFC822 source exceeds ${DESKTOP_EVIDENCE_MAX_BYTES} byte local evidence limit`);
    }
    const digest = await sha256Bytes(bytes);
    if (record.desktopEvidenceSha256 === digest) return null;
    const envelope = buildCivionMailPackage([record], addonVersion).envelopes[0];
    const evidencePackage = {
      exportFormat: "CIVION_MAIL_SOURCE_EVIDENCE",
      exportVersion: 1,
      generatedAt: new Date().toISOString(),
      addonVersion,
      transport: "native_messaging",
      authority: "untrusted_evidence_only",
      source: {
        idempotency_key: envelope.idempotency_key,
        source_message_id: envelope.payload.message.source_message_id,
        source_token: envelope.payload.message.source_token,
        message_id_header: envelope.payload.message.message_id_header
      },
      evidence: {
        format: "rfc822",
        encoding: "base64",
        byte_length: bytes.byteLength,
        sha256: digest,
        content_base64: bytesToBase64(bytes),
        original_filename: `${safeBridgeToken(record.id)}.eml`
      }
    };
    const filename = `CIVION_MAIL_EVIDENCE_${safeBridgeToken(record.id)}_${digest.slice(0, 16)}.json`;
    const delivery = await sendNativeBridgePayload(evidencePackage, filename);
    await patchRecordSystem(record.id, {
      desktopEvidenceSha256: digest,
      desktopEvidenceCapturedAt: new Date().toISOString()
    });
    return delivery;
  } catch (error) {
    await logDiagnostic("error", "DESKTOP_BRIDGE_SOURCE_EVIDENCE_FAILED", {
      message: safeError(error),
      headerMessageId: record.headerMessageId,
      context: record.id
    });
    return null;
  }
}

async function emitDesktopBridgeBackfill(reason = "update") {
  const settings = await getSettings();
  if (settings.desktopBridgeEnabled === false) return null;
  const state = await getState();
  const addonVersion = messenger.runtime.getManifest().version;
  if (state.metadata?.desktopBridge?.lastBackfillAddonVersion === addonVersion) return null;
  const records = Array.isArray(state.records) ? state.records : [];
  if (!records.length) {
    await recordBridgeEvent("backfill", { addonVersion, recordCount: 0 });
    return null;
  }
  const payload = buildCivionMailPackage(records, addonVersion);
  payload.transport = "native_messaging_backfill";
  payload.bridge = {
    bridge_version: DESKTOP_BRIDGE_VERSION,
    delivery: "native_messaging_durable_spool",
    relative_spool: DESKTOP_NATIVE_INBOX,
    authority: "candidate_only",
    backfill_reason: String(reason || "update")
  };
  const filename = `CIVION_MAIL_BACKFILL_${bridgeTimestamp(new Date())}_${records.length}.json`;
  try {
    const delivery = await sendNativeBridgePayload(payload, filename);
    await recordBridgeEvent("backfill", { addonVersion, recordCount: records.length });
    return delivery;
  } catch (error) {
    await recordBridgeEvent("failed", { code: "BACKFILL_NATIVE_FAILED" });
    await logDiagnostic("error", "DESKTOP_BRIDGE_BACKFILL_EXPORT_FAILED", { message: safeError(error) });
    return null;
  }
}

async function emitDesktopEvidenceBackfill(reason = "update") {
  const settings = await getSettings();
  if (settings.desktopBridgeEnabled === false) return { attempted: 0, preserved: 0 };
  const records = await getRecords();
  let attempted = 0;
  let preserved = 0;
  for (const record of records) {
    if ((!record?.currentMessageId && !record?.headerMessageId) || record.desktopEvidenceSha256) continue;
    attempted += 1;
    try {
      // Thunderbird numeric ids are runtime-local and are intentionally
      // invalidated at startup. Resolve again through the stable Message-ID
      // plus the record identity collision guard before reading raw bytes.
      const message = await resolveRecordMessage(record);
      const result = await emitDesktopSourceEvidence(record, message);
      if (result) preserved += 1;
    } catch (error) {
      await logDiagnostic("error", "DESKTOP_BRIDGE_SOURCE_EVIDENCE_FAILED", {
        message: safeError(error),
        headerMessageId: record.headerMessageId,
        context: `${reason}:${record.id}`
      });
    }
  }
  return { attempted, preserved };
}
let historicalScanJob = null;
let archiveExistingJob = null;

function enqueue(work) {
  const run = analysisQueue.then(work, work);
  analysisQueue = run.catch(() => undefined);
  return run;
}

function safeError(error) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}

function actionCenterUrl() {
  return messenger.runtime.getURL(ACTION_CENTER_PATH);
}

async function getAccountLabels() {
  const now = Date.now();
  if (now - accountLabelCache.at < 60000) return accountLabelCache.labels;
  const labels = {};
  try {
    const accounts = await messenger.accounts?.list?.();
    for (const account of Array.isArray(accounts) ? accounts : []) {
      if (!account?.id) continue;
      labels[account.id] = String(account.name || account.type || "Account");
    }
  } catch (error) {
    await logDiagnostic("warning", "ACCOUNT_LABEL_LOOKUP_FAILED", { message: safeError(error) });
  }
  accountLabelCache = { at: now, labels };
  return labels;
}

function registerListener(name, event, listener, ...extraArguments) {
  try {
    if (!event || typeof event.addListener !== "function") {
      throw new Error(`${name} API is unavailable`);
    }
    event.addListener(listener, ...extraArguments);
    listenerState[name] = true;
    return true;
  } catch (error) {
    listenerState[name] = false;
    listenerState.errors.push({ name, message: safeError(error) });
    console.error(`CIVION Mail could not register ${name}:`, error);
    return false;
  }
}

function numberValue(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

async function recordOperationalEvent(event, detail = {}) {
  const at = new Date().toISOString();
  return updateMetadata((metadata) => {
    const operational = {
      backgroundActivationCount: 0,
      initializationCount: 0,
      initializationFailureCount: 0,
      newMailEventCount: 0,
      inboxNewMailEventCount: 0,
      nonInboxEligibleEventCount: 0,
      junkExcludedEventCount: 0,
      junkAnalyzedEventCount: 0,
      junkNotAdmittedMessageCount: 0,
      messagesSeenCount: 0,
      messagesHandledCount: 0,
      analysisFailureCount: 0,
      excludedFolderEventCount: 0,
      movedEventCount: 0,
      movedMessageCount: 0,
      deletedEventCount: 0,
      deletedMessageCount: 0,
      selfCheckCount: 0,
      manualAnalysisCount: 0,
      manualAnalysisFailureCount: 0,
      perAccount: {},
      ...(metadata.operational || {})
    };

    if (event === "backgroundActivated") {
      operational.backgroundActivationCount = numberValue(operational.backgroundActivationCount) + 1;
      operational.lastBackgroundActivatedAt = at;
    } else if (event === "installed") {
      operational.installedAt = operational.installedAt || at;
      operational.lastInstalledEventAt = at;
      operational.lastInstallReason = String(detail.reason || "unknown");
      if (detail.previousVersion) operational.previousVersion = String(detail.previousVersion);
    } else if (event === "startup") {
      operational.lastStartupAt = at;
      operational.startupCount = numberValue(operational.startupCount) + 1;
    } else if (event === "listenersRegistered") {
      operational.listenersRegisteredAt = at;
    } else if (event === "initialized") {
      operational.initializationCount = numberValue(operational.initializationCount) + 1;
      operational.lastInitializationAt = at;
    } else if (event === "initializationFailed") {
      operational.initializationFailureCount = numberValue(operational.initializationFailureCount) + 1;
      operational.lastInitializationFailureAt = at;
    } else if (event === "newMailBatch") {
      operational.newMailEventCount = numberValue(operational.newMailEventCount) + 1;
      if (detail.isInbox) {
        operational.inboxNewMailEventCount = numberValue(operational.inboxNewMailEventCount) + 1;
      } else if (!detail.isJunk && !detail.excluded) {
        operational.nonInboxEligibleEventCount = numberValue(operational.nonInboxEligibleEventCount) + 1;
      }
      if (detail.isJunk && detail.excluded) {
        operational.junkExcludedEventCount = numberValue(operational.junkExcludedEventCount) + 1;
      } else if (detail.isJunk && !detail.excluded) {
        operational.junkAnalyzedEventCount = numberValue(operational.junkAnalyzedEventCount) + 1;
      }
      operational.junkNotAdmittedMessageCount = numberValue(operational.junkNotAdmittedMessageCount)
        + numberValue(detail.notAdmitted);
      operational.messagesSeenCount = numberValue(operational.messagesSeenCount) + numberValue(detail.seen);
      operational.messagesHandledCount = numberValue(operational.messagesHandledCount) + numberValue(detail.handled);
      operational.analysisFailureCount = numberValue(operational.analysisFailureCount) + numberValue(detail.failed);
      operational.lastNewMailEventAt = at;
      if (detail.excluded) {
        operational.excludedFolderEventCount = numberValue(operational.excludedFolderEventCount) + 1;
      }
      const accountId = String(detail.accountId || "unknown");
      const previous = operational.perAccount[accountId] || {};
      operational.perAccount = {
        ...operational.perAccount,
        [accountId]: {
          newMailEvents: numberValue(previous.newMailEvents) + 1,
          messagesSeen: numberValue(previous.messagesSeen) + numberValue(detail.seen),
          messagesAnalyzed: numberValue(previous.messagesAnalyzed) + numberValue(detail.handled),
          analysisFailures: numberValue(previous.analysisFailures) + numberValue(detail.failed),
          excludedFolderEvents: numberValue(previous.excludedFolderEvents) + (detail.excluded ? 1 : 0),
          lastEventAt: at
        }
      };
    } else if (event === "movedBatch") {
      operational.movedEventCount = numberValue(operational.movedEventCount) + 1;
      operational.movedMessageCount = numberValue(operational.movedMessageCount) + numberValue(detail.count);
      operational.lastMovedEventAt = at;
    } else if (event === "deletedBatch") {
      operational.deletedEventCount = numberValue(operational.deletedEventCount) + 1;
      operational.deletedMessageCount = numberValue(operational.deletedMessageCount) + numberValue(detail.count);
      operational.lastDeletedEventAt = at;
    } else if (event === "selfCheck") {
      operational.selfCheckCount = numberValue(operational.selfCheckCount) + 1;
      operational.lastSelfCheckAt = at;
      operational.lastSelfCheckStatus = String(detail.status || "unknown");
    } else if (event === "manualAnalysis") {
      operational.manualAnalysisCount = numberValue(operational.manualAnalysisCount) + numberValue(detail.handled);
      operational.manualAnalysisFailureCount = numberValue(operational.manualAnalysisFailureCount) + numberValue(detail.failed);
      operational.lastManualAnalysisAt = at;
    } else if (event === "acceptanceReset") {
      const preserved = {
        installedAt: operational.installedAt,
        lastInstalledEventAt: operational.lastInstalledEventAt,
        lastInstallReason: operational.lastInstallReason,
        previousVersion: operational.previousVersion
      };
      return {
        operational: {
          ...preserved,
          acceptanceResetAt: at,
          startupCount: 0,
          backgroundActivationCount: 0,
          initializationCount: 0,
          initializationFailureCount: 0,
          newMailEventCount: 0,
          inboxNewMailEventCount: 0,
          nonInboxEligibleEventCount: 0,
          junkExcludedEventCount: 0,
          junkAnalyzedEventCount: 0,
          messagesSeenCount: 0,
          messagesHandledCount: 0,
          analysisFailureCount: 0,
          excludedFolderEventCount: 0,
          movedEventCount: 0,
          movedMessageCount: 0,
          deletedEventCount: 0,
          deletedMessageCount: 0,
          selfCheckCount: 0,
          manualAnalysisCount: 0,
          manualAnalysisFailureCount: 0,
          perAccount: {}
        }
      };
    }

    return { operational };
  });
}

function hashText(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function messageReceivedAt(message) {
  return message.date instanceof Date
    ? message.date.toISOString()
    : new Date(message.date || 0).toISOString();
}

function makeIdentityKey(message, folder) {
  return [
    folder?.accountId || message.folder?.accountId || "",
    message.headerMessageId || "",
    messageReceivedAt(message),
    message.author || "",
    message.subject || ""
  ].join("|");
}

function makeRecordId(message, folder) {
  return `ms-${hashText(makeIdentityKey(message, folder))}`;
}

function folderSpecialUses(folder) {
  if (!folder) return [];
  if (Array.isArray(folder.specialUse)) return folder.specialUse.map((value) => String(value).toLowerCase());
  if (folder.specialUse) return [String(folder.specialUse).toLowerCase()];
  return [];
}

async function shouldAnalyzeFolder(folder) {
  const settings = await getSettings();
  const specialUse = folderSpecialUses(folder);
  if (specialUse.some((value) => ["trash", "sent", "drafts", "templates", "outbox", "archives"].includes(value))) {
    return false;
  }
  if (!settings.analyzeJunk && specialUse.includes("junk")) return false;
  return true;
}

async function detectLanguage(text) {
  const sample = String(text || "").slice(0, 20000);
  if (!sample.trim()) return { language: "und", reliable: false, confidence: 0 };
  try {
    const result = await messenger.i18n.detectLanguage(sample);
    const first = result?.languages?.[0];
    return {
      language: String(first?.language || "und").toLowerCase(),
      reliable: Boolean(result?.isReliable),
      confidence: Number(first?.percentage || 0) / 100
    };
  } catch {
    const lower = sample.toLowerCase();
    if (/[а-я]/u.test(lower)) return { language: "bg", reliable: false, confidence: 0.5 };
    if (/\b(het|een|van|voor|met|uw|u|graag)\b/u.test(lower)) return { language: "nl", reliable: false, confidence: 0.4 };
    if (/\b(the|and|you|your|please|with)\b/u.test(lower)) return { language: "en", reliable: false, confidence: 0.4 };
    return { language: "und", reliable: false, confidence: 0 };
  }
}

async function ensurePriorityTags() {
  const settings = await getSettings();
  if (!settings.autoTag) return;
  const existing = await messenger.messages.tags.list();
  const keys = new Set(existing.map((tag) => tag.key));
  for (const tag of Object.values(PRIORITY_TAGS)) {
    if (!keys.has(tag.key)) {
      try {
        await messenger.messages.tags.create(tag.key, tag.label, tag.color);
      } catch (error) {
        await logDiagnostic("error", "TAG_CREATE_FAILED", { message: safeError(error), context: tag.key });
      }
    }
  }
}

async function applyPriorityTag(message, priority) {
  const settings = await getSettings();
  if (!settings.autoTag || !message?.id || message.external) return;
  const target = PRIORITY_TAGS[priority] || PRIORITY_TAGS.Low;
  const sentinelKeys = new Set(Object.values(PRIORITY_TAGS).map((tag) => tag.key));
  const existing = Array.isArray(message.tags) ? message.tags : [];
  const tags = [...existing.filter((key) => !sentinelKeys.has(key)), target.key];
  await messenger.messages.update(message.id, { tags });
}

async function ensureMenus() {
  if (!messenger.menus?.create) {
    throw new Error("Thunderbird menus API is unavailable");
  }
  if (messenger.menus.removeAll) await messenger.menus.removeAll();
  const items = [
    { id: MENU_IDS.openTools, title: "CIVION Mail — Open Action Center", contexts: ["tools_menu"] },
    { id: MENU_IDS.analyzeTools, title: "CIVION Mail — Analyze selected message", contexts: ["tools_menu"] },
    { id: MENU_IDS.openMessage, title: "CIVION Mail — Open Action Center", contexts: ["message_list"] },
    { id: MENU_IDS.analyzeMessage, title: "CIVION Mail — Analyze selected message", contexts: ["message_list"] }
  ];
  for (const item of items) await messenger.menus.create(item);
}

async function ensureActionCenterSpace() {
  if (!messenger.spaces?.query || !messenger.spaces?.create) {
    throw new Error("Thunderbird Spaces API is unavailable");
  }

  if (actionCenterSpaceId !== null) {
    try {
      if (messenger.spaces.get) await messenger.spaces.get(actionCenterSpaceId);
      return actionCenterSpaceId;
    } catch {
      actionCenterSpaceId = null;
    }
  }

  const spaces = await messenger.spaces.query({ name: SPACE_NAME, isSelfOwned: true });
  if (spaces.length) {
    actionCenterSpaceId = spaces[0].id;
    return actionCenterSpaceId;
  }

  const created = await messenger.spaces.create(
    SPACE_NAME,
    ACTION_CENTER_PATH,
    {
      title: "CIVION Mail",
      defaultIcons: {
        "16": "icons/icon-16.png",
        "32": "icons/icon-32.png"
      },
      badgeBackgroundColor: "#9B1C1C"
    }
  );
  actionCenterSpaceId = created.id;
  return actionCenterSpaceId;
}

async function updateToolbarBadge(activeCount) {
  if (!messenger.action) return;
  try {
    if (messenger.action.setBadgeText) {
      await messenger.action.setBadgeText({
        text: activeCount ? String(Math.min(activeCount, 999)) : "ON"
      });
    }
    if (messenger.action.setBadgeBackgroundColor) {
      await messenger.action.setBadgeBackgroundColor({ color: "#397A46" });
    }
    if (messenger.action.setTitle) {
      await messenger.action.setTitle({ title: `CIVION Mail is active — ${activeCount} actionable records` });
    }
  } catch (error) {
    await logDiagnostic("warning", "ACTION_BADGE_FAILED", { message: safeError(error) });
  }
}

async function updateActionCenterBadge() {
  const records = await getRecords();
  // The badge must agree with the Action Center default view: records whose original
  // message no longer exists in Thunderbird are retained as evidence but are not counted
  // as current attention.
  const activeCount = availableSourceRecords(records)
    .filter((record) => !CLOSED_STATUSES.has(record.status) && record.priority !== "No Action").length;
  await updateToolbarBadge(activeCount);

  try {
    const spaceId = await ensureActionCenterSpace();
    if (!messenger.spaces?.update) return;
    await messenger.spaces.update(
      spaceId,
      ACTION_CENTER_PATH,
      {
        title: "CIVION Mail",
        badgeText: activeCount ? String(Math.min(activeCount, 999)) : null,
        badgeBackgroundColor: "#9B1C1C"
      }
    );
  } catch (error) {
    await logDiagnostic("warning", "SPACE_BADGE_FAILED", { message: safeError(error) });
  }
}

async function openActionCenter() {
  try {
    const spaceId = await ensureActionCenterSpace();
    if (!messenger.spaces?.open) throw new Error("Thunderbird Spaces open API is unavailable");
    await messenger.spaces.open(spaceId);
    return { mode: "space", spaceId };
  } catch (error) {
    await logDiagnostic("warning", "SPACE_OPEN_FAILED", { message: safeError(error) });
    if (!messenger.tabs?.create) throw error;
    const tab = await messenger.tabs.create({ url: actionCenterUrl() });
    return { mode: "tab", tabId: tab?.id ?? null };
  }
}

async function processMessage(folder, message, options = {}) {
  if (!message || message.external) return null;
  if (!options.force && !options.folderAccepted && !(await shouldAnalyzeFolder(folder))) return null;

  const identityKey = makeIdentityKey(message, folder);
  const recordId = makeRecordId(message, folder);
  const existing = await findMatchingRecord(identityKey, recordId);
  const headerCollisions = message.headerMessageId
    ? (await findRecordsByHeaderMessageId(message.headerMessageId)).filter((record) => record.identityKey !== identityKey)
    : [];
  if (headerCollisions.length) {
    await logDiagnostic("warning", "HEADER_MESSAGE_ID_COLLISION", {
      headerMessageId: message.headerMessageId,
      context: message.subject
    });
    for (const collision of headerCollisions) {
      await patchRecordSystem(collision.id, { headerMessageIdCollision: true });
    }
  }
  if (existing && !options.force) {
    let refreshed = await patchRecordSystem(existing.id, {
      currentMessageId: message.id,
      messageAvailable: true,
      sourceState: "available",
      sourceUnavailableAt: null,
      folderId: folder?.id || message.folder?.id || existing.folderId,
      folderName: folder?.name || message.folder?.name || existing.folderName
    });
    if (options.emitBridge !== false && !refreshed?.desktopEvidenceSha256) {
      await emitDesktopSourceEvidence(refreshed || existing, message);
    }
    if (options.archiveDocuments !== false && ["pending", "partial"].includes(refreshed?.documentArchive?.state)) {
      refreshed = await archiveRecordDocuments(refreshed, message);
    }
    return refreshed || existing;
  }

  try {
    const extracted = await extractMessageData(message);
    const language = await detectLanguage(`${message.subject || ""}\n${extracted.body}`);
    const analysisSettings = await getSettings();
    try {
      await recordAuthservObservations(listAuthservIds(extracted.headers));
    } catch (tallyError) {
      // Discoverability aid only: a tally failure must never block analysis.
      void tallyError;
    }
    const analysis = await executeAnalysisProvider(localRulesProvider, {
      subject: message.subject,
      body: extracted.body,
      links: extracted.links,
      trustedAuthservIds: analysisSettings.trustedAuthservIds,
      userAllowlistedDomains: analysisSettings.userAllowlistedDomains,
      userBlockedDomains: analysisSettings.userBlockedDomains,
      sender: message.author,
      language: language.language,
      headers: extracted.headers,
      attachments: extracted.attachments,
      referenceDate: message.date instanceof Date ? message.date : new Date(message.date || Date.now()),
      currentDate: new Date(),
      languageDetection: language,
      contentHash: extracted.contentHash || null
    });

    const record = {
      id: existing?.id || recordId,
      identityKey,
      schemaVersion: SCHEMA_VERSION,
      headerMessageId: message.headerMessageId || "",
      headerMessageIdCollision: headerCollisions.length > 0,
      currentMessageId: message.id,
      messageAvailable: true,
      sourceState: "available",
      sourceUnavailableAt: null,
      accountId: folder?.accountId || message.folder?.accountId || null,
      folderId: folder?.id || message.folder?.id || null,
      folderName: folder?.name || message.folder?.name || "",
      subject: String(message.subject || "(No subject)"),
      sender: String(message.author || "Unknown sender"),
      recipients: Array.isArray(message.recipients) ? message.recipients.map(String) : [],
      receivedAt: message.date instanceof Date ? message.date.toISOString() : new Date(message.date || Date.now()).toISOString(),
      analyzedAt: new Date().toISOString(),
      languageDetection: language,
      bodyStored: false,
      ...analysis
    };

    let stored = await saveRecord(record, { preserveManual: options.preserveManual !== false });
    if (options.emitBridge !== false) {
      await emitDesktopBridgeRecord(stored);
      await emitDesktopSourceEvidence(stored, message);
    }
    if (options.archiveDocuments !== false) {
      stored = await archiveRecordDocuments(stored, message, extracted.attachments);
    }
    if (options.applyTag !== false) {
      try {
        await applyPriorityTag(message, stored.priority);
      } catch (error) {
        await logDiagnostic("error", "TAG_APPLY_FAILED", {
          message: safeError(error),
          headerMessageId: message.headerMessageId
        });
      }
    }
    if (options.updateBadge !== false) await updateActionCenterBadge();
    return stored;
  } catch (error) {
    await logDiagnostic("error", "MESSAGE_ANALYSIS_FAILED", {
      message: safeError(error),
      headerMessageId: message.headerMessageId,
      context: message.subject
    });

    const fallback = {
      id: existing?.id || recordId,
      identityKey,
      schemaVersion: SCHEMA_VERSION,
      headerMessageId: message.headerMessageId || "",
      headerMessageIdCollision: headerCollisions.length > 0,
      currentMessageId: message.id,
      messageAvailable: true,
      sourceState: "available",
      sourceUnavailableAt: null,
      accountId: folder?.accountId || message.folder?.accountId || null,
      folderId: folder?.id || message.folder?.id || null,
      folderName: folder?.name || message.folder?.name || "",
      subject: String(message.subject || "(No subject)"),
      sender: String(message.author || "Unknown sender"),
      recipients: Array.isArray(message.recipients) ? message.recipients.map(String) : [],
      receivedAt: message.date instanceof Date ? message.date.toISOString() : new Date(message.date || Date.now()).toISOString(),
      analyzedAt: new Date().toISOString(),
      summary: "CIVION Mail could not read or analyze this message. Open the original message for manual review.",
      contentHash: null,
      requiredAction: "Review the original message manually.",
      action: { detected: false, mandatory: false, strength: 0, evidence: [] },
      actionEvidence: [],
      mandatoryAction: false,
      deadline: null,
      amounts: [],
      financialChange: false,
      replyExpected: false,
      importantAttachments: [],
      attachmentCount: 0,
      risk: { level: "Low", score: 0, reasons: [] },
      recommendedNextStep: "Open the original message and review it manually.",
      confidence: 0,
      confidenceKind: "analysis-reliability",
      confidenceLabel: "Low",
      confidenceReasons: ["Automatic analysis failed."],
      deadlineCandidates: [],
      typedFindings: [],
      needsVerification: ["analysis_error"],
      senderTrust: { domain: "", verifiedOfficial: false, officialClaim: false, displayNameClaim: false, mismatch: false },
      senderIdentity: { displayName: null, address: null, domain: null },
      relationshipClass: "Unknown / Review",
      claimedRelationshipClass: null,
      relationship: { class: "Unknown / Review", claimedClass: null, confidence: 0, verificationState: "analysis_error", basis: [] },
      documentType: "Other",
      documentClassification: { type: "Other", confidence: 0, basis: [] },
      obligation: { actionRequired: false, replyExpected: false, paymentRequired: false, deadline: null, financialConsequence: false, needsVerification: ["analysis_error"] },
      retention: { class: "Review manually", reason: "Automatic analysis failed.", advisory: true, autoDelete: false },
      civicMapReference: { eligible: false, status: "not_applicable", runtimeLookup: false, route: "CIVION Civic via authenticated CIVION Gateway" },
      language: "und",
      categories: ["Unknown"],
      priority: "Low",
      priorityReasons: ["Automatic analysis failed."],
      status: existing?.status || "New",
      analysisVersion: "local-rules-0.5.0",
      analysisMode: "local",
      analysisProvider: providerState(localRulesProvider),
      analysisError: safeError(error),
      markedIncorrect: false,
      manualEdited: false,
      bodyStored: false
    };
    const stored = await saveRecord(fallback);
    if (options.emitBridge !== false) {
      await emitDesktopBridgeRecord(stored);
      await emitDesktopSourceEvidence(stored, message);
    }
    if (options.updateBadge !== false) await updateActionCenterBadge();
    return stored;
  }
}

async function handleNewMail(folder, initialPage) {
  const accepted = await shouldAnalyzeFolder(folder);
  const specialUse = folderSpecialUses(folder);
  const isInbox = specialUse.includes("inbox");
  const isJunk = specialUse.includes("junk");
  // The admission gate belongs to the junk folder, not to one operation. Historical Scan
  // gated and this path did not, so enabling `analyzeJunk` restored full analysis of a spam
  // folder through live mail. Resolved to one gate on every path.
  const allJunkFolderIds = accepted && isJunk ? await listAllJunkFolderIds() : [];
  let seen = 0;
  let handled = 0;
  let failed = 0;
  let notAdmitted = 0;
  for await (const message of iterateMessagePages(initialPage)) {
    seen += 1;
    if (!accepted) continue;
    try {
      if (isJunk) {
        let admission = { admitted: false, reasons: ["The admission gate could not be evaluated."] };
        try {
          admission = await evaluateJunkMessage(message, allJunkFolderIds);
        } catch (error) {
          // Fail closed: an unevaluable gate never admits.
          await logDiagnostic("warning", "JUNK_ADMISSION_EVALUATION_FAILED", {
            message: safeError(error),
            headerMessageId: message?.headerMessageId
          });
        }
        if (!admission.admitted) {
          notAdmitted += 1;
          continue;
        }
      }
      // r002 section 5 is read-only over Junk: no tagging, no `messagesUpdate`, not even in
      // AUTO TAG mode. This path previously left `applyTag` unset, which means "apply".
      const record = await processMessage(folder, message, {
        folderAccepted: true,
        ...(isJunk ? { applyTag: false } : {})
      });
      if (record) handled += 1;
      if (record?.analysisError) failed += 1;
    } catch (error) {
      failed += 1;
      await logDiagnostic("error", "MESSAGE_BATCH_ITEM_FAILED", {
        message: safeError(error),
        headerMessageId: message?.headerMessageId,
        context: message?.subject
      });
    }
  }
  await recordOperationalEvent("newMailBatch", {
    accountId: folder?.accountId || "unknown",
    seen,
    handled,
    failed,
    notAdmitted,
    excluded: !accepted,
    isInbox,
    isJunk
  });
}

// Every junk folder in every configured account. Path B condition 5 requires that prior
// records sitting in junk anywhere are excluded as evidence, not only those in the folders
// currently under evaluation. The live path has no job config, so it resolves this itself.
async function listAllJunkFolderIds() {
  const scope = await getHistoricalScanScope();
  const ids = [];
  for (const account of scope) {
    for (const folder of account.folders || []) {
      const specialUse = (folder.specialUse || []).map((value) => String(value).toLowerCase());
      if (specialUse.includes("junk")) ids.push(String(folder.id));
    }
  }
  return ids;
}

// Evaluates the junk admission gate for one message before any analysis or storage occurs.
// Reads headers only; body analysis, deadline extraction and link inspection do not run.
// `allJunkFolderIds` is supplied by the caller so that the gate is identical on every path.
async function evaluateJunkMessage(message, allJunkFolderIds = []) {
  const settings = await getSettings();
  const full = await messenger.messages.getFull(message.id, { decodeHeaders: true });
  const headers = full?.headers || {};
  const signals = evaluateSenderAdmissionSignals({
    sender: message.author || "",
    headers,
    trustedAuthservIds: settings.trustedAuthservIds || [],
    // The normalized settings key is `userBlockedDomains`. Reading `blockedDomains` here
    // silently passed an empty list, which made the manual blocked-domain bar inert.
    userBlockedDomains: settings.userBlockedDomains || []
  });
  const junkFolderIds = new Set((allJunkFolderIds || []).map(String));
  const priorRecords = signals.domain
    ? (await getRecords()).filter((record) => senderDomainOf(record) === signals.domain)
    : [];
  return evaluateJunkAdmission({ signals, priorRecords, junkFolderIds });
}

function senderDomainOf(record) {
  const match = String(record?.sender || "").match(/@([^@>\s]+)\s*>?\s*$/u);
  return match ? match[1].toLowerCase() : "";
}

async function handleMoved(originalPage, movedPage) {
  const [originalMessages, movedMessages] = await Promise.all([
    flattenMessagePages(originalPage),
    flattenMessagePages(movedPage)
  ]);
  const movedByIdentity = new Map(
    movedMessages.map((message) => [makeIdentityKey(message, message.folder), message])
  );
  let matchedCount = 0;
  for (const original of originalMessages) {
    const identityKey = makeIdentityKey(original, original.folder);
    const moved = movedByIdentity.get(identityKey);
    if (!moved) continue;
    matchedCount += 1;
    const movedSpecialUse = folderSpecialUses(moved.folder);
    const movedToTrash = movedSpecialUse.includes("trash");
    await updateTechnicalByIdentity(identityKey, {
      currentMessageId: movedToTrash ? null : moved.id,
      messageAvailable: !movedToTrash,
      sourceState: movedToTrash ? "trash" : "available",
      sourceUnavailableAt: movedToTrash ? new Date().toISOString() : null,
      folderId: moved.folder?.id || null,
      folderName: moved.folder?.name || ""
    });
  }
  if (matchedCount) await updateActionCenterBadge();
  await recordOperationalEvent("movedBatch", { count: matchedCount });
}

async function handleDeleted(initialPage) {
  let count = 0;
  for await (const message of iterateMessagePages(initialPage)) {
    count += 1;
    const identityKey = makeIdentityKey(message, message.folder);
    await updateTechnicalByIdentity(identityKey, {
      messageAvailable: false,
      currentMessageId: null,
      sourceState: "deleted",
      sourceUnavailableAt: new Date().toISOString()
    });
  }
  if (count) await updateActionCenterBadge();
  await recordOperationalEvent("deletedBatch", { count });
}

async function findSelectedMessages() {
  if (!messenger.mailTabs?.query || !messenger.mailTabs?.getSelectedMessages) {
    throw new Error("Thunderbird mail-tab selection API is unavailable.");
  }
  const tabs = await messenger.mailTabs.query({});
  for (const tab of tabs) {
    try {
      const page = await messenger.mailTabs.getSelectedMessages(tab.id);
      const messages = await flattenMessagePages(page, 100);
      if (messages.length) return messages;
    } catch {
      // A tab can disappear or stop being a mail tab while the query is running.
    }
  }
  return [];
}

async function analyzeMessageHeaders(messages) {
  if (!Array.isArray(messages) || !messages.length) {
    throw new Error("Select one or more messages and try again.");
  }

  let handled = 0;
  let failed = 0;
  const records = [];
  for (const message of messages) {
    const folder = message.folder || null;
    try {
      // Explicit selection is its own authority and analysis proceeds, but the read-only
      // rule over Junk is unconditional: no message in a junk folder is ever marked.
      const isJunkMessage = folderSpecialUses(folder).includes("junk");
      const record = await processMessage(folder, message, {
        force: true,
        preserveManual: true,
        folderAccepted: true,
        ...(isJunkMessage ? { applyTag: false } : {})
      });
      if (record) {
        handled += 1;
        records.push(record);
        if (record.analysisError) failed += 1;
      }
    } catch (error) {
      failed += 1;
      await logDiagnostic("error", "MANUAL_ANALYSIS_FAILED", {
        message: safeError(error),
        headerMessageId: message?.headerMessageId,
        context: message?.subject
      });
    }
  }

  await recordOperationalEvent("manualAnalysis", { handled, failed });
  if (!handled) throw new Error("The selected messages could not be analyzed.");
  return { selected: messages.length, handled, failed, records };
}


function historicalScanPublicState(job = historicalScanJob) {
  if (!job) {
    return {
      status: "idle",
      jobId: null,
      startedAt: null,
      completedAt: null,
      processed: 0,
      analyzed: 0,
      skipped: 0,
      failed: 0,
      currentFolder: "",
      junkAdmitted: 0,
      junkNotAdmitted: 0,
      limit: 0,
      limitReached: false,
      cancelRequested: false,
      error: ""
    };
  }
  return {
    status: job.status,
    jobId: job.jobId,
    startedAt: job.startedAt,
    completedAt: job.completedAt || null,
    processed: job.processed,
    analyzed: job.analyzed,
    skipped: job.skipped,
    failed: job.failed,
    currentFolder: job.currentFolder || "",
    junkAdmitted: job.junkAdmitted || 0,
    junkNotAdmitted: job.junkNotAdmitted || 0,
    limit: job.config.maxMessages || 0,
    limitReached: job.limitReached === true,
    cancelRequested: job.cancelRequested === true,
    error: job.error || ""
  };
}

function flattenAccountFolders(account) {
  const result = [];
  const visit = (folder, parents = []) => {
    if (!folder?.id) return;
    const name = String(folder.name || "Folder");
    const path = [...parents, name].join(" / ");
    const specialUse = Array.isArray(folder.specialUse) ? folder.specialUse.map(String) : [];
    result.push({
      id: folder.id,
      accountId: account.id,
      name,
      path,
      specialUse,
      recommended: isNormalArchiveFolder(folder)
    });
    for (const child of folder.subFolders || []) visit(child, [...parents, name]);
  };
  for (const folder of account.rootFolder?.subFolders || account.folders || []) visit(folder, []);
  return result;
}

async function getHistoricalScanScope() {
  const accounts = await messenger.accounts.list(true);
  return (Array.isArray(accounts) ? accounts : []).map((account) => ({
    id: account.id,
    name: String(account.name || account.type || "Account"),
    type: String(account.type || "unknown"),
    folders: flattenAccountFolders(account)
  }));
}

function archiveExistingPublicState(job = archiveExistingJob) {
  if (!job) {
    return {
      status: "idle",
      jobId: null,
      startedAt: null,
      completedAt: null,
      examined: 0,
      pdfMessages: 0,
      recognizedDocuments: 0,
      archived: 0,
      alreadyArchived: 0,
      skipped: 0,
      pending: 0,
      failed: 0,
      currentFolder: "",
      accountCount: 0,
      folderCount: 0,
      cancelRequested: false,
      pauseReason: "",
      restartedFrom: null,
      error: ""
    };
  }
  return {
    status: job.status,
    jobId: job.jobId,
    startedAt: job.startedAt,
    completedAt: job.completedAt || null,
    examined: job.examined,
    pdfMessages: job.pdfMessages,
    recognizedDocuments: job.recognizedDocuments,
    archived: job.archived,
    alreadyArchived: job.alreadyArchived,
    skipped: job.skipped,
    pending: job.pending,
    failed: job.failed,
    currentFolder: job.currentFolder || "",
    accountCount: job.config?.accountCount ?? job.accountCount ?? 0,
    folderCount: job.config?.folderIds?.length ?? job.folderCount ?? 0,
    cancelRequested: job.cancelRequested === true,
    pauseReason: job.pauseReason || "",
    restartedFrom: job.restartedFrom || null,
    error: job.error || ""
  };
}

async function getArchiveExistingScope() {
  const accounts = await getHistoricalScanScope();
  const normalFolders = accounts.flatMap((account) => account.folders
    .filter((folder) => folder.recommended)
    .map((folder) => ({ ...folder, accountName: account.name })));
  return {
    accountCount: new Set(normalFolders.map((folder) => folder.accountId)).size,
    folderCount: normalFolders.length,
    folderIds: normalFolders.map((folder) => folder.id),
    folderLabels: Object.fromEntries(normalFolders.map((folder) => [folder.id, `${folder.accountName} / ${folder.path}`]))
  };
}

async function persistArchiveExistingState(job) {
  const snapshot = archiveExistingPublicState(job);
  await updateMetadata((metadata) => ({
    ...metadata,
    documentArchiveBackfill: snapshot
  }));
}

function successfulArchiveState(state) {
  return ["archived", "already_archived", "restored"].includes(state);
}

async function processArchiveExistingBatch(job, messages) {
  for (const message of messages) {
    if (job.cancelRequested) break;
    job.examined += 1;
    job.currentFolder = job.config.folderLabels[message.folder?.id] || message.folder?.name || "";
    try {
      const listed = await messenger.messages.listAttachments(message.id);
      const attachments = (listed || []).map((attachment) => ({
        name: String(attachment.name || "Unnamed attachment"),
        contentType: String(attachment.contentType || "application/octet-stream"),
        size: Number(attachment.size || 0),
        partName: String(attachment.partName || "")
      }));
      const pdfAttachments = attachments.filter((attachment) =>
        /\.pdf$/iu.test(attachment.name)
        || attachment.contentType.split(";", 1)[0].toLowerCase() === "application/pdf");
      if (!pdfAttachments.length) {
        job.skipped += 1;
        continue;
      }
      job.pdfMessages += 1;

      const identityKey = makeIdentityKey(message, message.folder);
      const recordId = makeRecordId(message, message.folder);
      let record = await findMatchingRecord(identityKey, recordId);
      if (record) {
        record = await patchRecordSystem(record.id, {
          currentMessageId: message.id,
          messageAvailable: true,
          sourceState: "available",
          sourceUnavailableAt: null,
          folderId: message.folder?.id || record.folderId,
          folderName: message.folder?.name || record.folderName
        }) || record;
      } else {
        record = await processMessage(message.folder || null, message, {
          force: true,
          preserveManual: true,
          folderAccepted: true,
          applyTag: false,
          updateBadge: false,
          emitBridge: false,
          archiveDocuments: false
        });
      }
      if (!record) {
        job.failed += 1;
        continue;
      }

      const previousFiles = new Map((record.documentArchive?.files || [])
        .map((file) => [String(file.partName || ""), file]));
      const updated = await archiveRecordDocuments(record, message, attachments, {
        force: true,
        verifyExisting: true
      });
      const files = updated?.documentArchive?.files || [];
      if (!files.length || updated?.documentArchive?.state === "not_applicable") {
        job.skipped += 1;
        continue;
      }
      job.recognizedDocuments += files.length;
      for (const file of files) {
        const prior = previousFiles.get(String(file.partName || ""));
        if (successfulArchiveState(file.state)) {
          if ((prior && successfulArchiveState(prior.state) && prior.sha256 === file.sha256)
              || file.state === "already_archived") {
            job.alreadyArchived += 1;
          } else {
            job.archived += 1;
          }
        } else if (file.state === "pending") {
          job.pending += 1;
          if (["ARCHIVE_ROOT_UNAVAILABLE", "ARCHIVE_HOST_UNAVAILABLE"].includes(file.errorCode)) {
            job.pauseReason = file.errorCode;
            job.error = file.errorCode === "ARCHIVE_ROOT_UNAVAILABLE"
              ? "Archive drive F: is unavailable."
              : "The local CIVION archive host is unavailable.";
            job.cancelRequested = true;
          }
        } else {
          job.failed += 1;
        }
      }
    } catch (error) {
      job.failed += 1;
      await logDiagnostic("error", "DOCUMENT_ARCHIVE_BACKFILL_ITEM_FAILED", {
        message: safeError(error),
        headerMessageId: message?.headerMessageId,
        context: message?.subject
      });
    }
  }
  await updateActionCenterBadge();
  await persistArchiveExistingState(job);
}

async function runArchiveExisting(job) {
  let activeListId = null;
  try {
    let page = await messenger.messages.query({
      folderId: job.config.folderIds,
      autoPaginationTimeout: 750
    });
    while (page && !job.cancelRequested) {
      activeListId = page.id || null;
      const pageMessages = Array.isArray(page.messages) ? page.messages : [];
      for (let index = 0; index < pageMessages.length && !job.cancelRequested; index += HISTORICAL_SCAN_BATCH_SIZE) {
        const batch = pageMessages.slice(index, index + HISTORICAL_SCAN_BATCH_SIZE);
        await enqueue(() => processArchiveExistingBatch(job, batch));
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (job.cancelRequested || !page.id) break;
      page = await messenger.messages.continueList(page.id);
    }
    if (job.cancelRequested && activeListId && messenger.messages.abortList) {
      try { await messenger.messages.abortList(activeListId); } catch { /* best effort */ }
    }
    job.status = job.pauseReason ? "paused" : job.cancelRequested ? "cancelled" : "completed";
  } catch (error) {
    job.status = "failed";
    job.error = safeError(error);
    await logDiagnostic("error", "DOCUMENT_ARCHIVE_BACKFILL_FAILED", { message: job.error });
  } finally {
    job.completedAt = new Date().toISOString();
    job.currentFolder = "";
    await enqueue(() => persistArchiveExistingState(job));
  }
}

async function startArchiveExisting() {
  if (archiveExistingJob?.status === "running") throw new Error("Existing-document archive is already running.");
  if (historicalScanJob?.status === "running") throw new Error("Stop Historical Scan before starting the document archive.");
  const config = await getArchiveExistingScope();
  if (!config.folderIds.length) throw new Error("No normal mail folders are available.");
  const previous = archiveExistingJob || (await getState()).metadata?.documentArchiveBackfill;
  archiveExistingJob = {
    jobId: `da-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    examined: 0,
    pdfMessages: 0,
    recognizedDocuments: 0,
    archived: 0,
    alreadyArchived: 0,
    skipped: 0,
    pending: 0,
    failed: 0,
    currentFolder: "",
    cancelRequested: false,
    restartedFrom: ["cancelled", "interrupted", "paused", "failed"].includes(previous?.status) ? previous.jobId : null,
    error: "",
    pauseReason: "",
    config
  };
  await persistArchiveExistingState(archiveExistingJob);
  setTimeout(() => { void runArchiveExisting(archiveExistingJob); }, 0);
  return archiveExistingPublicState(archiveExistingJob);
}

function cancelArchiveExisting() {
  if (!archiveExistingJob || archiveExistingJob.status !== "running") return archiveExistingPublicState();
  archiveExistingJob.cancelRequested = true;
  return archiveExistingPublicState(archiveExistingJob);
}

async function reconcileInterruptedArchiveExistingState() {
  if (archiveExistingJob) return;
  const state = await getState();
  const previous = state.metadata?.documentArchiveBackfill;
  if (!previous) return;
  if (previous.status !== "running") {
    archiveExistingJob = previous;
    return;
  }
  const interrupted = {
    ...previous,
    status: "interrupted",
    completedAt: new Date().toISOString(),
    currentFolder: "",
    cancelRequested: false,
    error: "Archiving was interrupted by a Thunderbird restart. Continue is safe because SHA-256 deduplication prevents duplicate files."
  };
  archiveExistingJob = interrupted;
  await updateMetadata((metadata) => ({
    ...metadata,
    documentArchiveBackfill: interrupted
  }));
}

function parseHistoricalDate(value, endOfRange = false) {
  const text = String(value || "").trim();
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(text)) throw new Error("Invalid date format.");
  const date = new Date(`${text}T00:00:00`);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid date.");
  if (endOfRange) date.setDate(date.getDate() + 1);
  return date;
}

async function validateHistoricalScanConfig(raw = {}) {
  const scope = await getHistoricalScanScope();
  const validFolders = new Map();
  for (const account of scope) {
    for (const folder of account.folders) validFolders.set(folder.id, folder);
  }
  const folderIds = [...new Set((Array.isArray(raw.folderIds) ? raw.folderIds : [])
    .map(String)
    .filter((id) => validFolders.has(id)))];
  if (!folderIds.length) throw new Error("Select at least one folder for Historical Scan.");
  const parsedLimit = Number(raw.maxMessages);
  const maxMessages = parsedLimit === 0
    ? 0
    : Math.min(HISTORICAL_SCAN_MAX_MESSAGES, Math.max(1, Number.isFinite(parsedLimit) ? Math.trunc(parsedLimit) : 5000));
  const fromDate = parseHistoricalDate(raw.dateFrom, false);
  const toDate = parseHistoricalDate(raw.dateTo, true);
  if (fromDate && toDate && fromDate >= toDate) throw new Error("The start date must be before the end date.");
  return {
    folderIds,
    maxMessages,
    fromDate,
    toDate,
    reanalyzeExisting: raw.reanalyzeExisting === true,
    applyTags: raw.applyTags === true,
    folderLabels: Object.fromEntries(folderIds.map((id) => [id, validFolders.get(id)?.path || id])),
    junkFolderIds: folderIds.filter((id) => (validFolders.get(id)?.specialUse || [])
      .map((value) => String(value).toLowerCase()).includes("junk")),
    // Every junk folder in the account tree, not only the selected ones: Path B evidence
    // must exclude prior records that themselves sit in junk anywhere.
    allJunkFolderIds: [...validFolders.values()]
      .filter((folder) => (folder.specialUse || []).map((value) => String(value).toLowerCase()).includes("junk"))
      .map((folder) => String(folder.id))
  };
}

async function persistHistoricalScanState(job) {
  const snapshot = historicalScanPublicState(job);
  await updateMetadata((metadata) => ({
    ...metadata,
    historicalScan: snapshot
  }));
}

async function processHistoricalBatch(job, messages) {
  const junkFolderIds = new Set((job.config.junkFolderIds || []).map(String));
  for (const message of messages) {
    if (job.cancelRequested) break;
    if (job.config.maxMessages && job.processed >= job.config.maxMessages) {
      job.limitReached = true;
      break;
    }
    job.processed += 1;
    job.currentFolder = job.config.folderLabels[message.folder?.id] || message.folder?.name || "";
    try {
      const isJunkMessage = junkFolderIds.has(String(message.folder?.id || ""));
      // The gate runs before the existing-record branch. Ordered the other way, a record
      // created before the gate existed was refreshed and its source state reasserted
      // without ever being evaluated against Path A or Path B.
      if (isJunkMessage) {
        let admission = { admitted: false, reasons: ["The admission gate could not be evaluated."] };
        try {
          admission = await evaluateJunkMessage(message, job.config.allJunkFolderIds);
        } catch (error) {
          // Fail closed: an unevaluable gate never admits.
          await logDiagnostic("warning", "JUNK_ADMISSION_EVALUATION_FAILED", {
            message: safeError(error),
            headerMessageId: message?.headerMessageId
          });
        }
        if (!admission.admitted) {
          job.junkNotAdmitted += 1;
          continue;
        }
        job.junkAdmitted += 1;
      }
      const identityKey = makeIdentityKey(message, message.folder);
      const recordId = makeRecordId(message, message.folder);
      const existing = await findMatchingRecord(identityKey, recordId);
      if (existing && !job.config.reanalyzeExisting) {
        await patchRecordSystem(existing.id, {
          currentMessageId: message.id,
          messageAvailable: true,
          sourceState: "available",
          sourceUnavailableAt: null,
          folderId: message.folder?.id || existing.folderId,
          folderName: message.folder?.name || existing.folderName
        });
        job.skipped += 1;
        continue;
      }
      const record = await processMessage(message.folder || null, message, {
        force: job.config.reanalyzeExisting,
        preserveManual: true,
        folderAccepted: true,
        // Read-only over Junk: an admitted message is analysed and reported, never marked.
        applyTag: isJunkMessage ? false : job.config.applyTags,
        updateBadge: false,
        emitBridge: false,
        archiveDocuments: false
      });
      if (record) {
        job.analyzed += 1;
        if (record.analysisError) job.failed += 1;
      }
    } catch (error) {
      job.failed += 1;
      await logDiagnostic("error", "HISTORICAL_SCAN_ITEM_FAILED", {
        message: safeError(error),
        headerMessageId: message?.headerMessageId,
        context: message?.subject
      });
    }
  }
  await updateActionCenterBadge();
  await persistHistoricalScanState(job);
}

async function reconcileInterruptedHistoricalScanState() {
  if (historicalScanJob) return;
  const state = await getState();
  const previous = state.metadata?.historicalScan;
  if (!previous || previous.status !== "running") return;
  const interrupted = {
    ...previous,
    status: "interrupted",
    completedAt: new Date().toISOString(),
    currentFolder: "",
    cancelRequested: false,
    error: "Historical Scan was interrupted by Thunderbird restart and was not resumed automatically."
  };
  await updateMetadata((metadata) => ({
    ...metadata,
    historicalScan: interrupted
  }));
}

async function runHistoricalScan(job) {
  let activeListId = null;
  try {
    const queryInfo = {
      folderId: job.config.folderIds,
      autoPaginationTimeout: 750
    };
    if (job.config.fromDate) queryInfo.fromDate = job.config.fromDate;
    if (job.config.toDate) queryInfo.toDate = job.config.toDate;

    let page = await messenger.messages.query(queryInfo);
    while (page && !job.cancelRequested && !job.limitReached) {
      activeListId = page.id || null;
      const pageMessages = Array.isArray(page.messages) ? page.messages : [];
      for (let index = 0; index < pageMessages.length && !job.cancelRequested && !job.limitReached; index += HISTORICAL_SCAN_BATCH_SIZE) {
        const batch = pageMessages.slice(index, index + HISTORICAL_SCAN_BATCH_SIZE);
        await enqueue(() => processHistoricalBatch(job, batch));
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (job.cancelRequested || job.limitReached || !page.id) break;
      page = await messenger.messages.continueList(page.id);
    }

    if ((job.cancelRequested || job.limitReached) && activeListId && messenger.messages.abortList) {
      try { await messenger.messages.abortList(activeListId); } catch { /* best effort */ }
    }
    job.status = job.cancelRequested ? "cancelled" : "completed";
  } catch (error) {
    job.status = "failed";
    job.error = safeError(error);
    await logDiagnostic("error", "HISTORICAL_SCAN_FAILED", { message: job.error });
  } finally {
    job.completedAt = new Date().toISOString();
    job.currentFolder = "";
    await enqueue(() => persistHistoricalScanState(job));
  }
}

async function startHistoricalScan(rawConfig = {}) {
  if (historicalScanJob && historicalScanJob.status === "running") {
    throw new Error("Historical Scan is already running.");
  }
  if (archiveExistingJob?.status === "running") {
    throw new Error("Stop the existing-document archive before starting Historical Scan.");
  }
  const config = await validateHistoricalScanConfig(rawConfig);
  historicalScanJob = {
    jobId: `hs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    processed: 0,
    analyzed: 0,
    skipped: 0,
    failed: 0,
    junkAdmitted: 0,
    junkNotAdmitted: 0,
    currentFolder: "",
    limitReached: false,
    cancelRequested: false,
    error: "",
    config
  };
  await persistHistoricalScanState(historicalScanJob);
  setTimeout(() => { void runHistoricalScan(historicalScanJob); }, 0);
  return historicalScanPublicState(historicalScanJob);
}

function cancelHistoricalScan() {
  if (!historicalScanJob || historicalScanJob.status !== "running") return historicalScanPublicState();
  historicalScanJob.cancelRequested = true;
  return historicalScanPublicState(historicalScanJob);
}

async function analyzeSelectedMessages() {
  const messages = await findSelectedMessages();
  return analyzeMessageHeaders(messages);
}

async function analyzeMessageIds(messageIds) {
  const ids = [...new Set((Array.isArray(messageIds) ? messageIds : [])
    .filter((id) => id !== null && id !== undefined))].slice(0, 100);
  const messages = [];
  for (const id of ids) {
    try {
      messages.push(await messenger.messages.get(id));
    } catch (error) {
      await logDiagnostic("warning", "MANUAL_MESSAGE_LOOKUP_FAILED", {
        message: safeError(error),
        context: String(id)
      });
    }
  }
  return analyzeMessageHeaders(messages);
}

async function handleMenuClick(info) {
  const id = String(info?.menuItemId || "");
  if (id === MENU_IDS.openTools || id === MENU_IDS.openMessage) {
    await openActionCenter();
    return;
  }
  if (id !== MENU_IDS.analyzeTools && id !== MENU_IDS.analyzeMessage) return;

  let messages = [];
  if (info?.selectedMessages) {
    messages = await flattenMessagePages(info.selectedMessages, 100);
  }
  const result = messages.length
    ? await analyzeMessageHeaders(messages)
    : await analyzeSelectedMessages();
  await openActionCenter();
  return result;
}

async function resolveRecordMessage(record) {
  if (record.currentMessageId !== null && record.currentMessageId !== undefined) {
    try {
      const message = await messenger.messages.get(record.currentMessageId);
      if (!record.headerMessageId || message.headerMessageId === record.headerMessageId) return message;
    } catch {
      // Internal message ids are expected to become invalid after restart or move.
    }
  }
  if (!record.headerMessageId) throw new Error("No stable Message-ID is available for this record.");
  const result = await messenger.messages.query({ headerMessageId: record.headerMessageId });
  const candidates = [];
  for await (const message of iterateMessagePages(result)) candidates.push(message);
  const matched = candidates.find((message) => makeIdentityKey(message, message.folder) === record.identityKey)
    || (candidates.length === 1 ? candidates[0] : null);
  if (matched) {
    await patchRecordSystem(record.id, {
      identityKey: makeIdentityKey(matched, matched.folder),
      currentMessageId: matched.id,
      messageAvailable: true,
      sourceState: "available",
      sourceUnavailableAt: null,
      folderId: matched.folder?.id || record.folderId,
      folderName: matched.folder?.name || record.folderName
    });
    return matched;
  }
  if (candidates.length > 1) {
    throw new Error("Multiple messages share the same Message-ID; the original cannot be selected safely.");
  }
  throw new Error("The original message could not be found.");
}

async function retryDocumentArchive(recordId) {
  const record = await findRecord(recordId);
  if (!record) throw new Error("Record not found.");
  if (record.messageAvailable === false) throw new Error("The original email is no longer available.");
  const message = await resolveRecordMessage(record);
  return archiveRecordDocuments(record, message, null, { force: true, verifyExisting: true });
}

async function retryPendingDocumentArchives(limit = 20) {
  const settings = await getSettings();
  if (settings.automaticDocumentArchive === false) return { attempted: 0, archived: 0 };
  const records = (await getRecords())
    .filter((record) => record.messageAvailable !== false && ["pending", "partial"].includes(record.documentArchive?.state))
    .slice(0, Math.max(0, limit));
  let archived = 0;
  for (const record of records) {
    try {
      const message = await resolveRecordMessage(record);
      const updated = await archiveRecordDocuments(record, message);
      if (updated?.documentArchive?.state === "archived") archived += 1;
    } catch (error) {
      await logDiagnostic("error", "DOCUMENT_ARCHIVE_RETRY_FAILED", {
        message: safeError(error), headerMessageId: record.headerMessageId
      });
    }
  }
  return { attempted: records.length, archived };
}

async function deleteOriginal(recordId) {
  const record = await findRecord(recordId);
  if (!record) throw new Error("Record not found.");
  if (record.messageAvailable === false) throw new Error("The original email is no longer available.");
  const message = await resolveRecordMessage(record);
  await messenger.messages.delete([message.id], {
    deletePermanently: false,
    isUserAction: true
  });
  const deletedAt = new Date().toISOString();
  await patchRecordSystem(record.id, {
    currentMessageId: null,
    messageAvailable: false,
    sourceState: "deleted",
    sourceUnavailableAt: deletedAt
  });
  await updateActionCenterBadge();
  return { deletedAt };
}

async function openOriginal(recordId) {
  const record = await findRecord(recordId);
  if (!record) throw new Error("Record not found.");
  try {
    const message = await resolveRecordMessage(record);
    return await messenger.messageDisplay.open({ messageId: message.id, location: "tab", active: true });
  } catch (firstError) {
    // Never open by Message-ID alone: duplicate Message-IDs are legal in malformed or adversarial mail,
    // and the API cannot prove which copy belongs to this record.
    throw firstError;
  }
}

async function reanalyzeRecord(recordId) {
  const record = await findRecord(recordId);
  if (!record) throw new Error("Record not found.");
  const message = await resolveRecordMessage(record);
  const folder = message.folder || {
    id: record.folderId,
    name: record.folderName,
    accountId: record.accountId,
    specialUse: []
  };
  return processMessage(folder, message, { force: true, preserveManual: false });
}

function normalizeContextDomain(value) {
  const domain = String(value || "").trim().toLowerCase().replace(/^\.+|\.+$/gu, "");
  if (!domain || domain.length > 253) return "";
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(domain)) return "";
  return domain;
}

async function setDomainDisposition(domainValue, disposition) {
  const domain = normalizeContextDomain(domainValue);
  if (!domain) throw new Error("Invalid sender domain.");
  const settings = await getSettings();
  const allowlisted = new Set(settings.userAllowlistedDomains || []);
  const blocked = new Set(settings.userBlockedDomains || []);

  if (disposition === "allow") {
    blocked.delete(domain);
    allowlisted.add(domain);
  } else if (disposition === "block") {
    allowlisted.delete(domain);
    blocked.add(domain);
  } else if (disposition === "clear") {
    allowlisted.delete(domain);
    blocked.delete(domain);
  } else {
    throw new Error("Unsupported domain action.");
  }

  const next = await setSettings({
    userAllowlistedDomains: [...allowlisted],
    userBlockedDomains: [...blocked]
  });
  return { domain, disposition, settings: next };
}

function validatePatch(patch) {
  const allowed = {};
  if (typeof patch.status === "string" && VALID_STATUSES.has(patch.status)) allowed.status = patch.status;
  if (typeof patch.priority === "string" && PRIORITIES.includes(patch.priority)) allowed.priority = patch.priority;
  if (patch.deadline === null) allowed.deadline = null;
  if (patch.deadline && typeof patch.deadline === "object" && /^\d{4}-\d{2}-\d{2}$/u.test(patch.deadline.date || "")) {
    allowed.deadline = {
      ...patch.deadline,
      date: patch.deadline.date,
      evidenceStrength: 1,
      manuallySet: true
    };
    allowed.deadlineCandidates = [];
    allowed.needsVerification = [];
  }
  if (typeof patch.requiredAction === "string") allowed.requiredAction = patch.requiredAction.slice(0, 1000);
  if (Array.isArray(patch.categories)) {
    allowed.categories = [...new Set(patch.categories.filter((category) => CATEGORY_ORDER.includes(category)))];
    if (!allowed.categories.length) allowed.categories = ["Unknown"];
  }
  if (typeof patch.markedIncorrect === "boolean") allowed.markedIncorrect = patch.markedIncorrect;
  if (typeof patch.userNotes === "string") allowed.userNotes = patch.userNotes.slice(0, 4000);
  return allowed;
}


async function buildSelfCheck({ sanitized = false } = {}) {
  const state = await getState();
  const report = await runSelfCheck({
    settings: state.settings,
    metadata: state.metadata,
    records: state.records,
    listenerState,
    ensureSpace: ensureActionCenterSpace,
    providerState: providerState(localRulesProvider),
    recoverySummary: state.recovery
  });
  await recordOperationalEvent("selfCheck", { status: report.overallStatus });
  const finalReport = sanitized ? sanitizeDiagnosticReport(report, state.diagnostics) : report;
  // Candidate identifiers only — never raw Authentication-Results headers.
  finalReport.authservCandidates = await getAuthservObservations();
  return finalReport;
}

async function handleRuntimeMessage(request) {
  const type = request?.type;
  if (type === "getState") {
    const state = await getState();
    return {
      ok: true,
      records: state.records,
      settings: state.settings,
      metadata: state.metadata,
      diagnostics: state.diagnostics,
      version: messenger.runtime.getManifest().version,
      listenerState: { ...listenerState },
      provider: providerState(localRulesProvider),
      recovery: state.recovery,
      historicalScan: historicalScanPublicState(),
      archiveExisting: archiveExistingPublicState(),
      accountLabels: await getAccountLabels(),
      categories: CATEGORY_ORDER,
      relationshipClasses: RELATIONSHIP_CLASSES,
      documentTypes: DOCUMENT_TYPES,
      retentionClasses: RETENTION_CLASSES,
      priorities: PRIORITIES,
      statuses: [...VALID_STATUSES]
    };
  }
  if (type === "updateRecord") {
    const record = await patchRecord(request.recordId, validatePatch(request.patch || {}));
    if (request.patch?.priority) {
      try {
        const message = await resolveRecordMessage(record);
        await applyPriorityTag(message, record.priority);
      } catch (error) {
        await logDiagnostic("error", "RETAG_AFTER_EDIT_FAILED", { message: safeError(error), headerMessageId: record.headerMessageId });
      }
    }
    await updateActionCenterBadge();
    return { ok: true, record };
  }
  if (type === "analyzeSelected") {
    const result = await analyzeSelectedMessages();
    return { ok: true, ...result };
  }
  if (type === "analyzeMessageIds") {
    const result = await analyzeMessageIds(request.messageIds);
    return { ok: true, ...result };
  }
  if (type === "openOriginal") {
    await openOriginal(request.recordId);
    return { ok: true };
  }
  if (type === "deleteOriginal") {
    const result = await deleteOriginal(request.recordId);
    return { ok: true, ...result };
  }
  if (type === "reanalyze") {
    const record = await reanalyzeRecord(request.recordId);
    return { ok: true, record };
  }
  if (type === "retryDocumentArchive") {
    const record = await retryDocumentArchive(request.recordId);
    return { ok: true, record };
  }
  if (type === "removeRecord") {
    await removeRecord(request.recordId);
    await updateActionCenterBadge();
    return { ok: true };
  }
  if (type === "clearClosed") {
    const remaining = await clearClosedRecords();
    await updateActionCenterBadge();
    return { ok: true, remaining };
  }
  if (type === "setDomainDisposition") {
    const result = await setDomainDisposition(request.domain, request.disposition);
    return { ok: true, ...result };
  }
  if (type === "setSettings") {
    const settings = await setSettings(request.patch || {});
    if (settings.autoTag) await ensurePriorityTags();
    await emitDesktopBridgeStatus("settings_changed");
    await updateActionCenterBadge();
    return { ok: true, settings };
  }
  if (type === "getHistoricalScanScope") {
    const accounts = await getHistoricalScanScope();
    return { ok: true, accounts, scan: historicalScanPublicState() };
  }
  if (type === "getHistoricalScanState") {
    return { ok: true, scan: historicalScanPublicState() };
  }
  if (type === "startHistoricalScan") {
    const scan = await startHistoricalScan(request.config || {});
    return { ok: true, scan };
  }
  if (type === "cancelHistoricalScan") {
    const scan = cancelHistoricalScan();
    return { ok: true, scan };
  }
  if (type === "getArchiveExistingScope") {
    const scope = await getArchiveExistingScope();
    return { ok: true, scope, archive: archiveExistingPublicState() };
  }
  if (type === "getArchiveExistingState") {
    return { ok: true, archive: archiveExistingPublicState() };
  }
  if (type === "startArchiveExisting") {
    const archive = await startArchiveExisting();
    return { ok: true, archive };
  }
  if (type === "cancelArchiveExisting") {
    const archive = cancelArchiveExisting();
    return { ok: true, archive };
  }
  if (type === "runSelfCheck") {
    const report = await buildSelfCheck();
    return { ok: true, report };
  }
  if (type === "getDiagnosticReport") {
    const report = await buildSelfCheck({ sanitized: true });
    return { ok: true, report };
  }
  if (type === "getRecoverySnapshot") {
    const snapshot = await getRecoverySnapshot();
    return { ok: true, snapshot };
  }
  if (type === "resetAcceptanceMetrics") {
    await clearDiagnostics();
    await recordOperationalEvent("acceptanceReset");
    const report = await buildSelfCheck();
    return { ok: true, report };
  }
  if (type === "openActionCenter") {
    await openActionCenter();
    return { ok: true };
  }
  return { ok: false, error: "Unknown request." };
}

async function initialize() {
  const componentFailures = [];

  // The runtime opens with CIVION Mail and lives until Thunderbird closes.
  if (!ensureCivionMailRuntime()) {
    componentFailures.push("mail-runtime: native messaging unavailable");
    await logDiagnostic("warning", "MAIL_RUNTIME_UNAVAILABLE", {
      message: "Thunderbird Native Messaging is unavailable"
    });
  }

  try {
    await reconcileInterruptedHistoricalScanState();
  } catch (error) {
    componentFailures.push(`historical-scan-state: ${safeError(error)}`);
    await logDiagnostic("warning", "HISTORICAL_SCAN_STATE_RECONCILE_FAILED", { message: safeError(error) });
  }

  try {
    await reconcileInterruptedArchiveExistingState();
  } catch (error) {
    componentFailures.push(`document-archive-state: ${safeError(error)}`);
    await logDiagnostic("warning", "DOCUMENT_ARCHIVE_STATE_RECONCILE_FAILED", { message: safeError(error) });
  }

  if (!runtimeMessageIdsInvalidated) {
    try {
      await invalidateRuntimeMessageIds();
      runtimeMessageIdsInvalidated = true;
    } catch (error) {
      componentFailures.push(`runtime-ids: ${safeError(error)}`);
      await logDiagnostic("warning", "RUNTIME_MESSAGE_ID_INVALIDATION_FAILED", { message: safeError(error) });
    }
  }

  try {
    await ensurePriorityTags();
  } catch (error) {
    componentFailures.push(`tags: ${safeError(error)}`);
    await logDiagnostic("warning", "TAG_INITIALIZATION_FAILED", { message: safeError(error) });
  }

  try {
    await ensureMenus();
  } catch (error) {
    componentFailures.push(`menus: ${safeError(error)}`);
    await logDiagnostic("warning", "MENU_INITIALIZATION_FAILED", { message: safeError(error) });
  }

  try {
    await ensureActionCenterSpace();
  } catch (error) {
    componentFailures.push(`space: ${safeError(error)}`);
    await logDiagnostic("warning", "SPACE_INITIALIZATION_FAILED", { message: safeError(error) });
  }

  try {
    await updateActionCenterBadge();
  } catch (error) {
    componentFailures.push(`badge: ${safeError(error)}`);
    await logDiagnostic("warning", "BADGE_INITIALIZATION_FAILED", { message: safeError(error) });
  }

  if (listenerState.errors.length) {
    for (const item of listenerState.errors) {
      await logDiagnostic("error", "LISTENER_REGISTRATION_FAILED", {
        message: item.message,
        context: item.name
      });
    }
  }

  if (!listenerState.newMail) {
    await recordOperationalEvent("initializationFailed");
    throw new Error("The essential new-mail listener could not be registered.");
  }

  await recordOperationalEvent("initialized", { componentFailures });
  return { ok: true, componentFailures };
}

registerListener(
  "newMail",
  messenger.messages?.onNewMailReceived,
  (folder, messages) => enqueue(() => handleNewMail(folder, messages)),
  true
);

registerListener(
  "moved",
  messenger.messages?.onMoved,
  (originalMessages, movedMessages) => enqueue(() => handleMoved(originalMessages, movedMessages))
);

registerListener(
  "deleted",
  messenger.messages?.onDeleted,
  (messages) => enqueue(() => handleDeleted(messages))
);

registerListener(
  "runtimeMessages",
  messenger.runtime?.onMessage,
  (request) => {
    if (request?.type === "cancelHistoricalScan" && historicalScanJob?.status === "running") {
      // Signal cancellation immediately so an in-flight historical batch can stop
      // at the next message boundary. State persistence remains serialized below.
      historicalScanJob.cancelRequested = true;
    }
    if (request?.type === "cancelArchiveExisting" && archiveExistingJob?.status === "running") {
      archiveExistingJob.cancelRequested = true;
    }
    return enqueue(() => handleRuntimeMessage(request)).catch((error) => ({
      ok: false,
      error: safeError(error)
    }));
  }
);

registerListener(
  "installed",
  messenger.runtime?.onInstalled,
  (details) => {
    void enqueue(async () => {
      await recordOperationalEvent("installed", details || {});
      await initialize();
      const desktopAvailable = await emitDesktopBridgeStatus(details?.reason || "install");
      if (["install", "update"].includes(String(details?.reason || ""))) {
        await emitDesktopBridgeBackfill(details?.reason || "update");
        if (desktopAvailable) {
          await emitDesktopEvidenceBackfill(details?.reason || "update");
        }
      }
      await retryPendingDocumentArchives();
      await openActionCenter();
    });
  }
);

registerListener(
  "startup",
  messenger.runtime?.onStartup,
  () => {
    void enqueue(async () => {
      await recordOperationalEvent("startup");
      await initialize();
      const desktopAvailable = await emitDesktopBridgeStatus("startup");
      if (desktopAvailable) await emitDesktopEvidenceBackfill("startup");
      await retryPendingDocumentArchives();
    });
  }
);

registerListener(
  "menus",
  messenger.menus?.onClicked,
  (info) => { void enqueue(() => handleMenuClick(info)); }
);

registerListener(
  "action",
  messenger.action?.onClicked,
  () => { void enqueue(() => openActionCenter()); }
);

listenerState.registeredAt = new Date().toISOString();

void enqueue(async () => {
  await recordOperationalEvent("backgroundActivated");
  await recordOperationalEvent("listenersRegistered");
  try {
    await initialize();
  } catch (error) {
    await logDiagnostic("error", "INITIALIZATION_FAILED", { message: safeError(error) });
  }
});
