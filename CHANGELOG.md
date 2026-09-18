# CIVION Mail — CHANGELOG

## v0.8.4 — 2026-09-18

### Settings shows what is stored, the transport says why it failed, and the add-on is called Insist

- **The user-facing name of the Thunderbird add-on is now Insist** (Insist for
  Thunderbird). The extension ID, the native host `nl.civion.desktop`, the protocol
  and storage identifiers and the existing mailbox tag labels are unchanged; the
  artifact is `Civion-Insist-0.8.4.xpi`.
- **Settings shows the stored values on every path.** The form was filled only by
  the one button that used to open the dialog; reached through the rail, a shortcut,
  or on the way back after Save, it showed the HTML defaults — for the Desktop
  bridge and the PDF archive the opposite of the stored ones. One projection
  (`views-settings.mjs`) now runs after load, on every arrival and after Save has
  read the stored values back. No `checked=` was added to the markup and no default
  was restated. `T164`–`T174` execute it, including the clean-store case.
- **About**, a subview of Settings: the product name, the platform line, the version
  read from the manifest, the copyright line, the proprietary statement and a link
  to the packaged `LICENSE`, opened locally.
- **`LICENSE`** at the repository root: the Civion proprietary notice, verbatim from
  the Product Licensing Canon r002. `README.md` and `README_BG.md` state the position.
- **A disconnect says why.** `port.error` is read and classified into `HOST_NOT_FOUND`,
  `HOST_DISCONNECTED`, `DISCONNECT_NO_REASON` or `UNCLASSIFIED`, matched against the
  platform's own messages; the platform text is not persisted. `HOST_NOT_FOUND`
  cannot distinguish a missing registration from one that points at another body —
  the platform gives one message for both.
- **The typed failure code survives.** `MAIL_RUNTIME_TIMEOUT`, `MAIL_RUNTIME_DISCONNECTED`,
  `MAIL_RUNTIME_PROTOCOL_ERROR` and the host's own refusal code reach the bridge
  metrics instead of being collapsed into `*_NATIVE_FAILED`; the fallback words
  remain for an error that says nothing. The `bridge_metrics` object in the status
  packet keeps exactly its five fields.
- **The startup probe is recorded**: attempt, outcome, last successful contact and
  the classified cause, in `metadata.desktopBridge`. No second probe was added.
- **Self Check has a separate transport check** with four states — `NEVER_ATTEMPTED`,
  `INDETERMINATE`, `FAILED`, `OK` — beside the untouched Thunderbird runtime check.
  An unknown state is a warning, never a pass.
- **System → Bridge**, a fourth tab: last attempt, last successful contact, last
  failure with its cause, the counters, and the state as a labelled chip (green for
  OK, red for an observed failure, ochre for the two unknown states). It describes
  the add-on's side of the transport and nothing about the Mail domain or Desktop.
- **`action-center/index.html` and `action-center/styles.css` are removed.** The
  pre-r005 wrapper had stayed in the package with no reference to it.

Analysis rules are unchanged and stay `local-rules-0.8.0`. The ingestion contract,
the native contract (version 2), the permissions, the CSP and the storage schema
are unchanged. 0.8.3 was the 0.8.2 body with the manifest, the background and the
popup opening the r005 shell, and is the baseline this release is built on.

## v0.8.2 — 2026-09-12

### One permission fewer, and a diagnostics panel that finishes rendering

- **`downloads` is gone from the manifest.** Its only consumer,
  `downloadBridgePayload`, had no call sites at all: the transport has been
  `native_messaging_durable_spool` since v0.6.2, and the Action Center's exports
  use an anchor download, which needs no permission. The extension was asking for
  a file-writing permission it never exercised. Removing it makes the document
  archive write boundary a property of the package rather than an intention —
  the add-on recognises and prepares, the Desktop layer validates and writes.
  The dead function and `DESKTOP_BRIDGE_SUBDIR` go with it.
- **Diagnostics no longer breaks halfway.** `elements.diagnosticsAuthserv` was
  read in three places and cached in none, so `clearNode(undefined)` threw inside
  `renderDiagnostics`. Everything below the observed authserv-id list — the checks
  table, the account coverage table and the operational counters — never rendered.
  The id is now cached, and `T120` fails if any element is ever used without being
  cached again.
- **The permissions section of `README_BG.md` is correct again.** It still claimed
  that `downloads` and native messaging were not requested; both had been in the
  manifest since v0.6.0. `PRIVACY.md` now says plainly that the Downloads spool is
  no longer written.

