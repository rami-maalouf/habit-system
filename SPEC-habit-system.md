# Spec: Habit System

Spec id: habit-system

Prerequisites: SPEC-native-foundation.md, SPEC-ripples-product.md (both inherited from Ripples at tag `ripples-v1-fork-point`)

Capability map: CAPABILITY-MAP.md (amendment proposed in section 12 of this document)

Covered module ids: daily-habits, stacks, coins, rewards, miss-alerts, sample-mode, starter-stack, fork-identity

Status: Phase 1 draft - awaiting Rami's review. No plan, tasks, or code until approved.

Date: 2026-09-08

Author: Fable 5.1, from the design interview with Rami on 2026-09-07 and 2026-09-08. Decisions are recorded in `/Users/rami/Documents/life-os/projects/better-habit-system/` (habits-v2.md, rewards-and-coins.md, source-notes.md).

## How to read this document

This is a delta specification. Everything in SPEC-ripples-product.md remains true unless a section below says otherwise. Where this document changes an inherited rule, it names the rule and states the replacement. Nothing inherited is silently dropped.

Three inherited rules are replaced:

1. Ripples out-of-scope: "Goals, scheduled habit frequencies, skipped days, rest days, penalties, scores shared between users, or gamification." Replaced by: coins, rewards, and stack bonuses are in scope. Penalties, rest days, scheduled frequencies, and scores shared between users remain out of scope.
2. Ripples check-in semantics: "Each quick-check-in press creates one new check-in. It is not a daily on/off toggle." Replaced by: this stays true for `count` boards. A new `daily` board kind is a per-day toggle.
3. CAPABILITY-MAP.md: "The project uses exactly two specifications." Replaced by: three. This document owns the modules listed above.

## Assumptions made while writing this spec

Rami: correct any of these now. Each one is a decision I filled in because it was not covered in the interview.

1. **Stack start time is derived, not stored.** You said the stack's start time is the first habit's start time. So every anchor (built-in, custom text) and every habit gets an optional `usualTimeMinute`. A stack's run starts at the usual time of its first element. If the first element has no time, the run starts at midnight. This time is informational only. It never penalizes a check.
2. **Stacks are derived from anchors, not stored as their own records.** A stack is every board connected through board-to-board anchors, ordered by the anchor direction. No `stacks` table. Stack metrics recompute when the stack changes, the same way Ripples analytics recompute when a board is archived.
3. **A built-in or text anchor ends a stack.** "Wake after the alarm" starts a new stack, because the alarm is not a habit and has no predecessor. With your six habits written as in habits-v2, that produces two stacks: a night stack (closed, bed) rooted at isha prayer and a morning stack (wake, dump, ignition, courage) rooted at the alarm. If you want one stack, anchor wake "after bed" and mention the alarm in the habit's text. Open question 1 asks which you want.
4. **The ledger is append-only.** Coins are rows, never a stored balance. Earned total is the sum of positive rows, spent total the sum of negative rows, balance the difference. A claw-back is a new negative row that references the row it reverses. This is the "two grow-only counters" you agreed to, expressed as rows so CloudKit merge is a plain set union.
5. **Claw-back applies to the run bonus too.** Un-checking a habit before the stack's next start time reverses the habit's coin and, if the run had been complete, the run bonus.
6. **"Next morning" for the never-miss-twice alert means 09:00 local**, adjustable later. The alert is scheduled by the same reconciler that schedules reminders (cold start, foreground, significant time change). It cannot fire from a background that iOS does not give us.
7. **Daily boards do not track amounts or exact time.** Enabling `daily` hides Track Amounts and Track Check-In Time. A daily check-in stores amount null and time null, plus the logical date.
8. **Sample mode runs the real UI on a throwaway in-memory database.** Every screen works inside it. Sync, widgets, notifications, export, import, and intents are disabled inside it. Closing it discards everything.
9. **The starter stack is a constant in code**, `src/core/templates/daily-stack.ts`, applied by one Settings action. Its contents are whatever habits-v2 says at build time and can be empty. Removal is normal board deletion.
10. **Identifiers use the `studio.orbitlabs.habitsystem` family** (open question 2 confirms the exact strings). Ripples' identifiers are never reused.

