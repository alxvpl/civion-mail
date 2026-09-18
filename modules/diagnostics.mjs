import { assessThunderbirdCompatibility } from "./compatibility.mjs";
import { BRIDGE_STATES, deriveBridgeState } from "./bridge-state.mjs";

// The transport check maps the four bridge states onto the three check statuses the
// report has. The two unknown states are warnings, not passes and not failures: a
// transport that was never tried, or whose last probe has no outcome, is not known
// to work, and red stays reserved for a failure that was actually observed.
const BRIDGE_CHECK_STATUS = Object.freeze({
  [BRIDGE_STATES.OK]: "pass",
  [BRIDGE_STATES.FAILED]: "fail",
  [BRIDGE_STATES.NEVER_ATTEMPTED]: "warn",
  [BRIDGE_STATES.INDETERMINATE]: "warn"
});

export function bridgeCheck(metadata) {
  const bridge = deriveBridgeState(metadata?.desktopBridge);
  const when = bridge.since ? ` Last known at ${bridge.since}.` : "";
  return {
    ...check("bridge", "Native Messaging transport to the Desktop host", BRIDGE_CHECK_STATUS[bridge.state], `${bridge.label} — ${bridge.note}${when}`),
    bridgeState: bridge.state,
    since: bridge.since,
    failureCode: bridge.lastFailureCode,
    failureReason: bridge.lastFailureReason
  };
}

function specialUses(folder) {
  if (!folder) return [];
  if (Array.isArray(folder.specialUse)) return folder.specialUse.map((value) => String(value).toLowerCase());
  if (folder.specialUse) return [String(folder.specialUse).toLowerCase()];
  return [];
}

function flattenFolders(rootFolder) {
  const output = [];
  const stack = rootFolder ? [rootFolder] : [];
  while (stack.length) {
    const folder = stack.pop();
    if (!folder) continue;
    output.push(folder);
    const children = Array.isArray(folder.subFolders) ? folder.subFolders : [];
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
  }
  return output;
}

function folderEligible(folder, settings) {
  const uses = specialUses(folder);
  const excluded = ["trash", "sent", "drafts", "templates", "outbox", "archives"];
  if (uses.some((value) => excluded.includes(value))) return false;
  if (!settings.analyzeJunk && uses.includes("junk")) return false;
  return true;
}

function countBySpecialUse(folders, use) {
  return folders.filter((folder) => specialUses(folder).includes(use)).length;
}

function check(id, label, status, detail) {
  return { id, label, status, detail: String(detail || "") };
}

function approximateBytes(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return null;
  }
}

function operationalForAccount(metadata, accountId) {
  return metadata?.operational?.perAccount?.[accountId] || {};
}

