# Tasks: Habit System

Spec: `SPEC-habit-system.md`. Plan: `tasks/plan.md`. Status: awaiting approval; no task started.

Definition of done for every task: tests first, `bun run validate` exit 0, `src/core` at 100 percent, Argent evidence for visible changes, independent review by a non-author, one `checkpoints.md` entry, lowercase conventional commit without co-author lines.

## Phase 0: fork identity

- [ ] **T1: Apply fork identifiers and create the EAS project**
  - Acceptance: `app.json` name and slug `habit-system`, bundle `studio.orbitlabs.habitsystem`, scheme `habitsystem`, widget name and display name renamed; `CloudKitTransport.swift` zone `habit-system`; podspec URLs point at `rami-maalouf/habit-system`; `extra.eas.projectId` and `updates.url` come from a new `eas init`; `package.json` name `habit-system`; FORK.md table marked applied.
  - Verify: `bun run test:native:config`; `bunx expo-doctor`; `bunx expo prebuild --platform ios --clean` then `bunx expo run:ios`; the built app's bundle id is the new one; `git status` shows no generated `ios/`.
  - Files: `app.json`, `package.json`, `modules/ripples-apple/ios/CloudKitTransport.swift`, `modules/ripples-apple/ios/RipplesApple.podspec`, `modules/ripples-apple/tests/plugin/config.test.cjs`, `FORK.md`.
  - Depends on: none. Size: M.

### Checkpoint 0
- [ ] Simulator build runs under the new identifiers; plugin tests and doctor pass; entry in `checkpoints.md`.

## Phase 1: daily habits

- [ ] **T2: Migration version 6 and entity types**
  - Acceptance: version 6 adds board columns `kind`, `anchor_relation`, `anchor_kind`, `anchor_board_id`, `anchor_preset`, `anchor_text`, `usual_time_minute`, `required_in_stack`, `earns_coins`, `coin_cap_per_day`; settings columns for the four preset minutes with defaults 420, 720, 1080, 1380; tables `coin_ledger`, `rewards`, `miss_alerts` with indexes; existing boards get `kind = 'count'`; `Board`, `AppSettings`, `LedgerEntry`, `Reward` types and branded ids exist; board repository reads and writes the new columns.
  - Verify: `bun run test:migrations` with a new version 5 fixture; every earlier fixture still opens; checksum test updated.
  - Files: `src/core/persistence/schema.ts`, `src/core/domain/entities.ts`, `src/core/domain/ids.ts`, `src/core/persistence/repositories/boards.ts`, `tests/product/migrations/`.
  - Depends on: T1. Size: M.

- [ ] **T3: `daily` kind rules and the toggle dispatcher**
  - Acceptance: `validateBoardFields` accepts `kind` and forces `tracksAmount` and `tracksTime` false for `daily`; `createCheckIn` on a `daily` board with an existing check-in for the date returns that id with `ok: true` and no mutation, recorded in the receipt; `toggleDailyCheckIn` command creates or removes today's check-in; `count` behavior unchanged.
  - Verify: `bun run test:domain` with new cases for both kinds, idempotent create, toggle both ways, kind switch preserving history.
  - Files: `src/core/domain/validation.ts`, `src/core/domain/commands.ts`, `tests/product/domain/commands.test.ts`, `tests/product/domain/daily.test.ts`.
  - Depends on: T2. Size: M.

- [ ] **T4: Board form Kind control**
  - Acceptance: Create and Edit Board show a Kind control (Daily, Count) defaulting to Daily for new boards; selecting Daily hides Track Amounts, Unit, Quick Check-In Amount, and Track Check-In Time; live preview reflects the kind; saving persists it.
  - Verify: `bun run test:features` board form cases by role and name; Argent screenshot of both states.
  - Files: `src/features/board-configuration/board-form.tsx` (or the existing form file), related form state, `tests/product/features/boards-slice.test.tsx`.
  - Depends on: T3. Size: S.

- [ ] **T5: Home card for `daily` boards**
  - Acceptance: card shows fourteen two-state cells ending today, "N/7 this week" using ISO Monday weeks and the board's logical day, the current streak label, and a toggle whose label is "Checked, double tap to uncheck" or "Not checked, double tap to check"; `getHomeBoardProjection` returns the needed fields; un-check of a check-in with a note asks for confirmation.
  - Verify: `bun run test:features` and `test:domain`; Argent evidence of check and un-check with Undo.
  - Files: `src/core/domain/queries.ts`, `src/features/boards/board-card.tsx`, `src/features/boards/boards-home.tsx`, `tests/product/features/boards-slice.test.tsx`, `tests/product/domain/queries.test.ts`.
  - Depends on: T3. Size: M.

