import type { SettingsSection, SettingsControl } from "../features/settings/catalogue.ts";
import { create } from "zustand";
import type { LiveDiscovery, LiveFilters } from "@mrstreamer/contracts/live-browse";
import type {
  CollectionId,
  CollectionSort,
  RelatedLink,
  TitleKind,
} from "@mrstreamer/contracts/ondemand";
import type { TitleFilters } from "@mrstreamer/contracts/title-filters";
import { ownedId, sameOwned, type OwnedId } from "@mrstreamer/contracts/subscription";
import type { WatchlistEntry } from "@mrstreamer/contracts/watchlist";
import { call } from "../lib/ipc.ts";
import { currentPreferences, readPreferences } from "../lib/preferences.ts";
import { titlePlayer } from "../player/title-player.ts";

/** The page under everything else. Watch, details and playing a title open over it. */
export type View = "home" | "live" | "movies" | "series" | "watchlist" | "downloads" | "recordings";

/**
 * Whether a page stays when every subscription has live TV only, as playlists do: Home, Live TV,
 * Watchlist, Downloads, whose copies need no subscription at all, and Recordings, of live TV.
 */
export function withoutTitles(view: View): boolean {
  return view !== "movies" && view !== "series";
}

/** The tabs of the Settings page, and the licences About opens. */
type SettingsTab = SettingsSection | "licences";

/**
 * A subscription Settings > Subscriptions opens on, and what of it shows: its details, the form
 * that edits it, or the field that asks for its password or link again.
 */
export interface SubscriptionTarget {
  readonly id: string;
  readonly show: "details" | "edit" | "secret";
}

/** A list of channels the guide and Watch's channel list show, one of the viewer's among them. */
export type ChannelList = (
  LiveDiscovery | { readonly kind: "favourites" } | { readonly kind: "recent" }
) & { readonly filters?: LiveFilters };

/** A movie or series whose details are on screen: one of its versions. */
export interface DetailsTarget extends OwnedId {
  readonly kind: TitleKind;
  /** The opener asked for this version, as the 4K tab does, even if the title shows it first. */
  readonly asked?: boolean;
}

/**
 * Where a title's details stood as a related title opened from them: the season picked there,
 * null for the one being watched, how far the sheet was scrolled, and the related title opened,
 * by its `Title.key`, which Back gives the keyboard back to. Opened from a person's or franchise's
 * titles, `linked` is that list, which Back shows again, and `scroll` is the list's.
 */
export interface DetailsPlace {
  readonly season: number | null;
  readonly scroll: number;
  readonly related: string;
  readonly linked?: LinkedView;
}

/**
 * A person's or film franchise's titles, shown in the details' sheet in place of the details
 * whose link opened them (`openLinked`). `label` is the link's own text, shown until TMDB names
 * them and where it can't; `scroll` is how far the details were scrolled, which Back restores
 * with the keyboard on the link.
 */
export interface LinkedView {
  readonly link: RelatedLink;
  readonly label: string;
  readonly scroll: number;
}

/** Details a related title led away from, with where they stood. */
interface DetailsStep {
  readonly target: DetailsTarget;
  readonly place: DetailsPlace;
}

/**
 * How many details Back returns through. Opening a related title beyond that lets the earliest
 * go: a viewer seldom retraces more, and the trail stays a few small records.
 */
export const DETAILS_TRAIL = 8;

/**
 * The update dialog on screen: the panel under the top bar's Update, the restart question, or the
 * launch's reminder (features/updates/UpdateReminder.tsx).
 */
type UpdateDialog = "panel" | "restart" | "reminder";

/**
 * The launch's update reminder: asked of the main process once the viewer browses, then allowed
 * or done. Once shown it keeps the top bar's Update for its version, even past an earlier Not now,
 * until the panel's own Not now or the next launch.
 */
export type UpdateReminder =
  "asking" | "done" | { readonly allowed: string } | { readonly kept: string };

/**
 * Where a list or grid stood as its page went: the item the keys were on, by a key that holds
 * while the list changes and by its position, and how far it was scrolled. Given back, the item
 * is found by its key, else the position is kept, so an item the list no longer shows, such as a
 * title hidden since, never comes back.
 */
export interface Spot {
  readonly key: string | null;
  readonly index: number;
  readonly top: number;
}

/** A `Spot` and what it was of, such as a collection by its sort and filters. */
interface SurfaceSpot extends Spot {
  readonly surface: string;
}

