# Immutable actions and ledger reconciliation

Approved engineering contract under Rami's 2026-09-08 authorization of the pre-T2 review fixes.
This supplements SPEC-habit-system.md. Stacks group exactly one stored logical date.
## Immutable evidence

T3 migration 7 adds `habit_actions`: `id TEXT PRIMARY KEY`, `command_id TEXT`,
`board_id TEXT NOT NULL`, `logical_date TEXT NOT NULL`, `check_in_id TEXT`,
`kind TEXT NOT NULL`, `created_at INTEGER NOT NULL`, `mutation_stamp TEXT NOT NULL`,
`policy_json TEXT`. Live ids and command ids are UUIDv4; synthetic baseline ids are UUIDv5.
Command ids are not unique: a date move writes old-date `move_out` and new-date `move_in`.
Index `(board_id, logical_date, mutation_stamp, id)`. Actions are never updated or tombstoned.
Kinds: `check`, `uncheck`, `move_out`, `move_in`, `policy`, `baseline`; policy never toggles.
A baseline retains a legacy active check. Its UUIDv5 name is the canonical JSON tuple
`["habit-baseline-v1", checkId, boardId, logicalDate]`, under namespace
`4d96f757-73e0-561c-99b9-16b7ef2d1903`. Its `createdAt` is always 0,
its stamp is `00000000000000-00000-baseline`, and command/policy are null.
This metadata is synthetic; original event times remain on the check-in. It never depends on
import time, importer identity, or fields absent from a legacy export.
Baselines rank below live actions; no matching evidence means unchecked. Reimport is idempotent.
Replay into an active check-id set, baselines first and then live actions by `(mutation_stamp, id)`.
`check` and `move_in` add their check id; `move_out` removes only its check id.
An `uncheck` with a check id removes only that id; an `uncheck` with null check id clears the date.
Daily state is checked when that set is nonempty, with the latest remaining completion canonical.
Thus a whole-day uncheck wins over earlier checks, while a later check restores completion.
The canonical completion identifies replay state. A local no-op check returns an existing row using
inherited history order, with `created=false`; its receipt cannot authorize Undo. It adds no
check/action/outbox mutation and does not advance the hybrid clock.
Materialize that state in check-ins atomically; merge cleanup never manufactures user unchecks.
Preserve every active token's check-in, including concurrent offline checks and retained Count history.
Daily projections and entitlement replay expose one effective completion without pruning active history.
A whole-day clear suppresses earlier checks even when those rows arrive after the clear.
Keep count history and note contents in check-ins; actions contain no titles, notes, or amounts.
Daily uncheck applies to the board/date; count uncheck targets its `check_in_id`.
Single-history deletion and Undo target only their check id. Switching kind changes the projection,
preserves retained history, and never reinterprets earlier targeted removals as whole-day clears.

`policy_json` is null in T3 and for legacy baselines; these facts cannot invent historical coins.
Once coins are enabled, validated version-1 policy JSON carries `boardKind`, `earnsCoins`,
`coinCapPerDay`, `checkClosesAtUtc`, nullable `rootId`, sorted `requiredBoardIds`,
nullable `bonusClosesAtUtc`, and `bonusEnabled`. Empty required membership earns no bonus.
Capture policy and close instants in the command transaction; later clocks do not rewrite them.
Policies apply prospectively and never mint or remove past coins merely because settings change.
Scopes: `check:<boardId>:<logicalDate>` and, when a snapshot names a root, `bonus:<rootId>:<logicalDate>`.
A root change writes two policy actions: old snapshot with `bonusEnabled=false`, new with true.
The old scope retains prior entitlement but cannot earn new bonuses; neither policy mints coins.
All bonus members use the exact scope date. Future genuine completions can earn under the new scope.

## Economic replay and identities

