// A stand-in for the Thunderbird messenger API, so the Action Center can be rendered and
// looked at outside Thunderbird. It answers the message types app.js sends and returns
// synthetic records.
//
// Every sender, address, amount and finding below is invented. No real mail, no real
// organisation, no real personal data goes into a development fixture.
//
// Usage with Playwright:
//   await page.addInitScript({ path: "tests/ui-harness/messenger-stub.mjs" });
//   await page.goto("http://localhost:PORT/action-center/index.r005.html");

const CATEGORIES = [
  "Deadline", "Payment", "Contract", "Government", "Healthcare", "Insurance",
  "Utilities", "Banking", "Subscription", "Information"
];
const PRIORITIES = ["Critical", "High", "Medium", "Low", "None"];
const STATUSES = ["New", "In progress", "Waiting", "Completed", "Dismissed", "Archived"];
const RELATIONSHIPS = [
  "Customer", "Tenant", "Employee", "Patient", "Insured", "Taxpayer",
  "Resident", "Subscriber", "Applicant", "Beneficiary", "Member", "Client",
  "Student", "Claimant", "Guarantor", "Unknown"
];
const DOCUMENT_TYPES = [
  "Invoice", "Reminder", "Contract", "Policy", "Statement", "Decision",
  "Notification", "Confirmation", "Summons", "Assessment", "Certificate",
  "Receipt", "Correspondence", "Unknown"
];
const RETENTION = ["Permanent", "Seven years", "Two years", "One year", "No retention"];

const record = (over) => ({
  id: crypto.randomUUID(),
  accountId: "account-1",
  folderId: "inbox-1",
  sender: "Onbekende afzender",
  senderAddress: "post@example.invalid",
  subject: "(No subject)",
  summary: "",
  requiredAction: "",
  priority: "Medium",
  status: "New",
  categories: [],
  receivedAt: "2026-09-10T08:14:00.000Z",
  analyzedAt: "2026-09-10T08:14:03.000Z",
  analysisMode: "preview",
  language: "nl",
  available: true,
  confidence: 0.82,
  ...over
});

