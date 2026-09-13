export const DOCUMENT_ARCHIVE_ROOT = "F:\\01_ARCHIVE\\CIVION";
export const DOCUMENT_ARCHIVE_CONTRACT = "CIVION_DOCUMENT_ARCHIVE_NATIVE";
export const DOCUMENT_ARCHIVE_FORMAT = "CIVION_MAIL_DOCUMENT_ARCHIVE";
export const DOCUMENT_ARCHIVE_MAX_BYTES = 18 * 1024 * 1024;

const SERIOUS_RELATIONSHIPS = new Set([
  "Government & Public Administration",
  "Pension & Social Security",
  "Healthcare",
  "Employment & Salary",
  "Banking & Finance",
  "Insurance",
  "Housing",
  "Energy & Utilities",
  "Telecom & Internet",
  "Transport & Mobility",
  "Subscriptions & Digital Services",
  "Purchases & Retail",
  "Professional & Business Services"
]);

const GENERIC_NAMES = /^(?:no-?reply|noreply|billing|invoice|factuur|service|support|customer service|klantenservice|notification|mail)$/iu;
const PDF_TYPE_PATTERNS = [
  ["Invoice", /\b(?:invoice|factuur|rechnung|фактура)\b/iu],
  ["Receipt", /\b(?:receipt|betalingsbewijs|kwitantie|quittung|разписка)\b/iu],
  ["Statement", /\b(?:statement|afschrift|jaaropgave|overzicht|kontoauszug|извлечение)\b/iu],
  ["Decision", /\b(?:decision|beschikking|besluit|uitspraak|bescheid|entscheidung|решение)\b/iu],
  ["Contract / Contract change", /\b(?:contract|agreement|overeenkomst|voorwaarden|vertrag|договор)\b/iu],
  ["Policy", /\b(?:policy|polis|verzekering|insurance|versicherung|застрахов)\b/iu],
  ["Order", /\b(?:order|bestelling|purchase|aankoop|bestellung|поръчка)\b/iu],
  ["Notification", /\b(?:notification|notice|kennisgeving|melding|bericht|mitteilung|уведомление)\b/iu]
];

function safeSegment(value, fallback = "Unknown") {
  const clean = String(value || "")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "-")
    .replace(/\s+/gu, " ")
    .replace(/[. ]+$/gu, "")
    .trim()
    .slice(0, 100);
  return clean && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(clean)
    ? clean
    : fallback;
}