-> Correct me now or I proceed with these.

## 1. Objective

Turn the Ripples fork into a habit system: a tracker where habits can be stacked onto each other in the Atomic Habits sense ("after X, I do Y"), where checking a habit earns coins, where completing a whole stack earns a bonus, and where coins buy rewards the user defines. Everything Ripples does stays.

### Who it is for

Rami first. He runs the six-habit night-to-morning chain from habits-v2 and the coin ledger from rewards-and-coins.md on paper and in a physical jar today. The app replaces both. A public release comes later, so nothing personal is hardcoded.

### User outcomes

- Create a habit as a `daily` toggle or keep it as a `count` board.
- Anchor a habit to another habit, to a built-in anchor (waking up, lunch, dinner, sleeping), or to typed text, as "after" or "before".
- See the stacks that form from those anchors, each with its own run window, and see whether each run was complete.
- Earn one coin per checked habit that is set to earn coins, capped per day, plus one bonus coin per complete stack run.
- Write a reward list with coin prices and claim rewards with the balance.
- Get one alert when the same habit is missed two runs in a row, and nothing else new.
- See the home screen show, per daily habit, the fourteen-day strip, checks this week, and the streak.
- Open a sample of the app as if used for three years, then close it without a trace.
- Apply a starter stack in one tap.

### Success looks like

Rami stops using the paper block and the jar within the first week of installing the app on his phone, and the Friday count happens inside the app.

### Out of scope for this spec

- Dice, wheel, or any chance-based reward (kept for a later spec)
- Deadlines on habits or any "late" state
- Penalties of any kind
- Full dependency graphs between habits (a habit has at most one anchor)
- Exporting into the Obsidian daily note
- macOS-specific UI (the iPhone/iPad build runs on Apple Silicon Macs as "Designed for iPad")
- Android UI
- Everything Ripples already lists as out of scope, except the gamification line replaced above

## 2. Tech stack

Unchanged from the inherited specs: Expo SDK 57 with Continuous Native Generation, Expo Router, React Native 0.86, React 19, TypeScript 6, `@expo/ui`, `expo-sqlite` in an App Group, `expo-widgets`, `expo-notifications`, `react-native-svg`, Reanimated 4, Bun. One local native module `modules/ripples-apple` (rename is a later cosmetic task). No new runtime dependency is approved by this document.

## 3. Commands

```bash
bun install --frozen-lockfile
bun run start                      # metro with expo mcp
bunx expo run:ios                  # local build to the simulator
bun run lint
bun run typecheck
bun run test                       # all jest suites
bun run test:domain
bun run test:migrations
bun run test:contracts
bun run test:features
bun run test:sync
bun run test:native                # plugin config checks + swift package tests
bun run validate                   # lint + typecheck + coverage; must exit 0 before every commit
bunx expo-doctor
```

## 4. Domain rules

### 4.1 Board kind

Board gains `kind: 'count' | 'daily'`. Default for new boards is `daily`. Existing boards migrate as `count`.

`count` boards keep every Ripples rule.

`daily` boards:

- At most one non-deleted check-in per logical date. `createCheckIn` on a date that already has one returns the existing check-in id with `ok: true` and does not insert. The command receipt records that no mutation happened.
- The quick action toggles. On an unchecked day it creates the check-in. On a checked day it removes it (a tombstone, as in Ripples). Both paths run through named commands.
- `tracksAmount` and `tracksTime` are forced false and their controls are hidden. Existing amounts and times on a board switched to `daily` are retained, not deleted.
- Heatmap cells have two states, unchecked and checked. The accessibility label says "checked" or "not checked" with the date.
- Analytics are unchanged: a completed day is one with a check-in. Streak, consistency, weekday, timeline, and year comparison all work without change.
- Switching kind is an edit with optimistic concurrency. Switching `count` to `daily` keeps all history; days with several check-ins show as checked.

