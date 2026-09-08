# Implementation Plan: Habit System

Spec: `SPEC-habit-system.md` (approved 2026-09-08). Inherited specs: `SPEC-native-foundation.md`, `SPEC-ripples-product.md`.

Status: Phase 2 draft for Rami's review. Implementation starts only after this plan and `tasks/todo.md` are approved.

Author: Fable 5.1. Ripples planning artifacts are archived under `tasks/ripples/`.

## Overview

Turn the Ripples fork into the habit system in five sequential slices and two parallel tails. Every slice leaves the app shippable: `count` boards keep working exactly as Ripples at every checkpoint, and each new capability is usable on its own before the next one starts. The order follows the data dependency: a board must be able to be `daily` before it can be anchored, anchored before stacks exist, stacked before a run bonus makes sense, earning before rewards can be claimed. Miss alerts and sample mode depend on everything above and run in parallel at the end.

## Inputs observed in the repository (2026-09-08)

- Schema at version 5 (`src/core/persistence/schema.ts`, `latestSchemaVersion`). Migrations are a statement list per version with checksum tests.
- Commands in `src/core/domain/commands.ts` run through `runCommand` with idempotency receipts; `createCheckIn`, `removeCheckIn`, `removeLatestCheckIn`, `undoCreatedCheckIn` are the check-in paths. Reminder commands live in `reminder-commands.ts`.
- Queries in `src/core/domain/queries.ts`; the home card reads `getHomeBoardProjection`; the widget reads `getWidgetProjection` over the `widget_board_rows` projection in `src/core/persistence/projections/widget-rows.ts`.
- Sync records are declared per entity in `src/core/sync/records.ts` (`SPECS`, `SYNC_SCHEMA_VERSION = 1`). The Swift CloudKit mapping rejects unknown fields and types before writing, so every new synced column and type needs a Swift-side change too.
- Export is version 1 in `src/core/export/serialize.ts`; import parsers in `import-parsers.ts`.
- The App Intents executor exists twice: TypeScript in `src/core/automations/contract.ts` and Swift in `modules/ripples-apple/ios`, both driven by `src/core/automations/fixtures/intent-contract.json`.
- The plugin derives App Group and CloudKit container from `ios.bundleIdentifier` (`modules/ripples-apple/plugin/index.js` lines 42 to 53). The zone name is a Swift constant (`CloudKitTransport.swift` line 21).
- Home card renders fourteen days (`src/features/boards/board-card.tsx`, `seven-day-strip.tsx` is the widget strip). Settings screens live in `src/features/settings/`, routes in `src/app/settings/`.
- Gates: `bun run validate` (570 tests, core at 100 percent), `bun run test:native` (50 Swift tests, 8 plugin checks), `bunx expo-doctor` 21/21.

## Architecture decisions

- **One migration, version 6, carries every schema change in this spec.** Migrations are sequential and each version runs once; splitting the fork's columns across several versions would only multiply fixtures. Version 6 adds board columns, settings columns, `coin_ledger`, `rewards`, `miss_alerts`, and their indexes. It lands first so every later slice only adds code.
- **Stacks and runs are pure functions over boards and check-ins.** `src/core/domain/stacks.ts` takes an array of boards plus a check-in window and returns stacks, runs, and completeness. No table, no cache. Queries call it; analytics call it; the run-bonus command calls it inside the same transaction as the check.
- **The ledger is written inside the check-in transaction.** Earning, claw-back, and the run bonus are consequences of `createCheckIn` and `removeCheckIn` on `daily` boards, computed by pure rules in `src/core/domain/coins.ts` and written by the same exclusive transaction. There is no separate "award coins" command and no reconciler for coins.
- **Toggle is two existing commands plus one dispatcher.** `toggleDailyCheckIn` reads today's check-in and calls `createCheckIn` or `removeCheckIn`. Widgets and intents keep calling the underlying commands; only the UI uses the dispatcher.
- **New synced types are additive.** `SYNC_SCHEMA_VERSION` becomes 2. A version 1 peer ignores unknown types and fields. The Swift mapping learns the new types and columns in the same task as the TypeScript records so the fixture round-trip test covers both.
- **Sample mode reuses the real provider with a different database handle.** The product-store provider already takes a database dependency. Sample mode constructs an in-memory database, runs migrations, seeds it, and mounts the same route tree in a modal with adapters swapped for no-op fakes.
- **Identifiers change first.** Nothing is built or run on a device under Ripples' identity. `fork-identity` is task 1.

## Dependency graph

```
T1 fork identity
   |
T2 schema v6 + entities
   |
T3 daily kind domain ---- T4 board form kind control
   |                          |
T5 home card toggle -------- T6 heatmap daily states
   |
T7 widget + TS intents daily ---- T8 Swift intents daily
   |
   [checkpoint A: daily habits]
   |
T9 preset anchor settings
   |
T10 anchor domain rules ---- T11 anchor picker UI
   |
T12 stack derivation (pure)
   |
T13 stack analytics ---- T14 stacks screens
   |
   [checkpoint B: stacks]
   |
T15 ledger repository + coin rules + earning/claw-back in check-in commands
   |
T16 run bonus
   |
T17 coins queries, balance pill, coins + history screens
   |
T18 rewards entity, commands, claim, screens
   |
T19 sync v2 (TS records + Swift mapping)
   |
T20 export v2 + import v1/v2
   |
   [checkpoint C: coins and rewards]
   |
T21 miss alerts ---------------- T22 sample generator + in-memory db
                                    |
                                 T23 sample mode modal
   |
T24 rename cosmetics
   |
   [checkpoint D: spec success criteria]
```

