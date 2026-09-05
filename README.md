# CIVION Mail

**Local-first Thunderbird mail intelligence and document-ingestion edge for CIVION.**

CIVION Mail is the mail-facing runtime of the CIVION personal administration system. It runs inside Thunderbird, analyzes mail locally, maintains a structured operational view of messages, preserves evidence through the local CIVION Desktop bridge, and can archive recognized PDF documents into the local CIVION archive.

It is deliberately **not** a second canonical database. CIVION Mail produces local observations, analysis records, evidence and candidate packages; canonical administrative state remains owned by CIVION Core and the relevant CIVION modules.

## Current release

**Latest delivered build: CIVION Mail v0.6.10 — 2026-09-05**

| Item | Value |
| --- | --- |
| Extension | CIVION Mail |
| Version | `0.6.10` |
| Thunderbird minimum | `140.0` |
| Extension ID | `mail-sentinel@local.invalid` |
| Storage schema | `v6` |
| Analysis rules | `local-rules-0.6.8` |
| XPI size | `170283 bytes` |
| XPI SHA-256 | `288822b10121d7a76e9cb5d5e1c6c832339e57a0336cbf395210d787647a51ee` |
| XPI file set | 32 files |
| Desktop archive host | `0.4.2` |

Release metadata is published under [`releases/v0.6.10/`](releases/v0.6.10/).

The v0.6.10 build is a conformance correction over v0.6.9. It fixes junk-admission enforcement on the live mail path, prevents writes to messages while they are in Junk, restores the manual blocked-domain list inside the admission gate, and evaluates the gate before the historical existing-record branch.

**Verification status:** syntax checks, targeted junk-gate behaviour checks and package-integrity checks were performed. The full automated CIVION Mail test suite was **not executed for v0.6.10** in the build environment. v0.6.9 had 61 passing automated Mail tests; no equivalent claim is made for v0.6.10.

## What CIVION Mail does

### Local message analysis

CIVION Mail analyzes mail into separate semantic dimensions instead of collapsing everything into a single category. Current records can include:

- Relationship Class;
- Document Type;
- obligation/message state;
- retention recommendation;
- priority and status;
- deadlines and monetary amounts;
- confidence and risk indicators;
- mail-authentication result;
- important attachment metadata;
- source availability and provenance;
- local manual notes and field-level manual provenance.

The full message body is not persisted in Thunderbird extension storage. New or re-analyzed records can retain a SHA-256 hash of the normalized analyzed text without retaining that text itself.

### Mail authentication and identity controls

The authentication engine evaluates receiver-produced `Authentication-Results` already present in the message and separates DMARC, DKIM and SPF results. It also evaluates alignment with the visible sender domain and observes `Reply-To`, `Return-Path` and `Sender` relationships.

Trusted authentication results can contribute to a verified verdict. Unknown or untrusted `Authentication-Results` do not gain verification authority. Protected-identity domain mismatch remains a hard block and is not bypassed by a local whitelist.

CIVION Mail does **not** perform DNS lookups for this process.

### Junk admission gate

Messages in Junk are not treated as ordinary mail merely because Junk analysis is enabled.

Before analysis and storage, a Junk message must pass the admission gate through one of the accepted paths: a verified protected/institutional identity, or sufficient authenticated non-Junk history for the sender domain. The gate fails closed when it cannot be evaluated safely.

As of v0.6.10:

- the gate runs on the live new-mail path as well as Historical Scan;
- manual blocked domains reach the gate correctly;
- the gate is evaluated before historical existing-record handling;
- a message while located in Junk is read-only from CIVION Mail's perspective — no tagging, moving or other message write is performed by the analysis path;
- an explicitly selected Junk message may still be analyzed if admitted, but the message itself is not modified.

An admitted Junk record does not yet have a dedicated presentation state, and the periodic-pass mechanism remains deferred.

### Action Center

Action Center is the main operational UI for CIVION Mail. It provides a structured view of analyzed messages rather than acting as another mailbox list.