### 4.2 Anchors

Board gains:

| Field | Contract |
| --- | --- |
| anchorRelation | `'after'`, `'before'`, or null |
| anchorKind | `'board'`, `'preset'`, `'text'`, or null |
| anchorBoardId | BoardId when anchorKind is `board`; must be an active or archived board; never self |
| anchorPreset | `'wake'`, `'lunch'`, `'dinner'`, `'sleep'` when anchorKind is `preset` |
| anchorText | trimmed, 1 through 80 code points when anchorKind is `text` |
| usualTimeMinute | nullable, 0 through 1439 in 15-minute increments |
| requiredInStack | boolean, default true |

Rules:

- A board has at most one anchor. The four anchor fields are all null or all consistent with `anchorKind`.
- "A after B" and "B before A" describe the same order. The UI offers both directions so the user can write the sentence naturally. Storage keeps what the user chose.
- Anchor cycles are rejected by validation: following board anchors from any board must terminate. `deleteBoard` on an anchored-to board sets dependents' anchors to null in the same transaction and reports how many were cleared in the confirmation.
- Archiving an anchored-to board keeps the link. Stack computations treat an archived member as absent.
- Text anchors are plain text. They are not entities and are not shared between boards.

Built-in anchor times live in AppSettings:

| Preset | Default minute | Label |
| --- | --- | --- |
| wake | 420 (7:00) | Waking up |
| lunch | 720 (12:00) | Lunch |
| dinner | 1080 (18:00) | Dinner |
| sleep | 1380 (23:00) | Sleeping |

All four are editable in Settings in 15-minute increments. They sync as part of the settings record.

### 4.3 Stacks

A stack is derived. It is the set of boards reachable from one another through `board` anchors, ordered so that every "after" edge points forward and every "before" edge points backward. Siblings anchored to the same board keep home order.

- Root: the first element in that order. It is either a board with no `board` anchor, or the preset or text anchor of such a board.
- Run start minute: the root's `usualTimeMinute` if it is a board with one; the preset's configured minute if the root is a preset; the anchoring board's `usualTimeMinute` if the root is a text anchor with none of its own; otherwise 0.
- A run is the window from one run start to the next. Runs are identified by the logical date on which they start, computed with the same shifted-day rule Ripples uses for `startOfDayMinute`, but using the run start minute across the whole clock. Boards inside a stack use the run window, not their own `startOfDayMinute`, for stack metrics. Their own check-ins keep their own logical dates; the run assigns each check-in to a run by its occurrence instant, or by its logical date when untimed.
- A run is complete when every member with `requiredInStack` true and not archived during that run has a check-in inside the run window.
- A stack with one member is still a stack. A board with no anchors and nothing anchored to it is not in any stack.

Stack metrics (all derived, none stored):

- complete runs per ISO week
- longest consecutive complete-run streak
- per-member checks per ISO week
- stack heatmap: one cell per run for the rolling 365 runs, shaded by the fraction of required members checked; four steps: none, some, most, all. Every cell has a text alternative.

### 4.4 Coins

Board gains `earnsCoins: boolean` (default false) and `coinCapPerDay: integer 1 through 10` (default 1).

New table `coin_ledger`:

| Field | Contract |
| --- | --- |
| id | branded LedgerEntryId, UUIDv4 |
| kind | `'check'`, `'run_bonus'`, `'claim'`, `'reversal'` |
| delta | integer; positive for `check` and `run_bonus`, negative for `claim` and `reversal` |
| boardId | BoardId for `check`; null otherwise |
| checkInId | CheckInId for `check`; null otherwise |
| runKey | `<rootId>|<runDate>` for `run_bonus`; null otherwise |
| rewardId | RewardId for `claim`; null otherwise |
| reversesId | LedgerEntryId for `reversal`; null otherwise |
| logicalDate | the board's logical date for `check`, the run date for `run_bonus`, the current logical date for `claim` |
| createdAt | UTC epoch milliseconds |
| mutationStamp | hybrid logical clock stamp |
| deletedAt | always null; ledger rows are never tombstoned |

