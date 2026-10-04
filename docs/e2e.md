# Local iOS test targets

Run on the dedicated simulator (the default):

```sh
bun run test:e2e:simulator
```

Run on a connected physical iPhone:

```sh
bun run test:e2e:device
```

Both commands launch `studio.orbitlabs.habitsystem.dev`. Install the development
build appropriate for the target first: an iPhone `.ipa` cannot run on a simulator.
Connect the development app to this checkout's Metro on port 8082.

The simulator command selects `Habit System QA` and boots it if needed. The device
command selects the single connected iPhone. It fails if none or several are
available, rather than choosing another kind of device. To choose by name or UDID:

```sh
E2E_DEVICE="another simulator name" bun run test:e2e:simulator
E2E_DEVICE="your-iphone-udid" bun run test:e2e:device
```

Pass test files and runner flags normally:

```sh
bun run test:e2e:simulator tests/e2e/layouts.e2e.ts
```

The same selection works for exploration:

```sh
E2E_TARGET=simulator bunx e2e explore "check the board layout picker"
E2E_TARGET=device bunx e2e explore "check the board layout picker"
```

`bun run test:e2e` defaults to simulator mode unless `E2E_TARGET=device` is set.
Physical-device automation displays iOS's automation overlay and requires the
automation runner's signing setup. Simulator mode keeps testing off your phone.
Neither mode clears app data.

Existing `E2E_EAS_SIMULATOR=1` runs still use the EAS provider and its build ID.
The two explicit local commands override that flag. `E2E_APP_ID` remains an
optional app identity override for all modes.
