# Incorporated pre-T2 review

Date: 2026-09-08. Scope: product spec, inherited behavior, T2 through T24, and existing implementation boundaries.

Status: findings incorporated into the amended spec and task plan after Rami authorized the changes, document push, and completion of the remaining tasks. His latest correction replaces the earlier overnight-stack assumption. This review records planning decisions; it does not claim the implementation is complete.

Pre-T2 baseline reported by the coordinating agent: 570 Jest tests, 51 Swift tests, and 9 plugin checks green.

## Resolved product decisions

1. **Stacks combine one stored logical date only.** The initial review identified ambiguity in assigning untimed checks to an overnight run. Rami corrected the requirement: there is no overnight assignment to infer. Tuesday bedtime and Wednesday waking belong to different runs, even when their habits are linked. Usual/preset times are informational. Exact occurrence instants and time edits never reassign a stored logical date. Runs use `<structuralRootBoardId>|<logicalDate>`.

2. **Re-completing a run restores its net bonus.** The original one-bonus-row plus permanent-reversal contract could not represent check -> complete -> uncheck -> recheck. The amended contract keeps all prior rows and restores the entitlement through append-only adjustments, subject to the approved close boundary.

3. **Offline daily conflicts use ordered action replay and deterministic ledger adjustment.** A local unique index cannot coordinate two offline devices. Immutable `habit_actions` preserve checked/unchecked evidence, including actions whose check rows were tombstoned. Scope-aware replay in valid mutation-stamp/id order resolves daily state: Daily uncheck clears the date, while Count removal, individual history deletion, Undo, and move-out remove only their referenced check. Event replay and adjustment reconcile duplicate earnings, cap races, duplicate bonuses/reversals, and runs completed only after merge. Separate offline claims still stand and can produce a negative balance.

The detailed action/adjustment protocol is `docs/ledger-reconciliation.md`. Generated ledger rows and synthetic legacy baseline actions use deterministic UUIDv5 identities; commands and live actions retain UUIDv4. Ledger adjustment evidence includes scope, source action, reconciliation identity, adjusted-row reference, and provenance. Raw positive/negative ledger totals retain their approved meaning.

## Incorporated migration and sequence corrections

- Split migrations by dependency: T2/schema 6 for board/settings/widget kind; T3/schema 7 for immutable habit actions; T15/schema 8 for ledger; T18/schema 9 for rewards; T21/schema 10 for local miss alerts. The action migration reserves a nullable policy snapshot so the later coin slice can add policy evidence without rewriting earlier history.
- Every new migration updates the Swift schema version/checksum map in the same commit. Versions 1 through 5 remain immutable.
- Explicit Count defaults preserve legacy imports, existing boards, and compatibility callers. New board forms explicitly choose Daily.
- Intermediate builds are development checkpoints until native, sync, and export compatibility through T20 is complete. Earlier slices are no longer described as independently release-ready for real multi-device use.
- Shared TS/Swift fixture changes land with both executors in one green integration commit. T7 owns that atomic daily-contract substep; T8 completes native-specific verification. Later coin contract changes follow the same rule.
- Bounded task substeps cover the expanded schema, writer, serialization, and sample-adapter boundaries without changing T1 through T24 numbering.

## Incorporated engineering corrections

### Daily actions and coins

- Add Earn Coins and Daily Coin Cap controls, validation, save/reopen, and accessible labels for both Daily and Count boards. Earning defaults false; the original UI plan offered no way to enable it.
- Resolve the toggle and persist its action inside one exclusive transaction. The original read-then-dispatch sketch could race another writer.
- Preserve Count-to-Daily history. Uncheck tombstones all live checks on the selected date, with confirmation if notes are affected; individual history deletion still removes its selected record. Tests distinguish these operations.
- Preserve active concurrent offline check rows too. Daily projection and settlement expose one effective completion without discarding notes, amounts, or times from the additional history. A later whole-date uncheck still suppresses earlier checks that arrive after it.
- Derive legacy baseline identity only from check id, board id, and logical date, with fixed synthetic metadata. Legacy exports omit original command/stamp metadata, so importing-device values must never participate in the baseline identity.
- Cover every TS/native writer: create, edit, remove, Remove Latest, Undo, board deletion, import, sync, and Swift intents. The existing commands mutate independently, so ledger hooks attached only to create/remove would miss real user actions.
- Use immutable action/policy evidence for coin replay, including historical edits and delayed delivery. Check-award identity includes scope and source check action. Date moves emit `move_out`/`move_in`: only timely move-out revokes an old entitlement; neither date nor time edits mint rewards. Root changes emit separate old/new policy actions, never retroactive earnings. Check-coin close uses its board's logical-day boundary; bonus close uses the structural root's boundary. Usual times control neither.
- Include shared Swift cap/earning/reversal/bonus/adjustment coverage in T15/T16. Tests verify action, check, receipt, outbox, projection, and ledger atomicity.
- Restoring old checks does not mint new coins. Restored action and ledger evidence preserve the exported state; deterministic adjustment settles only the approved entitlements.

