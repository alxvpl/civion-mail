export const STORAGE_KEYS = Object.freeze({
  records: "mailSentinelRecords",
  settings: "mailSentinelSettings",
  diagnostics: "mailSentinelDiagnostics",
  metadata: "mailSentinelMetadata",
  recovery: "mailSentinelRecovery"
});

export const SCHEMA_VERSION = 6;
export const RECOVERY_LIMIT = 25;
const HISTORICAL_SOURCE_AGE_DAYS = 120;
const HISTORICAL_DEADLINE_AGE_DAYS = 30;

const DEFAULT_ANALYSIS_PROVIDER = Object.freeze({
  id: "local-rules",
  label: "Local Rules",
  mode: "local",
  role: "baseline",
  contractVersion: 1,
  networkAccess: false
});

const OVERWRITE_SENSITIVE_MANUAL_FIELDS = new Set([
  "requiredAction",
  "priority",
  "deadline",
  "categories"
]);

const TRACKED_MANUAL_FIELDS = new Set([
  ...OVERWRITE_SENSITIVE_MANUAL_FIELDS,
  "status",
  "markedIncorrect",
  "userNotes"
]);

export const DEFAULT_SETTINGS = Object.freeze({
  autoTag: false,
  analyzeJunk: false,
  retentionDays: 365,
  maxRecords: 2000,
  diagnosticLogging: false,
  desktopBridgeEnabled: true,
  automaticDocumentArchive: true,
  trustedAuthservIds: Object.freeze([]),
  userAllowlistedDomains: Object.freeze([]),
  userBlockedDomains: Object.freeze([])
});

function normalizeAuthservIds(value) {
  const source = Array.isArray(value) ? value : String(value || "").split(/[\s,;]+/u);
  const unique = [];
  for (const entry of source) {
    const id = String(entry || "").trim().toLowerCase();
    if (!id || id.length > 120 || !/^[a-z0-9._-]+$/u.test(id)) continue;
    if (!unique.includes(id)) unique.push(id);
    if (unique.length >= 10) break;
  }
  return unique;
}

function normalizeDomainList(value, limit = 200) {
  const source = Array.isArray(value) ? value : String(value || "").split(/[\s,;]+/u);
  const unique = [];
  for (const entry of source) {
    const domain = String(entry || "").trim().toLowerCase().replace(/^\.+|\.+$/gu, "");
    if (!domain || domain.length > 253) continue;
    if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(domain)) continue;
    if (!unique.includes(domain)) unique.push(domain);
    if (unique.length >= limit) break;
  }
  return unique;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function normalizeSettings(settings = {}) {
  return {
    autoTag: settings.autoTag === true,
    analyzeJunk: settings.analyzeJunk === true,
    retentionDays: boundedInteger(settings.retentionDays, DEFAULT_SETTINGS.retentionDays, 7, 3650),
    maxRecords: boundedInteger(settings.maxRecords, DEFAULT_SETTINGS.maxRecords, 100, 50000),
    diagnosticLogging: settings.diagnosticLogging === true,
    desktopBridgeEnabled: settings.desktopBridgeEnabled !== false,
    automaticDocumentArchive: settings.automaticDocumentArchive !== false,
    trustedAuthservIds: normalizeAuthservIds(settings.trustedAuthservIds),
    userAllowlistedDomains: normalizeDomainList(settings.userAllowlistedDomains),
    userBlockedDomains: normalizeDomainList(settings.userBlockedDomains)
  };
}



function normalizeAnalysisProvider(record = {}) {
  const provider = record.analysisProvider;
  if (provider && typeof provider === "object" && !Array.isArray(provider)) {
    return {
      id: typeof provider.id === "string" && provider.id ? provider.id : DEFAULT_ANALYSIS_PROVIDER.id,
      label: typeof provider.label === "string" && provider.label ? provider.label : DEFAULT_ANALYSIS_PROVIDER.label,
      mode: provider.mode === "local" ? "local" : DEFAULT_ANALYSIS_PROVIDER.mode,
      role: typeof provider.role === "string" && provider.role ? provider.role : DEFAULT_ANALYSIS_PROVIDER.role,
      contractVersion: Number.isInteger(provider.contractVersion) ? provider.contractVersion : DEFAULT_ANALYSIS_PROVIDER.contractVersion,
      networkAccess: false
    };
  }
  return { ...DEFAULT_ANALYSIS_PROVIDER };
}

