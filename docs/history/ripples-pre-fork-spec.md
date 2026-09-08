# ripples pre-fork completion spec

status: CLOSED 2026-09-07. all items landed in ripples; closure entry is the first section of the repo's `checkpoints.md`; fork point is tag `ripples-v1-fork-point` (commit `5ed71a2`). open device checks and deferrals are listed in that entry.
repo: `/Users/rami/Documents/life-os/expo/content/videos/build-expo-with-claude-code/habit-tracker` (github `rami-maalouf/habit-tracker`, product name ripples)
governing docs in that repo: `SPEC-ripples-product.md`, `SPEC-native-foundation.md`, `CAPABILITY-MAP.md`, `checkpoints.md`

## 0. purpose

ripples is complete except for the work that was blocked on a signed apple developer build. this spec lists every item that must land in ripples **before** it is forked into `habit-system`, so that:

1. the fork inherits a working cloudkit transport (the bridge to the future macos app),
2. the fork inherits no known spec/code mismatches,
3. ripples itself stays a finished, honest artifact for the video series.

this file adds **no product rules**. every item below is already owned by `SPEC-ripples-product.md`; this file only sequences and specifies its completion. where an item needs a decision the product spec does not make, it is marked `decision` and must be approved by rami and recorded in the checkpoints approvals log before code.

## 1. non-goals

not in this spec, belongs to the fork:

- anything reward, coin, points, wheel, voucher, or cash-out related (banned by the ripples spec: "gamification")
- a `daily` board kind, deadlines, chain/`requires` links, seeded personal habits
- any new metric beyond the ripples analytics inventory
- macos ("designed for ipad") or android product ui
- renaming, re-branding, readme rewrite for habit-system

not in this spec, stays out of ripples forever:

- widget in-place quick check-in. proven impossible with `expo-widgets` in sdk 57: the widget button's intent performs in the extension process and its event never reaches the app. the deep-link fallback to add check-in is the spec's rule for an action that cannot safely run. no further work.

## 2. prerequisites (human-supplied, rami)

| input | needed by | status |
|---|---|---|
| apple developer team with app group, icloud/cloudkit, widget, app intents, alternate-icon signing | items 3.1, 3.2, 3.3, 3.5 | unknown - round 2 q1 |
| cloudkit container `iCloud.com.ramimaalouf.habittracker` created in the developer portal (or an approved equivalent id, which is an "ask first" change) | 3.1 | blocked on team |
| a signed physical iphone (spec: "a signed physical iphone for the final icloud, widget, shortcut, and siri checkpoint") | 3.1, 3.2 device evidence | blocked on team |
| midnight and paper icon artwork, human approved | 3.3 | missing |
| product and legal urls: feedback, app store review, more products, privacy policy, terms of use | 3.7 | missing |

if the team does not exist yet: do items 3.4, 3.6, 3.7, 3.8 now (no signing needed), fork, and build the native module inside the fork when the team exists. the module code is identical either way; only where the commit lands changes.

## 3. work items

ordered by dependency, then by value to the fork.

### 3.1 local native module: cloudkit transport

**what exists.** the sync engine is complete and tested against a deterministic fake (`tests/product/helpers/fake-transport.ts`): provider-neutral records (`src/core/sync/records.ts`), hybrid logical clock (`hybrid-clock.ts`), conflict resolution, tombstones, outbox, bounded retry with jitter, status machine (`engine.ts`). the only missing piece is the ios adapter. `src/platform/sync/index.ios.ts` exports `cloudKitAvailable = false` and a transport whose three methods throw `SyncTransportError('unavailable')`, so settings > icloud sync reports `needs attention` and queues every change.

**the port to implement** (`src/core/sync/transport.ts`, do not change it):

```ts
interface SyncTransport {
  ensureZone(): Promise<void>;                       // creates the custom private zone when missing; idempotent
  upload(records: SyncRecord[]): Promise<void>;      // idempotent by (entityId, mutationStamp)
  fetchChanges(token: string | null): Promise<FetchPage>;
}
// SyncRecord = { schemaVersion, entityType, entityId, mutationStamp, deleted, fields }
// FetchPage  = { records, nextToken, more }
// SyncFailureCode = 'offline' | 'signed_out' | 'unavailable' | 'failure'
```

