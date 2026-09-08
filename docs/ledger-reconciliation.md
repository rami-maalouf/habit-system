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
Once coins are enabled, validated policy JSON carries `version: 1`, `boardKind`, `earnsCoins`,
`coinCapPerDay`, `checkClosesAtUtc`, nullable `rootId`, sorted `requiredBoardIds`,
nullable `bonusClosesAtUtc`, and `bonusEnabled`. Empty required membership earns no bonus.
Capture policy and close instants in the acquired command transaction, after receipt replay;
later clocks do not rewrite them. Close instants are signed safe integers because valid
backdated history can precede the Unix epoch. A genuine backdated check is distinct from
an import or move-in; its captured close can precede its live action's creation timestamp.
Policies apply prospectively and never mint or remove past coins merely because settings change.
Targeted history removal and precise Undo remain available when sync delivers a board's
tombstone before its check tombstones. With no live board to describe, these two paths
append a null-policy removal rather than inventing current settings. Reconciliation still
uses each original earning action's immutable policy and close. This exception cannot earn
new coins; ordinary live-board actions capture canonical policy even when earning is off.
Scopes: `check:<boardId>:<logicalDate>` and, when a snapshot names a root, `bonus:<rootId>:<logicalDate>`.
A membership change writes each affected surviving root's post-edit policy. A root that
disappears or ceases to form a stack gets its old snapshot with `bonusEnabled=false`.
Do not disable a surviving stack merely because a member moves elsewhere. New/current
policies enable bonuses only when their required eligible set is nonempty.
Root controls use `kind=policy`, `boardId=rootId`, and the exact scope date. Their ordered
membership/close policy takes precedence over subsequent stale member check observations;
a stale offline check cannot re-enable retired membership on that same root/date.
Existing edited boards also record observations when kind, earning, cap, or day shift
changes. Topology-only detachment needs no redundant root-null member observation.
New rootless boards validate prospective settings but have no prior policy to replace.
Neither policy mints coins, changes checked state, nor removes an earlier valid award.
That award retains its source policy and close. A later genuine completion may use earlier
same-date member checks whose observations named a different root or no root.

Prepare old/new component snapshots before source writes. Consider their current logical
dates under both old/new shifts and sparse known scopes with open captured bonus evidence.
Do not enumerate unknown historical dates. Retirement applies to the recorded root/date,
not globally to an unseen date: replay can still discover an owed completion ordered before
the applicable policy change. All members of every bonus use its exact stored scope date.

## Economic replay and identities

Replay immutable actions in total order; resolve daily state as above and count state by check id.
A qualifying new completion earns only when the outstanding awarded count is below its cap.
Cap-blocked checks do not gain coins retroactively when another check is removed.
A check award belongs to its source action and check id. A later concurrent Daily token
can be the visible canonical completion without owning that award. Timely targeted removal
of the awarded token revokes its coin even if another token keeps the date checked; the
survivor does not inherit or gain a retroactive award. Removing only the non-awarded token
does not revoke the other's coin.
A timely uncheck removes its current entitlement; a later recheck is a new earning opportunity.
The configured cap applies to both kinds; Daily does not introduce a separate hard coin cap
of one. A late removal can retain an old award while a fresh genuine check earns under the
configured cap if the Daily active set is empty. Retained closed awards consume cap slots.
Cap reductions, kind conversion and earning-toggle edits never confiscate earlier valid
awards merely because policy changed. Each new genuine check uses its captured policy;
existing awards retain their own policy and source-bound reversal rules.
Date/time edits never mint check coins or bonuses. `move_in` updates completion but cannot earn.
`move_out` can revoke its original entitlement before captured close; after close it retains it.
For check coins, compare the uncheck's instant with the earned action's `checkClosesAtUtc`.
For bonuses use the completion's `bonusClosesAtUtc`; equality is already closed.
For earning date D, resolve the first actual crossing of the wall-clock threshold at the
following date's start-of-day minute, in the captured time zone. A missing threshold closes
at the first real instant after the gap; a repeated threshold closes at its first occurrence.
Once captured, a backward clock recrossing cannot reopen that earning. The check uses its
own board's shift and a bonus uses its structural root's shift. Conservative widget/display
expiry and informational times never supply an economic close.
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

