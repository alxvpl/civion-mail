# CIVION Mail v0.6.10 — Release Record r001

**Date:** 2026-09-05
**Status:** BUILT AND DELIVERED TO OWNER / AUTOMATED TEST SUITE NOT EXECUTED / NOT PUBLISHED TO DRIVE
**Author:** Claude (Anthropic) — CIVION executor
**Object key:** `civion-mail-v0.6.10-release-record`
**Component:** CIVION Mail
**Authority:** explicit owner decision, 2026-09-05, on the findings of `civion-mail-v0.6.9-conformance-audit-r001`
**Closes findings in:** `civion-mail-v0.6.9-conformance-audit-r001` — D1, D2, D5, and D6 (found during implementation, not present in the audit)
**Implements no part of:** `civion-mail-filter-authority-decision-r002` sections 4 and 6

---

## 1. Why this record exists

`civion-mail-v0.6.9-conformance-audit-r001` states its findings as open and closes with the sentence that nothing in it authorises implementation. The owner authorised implementation on the same day and the corrections were built. Without this record, a reader working from Drive alone would take the audit as current and act on defects that no longer exist in the delivered build.

## 2. Artifact

```text
CIVION_MAIL_v0_6_10.xpi
size:    170283 bytes
sha256:  288822b10121d7a76e9cb5d5e1c6c832339e57a0336cbf395210d787647a51ee
entries: 32 files, identical file set to v0.6.9 — none added, none removed
manifest version: 0.6.10
extension id:     mail-sentinel@local.invalid
storage schema:   v6 (unchanged)
analysis rules:   local-rules-0.6.8 (unchanged)
```

The binary was delivered to the owner in session. **It is not on Drive.** `08_PRODUCT_RELEASES/DISTRIBUTION` holds no v0.6.10 artifact at the time of writing, and the hash above is the only Drive-side means of identifying the build.

## 3. Changed files

`background.js`, `manifest.json`, `CHANGELOG.md`, `README_BG.md`, `RELEASE_NOTES_BG.md`, `PRIVACY.md`.

`modules/junk-admission.mjs` is byte-identical to v0.6.9. The two admission paths and their conditions are exactly as accepted in v0.6.7; this release changes where the gate is called and what reaches it, never what it decides.

## 4. Corrections

**D1 — the gate now runs on every path.** `evaluateJunkMessage` had one call site, in `processHistoricalBatch`. The live path `handleNewMail` gated on `shouldAnalyzeFolder` alone, so `analyzeJunk: true` produced full analysis and ordinary records for arriving junk mail with neither Path A nor Path B evaluated. `handleNewMail` now evaluates the gate per message before analysis or storage, fails closed on an unevaluable gate, and counts non-admissions.

`listAllJunkFolderIds` was added because the live path has no job config. Path B condition 5 requires that prior records sitting in junk *anywhere* are excluded as evidence; that set previously came only from `job.config.allJunkFolderIds`, which is what tied the gate to Historical Scan in the first place.

**D2 — no message in a junk folder is written to, on any path.** Both `handleNewMail` and explicit manual analysis passed no `applyTag`, and `processMessage` applies tagging when the option is not exactly `false`. With `autoTag` enabled this issued `messagesUpdate` against messages in a junk folder, which `r002 §5` prohibits without exception, including in AUTO TAG mode. Both call sites now pass `applyTag: false` for a junk folder, and Historical Scan does the same for junk messages regardless of the run's `applyTags` setting.

Analysis on explicit selection remains permitted. The prohibition is on writing, not on reading.

**D5 — gate before the existing-record branch.** In `processHistoricalBatch` the `existing && !reanalyzeExisting` branch preceded the junk check, so records created before v0.6.7 were patched, their source state reasserted as available, and skipped without ever being evaluated. The gate is now first.

**D6 — the manual blocked-domain list reaches the gate.** Found during implementation and not present in the audit. `evaluateJunkMessage` read `settings.blockedDomains`; the normalized settings key is `userBlockedDomains` (`modules/storage.mjs:92`). An empty list was passed, so `signals.userBlockedDomain` could never be true and the absolute bar of `r002 §3` and Path B condition 4 were both inert — in Historical Scan as well, not only on the unreached live path. The shipped gate was therefore weaker than the audit itself assumed.

## 5. Deliberately unchanged

- The deadline-or-payment condition of `r002 §3` remains unimplemented. It contradicts the requirement of `§2` that the gate be evaluated on cheap header data before analysis. The contradiction is for r003 to resolve; code written against either reading would be an executor choosing between two readings of an accepted decision.
- Distinct presentation of an admitted junk record (`r002 §6`) and the periodic pass (`r002 §4`) remain deferred.
- A pre-v0.6.7 record whose sender domain now fails the gate stops being refreshed but is not evicted. Retroactive eviction has no filed decision and was not invented here.
- The archive-path ownership question recorded as A6 in the audit is untouched and continues to accumulate cost with every document archived.

## 6. Verification performed and not performed

Performed:

- syntax check of `background.js` and every module — clean;
- behavioural check of `modules/junk-admission.mjs` after the surrounding changes: the blocked-domain bar refuses, Path B admits on two prior non-junk records with one verified, and evidence sitting in junk does not admit;
- package integrity: 32 entries, no corrupt member, file set identical to v0.6.9, manifest version confirmed from inside the archive.

Not performed:

- **the automated Mail test suite was not executed.** It is not part of the XPI and was not available in the build environment. The v0.6.9 release notes record 61 passing tests; no equivalent statement can be made for v0.6.10.

This record is filed on the owner's instruction ahead of that run. If the suite fails on the working tree, the correct response is to withdraw v0.6.10 and supersede this record, not to patch around it.

## 7. Open after this release

- `civion-mail-filter-authority-decision-r003` — resolves `§2`/`§3`, fixes the distinct presentation state. Not written.
- Archive-path ownership decision (audit A6). Not written.
- Automated test suite run against the 0.6.10 tree.
- Publication of the binary and its hash to `08_PRODUCT_RELEASES`, if the owner wants the build carried in Drive rather than held locally.