function recoveryPreview(value) {
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= 50000) return { raw: value, truncated: false };
    return { rawPreview: serialized.slice(0, 50000), truncated: true };
  } catch {
    return { rawPreview: String(value).slice(0, 50000), truncated: true };
  }
}

function recoveryEntry(value, index, reason) {
  return {
    recoveryVersion: 1,
    recoveredAt: new Date().toISOString(),
    sourceIndex: index,
    reason,
    ...recoveryPreview(value)
  };
}

function normalizeRecovery(value) {
  return Array.isArray(value) ? value.slice(-RECOVERY_LIMIT) : [];
}

function valuesEqual(left, right) {
  if (left === right) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function normalizeManualFields(record = {}) {
  if (Array.isArray(record.manualFields)) {
    return [...new Set(record.manualFields.filter((field) =>
      TRACKED_MANUAL_FIELDS.has(field) || field === "legacy"
    ))];
  }
  return record.manualEdited === true ? ["legacy"] : [];
}

function normalizeDocumentArchive(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const allowedStates = new Set(["not_applicable", "pending", "archived", "partial", "failed"]);
  const files = Array.isArray(value.files) ? value.files.slice(0, 20).map((file) => ({
    partName: String(file?.partName || ""),
    originalFilename: String(file?.originalFilename || "").slice(0, 255),
    state: ["archived", "already_archived", "restored", "pending", "failed"].includes(file?.state) ? file.state : "failed",
    sha256: /^[0-9a-f]{64}$/u.test(String(file?.sha256 || "")) ? String(file.sha256) : null,
    relativePath: typeof file?.relativePath === "string" ? file.relativePath.slice(0, 700) : null,
    errorCode: typeof file?.errorCode === "string" ? file.errorCode.slice(0, 120) : null
  })) : [];
  return {
    state: allowedStates.has(value.state) ? value.state : "pending",
    root: "F:\\01_ARCHIVE\\CIVION",
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
    files
  };
}

function hasOverwriteSensitiveManualFields(fields = []) {
  return fields.includes("legacy") || fields.some((field) => OVERWRITE_SENSITIVE_MANUAL_FIELDS.has(field));
}

function isActive(record) {
  return !["Completed", "Dismissed"].includes(record.status);
}

function recordTime(record) {
  const value = Number(new Date(record.receivedAt || record.analyzedAt || record.updatedAt || 0));
  return Number.isFinite(value) ? value : 0;
}

function buildLegacyIdentity(record) {
  return [
    record.accountId || "",
    record.headerMessageId || "",
    record.receivedAt || "",
    record.sender || "",
    record.subject || ""
  ].join("|");
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function migrateRelativeSummary(record, legacyDeadline) {
  const summary = String(record.summary || "");
  if (!summary || !legacyDeadline?.date) return summary;
  const period = legacyDeadline.relativePeriod;
  const language = String(record.language || "en").toLowerCase();
  const phrase = period
    ? language === "bg"
      ? `Срок: ${period.count} ${period.unit} — началната дата не е потвърдена.`
      : language === "nl"
        ? `Termijn: ${period.count} ${period.unit} — startdatum niet bevestigd.`
        : `Period: ${period.count} ${period.unit} — start date unconfirmed.`
    : language === "bg"
      ? "Възможният срок изисква ръчна проверка."
      : language === "nl"
        ? "De mogelijke termijn moet handmatig worden gecontroleerd."
        : "The possible deadline requires manual verification.";
  const date = escapeRegExp(legacyDeadline.date);
  const labelled = new RegExp(`(?:Deadline|Termijn|Краен срок|Срок):\\s*${date}\\.?`, "giu");
  if (labelled.test(summary)) return summary.replace(labelled, phrase);
  return summary.replace(new RegExp(date, "gu"), phrase);
}

function shouldMigrateLegacyRelativeDeadline(record) {
  const deadline = record?.deadline;
  if (!deadline || typeof deadline !== "object") return false;
  if (deadline.manuallySet === true || deadline.raw === "manual") return false;
  return deadline.anchorAssumed === "message_date" && deadline.anchorResolved === false;
}

function migrateRecord(record) {
  const needsVerification = Array.isArray(record.needsVerification) ? [...record.needsVerification] : [];
  let deadline = record.deadline ?? null;
  let estimatedDeadline = record.estimatedDeadline ?? null;
  let summary = record.summary;

  if (shouldMigrateLegacyRelativeDeadline(record)) {
    const legacyDeadline = deadline;
    const { overdue: _overdue, manuallySet: _manuallySet, ...estimate } = legacyDeadline;
    estimatedDeadline = {
      ...estimate,
      anchorResolved: false
    };
    deadline = null;
    if (!needsVerification.includes("relative_deadline_anchor")) {
      needsVerification.push("relative_deadline_anchor");
    }
    const genericIndex = needsVerification.indexOf("deadline");
    if (genericIndex >= 0) needsVerification.splice(genericIndex, 1);
    summary = migrateRelativeSummary(record, legacyDeadline);
  }

  const manualFields = normalizeManualFields(record);
  const relationshipClass = record.relationshipClass || record.relationship?.class || "Unknown / Review";
  const claimedRelationshipClass = record.claimedRelationshipClass || record.relationship?.claimedClass || null;
  const relationship = record.relationship && typeof record.relationship === "object"
    ? { class: relationshipClass, claimedClass: claimedRelationshipClass, confidence: Number(record.relationship.confidence || 0), verificationState: record.relationship.verificationState || "legacy", basis: Array.isArray(record.relationship.basis) ? record.relationship.basis : [] }
    : { class: relationshipClass, claimedClass: claimedRelationshipClass, confidence: 0, verificationState: "legacy", basis: [] };
  const documentType = record.documentType || record.documentClassification?.type || "Other";
  const documentClassification = record.documentClassification && typeof record.documentClassification === "object"
    ? { type: documentType, confidence: Number(record.documentClassification.confidence || 0), basis: Array.isArray(record.documentClassification.basis) ? record.documentClassification.basis : [] }
    : { type: documentType, confidence: 0, basis: [] };
  const retention = record.retention && typeof record.retention === "object"
    ? { class: record.retention.class || "Review manually", reason: record.retention.reason || "Legacy record; re-analysis recommended for retention classification.", advisory: true, autoDelete: false }
    : { class: "Review manually", reason: "Legacy record; re-analysis recommended for retention classification.", advisory: true, autoDelete: false };
  return {
    ...record,
    summary,
    deadline,
    estimatedDeadline,
    schemaVersion: SCHEMA_VERSION,
    identityKey: record.identityKey || buildLegacyIdentity(record),
    deadlineCandidates: Array.isArray(record.deadlineCandidates) ? record.deadlineCandidates : [],
    // v0.8.0: records written before typed findings existed open normally with an
    // empty list. No schema migration is required — the field is additive.
    typedFindings: Array.isArray(record.typedFindings) ? record.typedFindings : [],
    needsVerification,
    userNotes: typeof record.userNotes === "string" ? record.userNotes : "",
    manualFields,
    manualEdited: hasOverwriteSensitiveManualFields(manualFields),
    analysisProvider: normalizeAnalysisProvider(record),
    contentHash: typeof record.contentHash === "string" ? record.contentHash : null,
    messageAvailable: record.messageAvailable !== false,
    sourceState: record.messageAvailable === false
      ? (record.sourceState === "trash" ? "trash" : "deleted")
      : "available",
    sourceUnavailableAt: record.messageAvailable === false && typeof record.sourceUnavailableAt === "string"
      ? record.sourceUnavailableAt
      : null,
    senderIdentity: record.senderIdentity && typeof record.senderIdentity === "object" ? record.senderIdentity : { displayName: null, address: null, domain: record?.senderTrust?.domain || null },
    relationshipClass,
    claimedRelationshipClass,
    relationship,
    documentType,
    documentClassification,
    obligation: record.obligation && typeof record.obligation === "object" ? record.obligation : { actionRequired: Boolean(record.action?.detected || record.mandatoryAction), replyExpected: Boolean(record.replyExpected), paymentRequired: record.financialEffect === "payment_due", deadline: record.deadline?.date || null, financialConsequence: Boolean(record.financialChange), needsVerification: Array.isArray(record.needsVerification) ? record.needsVerification : [] },
    retention,
    civicMapReference: record.civicMapReference && typeof record.civicMapReference === "object" ? record.civicMapReference : { eligible: false, status: "legacy_unclassified", runtimeLookup: false, route: "CIVION Civic via authenticated CIVION Gateway" },
    documentArchive: normalizeDocumentArchive(record.documentArchive)
  };
}

function migrateRecords(records, existingRecovery = []) {
  const migrated = [];
  const recovery = normalizeRecovery(existingRecovery);
  const sourceSchemaVersions = {};
  const seenIds = new Set();
  let migratedCount = 0;

  records.forEach((record, index) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      recovery.push(recoveryEntry(record, index, "invalid_record_type"));
      return;
    }
    if (typeof record.id !== "string" || !record.id.trim()) {
      recovery.push(recoveryEntry(record, index, "missing_record_id"));
      return;
    }
    if (seenIds.has(record.id)) {
      recovery.push(recoveryEntry(record, index, "duplicate_record_id"));
      return;
    }
    seenIds.add(record.id);
    const sourceVersion = Number.isInteger(record.schemaVersion) ? String(record.schemaVersion) : "unknown";
    sourceSchemaVersions[sourceVersion] = (sourceSchemaVersions[sourceVersion] || 0) + 1;
    const next = migrateRecord(record);
    if (record.schemaVersion !== SCHEMA_VERSION || !record.identityKey || !record.analysisProvider) migratedCount += 1;
    migrated.push(next);
  });

  return {
    records: migrated,
    recovery: recovery.slice(-RECOVERY_LIMIT),
    migration: {
      sourceSchemaVersions,
      recordsExamined: records.length,
      migratedCount,
      recoveredCount: Math.max(0, recovery.length - normalizeRecovery(existingRecovery).length)
    }
  };
}

