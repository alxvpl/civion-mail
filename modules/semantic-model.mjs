export const RELATIONSHIP_CLASSES = Object.freeze([
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
  "Professional & Business Services",
  "Personal",
  "Marketing",
  "Unknown / Review"
]);

export const DOCUMENT_TYPES = Object.freeze([
  "Invoice",
  "Receipt",
  "Statement",
  "Decision",
  "Notification",
  "Reminder",
  "Contract / Contract change",
  "Renewal",
  "Cancellation",
  "Delivery notice",
  "Security alert",
  "Correspondence",
  "Marketing message",
  "Other"
]);

export const RETENTION_CLASSES = Object.freeze([
  "Keep",
  "Keep temporarily",
  "Reference only",
  "Disposable",
  "Review manually"
]);

const PUBLIC_IDS = new Set(["cjib","belastingdienst","toeslagen","digid","mijnoverheid","rijksoverheid","duo","ind","rdw","politie","rechtspraak","kvk","overheid"]);
const PENSION_IDS = new Set(["svb","pensioenfonds-pgb"]);
const EMPLOYMENT_IDS = new Set(["uwv","fnv"]);
const BANK_IDS = new Set(["paypal","bitvavo","ics"]);
const INSURANCE_IDS = new Set(["anwb"]);
const TELECOM_IDS = new Set(["odido","openfiber","belsimpel"]);
const ENERGY_IDS = new Set(["nextenergy","shell"]);
const TRANSPORT_IDS = new Set(["postnl","volkswagen","skoda","audi","wittebrug"]);
const DIGITAL_IDS = new Set(["google","openai","anthropic","github","cloudflare","notion","figma","ideogram","elevenlabs","discord","bitly","vimexx","bitdefender","licentie2go","wpmudev","lovable","magic-patterns","language-tool","quillbot","sync","ifttt","stardock","sudowrite"]);
const RETAIL_IDS = new Set(["amazon-nl","gmktec","minisforum","gamekeydiscounter","2go-software","antivirus-eu","envato","mcp-market","sihoo","claro-carwash","coolmuster"]);
const HEALTH_IDS = new Set(["23andme","infomedics"]);

function norm(value) { return String(value || "").normalize("NFKC").toLowerCase(); }
function any(text, patterns) { return patterns.some((pattern) => pattern.test(text)); }
function identityId(senderTrust = {}) { return String(senderTrust?.institutionIdentity?.id || "").toLowerCase(); }
function domain(senderTrust = {}) { return String(senderTrust?.domain || "").toLowerCase(); }

const REL_RULES = [
  ["Healthcare", [/\b(?:health|healthcare|hospital|clinic|doctor|dentist|pharmacy|zorg|ziekenhuis|huisarts|tandarts|apotheek|gezondheid|medisch|здраве|болница|лекар|аптека|krankenhaus|arzt|apotheke)\b/iu]],
  ["Employment & Salary", [/\b(?:salary|payroll|employer|employment|hr department|loon|salaris|werkgever|arbeidsovereenkomst|personeelszaken|заплата|работодател|трудов|gehalt|arbeitgeber|personalabteilung)\b/iu]],
  ["Banking & Finance", [/\b(?:bank|credit card|debit card|loan|mortgage|banking|rekening|creditcard|bankrekening|lening|hypotheek|банка|кредит|сметка|darlehen|konto|kreditkarte)\b/iu]],
  ["Insurance", [/\b(?:insurance|insurer|policy number|verzekering|verzekeraar|polis|застрахов|versicherung|versicherer)\b/iu]],
  ["Housing", [/\b(?:rent|rental|tenant|landlord|housing|huur|huurder|verhuurder|woning|wooncorporatie|наем|жилище|vermieter|mieter|wohnung)\b/iu]],
  ["Energy & Utilities", [/\b(?:energy|electricity|gas bill|water bill|utility|energie|stroom|gasrekening|waterbedrijf|енерг|ток|газ|вода|energieversorger|strom|gasrechnung)\b/iu]],
  ["Telecom & Internet", [/\b(?:telecom|mobile plan|internet provider|broadband|fiber|mobiel|internetabonnement|glasvezel|телеком|интернет|мобилен|mobilfunk|glasfaser)\b/iu]],
  ["Transport & Mobility", [/\b(?:transport|mobility|vehicle|car|train|parking|delivery carrier|vervoer|mobiliteit|auto|trein|parkeren|voertuig|транспорт|автомобил|паркинг|verkehr|fahrzeug|bahn)\b/iu]],
  ["Subscriptions & Digital Services", [/\b(?:subscription|software|hosting|domain name|cloud service|account plan|abonnement|softwarelicentie|hosting|domeinnaam|cloudservice|абонамент|софтуер|хостинг|cloud-dienst|softwarelizenz)\b/iu]],
  ["Purchases & Retail", [/\b(?:order|purchase|shop|store|retail|bestelling|aankoop|winkel|поръчка|покупка|магазин|bestellung|einkauf|shop)\b/iu]],
  ["Professional & Business Services", [/\b(?:consulting|professional services|business services|agency|accountant|legal services|advies|zakelijke dienstverlening|boekhouder|juridische dienstverlening|консулт|счетовод|geschäftsdienstleistung|beratung)\b/iu]]
];