**scope.**

- scaffold the one approved module: `bunx create-expo-module@latest --local modules/ripples-apple`. review generated files before they enter source control (spec 6.1). this is the only custom native module the spec allows; cloudkit, app intents, and alternate icons all live in it.
- swift implementation exposing `ensureZone`, `upload`, `fetchChanges` to js through the module, with a typed error mapping to the four `SyncFailureCode` values:
  - `signed_out`: `CKAccountStatus` is `noAccount` or `restricted`
  - `offline`: `CKError.networkUnavailable` / `networkFailure`
  - `unavailable`: entitlement or container missing, `CKAccountStatus.couldNotDetermine`
  - `failure`: everything else. raw cloudkit error text is never surfaced or logged (spec: "raw cloudkit errors and account data are never shown or logged")
- record mapping: one `CKRecord` per `SyncRecord`. record type = `entityType`, record name = `entityId`, fields written as-is from the snake_case `fields` map plus `schema_version`, `mutation_stamp`, `deleted`. tombstones carry only structural linkage and timestamps (already enforced by `records.ts`; the swift side must not add fields).
- zone: one custom private zone (name decision below). `ensureZone` is idempotent.
- `upload`: `CKModifyRecordsOperation` with `savePolicy = .allKeys` (the js engine already resolved conflicts by mutation stamp; the server must not second-guess). batched under cloudkit's per-operation limit with partial-failure handling per record.
- `fetchChanges`: `CKFetchRecordZoneChangesOperation` with the persisted server change token. return `nextToken` only when the page committed; the js engine persists tokens after local commit (spec: "change tokens are persisted only after all fetched records commit locally").
- `cloudKitAvailable` becomes a runtime check (entitlement present and account status determinable), not a constant.
- config plugin in `modules/ripples-apple/plugin/` adds the icloud services and container entitlements. `app.json` already lists them under `ios.entitlements`; move or keep, but one source only. generated `ios/` stays uncommitted.

**decision (rami):** `CKSyncEngine` vs direct operations. the current comment in `index.ios.ts` mentions cksyncengine. recommendation: **direct operations**. the js engine already owns state, outbox, retry, and conflict policy; cksyncengine would duplicate all four and fight the `SyncTransport` port. direct operations map 1:1 onto the port.

**decision (rami):** zone name. recommendation: `ripples`. the fork renames to `habit-system` in its own container, so nothing is shared.

**tests.**

- js side: no new engine tests needed; the fake already covers conflict, retry, token, tombstone, out-of-order delivery.
- swift side: the error-code mapping and record mapping get a swift unit test target in the module, plus a json fixture of sample `SyncRecord`s round-tripped through the mapping.
- `test:sync` script: create `tests/product/sync/` and move or add the engine-with-fake suites there so the existing package script stops pointing at a missing directory (see 3.6).

**evidence (spec success criterion 18).** two signed targets (physical iphone + a second signed target: second device or a signed simulator build with an icloud sandbox account): create, edit, archive, delete, offline mutation on both, reconnect, conflict convergence. record the argent session and screenshots in `checkpoints.md`. settings > icloud sync shows `up to date`.

### 3.2 local native module: app intents executor (shortcuts and siri)

**what exists.** typescript executor and the shared fixture suite are complete: `src/core/automations/contract.ts` and `src/core/automations/fixtures/intent-contract.json` ("the native executors read this file verbatim"). commands already resolve inside the envelope: `createCheckIn` reports the logical date it recorded, `removeLatestCheckIn` resolves its target inside the receipt.

**scope.** in `modules/ripples-apple/ios/`:

- `Board` as an `AppEntity`, backed by active boards only, in active order. archived or deleted boards fail with an actionable result.
- exactly three intents (spec: "the release exposes exactly three intents"):
  1. **check in**: board, optional date, optional time, optional amount, optional note. date defaults to the board's current logical date. omitted amount uses `quickAmount`.
  2. **remove latest check-in**: board, optional date. identifies the latest record by the history ordering rule, asks for confirmation, returns not found without mutation when none exists.
  3. **get today's check-ins**: optional board. returns counts plus board names for the current logical date. never returns note text.
