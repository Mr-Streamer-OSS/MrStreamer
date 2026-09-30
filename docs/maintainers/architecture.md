# Architecture

An Electron app in a pnpm workspace. The main process owns everything that touches the network, the disk and the system; the renderer shows state and starts actions over a typed IPC contract.

```
packages/contracts   @mrstreamer/contracts: IPC schemas, library and guide models, errors,
                     versions, updates. Depends on nothing else in the workspace.
packages/core        @mrstreamer/core: rules that run without Electron, React or the DOM. Catalogue
                     names and regions, trusted guide ids, the XMLTV reader, update feeds, the
                     provider port, text folding. Depends on contracts.
apps/desktop         The app, package name mrstreamer
  src/main           Electron main process
    providers        The Xtream Codes adapter
    services         Subscription, live library, programme guide, playback proxy, preferences,
                     updates
    playback         Stream inspection, the clean start and ffmpeg conversion behind the proxy
    platform         Keychain-backed secrets, atomic JSON files, the electron-updater installer
  src/preload        The typed bridge exposed to the UI
  src/renderer       React UI; player/ holds the playback engines, the player controller, Picture
  src/shared         What main and the renderer share inside the app: window bar sizes
  scripts            Icons, the DMG background, signing, notarization, ffmpeg builds, guide budgets
  test               Service suites, the fake provider, codec clips, packaged-app test, measurements
scripts              Release planning and CI signing, run from the repository root
test                 The release planning suite
```

Packages export their source files by path, `@mrstreamer/core/catalogue/normalize`, and the app bundles them; nothing is built separately. Lint rules keep packages from importing Electron, React or the app, contracts from importing core, and every file from import cycles. `scripts/release-plan.ts` imports `packages/contracts/src/version.ts` by relative path, because release jobs run it before installing packages.

`@mrstreamer/contracts/ipc` is the contract: each method has an input schema (ArkType) and a result type, and the main process validates every call before its handler runs. The preload script exposes it as `window.mrStreamer`; the renderer reaches it through `lib/ipc.ts` and React Query hooks in `lib/queries.ts`.

## Data

Everything lives in Electron's `userData` folder, named after the product, not the app id: see the [user troubleshooting page](../user/troubleshooting.md#where-your-data-is). Each file is written atomically; leftovers of an interrupted write are removed at startup. Changes to these files must stay readable by the newest stable release: choosing Stable on a nightly installs that release over the nightly, and it reads what the nightly wrote. Add fields rather than change a file's version: older readers ignore keys they don't know and keep them when they write.

| File                | Owner                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------ |
| `subscription.json` | `services/subscription.ts`; the password is sealed with `safeStorage`                      |
| `preferences.json`  | `services/preferences.ts`: volume, last channel and category, history, favourites          |
| `catalogue.json`    | `services/library.ts`: the last good catalogue, as the provider sent it                    |
| `guide.xml`         | `services/guide.ts`: the last complete XMLTV download, as it arrived                       |
| `guide.json`        | `services/guide.ts`: which subscription `guide.xml` belongs to, and when it was downloaded |
| `updates.json`      | `services/updates.ts`: the chosen channel                                                  |

## Catalogue

The library fetches categories and channels, indexes them in memory and caches the provider's raw answer; display names are worked out on load, so naming rules improve without a refetch. A refresh replaces the catalogue only when it looks complete: an empty answer never does, and one with less than half the channels only when a second fetch agrees. A failed refresh keeps the catalogue and reports the failure in the status. Preferences refer to provider ids, so renamed or reordered channels keep their history and favourites.

Each channel keeps the provider's guide id (`epg_channel_id` on Xtream panels). Quality variants of one channel usually share it, but panels also file unrelated channels under one id: Wout's lists nine Flemish channels under `PlayCrime.be`. `@mrstreamer/core/catalogue/guide-ids` keeps an id for a channel only when the channel's name matches the id, or when every channel sharing it is the same channel under another name or quality. The guide's own channel names don't count: panels copy them from their stream list. On Wout's provider this keeps 1,978 of 2,073 channels with programmes. A cache saved before guide ids existed still loads, and counts as due for a refresh at the next start.

## Programme guide

`services/guide.ts` downloads the provider's XMLTV (`xmltv.php` on Xtream panels) and keeps it separate from the catalogue and playback: listings are empty until a guide loads, and nothing waits for one. `@mrstreamer/core/guide/xmltv` reads the document as it arrives, from the network or from `guide.xml` after a restart. It searches the bytes and decodes one programme at a time, so the strings it keeps don't hold on to the chunks they came in. Programmes that already ended are dropped; a programme without an end runs until the next one, and overlaps are cut. Titles are folded for search as they arrive, and the last step yields to the event loop every 50 channels.

A download replaces the guide only when it completes and lists programmes; otherwise the last guide stays. The main process downloads after connecting a subscription, at startup, and whenever a 15-minute check finds the guide more than six hours old. Switching accounts clears it.

The UI asks `guide.listings` for now and next per channel, `guide.schedule` for one channel's day and `guide.search` for programme titles. Lists ask for listings in pages of 40 as rows come into view, and again each minute. `apps/desktop/scripts/measure-guide.ts` measures download, indexing, stalls, lookups and memory against the slice 03 budgets.

## Views and the picture

The window shows a page, Home or the Live TV guide, and Watch opens over it. The page stays laid out underneath, hidden, so leaving Watch finds it scrolled where it was.

There is one `<video>` element, created by the player controller (`player/player.ts`). Home's backdrop, the guide's preview and Watch each render a `Picture` (`player/Picture.tsx`); the active one holds the element, moved with `moveBefore` so it keeps playing. Moving between views never reopens the stream or opens a second provider connection. The packaged-app test checks this through the fake provider's stream count.

Sound follows the view: Watch plays at the viewer's volume, and pages keep the stream muted unless the speaker is pressed (`audible` in the player state). Pages start a muted preview of the last channel. A preview never reconnects after a failure, so a connection another device holds isn't fought over, and it stops while the window is hidden and restarts when it shows. Stop in Watch keeps previews from starting it again.

Lists keep one keyboard selection, separate from the pointer. Only the keyboard moves it or scrolls a list to it; the pointer only hovers, and the selection shows only while the keyboard was used last (`lib/input-mode.ts`). Wheel and trackpad gestures only scroll. Key handlers register once and read the current render through a ref: a handler registered again on every render can miss a key, because a state change in another keydown listener renders between listeners.

## Playback

The UI never sees provider URLs; they contain the login. `playback.open` returns a `127.0.0.1` URL with a random token, and only one session is open at a time, because many subscriptions allow one connection. When the player requests the URL, the proxy connects upstream and then, before sending anything:

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