/** The tabs of Movies and Series. */
export type TitlesTab =
  "for-you" | "new" | "genres" | "services" | "4k" | "adult" | "all" | "collections";

/** Where Movies or Series was. */
export interface TitlesPlace {
  /** Invalidates mounted surfaces and late writes after a policy reset. */
  readonly reset: number;
  readonly tab: TitlesTab;
  /** A collection opened over the tab, with how the viewer sorted it; null in its own order. */
  readonly collection: CollectionId | null;
  readonly collectionSort: CollectionSort | null;
  /** How All is sorted. */
  readonly sort: CollectionSort;
  /** What the field in the tab bar searches for; empty shows the tab. */
  readonly query: string;
  /** The filters over every grid of the kind. */
  readonly filters: TitleFilters;
  /** Where the tab, and a collection open over it, stood as each went. */
  readonly spots: { readonly tab: SurfaceSpot | null; readonly collection: SurfaceSpot | null };
}

/**
 * A channel the keys were on, and the row it was at. Given back, the channel is found again, else
 * the row: a channel the list no longer shows never comes back.
 */
export interface ChannelSpot {
  readonly channel: OwnedId | null;
  readonly index: number;
}

/**
 * Where the guide stood: its cursor's channel and moment (`at`), the moment at its left edge and
 * how far down it was scrolled.
 */
export interface GuideSpot extends ChannelSpot {
  readonly at: number;
  readonly left: number;
  readonly top: number;
}

/**
 * Where Live TV stood in the list on show, `UiState.list`; another list starts over. The rows'
 * and the guide's places are for the search they showed (`surface`).
 */
interface LivePlace {
  readonly search: string;
  readonly selected: ChannelSpot | null;
  readonly rows: SurfaceSpot | null;
  readonly guide: (GuideSpot & { readonly surface: string }) | null;
}

/** What Recordings shows beside its side: a list of its own, or one group by its key. */
export type RecordingsShelf =
  "overview" | "recorded" | "scheduled" | "rules" | "protected" | "other" | `group:${string}`;

/**
 * Where each page was as the viewer went to another, for this profile and these subscriptions
 * only: see `resetForAccount`, `leaveSubscription` and `closeTitleSheets`.
 */
export interface Browsing {
  readonly movie: TitlesPlace;
  readonly series: TitlesPlace;
  readonly live: LivePlace;
  readonly recordings: {
    readonly shelf: RecordingsShelf;
    readonly query: string;
    readonly top: number;
  };
  readonly downloads: { readonly top: number };
}

const TITLES_START: TitlesPlace = {
  reset: 0,
  tab: "for-you",
  collection: null,
  collectionSort: null,
  sort: "added",
  query: "",
  filters: {},
  spots: { tab: null, collection: null },
};

const BROWSING_START: Browsing = {
  movie: TITLES_START,
  series: TITLES_START,
  live: { search: "", selected: null, rows: null, guide: null },
  recordings: { shelf: "overview", query: "", top: 0 },
  downloads: { top: 0 },
};

/** Changes where one page is, keeping the rest. */
export function setBrowsing<P extends keyof Browsing>(
  page: P,
  change: (place: Browsing[P]) => Browsing[P],
): void {
  useUi.setState(({ browsing }) => ({ browsing: { ...browsing, [page]: change(browsing[page]) } }));
}

/**
 * `setBrowsing` for one page, bound to the account and profile on show now, and for Live TV to
 * the list on show too. Pages keep their place with it as they unmount: once any of those has
 * changed, as when a page drawn for the last profile unmounts after the switch, it changes nothing.
 */
export function browsingNow<P extends keyof Browsing>(
  page: P,
): (change: (place: Browsing[P]) => Browsing[P]) => void {
  const { account, list, browsing } = useUi.getState();
  const titlesPage = page === "movie" ? "movie" : page === "series" ? "series" : null;

  return (change) => {
    const now = useUi.getState();

    if (
      now.account === account &&
      (page !== "live" || sameList(now.list, list)) &&
      (titlesPage === null || now.browsing[titlesPage].reset === browsing[titlesPage].reset)
    )
      setBrowsing(page, change);
  };
}

