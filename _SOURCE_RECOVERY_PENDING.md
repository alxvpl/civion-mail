# Source recovery status

**Status: CLOSED — full v0.8.1 source restored from the working tree.**

## What this file used to say

Between 2026-09-05 and this commit the repository root held only a partial expansion of
CIVION Mail v0.6.9. Three files — `action-center/app.js`, `action-center/index.html` and
`action-center/styles.css` — were `RECOVERY STUB` placeholders, because the expansion job
could not obtain a GitHub Actions runner (`runner_id: 0`). The exact v0.6.9 extension stayed
preserved at `releases/v0.6.9/CIVION_MAIL_v0_6_9.xpi`,
SHA-256 `e4e82d5cf7dc0734cd80aee272d0d9e569c26a86b7fc80ff38dec939d50a7841`, and that XPI
remains untouched.

## What replaced it

The repository root now carries the complete **v0.8.1** source, taken from the project
owner's working tree at `F:\CIVION\01_SOURCE\desktop\mail-extension` and verified against the
installed extension before it was committed.

Verification performed on 2026-09-12:

- Installed extension: `CIVION-Mail-installed.xpi`, manifest `0.8.1`,
  SHA-256 `260a628c0452cf3def3287664cbc0575139b82a66ae27bd9260afeea3a75efd2`.
- The XPI contains 34 files. All 34 are byte-identical to the working tree — every file
  compared by SHA-256, zero differences.
- The working tree carries one file the XPI does not ship, `tests/run-tests.mjs`, which is
  correct: tests are not packaged.

So the tree in this repository is the shipped 0.8.1 plus its test runner. No file was
reconstructed, retyped or inferred.

Nothing under `releases/` was changed, and the v0.6.9 recovery provenance in
`RECOVERY_PROVENANCE.md` stands as the record of how the earlier state came about.
