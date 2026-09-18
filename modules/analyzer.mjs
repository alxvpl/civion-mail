import { OBSERVED_SERVICE_DOMAIN_ALLOWLIST, PROTECTED_IDENTITIES } from "./protected-identities.mjs";
import { evaluateMailAuthentication, listAuthservIds as listAuthservIdsFromAuth } from "./authentication.mjs";
import { analyzeSemanticAxes } from "./semantic-model.mjs";
import {
  TEMPORAL_ROLES,
  OPERATIONAL_ROLES,
  TEMPORAL_ROLE_LABELS,
  PAYMENT_DUE_CUES,
  MANDATORY_RECEIPT_CUES,
  resolveTemporalRole
} from "./temporal-context.mjs";

const CATEGORY_ORDER = [
  "Action Required",
  "Deadline",
  "Payment",
  "Official",
  "Reply Expected",
  "Information Only",
  "Commercial",
  "Suspicious",
  "Personal",
  "Unknown"
];

const PRIORITIES = ["Critical", "High", "Medium", "Low", "No Action"];

// Historical Scan must preserve old obligations as evidence without turning
// them into present-day urgency.  A source older than 120 days whose extracted
// deadline expired more than 30 days ago is therefore historical, not current.
const HISTORICAL_SOURCE_AGE_DAYS = 120;
const HISTORICAL_DEADLINE_AGE_DAYS = 30;

// Classification runs action, payment and consequence detection per date
// expression. A pathological body — a statement listing hundreds of dates — must
// not turn that into unbounded work inside the extension process.
const MAX_DATE_EXPRESSIONS = 80;

const ACTION_RULES = [
  {
    pattern: /\b(?:you must|you need to|you are required to)\b(?=.{0,140}\b(?:submit|send|provide|complete|confirm|sign|pay|upload|register|contact|respond|reply|review|approve|renew|schedule|book|return|update)\b)/iu,
    strength: 0.96,
    mandatory: true
  },
  {
    pattern: /\b(?:u moet|je moet|u dient(?: te)?|je dient(?: te)?|u bent verplicht(?: te)?)\b(?=.{0,140}\b(?:bezwaar (?:te )?maken|retourneren|terugbetalen|doorgeven|beroep (?:in te stellen|instellen)|klacht (?:in te dienen|indienen)|bezwaar (?:in te dienen|indienen)|aanleveren|indienen|opsturen|bevestigen|ondertekenen|betalen|uploaden|registreren|contact opnemen|reageren|antwoorden|controleren|goedkeuren|verlengen|afspraak maken|terugsturen|bijwerken)\b)/iu,
    strength: 0.96,
    mandatory: true
  },
  {
    pattern: /\b(?:bezwaarschrift|aanvraag|formulier|document|reactie|betaling)\b.{0,100}\b(?:moet|dient)\b.{0,100}\b(?:zijn ontvangen|zijn ingediend|worden ingediend|worden aangeleverd|worden opgestuurd|worden betaald)\b/iu,
    strength: 0.96,
    mandatory: true
  },
  {
    pattern: /(?<![\p{L}\p{N}_])(?:трябва да|необходимо е да|длъжни сте да|задължени сте да|трябва)(?![\p{L}\p{N}_])(?=.{0,140}(?<![\p{L}\p{N}_])(?:изпратите|предоставите|попълните|потвърдите|подпишете|платите|качите|регистрирате|свържете|отговорите|реагирате|прегледате|одобрите|подновите|запазите|върнете|актуализирате)(?![\p{L}\p{N}_]))/iu,
    strength: 0.96,
    mandatory: true
  },
  {
    pattern: /\b(?:sie müssen|du musst|sie sind verpflichtet)\b(?=.{0,140}\b(?:einreichen|senden|bereitstellen|ausfüllen|bestätigen|unterschreiben|bezahlen|hochladen|registrieren|antworten|prüfen|genehmigen|verlängern|zurücksenden|aktualisieren)\b)/iu,
    strength: 0.96,
    mandatory: true
  },
  {
    pattern: /\b(?:you must|you need to|you are required to|required action\s*:?)\s+(?:submit|send|provide|complete|confirm|sign|pay|upload|register|contact|respond|reply|review|approve|renew|schedule|book|return|update)\b/iu,
    strength: 0.98,
    mandatory: true
  },
  {
    pattern: /\b(?:please|kindly)\s+(?:submit|send|provide|complete|confirm|sign|pay|upload|register|contact|respond|reply|review|approve|renew|schedule|book|return|update)\b/iu,
    strength: 0.88,
    mandatory: false
  },
  {
    pattern: /^(?:submit|send|provide|complete|confirm|sign|pay|upload|register|contact|respond|reply|review|approve|renew|schedule|book|return|update)\b/iu,
    strength: 0.84,
    mandatory: false
  },
  {
    pattern: /\b(?:u moet|je moet|u dient te|je dient te|u bent verplicht te)\s+(?:bezwaar (?:te )?maken|retourneren|terugbetalen|doorgeven|beroep (?:in te stellen|instellen)|klacht (?:in te dienen|indienen)|bezwaar (?:in te dienen|indienen)|aanleveren|indienen|opsturen|bevestigen|ondertekenen|betalen|uploaden|registreren|contact opnemen|reageren|antwoorden|controleren|goedkeuren|verlengen|een afspraak maken|terugsturen|bijwerken)\b/iu,
    strength: 0.98,
    mandatory: true
  },
  {
    pattern: /\bgraag\s+(?:aanleveren|indienen|opsturen|bevestigen|ondertekenen|betalen|uploaden|registreren|contact opnemen|reageren|antwoorden|controleren|goedkeuren|verlengen|terugsturen|bijwerken)\b/iu,
    strength: 0.88,
    mandatory: false
  },
  {
    pattern: /(?<![\p{L}\p{N}_])(?:трябва да|необходимо е да|длъжни сте да|задължени сте да)\s+(?:изпратите|предоставите|попълните|потвърдите|подпишете|платите|качите|регистрирате|се свържете|отговорите|прегледате|одобрите|подновите|запазите|върнете|актуализирате)(?![\p{L}\p{N}_])/iu,
    strength: 0.98,
    mandatory: true
  },
  {
    pattern: /моля[, ]+(?:изпратете|предоставете|попълнете|потвърдете|подпишете|платете|качете|регистрирайте|свържете се|отговорете|прегледайте|одобрете|подновете|запазете|върнете|актуализирайте)(?![\p{L}\p{N}_])/iu,
    strength: 0.88,
    mandatory: false
  },
  {
    pattern: /\b(?:sie müssen|du musst|sie sind verpflichtet)\s+(?:einreichen|senden|bereitstellen|ausfüllen|bestätigen|unterschreiben|bezahlen|hochladen|registrieren|antworten|prüfen|genehmigen|verlängern|zurücksenden|aktualisieren)\b/iu,
    strength: 0.98,
    mandatory: true
  },
  {
    pattern: /\bbitte\s+(?:einreichen|senden|bereitstellen|ausfüllen|bestätigen|unterschreiben|bezahlen|hochladen|registrieren|antworten|prüfen|genehmigen|verlängern|zurücksenden|aktualisieren)\b/iu,
    strength: 0.88,
    mandatory: false
  }
];


const NON_ACTION_HEADING_PATTERNS = [
  /^(?:upload|submission|payment|reply|response|renewal|registration)\s+(?:requirements|instructions|information|guide|policy|limits|details)\b/iu,
  /^(?:vereisten|instructies|informatie|richtlijnen)\b/iu,
  /^(?:изисквания|инструкции|информация|правила)(?![\p{L}\p{N}_])/iu,
  /^(?:anforderungen|anweisungen|informationen|richtlinien)\b/iu
];

const OPTIONAL_ACTION_PATTERNS = [
  /^(?:if you (?:want|wish|would like)|if desired|you may|you can)\b/iu,
  /^(?:als u wilt|als je wilt|indien gewenst|u kunt|je kunt|mocht u)\b/iu,
  /^(?:ако желаете|ако искате|можете да)\b/iu,
  /^(?:wenn sie möchten|falls gewünscht|sie können)\b/iu
];