interface UiState {
  /**
   * Rises when the subscriptions start over, with the first one saved or the last one removed,
   * so work started before gives way.
   */
  readonly account: number;
  readonly view: View;
  /** Watch covers the page with a live channel. Closing it returns to the page as it was. */
  readonly watching: boolean;
  /** A movie or episode plays over everything, until the viewer leaves it. */
  readonly playingTitle: boolean;
  /** A movie's or series' details, over the page they were opened from. */
  readonly details: DetailsTarget | null;
  /**
   * The details related titles led away from to these, the latest last, which Back returns
   * through: at most `DETAILS_TRAIL`, for this session only, and none without details.
   */
  readonly trail: readonly DetailsStep[];
  /** Where Back found the details on screen, for them to show as they open, once. */
  readonly place: DetailsPlace | null;
  /** A person's or franchise's titles, in place of the details on screen; Back leaves it first. */
  readonly linked: LinkedView | null;
  /**
   * The season picked in the details Settings closed, by their `visit`, for them to show again as
   * Settings closes, as after a change of interface language.
   */
  readonly heldSeason: { readonly visit: number; readonly season: number } | null;
  /**
   * Rises as details open, as a related title opens over them and as Back returns to some: each
   * visit gets a sheet of its own, the same title's again too, so what Back restores applies as
   * that sheet opens, and only then.
   */
  readonly visit: number;
  /** A saved title the lists don't have, in its own short sheet over the page. */
  readonly savedEntry: WatchlistEntry | null;
  /** Watch's channel list is open over the picture. */
  readonly channelsOpen: boolean;
  readonly searchOpen: boolean;
  /** What search starts with when it opens: what Movies or Series searches for, while shown. */
  readonly searchFrom: string;
  /** The Settings tab on screen, over the current view; null while Settings is closed. */
  readonly settings: SettingsTab | null;
  /** What Settings > Subscriptions opens on, once; null leaves its list as it is. */
  readonly subscription: SubscriptionTarget | null;
  readonly settingsTarget: SettingsControl | null;
  /** Settings opens on Online subtitles, once, rather than at its top. */
  readonly onlineSubtitles: boolean;
  /** The list the guide and Watch's channel list show. */
  readonly list: ChannelList;
  readonly updateDialog: UpdateDialog | null;
  readonly updateReminder: UpdateReminder | null;
  /** Where each page was, for coming back to it. */
  readonly browsing: Browsing;
}

/** Navigation and overlay state for the window. */
export const useUi = create<UiState>(() => ({
  account: 0,
  view: window.location.hash === "#background-quit" ? "downloads" : "home",
  watching: false,
  playingTitle: false,
  details: null,
  trail: [],
  place: null,
  linked: null,
  heldSeason: null,
  visit: 0,
  savedEntry: null,
  channelsOpen: false,
  searchOpen: false,
  searchFrom: "",
  settings: null,
  subscription: null,
  settingsTarget: null,
  onlineSubtitles: false,
  list: { kind: "all" },
  updateDialog: null,
  updateReminder: null,
  browsing: BROWSING_START,
}));

// Live TV's place belongs to the list it was in: another list starts at its top.
useUi.subscribe((state, previous) => {
  if (state.list !== previous.list && !sameList(state.list, previous.list))
    useUi.setState({ browsing: { ...state.browsing, live: BROWSING_START.live } });
});

// Settings over a title holds the countdown to its next episode, so nothing starts behind it.
useUi.subscribe((state) => titlePlayer.holdNext(state.settings !== null));

/**
 * Rises as the viewer goes somewhere: to other details or none, or into Settings, a playing title,
 * Watch or search over them, however each was opened. A Back still waiting for the lists gives
 * way to it (`backDetails`), even when the viewer has come back by the time they answer.
 */
let navigation = 0;

useUi.subscribe((state, previous) => {
  if (
    state.details !== previous.details ||
    state.trail !== previous.trail ||
    state.linked !== previous.linked ||
    (state.settings !== null && previous.settings === null) ||
    (state.playingTitle && !previous.playingTitle) ||
    (state.watching && !previous.watching) ||
    (state.searchOpen && !previous.searchOpen)
  )
    navigation += 1;
});

/** A catalogue accepted meanwhile makes a Back's earlier visibility answer obsolete. */
export function invalidateDetailsCatalogue(): void {
  navigation += 1;
}

/** No details on screen, nor a way back through any. */
const NO_DETAILS = {
  details: null,
  trail: [],
  place: null,
  linked: null,
  heldSeason: null,
} as const;

/**
 * Leaves the title, saving how far it got, back to its details or the page. One that plays on a
 * receiver plays on there, with its controls a click away at the foot of every page.
 */
