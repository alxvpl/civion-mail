# CIVION Thunderbird Add-on — Agent Bootstrap

## Mandatory CIVION pre-work

This repository does not contain the authoritative CIVION project governance.

Before any discussion, planning, implementation, review or acceptance involving this repository, read from Google Drive:

1. `CIVION_PROJECT_WORK_INSTRUCTIONS.md` — Drive ID `1hE4shJrkbFSauoeKHbNC9sbTA0Pv4h0m`
2. `00_CIVION_CANON_INDEX.md` — Drive ID `1Dxdb6Yhww965bDSDYZNzi3JsCDdc1t1D`

Then read the current applicable subproject/domain Canon indexes named below and every active object relevant to the task.

Repository files are implementation authority or bootstrap pointers only. They are not competing product Canon. If Drive authority is inaccessible, conflicting, WORKING/OPEN at the required point, or missing, stop the affected scope instead of relying on memory, a handoff or a stale local copy.

Before shared work, follow the Notion `CIVION Execution Claims` protocol. Before code changes, inspect the current repository/ref/state and overlapping work. Use a bounded branch, run the relevant checks, report exact evidence and do not claim completion without verification.

## Applicable authority

- Thunderbird Add-on Canon Index r003 — Drive ID `1hpydn-fXBtt1qmcdtQSs7UcNjMnKHYml`
- Mail Domain Canon Index r002 — Drive ID `19jmH5LbD_YGFeKeVfHvOFmxfvyVnS7T4`
- Core Canon Index r001 when Core-facing candidate/transport behavior is involved — Drive ID `16SI9vPOotOuu5m7mrvauAKYnrTZJN7SR`

The add-on is the Thunderbird implementation of CIVION Mail Extension. It may own client-specific runtime behavior, but it does not own Mail-domain semantics or Core canonical state. The native host/Mail Bridge is transport-only.

## Repository-local discipline

- Preserve extension identity, storage compatibility, permission surface and release integrity unless the accepted increment explicitly changes them.
- Treat message content and attachments as untrusted.
- Do not add network access, permissions, telemetry or direct Core writes without explicit accepted authority.
- Keep changes bounded and add/update tests for behavior changes.
- Verify package identity, manifest/permission changes, tests and exact release body before claiming completion.

## Completion evidence

Return branch/commit, changed files, test/package commands and results, permission/security impact, produced artifact/hash when applicable, limitations and any required human Thunderbird acceptance.