Rules:

- Earned total is the sum of positive deltas. Spent total is the absolute sum of negative deltas. Balance is their difference. All three are queries, never columns.
- A `check` row is written in the same exclusive transaction as the check-in that earns it, when the board has `earnsCoins` and the number of non-reversed `check` rows for that board and logical date is below `coinCapPerDay`. Idempotent by (`boardId`, `checkInId`).
- A `run_bonus` row of +1 is written in the transaction that makes a run complete. Idempotent by `runKey`.
- Claw-back: removing or un-checking a check-in that has a non-reversed `check` row writes a `reversal` row of -1 when the current instant is before the next run start of the board's stack (or before the board's next logical day when it is in no stack). After that boundary the coin stays. The same rule reverses a `run_bonus` whose run is no longer complete.
- A `claim` row of -cost is written when a reward is claimed. The command fails with `validation` when balance is below cost. Balance is read inside the same exclusive transaction.
- Ledger rows sync as first-class records. They never conflict: equal ids are equal rows. The balance on two devices converges as soon as both have all rows. A claim made offline on both devices that together overspend is accepted; the balance can go negative and the UI shows it. The next earnings pay it back. No row is ever deleted to fix it.
- Export includes the ledger. Import from a version 1 Ripples export produces no ledger rows.

### 4.5 Rewards

New table `rewards`:

| Field | Contract |
| --- | --- |
| id | branded RewardId, UUIDv4 |
| title | trimmed, 1 through 80 code points |
| costCoins | integer 1 through 100000 |
| symbol | allowlisted SF Symbol, same list and fallback as boards |
| accentHex | uppercase #RRGGBB |
| orderKey | sortable text key with RewardId tie-breaker |
| archivedAt | nullable |
| createdAt, updatedAt, mutationStamp, deletedAt | as boards |

Rules:

- Rewards are user-defined. Nothing is seeded. The empty state explains in one sentence and offers Create Reward.
- Claiming requires a confirmation that states the cost and the balance after. Successful claim writes the ledger row and shows the claim in Coin History.
- Editing a reward's cost does not change past claims.
- Deleting a reward tombstones it. Its past claims remain in the ledger with the reward's title copied into the confirmation history at claim time (`claim` rows store `rewardTitleSnapshot`, trimmed, 80 code points, so history survives deletion).
- Rewards sync and export like boards.

### 4.6 Never miss twice

- Applies to `daily` boards only.
- A miss is a run (for a stacked board) or a logical day (for an unstacked board) in which the board was active for the whole window and has no check-in.
- When a board's two most recent closed windows are both misses and no alert has been recorded for that pair, the reconciler schedules one local notification for the next 09:00 local time, or immediately if that has passed and the app is in the foreground. Body: "[title] was missed twice. Fix the environment before anything else today." The tap deep-links to the board.
- New device-local table `miss_alerts` stores boardId, the second missed window key, and the native identifier. It never syncs and is excluded from export.
- The alert uses the existing notification permission. If permission is denied, the alert is recorded as `denied` and nothing prompts. Settings > Notifications shows the count of pending miss alerts.
- Ripples' per-board reminders are unchanged and remain the way to be reminded before a habit.

### 4.7 Home screen

For `count` boards, unchanged.

For `daily` boards the card shows: symbol, title, fourteen checked-or-unchecked cells ending today, "N/7 this week" using ISO Monday weeks and the board's logical day, the current streak as a small label, and the toggle. A checked toggle is visually filled and its accessibility label is "Checked, double tap to uncheck". Color is not the only indicator.

A coin balance pill sits in the Boards header trailing area, before edit and plus. Tapping it opens Coins. It shows the integer balance with a text label for VoiceOver.

### 4.8 Stacks screen

