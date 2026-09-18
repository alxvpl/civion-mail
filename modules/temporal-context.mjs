// CIVION Mail 0.8 — Administrative Understanding, slice 1: date ≠ deadline.
//
// A calendar expression is not an obligation. Finding a parsable date proves only
// that a date was written; it says nothing about the administrative ROLE that date
// plays. This module decides that role from the CLAUSE the date stands in, so that
// "your appointment is on 5 March" and "pay by 5 March" can never collapse into the
// same operational finding.
//
// Trust boundary: this module classifies text only. It owns no state, performs no
// I/O, and never promotes a finding to accepted CIVION Core state.

export const TEMPORAL_ROLES = Object.freeze({
  DEADLINE: "deadline",
  CANCELLATION_WINDOW: "cancellation_window",
  APPOINTMENT: "appointment",
  DELIVERY: "delivery",
  RENEWAL: "renewal",
  INFORMATION: "information",
  NONE: "none"
});

// Only these roles may produce deadline candidates. Appointment, delivery,
// renewal-effective and informational dates are administrative facts, not
// temporal constraints on an action.
export const OPERATIONAL_ROLES = Object.freeze([
  TEMPORAL_ROLES.DEADLINE,
  TEMPORAL_ROLES.CANCELLATION_WINDOW
]);

// Typed administrative finding vocabulary for this increment. Future types are
// deliberately NOT declared here: an undeclared type is a defect, not a feature.
export const FINDING_TYPES = Object.freeze([
  "deadline",
  "payment",
  "appointment",
  "delivery",
  "information",
  "renewal",
  "cancellation_window"
]);

export const TEMPORAL_ROLE_LABELS = Object.freeze({
  deadline: "due_by",
  cancellation_window: "cancellation_deadline",
  appointment: "appointment_date",
  delivery: "delivery_date",
  renewal: "renewal_effective_date",
  information: "effective_or_informational_date"
});

// --- Cue families -----------------------------------------------------------
// English, Dutch, Bulgarian and German, matching the existing multilingual
// pattern-family design in analyzer.mjs. These identify what a date IS ABOUT;
// they never assert that an action is owed.

export const APPOINTMENT_CUES = [
  // Cue tokens are anchored to their noun phrase. A bare verb ("please consult
  // the terms", "check up on the invoice") is an instruction, not an appointment,
  // and must not be able to type a date as one.
  /\b(?:appointment|appointments|is scheduled|are scheduled|scheduled (?:for|on|at)|consultation (?:is|on|at)|your consultation|(?:your |the )check-?up|check-?up is|hearing (?:is|will be) (?:on|held)|we expect you|your visit (?:is )?on|meeting (?:is|will be) (?:on|held))\b/iu,
  /\b(?:afspraak|afspraken|is gepland|staat gepland|gepland (?:op|voor)|ingepland|consultatie|(?:uw|het) consult\b|spreekuur|zitting|wij verwachten u|uw bezoek is op)\b/iu,
  /(?:вашият час|часът ви|час за преглед|прегледът (?:е|ще бъде) (?:на|насрочен)|насрочен(?:а|о|и)? за|насрочена среща|срещата (?:е|ще бъде) на|заседанието (?:е|ще бъде) на|очакваме ви на)/iu,
  /\b(?:termin|ihr termin|terminvereinbarung|ist (?:für|am) .{0,24}(?:vereinbart|geplant)|sprechstunde|anh[öo]rung findet|wir erwarten sie)\b/iu
];

export const DELIVERY_CUES = [
  /\b(?:delivery|delivered|will be delivered|delivery expected|expected delivery|will arrive|arrives on|arrival|shipment|shipped|dispatch(?:ed)?|your (?:parcel|package|order) will)\b/iu,
  /\b(?:bezorgd|wordt bezorgd|bezorging|geleverd|wordt geleverd|levering|verzonden|zending|aankomst|uw (?:pakket|bestelling) wordt)\b/iu,
  /(?:доставка(?:та)?|ще бъде доставен(?:а|о|и)?|доставено на|пратката (?:ще|е)|изпратен(?:а|о|и)? на|пристига на)/iu,
  /\b(?:lieferung|geliefert|wird geliefert|zustellung|sendung|versandt|ankunft|ihr paket wird)\b/iu
];

