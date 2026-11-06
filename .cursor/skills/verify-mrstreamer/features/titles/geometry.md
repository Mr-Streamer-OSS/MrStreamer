# Artwork and sheet geometry

## Artwork and sheet geometry

`PosterContent` in `components/TitleArt.tsx` owns the 2:3 frame and the name/caption block. Related rows and Home assign widths; tiles fill them. `CollectionGrid` uses the same aspect ratio and caption allowance for virtual row height. Check loaded pictures of different intrinsic dimensions, missing/failed pictures and long names at narrow/wide sizes and after zoom; labels and frames must stay inside their assigned slots while horizontal scrolling and keyboard opening work.

`Sheet` owns the rounded outer clip; its inner viewport owns vertical scrolling and fills tall sheets. Verify tall movie/series details, short unavailable Watchlist sheets and the Settings playlist/guide mapping sheets with few or no search results. Map footers stay at the bottom of tall sheets. Check Close, Escape, outside click, initial/returned focus and receiver-bar spacing. `App.tsx` gives details a top bar of their own, which `Sheet` draws above the backdrop in the page bar's place so Back, Search and Settings work over them; a click beside the sheet still reaches the backdrop and closes it. The scrollbar must remain inside the top corner. Genre/service tile pages leave space above the first row for its hover/focus border; inspect that edge and open a collection from the tile.