function retainRecords(records, settings) {
  const cutoff = Date.now() - settings.retentionDays * 86400000;
  const current = records
    .filter((record) => isActive(record) || recordTime(record) >= cutoff)
    .sort((a, b) => recordTime(b) - recordTime(a));

  const active = current.filter(isActive);
  const closed = current.filter((record) => !isActive(record));
  const remainingSlots = Math.max(0, settings.maxRecords - active.length);
  const keptClosed = closed.slice(0, remainingSlots);
  const retained = [...active, ...keptClosed].sort((a, b) => recordTime(b) - recordTime(a));

  return {
    records: retained,
    storagePressure: active.length > settings.maxRecords,
    activeCount: active.length,
    closedEvicted: Math.max(0, closed.length - keptClosed.length)
  };
}

async function writeRecords(records, settings, metadata = {}) {
  const retention = retainRecords(records, settings);
  const nextMetadata = {
    ...metadata,
    schemaVersion: SCHEMA_VERSION,
    lastWriteAt: new Date().toISOString(),
    recordCount: retention.records.length,
    storagePressure: retention.storagePressure,
    activeRecordCount: retention.activeCount,
    closedEvictedOnLastWrite: retention.closedEvicted
  };
  await messenger.storage.local.set({
    [STORAGE_KEYS.records]: retention.records,
    [STORAGE_KEYS.metadata]: nextMetadata
  });
  return { ...retention, metadata: nextMetadata };
}

