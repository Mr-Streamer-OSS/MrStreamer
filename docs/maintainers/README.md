# Planning

> For maintainers. The [docs index](../README.md) lists every guide.

Work is planned in slices. This page is the roadmap; each slice's handoff in [slices/](slices/) keeps its decisions, evidence and open questions. The current one is [Slice 5: tracks, languages, versions and details](slices/05-tracks-languages-and-details.md). Slices 03 and 3.5 shipped in Stable 0.0.2; slices 04 and 4.5 are on the nightly channel.

## Current sequence

1. Slice 01 delivered the desktop baseline on Mac, Windows and Linux.
2. [Slice 02](slices/02-reliability-and-releases.md) is complete: the repository is public at [Mr-Streamer-OSS/MrStreamer](https://github.com/Mr-Streamer-OSS/MrStreamer) and nightlies publish automatically. Stable 0.0.1 was published on 30 September from nightly `.15`'s commit. Wout reports successful Mac and Windows testing.
3. [Slice 03](slices/03-live-tv-and-guide.md) fixed the late update check and Stable release notes (#5), and added the programme guide, favourites, the muted live Home and desktop navigation (#6, #7).
4. [Slice 3.5](slices/03.5-foundation.md) laid the foundation for slice 04 (#8 to #15): the workspace, Effect services, an event log for favourites and history, a diagnostics log and build-to-build measurements. Stable 0.0.2, published on 30 September from `f26072f`, carries slices 03 and 3.5.
5. [Slice 04](slices/04-movies-home-updates.md) added movies and series with resume and track choice, the new Home with Continue watching, updates found in a static feed every four hours, and third-party notices in the app. It merged as #16 and shipped in nightly `0.0.3-nightly.20260930.37`; the update feed is live.
6. [Slice 4.5](slices/04.5-movies-and-series-browsing.md) turned Movies and Series into tabs of collections built from TMDB's metadata instead of the provider's categories, showed each film once in the viewer's language, loaded faster and kept less on disk. It merged as #17, with titles for adults in their own tab, TMDB's progress ring and the README banner after it (#18 to #20), and shipped in nightly `0.0.3-nightly.20261001.43`.
7. [Slice 5](slices/05-tracks-languages-and-details.md) fixed six findings of a review of `main`, then added every sound and subtitle track on live channels and on demand, picture subtitles, teletext and captions included, names in the viewer's language, picked versions, search in Movies and Series, details loaded on opening with the cast, and Settings > General and Subscription (#21 to #36), and shipped in nightly `0.0.3-nightly.20261001.46`. A second review's seven fixes and a follow-up (#37 to #44) reach the nightlies after it. It awaits use on a real subscription on the Mac and Windows.

## Roadmap adjustments

- Slice 02 delivered playback compatibility, library reliability, Mac signing/notarization, the DMG redesign, automatic nightlies with manual Stable promotion, in-app updates and documentation for public launch. Its clean-state reset was later removed: returning to Stable keeps the data.
- User documentation and maintainer/agent documentation must have separate entry points. During the active build-out, code contributions are limited to small bug fixes; document this policy for prospective contributors.
- Additional provider types and multiple subscriptions remain deferred. Their old placement in the slice 02 outline does not authorize implementing them now.
- Slice 03 covers live TV and the guide, and brought forward the muted live Home, programme-first presentation, desktop navigation and copy cleanup.
- Slice 04 covers movies and series, and brought forward the Home overhaul from slice 05, the update feed and the third-party notices. Downloads, trailers, external metadata, new provider types and mobile or TV apps stay out. Slice 05 keeps the remaining everyday controls.
- Slice 4.5 brings in external metadata from TMDB for collections and the pictures behind them; details, posters and playback still come from the provider. Downloads, trailers, new provider types and mobile or TV apps stay out.
- Slice 5 takes the remaining everyday controls: tracks and subtitles everywhere, the content languages, versions, contextual search and richer details from TMDB, which now supplies details as well as collections; the provider still supplies what plays. Interface translation, downloads, trailers, new provider types and mobile or TV apps stay out.
- Slice 06 consolidates quality checks across Mac, Windows and Linux. Each slice still verifies its own behaviour.
- Slice 07 covers distribution follow-up for desktop v1. Release automation and updating are delivered in slice 02; the first public release can happen after slice 02 without waiting for slice 07.
- Slice 08 retains beta feedback and desktop v1 acceptance.
- Slice 09 is a future Linux coverage review. Linux packaging and the current supported Linux workflow are already required in slices 01-02. Additional distributions or architectures need separate scope.
- Slice 10 retains mobile and TV exploration.
