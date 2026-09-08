const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { getPngInfo } = require('@expo/image-utils');
const { configureEntitlements, configureInfoPlist, writeAlternateIcons } = require('../../plugin');
const withRipplesApple = require('../../plugin');

const appDelegateFixture = `internal import Expo
import React

class AppDelegate: ExpoAppDelegate {
  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    initializeReactNative()
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  public override func application(_ app: UIApplication, open url: URL) -> Bool {
    return openExistingLink(url)
  }
}
`;

async function applyAppDelegateMod(contents, language = 'swift') {
  const config = withRipplesApple({ ios: { bundleIdentifier: 'studio.orbitlabs.habitsystem' } });
  return config.mods.ios.appDelegate({
    ...config,
    modRequest: { platform: 'ios', modName: 'appDelegate' },
    modResults: { path: '/fixture/AppDelegate.swift', language, contents },
  });
}

test('native startup registers the three app shortcuts once across repeated prebuilds', async () => {
  const first = (await applyAppDelegateMod(appDelegateFixture)).modResults.contents;
  const second = (await applyAppDelegateMod(first)).modResults.contents;
  const call = 'RipplesApplicationShortcuts.updateAppShortcutParameters()';
  assert.equal(second, first);
  assert.equal(first.split(call).length - 1, 1);
  assert.equal(first.split('import AppIntents').length - 1, 1);
  assert.ok(first.indexOf(call) > first.indexOf('initializeReactNative()'));
  assert.ok(first.indexOf(call) < first.indexOf('return super.application(application, didFinishLaunchingWithOptions: launchOptions)'));
  assert.ok(first.includes('return openExistingLink(url)'));
  assert.ok(first.startsWith('import AppIntents\ninternal import Expo'));
});

test('shortcut startup registration fails closed when the native launch hook changes', async () => {
  await assert.rejects(applyAppDelegateMod(appDelegateFixture, 'objc'), /swift app delegate/);
  await assert.rejects(applyAppDelegateMod('import Expo\nclass AppDelegate {}'), /launch hook/);
  await assert.rejects(applyAppDelegateMod(appDelegateFixture + appDelegateFixture), /launch hook/);
});

test('shortcut registration rejects duplicate or misplaced executable calls', async () => {
  const call = 'RipplesApplicationShortcuts.updateAppShortcutParameters()';
  const registered = (await applyAppDelegateMod(appDelegateFixture)).modResults.contents;
  await assert.rejects(applyAppDelegateMod(registered.replace(call, `${call}\n    ${call}`)), /shortcut registration/);
  await assert.rejects(applyAppDelegateMod(appDelegateFixture.replace('return openExistingLink(url)', `${call}\n    return openExistingLink(url)`)), /shortcut registration/);
  await assert.rejects(applyAppDelegateMod(appDelegateFixture.replace('    initializeReactNative()', `    ${call}\n    initializeReactNative()`)), /shortcut registration/);
});

test('a commented registration example never suppresses the executable startup call', async () => {
  const call = 'RipplesApplicationShortcuts.updateAppShortcutParameters()';
  const source = `// ${call}\n${appDelegateFixture}`;
  const first = (await applyAppDelegateMod(source)).modResults.contents;
  assert.match(first, /\n    RipplesApplicationShortcuts\.updateAppShortcutParameters\(\)\n    return super/);
  assert.equal((await applyAppDelegateMod(first)).modResults.contents, first);
});

test('generated shortcut provider uses the statically linked intents without an external package dependency', async () => {
  const projectRoot = path.resolve(__dirname, '../../../..');
  const platformProjectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ripples-native-config-'));
  try {
    const config = withRipplesApple({ ios: { bundleIdentifier: 'studio.orbitlabs.habitsystem' } });
    await config.mods.ios.dangerous({
      ...config,
      modRequest: { platform: 'ios', modName: 'dangerous', projectRoot, platformProjectRoot, projectName: 'fixture' },
      modResults: {},
    });
    const source = await fs.readFile(path.join(platformProjectRoot, 'fixture/RipplesApplicationIntents.swift'), 'utf8');
    assert.doesNotMatch(source, /:\s*AppIntentsPackage\b|includedPackages/);
    assert.match(source, /struct RipplesApplicationShortcuts: AppShortcutsProvider/);
    const intents = [...source.matchAll(/intent: (Ripples\w+Intent)\(\)/g)].map((match) => match[1]);
    assert.deepEqual(intents, ['RipplesCheckInIntent', 'RipplesRemoveLatestCheckInIntent', 'RipplesTodayCheckInsIntent']);
  } finally {
    await fs.rm(platformProjectRoot, { recursive: true, force: true });
  }
});