- [ ] **T6: Heatmap two-state rendering for `daily` boards**
  - Acceptance: `daily` boards render checked and unchecked cells only, with labels "checked" or "not checked" plus the date; `count` boards unchanged.
  - Verify: `bun run test:features`; Argent screenshot in light and dark.
  - Files: `src/features/boards/heatmap-view.tsx`, `src/features/boards/board-detail.tsx`, `tests/product/features/boards-detail-states.test.tsx`.
  - Depends on: T3. Size: S.

- [ ] **T7: Widget rows and TypeScript intents for `daily` boards**
  - Acceptance: `widget_board_rows` carries `kind` and checked state; the widget row shows the checked state; Check In on a `daily` board is idempotent for the day; Remove Latest un-checks; Get Today's Check-Ins reports checked or not; `intent-contract.json` gains cases for all three.
  - Verify: `bun run test:contracts`; widget renders on the simulator with a `daily` board.
  - Files: `src/core/persistence/projections/widget-rows.ts`, `src/platform/widgets/ripples-boards-widget.tsx`, `src/core/automations/contract.ts`, `src/core/automations/fixtures/intent-contract.json`, `tests/product/contracts/automations.test.ts`.
  - Depends on: T5. Size: M.

- [ ] **T8: Swift intents executor for `daily` boards**
  - Acceptance: the Swift executor passes the new fixture cases verbatim; idempotent daily create replays the same receipt shape as TypeScript.
  - Verify: `bun run test:native`; Shortcuts on a simulator with a `daily` board.
  - Files: `modules/ripples-apple/ios/` intent executor sources and their tests.
  - Depends on: T7. Size: M.

### Checkpoint A
- [ ] `daily` board created, toggled from Home, widget, Shortcuts; `count` boards unchanged; all gates and review recorded.

## Phase 2: stacks

- [ ] **T9: Preset anchor minutes**
  - Acceptance: settings hold four preset minutes with defaults; `setPresetAnchorMinute` validates 0 through 1439 in 15-minute steps; Settings > Anchors lists Waking up, Lunch, Dinner, Sleeping with native time pickers stepping by 15 minutes; values sync as settings fields.
  - Verify: `bun run test:domain`, `test:features`; Argent screenshot.
  - Files: `src/core/domain/commands.ts`, `src/core/domain/queries.ts`, `src/features/settings/anchors-screen.tsx`, `src/app/settings/anchors.tsx`, `tests/product/features/settings-flows.test.tsx`.
  - Depends on: T2. Size: M.

- [ ] **T10: Anchor fields and rules**
  - Acceptance: `updateBoard` and `createBoard` accept the anchor fields and `usualTimeMinute`, `requiredInStack`; validation rejects self-anchor, cycles, and inconsistent field sets; `deleteBoard` clears dependents' anchors in the same transaction and `getBoardDependentCounts` reports the number.
  - Verify: `bun run test:domain` with chain, sibling, before/after, cycle, and delete cases.
  - Files: `src/core/domain/validation.ts`, `src/core/domain/commands.ts`, `src/core/domain/queries.ts`, `tests/product/domain/anchors.test.ts`.
  - Depends on: T9. Size: M.

- [ ] **T11: Anchor picker and usual time in the board form**
  - Acceptance: an Anchor row opens a bottom sheet with three sections: Habits (default, active boards in home order), Built-in (four presets with their times), and a text input; a segmented After/Before control; the row renders the sentence "After Bed" or "Before Lunch"; a Usual Time row with a native picker in 15-minute steps; Required in Stack toggle.
  - Verify: `bun run test:features` by role and name; Argent evidence of all three anchor kinds.
  - Files: `src/features/anchors/anchor-picker-sheet.tsx`, board form file, `tests/product/features/anchors.test.tsx`.
  - Depends on: T10. Size: M.

