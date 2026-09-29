# Architecture

An Electron app. The main process owns everything that touches the network, the disk and the system; the renderer shows state and starts actions over a typed IPC contract.

```
src/shared     Contracts between the UI and the main process: IPC schemas, library model, errors,
               versions, updates
src/main       Electron main process
  providers    Provider adapters that report a catalogue as the provider sends it (Xtream Codes)
  catalogue    Display names and region grouping, the same rules for every provider
  services     Subscription, live library, playback proxy, preferences, updates
  playback     Stream inspection, the clean start and ffmpeg conversion behind the proxy
  updates      Reading the release list and picking the release to install
  platform     Keychain-backed secrets, atomic JSON files, the electron-updater installer
src/preload    The typed bridge exposed to the UI
src/renderer   React UI; player/ holds the playback engines and the player controller
scripts        Builds, signing and release helpers
test           Vitest suites, the fake provider, codec clips and the packaged-app smoke test
```

`src/shared/ipc.ts` is the contract: each method has an input schema (ArkType) and a result type, and the main process validates every call before its handler runs. The preload script exposes it as `window.mrStreamer`; the renderer reaches it through `lib/ipc.ts` and React Query hooks in `lib/queries.ts`.

## Data

Everything lives in Electron's `userData` folder, named after the product, not the app id: see the [user troubleshooting page](../user/troubleshooting.md#where-your-data-is). Each file is written atomically; leftovers of an interrupted write are removed at startup.

| File                | Owner                                                                   |
| ------------------- | ----------------------------------------------------------------------- |
| `subscription.json` | `services/subscription.ts`; the password is sealed with `safeStorage`   |
| `preferences.json`  | `services/preferences.ts`: volume, last channel and category, history   |
| `catalogue.json`    | `services/library.ts`: the last good catalogue, as the provider sent it |
| `updates.json`      | `services/updates.ts`: the chosen channel                               |
| `fresh-start.json`  | `services/updates.ts`: present only while a fresh start is under way    |

## Catalogue

The library fetches categories and channels, indexes them in memory and caches the provider's raw answer; display names are worked out on load, so naming rules improve without a refetch. A refresh replaces the catalogue only when it looks complete: an empty answer never does, and one with less than half the channels only when a second fetch agrees. A failed refresh keeps the catalogue and reports the failure in the status. Preferences refer to provider ids, so renamed or reordered channels keep their history.

## Playback

The UI never sees provider URLs; they contain the login. `playback.open` returns a `127.0.0.1` URL with a random token, and only one session is open at a time, because many subscriptions allow one connection. When the player requests the URL, the proxy connects upstream and then, before sending anything:

1. **Inspects** the stream (`playback/inspect.ts`): the program tables name each track's codec; the first frames settle what the tables leave open (MP2 or MP3, 8 or 10-bit HEVC, AAC channel layout). It reads at most 2 MB or 2.5 s and stops as soon as the delivery is settled.
2. **Plans** (`playback/convert.ts`): the renderer reports which codecs its player decodes (`player/decoders.ts`, from `MediaSource.isTypeSupported`). Tracks it decodes are copied; the rest convert: sound to stereo AAC, video to H.264 with deinterlacing, 4K reduced to 1080p.
3. **Starts clean** (`playback/clean-start.ts`): for H.264 and HEVC, drops video before the first keyframe and the leading frames that display before it, so a stream joined mid-sequence starts on a decodable picture.
4. **Delivers**: straight through when nothing converts, otherwise through the bundled ffmpeg reading stdin, so the upstream URL never reaches a command line.

If the player still fails to decode the picture, the player controller retries once with `repair`, which re-encodes the picture and conceals broadcast damage. The [playback evaluation](playback.md) records why this design won over a bundled engine such as libmpv.

## Updates

Nothing updates on its own; see the [user guide](../user/updates.md) for the behaviour.

- `updates/feed.ts` reads published releases from the GitHub API. A release counts only when its version and pre-release flag name the same channel and it carries this platform's `latest*.yml`. Stable takes the highest stable version, Nightly the highest of both, by version order.
- `services/updates.ts` holds the channel (set from the build on first launch, then only by the user), the check, download and restart steps, and the fresh start.
- `platform/installer.ts` wraps electron-updater: generic provider pointed at the chosen release, no automatic download, no install on quit, and a check that the metadata names the chosen version.
- A fresh start downloads Stable first. Only after the final confirmation does it write `fresh-start.json`, erase the device data, clear the browser session and install. `finishFreshStart` runs before anything reads the data at the next start: it completes an interrupted erase and reports when Stable did not arrive.
