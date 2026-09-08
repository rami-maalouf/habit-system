# Pre-T2 plan review

Date: 2026-09-08. Scope: approved product spec, inherited behavior, T2 through T24, and the existing implementation boundaries.

Status: review proposal. T2 and later implementation has not begun. Three product questions are pending with Rami; this document does not approve their answers or a revised plan.

Baseline reported by the coordinating agent: 570 Jest tests, 51 Swift tests, and 9 plugin checks green.

## Product decisions pending

1. **How untimed checks join an overnight run.** Daily checks store no occurrence instant, but runs can start in the evening and finish the next morning. Equating logical date with run date splits Tuesday bedtime from Wednesday waking. Pending choice: assign untimed checks by the habit's usual time, or use actual tap time. Recommendation: use usual time for untimed checks, explicitly define the fallback when it is absent, and retain exact instants for timed count checks. Combine usual time with the check's logical date and board start-of-day rule before applying the stack boundary. This needs no new column. Actual tap time needs a contract for historical entry, import, and time-zone changes; `createdAt` alone is insufficient. Sources: `SPEC-habit-system.md:37,157`; `src/core/domain/commands.ts:491`.

2. **Whether re-completing a run restores its bonus.** The current contract allows one bonus per run and a negative reversal, but provides no way to restore that bonus after check -> complete -> uncheck -> recheck. Pending choice: restore the bonus on re-completion or leave it reversed. Recommendation: restore the net entitlement with an explicit append-only compensation rule. Define the allowed row shapes and idempotency before the ledger migration. Sources: `SPEC-habit-system.md:176-194`; `tasks/todo.md:116`.

3. **How conflicting offline actions affect checks and coins.** Two devices can independently check the same daily habit, exceed a cap, award the same run, or reverse the same award. Set union converges rows but does not enforce those product rules. Pending choice: latest action wins with ledger compensation, or online finalization. Recommendation: latest action wins for daily state with deterministic compensation of ledger entitlements. This changes the current no-reconciler architecture and needs explicit conflict, identity, and compensation rules. Offline double claims must still retain the approved negative-balance behavior. Sources: `SPEC-habit-system.md:111,192-196`; `tasks/plan.md:29`.

Do not settle these choices by relying on a local unique index: it cannot coordinate two offline databases and can instead turn a duplicate into a sync failure.

## Migration and sequencing proposal

- **Split migrations by dependency rather than freezing every future table in version 6.** Proposed T2: board and settings fields, widget kind projection support, entity defaults, repositories, and the matching Swift schema gate. Add ledger, rewards, and miss-alert migrations with their respective features after their contracts are settled. Each migration remains atomic and checksum-tested. This is a proposed amendment to the approved single-migration rule, not an existing permission.
- Never edit migration versions 1 through 5. Every new migration updates the Swift executor's schema version and checksum map in the same commit.
- Board creation inputs must distinguish the new-form default of Daily from legacy imports, existing boards, and compatibility callers that remain Count. Update every typed construction site and fixture explicitly.
- The plan promises shippable slices but postpones new-field sync and export until T19/T20. Either deliver serialization support alongside each slice or mark intermediate builds as development checkpoints and prevent partial data from reaching real multi-device use. Choose and record the sequencing before enabling new features.
- T7 and T8 share contract fixtures. Expand their integration gate so changed fixtures cannot leave the native suite red between commits.
- Split large tasks into bounded substeps with the same acceptance scope. T18 already calls for this; T2, T19, and T23 also cross more boundaries than their listed files suggest.

## Required engineering corrections

### Coins and daily mutations

- Add Earn Coins and Daily Coin Cap controls, validation, persistence, and accessible form coverage. No current UI task exposes them, and earning defaults to false. Count boards can earn too; remove the plan's daily-only wording. Sources: `SPEC-habit-system.md:170`; `tasks/plan.md:29`; `tasks/todo.md:34,81,110`.
- Apply coin and run effects through every writer: app creation, removal, Remove Latest, Undo, date/time edits, board deletion, Swift intents, imports, and sync. Specify which bulk or restore paths preserve historical ledger rows without minting new earnings. The existing removal commands write independently. Sources: `src/core/domain/commands.ts:423,553,623,653,680`.
- Resolve the daily-history exception explicitly: switching Count to Daily preserves multiple old check-ins. Recommendation: unchecking tombstones every live check-in on the selected date in one transaction, with confirmation for retained notes; individual history deletion still removes one selected record. Date edits, import, and sync must respect the same daily-state contract.
- Resolve toggle state and apply its mutation inside one command transaction. A read outside the transaction followed by another command can race a second writer.
- Add Swift coin, cap, reversal, and run-bonus contract cases to the coin slice. T8 only adds daily semantics; later TS-only coin work would leave Shortcuts behaving differently.