const RECORDS = [
  record({
    sender: "Gemeente Nieuwveen",
    senderAddress: "geenantwoord@nieuwveen.example.invalid",
    subject: "Besluit aanvraag parkeervergunning",
    summary: "The application for a resident parking permit was granted for one vehicle.",
    requiredAction: "Confirm the licence plate before 30 September or the permit lapses.",
    priority: "High",
    status: "New",
    categories: ["Deadline", "Government"],
    deadline: { date: "2026-09-30", raw: "voor 30 september", marker: "voor", overdue: false, evidenceStrength: 0.9 },
    deadlineSource: "machine",
    receivedAt: "2026-09-11T07:02:00.000Z",
    typedFindings: [
      { id: "deadline:2026-09-30", type: "deadline", temporalRole: "due_by", date: "2026-09-30",
        dateRaw: "voor 30 september", actionRequired: true, needsVerification: false,
        evidence: "Bevestig het kenteken voor 30 september.", evidenceMarker: "voor", dateAlternatives: [] },
      { id: "appointment:2026-10-08", type: "appointment", temporalRole: "appointment_date", date: "2026-10-08",
        dateRaw: "8 oktober", actionRequired: false, needsVerification: false,
        evidence: "U kunt de vergunning ophalen op 8 oktober.", evidenceMarker: "op", dateAlternatives: [] }
    ]
  }),
  record({
    sender: "Waterbedrijf Kade",
    senderAddress: "facturen@kade-water.example.invalid",
    subject: "Herinnering openstaand bedrag",
    summary: "A reminder for an unpaid water bill of EUR 61,40.",
    requiredAction: "Pay EUR 61,40. The stated due date has passed.",
    priority: "Critical",
    status: "In progress",
    categories: ["Payment", "Utilities"],
    deadline: { date: "2026-09-05", raw: "uiterlijk 5 september", marker: "uiterlijk", overdue: true, evidenceStrength: 0.95 },
    deadlineSource: "machine",
    receivedAt: "2026-09-09T16:41:00.000Z",
    typedFindings: [
      { id: "payment:2026-09-05", type: "payment", temporalRole: "payment_due", date: "2026-09-05",
        dateRaw: "uiterlijk 5 september", actionRequired: true, needsVerification: false,
        evidence: "Betaal uiterlijk 5 september het openstaande bedrag.", evidenceMarker: "uiterlijk", dateAlternatives: [] }
    ]
  }),
  record({
    sender: "Zorgpolis Westland",
    senderAddress: "service@zorgpolis-westland.example.invalid",
    subject: "Wijziging in uw polisvoorwaarden per 1 januari",
    summary: "The policy conditions change at the start of the year; the premium is unchanged.",
    requiredAction: "No action is required. The change takes effect automatically.",
    priority: "Low",
    status: "New",
    categories: ["Insurance", "Information"],
    receivedAt: "2026-09-08T11:20:00.000Z",
    needsVerification: ["deadline"],
    confidence: 0.44,
    typedFindings: [
      { id: "information:2027-01-01", type: "information", temporalRole: "effective_or_informational_date",
        date: "2027-01-01", dateRaw: "per 1 januari", actionRequired: false, needsVerification: false,
        evidence: "De voorwaarden wijzigen per 1 januari.", evidenceMarker: "per", dateAlternatives: [] },
      { id: "deadline:2026-12-31", type: "deadline", temporalRole: "due_by", date: "2026-12-31",
        dateRaw: "31-12", actionRequired: true, needsVerification: true,
        evidence: "Reageer voor 31-12 als u niet akkoord gaat.", evidenceMarker: "voor",
        dateAlternatives: ["2026-12-31", "2026-03-12"] }
    ]
  }),
  record({
    sender: "Stroomnet Zuid",
    senderAddress: "noreply@stroomnet-zuid.example.invalid",
    subject: "Jaarafrekening 2025–2026",
    summary: "The annual settlement shows a credit of EUR 118,05, paid out within ten working days.",
    requiredAction: "Check the meter readings on page two against your own.",
    priority: "Medium",
    status: "Waiting",
    categories: ["Utilities", "Payment"],
    receivedAt: "2026-09-06T09:05:00.000Z",
    admittedFromJunk: true,
    markedIncorrect: true,
    junkAdmission: {
      admitted: true,
      path: "proven_history",
      identity: null,
      evaluatedAt: "2026-09-06T09:05:02.000Z",
      reasons: ["The sender domain has authenticated non-junk history in this mailbox."],
      conditions: [
        { id: "message-authenticated", label: "This message passes authentication", result: "pass" },
        { id: "no-blocked-history", label: "No blocked record exists for the domain", result: "pass" },
        { id: "prior-records", label: "At least 2 prior non-junk records", result: "pass" },
        { id: "prior-authenticated", label: "At least one prior non-junk record passed authentication", result: "pass" }
      ],
      evidenceProvenance: {
        source: "local non-junk history for this sender domain",
        qualifyingRecords: 4,
        authenticatedRecords: 2
      },
      upstreamMarker: {
        observedAs: "junk",
        by: "the mail provider or Thunderbird",
        note: "An observation about where the message was filed. It is never evidence of trust."
      }
    }
  }),
  record({
    sender: "Huurdersbureau Meander",
    senderAddress: "contact@meander-huur.example.invalid",
    subject: "Verlenging huurovereenkomst",
    summary: "The tenancy is extended by twelve months on the existing terms.",
    requiredAction: "Return the signed extension before 20 October.",
    priority: "High",
    status: "New",
    categories: ["Contract", "Deadline"],
    deadline: { date: "2026-10-20", manuallySet: true, overdue: false },
    deadlineSource: "you",
    receivedAt: "2026-09-04T13:55:00.000Z",
    typedFindings: [
      { id: "deadline:2026-10-20", type: "deadline", temporalRole: "due_by", date: "2026-10-20",
        dateRaw: "voor 20 oktober", actionRequired: true, needsVerification: false,
        evidence: "Retourneer de getekende verlenging voor 20 oktober.", evidenceMarker: "voor", dateAlternatives: [] },
      { id: "cancellation_window:2026-11-30", type: "cancellation_window", temporalRole: "cancellation_deadline",
        date: "2026-11-30", dateRaw: "tot 30 november", actionRequired: false, needsVerification: false,
        evidence: "U kunt tot 30 november opzeggen als u dat wenst.", evidenceMarker: "tot", dateAlternatives: [] }
    ]
  }),
  record({
    sender: "Bibliotheek Randstreek",
    senderAddress: "leden@bibliotheek-randstreek.example.invalid",
    subject: "Uw lidmaatschap is verlengd",
    summary: "The membership renewed automatically for another year.",
    requiredAction: "No action is required.",
    priority: "None",
    status: "Completed",
    categories: ["Subscription"],
    receivedAt: "2026-08-30T10:12:00.000Z",
    typedFindings: [
      { id: "renewal:2026-08-28", type: "renewal", temporalRole: "renewal_effective_date", date: "2026-08-28",
        dateRaw: "28 augustus", actionRequired: false, needsVerification: false,
        evidence: "Uw lidmaatschap is per 28 augustus verlengd.", evidenceMarker: "per", dateAlternatives: [] }
    ]
  })
];