// Renewal that TAKES EFFECT on a date. Deliberately excludes cancellation
// language: "cancel before 1 April to prevent renewal" is a cancellation
// window, not a renewal-effective date.
export const RENEWAL_CUES = [
  /\b(?:renews|will renew|is renewed|auto[- ]?renews?|automatically renews?|renewal date|renewal takes effect|due for renewal|next billing date|will be extended)\b/iu,
  /\b(?:wordt verlengd|verlengt automatisch|automatisch verlengd|verlengingsdatum|verlenging vindt plaats|volgende factuurdatum)\b/iu,
  /(?:се подновява|ще бъде подновен(?:а|о|и)?|автоматично подновяване|дата на подновяване|подновяването (?:е|ще бъде) на|следваща дата на фактуриране)/iu,
  /\b(?:verl[äa]ngert sich|wird verl[äa]ngert|automatisch verl[äa]ngert|verl[äa]ngerungsdatum|n[äa]chstes abrechnungsdatum)\b/iu
];

// Availability, validity and effective dates: meaningful temporal facts that
// impose no action.
export const INFORMATION_CUES = [
  /\b(?:available (?:from|on|as of)|becomes available|valid (?:from|until|through|to)|validity|effective (?:from|as of|on)|effective date|in effect (?:from|until)|applies from|takes effect|starts on|begins on|opens on|closed until|open until|published on|as of)\b/iu,
  /\b(?:beschikbaar (?:vanaf|op)|geldig (?:vanaf|tot)|geldigheid|ingangsdatum|gaat in (?:op|per)|van kracht (?:vanaf|tot)|start op|begint op|gesloten tot|geopend tot|gepubliceerd op)\b/iu,
  /(?:достъпн(?:а|о|и)? (?:от|на)|наличн(?:а|о|и)? от|валидн(?:а|о|и)? (?:от|до)|валидността (?:е )?до|в сила (?:от|до)|влиза в сила|започва на|затворено до|отворено до|публикуван(?:а|о)? на)/iu,
  /\b(?:verf[üu]gbar (?:ab|am)|g[üu]ltig (?:ab|bis)|g[üu]ltigkeit|gilt (?:ab|bis)|in kraft (?:ab|bis)|tritt .{0,24}in kraft|beginnt am|geschlossen bis|ver[öo]ffentlicht am)\b/iu
];

// Ending a contract, subscription or order. Combined with an end-date marker
// this is a cancellation WINDOW: the last date on which a right may be
// exercised, not a duty.
export const CANCELLATION_CUES = [
  /\b(?:cancel|cancels|cancelling|canceling|cancellation|terminate|termination|opt out|end (?:your|the) (?:subscription|contract|membership)|withdraw from (?:the )?(?:contract|agreement))\b/iu,
  /\b(?:opzeggen|opzegging|annuleren|annulering|be[eë]indigen|be[eë]indiging|herroepen|herroeping|ontbinden|ontbinding)\b/iu,
  /(?:да откажете|отказ от|отказване от|прекрат(?:яване|ите|и се)|анулира(?:не|те)|разваляне на договора|да прекратите)/iu,
  /\b(?:k[üu]ndigen|k[üu]ndigung|stornieren|stornierung|widerrufen|widerruf|vertrag beenden)\b/iu
];