export function leaveTitle(): void {
  if (!titlePlayer.onReceiver()) titlePlayer.close();
  useUi.setState({ playingTitle: false });
}

/** Shows a page, closing Watch, details and Settings over it. */
export function openView(view: View): void {
  useUi.setState({
    view,
    watching: false,
    channelsOpen: false,
    settings: null,
    ...NO_DETAILS,
    savedEntry: null,
  });
}

/**
 * Home with nothing open over it, for the first subscription or none: a list, details, a title
 * open before and where each page was belonged to what went. The title closes too, with what it
 * had pending, such as the countdown to its next episode.
 */
export function resetForAccount(): void {
  titlePlayer.close();
  useUi.setState((state) => ({
    account: state.account + 1,
    view: "home",
    watching: false,
    playingTitle: false,
    ...NO_DETAILS,
    savedEntry: null,
    channelsOpen: false,
    searchOpen: false,
    list: { kind: "all" },
    browsing: BROWSING_START,
  }));
}

/**
 * Opens Settings on one subscription's row, as from a message that it needs its password again:
 * what plays underneath goes on, and every other subscription's content stays in the lists.
 */
export function openSubscription(id: string, show: SubscriptionTarget["show"]): void {
  useUi.setState({ settings: "subscriptions", subscription: { id, show }, searchOpen: false });
}

/** Opens Settings on Online subtitles, as from a title's CC panel: the title goes on underneath. */
export function openOnlineSubtitleSettings(): void {
  useUi.setState({
    settings: "subtitles",
    settingsTarget: "online-subtitles",
    onlineSubtitles: true,
    searchOpen: false,
  });
}

/** Opens Watch over the current page. */
export function openWatch(): void {
  useUi.setState({ watching: true, searchOpen: false, settings: null });
}

/** Closes Watch, back to the page it opened over. */
export function closeWatch(): void {
  useUi.setState({ watching: false, channelsOpen: false });
}

/**
 * Shows a movie's or series' details over the page, as from a poster, search or a playing title.
 * Back leads from them to the page, as Close does.
 */
export function openDetails(target: DetailsTarget): void {
  useUi.setState(({ visit }) => ({
    details: target,
    trail: [],
    place: null,
    linked: null,
    visit: visit + 1,
    savedEntry: null,
    searchOpen: false,
    settings: null,
    watching: false,
  }));
}

/**
 * Shows a related title's details over the details on screen, which Back returns to as they
 * stood (`here`). Past `DETAILS_TRAIL`, the earliest of them goes.
 */
export function openRelated(target: DetailsTarget, here: DetailsPlace): void {
  const { details, trail, visit } = useUi.getState();

  if (!details) return openDetails(target);
  useUi.setState({
    details: target,
    trail: [...trail, { target: details, place: here }].slice(-DETAILS_TRAIL),
    place: null,
    linked: null,
    visit: visit + 1,
  });
}

/** Shows a person's or franchise's titles in place of the details on screen, which Back returns to. */
export function openLinked(view: LinkedView): void {
  if (useUi.getState().details) useUi.setState({ linked: view });
}

/**
 * Back over details: from a person's or franchise's titles to the details they were opened from,
 * else to the details the ones on screen were opened from as a related title, as they stood, with
 * the list they were opened from, or to the page once there are none. The lists are asked first, as they stand now:
 * details of a title they keep from the viewer, as one they have since marked for adults while
 * Settings hides those, are passed over and forgotten, and never show. Going anywhere meanwhile
 * wins over the answer (`navigation`): another Back, Close, other details, Settings, a playing
 * title or search, also left again before the lists answer, and the way back stays as it was.
 */
export async function backDetails(): Promise<void> {
  if (useUi.getState().linked) return useUi.setState({ linked: null });

  for (;;) {
    const mine = ++navigation;
    const { details, trail } = useUi.getState();
    const step = trail.at(-1);

    if (!details || !step) return closeDetails();
    const shown = await stillShown(step.target);

    if (mine !== navigation) return;

    if (!shown) {
      useUi.setState({ trail: trail.slice(0, -1) });
      continue;
    }

    useUi.setState(({ visit }) => ({
      details: step.target,
      trail: trail.slice(0, -1),
      place: step.place,
      linked: step.place.linked ?? null,
      visit: visit + 1,
    }));

    return;
  }
}