function classFromIdentity(id) {
  if (!id) return null;
  if (PENSION_IDS.has(id)) return "Pension & Social Security";
  if (EMPLOYMENT_IDS.has(id)) return "Employment & Salary";
  if (BANK_IDS.has(id)) return "Banking & Finance";
  if (INSURANCE_IDS.has(id)) return "Insurance";
  if (TELECOM_IDS.has(id)) return "Telecom & Internet";
  if (ENERGY_IDS.has(id)) return "Energy & Utilities";
  if (TRANSPORT_IDS.has(id)) return "Transport & Mobility";
  if (DIGITAL_IDS.has(id)) return "Subscriptions & Digital Services";
  if (RETAIL_IDS.has(id)) return "Purchases & Retail";
  if (HEALTH_IDS.has(id)) return "Healthcare";
  if (PUBLIC_IDS.has(id)) return "Government & Public Administration";
  return null;
}

function claimedPublicClass(senderTrust = {}) {
  const id = identityId(senderTrust);
  if (PUBLIC_IDS.has(id) || PENSION_IDS.has(id) || EMPLOYMENT_IDS.has(id)) return classFromIdentity(id) || "Government & Public Administration";
  if (!id && senderTrust.officialDomainClaim) return "Government & Public Administration";
  return null;
}

export function classifyRelationship({ senderTrust = {}, text = "", commercial = false, personal = false, risk = {} } = {}) {
  const id = identityId(senderTrust);
  const identityClass = classFromIdentity(id);
  const claimedClass = claimedPublicClass(senderTrust);

  if (senderTrust.institutionMismatch || risk.hardBlock === true) {
    return { class: "Unknown / Review", claimedClass: claimedClass || identityClass, confidence: 0.99, verificationState: "identity_mismatch", basis: ["protected_identity_mismatch"] };
  }

  if (claimedClass && !(senderTrust.verifiedIdentity || senderTrust.authenticatedOfficial)) {
    return { class: "Unknown / Review", claimedClass, confidence: 0.97, verificationState: "unverified_public_claim", basis: ["public_identity_claim_requires_verification"] };
  }

  if (identityClass && (senderTrust.verifiedIdentity || senderTrust.authentication?.verdict === "verified" || !claimedClass)) {
    return {
      class: identityClass,
      claimedClass: claimedClass || identityClass,
      confidence: senderTrust.verifiedIdentity ? 0.99 : 0.94,
      verificationState: senderTrust.verifiedIdentity ? "verified_identity" : "authenticated_or_known_identity",
      basis: [`protected_identity:${id}`]
    };
  }

  const d = domain(senderTrust);
  if (/\b(?:kpn\.com|kpn\.nl|ziggo\.nl|vodafone\.nl|tele2\.nl)$/u.test(d)) return { class: "Telecom & Internet", claimedClass: null, confidence: 0.96, verificationState: "domain_inference", basis: [`sender_domain:${d}`] };
  if (/\b(?:ing\.nl|rabobank\.nl|abnamro\.nl|bunq\.com|knab\.nl)$/u.test(d)) return { class: "Banking & Finance", claimedClass: null, confidence: 0.98, verificationState: "domain_inference", basis: [`sender_domain:${d}`] };

  if (commercial) return { class: "Marketing", claimedClass: null, confidence: 0.9, verificationState: "content_inference", basis: ["commercial_message_signals"] };
  if (personal) return { class: "Personal", claimedClass: null, confidence: 0.88, verificationState: "sender_inference", basis: ["personal_sender_signals"] };

  const source = norm(text);
  for (const [relationshipClass, patterns] of REL_RULES) {
    if (any(source, patterns)) return { class: relationshipClass, claimedClass: null, confidence: 0.72, verificationState: "content_inference", basis: [`content:${relationshipClass}`] };
  }

  return { class: "Unknown / Review", claimedClass: claimedClass || null, confidence: 0.35, verificationState: "unknown", basis: [] };
}

