# CIVION Mail v0.6.11 — Release Record r001

**Date:** 2026-09-05
**Status:** BUILT AND DELIVERED TO OWNER / AUTOMATED TEST SUITE NOT EXECUTED / BINARIES NOT PUBLISHED TO DRIVE
**Author:** Claude (Anthropic) — CIVION executor
**Object key:** `civion-mail-v0.6.11-release-record`
**Component:** CIVION Mail
**Authority:** explicit owner decision, 2026-09-05, on interface findings raised in session
**Relation to prior record:** extends, does not supersede, `civion-mail-v0.6.10-release-record-r001`. That record remains accurate for v0.6.10 and is not edited. Section 3 below carries the combined lineage so that this single file answers "what is the current Mail build and how did it get here".

---

## 1. Artifact

```text
CIVION_MAIL_v0_6_11.xpi
size:    176632 bytes
sha256:  f18a57b892a9da027ed0523b6406586bc3aca113c63c99efd850341d2d84bbcf
entries: 32 files, identical file set to v0.6.9 and v0.6.10 — none added, none removed
manifest version: 0.6.11
extension id:     mail-sentinel@local.invalid
storage schema:   v6 (unchanged)
analysis rules:   local-rules-0.6.8 (unchanged)
```

Changed against v0.6.10: `action-center/app.js`, `action-center/index.html`, `action-center/styles.css`, `manifest.json`, and the four packaged documents. `background.js` and every module under `modules/` are byte-identical to v0.6.10. This is an interface release with no analysis, no storage and no runtime change.

**Neither binary is on Drive.** `08_PRODUCT_RELEASES/DISTRIBUTION` holds no v0.6.10 or v0.6.11 artifact. The two hashes — in this record and in the v0.6.10 record — are the only Drive-side means of identifying either build.

## 2. What changed and why

The Action Center stylesheet carried the header `v0.1.11`. The visual system was designed for a much smaller application and had absorbed forty releases of functionality by appending: a new button to the topbar, a new block to the detail panel. Nothing had been re-ranked. This release re-ranks what already existed and adds no capability.

- **Topbar.** Historical Scan, Archive existing PDFs and Export JSON moved into one `Operations` menu, each carrying a note stating its scope. `Archive existing PDFs` sweeps every normal folder in every account with no date or count limit; it previously carried the same visual weight as a routine export. This is a safety correction expressed in the interface, not decoration.
- **Filters.** Nine controls of equal weight became three visible (search, Priority, Status) plus a `More filters` drawer with a count of active advanced filters. Active filters render as removable chips, so the current narrowing is legible without reading eight selects one by one.
- **Counters.** Active, Critical / High, Due within 3 days and New are now buttons that apply the view they name. Counter and filter share a single predicate set (`QUICK_FILTERS`), so a number cannot disagree with the view it opens. Pressing the active counter restores the full view.
- **Detail dialog.** The side panel held thirteen equally weighted blocks and a fourteen-row definition list; "Language" and "Account" competed with "Preliminary risk" and "Deadline evidence" on the screen where the decision is made. It is now ranked in three tiers, with account, folder, recipients, timestamps, mode and language collapsed under `Message and analysis details`. Every element id was preserved, so `renderDetail` required no change.
- **Columns.** A `Columns` menu toggles column visibility, persisted locally. `Categories` is hidden by default; Sender and Subject are locked visible. A hidden column keeps its stored width and no longer contributes to the table width — `applyColumnWidths` previously summed hidden columns into the total and left dead space to the right of the table.
- **Density.** A `Compact` toggle switches row and header spacing, persisted locally.

## 3. Combined lineage

| Version | Date | Nature | Runtime change |
|---|---|---|---|
| v0.6.9 | 2026-09-04 | owner-installed baseline, audited this session | — |
| v0.6.10 | 2026-09-05 | conformance corrections D1, D2, D5, D6 | yes — junk admission gate reachable on every path, no writes to junk messages, gate ahead of the existing-record branch, blocked-domain list actually consulted |
| v0.6.11 | 2026-09-05 | Action Center re-ranking | no — interface only |

`civion-mail-v0.6.9-conformance-audit-r001` states its findings as open. D1, D2 and D5 were closed in v0.6.10, together with D6, which was found during that implementation and is not in the audit. D3, D4 and A6 remain open and are unaffected by either release.

## 4. Deliberately not done

- **Dark-theme control.** Proposed and explicitly deferred by the owner. Theming still follows `prefers-color-scheme` alone, so a dark Thunderbird on a light OS still shows a light Action Center.
- **Junk provenance marker.** The interface still presents a record admitted from a junk folder identically to one from the Inbox. This is audit finding D4 seen from the interface side, and it cannot be designed before `civion-mail-filter-authority-decision-r003` establishes what is declared. It is the one place where the interface remains silent about something the audit holds to be material.
- Everything else listed as open in the v0.6.10 record: `r002 §3` deadline-or-payment condition, `r002 §4` periodic pass, `r002 §6` distinct presentation state, retroactive eviction of pre-v0.6.7 records, and the archive-path ownership question (A6).

## 5. Verification performed and not performed

Performed:

- syntax check of every JavaScript and MJS file — clean;
- markup integrity and element wiring checked programmatically: no duplicate or unbalanced tags, and every id required by `cacheElements` present after the rewrite;
- functional test of the Action Center under jsdom against the real modules — quick filters and their chips, release on second press, drawer and active-filter count, chip removal restoring the underlying select, `Clear filters` also clearing the quick filter, density toggle, column show and hide, rejection of locked and unknown columns on load, preference restore across a reload, and mutual exclusion of the two menus;
- package integrity: 32 entries, no corrupt member, file set identical to the two prior builds, manifest version read from inside the archive.

One real defect was found by that test and fixed before packaging: the `toggle` event is queued, so two menus opened within one task closed each other in the wrong order. Closing siblings now happens on the summary click, which is deterministic.

Not performed:

- **the automated Mail test suite was not executed** for either v0.6.10 or v0.6.11. It is not part of the XPI and was not available in the build environment. The v0.6.9 release notes record 61 passing tests; no equivalent statement can be made for either build filed here.

## 6. Open after this release

- run the automated suite against the 0.6.11 tree; on failure, withdraw and supersede rather than patch;
- `civion-mail-filter-authority-decision-r003` — not written;
- archive-path ownership decision (A6) — not written;
- publication of both binaries and their hashes to `08_PRODUCT_RELEASES`, if the owner wants the builds carried in Drive rather than held locally.