export async function runSelfCheck({ settings, metadata, records, listenerState, ensureSpace, providerState, recoverySummary }) {
  const generatedAt = new Date().toISOString();
  const checks = [];
  const operational = metadata?.operational || {};
  let browserInfo = null;
  let platformInfo = null;
  let accounts = [];
  let tagCount = null;
  let spaceId = null;

  let compatibility = null;
  try {
    browserInfo = await messenger.runtime.getBrowserInfo();
    platformInfo = await messenger.runtime.getPlatformInfo();
    const manifest = messenger.runtime.getManifest();
    compatibility = assessThunderbirdCompatibility(browserInfo, manifest);
    checks.push(check("runtime", "Thunderbird runtime", "pass", `${browserInfo.name || "Thunderbird"} ${browserInfo.version || "unknown"}`));
    checks.push(check("compatibility", "Thunderbird compatibility line", compatibility.status, compatibility.detail));
  } catch (error) {
    checks.push(check("runtime", "Thunderbird runtime", "fail", error instanceof Error ? error.message : String(error)));
  }

  // The "runtime" check above is Thunderbird. The native transport is a separate check,
  // read from what the background recorded; the self-check sends nothing itself.
  checks.push(bridgeCheck(metadata));

  try {
    const rawAccounts = await messenger.accounts.list(true);
    accounts = rawAccounts.map((account) => {
      const folders = flattenFolders(account.rootFolder);
      const eligible = folders.filter((folder) => folderEligible(folder, settings));
      const activity = operationalForAccount(metadata, account.id);
      return {
        id: String(account.id || ""),
        name: String(account.name || account.id || "Unnamed account"),
        type: String(account.type || "unknown"),
        identityCount: Array.isArray(account.identities) ? account.identities.length : 0,
        totalFolders: folders.length,
        eligibleFolders: eligible.length,
        excludedFolders: Math.max(0, folders.length - eligible.length),
        inboxFolders: countBySpecialUse(folders, "inbox"),
        junkFolders: countBySpecialUse(folders, "junk"),
        observedNewMailEvents: Number(activity.newMailEvents || 0),
        observedMessages: Number(activity.messagesSeen || 0),
        analyzedMessages: Number(activity.messagesAnalyzed || 0),
        lastObservedAt: activity.lastEventAt || null,
        coverageStatus: Number(activity.messagesAnalyzed || 0) > 0 ? "observed" : "not_observed"
      };
    });
    const eligibleFolders = accounts.reduce((sum, account) => sum + account.eligibleFolders, 0);
    checks.push(check(
      "accounts",
      "Account and folder discovery",
      accounts.length && eligibleFolders ? "pass" : "warn",
      `${accounts.length} accounts; ${eligibleFolders} eligible folders`
    ));
  } catch (error) {
    checks.push(check("accounts", "Account and folder discovery", "fail", error instanceof Error ? error.message : String(error)));
  }

  try {
    const tags = await messenger.messages.tags.list();
    tagCount = tags.length;
    checks.push(check("tags", "Thunderbird tag API", "pass", `${tagCount} existing tags are readable`));
  } catch (error) {
    checks.push(check("tags", "Thunderbird tag API", "fail", error instanceof Error ? error.message : String(error)));
  }

  try {
    spaceId = await ensureSpace();
    checks.push(check("space", "Action Center Space", "pass", `Space ${spaceId} is available`));
  } catch (error) {
    checks.push(check("space", "Action Center Space", "fail", error instanceof Error ? error.message : String(error)));
  }

  const providerIsSafe = providerState?.id === "local-rules"
    && providerState?.mode === "local"
    && providerState?.networkAccess === false;
  checks.push(check(
    "provider",
    "Analysis provider contract",
    providerIsSafe ? "pass" : "fail",
    providerIsSafe
      ? `Local Rules · contract v${providerState.contractVersion || "?"} · network disabled`
      : "The active provider is missing or does not satisfy the local-only contract."
  ));

  const recoveryCount = Number(recoverySummary?.entryCount || 0);
  checks.push(check(
    "recovery",
    "Migration recovery journal",
    recoveryCount ? "warn" : "pass",
    recoveryCount ? `${recoveryCount} recoverable storage entries are available for local export.` : "No quarantined storage entries."
  ));

  const listenerStatus = listenerState?.newMail && listenerState?.moved && listenerState?.deleted ? "pass" : "fail";
  checks.push(check(
    "listeners",
    "Mail event listeners",
    listenerStatus,
    listenerStatus === "pass" ? "New-mail, moved and deleted listeners are registered" : "One or more listeners are not registered"
  ));

  const storageBytes = approximateBytes({ records, metadata, settings });
  const storageStatus = metadata?.storagePressure ? "warn" : "pass";
  checks.push(check(
    "storage",
    "Local storage",
    storageStatus,
    `${records.length} records; approximately ${storageBytes === null ? "unknown" : storageBytes} bytes${metadata?.storagePressure ? "; storage pressure is active" : ""}`
  ));

  const acceptanceStarted = Boolean(operational.acceptanceResetAt);
  const accountCoverageComplete = accounts.length > 0 && accounts.every((account) => account.coverageStatus === "observed");
  const acceptanceGates = {
    accountCoverage: accountCoverageComplete,
    filteredFolder: Number(operational.nonInboxEligibleEventCount || 0) > 0,
    junkExcluded: Number(operational.junkExcludedEventCount || 0) > 0,
    junkAnalyzed: Number(operational.junkAnalyzedEventCount || 0) > 0,
    backgroundReactivated: Number(operational.backgroundActivationCount || 0) > 0
      && Number(operational.initializationCount || 0) > 0,
    moveObserved: Number(operational.movedEventCount || 0) > 0,
    deleteObserved: Number(operational.deletedEventCount || 0) > 0,
    noAnalysisFailures: Number(operational.analysisFailureCount || 0) === 0
  };

  if (!acceptanceStarted) {
    checks.push(check(
      "acceptance_window",
      "Live acceptance window",
      "warn",
      "Not started. Reset acceptance counters before running the live matrix."
    ));
  } else {
    checks.push(check(
      "acceptance_accounts",
      "Acceptance: all accounts observed",
      acceptanceGates.accountCoverage ? "pass" : "warn",
      acceptanceGates.accountCoverage
        ? `${accounts.length} account(s) have successful post-reset analysis.`
        : "Send one new test message to every configured account."
    ));
    checks.push(check(
      "acceptance_filtered_folder",
      "Acceptance: non-Inbox eligible folder",
      acceptanceGates.filteredFolder ? "pass" : "warn",
      acceptanceGates.filteredFolder
        ? "A post-reset new-mail event was observed in an eligible non-Inbox folder."
        : "Route a test message with a Thunderbird filter to a normal non-Inbox folder."
    ));
    checks.push(check(
      "acceptance_junk_off",
      "Acceptance: Junk excluded when disabled",
      acceptanceGates.junkExcluded ? "pass" : "warn",
      acceptanceGates.junkExcluded
        ? "A Junk-folder event was observed and excluded while Junk analysis was disabled."
        : "With Analyze Junk disabled, deliver one test message to Junk."
    ));
    checks.push(check(
      "acceptance_junk_on",
      "Acceptance: Junk analyzed when enabled",
      acceptanceGates.junkAnalyzed ? "pass" : "warn",
      acceptanceGates.junkAnalyzed
        ? "A Junk-folder event was observed and accepted for analysis."
        : "Enable Analyze Junk and deliver one test message to Junk."
    ));
    checks.push(check(
      "acceptance_reactivation",
      "Acceptance: background reactivation",
      acceptanceGates.backgroundReactivated ? "pass" : "warn",
      acceptanceGates.backgroundReactivated
        ? "The background runtime reactivated and initialized after the acceptance reset."
        : "Restart Thunderbird (or reload the Temporary Add-on after restart), then run self-check again."
    ));
    checks.push(check(
      "acceptance_move",
      "Acceptance: move event",
      acceptanceGates.moveObserved ? "pass" : "warn",
      acceptanceGates.moveObserved ? "A post-reset move event was observed." : "Move one analyzed test message."
    ));
    checks.push(check(
      "acceptance_delete",
      "Acceptance: delete event",
      acceptanceGates.deleteObserved ? "pass" : "warn",
      acceptanceGates.deleteObserved ? "A post-reset delete event was observed." : "Delete one analyzed test message."
    ));
    checks.push(check(
      "acceptance_failures",
      "Acceptance: analysis failures",
      acceptanceGates.noAnalysisFailures ? "pass" : "fail",
      acceptanceGates.noAnalysisFailures
        ? "No post-reset automatic analysis failures recorded."
        : `${Number(operational.analysisFailureCount || 0)} post-reset automatic analysis failure(s) recorded.`
    ));
  }

  const acceptanceComplete = acceptanceStarted && Object.values(acceptanceGates).every(Boolean);
  const acceptance = {
    status: !acceptanceStarted ? "not_started" : acceptanceComplete ? "pass" : "in_progress",
    resetAt: operational.acceptanceResetAt || null,
    gates: acceptanceGates,
    completedGateCount: Object.values(acceptanceGates).filter(Boolean).length,
    totalGateCount: Object.keys(acceptanceGates).length
  };

  const failed = checks.filter((item) => item.status === "fail").length;
  const warned = checks.filter((item) => item.status === "warn").length;

  return {
    reportVersion: 2,
    generatedAt,
    overallStatus: failed ? "fail" : warned ? "warn" : "pass",
    manifest: {
      version: messenger.runtime.getManifest().version,
      manifestVersion: messenger.runtime.getManifest().manifest_version,
      minimumThunderbirdVersion: messenger.runtime.getManifest().browser_specific_settings?.gecko?.strict_min_version || null
    },
    browserInfo,
    platformInfo,
    compatibility,
    provider: providerState || null,
    recovery: {
      entryCount: recoveryCount,
      status: recoverySummary?.status || (recoveryCount ? "recovery_available" : "clean"),
      lastUpdatedAt: recoverySummary?.lastUpdatedAt || null
    },
    listenerState: { ...listenerState },
    settings: {
      autoTag: settings.autoTag,
      analyzeJunk: settings.analyzeJunk,
      retentionDays: settings.retentionDays,
      maxRecords: settings.maxRecords,
      diagnosticLogging: settings.diagnosticLogging
    },
    storage: {
      recordCount: records.length,
      activeRecordCount: Number(metadata?.activeRecordCount || records.filter((record) => !["Completed", "Dismissed"].includes(record.status)).length),
      storagePressure: metadata?.storagePressure === true,
      approximateBytes: storageBytes,
      schemaVersion: metadata?.schemaVersion || null,
      lastWriteAt: metadata?.lastWriteAt || null,
      migration: metadata?.migration || null
    },
    operational,
    acceptance,
    accounts,
    tagCount,
    actionCenterSpaceId: spaceId,
    checks
  };
}