Analysis rules are unchanged and stay `local-rules-0.8.0`. The ingestion contract,
the native contract and the storage schema are unchanged. `T116` pins the new
permission set, so a future addition has to be argued for rather than slipping in.

## v0.8.1 — 2026-09-07

### The deadline candidate Desktop is willing to accept

`CivionMailIngestion/0.2` fixes the fields of a deadline candidate, and the
Desktop spool refuses a package that carries any other one. Mail was sending
three more — `temporal_state`, `currently_actionable` and `source_age_days` —
so every package containing a deadline was rejected on arrival, before a person
could review it. Nothing on either side read those three fields; they were
written, refused and lost, and the failure looked like an ingest problem rather
than a contract one.

- **Mail speaks the contract it has.** The three undeclared fields are gone. The
  temporal reading that mattered is already carried by `deadline_type`, which
  separates `Historical` from `Explicit` and `Inferred`, so nothing legible is
  lost. Widening the contract to admit more temporal metadata stays available as
  a deliberate decision; it is not one to take from the side that emits.
- **The boundary is tested end to end.** Every earlier test here built the
  envelope by hand in Python, so the two sides could drift without anything
  noticing — and had. `tests/test_mail_bridge_contract.py` now runs the real
  analyser and the real envelope builder, patches the package exactly as
  `background.js` does before native messaging, and feeds the result to the real
  `MailSpoolService`: the package is processed, the deadline arrives as a
  candidate `pending_review`, and re-adding one undeclared field is still
  refused. `T117`–`T119` check the emitted shape in the extension suite.

This is a packaging and bridge-compatibility release. Analysis rules are
unchanged and stay `local-rules-0.8.0`; the ingestion contract stays
`CivionMailIngestion/0.2`; storage schema stays v6; permissions, CSP, transport,
the native contract version and the runtime lifecycle are untouched. The version
moves because the packaged body changed and `0.8.0` already exists as a distinct
artifact — two bodies under one version is the property a version number exists
to prevent.

## v0.8.0 — 2026-09-07

### A date is not a deadline

Until now, a date that the parser could read and that happened to be preceded by
a preposition became a deadline candidate. "Your appointment is on 5 March",
"valid until 31 December" and "pay by 31 January" were separated only by which
words happened to sit in front of the date, and a message-wide action could push
any of them into the Deadline category. This build makes the administrative role
of a date something the analyser decides and states, rather than something a
consumer has to infer.

- **Temporal role classification (`modules/temporal-context.mjs`).** Every parsed
  date expression is classified into one of `deadline`, `cancellation_window`,
  `appointment`, `delivery`, `renewal`, `information` — or into no operational
  role at all. The precedence is fixed and deterministic: explicit due-by marker
  or a mandatory action with a due-by marker, then optional cancellation language
  with an end-date marker, then appointment, delivery, renewal-effective and
  informational context, then entitlement periods, then nothing.
- **Deadline context must be proven locally.** Evidence is read from the clause
  the date stands in, and is widened to the sentence only when that sentence
  carries no competing non-deadline cue. `Your appointment is on 5 March 2027.
  Please confirm your attendance.` keeps 5 March an appointment date: the action
  in the second sentence cannot reach it.
- **Only proven roles become deadline candidates.** Appointment, delivery,
  renewal-effective and informational dates never enter `deadlineCandidates`,
  never add the `Deadline` category and never set `obligation.actionRequired`.
- **Cancellation windows are not obligations.** `You may cancel until 16 May` is
  typed `cancellation_window` with `actionRequired: false`. The date is preserved
  as the last date on which the right can be exercised, and is exposed as
  `obligation.optionalDeadline`; `obligation.deadline` stays null so no consumer
  can read a duty into it. It does **not** take the top-level `Deadline`
  category, and the summary words it as an option rather than printing it as a
  deadline, because an Action Center row that says Deadline is read as something
  owed. A deadline the person set by hand is always obligation-bearing whatever
  role the analyser had assigned. `You must submit the cancellation request by
  16 May` remains a real deadline and keeps the category.
- **Typed administrative findings (`typedFindings`).** Additive, machine-readable
  and evidence-backed: `type`, `temporalRole`, `date`, `dateRaw`,
  `actionRequired`, `strength`, `evidence` (a verbatim span of the source),
  `evidenceMarker`, `evidenceKind`, `needsVerification`, `source`. A payment
  finding reuses the existing `financialEffect` vocabulary rather than replacing
  it. The analysis provider contract now requires the field, so date semantics
  cannot be reduced to a presentation label.
