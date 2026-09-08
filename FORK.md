# fork origin

this repository is a full-history fork of ripples.

- origin repo: https://github.com/rami-maalouf/habit-tracker (product name ripples)
- fork point: tag `ripples-v1-fork-point`, commit `5ed71a2`, 2026-09-07
- fork method: clone with full git history, no github fork link. ripples fixes are cherry-picked by hand if ever needed.
- what ripples proved before the fork: the first section of `checkpoints.md` ("pre-fork closure").

## identifiers that must change before the first build

the tree still carries ripples' identity. a build from this tree as-is would upload to ripples' eas project and write into ripples' cloudkit container and app-group database. change every one of these before running `eas build`, `expo run:ios`, or `eas update`:

| where | ripples value | must become |
| --- | --- | --- |
| `app.json` `expo.name` / `expo.slug` | `habit-tracker` | the fork's name and slug |
| `app.json` `ios.bundleIdentifier` | `studio.orbitlabs.habittracker` | a new bundle id |
| `app.json` expo-widgets `groupIdentifier` and the `ios.entitlements` app group | `group.studio.orbitlabs.habittracker` | a new app group |
| cloudkit container (module plugin + entitlements) | `iCloud.studio.orbitlabs.habittracker` | a new container |
| cloudkit zone (module plugin) | `habit-tracker` | a new zone name |
| widget extension name and bundle suffix | `RipplesBoards` / `ExpoWidgetsTarget` | rename |
| `app.json` `extra.eas.projectId` and `updates.url` | ripples' eas project `1e477943-...` | a new eas project (`eas init`) |
| `app.json` `scheme` | `habittracker` | a new url scheme |
| `package.json` `name` | `habit-tracker` | the fork's name |
| signing team | `3V2UU7RRK9` | same team is fine; new provisioning profiles are required for the new ids |

the local native module directory `modules/ripples-apple` and its swift type names can be renamed later; they are not shared state.

## what is inherited on purpose

- boards, check-ins, analytics, reminders, widgets, export/import, the native look
- the cloudkit transport, app intents executor, and alternate-icon adapter in the single approved native module
- the development fixture `src/testing/fixtures/reference-august-2026.ts`
- the test suites and coverage gates

## what this fork adds (see the product spec, once written)

a flexible habit list, daily binary habits alongside count habits, and a fully digital earned-reward economy. ripples' spec bans gamification; this fork's spec replaces that rule.