// The two lists the person owns. setDomainDisposition mutates them here exactly as the
// background would, so the harness can prove Trust updates without a reload.
const USER_ALLOW = new Set(["nieuwveen.example.invalid"]);
const USER_BLOCK = new Set();
const OBSERVED = ["kade-water.example.invalid", "stroomnet-zuid.example.invalid"];
const PHISHING_ONLY = ["oglix.example.invalid"];

function identitySnapshot() {
  return {
    generatedAt: new Date().toISOString(),
    trustedAuthservIds: [{ id: "mx.example.invalid", provenance: "user" }],
    allowlistedDomains: [
      ...[...USER_ALLOW].map((domain) => ({ domain, provenance: "user" })),
      ...OBSERVED.filter((d) => !USER_ALLOW.has(d)).map((domain) => ({ domain, provenance: "observed" }))
    ],
    blockedDomains: [
      ...[...USER_BLOCK].map((domain) => ({ domain, provenance: "user" })),
      ...PHISHING_ONLY.filter((d) => !USER_BLOCK.has(d)).map((domain) => ({ domain, provenance: "built-in" }))
    ],
    protectedIdentities: [
      { id: "nieuwveen", label: "Gemeente Nieuwveen", domains: ["nieuwveen.example.invalid"], provenance: "built-in" }
    ]
  };
}

const STATE = {
  ok: true,
  records: RECORDS,
  settings: {
    autoTag: false,
    desktopBridge: true,
    documentArchive: true,
    analyzeJunk: false,
    retentionDays: 365,
    maxRecords: 2000,
    diagnostics: false,
    trustedAuthserv: ""
  },
  accountLabels: { "account-1": "post@example.invalid" },
  categories: CATEGORIES,
  priorities: PRIORITIES,
  statuses: STATUSES,
  relationshipClasses: RELATIONSHIPS,
  documentTypes: DOCUMENT_TYPES,
  retentionClasses: RETENTION,
  metadata: { storagePressure: false, recordCount: RECORDS.length },
  listenerState: { newMail: true, moved: true, deleted: true, menus: true },
  historicalScan: null,
  archiveExisting: null,
  version: "0.8.2"
};

