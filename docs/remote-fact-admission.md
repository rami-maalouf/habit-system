# Remote fact admission and check visibility

Accepted T19/T20 contract, supplementing [the product spec](../SPEC-habit-system.md) and
[ledger reconciliation](ledger-reconciliation.md). This defines storage and transaction
boundaries; helper names and module placement may follow the implementation. It adds no
earning formula, cause encoding, or reconciliation rule.

## Accepted storage and atomicity

Accepted `habit_actions` and `coin_ledger` contain only validated immutable facts.
Remote facts with missing dependencies, invalid bytes, conflicts, or insufficient scope
capacity remain outside those tables. Preserve accepted bytes permanently, including
ordinary rows valid on a partial replica but corrected by the full evidence union.

Admission, generated economic settlement, effective check visibility, projections,
accepted HLC observation, outbox changes, and the caller's page token or import receipt
commit in one exclusive transaction or all roll back. There is no accepted-but-unsettled
state and no persistent scope-work queue. Pending work is derivable from the inbox;
missing display payloads are legitimate absence, not economic dependency failures.

Restored facts retain their IDs, exact stored dates, source policies, closes and canonical
bytes. Admission never captures current policy for historical evidence. Claims retain
their immutable title/cost snapshot and do not require a live reward, current price, or
another affordability check.

## Migration 11 and local storage

Migrations 1-10 and their checksums remain unchanged. Migration 11 adds
`check_ins.state_suppressed INTEGER NOT NULL DEFAULT 1 CHECK (state_suppressed IN (0,1))`.
This bit is a local projection, excluded from explicit sync and export allowlists. It is
neither deletion nor legacy provenance. Default 1 fails closed for a raw payload whose
evidence has not arrived; every applied mutation still recomputes its affected scopes.

Migration 11 also adds `remote_fact_inbox`, without foreign keys to live parents:

| Field | Contract |
| --- | --- |
| `fact_type`, `fact_id` | `habit_action` or `ledger_entry`; trusted UUID identity with binary comparison and original case. |
| `payload_digest` | 64 lowercase hexadecimal SHA-256 characters. |
| `payload_encoding`, `payload` | `canonical_v1` existing canonical tuple, or `rejected_json_v1` bounded compact diagnostic JSON. |
| `payload_bytes` | Integer 1-786432, constrained to the UTF-8 byte length of `payload`. |
| `logical_date`, `scope_key` | Valid typed selectors, nullable when an invalid candidate cannot supply them. |
| `state`, `reason` | `pending/dependency`, `blocked_capacity/scope_capacity`, or `quarantined/invalid` or `quarantined/conflict`. |
| `enqueue_on_admission` | Local boolean, default 0; durable intent to upload an explicitly restored fact after eventual admission. |
| `first_seen_at` | Nonnegative safe integer timestamp; retained on duplicate staging. |

The primary key is `(fact_type, fact_id, payload_digest)`. Index retry by
`(state, logical_date, fact_type, fact_id)` and scope by `(scope_key, state)`.
An action's primary scope is its own board/date; a ledger row uses its declared scope,
or null for a claim. Derive additional root/member dependencies from bounded payloads.
Do not store a second unbounded proof/diagnostic column or turn malformed selectors into
broad queries. Dependency maps can be derived once per retry pass.

Canonical payloads use the established tuple bytes and digest. Rejected JSON uses a
diagnostic domain separator and never becomes economic evidence. Internal payloads and
rejection details are not UI text, logs, exports, or proof facts.

Compare bytes after every digest hit. Equal bytes are duplicates. A matching digest/key
with unequal bytes fails the whole operation closed. Different digests for the same
immutable ID remain separate variants. Never resolve immutable conflicts by HLC or
arrival order: preserve an already accepted row and quarantine the conflicting variant;
if none is accepted and multiple otherwise admissible variants conflict, quarantine all
of them. A conflicting variant does not erase an accepted matching dependency. This
preserves evidence and reports a conflict; it does not invent an automatic repair for
replicas that already accepted different bytes under one ID.