/**
 * Whether the lists, as they stand now, let `target`'s title show: not when they mark it for
 * adults while Settings hides those. A title they no longer list shows what its details have of
 * it, as before. When the lists or the preferences can't be read, it doesn't show.
 */
async function stillShown(target: DetailsTarget): Promise<boolean> {
  try {
    const [title] = await call("ondemand.titles", {
      kind: target.kind,
      versions: [ownedId(target)],
    });

    if (!title?.adult) return true;

    return (currentPreferences() ?? (await readPreferences())).adultTitles === true;
  } catch {
    return false;
  }
}

/** Closes the details, and the way back through them, to the page they were opened over. */
export function closeDetails(): void {
  useUi.setState(NO_DETAILS);
}

/**
 * What a removed subscription listed leaves the window: details of it close, with the way back
 * through them, Back passes over its titles, and a saved title's sheet goes when it was saved
 * from it. Movies and Series no longer filter by it, and Live TV's selection and guide cursor go
 * when they were on one of its channels.
 */
export function leaveSubscription(id: string): void {
  useUi.setState(({ details, trail, savedEntry, browsing }) => ({
    ...(details?.subscriptionId === id
      ? NO_DETAILS
      : { trail: trail.filter((step) => step.target.subscriptionId !== id) }),
    savedEntry: savedEntry?.sources.includes(id) ? null : savedEntry,
    browsing: {
      ...browsing,
      movie: withoutSource(browsing.movie, id),
      series: withoutSource(browsing.series, id),
      live: {
        ...browsing.live,
        selected: ofSubscription(browsing.live.selected, id) ? null : browsing.live.selected,
        guide: ofSubscription(browsing.live.guide, id) ? null : browsing.live.guide,
      },
    },
  }));
}

/** A place's filters without one subscription; a filter left with no subscription goes. */
function withoutSource(place: TitlesPlace, id: string): TitlesPlace {
  const { sourceIds, ...rest } = place.filters;

  const kept = sourceIds?.filter((each) => each !== id);
  const removedCollection = place.collection?.startsWith(`like:${id}:`);

  return {
    ...place,
    filters: sourceIds?.includes(id)
      ? kept?.length
        ? { ...rest, sourceIds: kept }
        : rest
      : place.filters,
    collection: removedCollection ? null : place.collection,
    collectionSort: removedCollection ? null : place.collectionSort,
    spots: removedCollection ? { ...place.spots, collection: null } : place.spots,
  };
}

function ofSubscription(spot: ChannelSpot | null, id: string): boolean {
  return spot?.channel?.subscriptionId === id;
}

/**
 * Closes a title's details, with the way back through them, and a saved title's sheet, as when
 * Settings hides titles for adults: what shows may be one. Movies and Series go back to their tab
 * at its top, Adults closing for For you, as what they had open or selected may be one too. A
 * title the lists mark for adults only later is passed over by Back (`backDetails`).
 */
export function closeTitleSheets(): void {
  useUi.setState(({ browsing }) => ({
    ...NO_DETAILS,
    savedEntry: null,
    browsing: {
      ...browsing,
      movie: tabOnly(browsing.movie),
      series: tabOnly(browsing.series),
    },
  }));
}

function tabOnly(place: TitlesPlace): TitlesPlace {
  return {
    ...place,
    reset: place.reset + 1,
    query: "",
    tab: place.tab === "adult" ? "for-you" : place.tab,
    collection: null,
    collectionSort: null,
    spots: { tab: null, collection: null },
  };
}

/** Shows a saved title the lists don't have, over the page: what was kept of it, and Remove. */
export function openSavedEntry(entry: WatchlistEntry): void {
  useUi.setState({ savedEntry: entry, ...NO_DETAILS, searchOpen: false, settings: null });
}

/** Whether two lists are the same. */
export function sameList(a: ChannelList, b: ChannelList): boolean {
  return (
    a.kind === b.kind &&
    (a.kind !== "category" || (b.kind === "category" && sameOwned(a.category, b.category))) &&
    (a.kind !== "topic" || (b.kind === "topic" && a.topic === b.topic)) &&
    (a.kind !== "custom" || (b.kind === "custom" && a.id === b.id))
  );
}

/** Profile changes discard personal navigation, retaining household jobs and the startup initializer. */
export function resetForProfile(): void {
  resetForAccount();
  useUi.setState({
    settings: null,
    subscription: null,
    settingsTarget: null,
    onlineSubtitles: false,
    searchFrom: "",
  });
}