New root-level route `/stacks`, reached from a Boards header icon. It lists derived stacks. Each stack shows its members in order with today's run state, the run start time, complete runs this week, and the current complete-run streak. Selecting a stack opens `/stacks/[rootId]` with the stack heatmap and per-member counts. There is no create or edit on this screen; stacks change by editing anchors on boards. The empty state explains anchors in one sentence and links to Create Board.

### 4.9 Coins and rewards screens

`/coins` shows balance, earned total, spent total, and the reward list with Claim actions. `/coins/history` is a virtualized ledger, newest first, grouped by logical date, with kind, delta, and the board, run, or reward it refers to. `/coins/rewards/new` and `/coins/rewards/[rewardId]` are native form sheets with the same structure as board forms.

### 4.10 Sample mode

- Settings > Utilities gains "Try a sample". It opens `/sample` as a full-screen modal.
- The modal runs the complete app stack against a separate in-memory SQLite database created from the same migrations, seeded by a deterministic generator with a fixed seed: eight habits, one four-habit stack with a preset root, one count board, three years of check-ins with realistic weekly rhythms and gaps, coins earned and reversed, four rewards with claims.
- A persistent top banner reads "Sample data. Nothing here is saved." with a Close button in the trailing corner. Close discards the database.
- Inside sample mode: sync, widgets, notifications, export, import, App Intents, iCloud settings, and App Icon are disabled with a one-line explanation. Every other command works so the user can feel the app.
- Sample mode never reads or writes the real App Group database. A test asserts the real database file's checksum is unchanged across a sample session.

### 4.11 Starter stack

- Settings > Utilities gains "Create my daily stack". It applies `src/core/templates/daily-stack.ts` in one exclusive transaction: boards with kinds, anchors, usual times, coin settings, and preset anchors.
- The template is versioned product data. Its contents are decided in habits-v2 and can change between builds. An empty template hides the action.
- Applying twice is refused when any board with the same template key exists; the confirmation names the boards.
- Removal is normal board deletion. No special path.

### 4.12 Widgets, intents, sync, export

- Widget rows for `daily` boards show the checked state and the toggle. The quick action deep-links as today.
- App Intents: Check In on a `daily` board checks it (idempotent for the day). Remove Latest Check-In un-checks it. Get Today's Check-Ins reports checked or not. The shared fixture suite gains cases for all three.
- Sync: `coin_ledger` and `rewards` are new `SyncEntityType`s. Board and settings records carry the new fields. `SYNC_SCHEMA_VERSION` becomes 2. A device on version 1 ignores unknown types and fields; a version 2 device fills missing fields with defaults.
- Export: `exportVersion` becomes 2 and adds `rewards` and `coinLedger`. Import accepts versions 1 and 2 of this app's export and the Ripples CSV.
- Migration: schema version 6 adds the columns and tables above with defaults, in one exclusive transaction, checksum-tested, with a fixture from version 5.

## 5. Project structure

Additions only. Everything else is as in SPEC-ripples-product.md.

```text
src/
  app/
    stacks/                index.tsx, [rootId].tsx
    coins/                 index.tsx, history.tsx, rewards/new.tsx, rewards/[rewardId].tsx
    sample.tsx             full-screen modal host
  core/
    domain/
      stacks.ts            derive stacks, runs, completeness (pure)
      coins.ts             ledger rules, cap, claw-back window (pure)
    analytics/
      stacks.ts            complete runs per week, run streak, stack heatmap
    persistence/
      repositories/        ledger.ts, rewards.ts, miss-alerts.ts
    templates/
      daily-stack.ts
    sample/
      generator.ts         deterministic sample data
  features/
    stacks/
    coins/
    sample-mode/
    anchors/               anchor picker bottom sheet
  platform/
    database/              in-memory database factory for sample mode
tests/
  product/
    domain/                stacks.test.ts, coins.test.ts
    features/              stacks-slice.test.tsx, coins-slice.test.tsx, sample-mode.test.tsx, anchors.test.tsx
    migrations/            v5-to-v6 fixture
    sync/                  ledger and rewards records
    contracts/             daily-board intent cases
```

