# Architecture

An Electron app in a pnpm workspace. The main process owns everything that touches the network, the disk and the system; the renderer shows state and starts actions over a typed IPC contract.

```
packages/contracts   @mrstreamer/contracts: IPC schemas, library and guide models, errors,
                     versions, updates. Depends on nothing else in the workspace.
packages/core        @mrstreamer/core: rules that run without Electron, React or the DOM. Catalogue
                     names and regions, trusted guide ids, the XMLTV reader, the guide and viewing
                     record services, update feeds, the provider port, text folding. Depends on
                     contracts.
apps/desktop         The app, package name mrstreamer
  src/main           Electron main process
    providers        The Xtream Codes adapter
    services         Subscriptions, library, playback proxy, settings (preferences.json),
                     updates
    playback         Stream inspection, the clean start and ffmpeg conversion behind the proxy
    platform         Keychain-backed secrets, atomic JSON files, the guide and viewing stores, the
                     electron-updater installer
  src/preload        The typed bridge exposed to the UI
  src/renderer       React UI; player/ holds the playback engines, the player controller, Picture
  src/shared         What main and the renderer share inside the app: window bar sizes
  scripts            Icons, the DMG background, signing, notarization, ffmpeg builds, guide and
                     viewing record measurements
  test               Service suites, the fake provider, codec clips, packaged-app test, measurements
scripts              Release planning and CI signing, run from the repository root
test                 The release planning suite
```

Packages export their source files by path, `@mrstreamer/core/catalogue/normalize`, and the app bundles them; nothing is built separately. Lint rules keep packages from importing Electron, React or the app, contracts from importing core, and every file from import cycles. `scripts/release-plan.ts` imports `packages/contracts/src/version.ts` by relative path, because release jobs run it before installing packages.

`@mrstreamer/contracts/ipc` is the contract: each method has an input schema (ArkType) and a result type, and the main process validates every call before its handler runs. The preload script exposes it as `window.mrStreamer`; the renderer reaches it through `lib/ipc.ts` and React Query hooks in `lib/queries.ts`.

## Data

Everything lives in Electron's `userData` folder, named after the product, not the app id: see the [user troubleshooting page](../user/troubleshooting.md#where-your-data-is). Each JSON file is written atomically; leftovers of an interrupted write are removed at startup. Changes to these files must stay readable by the newest stable release: choosing Stable on a nightly installs that release over the nightly, and it reads what the nightly wrote. Add fields rather than change a file's version: older readers ignore keys they don't know and keep them when they write. The one agreed exception: Stable 0.0.1 doesn't read `mrstreamer.db`, so it shows no favourites or watch history.

| File                | Owner                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `subscription.json` | `services/subscription.ts`; the password is sealed with `safeStorage`                     |
| `preferences.json`  | `services/preferences.ts`: volume, mute, last channel and category                        |
| `mrstreamer.db`     | `platform/viewing-store.ts`: the viewing record, favourites and watch history per account |
| `catalogue.json`    | `services/library.ts`: the last good catalogue, as the provider sent it                   |
| `guide.xml`         | `platform/guide-store.ts`: the last complete XMLTV download, as it arrived                |
| `guide.json`        | `platform/guide-store.ts`: which subscription `guide.xml` belongs to, and when it arrived |
| `updates.json`      | `services/updates.ts`: the chosen channel                                                 |
| `diagnostics.log`   | `platform/diagnostics-log.ts`: what the app did; `diagnostics.1.log` is the one before    |

## Catalogue

The library fetches categories and channels, indexes them in memory and caches the provider's raw answer; display names are worked out on load, so naming rules improve without a refetch. A refresh replaces the catalogue only when it looks complete: an empty answer never does, and one with less than half the channels only when a second fetch agrees. A failed refresh keeps the catalogue and reports the failure in the status. Favourites and history refer to provider ids, so renamed or reordered channels keep them.

Each channel keeps the provider's guide id (`epg_channel_id` on Xtream panels). Quality variants of one channel usually share it, but panels also file unrelated channels under one id: Wout's lists nine Flemish channels under `PlayCrime.be`. `@mrstreamer/core/catalogue/guide-ids` keeps an id for a channel only when the channel's name matches the id, or when every channel sharing it is the same channel under another name or quality. The guide's own channel names don't count: panels copy them from their stream list. On Wout's provider this keeps 1,978 of 2,073 channels with programmes. A cache saved before guide ids existed still loads, and counts as due for a refresh at the next start.

## Effect services

