// Live TV's guide search: programme titles on every day a subscription's guide keeps, past and
// to come, narrowed by days and channels, a page at a time, with searches the viewer saved.
//   Search the guide, beside the reminders, opens it in place of the list's channels, with what
// the list is searched for; so does the last row of ⌘K's results. Escape closes it.
//   Down or Enter in the field moves to the first match; Up and Down move between matches, Home and
// End jump, Enter opens one's details and Escape goes back to the field. A match on now watches
// its channel; one to come has Remind me.
//   A search, its filters and its pages belong to one subscription: its channel ids, mappings and
// saved searches are its own. Changing the words or a filter starts again from the first page.
// A save that fails keeps what was saved before and says so, with Retry. Saved searches that
// can't be read are not shown as none, and nothing is saved over them.
//   Episode numbers show only as the guide gives them. A full xmltv_ns number reads S1 E4; other
// numbering shows as written, when the guide gives one meant for the screen. Nothing here takes a
// missing repeat mark, a premiere or a new-show mark as proof that an episode is new.
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, X } from "lucide-react";
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { create } from "zustand";
import type {
  GuideSearchPageInput,
  ProgrammeMatch,
  ProgrammeMetadata,
  SavedGuideQuery,
} from "@mrstreamer/contracts/guide";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import { defined } from "@mrstreamer/core/defined";
import { formatDate, t } from "@mrstreamer/core/i18n";
import { openView } from "../../app/ui-store.ts";
import { Button } from "../../components/ui/button.tsx";
import { SearchField } from "../../components/ui/search-field.tsx";
import { useNow } from "../../lib/clock.ts";
import { appError, describeError } from "../../lib/errors.ts";
import { endOfDay, pastTime } from "../../lib/format.ts";
import { call, searchCall } from "../../lib/ipc.ts";
import { subscriptionName, useSubscriptions } from "../../lib/queries.ts";
import { reminderAt, useReminders } from "../../lib/reminders.ts";
import { useDebounced } from "../../lib/use-debounced.ts";
import { cn } from "../../lib/utils.ts";
import { ReminderButton } from "../reminders/ReminderButton.tsx";

/** Matches asked for at a time; the contract allows up to 100. */
const PAGE = 50;

/** As many channels as one search can name. */
const MOST_CHANNELS = 100;

/** As many saved searches as a subscription keeps. */
const MOST_SAVED = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether guide search shows in Live TV, and the words it opens with. */
export const useGuideSearch = create<{ readonly open: boolean; readonly query: string }>(() => ({
  open: false,
  query: "",
}));

/** Opens guide search in Live TV for `query`, as from ⌘K's last row. */
export function openGuideSearch(query: string): void {
  useGuideSearch.setState({ open: true, query });
  openView("live");
}

export function closeGuideSearch(): void {
  useGuideSearch.setState({ open: false });
}

/**
 * "S1 E4 · Part 2 · The Final Lap · Shown before · Premiere": what the guide says of an episode,
 * or "" when it says nothing. The season and episode come only from a complete xmltv_ns number;
 * without one, a number the guide meant for the screen shows as written.
 */