function daysUntilIsoDate(isoDate, currentDate = new Date()) {
  const match = String(isoDate || "").match(/^(20\d{2})-(\d{2})-(\d{2})$/u);
  if (!match || !(currentDate instanceof Date) || Number.isNaN(currentDate.valueOf())) return null;
  const target = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const today = Date.UTC(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate());
  return Math.round((target - today) / 86400000);
}

export function refreshDeadlineStatus(record, currentDate = new Date()) {
  if (!record || typeof record !== "object") return record;
  let changed = false;
  const next = { ...record };
  if (record.deadline?.date) {
    const daysRemaining = daysUntilIsoDate(record.deadline.date, currentDate);
    if (daysRemaining !== null) {
      const receivedAt = new Date(record.receivedAt || record.analyzedAt || currentDate);
      const receivedDay = Date.UTC(receivedAt.getFullYear(), receivedAt.getMonth(), receivedAt.getDate());
      const currentDay = Date.UTC(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate());
      const sourceAgeDays = Number.isNaN(receivedAt.valueOf())
        ? Number(record.deadline.sourceAgeDays || 0)
        : Math.max(0, Math.round((currentDay - receivedDay) / 86400000));
      const historicalExpired = sourceAgeDays > HISTORICAL_SOURCE_AGE_DAYS
        && daysRemaining < -HISTORICAL_DEADLINE_AGE_DAYS;
      const temporalState = historicalExpired
        ? "historical_expired"
        : daysRemaining < 0
          ? "recently_overdue"
          : daysRemaining === 0
            ? "due_today"
            : daysRemaining <= 3
              ? "due_soon"
              : "future";
      next.deadline = {
        ...record.deadline,
        daysRemaining,
        overdue: daysRemaining < 0,
        sourceAgeDays,
        temporalState,
        currentlyActionable: !historicalExpired
      };
      changed = changed
        || record.deadline.daysRemaining !== daysRemaining
        || record.deadline.overdue !== (daysRemaining < 0)
        || record.deadline.sourceAgeDays !== sourceAgeDays
        || record.deadline.temporalState !== temporalState
        || record.deadline.currentlyActionable !== !historicalExpired;
    }
  }
  if (record.estimatedDeadline?.date) {
    const daysRemaining = daysUntilIsoDate(record.estimatedDeadline.date, currentDate);
    if (daysRemaining !== null) {
      next.estimatedDeadline = { ...record.estimatedDeadline, daysRemaining };
      changed = changed || record.estimatedDeadline.daysRemaining !== daysRemaining;
    }
  }
  return changed ? next : record;
}