- [ ] **T12: Stack derivation and runs (pure)**
  - Acceptance: `deriveStacks(boards)` returns ordered stacks with root and run start minute; `assignRuns(stack, checkIns, window)` returns runs keyed by start date with member check-ins and completeness honoring `requiredInStack` and archived members; cycles never reach it (validated upstream) but a defensive guard returns an error result.
  - Verify: `bun run test:domain` covering chains, siblings, before/after mixes, preset and text roots, midnight crossing, DST both directions, zone change, leap day, optional members, archived members.
  - Files: `src/core/domain/stacks.ts`, `tests/product/domain/stacks.test.ts`.
  - Depends on: T10. Size: M.

- [ ] **T13: Stack analytics**
  - Acceptance: complete runs per ISO week, longest complete-run streak, per-member checks per week, and stack heatmap data for the rolling 365 runs with four shade steps and text alternatives.
  - Verify: `bun run test:domain` at 100 percent branches.
  - Files: `src/core/analytics/stacks.ts`, `src/core/domain/queries.ts`, `tests/product/domain/stack-analytics.test.ts`.
  - Depends on: T12. Size: M.

- [ ] **T14: Stacks screens**
  - Acceptance: Boards header gains a Stacks icon; `/stacks` lists stacks with members, today's run state, run start time, complete runs this week, current run streak; `/stacks/[rootId]` shows the stack heatmap and per-member counts; empty state explains anchors and links to Create Board; every metric has a text alternative.
  - Verify: `bun run test:features`; Argent screenshots light and dark.
  - Files: `src/app/stacks/index.tsx`, `src/app/stacks/[rootId].tsx`, `src/features/stacks/stacks-screen.tsx`, `src/features/stacks/stack-detail.tsx`, `tests/product/features/stacks-slice.test.tsx`.
  - Depends on: T13. Size: M.

### Checkpoint B
- [ ] Six habits entered by hand form one stack; run window across midnight correct; gates and review recorded.

## Phase 3: coins and rewards

- [ ] **T15: Ledger, coin rules, earning and claw-back**
  - Acceptance: ledger repository with append-only writes; `coins.ts` pure rules for cap and claw-back window; `createCheckIn` on an `earnsCoins` board writes a `check` row inside the same transaction when under the cap; `removeCheckIn` and the toggle write a `reversal` row when before the next run start (or next logical day when unstacked); `earned_total`, `spent_total`, balance queries.
  - Verify: `bun run test:domain` with cap, inside and outside window, idempotent replay, and atomicity (row and check-in commit together or not at all).
  - Files: `src/core/domain/coins.ts`, `src/core/persistence/repositories/ledger.ts`, `src/core/domain/commands.ts`, `src/core/domain/queries.ts`, `tests/product/domain/coins.test.ts`.
  - Depends on: T12. Size: M.

- [ ] **T16: Run bonus**
  - Acceptance: the check that completes a run writes one `run_bonus` row keyed by `rootId|runDate`; un-checking a required member inside the window writes its reversal; idempotent under replay.
  - Verify: `bun run test:domain`.
  - Files: `src/core/domain/coins.ts`, `src/core/domain/commands.ts`, `tests/product/domain/coins.test.ts`.
  - Depends on: T15. Size: S.

- [ ] **T17: Coins screens and balance pill**
  - Acceptance: Boards header shows a balance pill with a VoiceOver label; `/coins` shows balance, earned, spent, and the reward list placeholder; `/coins/history` is a virtualized ledger grouped by logical date showing kind, delta, and the board, run, or reward.
  - Verify: `bun run test:features`; Argent screenshots.
  - Files: `src/app/coins/index.tsx`, `src/app/coins/history.tsx`, `src/features/coins/coins-screen.tsx`, `src/features/coins/ledger-history.tsx`, `src/features/boards/boards-home.tsx`.
  - Depends on: T16. Size: M.

- [ ] **T18: Rewards**
  - Acceptance: rewards repository and commands create, update, reorder, archive, delete; `claimReward` reads balance in the transaction, refuses below cost with `validation`, writes a `claim` row with `rewardTitleSnapshot`; `/coins/rewards/new` and `/coins/rewards/[rewardId]` form sheets; Claim with confirmation stating cost and balance after; empty state offers Create Reward.
  - Verify: `bun run test:domain`, `test:features`; Argent evidence of create, claim, refuse, delete with history intact.
  - Files: `src/core/persistence/repositories/rewards.ts`, `src/core/domain/commands.ts`, `src/app/coins/rewards/new.tsx`, `src/app/coins/rewards/[rewardId].tsx`, `src/features/coins/reward-form.tsx`, `tests/product/domain/rewards.test.ts`, `tests/product/features/coins-slice.test.tsx`.
  - Depends on: T17. Size: L, split into T18a (domain and repository) and T18b (screens) when scheduled.