The main process runs every service on one [Effect](https://effect.website) runtime (`effect` 4, pinned to a release candidate). `apps/desktop/src/main/runtime.ts` assembles them from Layers in `mainLayer`. `index.ts` makes the runtime at start, forwards each service's changes to the window, and registers the IPC handlers: each returns an Effect, and `ipc.ts` runs it on the runtime.

| Service         | Where                              | Owns                                                   |
| --------------- | ---------------------------------- | ------------------------------------------------------ |
| `Subscriptions` | `services/subscription.ts`         | The login, its sealed password, the provider behind it |
| `Settings`      | `services/preferences.ts`          | `preferences.json`                                     |
| `Library`       | `services/library.ts`              | The catalogue, its cache and refreshes                 |
| `Playback`      | `services/playback.ts`             | Stream sessions and the loopback proxy                 |
| `Updates`       | `services/updates.ts`              | The release channel, checks, downloads and the install |
| `Guide`         | `@mrstreamer/core/guide/service`   | The programme guide                                    |
| `ViewingRecord` | `@mrstreamer/core/viewing/service` | Favourites and watch history                           |

A service is a `Context.Service` class with a `layer`, and reaches the others through the context rather than callbacks. Services whose rules run without the platform live in `packages/core` and ask for what they need through ports, services of their own that the app supplies: the guide's are `GuideSource` (the subscription and its download), `GuideCatalogue` (guide ids) and `GuideStore` (the saved document, `platform/guide-store.ts`). The others live in the app. Every expected failure is a `Failed` from `@mrstreamer/core/failure`, carrying the `AppError` the UI shows; a provider adapter's `AppFailure` keeps its error, anything else counts as unexpected.

Background work, downloads and stream sessions run in their service's scope. Quitting closes open streams at once, so no ffmpeg or provider connection outlives the app, then disposes of the runtime without holding the quit: an update's restart goes through the same path. Disposing stops the calls still running; they answer nobody and aren't logged. Tests build the same layers with the fake provider; `apps/desktop/test/support.ts` makes a runtime per test and calls services with promises, and guide tests move a `TestClock` instead of waiting.

## Diagnostics

`@mrstreamer/core/diagnostics` defines what the app notes about its own work, as a typed union: steps with their duration and outcome (start, login, catalogue and guide downloads, update checks, downloads and installs), each stream the proxy served (direct, converted, repaired or refused, and how long it took to start), and failed IPC calls. Entries hold only names, numbers and failure kinds, so an address, login or channel name can't reach them; `diagnosed(step)` times an Effect and records how it ended. `Diagnostics` is a context reference that records nothing by default. The app provides `platform/diagnostics-log.ts`, which appends JSON lines to `diagnostics.log` and starts a new file at 512 KB, keeping the one before. Nothing is sent anywhere.

## Viewing record

Favourites and watch history are events, per account: `favourite-added`, `favourite-removed` and `watched`, each with a channel id. `@mrstreamer/core/viewing/record` holds the rules as plain functions: `decide` turns a command into events (none when it asks for what already holds), and `apply` adds an event to the state, favourites in the order added and the twelve most recent channels. `@mrstreamer/core/viewing/service` runs commands for the connected account; without one, the lists are empty and changes fail with `no-subscription`.

`platform/viewing-store.ts` keeps them in `mrstreamer.db` with the built-in `node:sqlite`: every event in order, the state they add up to per account, and the ids of commands already done. A command commits its events, its id and the new state in one transaction, so a command sent again changes nothing more. `STATE_VERSION` rises when `apply` changes; the next start then rebuilds the state from every event, skipping events written by a newer version. If the database can't open, the record's calls fail and the rest of the app carries on.

The first start with the record imports the lists `preferences.json` kept before, in the transaction that sets the import marker, and only then takes them out of the file. Lists wait for an account to import into, and connecting a different account drops them. Once the marker is set, lists found in the file again, as after running Stable 0.0.1, are removed without importing.

The UI reads `viewing.get` and sends `viewing.setFavourite` and `viewing.recordWatch` with a command id it makes up. After each commit the main process sends `viewing.changed` with the new sequence, and the UI reads again when it holds an older one. `apps/desktop/scripts/measure-viewing.ts` measures commits, opening and a rebuild with 100,000 events.

## Programme guide

`@mrstreamer/core/guide/service` downloads the provider's XMLTV (`xmltv.php` on Xtream panels) and keeps it separate from the catalogue and playback: listings are empty until a guide loads, and nothing waits for one. `@mrstreamer/core/guide/xmltv` reads the document as it arrives, from the network or from `guide.xml` after a restart. It searches the bytes and decodes one programme at a time, so the strings it keeps don't hold on to the chunks they came in. Programmes that already ended are dropped; a programme without an end runs until the next one, and overlaps are cut. Titles are folded for search as they arrive, and the last step yields to the event loop every 50 channels.

A download replaces the guide only when it completes and lists programmes; otherwise the last guide stays. The main process downloads after connecting a subscription and at startup; the service itself checks every 15 minutes and downloads when the guide is six hours old. Switching accounts clears it: the download in progress stops, and a load or download that finishes afterwards changes nothing. Indexing and lookups are plain functions in `@mrstreamer/core/guide/programmes`.

The UI asks `guide.listings` for now and next per channel, `guide.schedule` for one channel's day and `guide.search` for programme titles. Lists ask for listings in pages of 40 as rows come into view, and again each minute. `apps/desktop/scripts/measure-guide.ts` measures download, indexing, stalls, lookups and memory against the slice 03 budgets.

## Views and the picture

The window shows a page, Home or the Live TV guide, and Watch opens over it. The page stays laid out underneath, hidden, so leaving Watch finds it scrolled where it was.

There is one `<video>` element, created by the player controller (`player/player.ts`). Home's backdrop, the guide's preview and Watch each render a `Picture` (`player/Picture.tsx`); the active one holds the element, moved with `moveBefore` so it keeps playing. Moving between views never reopens the stream or opens a second provider connection. The packaged-app test checks this through the fake provider's stream count.

Sound follows the view: Watch plays at the viewer's volume, and pages keep the stream muted unless the speaker is pressed (`audible` in the player state). Pages start a muted preview of the last channel. A preview never reconnects after a failure, so a connection another device holds isn't fought over, and it stops while the window is hidden and restarts when it shows. Stop in Watch keeps previews from starting it again.

Lists keep one keyboard selection, separate from the pointer. Only the keyboard moves it or scrolls a list to it; the pointer only hovers, and the selection shows only while the keyboard was used last (`lib/input-mode.ts`). Wheel and trackpad gestures only scroll. Key handlers register once and read the current render through a ref: a handler registered again on every render can miss a key, because a state change in another keydown listener renders between listeners.

## Playback

The UI never sees provider URLs; they contain the login. `playback.open` returns a `127.0.0.1` URL with a random token, and only one session is open at a time, because many subscriptions allow one connection. Each session is a scope: closing it, by stopping, switching or quitting, aborts its upstream requests and ends their ffmpeg process. When the player requests the URL, the proxy connects upstream and then, before sending anything:

1. **Inspects** the stream (`playback/inspect.ts`): the program tables name each track's codec; the first frames settle what the tables leave open (MP2 or MP3, 8 or 10-bit HEVC, AAC channel layout). It reads at most 2 MB or 2.5 s and stops as soon as the delivery is settled.
2. **Plans** (`playback/convert.ts`): the renderer reports which codecs its player decodes (`player/decoders.ts`, from `MediaSource.isTypeSupported`). Tracks it decodes are copied; the rest convert: sound to stereo AAC, video to H.264 with deinterlacing, 4K reduced to 1080p.
3. **Starts clean** (`playback/clean-start.ts`): for H.264 and HEVC, drops video before the first keyframe and the leading frames that display before it, so a stream joined mid-sequence starts on a decodable picture.
4. **Delivers**: straight through when nothing converts, otherwise through the bundled ffmpeg reading stdin, so the upstream URL never reaches a command line.

If the player still fails to decode the picture, the player controller retries once with `repair`, which re-encodes the picture and conceals broadcast damage.

Providers send a burst of buffered seconds when a stream opens. mpegts.js jumps forward when the picture falls more than 8 s behind the newest data, keeping 3 s of buffer, instead of playing faster to catch up: a 1.2× rate was audible and visible for half a minute after every start. The [playback evaluation](playback.md) records why this design won over a bundled engine such as libmpv.

## Updates

Nothing updates on its own; see the [user guide](../user/updates.md) for the behaviour.

- `@mrstreamer/core/updates/feed` reads the newest hundred releases from the GitHub API, plus the latest release, which is always the newest stable one however many nightlies came since. A release counts only when its version and pre-release flag name the same channel and it carries this platform's `latest*.yml`. Stable takes the highest stable version, Nightly the highest of both, by version order.
- `services/updates.ts` holds the channel (set from the build on first launch, then only by the user) and the check, download and restart steps. Switching channels drops a downloaded or downloading update the new channel doesn't receive, then checks. Only the latest check counts: one that answers after a newer check or a channel change changes nothing, and download and restart refuse a version the chosen channel doesn't receive. On Stable, a nightly build is offered the newest stable release even when it is older; it installs over the nightly and keeps the data.
- `platform/installer.ts` wraps electron-updater: generic provider pointed at the chosen release, no automatic download, no install on quit, and a check that the metadata names the chosen version. On macOS, Squirrel checks the update's signature only when installing, so a refused update surfaces as a failed install, not a failed download.