const DOC_RULES = [
  ["Receipt", [/\b(?:receipt|payment received|paid successfully|betalingsbewijs|betaling ontvangen|betaald|kwitantie|разписка|плащането е получено|quittung|zahlung erhalten)\b/iu]],
  ["Invoice", [/\b(?:invoice|amount due|factuur|te betalen|rekeningnummer|фактура|дължима сума|rechnung|zahlbar)\b/iu]],
  ["Statement", [/\b(?:statement|account statement|annual statement|overzicht|jaaropgave|afschrift|извлечение|справка|kontoauszug|jahresübersicht)\b/iu]],
  ["Decision", [/\b(?:decision|ruling|determination|beschikking|besluit|uitspraak|решение|разпореждане|bescheid|entscheidung)\b/iu]],
  ["Contract / Contract change", [/\b(?:contract|agreement|terms change|contractwijziging|overeenkomst|voorwaarden wijzigen|договор|промяна на условия|vertrag|vertragsänderung)\b/iu]],
  ["Cancellation", [/\b(?:cancellation|cancelled|termination|opzegging|geannuleerd|beëindiging|прекратяване|отказ|kündigung|stornierung)\b/iu]],
  ["Renewal", [/\b(?:renewal|renew|extension|verlenging|verlengen|подновяване|verlängerung|erneuerung)\b/iu]],
  ["Delivery notice", [/\b(?:delivery|shipment|parcel|tracking|bezorg|zending|pakket|доставка|пратка|sendung|zustellung|paket)\b/iu]],
  ["Security alert", [/\b(?:security alert|new sign-in|login alert|password reset|beveiligingswaarschuwing|nieuwe aanmelding|wachtwoord|сигурност|вход в акаунт|парола|sicherheitswarnung|anmeldung|passwort)\b/iu]],
  ["Reminder", [/\b(?:reminder|overdue|past due|herinnering|aanmaning|achterstallig|напомняне|просроч|erinnerung|mahnung|überfällig)\b/iu]],
  ["Notification", [/\b(?:notification|notice|update|kennisgeving|melding|bericht ter informatie|уведомление|известие|mitteilung|benachrichtigung)\b/iu]],
  ["Correspondence", [/\b(?:dear |hello |hi |geachte |beste |уважаем|здравей|sehr geehrte|hallo )/iu]]
];

export function classifyDocumentType({ text = "", commercial = false, action = {}, paymentDetected = false, replyExpected = false } = {}) {
  const source = norm(text);
  for (const [type, patterns] of DOC_RULES) {
    if (any(source, patterns)) return { type, confidence: 0.88, basis: [`document_pattern:${type}`] };
  }
  // A store newsletter marker does not turn an attached invoice or receipt into
  // marketing. Explicit document evidence therefore precedes the generic
  // commercial fallback.
  if (commercial) return { type: "Marketing message", confidence: 0.96, basis: ["commercial_message_signals"] };
  if (replyExpected || action.detected) return { type: "Correspondence", confidence: 0.68, basis: ["interactive_message_state"] };
  if (paymentDetected) return { type: "Invoice", confidence: 0.62, basis: ["financial_obligation_without_explicit_document_label"] };
  return { type: "Other", confidence: 0.4, basis: [] };
}

