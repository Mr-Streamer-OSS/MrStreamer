# Movies and series

## Sub-features

Movie and series libraries, search, quality/language filters, metadata and episode details, version choice, playback/resume, audio/subtitles and marking episodes watched.

## How to get to it (user POV)

Open **Movies** or **Series** in the header. **All movies** and **All series** include every allowed title; other tabs filter and group the catalogue. The page's search is separate from global search. A poster opens details with Play/Resume, versions and Save. Series details show seasons and episodes. Quality/Language filter the current grid, while global search stays unfiltered.

## Driving it with Electron CDP

Preconditions: built app with fresh fixture provider/TMDB. Run `pnpm verify:desktop titles`. Open Movies > All movies > the fixture poster whose title includes `Two sound tracks`, then close details and open Series > All series > a poster containing `Formats`. Require actual detail dialogs, Save buttons, at least two fake-TMDB detail requests and retained dialog screenshots. This baseline verifies browsing/details, not playback or every filter.

For movie playback, seeking, release of provider connections and subtitles use `apps/desktop/test/e2e/packaged-app.ts`. For episode menus, numbering and watched-state behavior use `episode-marks.ts`. Inspect `TitlesPage.tsx` and the current filter labels before driving Quality/Language, and compare the visible matching poster/count and selected version. Filtering on Verified requires a file already observed by real playback; do not seed observations by writing internal state.

Source: `docs/user/movies-and-series.md`, `apps/desktop/src/renderer/src/features/titles/TitlesPage.tsx`, `DetailsView.tsx`, and `apps/desktop/test/fake-tmdb.ts`.

## Gotchas

TMDB enrichment changes displayed names; fixture poster titles still include provider names. A populated grid is not proof of playback, filters or version choice. Adult content needs its explicit Settings switch. Some verified series tracks only become filterable after reopening their details; check current user docs before treating absence as a defect.