// Explicitly DUE money. Document nouns ("invoice", "factuur", "Rechnung") are
// deliberately excluded: an invoice can be valid until a date without a payment
// being due on it.
export const PAYMENT_DUE_CUES = [
  /\b(?:payable|amount due|payment due|balance due|past due|outstanding balance|must be paid|to be paid by)\b/iu,
  /\b(?:te betalen|verschuldigd|openstaand bedrag|betaaldatum|dient (?:te worden )?betaald|moet.{0,30}betaald (?:zijn|worden))\b/iu,
  /(?:дължим[аои] сума|срок за плащане|подлежи на плащане|следва да бъде платен[оа]?|неплатен[оа] сума)/iu,
  /\b(?:zahlbar|f[äa]lliger betrag|offener betrag|zu zahlender betrag|muss.{0,30}gezahlt (?:sein|werden))\b/iu
];

// "X must be received / submitted by ..." — a mandatory constraint that does not
// use the second-person "you must" construction the action rules key on.
export const MANDATORY_RECEIPT_CUES = [
  /\b(?:must be (?:received|submitted|returned|paid|completed|signed|filed)|has to be (?:received|submitted|returned)|is due)\b/iu,
  /\b(?:moet.{0,48}(?:zijn ontvangen|zijn ingediend|worden ingediend|worden aangeleverd|worden opgestuurd|worden betaald|worden geretourneerd)|dient.{0,48}(?:te zijn ontvangen|te worden ingediend))\b/iu,
  /(?:трябва да (?:бъде|е) (?:получен[оа]?|подаден[оа]?|изпратен[оа]?|платен[оа]?|върнат[оа]?)|следва да бъде получен[оа]?)/iu,
  /\b(?:muss.{0,48}(?:eingegangen|eingereicht|zur[üu]ckgesandt|bezahlt) (?:sein|werden))\b/iu
];

const CUE_ORDER = [
  [TEMPORAL_ROLES.APPOINTMENT, APPOINTMENT_CUES],
  [TEMPORAL_ROLES.DELIVERY, DELIVERY_CUES],
  [TEMPORAL_ROLES.RENEWAL, RENEWAL_CUES],
  [TEMPORAL_ROLES.INFORMATION, INFORMATION_CUES]
];

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = String(text || "").match(pattern);
    if (match) return match[0].trim();
  }
  return "";
}

function anyCue(text, patterns) {
  return patterns.some((pattern) => pattern.test(String(text || "")));
}

// The first non-deadline role cue present in `text`, in fixed precedence order.
export function findRoleCue(text) {
  for (const [role, patterns] of CUE_ORDER) {
    const evidence = firstMatch(text, patterns);
    if (evidence) return { role, evidence };
  }
  return { role: TEMPORAL_ROLES.NONE, evidence: "" };
}

/**
 * Decide the administrative role of one date expression.
 *
 * Deadline semantics must be proven in the clause around the date itself. A
 * mandatory action elsewhere in the message — or in a neighbouring clause that
 * already carries its own non-deadline cue — must never promote a date.
 *
 * @param {object} input
 * @param {{marker: string, label: string, gap: number, score: number, strength: number}|null} input.marker
 *        Strongest due-by marker immediately preceding the date, or null.
 * @param {string} input.clause    Clause-local window around the date.
 * @param {string} input.sentence  Sentence-local window around the date.
 * @param {(text: string) => boolean} input.isMandatory
 * @param {(text: string) => boolean} input.isOptional
 * @param {boolean} [input.ambiguous] The calendar value itself is ambiguous.
 * @returns {{role: string, temporalRole: string|null, evidence: string,
 *            evidenceKind: string, strength: number, actionRequired: boolean,
 *            needsVerification: boolean}}
 */