- the swift executor opens the same app-group sqlite database, runs the same validation, idempotency receipt, mutation stamp, widget projection update (`widget_board_rows`), and sync outbox write as the typescript executor, inside one exclusive transaction. it never records an unvalidated partial row.
- a swift test target loads `intent-contract.json` verbatim, seeds the fixture store, runs every case, and asserts the fixture outcomes. this is the contract that stops native from forking product semantics.

**decision (rami):** the swift executor needs the schema and command logic in swift (a second implementation of `createCheckIn` / `removeLatestCheckIn`). the spec accepts this ("the native intent executor and typescript executor pass one shared json contract-fixture suite"). alternative: intents deep-link into the app and let js execute. recommendation: **implement in swift as specified**; the fixture suite exists precisely to make this safe, and a deep-link intent cannot return a result to siri.

**evidence.** shortcuts app: each intent runs against a signed build; siri phrase for check in. screenshots and argent session in `checkpoints.md`.

### 3.3 local native module: alternate app icons

**what exists.** `src/features/settings/app-icon-screen.tsx` shows default, midnight, paper previews and says selection arrives with a native update. `selectedIcon` persists in `app_settings` (`default | midnight | paper`).

**scope.**

- `AlternateIconAdapter` in the module: `supportsAlternateIcons()` and `setAlternateIcon(name | null)` wrapping `UIApplication.setAlternateIconName`.
- `src/platform/alternate-icons/` (the spec's planned directory) with `index.ios.ts` calling the module and `index.ts` returning unsupported on other platforms.
- the setting persists **only after the platform confirms success** (spec 5.x). failure restores the previous selection and shows a retryable message.
- icon assets: `assets/images/alternate-icons/midnight.png`, `paper.png` at the sizes xcode requires, wired through the module's config plugin into the generated asset catalog. blocked on human-approved artwork.
- tests: supported, unsupported, success, rollback (spec test inventory line "alternate icon supported, unsupported, success, and rollback").

**evidence.** change icon, relaunch, icon persists (spec device checklist item 13).

### 3.4 reference seed fixture

**what the spec says.** "the implementation uses deterministic seed data reproducing the seven reference board names and august 2026 activity only in development and visual tests. seed data is never inserted into a normal user's database." planned file: `src/testing/fixtures/reference-august-2026.ts`. it does not exist.

**scope.**

- write the fixture: seven boards with the reference names (take them from the visual reference contract table in the product spec and the existing `intent-contract.json` seed style), symbols from the sf symbol allowlist, colors, and a deterministic set of august 2026 check-ins that produces non-empty seven-day strips and a visibly populated heatmap.
- a dev-only entry point (behind `__DEV__` and an explicit action under `src/app/(dev)/`) that inserts the fixture into an **empty** database only. never runs in release builds; a test asserts the guard.
- value to the fork: every future demo and screenshot starts from a populated database instead of the "open ripples to create your first board" empty state (the demo runbook currently scripts board setup off camera to hide this).

**tests.** fixture shape validated against `validateBoard` / `validateCheckIn`; the insert is idempotent; release-build guard.

### 3.5 close the pending independent review

`checkpoints.md` p5 reminders: "gpt-5.6 sol review of this stage: pending (bounded run follows this checkpoint)." every other stage has a recorded pass. run the review, remediate findings with regression tests, record the result. the fork should not inherit an unreviewed stage in its history.

### 3.6 fix the package scripts that point at nothing

`package.json` has `test:contracts -> tests/product/contracts` and `test:sync -> tests/product/sync`. neither directory exists (`tests/product/` holds `domain`, `features`, `helpers`, `migrations`).

**scope.** create both directories and move the matching suites into them:

- `tests/product/contracts/`: the automation contract test (`tests/product/domain/automations.test.ts`) and the android-readiness contract test.
- `tests/product/sync/`: the engine, hybrid clock, records, and fake-transport suites currently under `tests/product/domain/`.

update `jest.config.js` coverage path groups if they key on directory. `bun run validate` must stay green; the 100 percent branch gate on `src/core/sync/` must still be enforced after the move.

### 3.7 record the spec/code drift

the product spec and the code disagree in three places. the fork should start from a spec that describes the code.

1. **import.** spec: "import is not implemented." code: `src/app/settings/import.tsx`, `src/features/settings/import-screen.tsx`, `src/core/export/import-parsers.ts` with `parseRipplesCsv`, `importSnapshot` command, user-directed in p5-partial. amend the spec: add import (own export json + ripples csv) to the export section, add the import route to the route table, add the import invariants sol's review pinned (tombstone-aware id checks, sanitized activity periods, fail-soft per-record parsing, forbidden-key leak scan).
2. **timeline route.** `src/app/settings/timeline.tsx` and `timeline-screen.tsx` exist and are not in the spec's route list. either specify it or remove it. recommendation: specify it; it exists and is tested.
3. **release links.** the spec's `platform/product-links/` directory is `src/features/settings/release-links.ts` in code. update the project structure section.

these are "ask first" changes to the spec ("change a product rule ... in this specification"). rami approves, the approval is logged in `checkpoints.md`, then the spec is edited.

### 3.8 fork readiness checklist (last item, after 3.1 to 3.7 or after the decision to skip the module)

- `bun run validate` exit 0, `bunx expo-doctor` 21/21, `git diff --check` clean
- `git status` clean on `main`, all pushed to `origin/main`
- `checkpoints.md` has a final "pre-fork closure" entry listing which of 3.1 to 3.7 landed and which are deferred to the fork, with reasons
- no personal data in the tree: `git ls-files` contains no `design/ripples-screenshots/`, `.artifacts/`, exports, `.env.secrets.local` (spec: keep private references untracked). verify `.gitignore` covers each.
- tag the fork point: `git tag ripples-v1-fork-point` so the fork's first commit can cite the sha.

## 4. order of execution

```
3.6 scripts  ->  3.5 review  ->  3.7 spec drift  ->  3.4 fixture
      (no signing needed, can start today)
                     |
                     v
3.1 cloudkit  ->  3.2 intents  ->  3.3 icons
      (needs apple developer team + signed build)
                     |
                     v
                3.8 fork readiness  ->  fork to habit-system
```

if the team is not available within the window rami wants to start the fork: run the top row, then 3.8, fork, and carry 3.1 to 3.3 as the fork's first native milestone. record that choice in the checkpoints closure entry.

## 5. process rules that still apply (from the ripples specs)

- red, green, refactor per task. jest + react native testing library, queries by accessible role and name.
- 90 percent global coverage; 100 percent branches on domain commands, calendar, analytics, migrations, export, sync.
- simulator or device evidence through argent before every commit; independent verification by a second model; a `checkpoints.md` entry per task. "the verifier cannot be the author of the task under review."
- native controls are not restyled. `boxShadow` only. 44-point targets. 200 percent dynamic type. color is never the only indicator of state.
- never: a second product store, bypassing validation or idempotency from widgets/intents/sync, logging note contents or cloudkit records, committing generated `ios/` or private screenshots, weakening tests to pass a gate, agent co-author lines.
- ask first before: changing bundle id `com.ramimaalouf.habittracker`, app group `group.com.ramimaalouf.habittracker`, cloudkit container `iCloud.com.ramimaalouf.habittracker`, widget extension id, minimum ios 18.6, signing team, intent inventory, export schema, or adding a second native module.

## 6. decisions this spec needs from rami

1. apple developer team: exists now, or fork first? (round 2 q1)
2. cloudkit implementation: direct operations (recommended) or `CKSyncEngine`?
3. zone name: `ripples` (recommended)?
4. app intents: swift executor against the fixture suite (recommended, as specified) or deep-link into the app?
5. spec drift (3.7): approve amending the product spec for import, timeline, release-links location?
6. timeline route: keep and specify (recommended) or remove?
7. icon artwork: will midnight and paper artwork be supplied, or should 3.3 ship the adapter with only `default` and leave the two previews hidden until artwork exists?

## 7. what the fork gets from this

- a real cloudkit transport behind the unchanged `SyncTransport` port, which the macos app (designed-for-ipad first, native later) will share by pointing at the fork's own container
- a native module skeleton where the fork's own native needs land (nothing reward-related needs native code, but alternate icons and intents for "check in" carry over unchanged)
- a populated demo database on first run
- a spec that matches the code, so the fork's spec amendments start from truth
- a clean, reviewed, tagged history