export function episodeLine(metadata: ProgrammeMetadata | undefined): string {
  if (!metadata) return "";
  const { episode } = metadata;
  const onscreen = metadata.episodes?.find((each) => each.system === "onscreen")?.value;

  return [
    episode
      ? t("S{season} E{episode}", { season: episode.season + 1, episode: episode.episode + 1 })
      : onscreen,
    episode && episode.part > 0 ? t("Part {part}", { part: episode.part + 1 }) : undefined,
    metadata.subtitle,
    metadata.repeat ? t("Shown before") : undefined,
    metadata.premiere ? t("Premiere") : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

type Days = Pick<GuideSearchPageInput, "from" | "until">;

type Channels = string[] | undefined;

/** The day filters, as of `now`: every kept day, before today, today, tomorrow and a week. */
function dayChoices(now: number): readonly { readonly label: string; readonly days: Days }[] {
  const today = new Date(now).setHours(0, 0, 0, 0);
  const tomorrow = endOfDay(now);

  return [
    { label: t("Any day"), days: {} },
    { label: t("Before today"), days: { until: today } },
    { label: t("Today"), days: { from: today, until: tomorrow } },
    { label: t("Tomorrow"), days: { from: tomorrow, until: endOfDay(tomorrow + 1) } },
    { label: t("Next 7 days"), days: { from: today, until: endOfDay(today + 6 * DAY_MS) } },
  ];
}

const sameDays = (a: Days, b: Days) => a.from === b.from && a.until === b.until;

const sameChannels = (a: Channels, b: Channels) =>
  a === b ||
  (a !== undefined && b !== undefined && a.length === b.length && a.every((id) => b.includes(id)));

/** "Today", "Yesterday", "Tomorrow" or "Wed 4 Nov", for a match's day column. */
function dayOf(at: number, now: number): string {
  const days = Math.round(
    (new Date(at).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / DAY_MS,
  );

  return days === 0
    ? t("Today")
    : days === 1
      ? t("Tomorrow")
      : days === -1
        ? t("Yesterday")
        : formatDate(at, "weekdayDay");
}

/**
 * The subscription a search starts in: the one the list is filtered to, else the one of the
 * channel playing, else the first.
 */
function startingSubscription(
  ids: readonly string[],
  filtered: readonly string[] | undefined,
  playing: string | undefined,
): string | undefined {
  if (filtered?.length === 1 && ids.includes(filtered[0]!)) return filtered[0];

  return playing && ids.includes(playing) ? playing : ids[0];
}

/**
 * The guide search panel. `channels` are the list's on screen, for This list; `filtered` the
 * subscriptions the list is filtered to and `playing` the subscription of the channel playing.
 */
export function GuideSearch({
  list,
  channels,
  everything,
  filtered,
  playing,
  onWatch,
}: {
  /** The name of the list on screen. */
  list: string;
  channels: readonly LiveChannel[] | undefined;
  /** The list on screen is every channel, unfiltered: This list would be the same as All. */
  everything: boolean;
  filtered: readonly string[] | undefined;
  playing: string | undefined;
  onWatch: (channel: LiveChannel) => void;
}) {
  const subscriptions = useSubscriptions();
  const ids = subscriptions.map((each) => each.id);
  const [picked, setPicked] = useState<string | undefined>(undefined);

  const subscriptionId =
    picked && ids.includes(picked) ? picked : startingSubscription(ids, filtered, playing);

  const text = useGuideSearch((state) => state.query);
  const setText = (query: string) => useGuideSearch.setState({ query });
  const [days, setDays] = useState<Days>({});
  const [chosenChannels, setChannels] = useState<Channels>(undefined);
  const now = useNow();
  const field = useRef<HTMLInputElement>(null);
  const rows = useRef<HTMLUListElement>(null);
  const labels = useId();

  const listIds = channels
    ?.filter((channel) => channel.subscriptionId === subscriptionId)
    .map((channel) => channel.id);

  const choose = (next: string) => {
    setPicked(next);
    // Channel ids are the subscription's own.
    setChannels(undefined);
  };

  const query = text.trim();
  const asked = useDebounced(query, 200);
  const settled = asked === query;

  const input = subscriptionId
    ? {
        subscriptionId,
        query: asked,
        ...defined({ from: days.from, until: days.until, channels: chosenChannels }),
      }
    : null;

  const results = useInfiniteQuery({
    queryKey: ["guide", "searchPage", input],
    queryFn: ({ pageParam, signal }) =>
      searchCall(
        "guide.searchPage",
        { ...input!, limit: PAGE, ...defined({ after: pageParam ?? undefined }) },
        signal,
        "guide-search",
      ),
    initialPageParam: null as GuideSearchPageInput["after"] | null,
    getNextPageParam: (last) => last.next,
    enabled: input !== null && asked !== "",
  });

  const matches =
    settled && asked !== "" ? (results.data?.pages.flatMap((page) => page.matches) ?? []) : [];

  const searching = query !== "" && input !== null && (!settled || results.isPending);
  const failed = settled && results.isError && !results.isFetchNextPageError;

  const choices = dayChoices(now);
  const knownDays = choices.some((choice) => sameDays(choice.days, days));

  const listCovers = !everything && listIds !== undefined;
  const tooMany = (listIds?.length ?? 0) > MOST_CHANNELS;
  const noneHere = listIds?.length === 0;
  const thisList = listCovers && !tooMany && !noneHere ? listIds : undefined;
  const custom = chosenChannels !== undefined && !sameChannels(chosenChannels, thisList);

  const focusRow = (index: number) => {
    const all = rows.current?.querySelectorAll<HTMLButtonElement>("[data-guide-row]");

    if (!all?.length) return;
    all[Math.min(Math.max(index, 0), all.length - 1)]!.focus();
  };

  const onRowsKey = (event: KeyboardEvent<HTMLUListElement>) => {
    const all = [...(rows.current?.querySelectorAll("[data-guide-row]") ?? [])];
    const at = all.indexOf(document.activeElement as Element);

    if (at === -1) return;

    if (event.key === "ArrowDown") focusRow(at + 1);
    else if (event.key === "ArrowUp") {
      if (at === 0) field.current?.focus();
      else focusRow(at - 1);
    } else if (event.key === "Home") focusRow(0);
    else if (event.key === "End") focusRow(all.length - 1);
    else if (event.key === "Escape") field.current?.focus();
    else return;
    event.preventDefault();
  };

  return (
    <section
      aria-labelledby={`${labels}-title`}
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.isDefaultPrevented()) return;
        closeGuideSearch();
        event.preventDefault();
      }}
    >
      <div className="flex h-14 flex-none items-center gap-3 px-9 pt-2 pb-3">
        <h1
          id={`${labels}-title`}
          className="flex-none text-xl font-semibold tracking-tight whitespace-nowrap"
        >
          {t("Search the guide")}
        </h1>
        <SearchField
          ref={field}
          autoFocus
          value={text}
          maxLength={512}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;

            if (event.key === "Escape" && text !== "") setText("");
            else if ((event.key === "ArrowDown" || event.key === "Enter") && matches.length)
              focusRow(0);
            else return;
            event.preventDefault();
          }}
          placeholder={t("Programme title")}
          aria-label={t("Search every guide day")}
          className="w-[22rem] min-w-[10rem] shrink"
        />
        <span
          role="status"
          className="flex-none text-[0.8125rem] whitespace-nowrap text-muted-foreground"
        >
          {searching
            ? t("Searching")
            : failed
              ? `${t("Guide")}: ${t("Service unavailable")}`
              : query && settled && results.isSuccess
                ? matches.length === 0
                  ? t("No matches")
                  : results.hasNextPage
                    ? t("{count} programmes so far", { count: matches.length })
                    : t("{count} programmes", { count: matches.length })
                : ""}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("Close guide search")}
          title={t("Close guide search")}
          onClick={closeGuideSearch}
          className="ml-auto"
        >
          <X />
        </Button>
      </div>

      <div className="flex-none px-9 pb-3">
        {subscriptions.length > 1 && (
          <FilterRow label={t("Subscription")}>
            {subscriptions.map((each) => (
              <Chip
                key={each.id}
                pressed={each.id === subscriptionId}
                onClick={() => choose(each.id)}
              >
                {subscriptionName(each)}
              </Chip>
            ))}
          </FilterRow>
        )}
        <FilterRow label={t("Days")}>
          {choices.map((choice) => (
            <Chip
              key={choice.label}
              pressed={sameDays(choice.days, days)}
              onClick={() => setDays(choice.days)}
            >
              {choice.label}
            </Chip>
          ))}
          {!knownDays && (
            <Chip pressed onClick={() => {}}>
              {days.from === undefined
                ? t("Before {day}", { day: formatDate(days.until ?? now, "day") })
                : t("{from} to {until}", {
                    from: formatDate(days.from, "day"),
                    until: formatDate((days.until ?? days.from + DAY_MS) - 1, "day"),
                  })}
            </Chip>
          )}
        </FilterRow>
        <FilterRow label={t("Channels")}>
          <Chip pressed={chosenChannels === undefined} onClick={() => setChannels(undefined)}>
            {t("All channels")}
          </Chip>
          {!everything && (
            <Chip
              pressed={thisList !== undefined && sameChannels(chosenChannels, thisList)}
              disabled={thisList === undefined}
              onClick={() => setChannels(thisList)}
            >
              {list}
            </Chip>
          )}
          {custom && (
            <Chip pressed onClick={() => {}}>
              {t("{count} channels", { count: chosenChannels?.length ?? 0 })}
            </Chip>
          )}
          {!everything && (tooMany || noneHere) && (
            <span className="text-xs text-muted-foreground">
              {tooMany ? t("Over 100 channels") : t("None from this subscription")}
            </span>
          )}
        </FilterRow>
        {subscriptionId && (
          <SavedSearches
            key={subscriptionId}
            subscriptionId={subscriptionId}
            current={{
              name: query.slice(0, 80),
              query,
              ...defined({ from: days.from, until: days.until, channels: chosenChannels }),
            }}
            onApply={(saved) => {
              setText(saved.query);
              setDays(defined({ from: saved.from, until: saved.until }));
              setChannels(saved.channels);
            }}
          />
        )}
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto px-9 pb-6"
        aria-busy={searching || results.isFetchingNextPage}
        inert={!settled}
      >
        {failed && (
          <p className="pb-3 text-[0.8125rem]">
            <button
              onClick={() => void results.refetch()}
              className="text-white underline underline-offset-4"
            >
              {t("Retry")}
            </button>
          </p>
        )}
        {matches.length > 0 && (
          <ul ref={rows} aria-label={t("Matches in the guide")} onKeyDown={onRowsKey}>
            {matches.map((match) => (
              <MatchRow
                key={`${ownedKey(match.channel)}:${match.programme.start}`}
                match={match}
                now={now}
                onWatch={onWatch}
              />
            ))}
          </ul>
        )}
        {results.hasNextPage && settled && (
          <div className="flex items-center gap-3 pt-3">
            <Button
              size="sm"
              disabled={results.isFetchingNextPage}
              onClick={() => void results.fetchNextPage()}
            >
              {t("Show more")}
            </Button>
            {results.isFetchNextPageError && (
              <span role="alert" className="text-xs text-muted-foreground">
                {t("Guide")}: {t("Service unavailable")}
              </span>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/** A label in its lane, then its choices: one row of the filters. */
function FilterRow({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();

  return (
    <div className="flex min-h-9.5 items-center">
      <span id={id} className="w-[6.875rem] flex-none text-[0.8125rem] text-muted-foreground">
        {label}
      </span>
      <div role="group" aria-labelledby={id} className="flex flex-wrap items-center gap-1.5">
        {children}
      </div>
    </div>
  );
}

/** A filter choice: white when chosen, dashed when it can't be. */
function Chip({
  pressed,
  disabled,
  onClick,
  children,
}: {
  pressed: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-7 max-w-[16rem] items-center truncate rounded-full px-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
        disabled
          ? "border border-dashed border-white/16 font-medium text-[#6b6b6b]"
          : pressed
            ? "bg-foreground font-semibold text-black"
            : "bg-accent font-medium text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/**
 * The subscription's saved searches, each applied with a press, and Save search for what is
 * asked now: one of the same name is replaced.
 */
function SavedSearches({
  subscriptionId,
  current,
  onApply,
}: {
  subscriptionId: string;
  current: SavedGuideQuery;
  onApply: (saved: SavedGuideQuery) => void;
}) {
  const client = useQueryClient();
  const key = ["guide", "savedQueries", subscriptionId];

  const saved = useQuery({
    queryKey: key,
    queryFn: () => call("guide.savedQueries", { subscriptionId }),
  });

  const write = useMutation({
    mutationFn: (queries: readonly SavedGuideQuery[]) =>
      call("guide.setSavedQueries", { subscriptionId, queries: [...queries] }),
    onSuccess: (queries) => client.setQueryData(key, queries),
  });

  const list = saved.data ?? [];
  const replaces = list.some((each) => each.name === current.name);
  const full = list.length >= MOST_SAVED && !replaces;

  const same = (each: SavedGuideQuery) =>
    each.query === current.query &&
    sameDays(each, current) &&
    sameChannels(each.channels, current.channels);

  return (
    <FilterRow label={t("Saved")}>
      {saved.isError ? (
        <span role="alert" className="text-xs text-muted-foreground">
          {t("Saved searches couldn't be read.")}{" "}
          <button
            onClick={() => void saved.refetch()}
            className="text-white underline underline-offset-4"
          >
            {t("Retry")}
          </button>
        </span>
      ) : (
        <>
          {list.map((each) => (
            <span key={each.name} className="flex items-center">
              <Chip pressed={same(each)} onClick={() => onApply(each)}>
                {each.name}
              </Chip>
              <button
                aria-label={t("Remove {title}", { title: each.name })}
                disabled={write.isPending}
                onClick={() => write.mutate(list.filter((other) => other !== each))}
                className="grid size-6 place-items-center rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
          {saved.isSuccess && list.length === 0 && (
            <span className="text-xs text-muted-foreground">{t("No saved searches")}</span>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={!saved.isSuccess || current.query === "" || full || write.isPending}
            onClick={() =>
              write.mutate([...list.filter((each) => each.name !== current.name), current])
            }
          >
            {t("Save search")}
          </Button>
          {full && <span className="text-xs text-muted-foreground">{t("20 saved at most")}</span>}
          {write.isError && (
            <span role="alert" className="text-xs text-foreground">
              {t("The search couldn't be saved.")} {describeError(appError(write.error))}{" "}
              <button
                onClick={() => write.variables && write.mutate(write.variables)}
                className="text-white underline underline-offset-4"
              >
                {t("Retry")}
              </button>
            </span>
          )}
        </>
      )}
    </FilterRow>
  );
}

/**
 * One match: its day, start, channel, title and what the guide says of the episode. Enter or a
 * press opens its description, with Watch while it is on, Remind me before, or when it aired.
 */
function MatchRow({
  match,
  now,
  onWatch,
}: {
  match: ProgrammeMatch;
  now: number;
  onWatch: (channel: LiveChannel) => void;
}) {
  const { channel, programme } = match;
  const [open, setOpen] = useState(false);
  const reminders = useReminders().data;
  const on = programme.start <= now && now < programme.stop;
  const later = programme.start > now;
  const reminded = reminderAt(reminders, channel, programme.start) !== undefined;
  const episode = episodeLine(programme.metadata);
  const day = dayOf(programme.start, now);
  const time = formatDate(programme.start, "time");

  return (
    <li className="border-b border-white/6">
      <button
        data-guide-row
        aria-expanded={open}
        aria-label={[day, time, channel.title, programme.title, episode, on ? t("On now") : null]
          .filter(Boolean)
          .join(", ")}
        onClick={() => setOpen((was) => !was)}
        className="flex h-8 w-full items-center text-left text-[0.8125rem] outline-none hover:bg-white/6 focus-visible:bg-white/10"
      >
        <span className="w-24 flex-none text-foreground">{day}</span>
        <span className="w-[4.375rem] flex-none text-foreground tabular-nums">{time}</span>
        <span className="w-40 flex-none truncate pr-3 text-muted-foreground">{channel.title}</span>
        <span className="min-w-0 flex-1 truncate">
          <span className="text-foreground">{programme.title}</span>
          {episode && <span className="ml-2 text-xs text-muted-foreground">{episode}</span>}
        </span>
        <span className="flex w-24 flex-none items-center justify-end gap-1.5 text-xs text-muted-foreground">
          {on && t("On now")}
          {reminded && <Bell role="img" aria-label={t("Reminder set")} className="size-3.5" />}
        </span>
      </button>
      {open && (
        <div className="pb-3 pl-[20.375rem]">
          {programme.description && (
            <p className="max-w-[40rem] text-[0.8125rem] leading-relaxed text-muted-foreground">
              {programme.description}
            </p>
          )}
          {!on && !later && (
            <p className="text-xs text-muted-foreground">
              {t("Aired {time}", { time: pastTime(programme.start, now) })}
            </p>
          )}
          {on && (
            <Button size="sm" className="mt-2" onClick={() => onWatch(channel)}>
              {t("Watch")}
            </Button>
          )}
          {later && <ReminderButton channel={channel} start={programme.start} className="mt-2" />}
        </div>
      )}
    </li>
  );
}