- **A decimal point is no longer a sentence boundary.** `EUR 83.17 by 31 January`
  was being split into two sentences, which removed the payment instruction from
  the date's local context. Sentence detection now ignores a full stop that is
  followed by a digit.
- **Dutch imperative payment instructions.** `Betaal uiterlijk …` is now
  recognised as a payment action; only the infinitive `betalen` was covered. The
  definite Bulgarian forms `Крайният срок` / `Крайния срок` are recognised too;
  the stem changes to `крайн-`, so the indefinite pattern never matched them.
- **Cue tokens are anchored to their noun phrase.** A first draft of this work
  typed `Please consult the terms before 5 March 2027` and `check up on the
  invoice` as appointments, because a bare verb matched an appointment cue.
- **Classification is bounded.** Deciding a role runs action, payment and
  consequence detection over the clause and the sentence, so a body listing
  hundreds of dates is capped at `MAX_DATE_EXPRESSIONS`.

Storage schema remains v6 and needs no migration: `typedFindings` is additive and
records written before this build open with an empty list. Permissions,
transport, native-messaging contract, runtime lifecycle, tray behaviour and the
archive path are untouched. No network access and no cloud or model call is
introduced. Analysis rules are now `local-rules-0.8.0`, because the rules
genuinely changed.

## v0.7.1 — 2026-09-07

### The package matches its source again