test('one bundle identifier drives app group, cloudkit and native lookup keys idempotently', () => {
  const bundle = 'studio.orbitlabs.habitsystem';
  const entitlements = configureEntitlements({ 'aps-environment': 'development' }, bundle);
  assert.deepEqual(configureEntitlements(entitlements, bundle), entitlements);
  assert.equal(entitlements['aps-environment'], 'development');
  assert.deepEqual(entitlements['com.apple.security.application-groups'], [`group.${bundle}`]);
  assert.deepEqual(entitlements['com.apple.developer.icloud-container-identifiers'], [`iCloud.${bundle}`]);
  assert.deepEqual(entitlements['com.apple.developer.icloud-services'], ['CloudKit']);
  assert.equal(entitlements['com.apple.developer.icloud-container-environment'], 'Development');
  const plist = configureInfoPlist({ CFBundleDisplayName: 'Ripples' }, bundle);
  assert.deepEqual(configureInfoPlist(plist, bundle), plist);
  assert.equal(plist.RipplesAppGroupIdentifier, `group.${bundle}`);
  assert.equal(plist.RipplesCloudKitContainerIdentifier, `iCloud.${bundle}`);
  assert.equal(plist.CFBundleDisplayName, 'Ripples');
});

test('cloudkit release environment is explicit and rejects unknown values', () => {
  const bundle = 'studio.orbitlabs.habitsystem';
  const environmentKey = 'com.apple.developer.icloud-container-environment';
  assert.equal(configureEntitlements({}, bundle, 'Production')[environmentKey], 'Production');
  assert.throws(() => configureEntitlements({}, bundle, 'production'), /cloudkit environment/);
  const profiles = require('../../../../eas.json').build;
  assert.equal(profiles.development.env.RIPPLES_CLOUDKIT_ENVIRONMENT, 'Development');
  assert.equal(profiles.production.env.RIPPLES_CLOUDKIT_ENVIRONMENT, 'Production');
});

test('alternate artwork produces opaque universal 1024px app icon sets on repeat prebuilds', async () => {
  const root = path.resolve(__dirname, '../../../..');
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'ripples-icons-'));
  try {
    await writeAlternateIcons(root, output);
    await writeAlternateIcons(root, output);
    for (const name of ['midnight', 'paper']) {
      const directory = path.join(output, `${name}.appiconset`);
      const contents = JSON.parse(await fs.readFile(path.join(directory, 'Contents.json'), 'utf8'));
      assert.deepEqual(contents.images, [{ filename: 'icon.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }]);
      const info = await getPngInfo(path.join(directory, 'icon.png'));
      assert.equal(info.width, 1024);
      assert.equal(info.height, 1024);
      assert.equal(info.bpp, 3);
    }
  } finally {
    await fs.rm(output, { recursive: true, force: true });
  }
});

test('app configuration carries the fork identity and never the ripples identity', () => {
  const root = path.resolve(__dirname, '../../../..');
  const app = require(path.join(root, 'app.json')).expo;
  const pkg = require(path.join(root, 'package.json'));
  assert.equal(pkg.name, 'habit-system');
  assert.equal(app.name, 'habit-system');
  assert.equal(app.slug, 'habit-system');
  assert.equal(app.scheme, 'habitsystem');
  assert.equal(app.ios.bundleIdentifier, 'studio.orbitlabs.habitsystem');
  assert.equal(app.ios.infoPlist.CFBundleDisplayName, 'Habit System');
  const widgets = app.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-widgets')[1];
  assert.equal(widgets.groupIdentifier, 'group.studio.orbitlabs.habitsystem');
  assert.equal(widgets.widgets[0].displayName, 'Habit System');
  assert.equal(widgets.widgets[0].name, 'HabitSystemBoards');
  assert.equal(widgets.widgets[0].description, 'Your boards with seven-day strips and quick check-in.');
  // the app group is duplicated as a typescript constant; it must not drift from the plugin-derived value
  const databaseSource = require('node:fs').readFileSync(path.join(root, 'src/platform/database/index.ts'), 'utf8');
  assert.match(databaseSource, /appGroupId = 'group\.studio\.orbitlabs\.habitsystem'/);
  const transportSource = require('node:fs').readFileSync(path.join(root, 'modules/ripples-apple/ios/CloudKitTransport.swift'), 'utf8');
  assert.match(transportSource, /static let zoneName = "habit-system"/);
  const podspec = require('node:fs').readFileSync(path.join(root, 'modules/ripples-apple/ios/RipplesApple.podspec'), 'utf8');
  assert.match(podspec, /s\.homepage\s*=\s*'https:\/\/github\.com\/rami-maalouf\/habit-system'/);
  assert.match(podspec, /git: 'https:\/\/github\.com\/rami-maalouf\/habit-system\.git'/);
  const widgetSource = require('node:fs').readFileSync(path.join(root, 'src/platform/widgets/ripples-boards-widget.tsx'), 'utf8');
  assert.match(widgetSource, /createWidget\('HabitSystemBoards'/);
  assert.doesNotMatch(widgetSource, /habittracker:\/\//);
  const intentsSource = require('node:fs').readFileSync(path.join(root, 'modules/ripples-apple/ios/Intents/RipplesAppIntents.swift'), 'utf8');
  assert.doesNotMatch(intentsSource, /RipplesBoards/);
  assert.match(intentsSource, /reloadTimelines\(ofKind: "HabitSystemBoards"\)/);
  assert.equal(app.extra.eas.projectId, '07481ea0-9f44-4f24-ad3c-fd889569cade');
  assert.equal(app.updates.url, `https://u.expo.dev/${app.extra.eas.projectId}`);
  const serialized = JSON.stringify(app) + JSON.stringify(pkg);
  assert.doesNotMatch(serialized, /habittracker|habit-tracker|1e477943/);
});