const ANSWERS = {
  getState: () => STATE,
  getHistoricalScanState: () => ({ ok: true, scan: null }),
  getArchiveExistingState: () => ({ ok: true, archive: null }),
  getHistoricalScanScope: () => ({
    ok: true,
    scan: null,
    accounts: [{
      id: "account-1",
      name: "post@example.invalid",
      folders: [
        { id: "inbox-1", path: "/Inbox", messageCount: 412, specialUse: ["inbox"] },
        { id: "arch-1", path: "/Archive/2025", messageCount: 1180, specialUse: [] },
        { id: "arch-2", path: "/Archive/2024", messageCount: 974, specialUse: [] },
        { id: "junk-1", path: "/Junk", messageCount: 96, specialUse: ["junk"] },
        { id: "sent-1", path: "/Sent", messageCount: 305, specialUse: ["sent"] },
        { id: "trash-1", path: "/Trash", messageCount: 41, specialUse: ["trash"] }
      ]
    }]
  }),
  getArchiveExistingScope: () => ({
    ok: true,
    archive: null,
    scope: { accountCount: 1, folderCount: 3, messageCount: 1592 }
  }),
  runSelfCheck: () => ({ ok: true, report: REPORT }),
  getIdentityState: () => ({ ok: true, identity: identitySnapshot() }),
  getJunkAdmissionState: () => ({
    ok: true,
    junk: {
      generatedAt: new Date().toISOString(),
      admitted: RECORDS
        .filter((entry) => entry.junkAdmission?.admitted === true)
        .map((entry) => ({
          recordId: entry.id,
          identityKey: entry.identityKey || null,
          headerMessageId: entry.headerMessageId || null,
          sender: entry.sender,
          subject: entry.subject,
          receivedAt: entry.receivedAt,
          folderName: "Junk",
          admission: entry.junkAdmission
        })),
      notAdmitted: {
        messageCount: 12,
        note: "Not analysed is not a spam verdict. These messages were left alone and no judgement about them is stored."
      },
      admittedWithoutReasoning: 0,
      userOverrides: {
        supported: false,
        note: "The runtime keeps no per-message override of the gate."
      }
    }
  }),
  setDomainDisposition: (message) => {
    const domain = String(message?.domain || "").toLowerCase();
    USER_ALLOW.delete(domain);
    USER_BLOCK.delete(domain);
    if (message?.disposition === "allow") USER_ALLOW.add(domain);
    if (message?.disposition === "block") USER_BLOCK.add(domain);
    return { ok: true, domain, disposition: message?.disposition };
  }
};

const REPORT = {
  overallStatus: "warn",
  generatedAt: "2026-09-12T20:40:00.000Z",
  manifest: { version: "0.8.2", manifestVersion: 3 },
  browserInfo: { name: "Thunderbird", version: "141.0" },
  platformInfo: { os: "win", arch: "x86-64" },
  compatibility: { runtimeLine: "Thunderbird 141.0 · minimum 140.0 · supported" },
  provider: { id: "local-rules-0.8.0", label: "Local rules", networkAccess: false },
  listenerState: { newMail: true, moved: true, deleted: false },
  acceptance: {
    status: "running",
    resetAt: "2026-09-12T06:00:00.000Z",
    completedGateCount: 6,
    totalGateCount: 8
  },
  authservCandidates: [
    { id: "mx.example.invalid", count: 214 },
    { id: "mail.example.invalid", count: 37 }
  ],
  checks: [
    { id: "storage", label: "Local storage is writable", status: "pass", detail: "Schema v6, 6 records." },
    { id: "listeners", label: "Message listeners are registered", status: "warn", detail: "The deleted-message listener is not registered." },
    { id: "bridge", label: "Native Messaging host answers", status: "pass", detail: "nl.civion.desktop, contract v2." },
    { id: "archive", label: "Document archive root is reachable", status: "fail", detail: "Drive F: is not available; documents stay pending." },
    { id: "network", label: "No network permission is requested", status: "pass", detail: "connect-src 'none'." }
  ],
  accounts: [
    { id: "account-1", name: "post@example.invalid", type: "imap", folderCount: 12, eligibleFolders: 9, events: 214, messages: 198, observed: true }
  ],
  operational: {
    newMailEventCount: 214, messagesSeen: 231, messagesHandled: 198, analysisFailures: 2,
    movedEventCount: 11, deletedEventCount: 4, backgroundActivationCount: 3,
    nonInboxEligibleEventCount: 7, junkExcludedEventCount: 12, junkAnalyzedEventCount: 1
  },
  storage: { recordCount: 6, storagePressure: false, migration: { status: "clean" } },
  recovery: { entryCount: 0, status: "clean" }
};

globalThis.messenger = {
  runtime: {
    sendMessage: async (message) => {
      const answer = ANSWERS[message?.type];
      if (answer) return answer(message);
      return { ok: true };
    },
    getManifest: () => ({ version: "0.8.2" }),
    onMessage: { addListener() {}, removeListener() {} }
  },
  storage: {
    local: {
      async get() { return {}; },
      async set() {}
    },
    onChanged: { addListener() {}, removeListener() {} }
  }
};