### Sync and import

- Replace the claim that existing version 1 peers ignore version 2. Native mapping requires version 1 and known types; TypeScript validates the same boundaries. Version 2 must read valid version 1 data with defaults, while mixed-version behavior needs a truthful minimum-version policy. Sources: `modules/ripples-apple/ios/CloudKitRecordMapping.swift:84,137`; `src/core/sync/inbound-validation.ts:46,383`.
- Update TS records, inbound validation, engine ordering/merge behavior, outbox support, and Swift mapping together. New ledger entries require immutable-row handling rather than inheriting mutable-record last-write-wins behavior silently.
- Restore anchors in two passes, validate the complete imported graph, and preserve valid references to already-present boards.
- Export excludes deleted checks and rewards, but their ledger entries must survive and round-trip. Do not require every historical ledger reference to resolve to an exported live parent. Preserve claim title snapshots and ledger identity on repeated import; never recreate earnings from restored checks.
- Ensure a run completed only by merged offline checks receives the chosen bonus entitlement, and a remote uncheck applies the corresponding compensation once.

### Stacks, widgets, alerts, and sample mode

- Separate stable stack identity from display order and run-time source. With "A before B," A is first but still has a board anchor, contradicting the stated root definition. Define deterministic before/after ordering, root identity, and preset/text behavior. Source: `SPEC-habit-system.md:153-157`.
- Define eligibility when there are no required active members, when membership changes, and when the root is archived. Avoid granting a bonus for an empty set solely because `every([])` is true.
- Existing activity periods hold dates and merge same-day archive/restore. They cannot prove activity for every instant of a run. Clarify date-based eligibility versus precise activity history before implementing strict whole-window missed alerts. Sources: `SPEC-ripples-product.md:138`; `SPEC-habit-system.md:225`.
- The widget currently deep-links to Add Check-In, which cannot uncheck a daily board. T7 needs a daily action destination that resolves fresh state and handles note confirmation. Include route/provider changes and preserve the approved fallback. Source: `src/platform/widgets/ripples-boards-widget.tsx:77`.
- Sample mode needs adapter and navigation isolation beyond a replacement database. The provider directly publishes widgets and registers native listeners; ensure every sample screen retains sample context, including nested forms and settings. Sources: `src/features/product-store/provider.tsx:181,197,219`; `tasks/todo.md:164`.

## Documentation corrections requiring no new product decision

- Update the plan's stale draft status to reflect existing approval, while keeping this amendment proposal separate.
- Remove FORK.md's obsolete starter-stack reference; that feature was explicitly removed.
- Correct the copied habits-v2 wake anchor to "after bed" for the approved single stack. The resolved spec decision wins over the stale copied design text.
- Include `rewardTitleSnapshot` and miss-alert status in their eventual schema contracts; both are required by existing section 4 behavior even though their field listings are incomplete.

## Validation inventory for the revised plan

- Preserve the current gates: tests first, `bun run validate`, every core file at 100 percent, native checks, independent review, checkpoint entry, and one lowercase conventional commit per completed task.
- Migrations: every earlier fixture, fresh database, defaults, unchanged old checksums, and Swift schema acceptance for each version.
- Daily state: create/retry/toggle/Undo, historical multi-check days, manual date edits, note confirmation, import, and matching Swift fixtures.
- Runs: before/after chains and siblings, optional/archived members, empty required sets, overnight assignment, historical entry, both DST changes, time-zone changes, leap day, and current/longest streaks.
- Ledger: atomicity, cap, current-window and closed-window removal, re-completion, reward deletion, negative balance, and all mutation entry points.
- Offline sync: duplicate same-day check, conflicting check/uncheck, duplicate award/reversal, cap race, run completed by merged checks, double claim, out-of-order delivery, retries, and two-device convergence.
- Export/import: version 1 defaults, version 2 round-trip, Ripples CSV, repeated restore, forward anchors, missing historical parents, and forbidden-key scans.
- Visible flows: simulator evidence for daily toggles, anchor picker, stacks, coin controls, claim/refusal, widget fallback, and sample navigation/close in light and dark.
- Alerts: controlled clock, both closed windows, activity eligibility, denied permission without prompting, scheduling deduplication, deep link, and pending count.
- Sample isolation: database checksum plus checks that no real widget, notification, sync, import/export, icon, or intent adapter was called.
- Final closure: doctor, iOS/Android exports, signed-device requirements, and actual multi-device sync evidence. Record any unavailable external gate honestly rather than treating mock coverage as device evidence.
