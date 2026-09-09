# Declined proposal: T19 period identity and backup compatibility

**Status: declined by Rami, not implemented.** Rami chose to avoid the additional complexity and expects mostly sequential device use. Do not add the proposed period identity column, identity backfill, period backup IDs, or deleted-anchor-target backup metadata. Migration 12 remains reserved for T21's local miss alerts. The technical design below is retained only as historical review context, not an implementation task. Review evidence and the reproduced legacy counterexample are retained under `.artifacts/t19/compatibility-design/`.

The proposal primarily addressed distinct archive/restore intervals sharing a start date during sync and restore; it was not primarily protection against future model migrations. Sequential use reduces concurrent-edit conflicts but does not recover missing historical identities or prevent all same-start intervals. Retain the existing identity/backup contracts and document their limits rather than claiming this declined design is implemented. The separate [offline anchor-cycle policy](offline-anchor-cycles-proposal.md) was also declined. Ordinary validation, transaction safety and required supported-path verification still apply.

## 1. Durable activity-period identity

Append SQLite **migration 12**, leaving migrations 1-11 and their checksums unchanged. Add exactly one column to `board_activity_periods`:

`sync_id TEXT NOT NULL COLLATE BINARY UNIQUE`

Enforce a valid nonempty identity and immutable binding to the row's `board_id` and `start_date`. Keep the existing local integer primary key. Backfill and constraints must commit in the same exclusive migration transaction; failure rolls back the table change, backfill, queued uploads and schema markers. Later planned migrations shift accordingly, and the Swift schema/checksum gate changes in the same implementation increment.

The identity domain is:

- Existing literal `boardId|startDate` for one legacy alias row per exact board/start group.
- UUIDv4, allocated once through the existing ID port, for every newly created interval after this migration.
- Deterministic UUIDv5 for additional retained legacy intervals. Closing, reopening or tombstoning an interval never changes its identity.

### Exact backfill

Include both live and tombstoned rows. Within each exact board/start group, choose the alias carrier by greatest binary `mutation_stamp`, then greatest UTF-8 bytes of compact JSON `[startDate,endDate,deletedAt]`. Identical ties are interchangeable for synchronized content; local integer ids never enter a wire identity.

For the remaining rows, number identical full tuples from 1 through N. Generate each extra id with the existing namespace `4d96f757-73e0-561c-99b9-16b7ef2d1903` and UUIDv5 of exact compact JSON:

`["habit-activity-period-extra-v1",boardId,startDate,endDate,mutationStamp,deletedAt,ordinal]`

Persist these ids once. Preserve every original endpoint, deletion time and mutation stamp; do not change actions, ledger, receipts or HLC. Queue each retained row for version-2 publication using its original source stamp and the acquired local enqueue time. Hash/identity/constraint failures abort migration. The migration and wire switch must prevent the old mapper from publishing UUID period identities prematurely.

**Guarantees:** the same retained row multiset produces the same identity multiset regardless of local integer ids or SQL order; migration preserves every locally retained interval, including identical duplicates, reversed ranges and overlaps; future version-2 updates address the intended stable interval.

**Unrecoverable limit:** version 1 never retained cross-device creation identity. Two peers can choose different alias carriers after divergent edits. A stale version of an old interval can survive as an extra UUID and reintroduce eligibility after merge. For example, X holds shortened P=Sep10..Sep08 at stamp40 plus Q=Sep10..Sep12 at stamp30; Y holds old P=Sep10..Sep15 at stamp20 plus the same Q. X aliases P, Y aliases Q, and merged stale P remains separately addressable. Deterministic hashing cannot tell those versions apart from independently created intervals. Approval accepts preservation of retained local rows and stable future identities, **not exact recovery of pre-upgrade divergent lineage or eligibility**.

### Wire compatibility

The existing `activity_period` entity keeps its four fields: `board_id`, `start_date`, `end_date`, `deleted_at`. Version 2 puts `sync_id` in the existing envelope `entityId`; no extra wire field or entity type is added. Alias ids must match their embedded board/start. UUID ids retain their original board/start binding.

Version-1 input continues addressing only the literal alias, never an arbitrary same-start row or UUID extra. Existing version-1 clients must upgrade before joining the version-2 dataset. Old numeric outbox references still resolve the local row, but uploads pair its current payload with its current stamp and stable identity.

## 2. Period identity in backups

Add exactly `id` to each version-2 board period object:

`{ id, startDate, endDate }`

Export all retained live intervals individually, preserving duplicate starts and stable ids; omit local integer ids and period tombstones. Version-2 import preserves those identities, validates board/start binding and skips existing or tombstoned identities. Preserve the inherited rule that existing boards are retained rather than replaced by a backup.

Newly inserted restored mutable content receives the inherited fresh import mutation stamp. This preserves identity and endpoint multiplicity, **not the original mutable sync version**. Do not add a period source-stamp export field or claim byte-identical LWW-record restoration under this proposal.

Version-1 backups remain readable. They preserve valid endpoint multiplicity but cannot recover ids or source stamps that were never exported. For newly restored boards, choose one alias carrier deterministically from endpoint tuples and assign remaining intervals UUIDv5 using a separate `habit-activity-period-v1-import-v1` name domain with board/start/end/duplicate ordinal. Persist the assignment within the import receipt transaction. CSV-created intervals receive fresh UUIDv4 ids. None of these identity operations creates historical earnings.

## 3. Referenced deleted anchor targets in backups

Add one version-2 top-level array with this exact entry allowlist:

`deletedAnchorTargets: { id, orderKey, createdAtUtc, updatedAtUtc, mutationStamp, deletedAtUtc }[]`

Include only actually retained tombstoned boards directly referenced by the raw board anchors of exported live or archived boards. Copy their original structural metadata exactly. Export no deleted title, symbol, accent, note, tracking preferences, anchor fields, periods, checks or history through this array, and no unrelated tombstones. Require valid non-null deletion metadata and reject conflicting duplicate identities or a target also represented as a live board in the file.

Import uses **missing-only insertion**: if the id is absent, insert the same privacy-stripped neutral board tombstone representation used by sync, carrying the exported structural metadata. If any live or tombstoned board already owns the id, leave that full local row unchanged regardless of relative stamps. Import does not acquire sync LWW behavior or delete an existing habit. Restore live raw anchors in two passes after identities exist.

This supports exact raw-anchor restoration into an empty store while preserving existing-id behavior in a merge restore. A truly missing, never-received parent remains distinct from a retained deleted target; do not fabricate deletion metadata for it. Network sync retains its normal LWW contract.

This is a narrowly scoped **exception** to `docs/remote-fact-admission.md`'s no-raw-tombstones backup rule. The privacy scanner may permit only these structural paths; suppressed payloads, unrelated tombstones, inbox state and other device metadata remain excluded.

## Historical requested approval scope (declined)

Approve the one-column period identity change, its explicit legacy limitation, version-2 `period.id`, and the restricted `deletedAnchorTargets` backup exception with missing-only insertion. No approval of the separate offline anchor-cycle policy, additional schema/export fields, source-stamp backup preservation, new dependency or Swift public API is implied.

Implementation acceptance must demonstrate transactional backfill rollback, old checksum preservation, repeated-start and identical-duplicate parity, the documented legacy counterexample, future two-peer interval updates, v1 alias isolation and actual old-decoder rejection, id-preserving backup/replay, fresh A-to-deleted-B restoration, existing live/deleted B preservation under both older and newer imported metadata, privacy allowlists, and no fresh coin earning from restoration.
