function token(value) {
  return String(value || "record").replace(/[^a-zA-Z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 80) || "record";
}

function senderParts(sender) {
  const raw = String(sender || "");
  const match = raw.match(/<([^<>\s]+@[^<>\s]+)>/u) || raw.match(/([^<>\s]+@[^<>\s]+)/u);
  const address = String(match?.[1] || "").replace(/[>,;]+$/gu, "");
  const domain = address.includes("@") ? address.split("@").pop().toLowerCase() : "";
  const displayName = raw.replace(/<[^>]+>/gu, "").replace(/^['"]|['"]$/gu, "").trim();
  return { displayName: displayName || null, address: address || null, domain: domain || null };
}

function normalizedContentHash(value) {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  const match = raw.match(/^(?:sha256:)?([0-9a-f]{64})$/u);
  return match?.[1] || null;
}

function riskState(record) {
  if (record?.risk?.hardBlock === true) return "Quarantine Recommended";
  if ((record?.risk?.score || 0) >= 60) return "High Risk";
  if ((record?.risk?.score || 0) >= 30) return "Suspicious";
  return "None";
}

const SENSITIVE_RELATIONSHIPS = new Set([
  "Healthcare",
  "Banking & Finance",
  "Insurance",
  "Pension & Social Security"
]);

export function inferDataClassification(record) {
  const relationship = record?.relationshipClass || record?.relationship?.class || "";
  const hasPayment = Array.isArray(record?.amounts) && record.amounts.length > 0;
  const paymentCategory = Array.isArray(record?.categories) && record.categories.includes("Payment");
  return SENSITIVE_RELATIONSHIPS.has(relationship) || hasPayment || paymentCategory ? "C3" : "C2";
}

export function buildCivionMailEnvelope(record, addonVersion = "0.5.0", generatedAt = new Date().toISOString()) {
  const id = token(record.id);
  const sender = senderParts(record.sender);
  const relationship = record.relationship || {};
  const dataClassification = inferDataClassification(record);
  return {
    request_id: `REQ-CM-${id}`,
    contract_name: "CivionMailIngestion",
    contract_version: "0.2",
    payload_version: "0.2",
    source_project: "CIVION Mail",
    source_component: "ThunderbirdExtension",
    source_module_version: addonVersion,
    timestamp: generatedAt,
    purpose_code: "inbound_message_ingestion",
    correlation_id: `COR-CM-${id}`,
    idempotency_key: `mail:${token(record.accountId)}:${token(record.currentMessageId || record.headerMessageId || record.id)}:2`,
    data_classification: dataClassification,
    confirmation_tier: 1,
    provenance_refs: ["LEGACY-ALIAS:MAIL_SENTINEL"],
    payload: {
      message: {
        source_message_id: record.id,
        account_ref: record.accountId || null,
        folder_ref: record.folderId || null,
        source_token: String(record.currentMessageId || record.headerMessageId || record.id),
        observed_at: record.analyzedAt || generatedAt,
        received_at: record.receivedAt || null,
        from: { display_name: sender.displayName, address: sender.address, domain: sender.domain },
        reply_to: record?.senderTrust?.authentication?.replyTo?.address ? [record.senderTrust.authentication.replyTo.address] : [],
        subject: record.subject || null,
        message_id_header: record.headerMessageId || null,
        content_hash: normalizedContentHash(record.contentHash),
        attachment_manifest: (record.importantAttachments || []).map((item) => ({ name: item.name || null, content_type: item.contentType || null, size: item.size || 0 }))
      },
      analysis: {
        analyser_version: record.analysisVersion || `local-rules-${addonVersion}`,
        analysis_state: "Inferred",
        priority: record.priority,
        categories: record.categories || [],
        relationship_class: record.relationshipClass || relationship.class || "Unknown / Review",
        claimed_relationship_class: record.claimedRelationshipClass || relationship.claimedClass || null,
        document_type: record.documentType || "Other",
        retention_class: record?.retention?.class || "Review manually",
        retention_reason: record?.retention?.reason || null,
        summary: record.summary || null,
        suspicious: Boolean(record?.risk?.hardBlock || (record?.risk?.score || 0) >= 30),
        confidence_score: Number(record.confidence || 0),
        warnings: record.needsVerification || []
      },
      organisation_candidates: sender.domain ? [{
        candidate_id: `CAND-ORG-${id}`,
        observed_name: sender.displayName || sender.domain,
        observed_domain: sender.domain,
        known_alias: record?.senderTrust?.institutionIdentity?.label || null,
        match_signals: relationship.basis || [],
        authenticity_warnings: record?.risk?.reasons || [],
        confidence_score: Number(relationship.confidence || 0)
      }] : [],
      relationship_candidates: relationship.class && relationship.class !== "Unknown / Review" ? [{
        candidate_id: `CAND-REL-${id}`,
        organisation_ref: `CAND-ORG-${id}`,
        relationship_type: relationship.class,
        basis: (relationship.basis || []).join("; ") || null,
        status_candidate: "Potential",
        confidence_score: Number(relationship.confidence || 0)
      }] : [],
      action_candidates: record.action?.detected ? [{
        candidate_id: `CAND-ACT-${id}`,
        title: record.requiredAction || "Review message",
        description: record.summary || null,
        priority: record.priority,
        consequence: record.financialEffect || null,
        source_span: record.action?.evidence?.[0]?.sentence || null,
        confidence_score: Number(record.action?.strength || 0)
      }] : [],
      deadline_candidates: record.deadline?.date ? [{
        candidate_id: `CAND-DDL-${id}`,
        deadline_type: record.deadline.temporalState === "historical_expired"
          ? "Historical"
          : record.deadline.manuallySet ? "Explicit" : "Inferred",
        stated_date: record.deadline.date,
        timezone: "Europe/Amsterdam",
        basis: record.deadline.raw || record.deadline.evidence || null,
        assumptions: [],
        source_span: record.deadline.raw || null,
        // CivionMailIngestion/0.2 fixes the fields of a deadline candidate, and the
        // Desktop spool rejects a package that carries any other one. This item
        // previously also sent temporal_state, currently_actionable and
        // source_age_days: nothing read them, and every package with a deadline was
        // refused before it could reach review because of them. The temporal reading
        // that mattered is already carried by deadline_type, which distinguishes
        // Historical from Explicit and Inferred. Widening the contract is a separate,
        // deliberate decision; until it is taken, Mail speaks the contract it has.
        confidence_score: Number(record.deadline.confidence || record.deadline.evidenceStrength || 0)
      }] : [],
      payment_candidates: (record.amounts || []).slice(0, 5).map((amount, index) => ({
        candidate_id: `CAND-PAY-${id}-${index + 1}`,
        amount: Number(amount.value ?? amount.amount ?? 0),
        currency: amount.currency || "EUR",
        direction: record.financialEffect === "payment_due" ? "Payable" : record.financialEffect === "payment_received" ? "Receivable" : "Unknown",
        period: null,
        prior_amount: null,
        source_span: amount.raw || null,
        confidence_score: Number(amount.confidence || record.confidence || 0)
      })),
      security: {
        risk_state: riskState(record),
        reasons: record?.risk?.reasons || [],
        protected_identity_match: record?.senderTrust?.institutionIdentity?.label || null,
        domain_mismatch: Boolean(record?.senderTrust?.mismatch),
        link_mismatch: Boolean((record?.risk?.reasons || []).some((reason) => /link|url|domain/iu.test(String(reason)))),
        reply_to_mismatch: record?.senderTrust?.authentication?.replyTo?.alignment === "different",
        requires_safe_review: Boolean(record?.risk?.hardBlock || (record?.risk?.score || 0) >= 60)
      },
      civic_reference: record.civicMapReference || null
    }
  };
}

export function buildCivionMailPackage(records = [], addonVersion = "0.5.0") {
  const generatedAt = new Date().toISOString();
  const envelopes = records.map((record) => buildCivionMailEnvelope(record, addonVersion, generatedAt));
  const missingContentHashes = records.filter((record) => !normalizedContentHash(record.contentHash)).length;
  return {
    exportFormat: "CIVION_MAIL_CANDIDATE_PACKAGE",
    exportVersion: 2,
    contract_name: "CivionMailIngestion",
    contract_version: "0.2",
    generatedAt,
    addonVersion,
    transport: "manual_local_package",
    authority: "candidate_only",
    lineage: {
      current_module: "CIVION Mail",
      legacy_alias: "MAIL_SENTINEL",
      previous_contract: "MailSentinelIngestion/0.1"
    },
    warnings: missingContentHashes ? [`${missingContentHashes} legacy record(s) have no normalized content hash until re-analysis.`] : [],
    envelopes
  };
}