export function resolveTemporalRole({
  marker = null,
  clause = "",
  sentence = "",
  isMandatory = () => false,
  isOptional = () => false,
  ambiguous = false
} = {}) {
  const clauseText = String(clause || "");
  const sentenceText = String(sentence || clauseText);

  const clauseCue = findRoleCue(clauseText);
  const sentenceCue = clauseCue.role === TEMPORAL_ROLES.NONE ? findRoleCue(sentenceText) : clauseCue;

  // Modality is read clause-locally. Widening to the whole sentence is allowed
  // ONLY when the sentence carries no competing non-deadline cue; otherwise
  // "your invoice is valid until 31 December, please pay the balance" would turn
  // a validity date into a deadline.
  const mayWiden = sentenceCue.role === TEMPORAL_ROLES.NONE;
  const inScope = (predicate) =>
    Boolean(predicate(clauseText)) || (mayWiden && Boolean(predicate(sentenceText)));

  const cancel = inScope((text) => anyCue(text, CANCELLATION_CUES));
  const mandatory = inScope(isMandatory);
  const optional = inScope(isOptional);

  const markerStrength = marker ? Number(marker.strength || marker.score || 0) : 0;
  const markerScore = marker ? Number(marker.score || 0) : 0;

  const build = (role, evidence, evidenceKind, strength, actionRequired, needsVerification = false) => ({
    role,
    temporalRole: TEMPORAL_ROLE_LABELS[role] || null,
    evidence: String(evidence || "").trim(),
    evidenceKind,
    strength: Number(Math.min(1, Math.max(0, strength)).toFixed(2)),
    actionRequired: Boolean(actionRequired),
    needsVerification: Boolean(needsVerification || ambiguous)
  });

  if (marker) {
    // 2. Optional cancellation language + an end-date marker is a window for
    //    exercising a right, never a duty. A mandatory cancellation instruction
    //    ("you must submit the cancellation request by ...") stays a deadline.
    if (cancel) {
      const cancellationEvidence = firstMatch(clauseText, CANCELLATION_CUES)
        || firstMatch(sentenceText, CANCELLATION_CUES)
        || marker.marker;
      return mandatory && !optional
        ? build(TEMPORAL_ROLES.DEADLINE, `${marker.marker} · ${cancellationEvidence}`, "mandatory_cancellation", markerScore, true)
        : build(TEMPORAL_ROLES.CANCELLATION_WINDOW, `${marker.marker} · ${cancellationEvidence}`, "cancellation_window", markerScore, false);
    }
    // 1. Explicit due-by marker, or a marker plus mandatory action/payment.
    if (markerStrength >= 0.98) {
      return build(TEMPORAL_ROLES.DEADLINE, marker.marker, "explicit_deadline_marker", markerScore, true);
    }
    if (mandatory && !optional) {
      return build(TEMPORAL_ROLES.DEADLINE, marker.marker, "action_with_deadline_marker", markerScore, true);
    }
  }

  // 3-6. Non-deadline administrative roles, clause first, then sentence.
  if (clauseCue.role !== TEMPORAL_ROLES.NONE) {
    return build(clauseCue.role, clauseCue.evidence, "clause_cue", 0.9, false);
  }
  if (sentenceCue.role !== TEMPORAL_ROLES.NONE) {
    return build(sentenceCue.role, sentenceCue.evidence, "sentence_cue", 0.72, false, true);
  }

  if (marker) {
    // An entitlement ("you may object before ...") keeps its legal temporal
    // boundary, but the act stays optional.
    if (optional) {
      return build(TEMPORAL_ROLES.DEADLINE, marker.marker, "entitlement_with_deadline_marker", markerScore, false);
    }
    // A strong dedicated deadline preposition (vóór / до / bis zum) still carries
    // the constraint on its own; the weak ones (by / before / until / voor / tot)
    // do not, and are left unpromoted.
    if (markerStrength >= 0.86) {
      return build(TEMPORAL_ROLES.DEADLINE, marker.marker, "deadline_preposition", markerScore, true, true);
    }
  }

  // 7. Bare or incidental date: not promoted to an operational finding.
  return build(TEMPORAL_ROLES.NONE, "", "no_semantic_evidence", 0, false, false);
}
