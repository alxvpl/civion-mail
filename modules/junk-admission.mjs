// Junk admission gate — civion-mail-filter-authority-decision-r002 section 3.
//
// This gate does NOT decide whether a message is spam. It answers a narrower question:
// can it be proven that the sender is a party the user is already demonstrably in contact
// with. A message that fails the gate is not declared spam and receives no verdict; it is
// simply not admitted. Absence of proof is silence, never admission.
//
// The gate fails closed on every missing or unresolvable input.

export const MIN_PRIOR_RECORDS = 2;

export const ADMISSION_PATHS = Object.freeze({
  registryIdentity: "registry_identity",
  provenHistory: "proven_history"
});

// Path B condition 5: a prior record only counts as evidence if it came from a non-junk
// folder. Without this, spam that once reached the Inbox opens the gate for its own domain.
// An unresolvable folder does not count.
export function priorRecordQualifies(record = {}, junkFolderIds = new Set()) {
  if (!record || typeof record !== "object") return false;
  if (record.risk?.hardBlock === true) return false;
  const folderId = record.folderId;
  if (folderId === null || folderId === undefined || folderId === "") return false;
  if (junkFolderIds.has(String(folderId))) return false;
  return true;
}

export function collectPriorEvidence(priorRecords = [], junkFolderIds = new Set()) {
  const records = Array.isArray(priorRecords) ? priorRecords : [];
  // A blocked record anywhere in the domain's history bars the domain outright — it is not
  // merely excluded from the count.
  const blockedPresent = records.some((record) => record?.risk?.hardBlock === true);
  const qualifying = records.filter((record) => priorRecordQualifies(record, junkFolderIds));
  const verifiedCount = qualifying
    .filter((record) => record?.authenticationVerdict === "verified").length;
  return { qualifyingCount: qualifying.length, verifiedCount, blockedPresent };
}

export function evaluateJunkAdmission({ signals = {}, priorRecords = [], junkFolderIds = new Set() } = {}) {
  const reasons = [];
  const domain = String(signals.domain || "").toLowerCase();

  // Absolute bars, applied before either path.
  if (!domain) {
    return { admitted: false, path: null, reasons: ["The sender domain could not be determined."] };
  }
  if (signals.userBlockedDomain === true) {
    return { admitted: false, path: null, reasons: ["The sender domain is on the local blocked-domain list."] };
  }

  // Path A — registry identity. `verifiedIdentity` already requires all three conditions:
  // a protected-identity claim, the From domain allowlisted for that identity, and a
  // trusted authentication service verifying aligned control of the From domain.
  if (signals.verifiedIdentity === true) {
    return {
      admitted: true,
      path: ADMISSION_PATHS.registryIdentity,
      identity: signals.identityToken || null,
      reasons: ["The sender is a protected identity, authenticated, from a domain allowlisted for that identity."]
    };
  }

  // Path B — proven personal history. All conditions are cumulative.
  const evidence = collectPriorEvidence(priorRecords, junkFolderIds);

  if (signals.authenticationVerdict !== "verified") {
    reasons.push("The message under evaluation does not itself pass authentication.");
  }
  if (evidence.blockedPresent) {
    reasons.push("The sender domain has a blocked record in local history.");
  }
  if (evidence.qualifyingCount < MIN_PRIOR_RECORDS) {
    reasons.push(`Fewer than ${MIN_PRIOR_RECORDS} prior non-junk records exist for this sender domain.`);
  }
  if (evidence.verifiedCount < 1) {
    reasons.push("No prior non-junk record for this sender domain passed authentication.");
  }

  if (reasons.length === 0) {
    return {
      admitted: true,
      path: ADMISSION_PATHS.provenHistory,
      identity: null,
      reasons: ["The sender domain has authenticated non-junk history in this mailbox."],
      evidence
    };
  }

  return { admitted: false, path: null, reasons, evidence };
}
