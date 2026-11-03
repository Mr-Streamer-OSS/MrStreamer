# Mr. Streamer for Android

React Native on Hermes (Expo SDK 58), for Android phones and tablets. It shares
`@mrstreamer/contracts` and the parts of `@mrstreamer/core` that run without Node with the
desktop and iOS apps, and brings its own Android adapters. Nothing of it is in the desktop's
install, build or packages, and it shares no install, lockfile, native module or config with
`apps/ios`.

The bootstrap connects Xtream subscriptions and M3U playlist links, one or several, and lists
every source's channels together, leaving out channels for adults (flagged, or in a category
named for them) until a setting can show them. Connect checks the login with the provider before
anything is saved; a refused or unreachable provider says why and saves nothing. An address typed without
`http://` or `https://` is tried over https first, and plain http is offered only when https
itself failed. Each source shows whether its channels are loading, failed (with Try again) or
listed, and Remove erases its login after a confirmation. At launch every saved source signs in
again from its protected login, checking it with the provider before listing its channels, as Try
again does; one whose login can't be read stays listed and asks for it again through Add provider.

## Its own install

`apps/android` is left out of the root workspace (`pnpm-workspace.yaml`), with its own
`pnpm-workspace.yaml` and lockfile. The shared packages are linked as source, and
`metro.config.cjs` resolves their imports (arktype, effect) from this app, one copy of each, so
keep those two at the versions the root lockfile holds. The workspace installs no peers on its
own, so only the native modules named in `package.json`, and those they depend on (Expo's
`expo-asset`, `expo-font` and `expo-keep-awake` among them), are linked into the build.

```sh
cd apps/android
pnpm install --frozen-lockfile
../../node_modules/.bin/tsc --noEmit -p .
```

Its tests run from the repository's root with the rest (`pnpm exec vitest run apps/android/test`),
resolving the shared packages, React and ArkType from the desktop's install as the iOS tests do
(`vitest.config.ts`).

`patches/` adds `URL.parse` and `URL.canParse` to React Native's type of the global `URL`, the
same change the iOS app carries: at runtime Expo installs a WHATWG `URL` that has both.

## Toolchain

Pinned to the versions the iOS app already resolves, so the shared source compiles under one
React Native: Expo 58.0.9, React Native 0.88.0-rc.4, React 19.3.0, and the native modules at the
versions `expo@58.0.9` bundles (`node_modules/expo/bundledNativeModules.json`). The build uses
the Android Gradle Plugin 9.2.1 and NDK 27.1.12297006 from React Native's Gradle catalogue
(`node_modules/react-native/gradle/libs.versions.toml`), Kotlin 2.2.10 as Gradle resolves it,
and Gradle 9.4.1 from the committed wrapper. Nothing pins the JDK: the Mac mini builds with its
JDK 17. Every native library in the Release
APK is aligned for 16 KB pages.

| Setting         | Value                             | Where                      |
| --------------- | --------------------------------- | -------------------------- |
| Package         | `app.mrstreamer.player`           | `app.json`                 |
| Minimum         | Android 8, API 26                 | `expo-build-properties`    |
| Target, compile | API 36, API 37                    | `expo-build-properties`    |
| ABIs            | `arm64-v8a`, `x86_64` (emulators) | `reactNativeArchitectures` |
| Engine          | Hermes, New Architecture          | `gradle.properties`        |

Expo 58.0.22 with React Native 0.88.1 (stable) has since been released; moving to it is a
separate change for both mobile apps. Release builds are signed with React Native's public debug
key in `android/app/debug.keystore` for local qualification only. Upload and app signing keys,
and which ABIs ship, belong to the release build card.

## Native project

`android/` is committed as `expo prebuild` generated it from `app.json`, so the Gradle wrapper,
template and settings are fixed in source. After changing `app.json`, a config plugin or a native
dependency, regenerate it and commit the result:

```sh
CI=1 pnpm exec expo prebuild --platform android --clean --no-install
```

Build on the Mac mini, where the Android SDK is:

```sh
onmac run -- onmac-job zsh -c 'cd apps/android && pnpm install --frozen-lockfile && cd android && ./gradlew assembleRelease'
```

## Handoff for later Android cards

- **Configuration.** This card owns `package.json`, the lockfile, `app.json`, `metro.config.cjs`,
  `index.ts`, `tsconfig.json` and `android/`. A later card adds its native dependency or plugin
  and regenerates `android/` in its own change, after this card has merged.
- **Route.** `index.ts` registers `src/bootstrap/app.tsx`, which shows Connect while no source
  is saved and the combined channel list after. The Destinations navigation card replaces that
  root with its tabs and stacks; the Connect screen and the sources owner stay as they are.
- **Sources.** `src/connect/sources.ts` is the one owner of saved sources: `restore`, `connect`,
  `retry`, `remove` and its `state` store. `sources.json` in the app's files folder lists each
  source's id, kind and host, and nothing of its login.
- **Credentials.** `modules/credentials` seals each source's authority with an AES-GCM key the
  Android Keystore holds, one file per source id under `noBackupFilesDir/credentials`. Native
  code reads it without JS through `app.mrstreamer.credentials.Credentials.read(context, id)`,
  which returns this JSON or null, and throws when the key or the file can't be used:

  ```json
  { "kind": "xtream", "server": "http://tv.example:8080", "username": "…", "password": "…" }
  { "kind": "m3u", "link": "https://lists.example/tv.m3u?token=…" }
  ```

  The app never logs either. Nothing native holds a source's work yet: the first card that adds
  such a worker also adds the step that stops it before `remove` erases the authority.

- **Storage.** `src/platform/storage.ts` reads and replaces whole JSON files in the app's files
  folder. Downloads and other durable native data choose their own private folders.
- **Backup and network.** Nothing of the app is backed up or moved to another phone:
  `allowBackup: false` up to Android 11, and from Android 12, whose device-to-device transfer
  ignores it, `plugins/no-backup.cjs` excludes every domain from cloud backup and device
  transfer. A reinstall or a new phone starts with no sources. Cleartext http is allowed for
  every host, since viewers type their own providers' addresses; https keeps Android's default
  certificate checks, system authorities only. Provider requests keep no HTTP cache and send or
  store no cookies.
- **Launch.** Restore erases every sealed authority that `sources.json` doesn't name, so a
  damaged list or a connect cut short leaves no login behind.
- **Temporary copies.** `src/connect/playlist.ts` reads M3U links under the iOS app's limits, and
  `src/platform/storage.ts` and `store.ts` follow the iOS app's. The card "Share mobile account
  and catalogue behavior without changing iOS outcomes" owns their one shared replacement.

## Where it stands

Android 0.1.0 is source on `main` only: no build has been distributed, and nothing is on Google
Play. The [Android programme card](https://github.com/orgs/Mr-Streamer-OSS/projects/1?pane=issue&itemId=291935563)
lists the delivery cards that follow this one.