export function classifyRetention({ documentType = "Other", relationshipClass = "Unknown / Review", actionRequired = false, replyExpected = false, paymentRequired = false, deadline = null, risk = {} } = {}) {
  if (risk.hardBlock === true || risk.level === "High") {
    return { class: "Review manually", reason: "Security finding requires safe review before any retention decision.", advisory: true, autoDelete: false };
  }
  if (["Invoice","Receipt","Statement","Decision","Contract / Contract change","Cancellation"].includes(documentType)) {
    return { class: "Keep", reason: `${documentType} may be legal, financial, contractual, or evidentiary material.`, advisory: true, autoDelete: false };
  }
  if (documentType === "Renewal") {
    return { class: paymentRequired || deadline ? "Keep" : "Keep temporarily", reason: "Renewal may affect an active service or contract.", advisory: true, autoDelete: false };
  }
  if (documentType === "Security alert") return { class: "Keep temporarily", reason: "Security event has temporary audit relevance.", advisory: true, autoDelete: false };
  if (documentType === "Delivery notice") return { class: "Keep temporarily", reason: "Delivery evidence is useful until the transaction is complete.", advisory: true, autoDelete: false };
  if (documentType === "Reminder") return { class: actionRequired || paymentRequired || deadline ? "Keep temporarily" : "Reference only", reason: "Reminder is useful while the underlying obligation is active.", advisory: true, autoDelete: false };
  if (documentType === "Marketing message" || relationshipClass === "Marketing") return { class: "Disposable", reason: "Marketing-only message; deletion remains an explicit user action.", advisory: true, autoDelete: false };
  if (actionRequired || replyExpected || deadline) return { class: "Keep temporarily", reason: "Message supports an active action, reply, or deadline.", advisory: true, autoDelete: false };
  if (relationshipClass === "Government & Public Administration" || relationshipClass === "Pension & Social Security") return { class: "Reference only", reason: "Public-administration correspondence may have future reference value.", advisory: true, autoDelete: false };
  if (documentType === "Other" && relationshipClass === "Unknown / Review") return { class: "Review manually", reason: "Message type and relationship are not sufficiently clear for an automatic retention recommendation.", advisory: true, autoDelete: false };
  return { class: "Reference only", reason: "No active obligation detected; retain only if useful as reference.", advisory: true, autoDelete: false };
}

export function buildCivicMapReference({ relationship = {}, senderTrust = {} } = {}) {
  const publicClaim = relationship.claimedClass === "Government & Public Administration" || relationship.class === "Government & Public Administration";
  if (!publicClaim) return { eligible: false, status: "not_applicable", runtimeLookup: false, route: "CIVION Civic via authenticated CIVION Gateway" };
  const verified = relationship.class === "Government & Public Administration" && (senderTrust.verifiedIdentity || senderTrust.authenticatedOfficial);
  return {
    eligible: true,
    status: verified ? "reference_candidate" : "verification_required",
    runtimeLookup: false,
    route: "CIVION Civic via authenticated CIVION Gateway",
    claimedIdentity: senderTrust?.institutionIdentity?.label || null,
    identityId: senderTrust?.institutionIdentity?.id || null,
    observedDomain: senderTrust.domain || null,
    verifiedAtMailLayer: Boolean(verified),
    note: verified
      ? "CIVION Mail may submit this as a bounded reference candidate; CIVION Civic remains authoritative for canonical public-institution identity."
      : "Public-institution claim is not promoted to a verified relationship until mail-layer identity verification succeeds."
  };
}

export function analyzeSemanticAxes(input = {}) {
  const relationship = classifyRelationship(input);
  const document = classifyDocumentType(input);
  const retention = classifyRetention({
    documentType: document.type,
    relationshipClass: relationship.class,
    actionRequired: Boolean(input.action?.detected || input.action?.mandatory),
    replyExpected: Boolean(input.replyExpected),
    paymentRequired: Boolean(input.paymentDetected),
    deadline: input.deadline || null,
    risk: input.risk || {}
  });
  const civicMap = buildCivicMapReference({ relationship, senderTrust: input.senderTrust || {} });
  return { relationship, document, retention, civicMap };
}