const ACTION_NEGATION_PATTERNS = [
  /\b(?:no action required|you do not need to|you don't need to|not required to)\b/iu,
  /\b(?:geen actie vereist|u hoeft niet|je hoeft niet|niet verplicht)\b/iu,
  /(?:не се изисква действие|не е необходимо да|не трябва да|няма нужда да)/iu,
  /\b(?:keine handlung erforderlich|sie müssen nicht|du musst nicht|nicht erforderlich)\b/iu
];

const CONSEQUENCE_PATTERNS = [
  /\b(?:failure to|if you do not|legal obligation|mandatory|obligatory)\b/iu,
  /\b(?:bij gebreke|indien u niet|wettelijk verplicht)\b/iu,
  /(?:при неизпълнение|ако не|законово задължение|задължително)/iu,
  /\b(?:bei nichtbeachtung|wenn sie nicht|gesetzlich verpflichtet|zwingend)\b/iu
];

const DEADLINE_MARKERS = [
  { pattern: /\b(?:deadline|due date|due by|no later than)\b/iu, strength: 0.98, label: "explicit deadline marker" },
  { pattern: /\b(?:by|before|until)\b/iu, strength: 0.84, label: "deadline preposition" },
  { pattern: /\b(?:deadline|uiterlijk|vervaldatum|betaaldatum)\b/iu, strength: 0.98, label: "expliciete termijnmarkering" },
  { pattern: /\bvóór\b/iu, strength: 0.86, label: "expliciet termijnvoorzetsel" },
  { pattern: /\bvoor\b/iu, strength: 0.70, label: "zwak termijnvoorzetsel" },
  { pattern: /\btot\b/iu, strength: 0.84, label: "termijnvoorzetsel" },
  // v0.8.0: the definite forms ("Крайният срок …") are the normal Bulgarian
  // administrative phrasing and were not covered by the indefinite form alone.
  { pattern: /(?:край(?:ен|ният|ния) срок|не по-късно от|последен ден|последна дата)/iu, strength: 0.98, label: "изричен маркер за срок" },
  { pattern: /(?:^|\s)до\s*$/iu, strength: 0.86, label: "предлог за срок" },
  { pattern: /\b(?:frist|fälligkeit|spätestens|fällig)\b/iu, strength: 0.98, label: "explizite fristmarkierung" },
  { pattern: /\b(?:bis zum|bis)\b/iu, strength: 0.86, label: "fristpräposition" }
];

const PAYMENT_PATTERNS = [
  /\b(invoice|payment|payable|amount due|outstanding balance|refund|charge|direct debit|bank transfer|price change|fee|premium)\b/iu,
  /\b(factuur|betaling|te betalen|openstaand bedrag|terugbetaling|incasso|overschrijving|prijswijziging|kosten|premie)\b/iu,
  /(фактура|плащане|дължима сума|неплатено|възстановяване|такса|банков превод|директен дебит|промяна на цена|премия)/iu,
  /\b(rechnung|zahlung|zahlbar|offener betrag|erstattung|lastschrift|überweisung|preisänderung|gebühr|beitrag)\b/iu
];

const PAYMENT_ACTION_PATTERNS = [
  /\b(?:pay|make (?:a )?payment|transfer)\b/iu,
  // v0.8.0: the Dutch imperative ("Betaal uiterlijk ...") is the normal form in
  // administrative payment requests and was not covered by the infinitive alone.
  /\b(?:betaal|betaalt|betalen|maak (?:de )?betaling over|overmaken)\b/iu,
  /(?:платете|извършете плащане|преведете сумата)/iu,
  /\b(?:bezahlen|zahlen sie|zahlung leisten|überweisen)\b/iu
];

const REPLY_PATTERNS = [
  /\b(please reply|please respond|let me know|awaiting your reply|could you|can you|would you|confirm receipt)\b/iu,
  /\b(graag antwoorden|graag reageren|laat het weten|ik hoor graag|kunt u|kun je|bevestig ontvangst)\b/iu,
  /(моля[, ]+отговорете|очаквам отговор|уведомете ме|можете ли|бихте ли|потвърдете получаването)/iu,
  /\b(bitte antworten|bitte rückmelden|lassen sie mich wissen|können sie|kannst du|empfang bestätigen)\b/iu
];

const COMMERCIAL_PATTERNS = [
  /\b(unsubscribe|newsletter|special offer|limited offer|sale|discount|promotion|shop now|marketing preferences)\b/iu,
  /\b(afmelden|nieuwsbrief|aanbieding|korting|promotie|bestel nu|marketingvoorkeuren)\b/iu,
  /(отписване|бюлетин|специална оферта|отстъпка|промоция|купи сега|маркетингови предпочитания)/iu,
  /\b(abbestellen|newsletter|sonderangebot|rabatt|aktion|jetzt kaufen|marketingeinstellungen)\b/iu
];

// v0.1.17 real-corpus controls: marketing CTAs, optional help text and product
// pricing must not be promoted to operational obligations merely because they
// contain an imperative verb, a question, or a currency amount.
const MARKETING_CTA_PATTERNS = [
  /\b(?:buy now|shop now|register now|complete your purchase|send your first prompt|learn more|claim (?:your )?(?:offer|discount)|contact (?:our )?sales|update (?:your )?(?:email|marketing) preferences)\b/iu,
  /^(?:contact|register|buy|shop|subscribe)\b/iu,
  /\b(?:bestel nu|koop nu|registreer nu|voltooi (?:je|uw) aankoop|meer informatie|neem contact op met sales|marketingvoorkeuren bijwerken)\b/iu,
  /(?:купи сега|регистрирай се сега|завърши покупката|научи повече|свържи се с продажби)/iu,
  /\b(?:jetzt kaufen|jetzt registrieren|kauf abschließen|mehr erfahren|vertrieb kontaktieren)\b/iu
];

const ACCOUNT_LIFECYCLE_PATTERNS = [
  /\b(?:account|licen[cs]e|subscription|membership|plan)\b.{0,120}\b(?:expire|expires|expiring|expiration|renew|renewal|deleted|deletion|suspend|suspended|closure|close)\b/iu,
  /\b(?:account|licentie|abonnement|lidmaatschap)\b.{0,120}\b(?:verloopt|vervallen|verlengen|verlenging|verwijderd|opschorting|geschorst|sluiting)\b/iu,
  /(?:акаунт|лиценз|абонамент).{0,120}(?:изтича|поднов|изтрит|закрит|спрян)/iu,
  /\b(?:konto|lizenz|abonnement|mitgliedschaft)\b.{0,120}\b(?:abläuft|verlängern|verlängerung|gelöscht|gesperrt|schließung)\b/iu
];

const STRONG_REPLY_PATTERNS = [
  /\b(?:please reply|please respond|reply to this (?:email|message)|respond to this (?:email|message)|let me know|awaiting your reply|confirm receipt)\b/iu,
  /\b(?:graag antwoorden|graag reageren|antwoord op (?:deze )?(?:e-mail|mail|bericht)|reageer op (?:deze )?(?:e-mail|mail|bericht)|laat het weten|ik hoor graag|bevestig ontvangst)\b/iu,
  /(?:моля[, ]+отговорете|отговорете на (?:този )?(?:имейл|съобщение)|очаквам отговор|уведомете ме|потвърдете получаването)/iu,
  /\b(?:bitte antworten|bitte rückmelden|antworten sie auf (?:diese )?(?:e-mail|nachricht)|lassen sie mich wissen|empfang bestätigen)\b/iu
];

const QUESTION_REPLY_PATTERNS = [
  /\b(?:could you|can you|would you)\b/iu,
  /\b(?:kunt u|kun je)\b/iu,
  /(?:можете ли|бихте ли)/iu,
  /\b(?:können sie|kannst du|würden sie)\b/iu
];

const OPTIONAL_HELP_PATTERNS = [
  /\b(?:if you have (?:any )?questions|for questions|contact support|contact us for help)\b/iu,
  /\b(?:als u (?:nog )?vragen heeft|mocht u (?:nog )?vragen hebben|voor vragen|neem contact op met (?:onze )?support)\b/iu,
  /(?:ако имате въпроси|при въпроси|свържете се с поддръжката)/iu,
  /\b(?:wenn sie fragen haben|bei fragen|support kontaktieren)\b/iu
];

const PAYMENT_OBLIGATION_PATTERNS = [
  /\b(?:amount due|payment due|outstanding balance|invoice(?: total)?|payable|past due|statement and pay|direct debit)\b/iu,
  /\b(?:te betalen|openstaand bedrag|factuur(?:bedrag)?|betaaldatum|achterstand|incasso|rekeningoverzicht.*betalen)\b/iu,
  /(?:дължима сума|неплатено|фактура|срок за плащане|директен дебит)/iu,
  /\b(?:zahlbar|offener betrag|rechnung(?:sbetrag)?|fällig|lastschrift)\b/iu
];

const COMPLETED_PAYMENT_PATTERNS = [
  /\b(?:receipt|order receipt|payment receipt|payment (?:was )?(?:received|completed)|you(?:'ve| have) paid|paid to|charged to|transaction completed)\b/iu,
  /\b(?:betaalbewijs|betalingsbewijs|betaling ontvangen|betaling voltooid|u heeft betaald|afgeschreven)\b/iu,
  /(?:разписка|плащането е получено|плащането е извършено|платили сте)/iu,
  /\b(?:beleg|zahlungsbeleg|zahlung erhalten|zahlung abgeschlossen|sie haben bezahlt|abgebucht)\b/iu
];

const PRICE_CHANGE_PATTERNS = [
  /\b(?:price change|price increase|new (?:monthly|annual) price|new rate|fee change)\b/iu,
  /\b(?:prijswijziging|prijsverhoging|nieuw (?:maand|jaar)tarief|nieuw tarief|wijziging van (?:de )?kosten)\b/iu,
  /(?:промяна на цената|увеличение на цената|нова месечна цена|нова тарифа)/iu,
  /\b(?:preisänderung|preiserhöhung|neuer (?:monats|jahres)preis|neuer tarif|gebührenänderung)\b/iu
];

const CREDENTIAL_PATTERNS = [
  /\b(verify (?:your )?account|confirm (?:your )?password|reset (?:your )?password|login immediately|sign in now|security alert|suspended account|unlock account|provide your code|one[- ]time code)\b/iu,
  /\b(account verifiëren|wachtwoord bevestigen|wachtwoord opnieuw instellen|direct inloggen|beveiligingswaarschuwing|account geblokkeerd|account ontgrendelen|deel uw code)\b/iu,
  /\b(?:bevestig|verifieer|controleer|actualiseer)\s+(?:(?:uw|je|jouw|het|de)\s+)?(?:account|wachtwoord|beveiligingscode|gegevens|inloggegevens|identiteit)\b/iu,
  // Dutch subordinate word order: "om uw gegevens te controleren".
  /\b(?:uw|je|jouw)\s+(?:gegevens|inloggegevens|identiteit|account|wachtwoord)\s+(?:te\s+)?(?:controleren|bevestigen|verifi[ëe]ren|actualiseren|bij\s?werken)\b/iu,
  /\b(?:verify|confirm|update)\s+your\s+(?:identity|details|information|personal\s+(?:details|information))\b/iu,
  /(потвърдете акаунта|потвърдете паролата|нулирайте паролата|влезте незабавно|предупреждение за сигурност|блокиран акаунт|отключете акаунта|изпратете кода)/iu,
  /\b(konto bestätigen|passwort bestätigen|passwort zurücksetzen|sofort anmelden|sicherheitswarnung|konto gesperrt|konto entsperren|code mitteilen)\b/iu
];

const HIGH_PRESSURE_PATTERNS = [
  /\b(immediately|urgent|act now|within hours|final warning|do not tell|confidential transaction|gift card|cryptocurrency|bitcoin|wire money)\b/iu,
  /\b(onmiddellijk|dringend|handel nu|binnen enkele uren|laatste waarschuwing|vertel niemand|cadeaukaart|cryptovaluta|bitcoin|geld overmaken)\b/iu,
  /(незабавно|спешно|действайте сега|до няколко часа|последно предупреждение|не казвайте на никого|карта за подарък|криптовалута|биткойн|преведете пари)/iu,
  /\b(sofort|dringend|jetzt handeln|innerhalb weniger stunden|letzte warnung|niemandem sagen|geschenkkarte|kryptowährung|bitcoin|geld überweisen)\b/iu
];

const OFFICIAL_DOMAINS = [
  "government.nl", "rijksoverheid.nl", "overheid.nl", "belastingdienst.nl", "toeslagen.nl",
  "uwv.nl", "svb.nl", "duo.nl", "ind.nl", "cjib.nl", "rdw.nl", "digid.nl", "politie.nl",
  "rechtspraak.nl", "om.nl", "kvk.nl", "acm.nl", "dnb.nl", "afm.nl", "zorginstituutnederland.nl",
  "europa.eu", "ec.europa.eu", "gov.uk", "bund.de"
];

const OFFICIAL_CLAIM_PATTERNS = [
  /\b(municipality|municipal|tax authority|government|ministry|court|benefit decision|official notice|case number)\b/iu,
  /\b(digid|mijnoverheid)\b/iu,
  /\b(gemeente|belastingdienst|rijksoverheid|ministerie|rechtbank|beschikking|officiële mededeling|zaaknummer|kenmerk)\b/iu,
  /(община|данъчна администрация|правителство|министерство|съд|решение|официално уведомление|номер на преписка)/iu,
  /\b(gemeinde|finanzamt|regierung|ministerium|gericht|bescheid|amtliche mitteilung|aktenzeichen)\b/iu
];

const FREE_MAIL_DOMAINS = new Set([
  "gmail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "icloud.com",
  "proton.me", "protonmail.com", "gmx.com", "gmx.de", "mail.com", "aol.com"
]);

const MONTH_LOCALES = ["en-US", "nl-NL", "bg-BG", "de-DE"];

const MONTH_FALLBACK_ALIASES = new Map([
  [1, ["ян", "яну"]], [2, ["фев"]], [3, ["мар", "maerz"]], [4, ["апр"]],
  [5, ["май"]], [6, ["юни"]], [7, ["юли"]], [8, ["авг"]],
  [9, ["сеп", "sept"]], [10, ["окт"]], [11, ["ное"]], [12, ["дек"]]
]);

function normalizeMonthToken(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[.]+$/gu, "")
    .trim();
}

function buildMonthMap() {
  const map = new Map();
  const add = (token, month) => {
    const normalized = normalizeMonthToken(token);
    if (/\p{L}/u.test(normalized)) map.set(normalized, month);
  };

  for (const locale of MONTH_LOCALES) {
    for (let month = 1; month <= 12; month += 1) {
      const date = new Date(Date.UTC(2026, month - 1, 1));
      for (const width of ["long", "short"]) {
        add(new Intl.DateTimeFormat(locale, { month: width, timeZone: "UTC" }).format(date), month);
      }
    }
  }

  for (const [month, aliases] of MONTH_FALLBACK_ALIASES) {
    for (const alias of aliases) add(alias, month);
  }
  return map;
}

const MONTHS = buildMonthMap();

function normalizeText(value) {
  return String(value || "").normalize("NFKC").replace(/\u0000/gu, "").trim();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function anyMatch(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function parseEmailAddress(author) {
  const value = normalizeText(author);
  const bracket = value.match(/<([^<>\s]+@[^<>\s]+)>/u);
  const plain = value.match(/\b([^\s<>]+@[^\s<>]+)\b/u);
  return (bracket?.[1] || plain?.[1] || "").replace(/[>,;]+$/u, "").toLowerCase();
}

function parseDisplayName(author) {
  const value = normalizeText(author);
  const bracketIndex = value.lastIndexOf("<");
  return bracketIndex > 0 ? value.slice(0, bracketIndex).replace(/^['"]|['"]$/gu, "").trim() : "";
}

function getDomain(author) {
  const email = parseEmailAddress(author);
  return email.includes("@") ? email.split("@").pop() : "";
}

function domainMatches(domain, expected) {
  return domain === expected || domain.endsWith(`.${expected}`);
}

const OFFICIAL_MUNICIPALITIES = [
  "amsterdam.nl", "rotterdam.nl", "denhaag.nl", "utrecht.nl", "eindhoven.nl",
  "groningen.nl", "tilburg.nl", "almere.nl", "breda.nl", "nijmegen.nl",
  "apeldoorn.nl", "arnhem.nl", "haarlem.nl", "haarlemmermeer.nl", "amersfoort.nl",
  "zaanstad.nl", "s-hertogenbosch.nl", "zwolle.nl", "leiden.nl", "leeuwarden.nl",
  "maastricht.nl", "dordrecht.nl", "ede.nl", "alphenaandenrijn.nl", "westland.nl",
  "venlo.nl", "delft.nl", "deventer.nl", "sittard-geleen.nl", "helmond.nl"
];

const OFFICIAL_SUFFIXES = [
  "gov.uk", "gov.nl", "gov.be", "gov.de", "gov.ie", "gov.pl", "gov.gr",
  "overheid.nl", "rijksoverheid.nl", "politie.nl", "rechtspraak.nl",
  "bund.de", "europa.eu"
];

// Institutions and companies that phishing campaigns impersonate. A token only
// counts when it appears as a full hyphen-separated label part of the hostname
// ("digid-beveiliging.com" matches "digid"; "marketing.nl" does not match "ing").
const IMPERSONATED_BRANDS = new Map(Object.entries({
  digid: ["digid.nl"],
  mijnoverheid: ["mijnoverheid.nl"],
  belastingdienst: ["belastingdienst.nl"],
  toeslagen: ["toeslagen.nl"],
  rijksoverheid: ["rijksoverheid.nl"],
  uwv: ["uwv.nl"],
  svb: ["svb.nl"],
  duo: ["duo.nl"],
  cjib: ["cjib.nl"],
  ind: ["ind.nl"],
  rdw: ["rdw.nl"],
  politie: ["politie.nl"],
  rechtspraak: ["rechtspraak.nl"],
  gemeente: [],
  gov: [],
  ing: ["ing.nl", "ing.com"],
  rabobank: ["rabobank.nl", "rabobank.com"],
  abnamro: ["abnamro.nl", "abnamro.com"],
  bunq: ["bunq.com"],
  knab: ["knab.nl"],
  postnl: ["postnl.nl", "postnl.com"],
  dhl: ["dhl.nl", "dhl.com", "dhl.de"],
  odido: ["odido.nl"]
}));

const DISPLAY_BRANDS = new Map(Object.entries({
  odido: ["odido.nl"]
}));

// Protected identity registry is maintained separately from the analyzer.
const INSTITUTION_IDENTITIES = PROTECTED_IDENTITIES;

function observedServiceDomain(domain) {
  return OBSERVED_SERVICE_DOMAIN_ALLOWLIST.some((expected) => domainMatches(domain, expected));
}

function domainListMatches(domain, domains = []) {
  return (Array.isArray(domains) ? domains : []).some((expected) => domainMatches(domain, expected));
}

function senderIdentityText(author) {
  const value = normalizeText(author);
  const email = parseEmailAddress(value);
  const localPart = email.includes("@") ? email.split("@")[0] : "";
  const displayName = parseDisplayName(value);
  return `${displayName} ${localPart}`.trim();
}

function detectInstitutionIdentity(author, domain) {
  const identityText = senderIdentityText(author);
  if (!identityText) return { claimed: false, supported: false, id: "", label: "", domains: [] };
  for (const institution of INSTITUTION_IDENTITIES) {
    if (!institution.patterns.some((pattern) => pattern.test(identityText))) continue;
    const supported = institution.domains.some((expected) => domainMatches(domain, expected));
    return {
      claimed: true,
      supported,
      id: institution.id,
      label: institution.label,
      domains: [...institution.domains]
    };
  }
  return { claimed: false, supported: false, id: "", label: "", domains: [] };
}

function hostLabelParts(host) {
  return String(host || "").toLowerCase().split(".").flatMap((label) => label.split("-")).filter(Boolean);
}

// True when the hostname is shaped like a known institution or brand but is not
// one of that brand's real domains and not an official domain. This is the form
// real phishing domains take: digid-beveiliging.com, belastingdienst-teruggaaf.ru.
function brandImpersonation(host) {
  if (!host || isOfficialDomain(host)) return false;
  const parts = hostLabelParts(host);
  const labels = String(host || "").toLowerCase().split(".").filter(Boolean);
  for (const [token, legitimateDomains] of IMPERSONATED_BRANDS) {
    // Exact hyphen-separated part match for every token; additionally a
    // concatenated prefix/suffix match ("digidbeveiliging") for tokens of at
    // least five characters, so short tokens like "ing" cannot fire on substrings.
    const concatenated = token.length >= 5
      && labels.some((label) => label !== token && (label.startsWith(token) || label.endsWith(token)));
    if (!parts.includes(token) && !concatenated) continue;
    if (legitimateDomains.some((legit) => domainMatches(host, legit))) continue;
    return true;
  }
  return false;
}

function isOfficialDomain(domain) {
  if (!domain) return false;
  if (OFFICIAL_DOMAINS.some((item) => domainMatches(domain, item))) return true;
  // Only registry-controlled public suffixes may be trusted generically. A pattern such as
  // /gemeente\.[a-z0-9.-]+$/ is unsafe: an attacker can register `gemeente.evil.com` and be
  // verified as official. False negatives are acceptable here; false official verification is not.
  if (OFFICIAL_MUNICIPALITIES.some((item) => domainMatches(domain, item))) return true;
  return OFFICIAL_SUFFIXES.some((suffix) => domainMatches(domain, suffix));
}

function firstHeaderValue(headers, headerName) {
  if (!headers || typeof headers !== "object") return "";
  const key = Object.keys(headers).find((name) => name.toLowerCase() === headerName.toLowerCase());
  const value = key ? headers[key] : null;
  if (Array.isArray(value)) return String(value[0] || "");
  return String(value || "");
}

function allHeaderValues(headers, headerName) {
  if (!headers || typeof headers !== "object") return [];
  const key = Object.keys(headers).find((name) => name.toLowerCase() === headerName.toLowerCase());
  const value = key ? headers[key] : null;
  if (Array.isArray(value)) return value.map((item) => String(item || ""));
  return value ? [String(value)] : [];
}

function alignedDomain(candidate, domain) {
  const value = String(candidate || "").toLowerCase().replace(/^.*@/u, "").replace(/[;,)"'>]+$/u, "");
  if (!value || !domain) return false;
  return value === domain || value.endsWith(`.${domain}`) || domain.endsWith(`.${value}`);
}

// v0.3.0 authentication parsing/evaluation lives in authentication.mjs so the
// trust boundary is testable independently from semantic message analysis.

function getDisplayBrandClaim(displayName, domain) {
  const normalized = String(displayName || "").toLowerCase();
  for (const [token, legitimateDomains] of DISPLAY_BRANDS) {
    if (!new RegExp(`(^|[^a-z0-9])${token}([^a-z0-9]|$)`, "iu").test(normalized)) continue;
    return {
      claimed: true,
      supported: legitimateDomains.some((legit) => domainMatches(domain, legit)),
      token
    };
  }
  return { claimed: false, supported: false, token: "" };
}

function getSenderTrust(author, combinedText, headers = {}, trustedAuthservIds = [], userAllowlistedDomains = [], userBlockedDomains = []) {
  const domain = getDomain(author);
  const displayName = parseDisplayName(author);
  const officialDomainClaim = isOfficialDomain(domain);
  const authentication = evaluateMailAuthentication({ headers, from: author, trustedAuthservIds });
  const userAllowlistedDomain = domainListMatches(domain, userAllowlistedDomains);
  const userBlockedDomain = domainListMatches(domain, userBlockedDomains);
  const displayNameClaim = displayName ? anyMatch(displayName, OFFICIAL_CLAIM_PATTERNS) : false;
  const displayBrand = getDisplayBrandClaim(displayName, domain);
  const institutionIdentity = detectInstitutionIdentity(author, domain);
  // v0.3.0 separates DOMAIN authentication from CLAIMED identity compatibility.
  // A protected identity is verified only when the From domain is on that identity's
  // allowlist AND a trusted authentication service verifies aligned control of the
  // From domain. A compatible domain alone is never enough.
  const verifiedIdentity = institutionIdentity.claimed
    && institutionIdentity.supported
    && authentication.verdict === "verified";
  const authenticatedOfficial = officialDomainClaim && authentication.verdict === "verified";
  const authenticationObserved = authentication.observedAlignedPass === true;
  // Identity cues are taken from the author field, never from incidental body mentions.
  const authorClaim = anyMatch(String(author || ""), OFFICIAL_CLAIM_PATTERNS);
  const officialShapedDomain = brandImpersonation(domain);
  const officialClaim = officialDomainClaim || displayNameClaim || authorClaim || officialShapedDomain || displayBrand.claimed || institutionIdentity.claimed;
  // Mismatch means: an official/brand identity claim that the From DOMAIN ITSELF does
  // not support. When the From domain is a genuine official domain, spoofing is instead
  // covered by the unverifiable-authentication penalty and trusted verification.
  // Authentication observations from unknown headers are DISPLAY-ONLY and never enter
  // this decision (v0.1.15 audit P1): a sender-forged header must not move any score.
  const institutionMismatch = institutionIdentity.claimed && !institutionIdentity.supported;
  const mismatch = institutionMismatch || (!userAllowlistedDomain && !authenticatedOfficial && !officialDomainClaim
    && (displayNameClaim || authorClaim || officialShapedDomain || (displayBrand.claimed && !displayBrand.supported)));
  return {
    domain,
    officialDomainClaim,
    authenticatedOfficial,
    verifiedOfficial: authenticatedOfficial,
    verifiedIdentity,
    authenticationObserved,
    authenticationVerdict: authentication.verdict,
    authentication,
    officialClaim,
    displayNameClaim,
    displayBrandClaim: displayBrand.claimed,
    displayBrandSupported: displayBrand.supported,
    institutionIdentity,
    observedServiceDomain: observedServiceDomain(domain),
    userAllowlistedDomain,
    userBlockedDomain,
    institutionMismatch,
    mismatch,
    freeMailDomain: FREE_MAIL_DOMAINS.has(domain)
  };
}

function validDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date
    : null;
}

function dateToIso(date) {
  return date.toISOString().slice(0, 10);
}

function localCalendarAnchor(referenceDate) {
  return new Date(Date.UTC(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate()));
}

function addCalendarMonthsUtc(referenceDate, count) {
  const anchor = localCalendarAnchor(referenceDate);
  const startYear = anchor.getUTCFullYear();
  const startMonth = anchor.getUTCMonth();
  const startDay = anchor.getUTCDate();
  const absoluteMonth = startMonth + count;
  const targetYear = startYear + Math.floor(absoluteMonth / 12);
  const targetMonth = ((absoluteMonth % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, targetMonth, Math.min(startDay, lastDay)));
}

function inferYear(day, month, referenceDate) {
  let year = referenceDate.getFullYear();
  const candidate = validDate(year, month, day);
  if (!candidate) return year;
  const differenceDays = (candidate.getTime() - referenceDate.getTime()) / 86400000;
  if (differenceDays < -180) year += 1;
  return year;
}

function normalizeYear(rawYear, day, month, referenceDate) {
  if (!rawYear) return inferYear(day, month, referenceDate);
  const numeric = Number(rawYear);
  if (numeric < 100) return numeric >= 70 ? 1900 + numeric : 2000 + numeric;
  return numeric;
}

function findLastMatch(text, pattern) {
  const flags = unique([...pattern.flags.replace(/[gy]/gu, ""), "g"]).join("");
  const regex = new RegExp(pattern.source, flags);
  let last = null;
  let match;
  while ((match = regex.exec(text))) {
    last = match;
    if (match[0].length === 0) regex.lastIndex += 1;
  }
  return last;
}

function deadlineEvidenceBefore(text, dateIndex) {
  const start = Math.max(0, dateIndex - 60);
  const before = text.slice(start, dateIndex);
  let best = null;
  for (const marker of DEADLINE_MARKERS) {
    const match = findLastMatch(before, marker.pattern);
    if (!match) continue;
    const markerEnd = start + match.index + match[0].length;
    const gap = dateIndex - markerEnd;
    const between = text.slice(markerEnd, dateIndex);
    if (gap < 0 || gap > 40 || /\.(?!\d)|[!?\n]/u.test(between)) continue;
    const score = clamp(marker.strength - gap * 0.004, 0, 1);
    if (!best || score > best.score) {
      best = { marker: match[0].trim(), label: marker.label, gap, score, strength: marker.strength };
    }
  }
  return best;
}

// Clause separators used to bound the LOCAL window around a date. A comma that
// is followed by a digit is a decimal or thousands separator, never a clause
// break ("EUR 83,17" must stay one clause).
const CLAUSE_BOUNDARY_SOURCE = "[;:]|,(?!\\s*\\d)|\\s+[—–]\\s+|(?<![\\p{L}\\p{N}_])(?:and|but|however|en|maar|und|aber|и|но)(?![\\p{L}\\p{N}_])";

// A full stop that separates two digits is a decimal separator, not a sentence
// boundary: "EUR 83.17 by 31 January" is ONE sentence, and treating it as two
// would strip the payment instruction out of the date's local context.
const SENTENCE_BREAK_SOURCE = "\\.(?!\\d)|[!?\\n]";

function lastSentenceBreakBefore(text, index) {
  const regex = new RegExp(SENTENCE_BREAK_SOURCE, "gu");
  let last = -1;
  let match;
  while ((match = regex.exec(text))) {
    if (match.index >= index) break;
    last = match.index;
  }
  return last;
}

function firstSentenceBreakFrom(text, index) {
  const regex = new RegExp(SENTENCE_BREAK_SOURCE, "gu");
  regex.lastIndex = index;
  const match = regex.exec(text);
  return match ? match.index : -1;
}

function sentenceBounds(text, index) {
  const start = lastSentenceBreakBefore(text, index) + 1;
  const breakAt = firstSentenceBreakFrom(text, index);
  return { start, end: breakAt >= 0 ? breakAt + 1 : text.length };
}

// The clause containing `index`, bounded by the sentence and by clause separators.
// This is the window in which deadline semantics must be proven: a mandatory
// action in another clause or another sentence may not promote this date.
function clauseAt(text, index) {
  const { start, end } = sentenceBounds(text, index);
  const sentence = text.slice(start, end);
  const local = index - start;
  const regex = new RegExp(CLAUSE_BOUNDARY_SOURCE, "giu");
  let clauseStart = 0;
  let clauseEnd = sentence.length;
  let match;
  while ((match = regex.exec(sentence))) {
    if (match[0].length === 0) { regex.lastIndex += 1; continue; }
    const boundaryEnd = match.index + match[0].length;
    if (boundaryEnd <= local) {
      clauseStart = boundaryEnd;
    } else if (match.index > local) {
      clauseEnd = match.index;
      break;
    }
  }
  return sentence.slice(clauseStart, clauseEnd).trim();
}

// v0.8.0 mandatory/optional evidence reuses the analyser's existing action,
// payment and consequence detection rather than duplicating it.
function hasMandatoryTemporalEvidence(text) {
  if (!text) return false;
  return detectAction(text).detected
    || anyMatch(text, PAYMENT_ACTION_PATTERNS)
    || anyMatch(text, PAYMENT_DUE_CUES)
    || anyMatch(text, MANDATORY_RECEIPT_CUES)
    || anyMatch(text, CONSEQUENCE_PATTERNS);
}

function hasOptionalTemporalEvidence(text) {
  if (!text) return false;
  return anyMatch(text, OPTIONAL_ACTION_PATTERNS) || detectEntitlement(text);
}

// Every parsed date expression is classified. Only expressions whose local
// context proves a deadline or a cancellation window become deadline candidates;
// the rest survive as typed administrative findings.
function classifyDateExpression({ date, raw, index, text, source, ambiguous = false, alternatives = [] }) {
  const marker = deadlineEvidenceBefore(text, index);
  const clause = clauseAt(text, index);
  const sentence = sentenceAt(text, index);
  const role = resolveTemporalRole({
    marker,
    clause,
    sentence,
    ambiguous,
    isMandatory: hasMandatoryTemporalEvidence,
    isOptional: hasOptionalTemporalEvidence
  });
  return {
    date: date ? dateToIso(date) : null,
    raw: raw.trim(),
    index,
    source,
    role: role.role,
    temporalRole: role.temporalRole,
    roleEvidence: role.evidence,
    roleEvidenceKind: role.evidenceKind,
    roleStrength: role.strength,
    roleActionRequired: role.actionRequired,
    roleNeedsVerification: role.needsVerification,
    clause: shorten(clause, 300),
    marker: marker ? marker.marker : "",
    markerLabel: marker ? marker.label : "",
    distance: marker ? marker.gap : null,
    score: marker ? Number(marker.score.toFixed(2)) : Number(role.strength.toFixed(2)),
    ambiguous,
    alternatives
  };
}

function daysFromReference(isoDate, referenceDate) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  const today = Date.UTC(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate());
  return Math.ceil((date.getTime() - today) / 86400000);
}

function calendarDaysBetween(laterDate, earlierDate) {
  const later = localCalendarAnchor(laterDate).getTime();
  const earlier = localCalendarAnchor(earlierDate).getTime();
  return Math.round((later - earlier) / 86400000);
}

function resolveDeadlineCandidates(candidates, statusDate, sourceDate) {
  if (!candidates.length) return { deadline: null, estimatedDeadline: null, candidates: [], needsVerification: [] };

  const deduplicated = [];
  for (const candidate of candidates.sort((a, b) => b.score - a.score || a.index - b.index)) {
    const key = candidate.ambiguous
      ? `ambiguous:${candidate.alternatives.join("|")}:${candidate.raw}`
      : `date:${candidate.date}`;
    if (!deduplicated.some((item) => item.key === key)) deduplicated.push({ ...candidate, key });
  }

  const publicCandidates = deduplicated.map(({ key, ...candidate }) => candidate).slice(0, 10);
  const top = deduplicated[0];
  const needsVerification = [];

  if (top.ambiguous || !top.date) {
    needsVerification.push("deadline_ambiguous_numeric_date");
    return { deadline: null, estimatedDeadline: null, candidates: publicCandidates, needsVerification };
  }

  const conflicting = deduplicated.find((candidate, index) =>
    index > 0 && candidate.date && candidate.date !== top.date && Math.abs(top.score - candidate.score) <= 0.08
  );
  if (conflicting) {
    needsVerification.push("deadline_multiple_equal_candidates");
    return { deadline: null, estimatedDeadline: null, candidates: publicCandidates, needsVerification };
  }

  const daysRemaining = daysFromReference(top.date, statusDate);
  const sourceAgeDays = Math.max(0, calendarDaysBetween(statusDate, sourceDate));
  const historicalSource = sourceAgeDays > HISTORICAL_SOURCE_AGE_DAYS;
  const historicalExpired = historicalSource && daysRemaining < -HISTORICAL_DEADLINE_AGE_DAYS;
  const temporalState = historicalExpired
    ? "historical_expired"
    : daysRemaining < 0
      ? "recently_overdue"
      : daysRemaining === 0
        ? "due_today"
        : daysRemaining <= 3
          ? "due_soon"
          : "future";

  // A relative period ("binnen zes weken") states a DURATION, not a date. Its legal anchor is
  // usually the bekendmaking/decision date, not the date the message arrived. With no resolved
  // anchor the system must not assert a calendar deadline: it reports the period and an explicitly
  // labelled estimate, and leaves `deadline` null so no downstream consumer can treat it as fact.
  if (top.anchorAssumed && !top.anchorResolved) {
    needsVerification.push("relative_deadline_anchor");
    return {
      deadline: null,
      estimatedDeadline: {
        date: top.date,
        daysRemaining,
        raw: top.raw,
        marker: top.marker,
        relativePeriod: top.relativePeriod,
        anchorAssumed: top.anchorAssumed,
        anchorResolved: false,
        evidenceStrength: top.score
      },
      candidates: publicCandidates,
      needsVerification
    };
  }

  return {
      deadline: {
        date: top.date,
        raw: top.raw,
        marker: top.marker,
        // v0.8.0: the deadline slot may legitimately hold the last date on which an
        // OPTIONAL right may be exercised (a cancellation window). The typed role
        // says which it is, so no consumer has to infer a duty from the slot alone.
        role: top.role || TEMPORAL_ROLES.DEADLINE,
        temporalRole: top.temporalRole || TEMPORAL_ROLE_LABELS.deadline,
        actionRequired: top.roleActionRequired !== false,
        overdue: daysRemaining < 0,
        daysRemaining,
        sourceAgeDays,
        temporalState,
        currentlyActionable: !historicalExpired,
        evidenceStrength: top.score,
        manuallySet: false
      },
    estimatedDeadline: null,
    candidates: publicCandidates,
    needsVerification
  };
}

function sentenceAt(text, index) {
  const { start, end } = sentenceBounds(text, index);
  return text.slice(start, end).trim();
}

const COUNT_WORDS = new Map(Object.entries({
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, twenty: 20, thirty: 30,
  een: 1, twee: 2, drie: 3, vier: 4, vijf: 5, zes: 6, zeven: 7, acht: 8, negen: 9, tien: 10,
  elf: 11, twaalf: 12, dertien: 13, veertien: 14, twintig: 20, dertig: 30,
  един: 1, една: 1, едно: 1, две: 2, три: 3, четири: 4, пет: 5, шест: 6, седем: 7, осем: 8, девет: 9, десет: 10,
  единадесет: 11, дванадесет: 12, тринадесет: 13, четиринадесет: 14, двадесет: 20, тридесет: 30,
  eins: 1, zwei: 2, drei: 3, fünf: 5, sechs: 6, sieben: 7, neun: 9, zehn: 10,
  elf_de: 11, zwölf: 12, dreizehn: 13, vierzehn: 14, zwanzig: 20, dreißig: 30
}));

function parseCountWord(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (/^\d{1,3}$/u.test(value)) return Number(value);
  return COUNT_WORDS.get(value) ?? null;
}

// Administrative ENTITLEMENTS: the recipient MAY act (bezwaar/beroep/appeal) within a legal period.
// These are rights, not duties: they must open the deadline gate without being marked `mandatory`.
const ENTITLEMENT_PATTERNS = [
  /(?<![\p{L}\p{N}_])(?:u kunt|u kan|je kunt|u heeft het recht om|u bent gerechtigd)(?![\p{L}\p{N}_])(?=.{0,140}(?:bezwaar|beroep|klacht|reageren|reactie))/iu,
  /\b(?:you may|you can|you have the right to|you are entitled to)\b(?=.{0,140}\b(?:appeal|object|objection|respond|complain|dispute)\b)/iu,
  /\b(?:sie können|sie haben das recht|sie sind berechtigt)\b(?=.{0,140}\b(?:widerspruch|einspruch|beschwerde|reagieren)\b)/iu,
  /(?<![\p{L}\p{N}_])(?:можете да|имате право да|разполагате с право)(?![\p{L}\p{N}_])(?=.{0,140}(?:обжалвате|обжалване|възразите|възражение|жалба|отговорите))/iu
];

function detectEntitlement(text) {
  return anyMatch(text, ENTITLEMENT_PATTERNS);
}

function relativeWindowHasDeadlineContext(text, index) {
  const sentence = sentenceAt(text, index);
  if (!sentence) return false;
  const action = detectAction(sentence);
  return action.detected
    || detectEntitlement(sentence)
    || anyMatch(sentence, PAYMENT_ACTION_PATTERNS)
    || anyMatch(sentence, REPLY_PATTERNS)
    || anyMatch(sentence, CONSEQUENCE_PATTERNS)
    || /\b(?:deadline|termijn|frist|краен срок)\b/iu.test(sentence);
}

function extractDeadline(text, referenceDate, language, statusDate = referenceDate) {
  // v0.8.0: EVERY parsed date expression is collected and classified. Deadline
  // candidacy is then a property of the expression's administrative role, not a
  // side effect of the parser having recognised a calendar value.
  const expressions = [];
  const push = (expression) => {
    if (!expression || expressions.length >= MAX_DATE_EXPRESSIONS) return;
    expressions.push(expression);
  };
  // Skip classification entirely once the cap is reached, so the bound applies to
  // the work as well as to the result.
  const classify = (input) => (expressions.length >= MAX_DATE_EXPRESSIONS ? null : classifyDateExpression(input));
  let match;

  const isoPattern = /\b(20\d{2})[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])\b/gu;
  while ((match = isoPattern.exec(text))) {
    push(classify({
      date: validDate(Number(match[1]), Number(match[2]), Number(match[3])),
      raw: match[0], index: match.index, text, source: "iso"
    }));
  }

  const numericPattern = /\b(0?[1-9]|[12]\d|3[01])[-/.](0?[1-9]|[12]\d|3[01])[-/.](\d{2}|20\d{2})\b/gu;
  while ((match = numericPattern.exec(text))) {
    const first = Number(match[1]);
    const second = Number(match[2]);
    const lang = String(language || "und").toLowerCase();
    let day;
    let month;
    let ambiguous = false;
    let alternatives = [];

    if (first > 12 && second <= 12) {
      day = first; month = second;
    } else if (second > 12 && first <= 12) {
      day = second; month = first;
    } else if (first <= 12 && second <= 12) {
      if (["nl", "bg", "de"].includes(lang)) {
        day = first; month = second;
      } else {
        const dmyYear = normalizeYear(match[3], first, second, referenceDate);
        const mdyYear = normalizeYear(match[3], second, first, referenceDate);
        const dmy = validDate(dmyYear, second, first);
        const mdy = validDate(mdyYear, first, second);
        alternatives = unique([dmy && dateToIso(dmy), mdy && dateToIso(mdy)]);
        ambiguous = alternatives.length > 1;
        if (!ambiguous && alternatives.length === 1) {
          const [year, resolvedMonth, resolvedDay] = alternatives[0].split("-").map(Number);
          push(classify({
            date: validDate(year, resolvedMonth, resolvedDay), raw: match[0], index: match.index,
            text, source: "numeric-resolved"
          }));
          continue;
        }
      }
    }

    if (ambiguous) {
      push(classify({
        date: null, raw: match[0], index: match.index, text,
        source: "numeric-ambiguous", ambiguous: true, alternatives
      }));
      continue;
    }

    if (day && month) {
      const year = normalizeYear(match[3], day, month, referenceDate);
      push(classify({
        date: validDate(year, month, day), raw: match[0], index: match.index, text, source: "numeric"
      }));
    }
  }

  const monthNames = [...MONTHS.keys()]
    .sort((a, b) => b.length - a.length)
    .map((item) => item.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("|");

  const dayMonthPattern = new RegExp(`(?<![\\p{L}\\p{N}_])(0?[1-9]|[12]\\d|3[01])(?:st|nd|rd|th|e)?\\.?\\s+(${monthNames})\\.?(?:\\s+(20\\d{2}|\\d{2}))?(?![\\p{L}\\p{N}_])`, "giu");
  while ((match = dayMonthPattern.exec(text))) {
    const day = Number(match[1]);
    const month = MONTHS.get(normalizeMonthToken(match[2]));
    const year = normalizeYear(match[3], day, month, referenceDate);
    push(classify({
      date: validDate(year, month, day), raw: match[0], index: match.index, text, source: "day-month-name"
    }));
  }

  const monthDayPattern = new RegExp(`(?<![\\p{L}\\p{N}_])(${monthNames})\\.?\\s+(0?[1-9]|[12]\\d|3[01])(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}|\\d{2}))?(?![\\p{L}\\p{N}_])`, "giu");
  while ((match = monthDayPattern.exec(text))) {
    const month = MONTHS.get(normalizeMonthToken(match[1]));
    const day = Number(match[2]);
    const year = normalizeYear(match[3], day, month, referenceDate);
    push(classify({
      date: validDate(year, month, day), raw: match[0], index: match.index, text, source: "month-name-day"
    }));
  }

  const relativeRules = [
    { pattern: /(?<![\p{L}\p{N}_])(tomorrow|morgen|утре)(?![\p{L}\p{N}_])/giu, offset: 1 },
    { pattern: /(?<![\p{L}\p{N}_])(day after tomorrow|overmorgen|вдругиден)(?![\p{L}\p{N}_])/giu, offset: 2 },
    { pattern: /(?<![\p{L}\p{N}_])(today|vandaag|днес|heute)(?![\p{L}\p{N}_])/giu, offset: 0 }
  ];
  for (const rule of relativeRules) {
    while ((match = rule.pattern.exec(text))) {
      const date = new Date(Date.UTC(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate() + rule.offset));
      push(classify({ date, raw: match[0], index: match.index, text, source: "relative" }));
    }
  }

  const withinPattern = /(?<![\p{L}\p{N}_])(?:within|binnen|in een termijn van|в срок от|innerhalb von)\s+(\d{1,3}|[\p{L}]{3,20})\s+(?:calendar\s+|kalender)?(days?|dagen|dag|дни|ден|tagen|tage|tag|weeks?|weken|week|седмици|седмица|wochen|woche|months?|maanden|maand|месеца|месец|monaten|monate|monat)(?![\p{L}\p{N}_])/giu;
  while ((match = withinPattern.exec(text))) {
    const count = parseCountWord(match[1]);
    const isMonths = /^(?:months?|maanden|maand|месеца|месец|monaten|monate|monat)$/iu.test(match[2]);
    const unitDays = /^(?:weeks?|weken|week|седмици|седмица|wochen|woche)$/iu.test(match[2]) ? 7 : 1;
    if (count !== null && count >= 1 && relativeWindowHasDeadlineContext(text, match.index)) {
      // Calendar-month arithmetic clamps to the last valid day of the target month.
      // 31 January + 1 month therefore becomes 28/29 February, never a March overflow.
      const date = isMonths
        ? addCalendarMonthsUtc(referenceDate, count)
        : new Date(Date.UTC(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate() + count * unitDays));
      const referenceDay = Date.UTC(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate());
      const actualOffsetDays = Math.round((date.getTime() - referenceDay) / 86400000);
      if (actualOffsetDays >= 1 && actualOffsetDays <= 366 && expressions.length < MAX_DATE_EXPRESSIONS) {
        const windowMarker = {
          marker: match[0].trim(), label: "context-supported relative deadline",
          gap: 0, score: 0.92, strength: 0.92
        };
        const windowRole = resolveTemporalRole({
          marker: windowMarker,
          clause: clauseAt(text, match.index),
          sentence: sentenceAt(text, match.index),
          isMandatory: hasMandatoryTemporalEvidence,
          isOptional: hasOptionalTemporalEvidence
        });
        expressions.push({
          date: dateToIso(date), raw: match[0], index: match.index, source: "relative-window",
          marker: match[0], markerLabel: "context-supported relative deadline", distance: 0, score: 0.92,
          ambiguous: false, alternatives: [],
          role: windowRole.role === TEMPORAL_ROLES.NONE ? TEMPORAL_ROLES.DEADLINE : windowRole.role,
          temporalRole: windowRole.temporalRole || TEMPORAL_ROLE_LABELS.deadline,
          roleEvidence: windowRole.evidence || match[0].trim(),
          roleEvidenceKind: "relative_period_with_deadline_context",
          roleStrength: 0.92,
          roleActionRequired: windowRole.actionRequired,
          roleNeedsVerification: true,
          clause: shorten(clauseAt(text, match.index), 300),
          // The period is certain; its ANCHOR is not. Dutch administrative periods run from
          // bekendmaking/decision date, not necessarily the date the email was received.
          relativePeriod: { count, unit: match[2].toLowerCase(), days: actualOffsetDays },
          anchorAssumed: "message_date"
        });
      }
    }
  }

  // Only proven deadline / cancellation-window context may reach the deadline
  // resolver. Appointment, delivery, renewal-effective and informational dates
  // are never deadline candidates, however confidently they were parsed.
  const operational = expressions.filter((expression) => OPERATIONAL_ROLES.includes(expression.role));
  const resolved = resolveDeadlineCandidates(operational, statusDate, referenceDate);
  return { ...resolved, expressions: expressions.sort((a, b) => a.index - b.index) };
}

function parseLocalizedNumber(raw) {
  let value = raw.replace(/\s+/gu, "").replace(/[^0-9.,-]/gu, "");
  if (!value) return null;
  const lastComma = value.lastIndexOf(",");
  const lastDot = value.lastIndexOf(".");
  const decimalIndex = Math.max(lastComma, lastDot);
  if (decimalIndex >= 0 && value.length - decimalIndex - 1 === 2) {
    const integerPart = value.slice(0, decimalIndex).replace(/[.,]/gu, "");
    const decimalPart = value.slice(decimalIndex + 1);
    value = `${integerPart}.${decimalPart}`;
  } else {
    value = value.replace(/[.,]/gu, "");
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function extractAmounts(text) {
  const h = "[ \t\u00A0\u202F]*";
  const eurNumber = "([0-9]+(?:[., \u00A0\u202F][0-9]{3})*(?:[.,][0-9]{2})?)";
  const enNumber = "([0-9]+(?:[, \u00A0\u202F][0-9]{3})*(?:\.[0-9]{2})?)";
  const patterns = [
    { currency: "EUR", pattern: new RegExp(`(?:€|EUR)${h}${eurNumber}(?![0-9])`, "giu") },
    { currency: "EUR", pattern: new RegExp(`${eurNumber}${h}(?:€|EUR|euros?|euro)`, "giu") },
    { currency: "USD", pattern: new RegExp(`(?:\\$|USD)${h}${enNumber}(?![0-9])`, "giu") },
    { currency: "GBP", pattern: new RegExp(`(?:£|GBP)${h}${enNumber}(?![0-9])`, "giu") }
  ];
  const results = [];
  for (const item of patterns) {
    let match;
    while ((match = item.pattern.exec(text))) {
      const value = parseLocalizedNumber(match[1]);
      if (value !== null && value >= 0 && value < 1e12) {
        results.push({ currency: item.currency, value, raw: match[0].trim() });
      }
    }
  }
  const seen = new Set();
  return results.filter((item) => {
    const key = `${item.currency}:${item.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 10);
}

function splitSentences(text) {
  const sentences = text
    .replace(/\r/gu, "")
    .split(/(?<=[.!?])\s+|\n+/gu)
    .map((sentence) => sentence.replace(/\s+/gu, " ").trim())
    .filter((sentence) => sentence.length >= 4);
  const chunks = [];
  for (const sentence of sentences) {
    if (sentence.length <= 600) {
      chunks.push(sentence);
      continue;
    }
    for (let offset = 0; offset < sentence.length; offset += 500) {
      chunks.push(sentence.slice(offset, offset + 600).trim());
    }
  }
  return chunks.filter((sentence) => sentence.length >= 4);
}

function splitActionClauses(sentence) {
  return sentence.split(/\s+(?:but|however|maar|но|aber)\s+/iu).map((part) => part.trim()).filter(Boolean);
}

function shorten(value, maxLength = 220) {
  const clean = normalizeText(value).replace(/\s+/gu, " ");
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 1).trimEnd()}…`;
}

function detectAction(text) {
  const evidence = [];
  for (const sentence of splitSentences(text)) {
    if (anyMatch(sentence, NON_ACTION_HEADING_PATTERNS)) continue;
    for (const clause of splitActionClauses(sentence)) {
      if (anyMatch(clause, ACTION_NEGATION_PATTERNS) || anyMatch(clause, OPTIONAL_ACTION_PATTERNS)) continue;
      for (const rule of ACTION_RULES) {
        const match = clause.match(rule.pattern);
        if (!match) continue;
        evidence.push({
          sentence: shorten(clause, 500),
          matched: match[0],
          strength: rule.strength,
          mandatory: rule.mandatory || anyMatch(clause, CONSEQUENCE_PATTERNS)
        });
      }
    }
  }
  evidence.sort((a, b) => b.strength - a.strength);
  return {
    detected: evidence.length > 0,
    mandatory: evidence.some((item) => item.mandatory),
    strength: evidence[0]?.strength || 0,
    evidence: evidence.slice(0, 5)
  };
}

function gateCommercialAction(action, text, commercial) {
  if (!commercial || !action.detected || action.mandatory || anyMatch(text, ACCOUNT_LIFECYCLE_PATTERNS)) return action;
  const evidence = action.evidence.filter((item) => !anyMatch(item.sentence, MARKETING_CTA_PATTERNS));
  return {
    detected: evidence.length > 0,
    mandatory: evidence.some((item) => item.mandatory),
    strength: evidence[0]?.strength || 0,
    evidence
  };
}

function detectReplyExpected(text, { commercial = false } = {}) {
  for (const sentence of splitSentences(text)) {
    if (anyMatch(sentence, OPTIONAL_HELP_PATTERNS)) continue;
    if (anyMatch(sentence, STRONG_REPLY_PATTERNS)) return true;
    if (!commercial && sentence.includes("?") && anyMatch(sentence, QUESTION_REPLY_PATTERNS)) return true;
  }
  return false;
}

function classifyFinancialContext(text, amounts, commercial) {
  const obligation = anyMatch(text, PAYMENT_OBLIGATION_PATTERNS);
  const completed = anyMatch(text, COMPLETED_PAYMENT_PATTERNS);
  const priceChange = anyMatch(text, PRICE_CHANGE_PATTERNS);
  const paymentAction = anyMatch(text, PAYMENT_ACTION_PATTERNS);
  const genericFinancial = anyMatch(text, PAYMENT_PATTERNS);
  const paymentDetected = obligation || completed || priceChange
    || (!commercial && (paymentAction || (genericFinancial && amounts.length > 0)));
  const actionRequired = obligation || (!completed && !priceChange && paymentAction && !commercial);
  return { paymentDetected, actionRequired, completed, priceChange, obligation };
}

function extractRequiredAction(text, action, replyExpected, paymentDetected) {
  if (!action.detected && !replyExpected && !paymentDetected) return "";
  if (action.evidence.length) return shorten(action.evidence[0].sentence);
  const sentences = splitSentences(text);
  const candidate = sentences.find((sentence) =>
    anyMatch(sentence, REPLY_PATTERNS) || anyMatch(sentence, PAYMENT_ACTION_PATTERNS)
  );
  return shorten(candidate || "Review the message and determine the requested action.");
}

function getHeaderText(headers, headerName) {
  if (!headers || typeof headers !== "object") return "";
  const key = Object.keys(headers).find((name) => name.toLowerCase() === headerName.toLowerCase());
  const value = key ? headers[key] : null;
  return Array.isArray(value) ? value.join(" ") : String(value || "");
}

const IP_HOST_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/u;
const IPV6_HOST_PATTERN = /^\[?[0-9a-f:]*:[0-9a-f:]*\]?$/iu;
const TEXT_DOMAIN_PATTERN = /\b([a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+)\b/u;

const MULTI_LABEL_PUBLIC_SUFFIXES = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk",
  "com.au", "net.au", "org.au", "co.nz", "co.jp", "com.br"
]);
const SAFE_SIMPLE_PUBLIC_SUFFIXES = new Set([
  "com", "net", "org", "nl", "de", "be", "eu", "ai", "dev", "app", "io"
]);

function organizationalDomain(host) {
  const labels = String(host || "").toLowerCase().split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  if (MULTI_LABEL_PUBLIC_SUFFIXES.has(lastTwo)) return labels.slice(-3).join(".");
  // Do not guess registrable boundaries for unknown country-code policies.
  // False negatives are safer than suppressing a real cross-domain phishing signal.
  return SAFE_SIMPLE_PUBLIC_SUFFIXES.has(labels.at(-1)) ? lastTwo : labels.join(".");
}

function sameOrganizationalDomain(first, second) {
  const a = organizationalDomain(first);
  const b = organizationalDomain(second);
  return Boolean(a && b && a === b);
}

function linkHostname(href) {
  try {
    return new URL(String(href || "")).hostname.toLowerCase();
  } catch {
    return "";
  }
}

// Links are the primary phishing signal. Each finding is reported once per message.
function analyzeLinks(links, senderDomain, commercial = false) {
  const findings = [];
  const flagged = new Set();
  const add = (key, score, reason) => {
    if (flagged.has(key)) return;
    flagged.add(key);
    findings.push({ key, score, reason });
  };

  for (const link of Array.isArray(links) ? links.slice(0, 400) : []) {
    const host = linkHostname(link?.href);
    if (!host) continue;

    // 1. The visible link text names a domain, but the real target is elsewhere.
    const textDomain = (String(link?.text || "").toLowerCase().match(TEXT_DOMAIN_PATTERN) || [])[1] || "";
    if (textDomain && textDomain.includes(".") && !alignedDomain(host, textDomain) && !alignedDomain(textDomain, host)) {
      // A first-party destination is not a credential escape merely because its
      // visible label names a third-party service (common in account notices).
      if (!senderDomain || (!alignedDomain(host, senderDomain) && !sameOrganizationalDomain(host, senderDomain))) {
        add(
          "link_text_mismatch",
          commercial ? 15 : 30,
          commercial
            ? "A marketing link uses a cross-domain redirect; treat it as a weak indicator unless other risk signals are present."
            : "A link's visible text names a different domain than its real target."
        );
      }
    }
    // 2. The target hostname is shaped like a known institution or brand but is not it.
    if (brandImpersonation(host)) {
      add("link_brand_lookalike", 30, "A link points to a domain shaped like a known institution or brand, but it is not that organization's real domain.");
    }
    // 3. Punycode hostnames can disguise homograph lookalikes.
    if (host.split(".").some((label) => label.startsWith("xn--"))) {
      add("link_punycode", 20, "A link uses an internationalized (punycode) hostname, which can disguise a lookalike domain.");
    }
    // 4. Raw IP-address links (IPv4 or IPv6) are almost never legitimate in administrative mail.
    if (IP_HOST_PATTERN.test(host) || IPV6_HOST_PATTERN.test(host)) {
      add("link_ip_address", 25, "A link points directly to an IP address instead of a named domain.");
    }
  }
  return findings;
}

const IBAN_PATTERN = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,8}(?:\s?[A-Z0-9]{1,3})?\b/iu;

const BANK_CHANGE_PATTERNS = [
  /\b(?:nieuwe?|gewijzigde?|andere?)\s+(?:bank)?rekening(?:nummer)?\b|\brekeningnummer\s+(?:is\s+)?gewijzigd\b/iu,
  /\b(?:new|changed|updated)\s+(?:bank\s+)?(?:account|iban|banking)\s*(?:number|details)?\b/iu,
  /\b(?:neue[sn]?|geändertes?)\s+(?:bank)?(?:konto|kontonummer|iban)\b/iu,
  /(нова?\s+(?:банкова\s+)?сметка|променен[аи]?\s+(?:банкова\s+)?сметка|нов\s+iban)/iu
];

function buildRisk({ text, attachments, paymentDetected, senderTrust, links = [], commercial = false }) {
  let score = 0;
  const reasons = [];
  const authentication = senderTrust.authentication || { present: false, trust: "unknown", trustedAlignedPass: false, observedAlignedPass: false, trustedFailure: false };
  const credentialAsk = anyMatch(text, CREDENTIAL_PATTERNS);
  const claimsOrAsks = senderTrust.officialClaim || credentialAsk || paymentDetected;
  const institutionMismatch = senderTrust.institutionMismatch === true;

  if (senderTrust.userBlockedDomain === true) {
    return {
      level: "High",
      score: 100,
      scoreKind: "user-domain-hard-block",
      hardBlock: true,
      blockCode: "USER_BLOCKED_DOMAIN",
      actualDomain: senderTrust.domain || "unknown",
      reasons: [
        `The sender domain ${senderTrust.domain || "unknown"} is on the local CIVION Mail blocked-domain list.`,
        "A user-blocked sender domain is an unconditional CIVION Mail hard block."
      ],
      credentialRequest: credentialAsk
    };
  }

  if (institutionMismatch) {
    const identity = senderTrust.institutionIdentity || {};
    const expected = Array.isArray(identity.domains) ? identity.domains.join(", ") : "the institution allowlist";
    return {
      level: "High",
      score: 100,
      scoreKind: "institution-hard-block",
      hardBlock: true,
      blockCode: "INSTITUTION_DOMAIN_MISMATCH",
      claimedInstitution: identity.id || "official-institution",
      claimedInstitutionLabel: identity.label || "Official institution",
      actualDomain: senderTrust.domain || "unknown",
      expectedDomains: Array.isArray(identity.domains) ? [...identity.domains] : [],
      reasons: [
        `${identity.label || "An official institution"} is claimed by the sender identity, but the From domain ${senderTrust.domain || "unknown"} is not allowlisted for that institution (expected: ${expected}).`,
        "Institution identity mismatch is an unconditional CIVION Mail hard block."
      ],
      credentialRequest: credentialAsk
    };
  }

  // Failure scoring and verification share ONE trust boundary: only a failure reported
  // by a trusted authserv-id counts as a failure. A forged secondary "dmarc=fail" from
  // an untrusted header can neither create suspicion nor cancel a trusted pass.
  if (authentication.trustedFailure) {
    score += 35;
    reasons.push("A trusted authentication service reports a failure or error for this sender.");
  } else if (!senderTrust.verifiedOfficial && claimsOrAsks && !(senderTrust.userAllowlistedDomain && !credentialAsk && !paymentDetected)) {
    // Authentication evidence is absent or unverifiable for a message that claims
    // authority or requests credentials or payment. Observations from unknown
    // authserv-ids deliberately do NOT suppress this penalty: they are unverified
    // and can be supplied by the sender (v0.1.15 audit P1).
    score += 15;
    reasons.push("Sender authentication is unavailable or unverifiable for a message that claims authority or requests credentials or payment.");
  }
  if (authentication.conflict) {
    score += 25;
    reasons.push("Trusted mail-authentication results conflict; sender identity cannot be verified automatically.");
  }
  const replyToMismatch = authentication.replyTo?.alignment === "different";
  if (replyToMismatch && claimsOrAsks) {
    score += 18;
    reasons.push(`Reply-To uses ${authentication.replyTo.domain || "a different domain"}, which does not align with the From domain ${senderTrust.domain || "unknown"}.`);
  }
  if (senderTrust.mismatch) {
    score += 30;
    reasons.push("The message uses official language or identity cues, but the sender domain is not a verified official domain.");
  }
  if (senderTrust.displayNameClaim && !senderTrust.verifiedOfficial && !senderTrust.officialDomainClaim) {
    score += 20;
    reasons.push("The display name claims an official identity that is not supported by the sender domain.");
  }
  if (senderTrust.freeMailDomain && senderTrust.officialClaim) {
    score += 15;
    reasons.push("An official claim is sent from a public free-mail domain.");
  }
  // 32 keeps a lone credential request above the Suspicious/Medium threshold (30):
  // a credential signal must never coexist with Information Only / No Action.
  if (credentialAsk) {
    score += 32;
    reasons.push("The message asks for account, password, personal-details or security-code action.");
  }
  for (const finding of analyzeLinks(links, senderTrust.domain, commercial)) {
    score += finding.score;
    reasons.push(finding.reason);
  }
  if (IBAN_PATTERN.test(text) && anyMatch(text, BANK_CHANGE_PATTERNS)) {
    score += 30;
    reasons.push("The message announces a new or changed bank account number, a common invoice-fraud pattern.");
  }
  if (anyMatch(text, HIGH_PRESSURE_PATTERNS)) {
    score += 22;
    reasons.push("The message uses high-pressure or unusual payment language.");
  }
  if (paymentDetected && anyMatch(text, HIGH_PRESSURE_PATTERNS)) {
    score += 18;
    reasons.push("A financial request is combined with urgency.");
  }
  const riskyAttachment = attachments.find((attachment) => /\.(exe|scr|js|jse|vbs|vbe|bat|cmd|com|msi|lnk|iso|img|jar|ps1|hta)$/iu.test(attachment.name || ""));
  if (riskyAttachment) {
    score += 35;
    reasons.push(`Potentially dangerous attachment type: ${riskyAttachment.name}.`);
  }
  if (attachments.some((attachment) => /\.(zip|rar|7z)$/iu.test(attachment.name || "")) && credentialAsk) {
    score += 15;
    reasons.push("An archive attachment accompanies a credential-related request.");
  }

  score = clamp(score, 0, 100);
  const level = score >= 65 ? "High" : score >= 30 ? "Medium" : "Low";
  return { level, score, scoreKind: "rule-indicator", hardBlock: false, reasons: unique(reasons), credentialRequest: credentialAsk };
}

function determinePriority({ deadline, needsVerification, action, replyExpected, paymentDetected, senderTrust, risk }) {
  const reasons = [];
  let priority = "No Action";
  // A historically expired deadline stays evidence. It must not raise current priority through
  // ANY branch, not only the overdue one, and not only when the security risk is Low.
  const deadlineActionable = Boolean(deadline)
    && deadline.currentlyActionable !== false
    && deadline.temporalState !== "historical_expired";
  const deadlineVerified = deadlineActionable
    && !needsVerification.includes("deadline")
    && deadline.evidenceStrength >= 0.84;

  if (risk.hardBlock === true) {
    priority = "Critical";
    reasons.push(risk.blockCode === "USER_BLOCKED_DOMAIN"
      ? "Blocked: the sender domain is on the local blocked-domain list."
      : "Blocked: a recognized official institution is claimed from a non-allowlisted sender domain.");
  } else if (risk.level === "High") {
    priority = "High";
    reasons.push("High preliminary security risk.");
  }

  if (risk.hardBlock === true) {
    return { priority, reasons };
  }

  if (deadline?.temporalState === "historical_expired" && risk.level === "Low") {
    reasons.push("The extracted obligation belongs to a historical source and is retained as evidence, not current attention.");
    return { priority: "No Action", reasons };
  }

  if (deadlineVerified && deadline.overdue && (action.mandatory || paymentDetected)) {
    priority = "Critical";
    reasons.push("A strongly evidenced mandatory or payment deadline appears overdue.");
  } else if (deadlineVerified && deadline.daysRemaining <= 1 && (action.mandatory || paymentDetected)) {
    priority = "Critical";
    reasons.push("A strongly evidenced consequential deadline is today or tomorrow.");
  } else if (deadlineVerified && deadline.daysRemaining <= 3 && (action.detected || paymentDetected || replyExpected)) {
    if (priority !== "Critical") priority = "High";
    reasons.push("A strongly evidenced deadline is within three days.");
  } else if ((senderTrust.verifiedOfficial && action.mandatory) || (paymentDetected && action.detected)) {
    if (!["Critical", "High"].includes(priority)) priority = "High";
    reasons.push("The message combines consequential context with explicit action evidence.");
  } else if (deadlineActionable || action.detected || replyExpected || paymentDetected || needsVerification.length) {
    if (priority === "No Action") priority = "Medium";
    reasons.push(needsVerification.length
      ? "The message requires review because part of the analysis is unresolved."
      : "The message appears to require attention.");
  } else if (risk.level === "Medium") {
    priority = "Medium";
    reasons.push("The message has security indicators requiring review.");
  } else if (priority === "No Action") {
    reasons.push("No explicit action or deadline was detected.");
  }

  return { priority, reasons };
}

function localizedFallback(language, kind) {
  const code = (language || "").toLowerCase();
  const table = {
    bg: {
      noAction: "Не е открито изрично задължително действие.",
      review: "Прегледайте писмото и проверете извлечената информация.",
      reply: "Подгответе отговор след проверка на искането.",
      pay: "Проверете сумата, получателя и срока преди плащане.",
      suspicious: "Не използвайте връзки или приложения, преди да проверите подателя по независим канал.",
      blocked: "БЛОКИРАНО — подателят се представя за официална институция, но използва неразрешен за нея домейн. Не използвайте връзки, приложения или инструкции от това писмо.",
      blockedDomain: "БЛОКИРАНО — домейнът на подателя е добавен ръчно в блокирания списък на CIVION Mail. Не използвайте връзки, приложения или инструкции от това писмо.",
      historical: "Исторически запис — извлеченото задължение е запазено като доказателство, но не се представя като текущо."
    },
    nl: {
      noAction: "Er is geen expliciete verplichte actie gevonden.",
      review: "Controleer het bericht en de geëxtraheerde gegevens.",
      reply: "Bereid na controle een antwoord voor.",
      pay: "Controleer bedrag, begunstigde en termijn vóór betaling.",
      suspicious: "Gebruik geen links of bijlagen voordat de afzender onafhankelijk is geverifieerd.",
      blocked: "GEBLOKKEERD — de afzender doet zich voor als een officiële instantie maar gebruikt geen toegestaan domein. Gebruik geen links, bijlagen of instructies uit dit bericht.",
      blockedDomain: "GEBLOKKEERD — het afzenderdomein staat handmatig op de lokale blokkeerlijst van CIVION Mail. Gebruik geen links, bijlagen of instructies uit dit bericht.",
      historical: "Historisch bericht — de gevonden verplichting blijft als bewijs bewaard, maar wordt niet als actueel gepresenteerd."
    },
    en: {
      noAction: "No explicit mandatory action was detected.",
      review: "Review the message and verify the extracted information.",
      reply: "Prepare a reply after checking the request.",
      pay: "Verify the amount, recipient and deadline before paying.",
      suspicious: "Do not use links or attachments until the sender is independently verified.",
      blocked: "BLOCKED — the sender claims an official institution but uses a non-allowlisted domain. Do not use links, attachments, or instructions from this message.",
      blockedDomain: "BLOCKED — the sender domain is manually listed in the local CIVION Mail blocked-domain list. Do not use links, attachments, or instructions from this message.",
      historical: "Historical record — the extracted obligation is retained as evidence but is not presented as current."
    }
  };
  const languageTable = table[code] || table.en;
  return languageTable[kind] || table.en[kind];
}

function buildSummary({ language, sender, requiredAction, deadline, estimatedDeadline, deadlineCandidates, amounts, priority, risk }) {
  const code = (language || "").toLowerCase();
  const senderText = shorten(sender || "Unknown sender", 90);
  const actionText = requiredAction || localizedFallback(language, "noAction");
  const amountText = amounts.length ? `${amounts[0].currency} ${amounts[0].value.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "";
  const unresolvedDeadline = !deadline && deadlineCandidates.length > 0;

  // With an unresolved anchor, state the PERIOD (known) rather than a date (assumed).
  const period = estimatedDeadline?.relativePeriod;
  const periodText = period
    ? {
      bg: ` Срок: ${period.count} ${period.unit} — началната дата не е потвърдена.`,
      nl: ` Termijn: ${period.count} ${period.unit} — startdatum niet bevestigd.`,
      en: ` Period: ${period.count} ${period.unit} — start date unconfirmed.`
    }
    : null;

  const historicalDeadline = deadline?.temporalState === "historical_expired";

  // v0.8.0: an optional cancellation window keeps its date but is never worded as
  // a deadline, so the summary cannot read as an obligation either.
  const optionalWindow = Boolean(deadline)
    && deadline.role === TEMPORAL_ROLES.CANCELLATION_WINDOW
    && deadline.actionRequired !== true;
  const windowText = optionalWindow ? {
    bg: ` Възможност за отказ до ${deadline.date} — по избор, не задължение.`,
    nl: ` Opzeggen mogelijk tot ${deadline.date} — optioneel, geen verplichting.`,
    en: ` Cancellation possible until ${deadline.date} — optional, not an obligation.`
  } : null;

  if (code === "bg") {
    const deadlineText = historicalDeadline
      ? ` Исторически срок: ${deadline.date} — запазен като доказателство, не като текущо задължение.`
      : optionalWindow ? windowText.bg
        : deadline ? ` Краен срок: ${deadline.date}.` : "";
    return shorten(`От: ${senderText}. ${actionText}${deadlineText || (periodText ? periodText.bg : unresolvedDeadline ? " Възможният срок изисква ръчна проверка." : "")}${amountText ? ` Сума: ${amountText}.` : ""} Приоритет: ${priority}.${risk.level !== "Low" ? ` Риск: ${risk.level}.` : ""}`, 420);
  }
  if (code === "nl") {
    const deadlineText = historicalDeadline
      ? ` Historische termijn: ${deadline.date} — bewaard als bewijs, niet als actuele verplichting.`
      : optionalWindow ? windowText.nl
        : deadline ? ` Termijn: ${deadline.date}.` : "";
    return shorten(`Van: ${senderText}. ${actionText}${deadlineText || (periodText ? periodText.nl : unresolvedDeadline ? " De mogelijke termijn moet handmatig worden gecontroleerd." : "")}${amountText ? ` Bedrag: ${amountText}.` : ""} Prioriteit: ${priority}.${risk.level !== "Low" ? ` Risico: ${risk.level}.` : ""}`, 420);
  }
  const deadlineText = historicalDeadline
    ? ` Historical deadline: ${deadline.date} — retained as evidence, not a current obligation.`
    : optionalWindow ? windowText.en
      : deadline ? ` Deadline: ${deadline.date}.` : "";
  return shorten(`From: ${senderText}. ${actionText}${deadlineText || (periodText ? periodText.en : unresolvedDeadline ? " The possible deadline requires manual verification." : "")}${amountText ? ` Amount: ${amountText}.` : ""} Priority: ${priority}.${risk.level !== "Low" ? ` Risk: ${risk.level}.` : ""}`, 420);
}

function buildRecommendedNextStep({ language, replyExpected, paymentDetected, risk, action, needsVerification, deadline }) {
  if (risk.hardBlock === true) return localizedFallback(language, "blocked");
  if (risk.level === "High") return localizedFallback(language, "suspicious");
  if (deadline?.temporalState === "historical_expired") return localizedFallback(language, "historical");
  if (needsVerification.length) return localizedFallback(language, "review");
  if (paymentDetected) return localizedFallback(language, "pay");
  if (replyExpected) return localizedFallback(language, "reply");
  if (action.detected) return localizedFallback(language, "review");
  return localizedFallback(language, "noAction");
}

function calculateReliability({ body, languageDetection, action, deadline, deadlineCandidates, amounts, senderTrust, needsVerification }) {
  if (!body.trim()) return { score: 0.2, label: "Low", reasons: ["The readable message body is empty."] };

  const reasons = [];
  let score = body.length >= 120 ? 0.76 : body.length >= 40 ? 0.68 : 0.56;

  if (action.detected && action.strength >= 0.9) {
    score += 0.04;
    reasons.push("The requested action is supported by a direct action phrase.");
  }
  if (deadline?.evidenceStrength >= 0.9) {
    score += 0.05;
    reasons.push("The selected deadline has a close explicit marker.");
  }
  if (deadlineCandidates.length > 1) {
    score -= 0.12;
    reasons.push("Multiple deadline candidates reduce reliability.");
  }
  if (needsVerification.includes("deadline_ambiguous_numeric_date")) {
    score -= 0.25;
    reasons.push("The numeric date order is ambiguous.");
  }
  if (needsVerification.includes("deadline_multiple_equal_candidates")) {
    score -= 0.22;
    reasons.push("Several deadline candidates have similar evidence strength.");
  }
  if (senderTrust.mismatch) {
    score -= 0.15;
    reasons.push("The claimed official identity conflicts with the sender domain.");
  }
  if (deadline && !action.detected && !anyMatch(body, PAYMENT_PATTERNS) && !anyMatch(body, REPLY_PATTERNS)) {
    score -= 0.1;
    reasons.push("A deadline was detected without a matching action, payment or reply request.");
  }
  if (amounts.length > 3) {
    score -= 0.05;
    reasons.push("Multiple amounts make the financial interpretation less certain.");
  }
  if (languageDetection && languageDetection.reliable === false) {
    score -= 0.05;
    reasons.push("Language detection is not marked reliable.");
  }

  score = Number(clamp(score, 0.15, 0.95).toFixed(2));
  const label = score >= 0.8 ? "High" : score >= 0.58 ? "Medium" : "Low";
  if (!reasons.length) reasons.push("No material internal contradiction was detected by the local rules.");
  return { score, label, reasons: unique(reasons) };
}

function findEvidenceSentence(text, patternGroups) {
  for (const sentence of splitSentences(text)) {
    for (const patterns of patternGroups) {
      if (anyMatch(sentence, patterns)) return shorten(sentence, 300);
    }
  }
  return "";
}

// Typed administrative findings: the machine-readable statement of WHAT each
// date and each financial signal means. Every finding carries evidence taken
// verbatim from the source text; nothing here is generated prose.
function buildTypedFindings({ expressions, deadline, financialContext, paymentDetected, paymentActionRequired, amounts, text }) {
  const findings = [];

  for (const expression of expressions) {
    if (!expression || expression.role === TEMPORAL_ROLES.NONE) continue;
    findings.push({
      type: expression.role,
      temporalRole: expression.temporalRole,
      date: expression.date || null,
      dateRaw: expression.raw,
      dateAlternatives: expression.ambiguous ? [...(expression.alternatives || [])] : [],
      actionRequired: Boolean(expression.roleActionRequired),
      strength: Number(expression.roleStrength || 0),
      evidence: expression.clause,
      evidenceMarker: expression.roleEvidence,
      evidenceKind: expression.roleEvidenceKind,
      needsVerification: Boolean(expression.roleNeedsVerification),
      source: expression.source,
      index: expression.index
    });
  }

  if (paymentDetected) {
    const evidence = findEvidenceSentence(text, [
      PAYMENT_OBLIGATION_PATTERNS, COMPLETED_PAYMENT_PATTERNS, PRICE_CHANGE_PATTERNS,
      PAYMENT_ACTION_PATTERNS, PAYMENT_PATTERNS
    ]);
    // The financial effect vocabulary is owned by classifyFinancialContext and is
    // reused verbatim here; the typed finding never re-derives it more coarsely.
    const effect = financialContext.completed ? "payment_received"
      : financialContext.priceChange ? "price_change"
        : financialContext.obligation ? "payment_due"
          : "payment_unclassified";
    findings.push({
      type: "payment",
      temporalRole: effect,
      // A payment finding carries a date only when the resolved deadline is an
      // actual due-by deadline, never when it is a cancellation window.
      date: deadline && deadline.role === TEMPORAL_ROLES.DEADLINE ? deadline.date : null,
      dateRaw: deadline && deadline.role === TEMPORAL_ROLES.DEADLINE ? deadline.raw : "",
      dateAlternatives: [],
      actionRequired: Boolean(paymentActionRequired),
      amount: amounts.length ? { currency: amounts[0].currency, value: amounts[0].value, raw: amounts[0].raw } : null,
      strength: financialContext.obligation || financialContext.completed || financialContext.priceChange ? 0.92 : 0.75,
      evidence,
      evidenceMarker: "",
      evidenceKind: "financial_context",
      needsVerification: effect === "payment_unclassified",
      source: "financial-context",
      index: Number.MAX_SAFE_INTEGER
    });
  }

  const seen = new Set();
  return findings
    .sort((a, b) => a.index - b.index)
    .filter((finding) => {
      const key = `${finding.type}:${finding.date || finding.dateRaw || "none"}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20)
    .map(({ index: _index, ...finding }) => finding);
}

export function analyzeMessage(input) {
  const subject = normalizeText(input.subject);
  const body = normalizeText(input.body);
  const sender = normalizeText(input.sender);
  const language = normalizeText(input.language || "und").toLowerCase();
  const languageDetection = input.languageDetection || null;
  const headers = input.headers || {};
  const attachments = Array.isArray(input.attachments) ? input.attachments : [];
  const referenceDate = input.referenceDate instanceof Date && !Number.isNaN(input.referenceDate.valueOf())
    ? input.referenceDate
    : new Date();

  const currentDate = input.currentDate instanceof Date && !Number.isNaN(input.currentDate.valueOf())
    ? input.currentDate
    : referenceDate;
  const attachmentNames = attachments.map((attachment) => String(attachment?.name || "")).filter(Boolean).join("\n");
  const combinedText = `${subject}\n${body}\n${attachmentNames}`;
  const commercial = Boolean(getHeaderText(headers, "list-unsubscribe")) || anyMatch(combinedText, COMMERCIAL_PATTERNS);
  const action = gateCommercialAction(detectAction(combinedText), combinedText, commercial);
  let replyExpected = detectReplyExpected(combinedText, { commercial });
  const deadlineResult = extractDeadline(combinedText, referenceDate, language, currentDate);
  const deadline = deadlineResult.deadline;
  const deadlineCandidates = deadlineResult.candidates;
  const needsVerification = [...deadlineResult.needsVerification];
  // Only raise the generic "deadline not selected" state when no specific reason already explains it.
  const SPECIFIC_DEADLINE_STATES = ["relative_deadline_anchor", "deadline_ambiguous_numeric_date", "deadline_multiple_equal_candidates"];
  if (deadlineResult.needsVerification.length && !deadlineResult.needsVerification.some((code) => SPECIFIC_DEADLINE_STATES.includes(code))) {
    needsVerification.push("deadline");
  }

  const amounts = extractAmounts(combinedText);
  const financialContext = classifyFinancialContext(combinedText, amounts, commercial);
  const paymentDetected = financialContext.paymentDetected;
  const paymentActionRequired = financialContext.actionRequired;
  const trustedAuthservIds = Array.isArray(input.trustedAuthservIds) ? input.trustedAuthservIds : [];
  const userAllowlistedDomains = Array.isArray(input.userAllowlistedDomains) ? input.userAllowlistedDomains : [];
  const userBlockedDomains = Array.isArray(input.userBlockedDomains) ? input.userBlockedDomains : [];
  const senderTrust = getSenderTrust(sender, combinedText, headers, trustedAuthservIds, userAllowlistedDomains, userBlockedDomains);
  const official = senderTrust.verifiedOfficial;
  const personal = senderTrust.freeMailDomain && !commercial && !senderTrust.officialClaim;
  const links = Array.isArray(input.links) ? input.links : [];
  const risk = buildRisk({ text: combinedText, attachments, paymentDetected: paymentActionRequired, senderTrust, links, commercial });
  if (senderTrust.authentication?.conflict) needsVerification.push("sender_authentication_conflict");
  if (senderTrust.authentication?.trustedFailure) needsVerification.push("sender_authentication_failed");
  if (senderTrust.authentication?.replyTo?.alignment === "different" && (senderTrust.officialClaim || paymentActionRequired)) {
    needsVerification.push("reply_to_domain_mismatch");
  }
  if (risk.hardBlock === true) replyExpected = false;
  const suspicious = risk.score >= 30;

  // v0.8.0: a date that only marks how long an OPTIONAL right stays open is not a
  // deadline at the Action Center level. The date is kept (deadline slot, typed
  // finding and obligation.optionalDeadline), but the top-level Deadline category
  // is reserved for obligations, so an option never reads as a duty.
  // A deadline the user set by hand is always an obligation, whatever role the
  // analyser had originally assigned to that date.
  const optionalCancellationWindow = (item) => Boolean(item)
    && item.manuallySet !== true
    && item.role === TEMPORAL_ROLES.CANCELLATION_WINDOW
    && item.actionRequired !== true
    && item.roleActionRequired !== true;
  const deadlineBearing = (Boolean(deadline) && !optionalCancellationWindow(deadline))
    || deadlineCandidates.some((candidate) => !optionalCancellationWindow(candidate));

  const categories = [];
  if (action.detected || action.mandatory) categories.push("Action Required");
  if (deadlineBearing) categories.push("Deadline");
  if (paymentDetected) categories.push("Payment");
  if (official) categories.push("Official");
  if (replyExpected) categories.push("Reply Expected");
  if (commercial) categories.push("Commercial");
  if (suspicious) categories.push("Suspicious");
  if (personal) categories.push("Personal");
  if (!action.detected && !deadlineBearing && !paymentDetected && !replyExpected && !suspicious) categories.push("Information Only");
  if (!categories.length) categories.push("Unknown");

  // Structural floor (v0.1.15 audit P1): a credential/personal-details request can
  // never present as harmless. Regardless of the numeric score it always carries the
  // Suspicious category, never Information Only, and never priority No Action.
  if (risk.credentialRequest) {
    if (!categories.includes("Suspicious")) categories.push("Suspicious");
    const informationOnlyIndex = categories.indexOf("Information Only");
    if (informationOnlyIndex >= 0) categories.splice(informationOnlyIndex, 1);
  }

  categories.sort((a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b));
  const requiredAction = risk.hardBlock === true
    ? localizedFallback(language, risk.blockCode === "USER_BLOCKED_DOMAIN" ? "blockedDomain" : "blocked")
    : extractRequiredAction(combinedText, action, replyExpected, paymentActionRequired);
  if (risk.hardBlock === true) {
    const replyIndex = categories.indexOf("Reply Expected");
    if (replyIndex >= 0) categories.splice(replyIndex, 1);
    if (!categories.includes("Suspicious")) categories.push("Suspicious");
    categories.sort((a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b));
  }
  const semantic = analyzeSemanticAxes({
    senderTrust,
    text: combinedText,
    commercial,
    personal,
    action,
    replyExpected,
    paymentDetected: paymentActionRequired,
    deadline,
    risk
  });

  const priorityResult = determinePriority({ deadline, needsVerification, action, replyExpected, paymentDetected: paymentActionRequired, senderTrust, risk });
  if (risk.credentialRequest && ["No Action", "Low"].includes(priorityResult.priority)) {
    priorityResult.priority = "Medium";
    priorityResult.reasons.push("A credential or personal-details request always requires review.");
  }
  const importantAttachments = attachments
    .filter((attachment) => /\.(pdf|docx?|xlsx?|odt|ods|zip|rar|7z|p7m|eml)$/iu.test(attachment.name || "") || attachment.size > 250000)
    .slice(0, 10)
    .map((attachment) => ({ name: attachment.name, contentType: attachment.contentType, size: attachment.size }));

  const reliability = calculateReliability({
    body, languageDetection, action, deadline, deadlineCandidates, amounts, senderTrust, needsVerification
  });

  const typedFindings = buildTypedFindings({
    expressions: deadlineResult.expressions || [],
    deadline,
    financialContext,
    paymentDetected,
    paymentActionRequired,
    amounts,
    text: combinedText
  });

  const result = {
    summary: "",
    sender,
    requiredAction: requiredAction || localizedFallback(language, "noAction"),
    action: {
      detected: action.detected,
      mandatory: action.mandatory,
      strength: action.strength,
      evidence: action.evidence
    },
    actionEvidence: action.evidence,
    mandatoryAction: action.mandatory,
    deadline,
    estimatedDeadline: deadlineResult.estimatedDeadline || null,
    deadlineCandidates,
    // v0.8.0 typed administrative findings. Additive and backward compatible:
    // the fields above keep their existing meaning, and records written before
    // 0.8.0 simply carry an empty list.
    typedFindings,
    needsVerification: unique(needsVerification),
    amounts,
    financialChange: paymentDetected,
    financialEffect: financialContext.completed ? "payment_received"
      : financialContext.priceChange ? "price_change"
        : financialContext.obligation ? "payment_due"
          : paymentDetected ? "unknown" : "none",
    replyExpected,
    importantAttachments,
    attachmentCount: attachments.length,
    risk,
    senderTrust,
    senderIdentity: {
      displayName: String(sender || "").replace(/<[^>]+>/gu, "").trim() || null,
      address: parseEmailAddress(sender) || null,
      domain: senderTrust.domain || null
    },
    relationshipClass: semantic.relationship.class,
    claimedRelationshipClass: semantic.relationship.claimedClass || null,
    relationship: semantic.relationship,
    documentType: semantic.document.type,
    documentClassification: semantic.document,
    obligation: {
      actionRequired: Boolean(action.detected || action.mandatory),
      currentlyActionable: deadline?.temporalState === "historical_expired"
        ? false
        : Boolean(action.detected || action.mandatory || replyExpected || paymentActionRequired || deadline),
      replyExpected: Boolean(replyExpected),
      paymentRequired: Boolean(paymentActionRequired),
      // A cancellation window is the last date for an OPTIONAL act. It is kept as
      // a distinct field so it is never read as an obligation deadline.
      deadline: deadline && deadline.role !== TEMPORAL_ROLES.CANCELLATION_WINDOW ? deadline.date : null,
      optionalDeadline: deadline && deadline.role === TEMPORAL_ROLES.CANCELLATION_WINDOW ? deadline.date : null,
      financialConsequence: financialContext.obligation || financialContext.priceChange,
      needsVerification: unique(needsVerification)
    },
    retention: semantic.retention,
    civicMapReference: semantic.civicMap,
    contentHash: input.contentHash || null,
    recommendedNextStep: "",
    confidence: reliability.score,
    confidenceKind: "analysis-reliability",
    confidenceLabel: reliability.label,
    confidenceReasons: reliability.reasons,
    language,
    categories,
    priority: priorityResult.priority,
    priorityReasons: priorityResult.reasons,
    status: "New",
    analysisVersion: "local-rules-0.8.0",
    analysisMode: "local",
    markedIncorrect: false,
    manualEdited: false
  };

  result.summary = buildSummary({
    language, sender, requiredAction: result.requiredAction, deadline,
    estimatedDeadline: result.estimatedDeadline, deadlineCandidates,
    amounts, priority: result.priority, risk
  });
  result.recommendedNextStep = buildRecommendedNextStep({
    language, replyExpected, paymentDetected: paymentActionRequired, risk, action,
    needsVerification: result.needsVerification, deadline
  });
  return result;
}

function listAuthservIds(headers) {
  return listAuthservIdsFromAuth(headers);
}

// Cheap sender-side signals for the junk admission gate. This deliberately does NOT run
// body analysis, deadline extraction or link inspection: the gate must be evaluable before
// a message is analysed or stored.
export function evaluateSenderAdmissionSignals({
  sender = "",
  headers = {},
  trustedAuthservIds = [],
  userBlockedDomains = []
} = {}) {
  const trust = getSenderTrust(sender, "", headers, trustedAuthservIds, [], userBlockedDomains);
  return {
    domain: trust.domain || "",
    verifiedIdentity: trust.verifiedIdentity === true,
    identityToken: trust.institutionIdentity?.token || null,
    authenticationVerdict: trust.authenticationVerdict,
    userBlockedDomain: trust.userBlockedDomain === true
  };
}

export { CATEGORY_ORDER, PRIORITIES, listAuthservIds };
export { FINDING_TYPES, TEMPORAL_ROLES, TEMPORAL_ROLE_LABELS } from "./temporal-context.mjs";
