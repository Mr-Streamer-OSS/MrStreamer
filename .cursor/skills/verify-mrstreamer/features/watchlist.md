# Watchlist

## Sub-features

Save/remove movies or whole series from details, browse Watchlist and Home, sort and keyboard-open entries, preserve saves across restart and subscription changes, handle unavailable titles.

## How to get to it (user POV)

A movie or series poster opens details. **Save** becomes **Saved** after saving; pressing it again removes the title. **Watchlist** in the header opens saved titles; Home also offers its Watchlist row and **All** entry. Tiles open details and have a removal control.

## Driving it with Electron CDP

Preconditions: fresh built desktop session with fake provider/TMDB. Run `pnpm verify:desktop watchlist`. Open the fixture movie through Movies > All movies, click Save, observe Saved, close details, and open the header's Watchlist. Require the same title's saved tile, a persisted app database and before/after screenshots. The baseline proves the details-to-header entry path, not restart persistence.

For removal, Home entry, keyboard actions, ordering, unavailable titles, database write failure, restart and multiple-subscription behavior use `apps/desktop/test/e2e/watchlist-app.ts`. Its real-click and keyboard recipes are reusable; IPC/database observations may confirm a save but cannot perform it for the proof.

Source: `docs/user/movies-and-series.md#watchlist`, `apps/desktop/src/renderer/src/features/watchlist/WatchlistPage.tsx`, `apps/desktop/test/e2e/watchlist-app.ts`.

## Gotchas

Save is a toggle, so clicking twice undoes the first action. One displayed tile does not establish keyboard removal, series saves, ordering or persistence. A removed subscription can preserve its watchlist for reconnecting; ticked deletion has different acceptance. Verify the path the task actually changed.