export async function getState() {
  const stored = await messenger.storage.local.get({
    [STORAGE_KEYS.records]: [],
    [STORAGE_KEYS.settings]: DEFAULT_SETTINGS,
    [STORAGE_KEYS.diagnostics]: [],
    [STORAGE_KEYS.metadata]: {},
    [STORAGE_KEYS.recovery]: []
  });

  const settings = normalizeSettings(stored[STORAGE_KEYS.settings]);
  const storedRecords = stored[STORAGE_KEYS.records];
  const rawRecords = Array.isArray(storedRecords) ? storedRecords : [];
  const existingRecovery = normalizeRecovery(stored[STORAGE_KEYS.recovery]);
  const migration = migrateRecords(rawRecords, existingRecovery);
  if (!Array.isArray(storedRecords) && storedRecords !== undefined && storedRecords !== null) {
    migration.recovery.push(recoveryEntry(storedRecords, -1, "invalid_records_container"));
    migration.recovery = migration.recovery.slice(-RECOVERY_LIMIT);
    migration.migration.recoveredCount += 1;
  }
  const records = migration.records.map((record) => refreshDeadlineStatus(record));
  const diagnostics = Array.isArray(stored[STORAGE_KEYS.diagnostics]) ? stored[STORAGE_KEYS.diagnostics] : [];
  const storedMetadata = stored[STORAGE_KEYS.metadata] && typeof stored[STORAGE_KEYS.metadata] === "object"
    ? stored[STORAGE_KEYS.metadata]
    : {};
  const metadata = { ...storedMetadata };
  const needsMigration = metadata.schemaVersion !== SCHEMA_VERSION
    || !Array.isArray(storedRecords)
    || migration.migration.migratedCount > 0
    || migration.migration.recoveredCount > 0;

  if (needsMigration) {
    const migrationMetadata = {
      currentSchemaVersion: SCHEMA_VERSION,
      previousSchemaVersion: Number.isInteger(metadata.schemaVersion) ? metadata.schemaVersion : null,
      lastRunAt: new Date().toISOString(),
      status: migration.migration.recoveredCount > 0 ? "recovery_required" : "completed",
      ...migration.migration,
      recoveryEntryCount: migration.recovery.length
    };
    await messenger.storage.local.set({ [STORAGE_KEYS.recovery]: migration.recovery });
    const written = await writeRecords(records, settings, { ...metadata, migration: migrationMetadata });
    return {
      records: written.records,
      settings,
      diagnostics,
      metadata: written.metadata,
      recovery: {
        entryCount: migration.recovery.length,
        lastUpdatedAt: migration.recovery.at(-1)?.recoveredAt || null,
        status: migrationMetadata.status
      }
    };
  }

  return {
    records,
    settings,
    diagnostics,
    metadata: { ...metadata, schemaVersion: SCHEMA_VERSION },
    recovery: {
      entryCount: existingRecovery.length,
      lastUpdatedAt: existingRecovery.at(-1)?.recoveredAt || null,
      status: existingRecovery.length ? "recovery_available" : "clean"
    }
  };
}

