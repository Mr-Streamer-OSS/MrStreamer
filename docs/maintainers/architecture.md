# Architecture

An Electron app in a pnpm workspace. The main process owns everything that touches the network, the disk and the system; the renderer shows state and starts actions over a typed IPC contract.

```
packages/contracts   @mrstreamer/contracts: IPC schemas, library, guide and movie and series
                     models, errors, versions, updates, the update feed, licences. Depends on
                     nothing else in the workspace.
packages/core        @mrstreamer/core: rules that run without Electron, React or the DOM. Catalogue
                     names and regions, trusted guide ids, the XMLTV reader, the guide and viewing
                     record services, movie and series names, their catalogue, languages,
                     collections and tracks, TMDB's client, update discovery, the provider port,
                     text folding, and the subtitle decoders: DVB, PGS, teletext, CEA-608.
                     Depends on contracts.
apps/desktop         The app, package name mrstreamer
  src/main           Electron main process
    providers        The Xtream Codes adapter
    services         Subscriptions, library, movies and series, playback proxy, settings
                     (preferences.json), updates, licences
    ondemand         The worker thread that holds the movie and series catalogue and TMDB's
                     metadata
    playback         Stream inspection, the clean start, the sound track choice, captions copied
                     out of the pictures and ffmpeg conversion behind the proxy; probing and
                     ffmpeg runs for movies and episodes
    platform         Keychain-backed secrets, atomic JSON files, the guide and viewing stores, the
                     electron-updater installer, the diagnostics log
  src/preload        The typed bridge exposed to the UI
  src/renderer       React UI; player/ holds the playback engines, the live and title player
                     controllers, Picture, and the subtitles drawn over it
  src/shared         What main and the renderer share inside the app: window bar sizes
  scripts            Icons, the DMG background, signing, notarization, ffmpeg builds, third-party
                     notices, guide and viewing record measurements
  test               Service suites, the fake provider, codec and title clips, packaged-app test,
                     measurements
scripts              Release planning, the update feed and CI signing, run from the repository root
test                 The release planning suite
```

Packages export their source files by path, `@mrstreamer/core/catalogue/normalize`, and the app bundles them; nothing is built separately. Lint rules keep packages from importing Electron, React or the app, contracts from importing core, and every file from import cycles. `scripts/release-plan.ts` imports `packages/contracts/src/version.ts` and `update-feed.ts` by relative path, because release jobs run it before installing packages.

`@mrstreamer/contracts/ipc` is the contract: each method has an input schema (ArkType) and a result type, and the main process validates every call before its handler runs. ArkType compiles a schema when it's defined, which adds to every start, so schemas the start doesn't need are built on first use: each IPC input on its method's first call. The preload script exposes it as `window.mrStreamer`; the renderer reaches it through `lib/ipc.ts` and React Query hooks in `lib/queries.ts`.

## Data

