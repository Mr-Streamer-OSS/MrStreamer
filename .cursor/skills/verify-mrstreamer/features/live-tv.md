# Live TV

Read only the area needed for the changed path.

- For desktop Live TV baseline, read [Desktop Live TV baseline](live-tv/desktop.md).
- For source removal and provider admission, read [Source removal and provider admission](live-tv/subscriptions.md).
- For live playback, failures and receivers, read [Live playback, failures and receivers](live-tv/playback.md).
- For catch-up playback, read [Catch-up playback](live-tv/catch-up.md).
- For guide sources and labels, read [Guide sources and labels](live-tv/guides.md).
- For guide grid and performance, read [Guide grid and performance](live-tv/guide-grid.md).
- For search and programme reminders, read [Search and programme reminders](live-tv/search-reminders.md).
- For categories, freshness and selection, read [Categories, freshness and selection](live-tv/categories.md).
- For desktop custom channel lists, read [Desktop custom channel lists](live-tv/custom-lists.md).
- For iOS lists, guides and catch-up, read [iOS lists, guides and catch-up](live-tv/ios-lists-guides.md).
- For iOS tracks, recovery and receivers, read [iOS tracks, recovery and receivers](live-tv/ios-playback.md).
- For iOS language, programme search and reminders, read [iOS language, programme search and reminders](live-tv/ios-language-search.md).
- For iOS safe areas, read [iOS safe areas](live-tv/ios-layout.md).
- For desktop playback diagnostic context, read [Desktop playback diagnostic context](live-tv/diagnostics.md).
- For clear muxed MPEG-TS HLS, read [Clear muxed MPEG-TS HLS](live-tv/hls.md).
- For android Explore app, read [Android Explore app](live-tv/android.md).
- For local live rewind and retained timeline, read [Local retained timeline service](live-tv/timeline.md).

Desktop playback command defaults and overrides share `apps/desktop/src/renderer/src/app/shortcuts.ts` with title playback. Channel digits and list navigation remain fixed; the active profile's committed preferences control remappable commands. Verify a remap and reset on an advancing rewind-capable live fixture, including unchanged menu/text/button input and held-key behavior. See [Shared viewing preferences](preferences.md) for profile/restart and failed-save acceptance. Renderer `live-more.test.ts` mounts WatchScreen and observes the live-only Favourite command from committed remaps, retired keys and a later preference publication. Actual built-app live dispatch remains a separate proof.