export async function getRecoverySnapshot() {
  const stored = await messenger.storage.local.get({
    [STORAGE_KEYS.recovery]: [],
    [STORAGE_KEYS.metadata]: {}
  });
  const entries = normalizeRecovery(stored[STORAGE_KEYS.recovery]);
  return {
    exportFormat: "CIVION_MAIL_RECOVERY",
    exportVersion: 1,
    generatedAt: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
    warning: "This local recovery export may contain message metadata and previous analysis values. Review it before sharing.",
    migration: stored[STORAGE_KEYS.metadata]?.migration || null,
    entries
  };
}

export async function getRecords() {
  return (await getState()).records;
}

const AUTHSERV_TALLY_KEY = "authservObservations";
const MAX_AUTHSERV_IDS = 20;

// Privacy-minimized discoverability aid (v0.1.14 audit P2): only the authserv-id
// token itself and a message count are kept. Never raw headers, never message content.
export async function recordAuthservObservations(ids) {
  if (!Array.isArray(ids) || !ids.length) return;
  const area = messenger.storage.local;
  const stored = await area.get(AUTHSERV_TALLY_KEY);
  const tally = stored?.[AUTHSERV_TALLY_KEY] && typeof stored[AUTHSERV_TALLY_KEY] === "object"
    ? { ...stored[AUTHSERV_TALLY_KEY] }
    : {};
  for (const rawId of ids) {
    const id = String(rawId || "").trim().toLowerCase();
    if (!id || id.length > 120 || !/^[a-z0-9._-]+$/u.test(id)) continue;
    if (!(id in tally) && Object.keys(tally).length >= MAX_AUTHSERV_IDS) continue;
    tally[id] = Math.min((tally[id] || 0) + 1, 999999);
  }
  await area.set({ [AUTHSERV_TALLY_KEY]: tally });
}

export async function getAuthservObservations() {
  const stored = await messenger.storage.local.get(AUTHSERV_TALLY_KEY);
  const tally = stored?.[AUTHSERV_TALLY_KEY];
  if (!tally || typeof tally !== "object") return [];
  return Object.entries(tally)
    .map(([id, count]) => ({ id, count: Number(count) || 0 }))
    .sort((a, b) => b.count - a.count);
}

export async function getSettings() {
  return (await getState()).settings;
}