export function sanitizeDiagnosticReport(report, diagnostics = []) {
  const accountIndex = new Map((report.accounts || []).map((account, index) => [String(account.id || ""), `Account ${index + 1}`]));
  const perAccount = {};
  for (const [accountId, value] of Object.entries(report.operational?.perAccount || {})) {
    const alias = accountIndex.get(String(accountId)) || `Account ${Object.keys(perAccount).length + 1}`;
    perAccount[alias] = value;
  }
  return {
    ...report,
    listenerState: {
      ...(report.listenerState || {}),
      errors: (report.listenerState?.errors || []).map((entry) => ({ name: String(entry.name || "unknown") }))
    },
    operational: {
      ...(report.operational || {}),
      perAccount
    },
    accounts: (report.accounts || []).map((account, index) => ({
      account: `Account ${index + 1}`,
      type: account.type,
      identityCount: account.identityCount,
      totalFolders: account.totalFolders,
      eligibleFolders: account.eligibleFolders,
      excludedFolders: account.excludedFolders,
      inboxFolders: account.inboxFolders,
      junkFolders: account.junkFolders,
      observedNewMailEvents: account.observedNewMailEvents,
      observedMessages: account.observedMessages,
      analyzedMessages: account.analyzedMessages,
      lastObservedAt: account.lastObservedAt,
      coverageStatus: account.coverageStatus
    })),
    diagnostics: diagnostics.map((entry) => ({
      level: String(entry.level || ""),
      code: String(entry.code || ""),
      at: entry.at || null
    }))
  };
}