## 6. Code style

Inherited. One illustration of how the new pure domain code should read: small, typed, no I/O, lowercase comments, no clever abstractions.

```ts
// a run is complete when every required, present member has a check-in inside the window
export function isRunComplete(run: StackRun): boolean {
  return run.members
    .filter((member) => member.requiredInStack && !member.archivedDuringRun)
    .every((member) => member.checkInIds.length > 0);
}

// claw-back is allowed only until the stack's next run starts
export function canReverseCoin(input: {
  nowUtcMs: number;
  nextRunStartUtcMs: number;
}): boolean {
  return input.nowUtcMs < input.nextRunStartUtcMs;
}
```

Conventions that matter most here: branded ids for every new entity, `DomainResult` for every command, named commands for every mutation, pure functions in `src/core/domain` with the database touched only in repositories.

## 7. Testing strategy

Inherited process: red, green, refactor; Jest with React Native Testing Library; queries by accessible role and name; 90 percent global coverage; 100 percent branches on domain, calendar, analytics, migrations, export, sync; simulator evidence and an independent verification pass before every commit; a `checkpoints.md` entry per task.

New coverage that this spec requires:

- Domain: stack derivation for chains, siblings, before/after mixes, cycles (rejected), archived members, preset and text roots; run windows across midnight, DST, and time-zone change; completeness with optional members; cap enforcement; claw-back inside and outside the window; run bonus idempotency; claim with sufficient, insufficient, and negative balance; ledger totals.
- Migrations: version 5 fixture migrates to 6 with defaults; every earlier fixture still opens.
- Sync: ledger and rewards records round-trip; a version 1 peer ignores them; out-of-order ledger delivery converges to one balance.
- Contracts: daily-board cases in `intent-contract.json`, executed by both the TypeScript and Swift executors.
- Features: toggle behavior and accessibility labels; anchor picker with all three kinds and both directions; stacks screen states; coins screens; sample mode isolation (real database checksum unchanged); starter stack apply and refuse-twice.
- Device: Argent evidence for toggle, anchor picker, stacks screen, claim, sample mode open and close, and the miss alert firing on a simulator with the clock advanced.

## 8. Boundaries

**Always**

- Run `bun run validate` before every commit; keep every `src/core` file at 100 percent.
- Route every mutation through a named command with an idempotency key.
- Keep the ledger append-only.
- Keep the SQLite database the only source of truth. Derived values (balance, stacks, runs) are queries.
- Preserve every Ripples behavior for `count` boards.
- Change the identifiers in FORK.md before the first build.

**Ask first**

- Any new column, table, sync entity type, or export field beyond section 4.
- Any new runtime dependency.
- Storing a balance, a stack, or a run as a row.
- Adding chance mechanics, deadlines, or penalties.
- Changing the four preset anchors or their 15-minute step.
- Changing the claw-back window or the cap range.
- Any change to the Swift module's public surface.

**Never**

- Tombstone or delete a ledger row.
- Seed data into a real user's database outside the starter-stack action.
- Let sample mode touch the App Group database.
- Reuse a Ripples bundle id, App Group, CloudKit container, EAS project, or scheme.
- Weaken tests, coverage, or accessibility to pass a gate.
- Add agent signatures or co-author lines to commits.

## 9. Success criteria