Exact duplicate staging ORs `enqueue_on_admission`, changes no canonical bytes, and
preserves first-seen time. Sync-origin facts do not echo. Explicit restore intent survives
restart and later admission by another caller. Generated deterministic rows enqueue once.

## Explicit legacy evidence step

Migration 11 includes a named, versioned derived step establishing legacy evidence,
settlement and visibility. Its descriptor participates in the migration checksum;
unknown descriptors fail closed. Preserve the checksum serialization of migrations
without a derived step. Do not hash callback identity or conceal semantic work in a
post-migration bootstrap repair.

Execute the step after DDL and before `schema_migrations` and `user_version` markers,
inside the existing exclusive migration transaction:

1. Bulk-read existing nondeleted raw checks and accepted exact-date token evidence.
   Append a deterministic baseline only where that token has no action in its exact
   board/date. Existing targeted removal prevents synthesis. A date-wide clear may
   coexist with a new baseline, but the baseline ranks before the clear and stays hidden.
   Never baseline raw tombstones.
2. Use the existing baseline UUIDv5 tuple, fixed zero creation time and baseline stamp,
   null command and null policy. Queue each new baseline once using the migration's
   acquired enqueue time. Do not create a check, UUIDv4 source, receipt, HLC advance, or
   restore-time policy.
3. Settle existing ledger scopes and newly affected legacy scopes to the existing
   reconciliation fixed point. Existing ledger rows remain byte-identical. A legacy-only
   store has no genuine earning cause and gains no ledger rows. Mixed older stores may
   need deterministic corrections justified by their existing genuine evidence.
4. Derive suppression strictly from accepted action tokens intersected with each current
   raw row's board/date. No implicit legacy token remains for runtime code to infer.
   Only then publish migration markers.

Pass the existing full hashing port through bootstrap and migration: SHA-1 for baseline
UUIDs and SHA-256 for settlement. Core must not import platform hashing or silently supply
an alternate hasher. Capture migration enqueue/applied time after transaction acquisition.
Existing raw payload fields, timestamps and stamps remain unchanged. Failure in hashing,
storage, settlement or visibility rolls back DDL, new facts, outbox, local bits and markers.

The native executor never migrates. Its schema/checksum gate changes with migration 11
and cannot observe a completed marker before this step finishes. App bootstrap, direct
migration tests and both native fixture migration executors must execute the versioned
step or consume an actually migrated database. SQL-only fixture replay is insufficient;
preserve step descriptors. Tests supply hashing before bootstrap and reuse the same port
for commands. Historical fixture builders targeting only versions 1-10 remain unchanged.

After migration, baseline authority exists only at validated legacy boundaries: an
actually applied version-1 wire check, version-1 own-export import, or CSV compatibility
import. Deferred v1 records retain their original wire version until application. Ignored
older mutable versions do not create baselines for the ignored date. Compatibility
admission follows the applied row and is idempotent against existing raw IDs/evidence.

Ordinary app/native commands, board edits, and settlement must stop inferring baselines
from action-less raw rows, including existing raw `legacyChecks` discovery paths. A
version-2 payload or incomplete v2 import never gains baseline authority, even after a
restart. The suppression bit cannot grant that authority.

The accepted import rule permits deterministic corrections to existing coins. Restored
checks never become fresh earning actions. For example, a distinct legacy token can
supersede an existing Daily award: preserve its +1 row and append the justified -1
adjustment atomically. Positive corrections or regenerated rows likewise require genuine
preexisting source evidence, not a baseline treated as a new check. This applies both to
legacy admission and migration cleanup of an already inconsistent older ledger scope.

## Bounds and failure rules