Everything lives in Electron's `userData` folder, named after the product, not the app id: see the [user troubleshooting page](../user/troubleshooting.md#where-your-data-is). Each JSON file is written atomically, packed with gzip when its name ends in `.gz`; leftovers of an interrupted write are removed at startup. Changes to these files must stay readable by the newest stable release: choosing Stable on a nightly installs that release over the nightly, and it reads what the nightly wrote. Add fields rather than change a file's version: older readers ignore keys they don't know and keep them when they write. New files are fine: older releases don't look for them. The one agreed exception: Stable 0.0.1 doesn't read `mrstreamer.db`, so it shows no favourites or watch history; Stable 0.0.2 reads it and skips what it doesn't know (see [Viewing record](#viewing-record)).

| File                | Owner                                                                                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `subscription.json` | `services/subscription.ts`; the password is sealed with `safeStorage`                                                                                                                                                                |
| `preferences.json`  | `services/preferences.ts`: volume, mute, last channel and category, the sound and subtitle languages picked last, the language for movies and series, the versions picked, the viewer's own TMDB key, whether titles for adults show |
| `mrstreamer.db`     | `platform/viewing-store.ts`: the viewing record, favourites, watch history and title progress per account                                                                                                                            |
| `catalogue.json`    | `services/library.ts`: the last good catalogue, as the provider sent it                                                                                                                                                              |
| `ondemand.json.gz`  | `ondemand/catalogue-worker.ts`: the last good movie and series lists, as the provider sent them                                                                                                                                      |
| `metadata.json.gz`  | `ondemand/metadata.ts`: what TMDB said about each title, its names by language included, and what each streaming service carries                                                                                                     |
| `guide.xml`         | `platform/guide-store.ts`: the last complete XMLTV download, as it arrived                                                                                                                                                           |
| `guide.json`        | `platform/guide-store.ts`: which subscription `guide.xml` belongs to, and when it arrived                                                                                                                                            |
| `updates.json`      | `services/updates.ts`: the chosen channel, and the version whose notice was closed                                                                                                                                                   |
| `diagnostics.log`   | `platform/diagnostics-log.ts`: what the app did; `diagnostics.1.log` is the one before                                                                                                                                               |

Chromium keeps its own cache there too, mostly posters and backdrops; `index.ts` caps it at 64 MB on disk, and artwork is asked for at the width it shows at (`components/TitleArt.tsx`).

## Catalogue

The library fetches categories and channels, indexes them in memory and caches the provider's raw answer; display names are worked out on load, so naming rules improve without a refetch. A refresh replaces the catalogue only when it looks complete: an empty answer never does, and one with less than half the channels only when a second fetch agrees. A failed refresh keeps the catalogue and reports the failure in the status. Favourites and history refer to provider ids, so renamed or reordered channels keep them.

Each channel keeps the provider's guide id (`epg_channel_id` on Xtream panels). Quality variants of one channel usually share it, but panels also file unrelated channels under one id: Wout's lists nine Flemish channels under `PlayCrime.be`. `@mrstreamer/core/catalogue/guide-ids` keeps an id for a channel only when the channel's name matches the id, or when every channel sharing it is the same channel under another name or quality. The guide's own channel names don't count: panels copy them from their stream list. On Wout's provider this keeps 1,978 of 2,073 channels with programmes. A cache saved before guide ids existed still loads, and counts as due for a refresh at the next start.

## Movies and series

`services/ondemand.ts` (`OnDemand`) owns movies and series. Their lists are large: 53,000 movies (21 MB of JSON) and 10,000 series on Wout's provider. Reading, indexing and sorting them on the main thread stalled it for 100 to 300 ms, so the catalogue lives in a worker thread, `ondemand/catalogue-worker.ts`, started on first use (electron-vite bundles it through `?nodeWorker`; tests start the source file). The worker fetches both lists with its own copy of the Xtream adapter, parsing each in one go, which off the main thread is several times faster than reading row by row. It answers first and a second later keeps the lists in `ondemand.json.gz` as the provider sent them, 3.3 MB packed instead of 17.7. A key change restarts the worker after up to 2 s for a write in progress; quitting doesn't wait, and a write cut short leaves the previous lists, which the next start refreshes when due. Every call names the subscription it is for, so an answer never mixes accounts. An empty answer replaces lists that had titles only when a second refresh agrees, and a list answered with a refused login fails the refresh instead of counting as empty. The lists refresh at startup after the live catalogue and the guide when they are older than 12 hours, and when first needed.

Nothing depends on a field only some providers send. The worker reads what Xtream Codes panels list for every movie and series, names, dates, ratings, artwork and the TMDB id (`tmdb`), and asks TMDB for the rest. The provider's categories aren't shown.

### Titles and versions

`@mrstreamer/core/ondemand/catalogue` indexes the lists for one language, each kind when first read. Display names are worked out on load (`@mrstreamer/core/ondemand/names`: "Blow 2001 (NL)" is "Blow 2001" with the tag NL), so naming rules improve without fetching again. Providers list each language version of a film as its own stream; rows sharing a TMDB id become one title with its versions inside, and rows without one stay on their own. A title shows the version that suits the viewer's language best (`@mrstreamer/core/ondemand/languages`): marked with the language, then marked for several, then marked for a language that subtitles rather than dubs, then unmarked, then dubbed into another, the newest first among equals. Dutch, Flemish included, subtitles: "(NL)" on an English film is English with Dutch subtitles, unless the mark says otherwise, as "(NL AUDIO)". A row for adults never joins the others, so the film's other versions stay. The language is `titleLanguage` in the preferences, English by default, and changing it indexes again. Every version's id finds its title, details belong to the version they were opened for, and progress counts across versions: `viewing.progress` takes the ids of every version of a series.

A version the viewer picks is `titleVersions` in the preferences, by kind and TMDB id, `"movie:603"`, to the version's id; only titles with a TMDB id have several. The details sheet works out which version plays before asking for details: `ondemand.titles` gives the title with its versions from the lists, then the pick, else the version a movie stopped in partway or a series was watched in last, else the best suited (`lib/titles.ts`). It shows that version's details, so a series lists the episodes that play. Resuming from Continue watching plays the pick too. A pick the provider no longer lists counts as none, and connecting another subscription forgets them all. The menu names each version by its marks (`versionLabels` in `@mrstreamer/core/ondemand/languages`): "Nederlands audio · 1080p", numbered when two read the same.

Titles the provider marks for adults, or that sit in a category named for adults, are left out of every collection but their own, `adult`, and of search. That one answers empty unless `adultTitles` in the preferences says to show them; Movies and Series then show an Adults tab.

### TMDB

`@mrstreamer/core/metadata/tmdb` is TMDB's client: one title's details (genres, original language, popularity, rating and votes, franchise, backdrop, its name in a language and its original name), and which titles each streaming service carries in a region, from TMDB's watch providers, whose data comes from JustWatch. A read access token goes in the Authorization header, an API key in the query.

`ondemand/metadata.ts` keeps what collections use in `metadata.json.gz`, inside the worker. After the lists load, it asks about each listed title once, newest first, 8 at a time and at most 40 a second, waiting when TMDB asks it to and trying twice more after a failure, 15 s at most per request. After 24 requests in a row without an answer, offline or with TMDB down, the run stops until the next start or refresh. It asks in the viewer's language and keeps each title's name per language, so a title counts as answered once it has a name in the language chosen now: changing the language asks every title once more, in the background, and changing back asks nothing. TMDB answers with the original name when it has no translation; that counts as none, and for a title made in neither English nor the viewer's language the English name is asked for too. Titles show the translation, else the original name when it is in the viewer's language, else the English name, else the original, else the provider's name without its marks (`metadata.name`). Search finds titles by every name TMDB gave them as well as the provider's. It asks again after 150 days, and stops using and keeping anything after six months, TMDB's limit. A list given while it fetches, as after a refresh, takes over, ahead of the streaming services. Those, the 12 most prominent per kind in the system's region with their 5,000 most popular titles each, are fetched again after a week. It saves every 30 s while fetching, and tells the main process, which tells the UI, at most every 3 s. A refused key stops it until the key changes. Settings > Movies & series shows how far it got, and so does a ring beside search in the top bar (`components/TmdbProgress.tsx`), only while titles are being asked about: the status says whether a run is going.

The key is the viewer's own from Settings (`tmdbKey`), else `MR_STREAMER_TMDB_KEY` at run time, else the one built in from the release's `TMDB_API_KEY` secret (see [releasing](releasing.md#tmdb-key)). Changing it restarts the worker. Without a key, movies and series work without genres, services or popularity.

### Collections

`@mrstreamer/core/ondemand/collections` builds a kind's collections for a language from the titles and the metadata so far:

- All, every title but those for adults
- For adults, only once the viewer turns them on in Settings
- New this week and this month, by the date the provider added them
- Recent releases, from this year and last
- Popular, by TMDB's popularity
- Top rated, 7.5 and up on TMDB once 100 people voted; the provider's rating only sorts titles TMDB doesn't know
- 4K, titles with a version marked 4K or UHD
- each genre and each streaming service, `genre:Comedy` and `service:8`
- titles like one, `like:<id>`: the most genres shared, then the most popular

Every collection but All holds only titles that suit the language: a version in it or in several, or one with its own sound or unmarked that TMDB doesn't place in another language. New counts the date a version arrived unless it is a dub into another language. The worker builds them when first asked and again after more metadata arrived, and answers three calls. `ondemand.rows` gives a tab's rows: For you starts with titles like the one watched last, then popular, new this week, top rated and the three best-stocked services; New has this week, this month and recent releases. `ondemand.tiles` gives the genres or services with their counts and a picture. `ondemand.collection` gives a page of one, in its own order or by date added, popularity, rating or name.

Details come from the provider when a title opens (`get_vod_info`, `get_series_info`), never before: nothing loads them on hover or keyboard selection. TMDB is asked at the same time, in the viewer's language with the credits (`tmdb.about`), for at most 4 s; its overview, poster, backdrop, genres, cast with portraits and directors or creators come first, the provider's fill in, and the provider's seasons, episodes and file length stand, since they are what plays. Both stay in memory for the last 200 titles, so a title opened again asks no one. Continue watching takes its titles from the lists (`ondemand.titles`, through the worker), so Home asks the provider nothing for it; an episode's series details load when it is resumed. `@mrstreamer/core/ondemand/details` builds a series' seasons from its episodes, because panels list seasons incompletely or not at all, and puts specials last. `OnDemand.file` names the provider file a movie or episode streams from; the URL holds the login and never leaves the main process.

## Effect services

The main process runs every service on one [Effect](https://effect.website) runtime (`effect` 4, pinned to a release candidate). `apps/desktop/src/main/runtime.ts` assembles them from Layers in `mainLayer`. `index.ts` makes the runtime at start, forwards each service's changes to the window, and registers the IPC handlers: each returns an Effect, and `ipc.ts` runs it on the runtime.

| Service         | Where                              | Owns                                                   |
| --------------- | ---------------------------------- | ------------------------------------------------------ |
| `Subscriptions` | `services/subscription.ts`         | The login, its sealed password, the provider behind it |
| `Settings`      | `services/preferences.ts`          | `preferences.json`                                     |
| `Library`       | `services/library.ts`              | The catalogue, its cache and refreshes                 |
| `OnDemand`      | `services/ondemand.ts`             | Movies and series, through the catalogue worker        |
| `Playback`      | `services/playback.ts`             | Stream sessions and the loopback proxy                 |
| `Updates`       | `services/updates.ts`              | The release channel, checks, downloads and the install |
| `Guide`         | `@mrstreamer/core/guide/service`   | The programme guide                                    |
| `ViewingRecord` | `@mrstreamer/core/viewing/service` | Favourites, watch history and title progress           |
| `Licences`      | `services/licences.ts`             | Third-party notices for Settings > About               |

A service is a `Context.Service` class with a `layer`, and reaches the others through the context rather than callbacks. Services whose rules run without the platform live in `packages/core` and ask for what they need through ports, services of their own that the app supplies: the guide's are `GuideSource` (the subscription and its download), `GuideCatalogue` (guide ids) and `GuideStore` (the saved document, `platform/guide-store.ts`). The others live in the app. Every expected failure is a `Failed` from `@mrstreamer/core/failure`, carrying the `AppError` the UI shows; a provider adapter's `AppFailure` keeps its error, anything else counts as unexpected.

Background work, downloads and stream sessions run in their service's scope. Quitting closes open streams at once, so no ffmpeg or provider connection outlives the app, then disposes of the runtime without holding the quit: an update's restart goes through the same path. Disposing stops the calls still running; they answer nobody and aren't logged. Tests build the same layers with the fake provider; `apps/desktop/test/support.ts` makes a runtime per test and calls services with promises, and guide tests move a `TestClock` instead of waiting.

## Diagnostics

`@mrstreamer/core/diagnostics` defines what the app notes about its own work, as a typed union: steps with their duration and outcome (start, login, catalogue, movie and series list and guide downloads, a title's details, update checks, downloads and installs), each stream the proxy served (direct, converted, repaired or refused, and how long it took to start), each movie or episode run (whether the picture and sound were copied or converted), what an update source answered when a check failed (the HTTP status and GitHub's rate-limit headers), and failed IPC calls. Entries hold only names, numbers and failure kinds, so an address, login or channel name can't reach them; `diagnosed(step)` times an Effect and records how it ended. `Diagnostics` is a context reference that records nothing by default. The app provides `platform/diagnostics-log.ts`, which appends JSON lines to `diagnostics.log` and starts a new file at 512 KB, keeping the one before. Nothing is sent anywhere.

## Viewing record

Favourites, watch history and how far movies and episodes got are events, per account: `favourite-added`, `favourite-removed` and `watched` with a channel id, `title-progress` with a title, its position and length, and `title-removed` when a title leaves Continue watching. `@mrstreamer/core/viewing/record` holds the rules as plain functions: `decide` turns a command into events (none when it asks for what already holds), and `apply` adds a channel event to the state, favourites in the order added and the twelve most recent channels. `@mrstreamer/core/viewing/titles` holds the title rules: a checkpoint's row, when a title counts as finished (its last 5 %, at least 30 s), and Continue watching: movies past two minutes and not finished, and each series at the episode played last, finished or not, so the UI can offer the next one. `@mrstreamer/core/viewing/service` runs commands for the connected account; without one, the lists are empty and changes fail with `no-subscription`.

`platform/viewing-store.ts` keeps them in `mrstreamer.db` with the built-in `node:sqlite`: every event in order, the state they add up to per account, one row per title and account in `titles`, and the ids of commands already done. Title events carry their details as JSON in the events table's `payload` column. A command commits its events, its id and the new state in one transaction, so a command sent again changes nothing more. `STATE_VERSION` rises when `apply` or the title rules change; the next start then rebuilds the state and the titles from every event, skipping events written by a newer version. If the database can't open, the record's calls fail and the rest of the app carries on.

Older builds share the file, as when someone returns to Stable 0.0.2: they skip event types they don't know, leave `titles` alone and insert their events without a payload, so going back and forth loses nothing. The UI checkpoints a title's progress every minute while it plays and at each pause, seek, track change, the end, leaving and hiding the window; never per frame. A 45-minute episode adds about 50 events.

The first start with the record imports the lists `preferences.json` kept before, in the transaction that sets the import marker, and only then takes them out of the file. Lists wait for an account to import into, and connecting a different account drops them. Once the marker is set, lists found in the file again, as after running Stable 0.0.1, are removed without importing.

The UI reads `viewing.get` and sends `viewing.setFavourite`, `viewing.recordWatch`, `viewing.recordProgress` and `viewing.removeFromContinue` with a command id it makes up; `viewing.progress` reads the rows of some movies or of a series' versions. After each commit the main process sends `viewing.changed` with the new sequence, and the UI reads again when it holds an older one. `apps/desktop/scripts/measure-viewing.ts` measures commits, opening and a rebuild with 100,000 events.

## Programme guide

`@mrstreamer/core/guide/service` downloads the provider's XMLTV (`xmltv.php` on Xtream panels) and keeps it separate from the catalogue and playback: listings are empty until a guide loads, and nothing waits for one. `@mrstreamer/core/guide/xmltv` reads the document as it arrives, from the network or from `guide.xml` after a restart. It searches the bytes and decodes one programme at a time, so the strings it keeps don't hold on to the chunks they came in. Programmes that already ended are dropped; a programme without an end runs until the next one, and overlaps are cut. Titles are folded for search as they arrive, and the last step yields to the event loop every 50 channels.

A download replaces the guide only when it completes and lists programmes; otherwise the last guide stays. The main process downloads after connecting a subscription and at startup; the service itself checks every 15 minutes and downloads when the guide is six hours old. Switching accounts clears it: the download in progress stops, and a load or download that finishes afterwards changes nothing. Indexing and lookups are plain functions in `@mrstreamer/core/guide/programmes`.

The UI asks `guide.listings` for now and next per channel, `guide.schedule` for one channel's day and `guide.search` for programme titles. Lists ask for listings in pages of 40 as rows come into view, and again each minute. `apps/desktop/scripts/measure-guide.ts` measures download, indexing, stalls, lookups and memory against the slice 03 budgets.

## Views and the picture

The window shows a page, Home, Live TV, Movies or Series. A title's details open in a sheet over the page; Watch, for a channel, and a playing movie or episode open over everything. The page stays laid out underneath, hidden and `inert`, so leaving any of them finds it scrolled where it was and a key or Tab never reaches it meanwhile.

There is one `<video>` element, created by the live player controller (`player/player.ts`). Home's backdrop, the guide's preview, Watch and a playing title each render a `Picture` (`player/Picture.tsx`); the active one holds the element, moved with `moveBefore` so it keeps playing. Moving between views never reopens the stream or opens a second provider connection. The packaged-app test checks this through the fake provider's stream count.

Sound follows the view: Watch and a playing title play at the viewer's volume, and pages keep the stream muted unless the speaker is pressed (`audible` in the player state). Home and Live TV start a muted preview of the last channel; Movies and Series stop it, and coming back starts it again, muted. A preview never reconnects after a failure, so a connection another device holds isn't fought over, and it stops while the window is hidden and restarts when it shows. Stop in Watch keeps previews from starting it again.

`player/title-player.ts` controls movies and episodes in the same element. Opening a title suspends the live stream; starting a live channel closes the title. It picks the tracks (`@mrstreamer/core/ondemand/tracks`: the remembered language, or the file's default sound and forced subtitles in its language), seeks within what is buffered or starts a new run, ends the run after five minutes paused and resumes from there, retries a copied sound track once as converted when it doesn't start, and saves progress as above. Leaving a title while its file is still being probed closes that session too, so no provider request outlives it.

Lists keep one keyboard selection, separate from the pointer. Only the keyboard moves it or scrolls a list to it; the pointer only hovers, and the selection shows only while the keyboard was used last (`lib/input-mode.ts`). Wheel and trackpad gestures only scroll. Key handlers register once and read the current render through a ref: a handler registered again on every render can miss a key, because a state change in another keydown listener renders between listeners. Watch and a playing title listen in the capture phase and stop the keys they handle, so a tooltip can't keep Escape to itself and an Escape that leaves a layer doesn't also close the one it uncovers.

## Playback

The UI never sees provider URLs; they contain the login. `playback.open` returns a `127.0.0.1` URL with a random token, and only one session is open at a time, because many subscriptions allow one connection. Each session is a scope: closing it, by stopping, switching or quitting, aborts its upstream requests and ends their ffmpeg process. When the player requests the URL, the proxy connects upstream and then, before sending anything:

1. **Inspects** the stream (`playback/inspect.ts`): the program tables name each track's codec, each sound track's language and whether it describes the picture, and the teletext and DVB subtitle pages; the first frames settle what the tables leave open (MP2 or MP3, 8 or 10-bit HEVC, AAC channel layout). It reads at most 2 MB or 2.5 s and stops as soon as the delivery is settled. `playback.tracks` lists the sound and subtitle tracks from then on.
2. **Plans** (`playback/convert.ts`): the renderer reports which codecs its player decodes (`player/decoders.ts`, from `MediaSource.isTypeSupported`). Tracks it decodes are copied; the rest convert: sound to stereo AAC, video to H.264 with deinterlacing, 4K reduced to 1080p. `playback.open` can name a sound track by PID; mpegts.js plays the first one the program table lists, so a stream delivered as it is gets the chosen one moved to the front (`playback/program-table.ts`), and ffmpeg keeps only the chosen one. Converting keeps teletext and DVB subtitles, and every track under its own PID.
3. **Starts clean** (`playback/clean-start.ts`): for H.264 and HEVC, drops video before the first keyframe and the leading frames that display before it, so a stream joined mid-sequence starts on a decodable picture.
4. **Delivers**: straight through when nothing converts, otherwise through the bundled ffmpeg reading stdin, so the upstream URL never reaches a command line.

If the player still fails to decode the picture, the player controller retries once with `repair`, which re-encodes the picture and conceals broadcast damage.

Closed captions travel inside the pictures, in SEI messages, which mpegts.js reads but doesn't pass on. On their way out, after any conversion, `playback/caption-stream.ts` copies each picture's CEA-608 pairs into a private data stream on PID 0x1FF0, with the picture's time, in display order: pictures arrive in decoding order, and B-frames reorder them. The program table lists that stream once a picture carries captions, so a channel without them passes unchanged, and `playback.tracks` lists the caption channels found. mpegts.js passes private data on with times on the player's clock, as it does teletext and DVB subtitles.

Watch shares its Sound and CC menus with a playing title (`features/watch/TrackMenus.tsx`). The live player reads `playback.tracks` once the stream plays, and again 5 s later, since caption channels show up only as pictures carry them. Another sound track opens the stream again with its PID. A channel opened afresh names the remembered language instead (`audioLanguage`), and the proxy picks the first sound track in it from the program table. Subtitles never reopen anything: the engine hands each private data packet to the player controller, which feeds the chosen PID to its `@mrstreamer/core/subtitles` decoder and shows the changes as a title's (`player/subtitles.ts`). The chosen languages are the same `audioLanguage` and `subtitleLanguage` preferences titles use. A channel starts with subtitles in the viewer's language only when none of its sound tracks is in it: on a channel that speaks it, they are for the hard of hearing.

Providers send a burst of buffered seconds when a stream opens. mpegts.js jumps forward when the picture falls more than 8 s behind the newest data, keeping 3 s of buffer, instead of playing faster to catch up: a 1.2× rate was audible and visible for half a minute after every start. The [playback evaluation](playback.md) records why this design won over a bundled engine such as libmpv.

### Movies and episodes

Providers keep movies and episodes as files behind a redirect, and answer byte ranges: two thirds MKV (H.264, sometimes HEVC, with E-AC-3 sound in several languages and dozens of SubRip subtitles), a third MP4, and a few AVI, MPEG-TS and MPEG-PS. Chromium's own player can't pick among their sound tracks or show their subtitles, and doesn't decode E-AC-3 on Linux, so every title goes through ffmpeg (`playback/title.ts`, `services/playback.ts`):

1. **Probe.** `playback.openTitle` closes any open stream, opens a title session and runs the bundled ffprobe on the proxy's `/source/<token>`, which forwards ranges to the provider one upstream request at a time; a new one, such as a seek, ends the one before, and a refusal is retried after 0.15, 0.4, 1 and 2 s, since panels take a moment to free the connection just closed. ffprobe decodes the first keyframe too, since only a decoded picture shows the closed captions inside it. The session answers with the tracks, labelled in their own language (`@mrstreamer/core/ondemand/tracks`), and the length. Each subtitle track has a format: text (SubRip, ASS, MP4 text, WebVTT), picture (PGS, DVD, DVB, XSUB), teletext, one track per subtitle page, or captions (CEA-608 tracks, and captions inside the picture). Formats outside these aren't listed.
2. **Run.** Each request to `/title/<token>.mp4?start=&audio=&subtitle=` runs ffmpeg from that position with those tracks and replaces the run before. Video the player decodes is copied, the rest becomes H.264; sound likewise becomes stereo AAC. Copied video starts at the keyframe before the position, so ffmpeg keeps the file's timestamps (`-copyts`) and PUTs a one-packet `framecrc` report of the first video packet back to the proxy, which reads the keyframe's time from its first line and answers with `x-start`. The fragmented MP4 goes to the player; text subtitles and CEA-608 tracks become WebVTT, PUT to the proxy and streamed to the player on the file's clock, with `x-origin` for where that clock starts. Other subtitles go beside the picture as packets the player decodes: PGS as it is stored (the `sup` muxer), since ffmpeg only learns how long a PGS picture shows when the next arrives; DVD and DivX pictures as DVB subtitles, which carry their length; DVB and teletext as they are; and a picture's captions as its SEI units alone (`filter_units`). The proxy turns them into JSON lines, each packet's time on the file's clock and its data, at `x-packets`, with `x-packets-codec` naming the decoder. Copied AAC passes `aac_adtstoasc`, which MPEG-TS files need. `delay_moov` lets ffmpeg describe copied AC-3 and E-AC-3, and a start at zero doesn't seek, which skips seconds of some AVI and FLV files.
3. **Play.** `player/title-engine.ts` feeds the fragments to Media Source Extensions with the timestamp offset that puts the first fragment at `x-start`, so the element's clock is the title's: the position is `currentTime`, a skip into what is buffered only moves `currentTime`, and cues from `webvtt.ts` go straight onto a text track. `player/mp4.ts` reads the codec string MSE needs from the first boxes. Reading stops once 60 s are buffered ahead and starts again below 40 s; while paused nothing more is read and the provider's connection idles until playback moves on. When the provider breaks off a file, ffmpeg can still end its run as if the file had ended; the proxy saw the break, so it ends the run's response as broken, and the player reconnects instead of playing out to a false end.

### Subtitles the app draws

`@mrstreamer/core/subtitles` decodes DVB subtitles, PGS, teletext subtitle pages and CEA-608 captions into changes of a screen: lines of text, or pictures on a canvas the size the subtitles were made for. Teletext shows only a subtitle page's boxed text, with the page's national character set and the accented letters enhancement packets add; captions build up as pop-on, roll-up or paint-on. `player/subtitles.ts` shows each change from its time on: text as cues on the element's subtitle track, where Chromium lays it out as it does WebVTT, and pictures on a canvas over the picture, stretched over the area the picture fills, as broadcasts mean them. Cues on a hidden metadata track show and hide the pictures, so the element's own clock times them and the canvas is only drawn at a change or a resize. Cues more than 30 s behind go. `Picture` moves the canvas with the video element. Subtitles show only inside Watch and a playing title, not in the muted previews; while the controls show, those set `data-controls`, and `styles.css` moves text and pictures up above them.

A run starting from a position gets the subtitle packets from there on, so after a seek a picture, page or caption already on screen shows again only from the next change.

Measured with Electron 44 against the fake provider: a run starts in about 1.1 s and a seek outside the buffer in 0.9 s; starting 10 minutes into a file read 57 MB, probe and a minute ahead included, and nothing more while paused. [Playback evaluation](playback.md#movies-and-episodes) records how this design was chosen.

## Updates

The app never downloads or installs on its own; see the [user guide](../user/updates.md) for the behaviour.

- **Discovery** (`@mrstreamer/core/updates/feed`): one request reads the feed the release workflow publishes to GitHub Pages, `updates.json`, naming the newest complete release of each channel (see [releasing](releasing.md#update-feed)). Only when the feed is missing or broken does it ask GitHub's API instead, two unauthenticated requests that share GitHub's limit of 60 an hour per network address: not when offline, and not while GitHub said it limits requests from this network (a 403 or 429 with no requests remaining, or a Retry-After), until the time it named. A failed check says why (offline, busy until a time, an HTTP status, or an unreadable answer), and the diagnostics log records each source's status and rate-limit headers. The 403s users reported match that limit; the log now tells a limit from other refusals. The app ships no GitHub credentials.
- **Rules:** a release counts only when its version and channel agree and it carries this platform's `latest*.yml`. The feed's download folder must be the repository's GitHub Releases, so the feed can't send the app to files anywhere else; a feed that tries counts as broken. Stable takes the highest stable version, Nightly the highest of both, by version order.
- **Schedule** (`services/updates.ts`): a check 20 seconds after starting, then every four hours plus up to a tenth, so installs spread out. An automatic check that fails keeps what the last one found and tries again after 15 minutes, backing off to four hours, and never before GitHub allows it. Checks that overlap share one request. A check never runs while a download is in progress or ready, and one that answers after a download started leaves it alone, so a check can't drop a staged update.
- **The service** holds the channel (set from the build on first launch, then only by the user), the offered release with its notes and page, when it last checked and checks next, the version whose notice was closed, and the download and restart steps. Switching channels drops a downloaded or downloading update the new channel doesn't receive, then checks. Only the latest check counts: one that answers after a newer check or a channel change changes nothing, and download and restart refuse a version the chosen channel doesn't receive. On Stable, a nightly build is offered the newest stable release even when it is older; it installs over the nightly and keeps the data. `updates.json` is written one change at a time, so the last choice wins.
- **The UI:** the top bar's notice (`features/updates/UpdateNotice.tsx`) and Settings > Updates read the same status and call the same actions.
- **The installer** (`platform/installer.ts`) wraps electron-updater: generic provider pointed at the chosen release, no automatic download, no install on quit, a check that the metadata names the chosen version, and one download at a time, so a new one waits for a cancelled one to stop. On macOS, Squirrel checks the update's signature only when installing, so a refused update surfaces as a failed install, not a failed download.

## Licences

`scripts/licences.ts` writes `out/licences/third-party.json` during the build from the packages the bundles actually contain, plus Electron, Chromium, Node.js, FFmpeg and x264; [development](development.md#third-party-notices) describes it. `services/licences.ts` reads it for Settings > About, and turns Chromium's credits page into text on request.