### Sync and import

- Version 1 binaries reject unsupported schema versions/types; they do not ignore version 2. The supported direction is v2 reading v1 with defaults. All peers must upgrade before using v2 data.
- Change TS records, inbound validation, engine ordering/merge logic, outbox support, and native CloudKit mapping together. Include habit-action records and immutable ledger behavior, rather than silently applying mutable-record last-write-wins rules to them.
- Test merged-only stack completion: each offline device can check a different required member, so no local check command necessarily sees the completed run. Sync reconciliation must create its single net entitlement.
- Restore anchors in two passes, validate the imported graph, and handle valid existing parents.
- Export omits deleted checks/rewards but retains their ledger history. Import cannot require all historical parents to appear as live exported records. Preserve title snapshots, action evidence, provenance, deterministic identities, and safe repeated restore.
- Narrowly allow the approved action/provenance export fields; unrelated command receipts, outbox, device state, and local notification details remain excluded.

### Stacks, widgets, alerts, and sample mode

- Separate structural stack identity from display order. A member before its anchor may display first without becoming the identity root. Usual time is presentation only.
- No required eligible members means incomplete and no bonus. Existing date-based activity periods decide eligibility, including inherited same-day archive/restore merging; there is no new exact intraday activity-history promise.
- A widget link to Add Check-In cannot uncheck Daily state. T7 adds a daily action destination that reads fresh state and handles note confirmation through the validated command; Count retains its fallback.
- Sample mode injects all effects and isolates navigation, not merely its database handle. Nested screens/forms remain under sample context. Real widget publication, native listeners, notifications, sync, import/export, intents, iCloud, and icon changes cannot be triggered by sample activity.
- Close disposes sample navigation/listeners/database, and reopening starts from the deterministic seed. Check both database checksum and prohibited adapter calls.

## Documentation cleanup

- Replace stale draft and pending-question wording with the actual approval and latest same-day correction.
- Remove obsolete starter-stack references; that feature remains removed.
- Historical design prose does not override the same-day product contract. Linked habits may express order without allowing checks on back-to-back dates to complete one run.
- Include claim title snapshot and miss-alert status in their eventual schema contracts; both were already required by user-visible behavior.

## Validation inventory

- Retain tests first, `bun run validate`, every core file at 100 percent, native checks, independent review, simulator evidence, checkpoint entries, and lowercase conventional commits.
- Migrations: fresh/latest database, every earlier fixture, immutable old checksums, correct defaults, and matching Swift acceptance at every version.
- Actions/Daily state: replay, concurrent check/uncheck, multi-check preserved history, manual date moves, notes, selective deletion, Undo ownership, TS/Swift matching evidence, and immutable action identity.
- Stacks: before/after siblings and chains, stable root, optional/archived members, empty required sets, exact same-date assignment, consecutive-date rejection, time edits, DST/time-zone changes without stored-date reassignment, leap day, current/longest streaks.
- Ledger: deterministic UUIDv5 identities, policy/provenance validation, cap, raw totals, atomicity, current/closed-date edits, bonus restoration, reward deletion, negative balances, and every writer.
- Offline sync: duplicate checks, check/uncheck races, duplicate awards/reversals, cap races, merged-only completion, offline double claims, out-of-order/repeated/delayed delivery, reconciliation idempotency, and two-device convergence.
- Export/import: v1 defaults, v2 round-trip including action evidence, CSV, repeat restore, forward anchors, missing historical parents, tombstone safety, and explicit forbidden-field scan exceptions.
- Visible flows: daily toggle/Undo, anchor picker, stack states, coin controls, reward create/claim/refusal, widget fallback, and sample navigation/close in light and dark.
- Alerts: controlled clock, two closed dates, date-based eligibility, denied permission without prompting, deduplication, native failure/retry, deep link, and pending count.
- Sample: full route navigation, fresh reopen, database checksum, prohibited-effect assertions, listener teardown, and real-app resumption.
- Final closure: doctor, iOS/Android exports, diff hygiene, required signed-device behavior, and actual multi-device sync evidence. Record unavailable external gates honestly; mocks do not prove device behavior.
