# Movies and series

## Sub-features

Movie and series libraries, search, quality/language filters, metadata and episode details, version choice, playback/resume, file tracks, online subtitles with saved timing, and marking episodes watched.

## How to get to it (user POV)

Open **Movies** or **Series** in the header. **All movies** and **All series** include every allowed title; other tabs filter and group the catalogue. The page's search is separate from global search. A poster opens details with Play/Resume, versions and Save. Series details show seasons and episodes. Quality/Language filter the current grid, while global search stays unfiltered.

Online subtitles are configured in **Settings > General > Online subtitles**. During local movie or episode playback, **CC > Search subtitles** searches the enabled services. Choose a result there, or select a saved result under **Saved for this version**. **Playback > Subtitle timing** edits the downloaded result's offset and drift. **Forget downloaded subtitles** clears that file's downloaded results.

## Driving it with Electron CDP

Preconditions: built app with fresh fixture provider/TMDB. Run `pnpm verify:desktop titles`. Open Movies > All movies > the fixture poster whose title includes `Two sound tracks`, then close details and open Series > All series > a poster containing `Formats`. Require actual detail dialogs, Save buttons, at least two fake-TMDB detail requests and retained dialog screenshots. This baseline verifies browsing/details, not playback or every filter.

For movie playback, seeking, release of provider connections and subtitles use `apps/desktop/test/e2e/packaged-app.ts`. For episode menus, numbering and watched-state behavior use `episode-marks.ts`. Inspect `TitlesPage.tsx` and the current filter labels before driving Quality/Language, and compare the visible matching poster/count and selected version. Filtering on Verified requires a file already observed by real playback; do not seed observations by writing internal state.

The titles baseline does not configure online subtitle services. For online proof, use the existing Electron/CDP harness in `apps/desktop/test/e2e/app.ts` with fixture service responses at the external API/download boundary. Require zero service requests after configuration or opening CC, a request after Search, and downloaded cues over a picture that keeps playing. Edit timing, switch cached results with no new download, then restart the app and require that the same exact file restores its text and correction without a service request. Another file version must start without that correction. Choosing Off or a file track during restore must leave the saved result available. Choosing Off, a file track or a saved result during a download, or pressing C, must cancel that download and ignore its late success or failure. Forget must clear the download without changing the global subtitle language.

Public service and IPC cases are in `online-subtitles.test.ts`, `online-subtitle-playback.test.ts`, `subtitle-services.test.ts` and `saved-subtitles.test.ts`; renderer cases are in `renderer/downloaded-subtitles.test.ts` and `renderer/online-subtitle-panel.test.ts`. These contracts supplement the built-app flow. Service fixtures establish no real account, quota or external-service acceptance.

Source: `docs/user/movies-and-series.md`, `docs/user/playback.md`, `apps/desktop/src/renderer/src/features/titles/TitlesPage.tsx`, `DetailsView.tsx`, `SubtitlePanel.tsx`, `SubtitleTimingControls.tsx`, `features/settings/OnlineSubtitlesSection.tsx`, and `apps/desktop/test/fake-tmdb.ts`.

## Gotchas

TMDB enrichment changes displayed names; fixture poster titles still include provider names. A populated grid is not proof of playback, filters or version choice. Adult content needs its explicit Settings switch. Some verified series tracks only become filterable after reopening their details; check current user docs before treating absence as a defect.

Downloaded text and timing belong to the exact file and play locally. Receivers keep supported file tracks. Removing a subscription retains its saved subtitle data unless the viewer also deletes its viewing data. Catalogue refresh can invalidate an episode session's subtitle ownership; record that limit rather than accepting a failed save as successful proof.

Main sends the service requests with its own `fetch`, so a window-side network stub never sees them. Start the app with `--inspect-brk`, replace `globalThis.fetch` for the service hosts while main is paused, and start its workers without that flag. The player ignores its keys while the CC panel or a menu is open, and closing the panel cancels a pending request. To press C during a download, start one with **Playback > Subtitle timing > Try the next result**, then close the menu. A saved result shows again when its file reopens, including after Off.