1. A `daily` board toggles from Home, widget, and Shortcuts with exactly one check-in per day and correct accessibility labels.
2. Anchors of all three kinds and both directions save, validate (no self, no cycle), and render as sentences in the board form.
3. Rami's six habits, entered by hand with the anchors from habits-v2, produce the stacks named in open question 1, with the correct run windows across midnight.
4. Checking a coin-earning habit writes one `check` row; the cap holds; un-checking before the next run start writes a `reversal`; un-checking after does not.
5. Completing a run writes exactly one `run_bonus` row, and un-checking a required member inside the window reverses it.
6. A reward can be created, claimed with sufficient balance, refused with insufficient balance, and its claim survives the reward's deletion.
7. Two devices with offline ledger writes converge to the same balance after sync, including a negative balance from double claims.
8. Schema 6 migrates from every earlier fixture; export version 2 round-trips; import accepts versions 1 and 2 and the Ripples CSV.
9. The never-miss-twice alert schedules exactly once per missed pair, deep-links to the board, and never prompts for permission on its own.
10. Sample mode opens with three years of generated data, every screen works, and the real database checksum is unchanged after closing.
11. The starter stack applies once and refuses a second application by name.
12. Home shows fourteen cells, checks this week, and streak for daily boards; the balance pill reads correctly to VoiceOver.
13. All gates pass: `bun run validate`, `bun run test:native`, `bunx expo-doctor`, iOS and Android exports.
14. The app runs under its own identifiers on a signed device and never appears in Ripples' CloudKit container or EAS project.

## 10. Open questions

1. **One stack or two.** With anchors as written in habits-v2 (wake after the alarm), your six habits form a night stack and a morning stack. Do you want that, or should wake anchor "after bed" so the whole night-to-morning chain is one run? Recommendation: one stack. "Full chain" is the number you care about, and two stacks give you two smaller numbers instead.
2. **Exact identifiers.** Proposed: name and slug `habit-system`, bundle `studio.orbitlabs.habitsystem`, App Group `group.studio.orbitlabs.habitsystem`, container `iCloud.studio.orbitlabs.habitsystem`, zone `habit-system`, scheme `habitsystem`, new EAS project via `eas init`. Confirm or change.
3. **Miss alert time.** 09:00 local as a constant, or editable in Settings next to the preset anchors? Recommendation: constant now.
4. **Coin cap range.** 1 through 10 per day. Is 10 enough for a count board like water?
5. **Public name.** The README still says Ripples. The rename of the README, the native module, and the widget display name is cosmetic and can be its own task after the first build. Confirm that order.

## 11. What happens after approval

Per the spec-driven-development skill: Phase 2 writes `tasks/plan.md` (components, order, risks, checkpoints), Phase 3 writes `tasks/todo.md` (tasks of at most five files each, with acceptance and verification), and Phase 4 implements one task at a time with tests first. The existing Ripples `tasks/plan.md` and `tasks/todo.md` are archived under `tasks/ripples/` first.

## 12. Proposed CAPABILITY-MAP.md amendment

On approval, CAPABILITY-MAP.md changes as follows. Not applied yet.

- Rule "The project uses exactly two specifications" becomes three: SPEC-native-foundation.md, SPEC-ripples-product.md, SPEC-habit-system.md.
- New module rows:

| Module id | Responsibility | Depends on |
| --- | --- | --- |
| `fork-identity` | New bundle, group, container, scheme, EAS project, and name; FORK.md table applied | `native-foundation` |
| `daily-habits` | `daily` board kind, toggle semantics, home card, widget and intent behavior | `boards`, `board-configuration`, `widgets`, `automations` |
| `stacks` | anchors, preset anchor settings, derived stacks and runs, stacks screens and analytics | `daily-habits`, `analytics` |
| `coins` | append-only ledger, earning, cap, claw-back, run bonus, balance, history, sync and export of ledger rows | `stacks`, `cloud-sync`, `data-export` |
| `rewards` | reward records, claim flow, reward screens | `coins` |
| `miss-alerts` | never-miss-twice reconciler and notification | `daily-habits`, `reminders` |
| `sample-mode` | in-memory database, deterministic generator, sample modal | `coins`, `rewards`, `stacks` |
| `starter-stack` | template constant and one-tap apply | `stacks`, `coins` |

- Build order appended: `fork-identity` -> `daily-habits` -> `stacks` -> `coins` -> `rewards` in sequence; then `miss-alerts`, `sample-mode`, `starter-stack` in parallel.
