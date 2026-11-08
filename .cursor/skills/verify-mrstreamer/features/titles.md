# Movies and series

Read only the area needed for the changed path.

- For desktop library and title baseline, read [Desktop library and title baseline](titles/desktop.md).
- For desktop file and online subtitles, read [Desktop file and online subtitles](titles/subtitles.md).
- For related titles and Back, read [Related titles and Back](titles/details-back.md).
- For next-episode settings and acceptance, read [Next-episode settings and acceptance](titles/next-episode.md).
- For catalogue, metadata and freshness, read [Catalogue, metadata and freshness](titles/catalogue.md).
- For title playback, recovery and receivers, read [Title playback, recovery and receivers](titles/playback.md).
- For iOS metadata, read [iOS metadata](titles/ios-metadata.md).
- For iOS subtitles and language, read [iOS subtitles and language](titles/ios-subtitles-language.md).
- For iOS autoplay, speed and receivers, read [iOS autoplay, speed and receivers](titles/ios-playback.md).
- For poster-grid focus, read [Poster-grid focus](titles/poster-grid.md).
- For artwork and sheet geometry, read [Artwork and sheet geometry](titles/geometry.md).
- For category compatibility, read [Category compatibility](titles/categories.md).
- For main-process harness observations, read [Main-process harness observations](titles/harness.md).
- For android subtitles, read [Android subtitles](titles/android-subtitles.md).

Desktop title commands resolve through the same shortcut catalog and profile preferences as Live TV. Renderer `shortcuts.test.ts` drives an actual TitleWatch/controller with a stand-in media engine: a remap retires Space, the new key pauses, held Pause does not toggle again, a failed save retains the committed binding and reset restores Space. This is controller/input proof, not decoded playback or disk persistence. Use [Shared viewing preferences](preferences.md) for the isolated built-app remap/profile/restart/failure/focus journey, and preserve the scrubber's native arrow keys.

## Personal collections

The **Collections** tab on Movies and Series (`apps/desktop/src/renderer/src/features/collections/CollectionsPage.tsx`) lists the active profile's collections with visible counts, and opens one as a poster grid in saved member order. The column offers **New collection** and each row's options menu (Rename, Move up, Move down, Delete collection). A member's poster opens details on the exact added version (`asked`); an unavailable member is dimmed, says Unavailable and is selected by pressing it. Each poster's corner ring selects it; the bar above the grid then offers Add to collection (available members only), Remove from the open collection, and Done. In details, **Add to collection** beside **Save** (`apps/desktop/src/renderer/src/features/collections/TitleCollections.tsx`) ticks the collections holding the version that plays, by subscription and provider id; another version of the same title is another member.

Every read goes through the owner-enveloped `collections.*` IPC and is refused, never shown as empty, when it fails. `collections.changed` re-reads only for the same profile id and revision; changes are sent for the profile the view was drawn for and refused after a switch. A refresh that marks a member for adults cancels old collection responses and drops cached content and counts, including while collection surfaces are closed. Ordinary metadata updates retain selected identities and their saving state, open menu, focus and failed-write retry. During a privacy reset, collection controls remove displayed data and block replay until fresh admission arrives; an exact selected member that remains admitted retains its pending failure, while restricted or deselected members and owner or visit changes discard obsolete action state. A failed fresh title read keeps membership intent suspended and offers Try again; only a successful absence or an owner, visit or version change discards it. Loading another member page keeps controls and focus for already admitted selections; missing selections are pruned only after successful reads of all requested pages. If creating a collection succeeds while title admission is unknown, the created target is retained and Retry sends only the unfinished add with fresh exact title facts. Collection replies and writes bind their exact title facts to `apps/desktop/src/main/services/ondemand.ts` catalogue currency: accepted refreshes, source changes and worker lifetime changes invalidate suspended work, including the synchronous store transaction guard. A failed refresh before acceptance retains readable catalogue facts; unloaded or failed reads refuse. Public renderer checks are in `apps/desktop/test/renderer/collections.test.ts`. Kids approval, adult visibility, exact-source authorization, restart persistence, source erasure and profile deletion are proven by main-process cases in `apps/desktop/test/collections.test.ts` and `apps/desktop/test/profile-policy.test.ts`, not by the built window.

No `pnpm verify:desktop` scenario drives collections yet. A built-window journey uses the CDP harness in `apps/desktop/test/e2e/app.ts` with the fake provider, a scratch script under `.local/` and real clicks and keys: create a collection in the tab, add the fixture movie from its details, reopen the tab, select it and remove it. The fake provider has one subscription, so a built-window run does not show two sources' same-named titles apart, and native macOS and Windows windows are not covered.