Retain at most **32768 inbox variants** and **67108864 aggregate UTF-8 payload bytes**,
including quarantined and capacity-blocked variants. Sum checked byte lengths, not string
lengths. Exact duplicates consume no extra budget. Plan occupancy after proposed
promotions/removals, before final writes. There is no eviction or truncation.

Existing limits remain separate: policy 196608 bytes, canonical action/ledger record
786432 bytes, provenance 524288 bytes, and 4096 ordinary evidence facts per scope/proof.
Count actions and ordinary economic evidence after required deterministic rows are
planned; claims and adjustments are excluded from ordinary E. A multi-date transaction
does not share one scope budget. Retain otherwise supported facts blocked by a scope
budget; unrelated complete components may commit.

Exceeding a global inbox bound, an individually unretainable payload bound, or a trusted
outer-envelope requirement aborts the entire page/file transaction. Persist no token,
import receipt, raw merge, outbox or partial admission. Transport/file decoders also bound
their input before admission. Database, hashing and cancellation failures propagate;
they are not invalid-fact quarantine.

Whole-operation failures must escape the transaction before mapping to a recoverable
domain error. Returning a normal failed command result inside a receipt-writing wrapper
would incorrectly advance the receipt boundary. Identifiable bounded fact defects can
instead commit to quarantine with the successful page/import summary. Report final
pending, blocked and quarantined counts distinctly from admitted or skipped records.

## Source-neutral admission

One shared boundary accepts normalized candidates containing type, trusted ID, unknown
payload and enqueue intent, plus the caller's affected old/new check scopes and explicit
root scopes. It receives the acquired transaction, acquired time and hashing port, with
no network/account dependency. Return unique admitted, duplicate and generated identities,
accepted mutation stamps, affected scopes and final inbox counts.

The caller owns mutable LWW merges, old/new scope capture, cancellation, accepted HLC
observation, projections and token/receipt completion. Observe no immutable stamp from a
pending or quarantined candidate. Admission owns immutable validation, staging, economic
settlement and saved enqueue intent. A zero-input drain retries pending work, including
with iCloud disabled, and stops when no actual progress unlocks another component.

Promotion follows these boundaries:

1. Validate bounded identity, explicit fields, canonical policy/proof bytes and baseline
   identity. Classify the whole incoming identity group before promotion so batch order
   cannot select a conflicting winner.
2. Bulk-load accepted exact-scope evidence and explicit dependency IDs. Combine with
   nonconflicting staged candidates in memory, including pending root policies and
   exact-date reverse membership for detached/former/null-root member actions. Avoid
   all-history scans, per-member/date queries and unchecked insertion into accepted SQL.
3. Resolve typed references with visited identities. Ordinary economic links require
   their expected role and the same scope/date. Action evidence uses the exact date and
   retains approved former/null-root membership. Proofs require exact type/ID/hash and
   exclude claims/adjustments. Present wrong-role or wrong-hash evidence is invalid;
   absent dependencies wait.
4. Validate ordinary causes before full-scope replay. Recover a bonus award's committed
   source/control before enforcing its membership envelope. With root-null G and absent
   admitting control C, W remains pending; G may still enter its own check scope.
5. Validate each correction only against its declared, self-contained subset. Listed
   missing dependencies wait; a complete listed subset omitting a necessary cause is
   invalid. Validate cancellation using its parent and an available strict superset of
   ordinary E. Never borrow a full-union candidate cache for a subset proof. Legitimate
   deterministic rows planned by replay may join the same atomic available evidence;
   do not fabricate an award merely to satisfy a proof reference.
6. Use existing check/bonus reconcilers to plan the complete result, then check canonical
   conflicts and budgets before live writes. Isolate invalid candidates and dependents
   without declaring unrelated valid facts invalid. Append complete admitted closures,
   generated rows and outbox, update/remove inbox variants, and retry actual unlocks.
7. Recompute effective visibility and projections for all affected old/new scopes before
   the caller commits accepted stamps and its token/receipt. A later raw payload/parent
   arrival supplies its scopes; absent display content requires no persistent work job.