function senderOrganisation(record = {}) {
  const identity = record.senderIdentity || {};
  const display = String(identity.displayName || "").replace(/^['"]|['"]$/gu, "").trim();
  if (display && !GENERIC_NAMES.test(display)) return safeSegment(display, "Unknown organisation");
  const domain = String(identity.domain || record.senderTrust?.domain || "").toLowerCase();
  if (domain) {
    const labels = domain.split(".").filter(Boolean);
    const base = labels.length >= 2 ? labels.at(-2) : labels[0];
    return safeSegment(base?.replace(/[-_]+/gu, " ") || domain, "Unknown organisation");
  }
  const author = String(record.sender || "").replace(/<[^>]+>/gu, "").trim();
  return safeSegment(author, "Unknown organisation");
}

function dateOf(record = {}) {
  const candidate = String(record.receivedAt || record.analyzedAt || "").slice(0, 10);
  return /^20\d{2}-\d{2}-\d{2}$/u.test(candidate) ? candidate : new Date().toISOString().slice(0, 10);
}

function attachmentDocumentType(record = {}, attachment = {}) {
  const source = `${attachment.name || ""} ${record.subject || ""}`;
  for (const [type, pattern] of PDF_TYPE_PATTERNS) {
    if (pattern.test(source)) return { type, confidence: 0.94, basis: `attachment_name:${type}` };
  }
  const type = String(record.documentType || record.documentClassification?.type || "Other");
  const confidence = Number(record.documentClassification?.confidence || 0);
  return { type, confidence, basis: `message_classification:${type}` };
}

function documentNumber(record = {}, attachment = {}) {
  const source = `${attachment.name || ""} ${record.subject || ""}`;
  const labelled = source.match(/\b(?:invoice|factuur|receipt|order|bestelling|statement|afschrift|policy|polis|decision|besluit|contract|reference|referentie|ref)\s*(?:no\.?|nr\.?|number|nummer|#|:|-)?\s*([A-Z0-9][A-Z0-9._/-]{2,})/iu);
  return safeSegment(labelled?.[1] || "No-number", "No-number");
}

function areaAndSubtype(record, type, review) {
  if (review) return { area: "90_REVIEW", subtype: null };
  const relationship = String(record.relationshipClass || "Unknown / Review");
  if (relationship === "Healthcare") return { area: "05_HEALTH", subtype: null };
  if (["Government & Public Administration", "Pension & Social Security"].includes(relationship)) {
    return {
      area: "04_OFFICIAL",
      subtype: type === "Decision" ? "Decisions" : type === "Notification" ? "Notifications" : "Other"
    };
  }
  if (["Banking & Finance", "Insurance"].includes(relationship)) {
    return {
      area: "03_FINANCE_INSURANCE",
      subtype: type === "Statement" ? "Statements" : type === "Policy" ? "Policies" : "Other"
    };
  }
  const purchase = relationship === "Purchases & Retail"
    || (record.categories || []).includes("Commercial")
    || relationship === "Marketing";
  if (purchase) {
    return {
      area: "02_PURCHASES",
      subtype: type === "Receipt" ? "Receipts" : type === "Order" ? "Orders" : "Invoices"
    };
  }
  return {
    area: "01_SUPPLIERS",
    subtype: type === "Contract / Contract change" ? "Contracts" : type === "Invoice" ? "Invoices" : "Other"
  };
}

function isEligibleType(type, record) {
  if (["Invoice", "Receipt", "Statement", "Decision", "Notification", "Contract / Contract change", "Policy", "Order"].includes(type)) return true;
  return SERIOUS_RELATIONSHIPS.has(String(record.relationshipClass || ""))
    && !["Marketing message", "Delivery notice", "Security alert"].includes(type);
}

export function buildDocumentArchivePlans(record = {}, attachments = []) {
  if (record.risk?.hardBlock === true || record.risk?.level === "High") return [];
  const organisation = senderOrganisation(record);
  const documentDate = dateOf(record);
  const year = documentDate.slice(0, 4);
  const plans = [];
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    const name = String(attachment?.name || "");
    const mediaType = String(attachment?.contentType || "").split(";", 1)[0].toLowerCase();
    if (!/\.pdf$/iu.test(name) && mediaType !== "application/pdf") continue;
    const classification = attachmentDocumentType(record, attachment);
    if (!isEligibleType(classification.type, record)) continue;
    const relationshipConfidence = Number(record.relationship?.confidence || 0);
    const review = record.risk?.level === "Medium"
      || classification.confidence < 0.7
      || relationshipConfidence < 0.7
      || (String(record.relationshipClass || "") === "Unknown / Review" && classification.confidence < 0.9);
    const destination = areaAndSubtype(record, classification.type, review);
    const number = documentNumber(record, attachment);
    const typeToken = safeSegment(classification.type.replace(" / Contract change", ""), "Document").replace(/\s+/gu, "-");
    const orgToken = organisation.replace(/\s+/gu, "-");
    const filename = safeSegment(`${documentDate}__${orgToken}__${typeToken}__${number}.pdf`, `${documentDate}__Document.pdf`);
    const parts = destination.subtype
      ? [destination.area, organisation, year, destination.subtype, filename]
      : [destination.area, organisation, year, filename];
    plans.push({
      attachment: {
        name,
        contentType: "application/pdf",
        size: Number(attachment?.size || 0),
        partName: String(attachment?.partName || "")
      },
      area: destination.area,
      documentType: classification.type,
      confidence: classification.confidence,
      requiresReview: review,
      reasons: [classification.basis, `relationship:${record.relationshipClass || "Unknown / Review"}`],
      organisation,
      documentDate,
      documentNumber: number === "No-number" ? null : number,
      relativePath: parts.join("/")
    });
  }
  return plans;
}

export function buildDocumentArchivePackage({ record, plan, byteLength, sha256, contentBase64, addonVersion }) {
  return {
    exportFormat: DOCUMENT_ARCHIVE_FORMAT,
    exportVersion: 1,
    generatedAt: new Date().toISOString(),
    addonVersion: String(addonVersion || ""),
    archiveRootId: "CIVION_LOCAL_ARCHIVE_V1",
    source: {
      record_id: String(record.id || ""),
      source_message_id: String(record.id || ""),
      message_id_header: record.headerMessageId ? String(record.headerMessageId) : null,
      received_at: String(record.receivedAt || record.analyzedAt || new Date().toISOString()),
      sender_address: record.senderIdentity?.address ? String(record.senderIdentity.address) : null,
      sender_domain: record.senderIdentity?.domain ? String(record.senderIdentity.domain) : null,
      organisation: plan.organisation
    },
    classification: {
      area: plan.area,
      document_type: plan.documentType,
      confidence: plan.confidence,
      requires_review: plan.requiresReview,
      reasons: plan.reasons
    },
    document: {
      original_filename: plan.attachment.name,
      media_type: "application/pdf",
      byte_length: byteLength,
      sha256,
      content_base64: contentBase64,
      document_date: plan.documentDate,
      document_number: plan.documentNumber,
      relative_path: plan.relativePath
    }
  };
}