- [ ] **T19: Sync schema 2**
  - Acceptance: `SyncEntityType` gains `ledger_entry` and `reward`; `SPECS` gains their tables and the new board and settings columns; `SYNC_SCHEMA_VERSION = 2`; a version 1 fake peer ignores unknown types and fields; Swift mapping accepts the new types and columns; the shared fixture round-trips through both.
  - Verify: `bun run test:sync`; `bun run test:native`; two-simulator convergence including a double claim at checkpoint C.
  - Files: `src/core/sync/records.ts`, `src/core/sync/transport.ts`, `modules/ripples-apple/ios/` mapping sources and tests, `tests/product/sync/`.
  - Depends on: T18. Size: M.

- [ ] **T20: Export version 2 and import**
  - Acceptance: export adds `rewards` and `coinLedger` with `exportVersion: 2`; import accepts versions 1 and 2 of this app and the Ripples CSV; forbidden-key scan covers new tables; `miss_alerts` never exported.
  - Verify: `bun run test:domain` import-export suite; device round trip.
  - Files: `src/core/export/serialize.ts`, `src/core/export/import-parsers.ts`, `src/core/domain/commands.ts` (`importSnapshotInTransaction`), `tests/product/domain/import-export.test.ts`.
  - Depends on: T19. Size: M.

### Checkpoint C
- [ ] Balance converges across two simulators after offline writes; export round-trips; gates and review recorded.

## Phase 4: tails

- [ ] **T21: Never-miss-twice alerts**
  - Acceptance: reconciler (cold start, foreground, significant time change) finds `daily` boards whose two most recent closed windows are misses and have no `miss_alerts` row for the pair; schedules one local notification at the next 09:00 local, or fires now in the foreground; body and deep link per spec 4.6; denied permission records `denied` without prompting; Settings > Notifications shows pending miss alerts.
  - Verify: `bun run test:domain`, `test:features`; Argent evidence with the simulator clock advanced.
  - Files: `src/core/domain/miss-alerts.ts`, `src/core/persistence/repositories/miss-alerts.ts`, `src/features/product-store/provider.tsx`, `src/features/settings/notifications-screen.tsx`, `tests/product/domain/miss-alerts.test.ts`.
  - Depends on: T15. Size: M.

- [ ] **T22: Sample generator and in-memory database**
  - Acceptance: `generateSample(seed)` produces eight habits, one four-habit stack with a preset root, one count board, three years of check-ins with weekly rhythm and gaps, ledger rows including reversals, four rewards with claims; deterministic for a fixed seed; in-memory database factory runs the real migrations.
  - Verify: `bun run test:domain` snapshot of counts and a determinism test.
  - Files: `src/core/sample/generator.ts`, `src/platform/database/in-memory.ts`, `tests/product/domain/sample-generator.test.ts`.
  - Depends on: T18. Size: M.

- [ ] **T23: Sample mode modal**
  - Acceptance: Settings > Utilities "Try a sample" opens `/sample` full-screen; the real route tree mounts against the in-memory database with sync, widgets, notifications, export, import, intents, iCloud, and App Icon disabled with one-line explanations; persistent banner with Close in the trailing corner; Close discards; a test asserts the real database file checksum is unchanged across a session.
  - Verify: `bun run test:features`; Argent evidence of open, navigate, claim, close.
  - Files: `src/app/sample.tsx`, `src/features/sample-mode/sample-host.tsx`, `src/features/settings/settings-screen.tsx`, `tests/product/features/sample-mode.test.tsx`.
  - Depends on: T22. Size: M.

- [ ] **T24: Cosmetic rename**
  - Acceptance: README describes Habit System; native module display strings, widget display name, and podspec names no longer say Ripples where user-visible; code identifiers may keep `ripples` internally.
  - Verify: `bun run validate`; `bun run test:native`.
  - Files: `README.md`, `app.json`, `modules/ripples-apple/expo-module.config.json`, module strings.
  - Depends on: T23. Size: S.

### Checkpoint D
- [ ] All fourteen success criteria in `SPEC-habit-system.md` section 9 recorded true in `checkpoints.md`.