Current capabilities include filtering and sorting across semantic fields, message detail, original-message access when still available, manual re-analysis, workflow/status handling, local identity controls, diagnostic/export functions and explicit operations such as Historical Scan and PDF archival.

Deleted or unavailable Thunderbird originals are removed from the normal active view while their retained analysis/provenance record can remain available separately.

### Historical Scan

Historical Scan is an **explicitly started** operation. It never begins automatically.

The user selects scope and can bound the scan by folders, date range and message count. Normal folders are the default; special folders such as Junk, Sent, Drafts, Templates and Trash require explicit inclusion where applicable. Existing records are normally skipped unless re-analysis is requested.

Historical work is processed in bounded batches so live mail handling can continue between batches. A scan can be stopped, and an interrupted run is not silently resumed after Thunderbird restart.

### Exact RFC822 evidence preservation

When Thunderbird still exposes the original message, CIVION Mail can read the exact RFC822 bytes and pass them through the same-machine Native Messaging channel to the CIVION Desktop host.

Desktop validates identity, byte length and SHA-256 before storing the `.eml` as **untrusted local evidence**. This preserves the original source without turning imported mail content into canonical CIVION state.

Historical records for which the original Thunderbird message is no longer available remain honestly metadata-only; CIVION Mail does not reconstruct missing message content.

### Intelligent PDF archive

From v0.6.8, recognized PDF documents can be passed locally to CIVION Desktop for validated archival.

The current archive root is:

```text
F:\01_ARCHIVE\CIVION
```

The Desktop host validates the exact PDF bytes, PDF signature, size, target path and SHA-256. Documents are then organized by domain, organization, year and document type. A SHA-256 archive index prevents duplicate storage, and writes are atomic.

Recognized document classes include invoices, receipts, statements, insurance policies, contracts, decisions and official notifications. Low-confidence but otherwise admissible documents can be routed to `90_REVIEW`.

High-risk or hard-blocked messages are not automatically archived.

If the archive drive or Desktop host is unavailable, the document remains pending. CIVION Mail does **not** silently fall back to Downloads.

### Archive existing PDFs

From v0.6.9, Action Center provides `Archive existing PDFs` for controlled archival of existing mail attachments.

After explicit confirmation it scans normal folders across all configured mail accounts without a date or message-count limit. Trash, Junk, Sent, Drafts, Templates, Outbox, virtual folders and unified folders are excluded.

The operation first inspects attachment metadata. Full local message analysis is performed only for messages that contain a PDF. Progress exposes the current folder, checked messages, discovered PDFs, archived documents, duplicates, pending items and errors.

The pass can be stopped and safely repeated. The Desktop SHA-256 index makes the process idempotent and prevents already archived documents from being duplicated.

## CIVION integration

CIVION Mail is an **edge/source runtime**, not the canonical CIVION master.

The main integration path is the Desktop-owned Native Messaging host:

```text
Thunderbird
    |
    v
CIVION Mail
    |
    | Native Messaging — same machine only
    v
nl.civion.desktop
    |
    +--> candidate packages
    +--> RFC822 evidence
    +--> validated PDF archive
    v
CIVION Desktop / downstream CIVION processing
```

Candidate packages remain candidate-only. Transport does not itself mean acceptance into CIVION Core, and CIVION Mail has no authority to write canonical Core/PostgreSQL state directly.

The legacy Downloads spool remains only a diagnostic/backward-compatible path for candidate JSON where supported. PDF archival never uses Downloads.

## Privacy and security model

CIVION Mail is designed as a local-first extension.

The current extension contains no cloud AI provider integration, telemetry endpoint, remote script, remote font or general external-network integration. Its extension CSP keeps:

```text
connect-src 'none'
```

There is no `fetch`, `XMLHttpRequest` or remote host permission in the extension runtime. `nativeMessaging` is used for the local Desktop-owned host `nl.civion.desktop` on the same machine.