Reuse existing action/ledger canonicalizers, policy/provenance parsers, typed cause
validation and pure reconcilers. Extract only the current per-candidate check ordinary
and correction/cancellation validation needed for classification. Preserve all existing
UUIDs, formulas, subset rules and shared TS/Swift bytes. Narrow catch handling must retain
size, hashing and cancellation failures rather than convert every thrown error into
quarantine. A present adjustment requested as ordinary proof evidence is invalid, not
missing merely because an ordinary-only lookup excludes it.

## Raw payloads, effective reads and export privacy

Visible checks are accepted active tokens intersected with current nondeleted raw rows
on the same board/date. Preserve all surviving tokens and payloads; Daily binary display
does not prune concurrent or converted Count history. LWW still selects the current raw
row, including its date. Historical economic replay retains immutable per-date evidence;
do not invent cross-date cancellation facts to force it to match display.

User-facing history, notes, statistics, stacks, widgets, native Today/Remove Latest and
command selection use effective rows. Raw access remains necessary for sync LWW/upload,
ID existence/idempotency, and real board deletion of every raw live child, including
suppressed children. Use explicit column allowlists so local state never enters the wire.

Export only effective-live check payloads, with every surviving payload, plus complete
accepted note-free action and ledger evidence independent of live parent presence.
Do not export suppressed note text, raw tombstones, inbox data or local suppression state.
An action may reference an omitted check/board; a claim may reference a deleted reward
and retains its intentionally immutable title snapshot. Missing display payloads do not
make that economic evidence invalid.

V2 import preserves immutable IDs and bytes without remapping absent parents. Existing
raw tombstone IDs prevent resurrection. An incomplete v2 payload remains suppressed until
accepted action evidence arrives. Supported v2 export follows migration 11 and includes real
legacy baselines; export itself is read-only. This is restoration of effective content
and accepted history, not a promise to reproduce every suppressed transport payload.

## Required acceptance vectors

- Upgrade empty, v5 and mixed v10 stores; pin unchanged checksums 1-10. Preserve legacy
  payload bytes, deterministic baseline/outbox identity and no fresh earnings. Settle an
  existing baseline/award mismatch even when no new baseline is required.
- Fail after later baseline, outbox, settlement or visibility writes; prove full migration
  rollback and that another connection/native gate cannot observe partial schema 11.
- Replay v2 payload-before-G across restart, local Daily Check, board policy edit and
  native mutation. No baseline is inferred; later G keeps its genuine earning identity.
  A premature baseline for G's own token must be caught because it changes target 1 to 0.
- Apply move-out/payload/move-in permutations, concurrent date moves and later note edits.
  Display follows the winning raw date and active tokens; move-in never earns and a note
  update cannot revive a cleared token.
- Defer v1 payload until parent arrival, then create one baseline. Ignore an older v1 date
  without stray evidence. Public export/parse/import of a distinct legacy Daily token
  preserves an existing +1 row and atomically appends its justified -1 correction.
- Stage exact duplicates, same-ID variants, missing dependencies and digest collisions;
  preserve accepted bytes and restart-safe enqueue intent. Empty/offline drains unlock
  complete components without echoing sync sources or retrying quarantined payloads.
- Deliver root-null G, W and C in every order; recover the same committed award when C
  arrives. Test self-contained correction subsets, wrong roles/hashes, repeated/cyclic
  references, detached members and valid raw rows corrected only by the full union.
- Exercise exact byte/count limits, scope blocking and global rollback with no token or
  receipt advancement. Hashing/abort faults must not quarantine otherwise valid facts.
- Export after a clear plus a higher-stamp raw note update: cleared text is absent while
  complete immutable evidence remains. Import with omitted/deleted parents and duplicate
  IDs preserves history, snapshots and effective absence without resurrection or minting.