export async function findRecord(recordId) {
  return (await getRecords()).find((record) => record.id === recordId) || null;
}

export async function findRecordsByHeaderMessageId(headerMessageId) {
  if (!headerMessageId) return [];
  return (await getRecords()).filter((record) => record.headerMessageId === headerMessageId);
}

export async function findMatchingRecord(identityKey, recordId = "") {
  const records = await getRecords();
  if (recordId) {
    const exact = records.find((record) => record.id === recordId);
    if (exact) return exact;
  }
  if (!identityKey) return null;
  return records.find((record) => record.identityKey === identityKey) || null;
}

export async function saveRecord(record, options = {}) {
  const state = await getState();
  const index = state.records.findIndex((item) =>
    item.id === record.id || (record.identityKey && item.identityKey === record.identityKey)
  );

  let storedId = record.id;
  let storedIdentity = record.identityKey;
  if (index >= 0) {
    const previous = state.records[index];
    const previousManualFields = normalizeManualFields(previous);
    const preserve = options.preserveManual !== false && hasOverwriteSensitiveManualFields(previousManualFields);
    const retainedManualFields = preserve
      ? previousManualFields
      : previousManualFields.filter((field) =>
          field !== "legacy" && !OVERWRITE_SENSITIVE_MANUAL_FIELDS.has(field)
        );
    const preservedFields = preserve ? {
      priority: previous.priority,
      status: previous.status,
      deadline: previous.deadline,
      deadlineCandidates: previous.deadlineCandidates,
      needsVerification: previous.needsVerification,
      categories: previous.categories,
      requiredAction: previous.requiredAction,
      markedIncorrect: previous.markedIncorrect,
      userNotes: previous.userNotes || "",
      manualFields: retainedManualFields,
      manualEdited: hasOverwriteSensitiveManualFields(retainedManualFields)
    } : {
      status: previous.status || record.status,
      markedIncorrect: previous.markedIncorrect || false,
      userNotes: previous.userNotes || "",
      manualFields: retainedManualFields,
      manualEdited: hasOverwriteSensitiveManualFields(retainedManualFields)
    };
    state.records[index] = {
      ...previous,
      ...record,
      ...preservedFields,
      schemaVersion: SCHEMA_VERSION,
      updatedAt: new Date().toISOString()
    };
    storedId = state.records[index].id;
    storedIdentity = state.records[index].identityKey;
  } else {
    const manualFields = normalizeManualFields(record);
    state.records.push({
      ...record,
      schemaVersion: SCHEMA_VERSION,
      identityKey: record.identityKey || buildLegacyIdentity(record),
      userNotes: typeof record.userNotes === "string" ? record.userNotes : "",
      manualFields,
      manualEdited: hasOverwriteSensitiveManualFields(manualFields),
      analysisProvider: normalizeAnalysisProvider(record),
      updatedAt: new Date().toISOString()
    });
    storedIdentity = record.identityKey || buildLegacyIdentity(record);
  }

  const written = await writeRecords(state.records, state.settings, state.metadata);
  return written.records.find((item) => item.id === storedId || item.identityKey === storedIdentity) || null;
}

export async function patchRecord(recordId, patch) {
  const state = await getState();
  const index = state.records.findIndex((record) => record.id === recordId);
  if (index < 0) throw new Error("Record not found.");
  const previous = state.records[index];
  const manualFields = new Set(normalizeManualFields(previous));
  for (const [field, value] of Object.entries(patch || {})) {
    if (TRACKED_MANUAL_FIELDS.has(field) && !valuesEqual(previous[field], value)) {
      manualFields.add(field);
    }
  }
  const normalizedManualFields = [...manualFields];
  state.records[index] = {
    ...previous,
    ...patch,
    schemaVersion: SCHEMA_VERSION,
    manualFields: normalizedManualFields,
    manualEdited: hasOverwriteSensitiveManualFields(normalizedManualFields),
    updatedAt: new Date().toISOString()
  };
  const written = await writeRecords(state.records, state.settings, state.metadata);
  return written.records.find((record) => record.id === recordId) || state.records[index];
}