Replay immutable actions in total order; resolve daily state as above and count state by check id.
A qualifying new completion earns only when the outstanding awarded count is below its cap.
Cap-blocked checks do not gain coins retroactively when another check is removed.
A timely uncheck removes its current entitlement; a later recheck is a new earning opportunity.
Date/time edits never mint check coins or bonuses. `move_in` updates completion but cannot earn.
`move_out` can revoke its original entitlement before captured close; after close it retains it.
For check coins, compare the uncheck's instant with the earned action's `checkClosesAtUtc`.
For bonuses use the completion's `bonusClosesAtUtc`; equality is already closed.
A late uncheck still changes visible history but does not revoke that historical entitlement.
Duplicate/cap corrections survive close. Never gate reconciliation by current time; replay derives target `T`.
Each earning incomplete-to-complete transition needs a genuine check cause: its final required action
plus its policy fingerprint. A fresh transition after timely uncheck can earn the bonus again.
Commands and sync mint a missing economic row for that cause before calculating corrections.
This includes a completion visible only after merging separate devices' member actions.

T15 migration 8 adds the ledger fields in the spec, including `scope_key`, `source_action_id`,
`reconciliation_key`, `adjusts_id`, `provenance_json`, and `reward_title_snapshot`.
Derived ids use UUIDv5 under one fixed fork namespace. Check-award ids derive from scope/source action;
bonus ids from scope/completion cause; reversal ids from their award and immutable removal cause.
User claims remain UUIDv4 and outside earning scopes. Command receipts prevent local replay.
Canonical payloads use fixed key order, sorted unique ids, integers, explicit nulls, and UTF-8.
Generated timestamps/stamps derive from source facts, never the reconciling device's clock.
Equal ids require byte-equivalent canonical payloads; mismatches fail validation and never overwrite.

## Corrections and convergence

For one scope, `E` contains all its immutable action/policy facts and ordinary economic rows.
Exclude claims and every adjustment. Fingerprint each fact by type, id, and canonical payload hash.
Let `B` be the sum of ordinary check/bonus/reversal deltas in `E`; replay derives target `T`.
Append a signed adjustment `D(E) = T - B`, keyed by scope and SHA-256 of sorted fingerprints.
Omit zero adjustments. Store the full sorted provenance; adjustment ids are deterministic UUIDv5.
An old adjustment is obsolete only when its provenance is a strict subset of available `E`.
Append exactly one cancellation, id UUIDv5(`cancel:<oldId>`), `adjusts_id = oldId`,
and delta `-old.delta`. Its metadata derives from the old row, independent of the witness device.
Never cancel a cancellation. Never include adjustments in `E` or use arrival order as evidence.
Wait for every referenced fact and verify every hash before applying a correction or cancellation.
Persist missing dependencies in deferred sync; reject invalid types, duplicate fingerprints,
wrong scope, malformed digests, unsafe integers, wrong derived ids, or inconsistent deltas.
Bound parsing by the transport's record-size budget; never truncate provenance or partially apply.
An oversized proof must produce an explicit recoverable size failure, not an incorrect balance.
Reconcile after commands and after inbound facts or corrections, inside the exclusive transaction.
At convergence every obsolete correction cancels once; one full-set correction remains: `B+D=T`.

Two offline devices each seeing two duplicate awards have `B=2,T=1,D=-1` with different proofs.
After union: `B=4`, old corrections `-2`, their cancellations `+2`, new correction `-3`: balance 1.
For overlapping proofs `{a,b}` and `{b,c}`: `B=3`, old `-2`, cancellation `+2`, final `-2`: 1.
Same-proof corrections/cancellations share ids and contribute once. Claims simply add their negatives.
Earned total stays the sum of positive rows; spent total stays the absolute sum of negative rows.

## Delivery gates

T3 adds actions; T15 ledger; T18 rewards; T21 local miss alerts. Each updates Swift's schema gate.
Shared TS/Swift fixtures cover daily LWW, baselines, non-earning edits/moves, cap races, restoration,
late uncheck, split completion, repeated/overlapping corrections, missing proofs, and malformed ids.
Test retired/new root policies, delivery permutations, retries, import replay, and negative double claims.