v0.7.0 was packaged before the correction below was committed, so two different
bodies carried one version number: the `.xpi` in `dist\` and the add-on
installed in Thunderbird both lacked a fix the repository already had. A version
that identifies two different things cannot be reasoned about, and this build
exists to end that rather than to add anything.

- **A synchronous send failure now fails the session, not only the package that
  noticed it.** When `port.postMessage()` throws — the port is gone but
  Thunderbird has not yet delivered `onDisconnect` — the runtime rejected only
  the request in hand. Every other package outstanding on the same dead port
  went on waiting for an acknowledgement that could never arrive, until its
  two-minute timeout expired. The throw is now read as what it is: the session
  is dead, every outstanding package fails with `MAIL_RUNTIME_DISCONNECTED`,
  and the next outgoing package opens a new native session.

Nothing else changed. Analysis rules remain `local-rules-0.6.8`, storage schema
remains v6, permissions are untouched and the protocol is the same contract
version 2. This package was produced from the repository at the commit that
carries this version, and its contents match that source file for file.

## v0.7.0 — 2026-09-06 (build version; not an accepted project decision)

### Persistent CIVION Mail Runtime

The transport changes; nothing else does. No analysis, no storage schema, no permission, no network behaviour and no archive path is touched. Analysis rules remain `local-rules-0.6.8`; storage schema remains v6.

- **One connection per Thunderbird session.** `messenger.runtime.sendNativeMessage` is gone. One `connectNative` port, opened in `initialize()` together with CIVION Mail, carries every package until Thunderbird closes; the host then sees the end of its input stream and stops. `nativeMessaging` already covers it; no new permission.
- **Contract version 2.** The persistent protocol is a new contract version. Every request carries `message_id` and every acknowledgement must echo it. The Desktop host refuses a version-2 envelope without one (`NATIVE_CORRELATION_REQUIRED`) and keeps speaking version 1 for an installed CIVION Mail older than this build, so intake does not stop during the transition.
- **An unattributable acknowledgement is a protocol error.** An answer with no id, or with an id nothing is waiting for, is never attributed to whatever package happens to be outstanding: all outstanding packages fail with `MAIL_RUNTIME_PROTOCOL_ERROR` and the session is closed. The only tolerated exception is a late answer to a package that already failed on its own timeout; that is dropped and logged.
- **Lazy recovery.** If the host disconnects while Thunderbird stays open, outstanding packages fail with `MAIL_RUNTIME_DISCONNECTED`, the runtime is OFF, and the next outgoing package opens a new native session. Nothing is retried silently: the archive path records its existing retryable `pending` state, and the bridge path reports the failure as it always did.
- **Timeout.** An unacknowledged package fails after two minutes with `MAIL_RUNTIME_TIMEOUT`.
- The protocol lives in `modules/mail-runtime.mjs` so its behaviour is executed by the extension's own tests rather than asserted as text; `background.js` only wires it to Thunderbird's port.

### Provenance

- Built on the installed v0.6.11, recovered from the Thunderbird profile. The repository held v0.6.9; v0.6.10's junk-admission corrections and v0.6.11's Action Center reordering would otherwise have been discarded. v0.6.9 is frozen under `artifacts/mail-extension-0.6.9`.
- Version 0.7.0 identifies this build. Whether it becomes the accepted version, and whether contract version 2 becomes accepted canon, are owner decisions still open.

## v0.6.11 — 2026-09-05

### Action Center interface

The stylesheet had not been reorganised since v0.1.11 while the surface kept growing by appending. This release re-ranks what is already there; it adds no analysis capability and changes no record.

- **Topbar.** Historical Scan, Archive existing PDFs and Export JSON move into one `Operations` menu, each with a note stating its scope. `Archive existing PDFs` no longer sits at the same visual weight as a routine export while sweeping every folder in every account.
- **Filters.** Search, Priority and Status stay in the primary row; the remaining six move into a `More filters` drawer with a count of how many are active. Active filters now appear as removable chips, so the current narrowing is legible without reading eight selects.
- **Counters.** Active, Critical / High, Due within 3 days and New are now buttons that apply the view they describe. Counter and filter share one predicate, so a number can never disagree with the view it opens. Pressing the active counter returns to the full view.
- **Detail dialog.** The side panel is ranked in three tiers: next step, risk, verification and authentication first; supporting signals and reasons next; account, folder, recipients, timestamps, mode and language collapsed under `Message and analysis details`.
- **Columns.** A `Columns` menu toggles column visibility, persisted locally. `Categories` is hidden by default because it repeats the detail dialog and costs scan width. Sender and Subject cannot be hidden. A hidden column keeps its width and no longer claims table space.
- **Density.** A `Compact` toggle switches row and header spacing for scanning long lists. Persisted locally.

### Scope

- No change to analysis, the junk admission gate, storage schema, permissions, network behaviour or the archive path. Schema remains v6; rules remain `local-rules-0.6.8`.
- Dark-theme control was proposed and explicitly deferred by the owner; theming still follows `prefers-color-scheme` only.
- No provenance marker distinguishing an admitted junk record from an inbox record. That surface depends on `civion-mail-filter-authority-decision-r003`, which is not written.
- Authority: explicit owner decision, 2026-09-05, on the interface findings raised in session.

## v0.6.10 — 2026-09-05

### Junk admission gate conformance

- The admission gate now runs on the live-mail path. Previously it was reachable only from Historical Scan, so enabling `Analyze junk` performed full analysis of a spam folder as new mail arrived, with neither Path A nor Path B evaluated. The gate belongs to the junk folder, not to one operation.
- No message in a junk folder is tagged on any path. The live path left `applyTag` unset, which means apply, and explicit manual analysis did the same. Analysis on explicit selection still proceeds; the message itself is never written to.
- The manual blocked-domain list reaches the gate. The evaluation read `settings.blockedDomains`, which does not exist in normalized settings, so an empty list was passed and the blocked-domain bar was inert on both paths.
- In Historical Scan the gate is evaluated before the existing-record branch. Ordered the other way, records created before v0.6.7 were refreshed and their source state reasserted without ever being evaluated.
- Live-path non-admissions are counted and reported in diagnostics as `junkNotAdmittedMessageCount`.

### Compatibility and authority

- Corrections only. `modules/junk-admission.mjs` is unchanged; the two admission paths and their conditions are exactly as shipped in v0.6.7.
- No permission, host permission, network primitive or storage schema change. Analysis rules remain `local-rules-0.6.8`; storage schema remains v6. No record requires re-analysis.
- Implements no deferred item. `civion-mail-filter-authority-decision-r002` section 4 periodic cadence and section 6 distinct presentation state remain deferred, and the deadline-or-payment condition of section 3 remains unimplemented pending r003, which must first resolve the contradiction between section 2 and section 3.
- A pre-v0.6.7 record whose sender domain now fails the gate is no longer refreshed, but is not evicted either. Retroactive eviction is deliberately not done here.
- Authority: explicit owner decision, 2026-09-05, on the findings of `civion-mail-v0.6.9-conformance-audit-r001` (D1, D2, D5, D6).

## v0.6.9 — 2026-09-04

### Existing-document archive

- Adds an explicit `Archive existing PDFs` command covering every normal folder in every configured mail account, without a date or message limit.
- Excludes Trash, Junk, Sent, Drafts, Templates, Outbox, virtual and unified folders.
- Lists attachments first and performs full local analysis only for messages containing a PDF.
- Reports examined messages, PDF-bearing messages, recognized documents, newly archived documents, duplicates, pending items, failures and the current folder.
- Supports stop and safe continuation. An interrupted pass can be restarted idempotently because the Desktop host deduplicates exact PDF bytes by SHA-256.
- Pauses on an unavailable archive drive or local host and never falls back to Downloads.
- Historical Scan remains analysis-only; the new bounded operation owns existing-document extraction.
- Analysis rules remain `local-rules-0.6.8`; storage schema remains v6.

## v0.6.8 — 2026-09-04

### Intelligent local PDF archive

- Recognizes supported PDF document types using the message semantics and attachment name, then builds an approved archive path below `F:\01_ARCHIVE\CIVION`.
- Transfers exact PDF bytes only to the existing local `nl.civion.desktop` Native Messaging host under the strict `CIVION_DOCUMENT_ARCHIVE_NATIVE` contract.
- Desktop validates length, PDF signature, SHA-256 and every relative path component before an atomic write.
- Adds SHA-256 deduplication through `99_SYSTEM\archive-index.sqlite3`; distinct files never overwrite one another.
- A missing `F:` archive root produces a retryable `pending` state and never falls back to Downloads.
- High-risk or hard-blocked messages are excluded from automatic archiving; uncertain admissible documents route to `90_REVIEW`.
- Historical Scan does not bulk-archive attachments. Individual records can be retried explicitly from Action Center.
- Storage schema advances to v6 and analysis version advances to `local-rules-0.6.8`.

## v0.6.7 — 2026-09-04

### Junk admission gate

- Selecting a Junk folder in Historical Scan previously analyzed the entire spam folder and created ordinary records for all of it. Messages in Junk folders now pass an admission gate before any analysis or storage occurs.
- Admission requires either a protected registry identity that is authenticated from a domain allowlisted for that identity, or a sender domain with proven non-junk authenticated history in this mailbox.
- Proven history requires all of: at least two prior records from the same sender domain, at least one of them authenticated, none blocked, the domain absent from the local blocked-domain list, every qualifying prior in a non-junk folder, and the evaluated message itself authenticated.
- The gate reads headers only. Body analysis, deadline extraction and link inspection do not run on a message that is not admitted, and no record is created for it.
- A message that is not admitted receives no verdict. It is not marked, moved, tagged, or classified as spam, and the scan report states this explicitly.
- The gate fails closed: an undeterminable sender domain, an unreadable header set or any evaluation error results in non-admission.
- Historical Scan reports admitted and non-admitted counts per run.

### Compatibility and authority

- Constrains an existing capability; adds none. Junk was already reachable through Historical Scan.
- No permission, host permission, network primitive, storage schema or junk-state change. Nothing is written to any message.
- Analysis version remains `local-rules-0.6.5`.
- Implements section 3 of `civion-mail-filter-authority-decision-r002`. The periodic junk pass, separate presentation state and dismissal persistence remain deferred under section 6.

## v0.6.6 — 2026-09-04

### Action Center disclosure corrections

- The "CIVION Mail is ready" empty state no longer appears while records are held but excluded by the current view. A second empty state states how many records are held and offers to clear the filters or reveal retained originals.
- A narrowed view is now disclosed above the table. The notice names the active filters and, when the default `Available mail` filter is hiding records whose original was deleted or moved to Trash, states how many are hidden.
- Added `Clear filters`, which returns the view to its default, and `Show all retained records`, which widens the source filter beyond the default. The two are deliberately separate: clearing filters does not silently reveal deleted originals.
- Top bar commands now carry three weights instead of five identical buttons. `CIVION candidate export` is primary, `Historical Scan` and `Export JSON` are secondary, `Diagnostics` and `Settings` are quiet.

### Compatibility and authority

- Presentation and disclosure only. No analysis rule, priority rule, storage schema, permission or transport behavior was changed.
- Analysis version remains `local-rules-0.6.5`; no record requires re-analysis.
- Added `modules/view-filters.mjs`, a pure module with no Thunderbird API surface.

## v0.6.5 — 2026-09-04

### Consistency corrections over v0.6.4

- The toolbar and Spaces badge counter now excludes records whose original message was deleted or moved to Trash, so it agrees with the Action Center `Active` counter and with the default `Available mail` view.
- Deletion and move-to-Trash events detected in Thunderbird refresh the badge immediately instead of leaving a stale count until the next unrelated badge update.
- A `historical_expired` deadline can no longer raise current priority through any branch. Previously the suppression applied only when the security risk level was `Low`, so a stale obligation in a message with elevated risk could still be reported as `Critical`.
- A historically expired deadline alone no longer produces `Medium` attention; attention at or above `Medium` must now come from security risk, detected action, expected reply, payment evidence or unresolved verification.

### Compatibility and authority

- Patch release over 0.6.4; manifest permissions, extension ID, storage schema, Native Messaging and RFC822 evidence behavior are unchanged.
- No canonical CIVION Core state is mutated; Mail output remains candidate-only.
- Analysis version advances to `local-rules-0.6.5`.

## v0.6.4 — 2026-09-04

### Thunderbird deletion synchronisation
- Deleted messages and messages moved to Trash are removed immediately from the default Action Center list and from active/urgent/new counters.
- The analysis and provenance record is retained non-destructively and remains available through the new `Original` filter under `Deleted / unavailable` or `All retained records`.
- Restoring a message from Trash returns it to the default available-mail view.
- Source state and the unavailability timestamp are stored as technical Mail runtime fields without changing canonical Core state.

### Historical deadline relevance
- Preserves deadlines extracted from old messages but marks a deadline as `historical_expired` when the source is older than 120 days and the deadline expired more than 30 days ago.
- Historical expired obligations remain auditable evidence and candidate data, but no longer become current `Critical` or `Medium` attention solely because the old message contains mandatory, payment, reply, or deadline wording.
- Adds explicit `temporalState`, `currentlyActionable`, and `sourceAgeDays` fields to deadline analysis and the CIVION Mail ingestion envelope.
- User-facing summaries label historical deadlines as evidence rather than current obligations.

### Compatibility and authority
- Patch release over 0.6.3; storage schema and permissions are unchanged.
- Native Messaging, RFC822 evidence delivery, candidate-only authority and all security boundaries remain unchanged.
- Analysis version advances to `local-rules-0.6.4` for deterministic projection/re-analysis traceability.

## v0.6.3 — 2026-08-10

### Local source evidence
- Added bounded, exact RFC822 capture through Thunderbird `messages.getRaw()` for messages Thunderbird still permits the extension to read.
- Delivers source bytes to the Desktop-owned Native Messaging host using a strict, hash-verified, candidate-independent evidence contract.
- Existing records are backfilled opportunistically when their current Thunderbird message ID remains valid; missing historical bodies are never reconstructed or fabricated.
- Evidence capture failure is diagnostic-only and never blocks Thunderbird analysis or candidate delivery.
- Historical evidence can be linked after Thunderbird restart through the stable CIVION Mail record ID plus an exact, non-empty RFC `Message-ID`; ambiguous/headerless records remain metadata-only and fail closed.

### Security and authority
- Preserved `messagesRead` and `nativeMessaging`; no new permission, network primitive, server dependency, message sending, or canonical mutation authority was added.
- Exact RFC822 evidence is capped at 18 MiB (to remain inside the Native Messaging envelope limit), stored locally by Desktop, treated as untrusted, and linked idempotently to the pre-existing Mail source observation.

## v0.6.0 — 2026-08-09

### Desktop integration
- Added an automatic same-machine local spool bridge for CIVION Desktop.
- Added a content-free `CIVION_MAIL_BRIDGE_STATUS` handshake on Thunderbird install/startup/settings change so Desktop can show Mail availability and bridge state.
- New and re-analyzed messages emit one candidate-only `CIVION_MAIL_CANDIDATE_PACKAGE` v2 file under `Downloads/CIVION/Mail/Outbox`.
- Upgrade/install emits one bounded backfill package for the existing local Mail corpus; Historical Scan does not emit thousands of per-message spool files.
- Added persisted bridge counters/status in Mail metadata and a Settings toggle.
- Added the Thunderbird `downloads` permission solely for writing local JSON packages under the Downloads directory.
- No network permission, host permission, direct Core mutation, message sending, or server dependency was added.

### Authority and compatibility
- Mail remains candidate-only; Core/Console remains responsible for normalization, review, canonical acceptance and audit.
- `CivionMailIngestion` remains v0.2 and the existing candidate payload semantics remain compatible.
- Analysis rules are unchanged from v0.5.0; this release changes local transport/integration rather than Mail interpretation semantics.

## v0.5.0 — 2026-08-08

### CIVION alignment
- Renamed the active Thunderbird component identity from legacy MAIL SENTINEL to **CIVION Mail** while preserving the existing Gecko extension ID and local storage keys for in-place upgrade continuity.
- Replaced active ADMIN MAP / CIVIC MAP terminology with CIVION Gateway / CIVION Civic terminology. Legacy names remain only in explicit lineage/provenance and Core backward-compatibility handling.
- Added CIVION-native candidate export `CIVION_MAIL_CANDIDATE_PACKAGE` v2 using `CivionMailIngestion` v0.2, `source_project: CIVION Mail`, and candidate-only authority.
- Added deterministic C2/C3 envelope classification; financial and selected sensitive relationship classes are C3. C4 is never emitted by the extension.

### UI
- Application UI is English across popup, Action Center, menus, settings, diagnostics, confirmations and accessibility labels.
- Multilingual message-content detection and analysis remain available; UI language and message language are independent.

### Compatibility / security
- Analysis version advanced to `local-rules-0.5.0`; persisted storage schema remains v5 because no stored-record migration is required.
- No new Thunderbird permissions or host permissions. CSP remains `connect-src 'none'`; no network primitive was added.
- Manual delete remains explicit, confirmation-gated and non-permanent.
- Added a version-aware current-release test runner plus v0.5.0 package, semantic, UI-language and upgrade-continuity tests. Historical tests remain in source provenance but are not blindly executed against newer manifests.

## v0.4.0 — 2026-08-08

### Semantic model
- Added independent `relationshipClass`, `documentType`, structured `obligation`, `retention` and `civicMapReference` fields.
- Relationship Class is separated from legacy message categories and from Document Type.
- Public-institution claims are not promoted to a verified government relationship until the mail-layer identity/authentication gate succeeds.
- Added Document Type classification for Invoice, Receipt, Statement, Decision, Notification, Reminder, Contract/Change, Renewal, Cancellation, Delivery, Security Alert, Correspondence, Marketing and Other.
- Added advisory Retention Class: Keep, Keep temporarily, Reference only, Disposable, Review manually.
- `Disposable` is advisory only; no automatic deletion was introduced.
- Legacy `categories[]` remains for backward compatibility.

### ADMIN MAP / CIVIC MAP boundary
- Added candidate-only local `ADMIN MAP export` conforming to the shared `MailSentinelIngestion` v0.1 envelope.
- MAIL SENTINEL exports observations/candidates only; it does not write ADMIN_MAP_NL Shared Core and does not perform runtime CIVIC MAP network lookup.
- Added bounded CIVIC MAP reference candidates for verified/public-identity messages and explicit `verification_required` state for unverified claims.
- Added SHA-256 hash of the normalized analyzed body for new/re-analyzed records; full message body is still not persisted.

### UI / storage
- Added Relationship, Document Type and Retention filters.
- Added Semantic Model detail block with claimed relationship, retention reason and CIVIC MAP status.
- Schema upgraded from v4 to v5. Legacy records migrate non-destructively to conservative `Unknown / Review`, `Other`, `Review manually` semantic defaults until re-analysis.

### Security / privacy / compatibility
- No new Thunderbird permissions, host permissions or network primitives.
- CSP remains `connect-src 'none'`.
- ADMIN MAP export is explicit, local and candidate-only.

## v0.3.0 — 2026-08-08

### Mail Authentication Engine
- Promoted mail authentication from a hidden risk helper into a first-class analysis layer.
- Added structured parsing of trusted `Authentication-Results` for DMARC, DKIM and SPF.
- Added explicit alignment against the visible RFC5322 From domain and a conservative parent/child relaxed-alignment fallback without unsafe public-suffix guessing.
- Added authentication verdicts: `verified`, `failed`, `conflict`, `untrusted_results`, `observed_untrusted`, `no_results`.
- DMARC fail is decisive when trusted; an SPF failure no longer overrides a valid aligned DMARC/DKIM pass.
- Added conflict detection for contradictory trusted results.
- Added Reply-To, Return-Path and Sender-header domain alignment observations.
- Protected identities are now marked verified only when both the identity-domain allowlist and trusted aligned mail authentication succeed.
- Protected Identity domain mismatch remains an unconditional hard block and cannot be bypassed by whitelist or forged Authentication-Results.

### Action Center
- Added a visible **Mail authentication** block in message detail with verdict, DMARC/DKIM/SPF status, alignment and trusted authserv-id.
- Added `AUTH FAIL` and `AUTH CONFLICT` warning chips.
- Added explicit verification reasons for authentication conflict/failure and Reply-To domain mismatch.

### Security / privacy / compatibility
- No new Thunderbird permission and no host permission.
- No DNS or external network lookup is performed; the engine evaluates receiver-produced message headers already available through `messages.getFull()`.
- CSP remains `connect-src 'none'`.
- Raw `Authentication-Results` headers are not persisted in records; only minimized parsed results are stored.
- Schema remains v4; existing records gain the richer authentication layer on re-analysis.

## v0.2.3 — 2026-08-08

### Historical Scan / Import existing mail
- Added an explicit Action Center workflow for historical analysis of existing Thunderbird mail.
- Added account/folder scope selection, optional From/To date range and a bounded maximum-message setting (`0` = no scan limit).
- Normal folders are selected by default; Junk, Sent, Drafts, Templates, Outbox and Trash require explicit selection.
- Existing MAIL SENTINEL records are skipped by default; optional re-analysis preserves manual workflow fields.
- Historical analysis is read-oriented by default and does not apply Thunderbird priority tags unless explicitly requested.
- Added running progress, analyzed/skipped/failed counters, current-folder display and explicit cancel.
- Historical work is split into small queued batches so live new-mail events can interleave between batches.
- JSON export remains a full export of local `state.records`; after Historical Scan it contains the imported historical analysis corpus.
- Increased configurable soft `maxRecords` ceiling from 10,000 to 50,000 for larger local corpora.

### Compatibility / privacy
- No new Thunderbird permission, schema or network capability.
- DEC-006 preserved: no historical scan can begin without an explicit user command.
- CSP remains `connect-src 'none'`; full message bodies and attachment contents are not persisted.

## v0.2.2 — 2026-08-08

### Action Center context workflow
- Added a custom right-click context menu on every Action Center message row.
- Added quick actions: open original, re-analyze, status, priority, mark/unmark analysis as incorrect, copy sender/address/domain/subject, identity controls and delete original.
- Added keyboard access via Context Menu key or Shift+F10.
- Manual delete reuses the existing `messagesDelete` capability and remains explicit, non-permanent and confirmation-gated.
- Added `Покажи причината за блокиране` entry for hard-blocked records.

### Local identity controls
- Added bounded local `userAllowlistedDomains` and `userBlockedDomains` settings.
- Adding a domain to the user whitelist does not create an Official/Safe verdict and cannot override Protected Identity hard blocks or authentication/link checks.
- User-blocked domains receive unconditional local Hard Block after re-analysis.
- Whitelist/blocklist entries are mutually exclusive; changing disposition removes the domain from the opposite list.

### Compatibility / privacy
- PATCH over v0.2.1: no new Thunderbird permission, schema or network capability.
- CSP remains `connect-src 'none'`; no host permissions or network primitives added.

## v0.2.1 — 2026-08-08

### Security / corpus
- Added `modules/protected-identities.mjs` as the single protected-identity and corpus-derived service-domain registry.
- Imported 68 legitimate-looking service/organization sender domains from `MAIL_SENTINEL_export_2026-08-08`.
- Excluded personal sender domains and phishing-only domains `oglix.ba`, `levallos.app`, `livingcube.de`, `maxxoutkratom.com`, `tropico.vn`.
- Expanded protected identities and regression coverage for CJIB, Odido, PostNL, Bitvavo and Infomedics impersonation.
- Allowlisting remains informational/domain-compatible evidence only; it does not bypass authentication, link analysis or other risk checks.

### Action Center
- Added a separate **Дата** column using `receivedAt`.
- Added date filters: Today, last 7 days, last 30 days and custom From–To period.
- Added sorting by received date; Action Center now has eight sortable columns.
- Restored manual column resizing by dragging the separator between headers.
- Persisted column widths locally between Action Center sessions.
- Kept sorting and resize independent so dragging a separator cannot trigger a sort.
- Added keyboard resize for focused column separators.

### Compatibility / privacy
- PATCH over v0.2.0: no new permission, schema or network capability.
- Manifest V3 and minimum Thunderbird 140 preserved.
- Schema remains v4.
- CSP remains `connect-src 'none'`; no host permissions or network primitives added.

## v0.2.0 — 2026-08-08

### Security / analysis
- Added Institution Identity Allowlist and hard block for recognized identity + unauthorized From domain.
- Hard-blocked messages receive score 100, Critical priority and suppress `Reply Expected`.
- Added CJIB real-corpus regression cases.

### Workflow / UI
- Added manual deletion of the original Thunderbird message from detail view.
- Added `messagesDelete`; delete remains explicitly user-triggered and non-permanent.
- Added tri-state column sorting for the original seven Action Center columns.

### Versioning
- v0.2.0 is MINOR because manual delete introduced a new Thunderbird permission.


### v0.2.3 candidate hardening
- Historical Scan persisted as `running` is reconciled to `interrupted` after a Thunderbird restart; it is never resumed automatically.
- Cancel requests set the in-memory cancellation flag immediately, allowing an active batch to stop at the next message boundary while persistence remains serialized.
- Action Center now reports an interrupted-by-restart state explicitly.