During analysis CIVION Mail may temporarily read message identifiers, account/folder context, sender/recipients, subject/date, inline text, relevant mail-authentication headers, HTML link targets/text and attachment metadata. These inputs are used locally.

The extension does not persist the full message body or attachment contents in `messenger.storage.local`. Exact RFC822 evidence and PDF bytes are transferred only through the local Desktop bridge for the explicit local preservation/archive functions described above.

Manual deletion of an original Thunderbird message is user-triggered, confirmation-gated and non-permanent (`deletePermanently: false`). CIVION Mail does not automatically delete mail.

See [`PRIVACY.md`](PRIVACY.md) in the packaged release source for the detailed privacy model.

## Installation and dependencies

### Thunderbird

CIVION Mail v0.6.10 requires Thunderbird `140.0` or newer.

For an XPI installation:

1. Open Thunderbird Add-ons and Themes.
2. Choose **Install Add-on From File…**.
3. Select the verified CIVION Mail XPI.
4. Confirm the extension installation/update.

The extension ID remains `mail-sentinel@local.invalid` for compatibility with the existing Mail Sentinel/CIVION Mail installation lineage and local extension storage.

### CIVION Desktop host

Core local message analysis can run inside Thunderbird, but Desktop-backed features require the local Desktop Native Messaging host.

The current PDF archive dependency for v0.6.8–v0.6.10 is **CIVION Desktop archive host 0.4.2**. The host should be installed and validated before using automatic PDF archival or `Archive existing PDFs`.

## Release lineage

Recent releases materially changed the product as follows:

- **v0.6.10** — junk-gate conformance corrections across live, manual and historical paths.
- **v0.6.9** — controlled all-account `Archive existing PDFs` operation.
- **v0.6.8** — intelligent local PDF archive through the Desktop host.
- **v0.6.7** — Junk Admission Gate.
- **v0.6.6** — view/filter disclosure improvements.
- **v0.6.5** — active-counter and historical-priority consistency.
- **v0.6.4** — historical deadline relevance and Thunderbird deletion synchronization.
- **v0.6.3** — exact RFC822 evidence preservation through Desktop Native Messaging.
- **v0.6.2** — unattended same-machine Desktop bridge.
- **v0.6.0** — Desktop spool/bridge integration line.
- **v0.5.0** — transition from legacy Mail Sentinel identity to CIVION Mail module identity.

Detailed per-version notes are carried in the packaged `README_BG.md`, `RELEASE_NOTES_BG.md` and `CHANGELOG.md`.

## Known open items

The current release record intentionally leaves several matters open:

- the accepted junk-filter authority decision still contains a pre-analysis versus deadline/payment-information contradiction that requires a later decision revision;
- distinct presentation of admitted Junk records is not yet implemented;
- the periodic Junk pass remains deferred;
- archive-path ownership remains unresolved at the product-architecture level;
- the full automated CIVION Mail test suite still needs to be executed against the v0.6.10 working tree;
- the v0.6.10 XPI binary still needs publication to the canonical distribution locations if it is to be distributed from GitHub/Drive rather than held as the owner-delivered build.

## Repository status

This repository was created after CIVION Mail had already progressed through several local builds. The original v0.6.9 XPI was recovered from the owner's active Thunderbird installation and preserved with its historical SHA-256.

The repository root was only partially expanded during that recovery operation; files explicitly marked as recovery stubs are **not canonical source**. Current release evidence and checksums are kept under `releases/` while source normalization continues.

For v0.6.10, the delivered XPI is the verified build artifact identified by the SHA-256 above. Do not infer a different build from a partial recovery stub.

## Authority boundary

CIVION Mail can analyze, classify, preserve evidence, create candidates and perform explicitly authorized local mailbox/document operations. It does not gain authority merely because content arrived by email.

Mail bodies, attachments, imported PDFs and embedded instructions are untrusted inputs. Analysis confidence is not verification, candidate state is not accepted state, and UI state is not canonical CIVION state.

That boundary is intentional and is part of the product design, not a temporary limitation.