### Canonical check-ledger protocol

Required-member policy capture evaluates the action's stored logical date against
current membership and stored activity periods, including start and excluding closed
end. It does not use the stack screen's current-date horizon. A midnight-based member
can already be on the following date while its 04:00-shifted root still displays the
previous date; that valid check retains its own date and eligible required-member
snapshot. The root's shift supplies the bonus close for that same stored date.

The shared TypeScript/Swift fixtures in `src/core/automations/fixtures/check-coins.json`
pin complete rows, hashes and ids. Canonical JSON has no insignificant whitespace and is
encoded as UTF-8. Preserve the bytes and case of existing immutable identifiers.
The UUIDv5 namespace is `4d96f757-73e0-561c-99b9-16b7ef2d1903`, also used by legacy
baselines. UUIDv5 uses SHA-1; evidence fingerprints and reconciliation keys use SHA-256.

Policy objects serialize keys in this order: `version`, `boardKind`, `earnsCoins`,
`coinCapPerDay`, `checkClosesAtUtc`, `rootId`, `requiredBoardIds`, `bonusClosesAtUtc`,
`bonusEnabled`. A habit action retains this canonical JSON as a string in its existing
canonical tuple. It is not embedded as an unordered object.

Ledger payloads serialize as an array beginning with `"habit-ledger-row-v1"`, followed by
`id`, `kind`, `delta`, `boardId`, `checkInId`, `runKey`, `rewardId`,
`rewardTitleSnapshot`, `reversesId`, `scopeKey`, `sourceActionId`, `reconciliationKey`,
`adjustsId`, `provenanceJson`, `logicalDate`, `createdAt`, `mutationStamp`, `deletedAt`.
All fields are present; unused references and `deletedAt` are null. Check and run-bonus
awards are exactly +1. Reversals and claims are negative; adjustments are signed and
nonzero. Every stored delta and creation timestamp is a safe integer, and creation
timestamps are nonnegative. Historical parent rows need not exist.

Check-award UUID names are the canonical tuple
`["habit-ledger-v1","check",scopeKey,sourceActionId]`. Reversal names are
`["habit-ledger-v1","reversal",awardId,removalActionId]`. Correction names are
`["habit-ledger-v1","adjustment",scopeKey,reconciliationKey]`. Cancellation names
are the literal string `cancel:<oldCorrectionId>`.

Provenance serializes as `{"version":1,"facts":[...]}`. Each fact is
`["habit_action"|"ledger_entry",id,lowercaseSha256Hex]`; facts are strictly sorted
lexicographically by their tuple and unique by type/id. Habit-action fingerprints
accept UUIDv4 live actions and UUIDv5 baselines; ledger fingerprints require UUIDv5
because UUIDv4 claims are excluded from evidence. The reconciliation key is the
SHA-256 of that full canonical provenance string. A correction copies its creation
timestamp and mutation stamp from the greatest `(mutationStamp,id,factType)` evidence
fact. A cancellation copies the old correction's metadata, proof and reconciliation
key. The strict-superset witness authorizes cancellation but never enters its payload.

Limits apply before acceptance: policy JSON 196,608 UTF-8 bytes, canonical ledger row
786,432 bytes, provenance JSON 524,288 bytes, and 4,096 facts per proof. Both byte and
count limits apply. Reject oversize evidence with a recoverable size failure; do not
truncate it. T19 must preserve these budgets across native transport and deferred
validation. A repository's intrinsic shape validation does not replace the reconciler's
validation of the source action, derived id, proof dependencies and economic delta.

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
