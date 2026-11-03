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

- **Configuration.** `package.json`, the lockfile, `app.json`, `metro.config.cjs`, `index.ts`,
  `tsconfig.json` and `android/` are handed on: a later card adds its native dependency or plugin
  and regenerates `android/` in its own change. Expo Router (58.0.18, with React Native Screens
  4.29.0, the iOS app's pins) is the router; Android's predictive Back is on.
- **Routes.** `index.ts` starts Expo Router on `src/app/`. The root layout shows `connect` while
  no source is saved and the destinations (`(tabs)`) after: Home, Live, Movies and Series
  (`src/navigation/destinations.ts`), each with its own stack, along the bottom on phones and
  down a rail from 600dp, which scrolls when the window is shorter than it. Live (`(live)`, at
  `/`) is where the app opens, and Back at another destination's root returns to it before
  leaving the app. A feature card owns its destination's `index.tsx` and adds its own pushed
  routes beside it (`movies/title/[id].tsx`); Search, Downloads and Settings are
  `(live)/search.tsx`, `downloads.tsx` and `settings.tsx`, which the other destinations
  re-export so each opens on the stack it was opened from (`hrefOn`), at most once. Each stack
  starts on its `index`, and a link that opens the app straight to a pushed screen gets that
  root under it; navigating into another destination's stack while the app runs passes
  `withAnchor: true` for the same. A link to no screen is dropped while the app runs, and one that
  opens the app opens Live, or Connect while no source is saved (`+not-found.tsx`). Live's root shows the bootstrap's channel list under its own header
  until the Live card replaces it.
- **Screens.** Each screen frames itself with `Screen` (`src/navigation/screen.tsx`): its top
  app bar, and the insets `useSafeAreaInsets` still gives its content (the bottom only beside
  the rail). A screen with a list and a selected item passes `detail` (`title`, `content` and
  `onClose`): from 840dp it shows beside the list, below that it takes the list's place under
  its own title, with TalkBack moved there. The bar's Back closes it at either width. The list
  stays mounted with its state but not its scroll offset, which a list restores itself if it
  needs to, and `onClose` returns focus to the selected row. Keep the selection in the route's
  params so it survives rotation into either form.
- **Back order.** A `Sheet` (`src/ui/sheet.tsx`), a dialog or an alert closes before anything
  under it, then the showing screen's detail pane (its `BackHandler` listener, registered only
  while its screen is focused, is newer than the stacks'), then a pushed screen, then the
  destination, back to Live and out. A player or other layer that takes Back registers its
  listener the same way while it shows. This order is checked against the installed router and
  React Native's listeners; on a device it is not yet observed, nor is predictive Back's preview.
- **Sources.** `src/bootstrap/sources.ts` holds the app's one `sources` owner
  (`src/connect/sources.ts`): `restore`, `connect`, `retry`, `remove` and its `state` store. The
  root layout restores it at launch. `sources.json` in the app's files folder lists each
  source's id, kind and host, and nothing of its login.
- **Credentials.** `modules/credentials` seals each source's authority with an AES-GCM key the
  Android Keystore holds, one file per source id under `noBackupFilesDir/credentials`. Native
  code reads it without JS through `app.mrstreamer.credentials.Credentials.read(context, id)`,
  which returns this JSON or null, and throws when the key or the file can't be used:

  ```json
  { "kind": "xtream", "server": "http://tv.example:8080", "username": "…", "password": "…" }
  { "kind": "m3u", "link": "https://lists.example/tv.m3u?token=…" }
  ```

  The app never logs either. The player is the first native worker that holds a source: it stops
  playing a source the moment the source leaves the saved list. A Remove that should wait until
  the player has let go first calls `player.release` (below) before `remove`.

- **Player.** `modules/player` is the app's one Media3 ExoPlayer and MediaSession (`PlayerHost`),
  and `src/player/instance.ts` its one JS owner, `player`. Screens play a `PlayIntent`
  (`src/player/intent.ts`: live, catch-up, title or file), never an address:
  `src/player/resolve.ts` works the address out from the source's protected login each time, and
  it goes only to the native player. Each `play` is a new attempt that replaces the one before;
  commands and observations name their attempt, so nothing late from a replaced one acts on its
  successor. `player.state` holds what the native player observed (phase, position, duration,
  buffer, live and seekable, speed, failure) and the tracks the media declares, each saying
  whether this phone decodes it; `capabilities()` lists the decoders the phone declares. Live
  plays at its live edge and doesn't seek or change speed: going back is catch-up's. `setQuality`
  chooses a video track wherever there are several. `retry()` plays a failed attempt again with
  its address worked out afresh, from the position it reached, and `onSettled(listener)` reports
  where each attempt paused, stopped or ended, once per place, for history to save. A source reads
  only http and https, never http once its address is https; a file reads only files. Media
  buttons and system controls play and pause through the owner. `release(matches)` stops what
  holds a source or file and resolves once the native player says how it let go: `file-closed`;
  `connections-closed`, after which whether the provider counts the connection as ended can't be
  observed; or `unconfirmed` when a reader was still open ten seconds later. No reader of an
  attempt opens once it is let go. Watch is `src/app/watch.tsx`, opened with `watchHref(intent)`
  after `player.play(intent)`; the mini player shows while something plays and Watch doesn't.
  `PlayerSurface` shows the picture: the newest one mounted has it. Playlist channels are found by
  reading the playlist link again until their entry; the shared playlist adapter can answer that
  from its catalogue instead.

- **Long work.** `src/platform/tasks.ts` runs core's paced steps a few slices per task, as the iOS
  app does, so catalogue mapping and naming leave taps and Back responsive.
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
  `src/platform/storage.ts`, `store.ts` and `tasks.ts` follow the iOS app's. The card "Share mobile account
  and catalogue behavior without changing iOS outcomes" owns their one shared replacement.

## Where it stands

Android 0.1.0 is source on `main` only: no build has been distributed, and nothing is on Google
Play. The [Android programme card](https://github.com/orgs/Mr-Streamer-OSS/projects/1?pane=issue&itemId=291935563)
lists the delivery cards that follow this one.