## Phases

### Phase 0: fork identity
- T1 apply the FORK.md identifier table and create the EAS project.

### Checkpoint 0
- `bun run test:native:config` passes with the new identifiers; `bunx expo-doctor` 21/21; `bunx expo prebuild --platform ios --clean` succeeds; generated `ios/` stays untracked; simulator build runs under the new bundle id.

### Phase 1: daily habits
- T2 migration version 6 and entity types.
- T3 `daily` kind domain rules and the toggle dispatcher.
- T4 board form: Kind control, hidden amount and time controls.
- T5 home card for `daily` boards: fourteen binary cells, checks this week, streak, toggle.
- T6 heatmap two-state rendering and labels for `daily` boards.
- T7 widget rows and TypeScript intents for `daily` boards, fixture cases.
- T8 Swift intents executor for `daily` boards against the same fixtures.

### Checkpoint A
- A `daily` board can be created, toggled from Home, widget, and Shortcuts, shows correct labels; `count` boards unchanged; migrations from every fixture pass; `bun run validate`, `bun run test:native`, Argent evidence, independent review.

### Phase 2: stacks
- T9 preset anchor minutes in settings, command, Settings > Anchors screen.
- T10 anchor fields, validation (self, cycle, consistency), `deleteBoard` clears dependents.
- T11 anchor picker bottom sheet and usual-time control in the board form.
- T12 stack derivation, run windows, completeness (pure, exhaustive tests).
- T13 stack analytics: complete runs per week, run streak, per-member counts, stack heatmap data.
- T14 `/stacks` and `/stacks/[rootId]` screens, Boards header icon.

### Checkpoint B
- Rami's six habits entered by hand form one stack with the right run window across midnight; stacks screens render; `bun run validate`, Argent evidence, independent review.

### Phase 3: coins and rewards
- T15 ledger repository, coin rules, earning and claw-back inside `createCheckIn` and `removeCheckIn`.
- T16 run bonus and its reversal.
- T17 ledger queries, balance pill, `/coins`, `/coins/history`.
- T18 rewards entity, commands, claim with snapshot, `/coins/rewards/*` screens.
- T19 sync schema 2: ledger and rewards records, new board and settings fields, Swift mapping.
- T20 export version 2 and import of versions 1 and 2.

### Checkpoint C
- Two simulators converge on a balance after offline ledger writes including a double claim; export round-trips; `bun run validate`, `bun run test:native`, Argent evidence, independent review.

### Phase 4: tails
- T21 never-miss-twice reconciler, `miss_alerts` table, notification, Settings count.
- T22 deterministic sample generator and in-memory database factory.
- T23 sample mode modal with disabled adapters and the real-database checksum test.
- T24 cosmetic rename: README, native module display strings, widget display name.

### Checkpoint D
- Every success criterion in `SPEC-habit-system.md` section 9 is true, recorded in `checkpoints.md`.

## Verification standard per task

Inherited from the Ripples process and unchanged:

1. Tests first (red), implementation (green), refactor. Jest with React Native Testing Library, queries by accessible role and name.
2. `bun run validate` exit 0 before every commit; every `src/core` file at 100 percent on all four metrics.
3. Argent simulator evidence for every visible change; a full-resolution screenshot comparison for pixel-changing tasks.
4. Independent verification by a second model that did not author the task.
5. One `checkpoints.md` entry per task with commits, tests, evidence, and decisions.
6. Lowercase conventional commit, no co-author lines, pushed only after 1 to 5.

## Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Run windows across midnight with DST and time-zone changes produce off-by-one run assignment | High | T12 is pure and gets the same fixture families as Ripples' calendar tests (midnight, shifted day, DST both directions, zone change, leap day) before any UI uses it |
| Coins written outside the check-in transaction drift from check-ins | High | Earning, claw-back, and bonus are written by the same `runCommand` transaction as the check-in; tests assert receipt, ledger row, and check-in commit together or not at all |
| Swift CloudKit mapping rejects new fields and sync stalls with `needs_attention` | High | T19 changes TypeScript records and Swift mapping together; the shared fixture round-trip test is the gate; two-simulator convergence at checkpoint C |
| Version 1 peers (old installs) receive unknown record types | Medium | Version 1 code already ignores unknown types; T19 adds a test with a version 1 fake peer |
| Toggle un-check deletes a check-in that has a note or amount | Medium | Un-check on a `daily` board with a note asks for confirmation; `daily` boards cannot add amounts or times |
| Sample mode leaks into the real database | High | Separate database handle, adapters replaced by fakes, and a checksum test on the real file across a sample session |
| Miss alert double-schedules or fires for archived boards | Medium | `miss_alerts` records the missed-window key; reconciler skips archived boards and windows where the board was not active for the whole window |
| Building under Ripples' identifiers by accident | High | T1 runs first and checkpoint 0 verifies the bundle id in the built app before any other task |
| Scope creep toward dice, deadlines, penalties | Medium | Listed under Ask first in the spec; not in any task |

## Parallelization

- T3 and T4 after T2; T5 and T6 after T3; T7 then T8.
- T10 and T11 after T9; T13 and T14 after T12.
- T17 and T18 after T16; T19 after T18; T20 after T19.
- T21, and the pair T22 then T23, in parallel after checkpoint C. T24 last.

## Open questions

None. The spec's open questions were resolved on 2026-09-08.