export async function removeRecord(recordId) {
  const state = await getState();
  const records = state.records.filter((record) => record.id !== recordId);
  const written = await writeRecords(records, state.settings, state.metadata);
  return written.records.length;
}

export async function clearClosedRecords() {
  const state = await getState();
  const records = state.records.filter(isActive);
  const written = await writeRecords(records, state.settings, state.metadata);
  return written.records.length;
}

export async function setSettings(patch) {
  const state = await getState();
  const settings = normalizeSettings({ ...state.settings, ...patch });
  await messenger.storage.local.set({ [STORAGE_KEYS.settings]: settings });
  await writeRecords(state.records, settings, state.metadata);
  return settings;
}

export async function logDiagnostic(level, code, detail = {}) {
  const state = await getState();
  if (!state.settings.diagnosticLogging && level !== "error") return;
  const safeDetail = {
    message: String(detail.message || "").slice(0, 500),
    headerMessageId: String(detail.headerMessageId || "").slice(0, 300),
    context: String(detail.context || "").slice(0, 200)
  };
  const diagnostics = [
    ...state.diagnostics,
    { level, code, detail: safeDetail, at: new Date().toISOString() }
  ].slice(-100);
  await messenger.storage.local.set({ [STORAGE_KEYS.diagnostics]: diagnostics });
}

export async function patchRecordSystem(recordId, patch) {
  const state = await getState();
  const index = state.records.findIndex((record) => record.id === recordId);
  if (index < 0) return null;
  state.records[index] = {
    ...state.records[index],
    ...patch,
    schemaVersion: SCHEMA_VERSION,
    updatedAt: new Date().toISOString()
  };
  const written = await writeRecords(state.records, state.settings, state.metadata);
  return written.records.find((record) => record.id === recordId) || state.records[index];
}

export async function invalidateRuntimeMessageIds() {
  const state = await getState();
  let changedCount = 0;
  const records = state.records.map((record) => {
    if (record.currentMessageId === null || record.currentMessageId === undefined) return record;
    changedCount += 1;
    return {
      ...record,
      currentMessageId: null,
      // Without a stable RFC Message-ID the old numeric id cannot be recovered
      // safely in a new Thunderbird runtime.
      messageAvailable: record.headerMessageId ? record.messageAvailable !== false : false,
      sourceState: record.headerMessageId && record.messageAvailable !== false ? "available" : "unavailable",
      sourceUnavailableAt: record.headerMessageId && record.messageAvailable !== false
        ? null
        : record.sourceUnavailableAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  });
  if (!changedCount) return 0;
  await writeRecords(records, state.settings, state.metadata);
  return changedCount;
}

export async function updateTechnicalByIdentity(identityKey, patch) {
  if (!identityKey) return null;
  const state = await getState();
  const index = state.records.findIndex((record) => record.identityKey === identityKey);
  if (index < 0) return null;
  state.records[index] = {
    ...state.records[index],
    ...patch,
    schemaVersion: SCHEMA_VERSION,
    updatedAt: new Date().toISOString()
  };
  const written = await writeRecords(state.records, state.settings, state.metadata);
  return written.records.find((record) => record.identityKey === identityKey) || state.records[index];
}

export async function updateMetadata(patchOrFactory) {
  const stored = await messenger.storage.local.get({ [STORAGE_KEYS.metadata]: {} });
  const current = {
    schemaVersion: SCHEMA_VERSION,
    ...(stored[STORAGE_KEYS.metadata] || {})
  };
  const patch = typeof patchOrFactory === "function"
    ? patchOrFactory(structuredClone(current))
    : patchOrFactory;
  const next = {
    ...current,
    ...(patch || {}),
    schemaVersion: SCHEMA_VERSION
  };
  await messenger.storage.local.set({ [STORAGE_KEYS.metadata]: next });
  return next;
}

export async function clearDiagnostics() {
  await messenger.storage.local.set({ [STORAGE_KEYS.diagnostics]: [] });
  return [];
}
