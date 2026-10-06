// Live TV: the lists on the left, the chosen list's channels with what's on now and next, and the
// current stream, muted, on top. A click on a channel opens Watch; Back returns here unchanged.
//   Up and Down move the selection; PageUp, PageDown, Home and End jump. Enter watches. Right opens
//   the rest of the day and Left closes it; Left again moves to the lists and Right comes back.
//   Digits jump to a channel number, S stars, Escape goes Home.
//   The field at the end of the list's title searches that list, by channel name and by the
// programmes on now and later today, and shows the channels it finds in the list's order. / goes
// to it; Down or Enter there hands the keys to the channels found. Escape clears a search before
// it goes Home, and so does another list. ⌘K searches everything for the same.
import { useQuery } from "@tanstack/react-query";
import { Play, Search, Volume2, VolumeX, X } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { hasModifier, isMac, isTyping } from "../../app/platform.ts";
import { openView, openWatch, useUi } from "../../app/ui-store.ts";
import { CatalogueNotice, catalogueState } from "../../components/CatalogueNotice.tsx";
import { ChannelLogo } from "../../components/ChannelLogo.tsx";
import { Progress } from "../../components/Progress.tsx";
import { Button } from "../../components/ui/button.tsx";
import { WindowBar } from "../../components/WindowBar.tsx";
import { useNow } from "../../lib/clock.ts";
import { progressOf, timeLeft } from "../../lib/format.ts";
import { showSelection, useKeyboardMode } from "../../lib/input-mode.ts";
import { queries, useCategoryMap, useFavouriteIds, useToggleFavourite } from "../../lib/queries.ts";
import { usePreviewWaits } from "../../player/output.ts";
import { Picture } from "../../player/Picture.tsx";
import { player, usePlayer } from "../../player/player.ts";
import { numberEntry, NumberEntry } from "../watch/NumberEntry.tsx";
import { ChannelTable } from "./ChannelTable.tsx";
import { ListPicker, listKey, useOpenGroups } from "./ListPicker.tsx";
import {
  groupOf,
  listTitle,
  showList,
  useListChannels,
  useListEntries,
  useListSearch,
} from "./lists.ts";

const PAGE_ROWS = 10;
const NO_CHANNELS: readonly LiveChannel[] = [];

/** Plays a channel and opens Watch on it. */
export function watchChannel(channel: LiveChannel): void {
  player.watch(channel);
  openWatch();
}

export function GuidePage({ active }: { active: boolean }) {
  const list = useUi((state) => state.list);
  const categories = useQuery(queries.categories());
  const categoryMap = useCategoryMap();
  const { channels: listed, error } = useListChannels(list);
  const channels = listed ?? NO_CHANNELS;
  const playingId = usePlayer((state) => state.channel?.id ?? null);
  const favourites = useFavouriteIds();
  const toggleFavourite = useToggleFavourite();
  const keyboard = useKeyboardMode();

  const { open, toggle } = useOpenGroups(groupOf(list, categoryMap));
  const entries = useListEntries(open);
  const [focus, setFocus] = useState<"lists" | "channels">("channels");
  const [entry, setEntry] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // A remembered category can disappear after a refresh or a new login.
  useEffect(() => {
    if (list.kind === "category" && categories.data && !categoryMap.has(list.id)) {
      showList({ kind: "all" });
    }
  }, [list, categories.data, categoryMap]);

  // What the field holds belongs to the list it was typed in: another list starts without a
  // search, unless the search itself moved there.
  const key = listKey(list);
  const [typed, setTyped] = useState({ key, text: "" });
  if (typed.key !== key) setTyped({ key, text: "" });
  const text = typed.key === key ? typed.text : "";
  const setText = (text: string) => setTyped({ key, text });
  const search = useListSearch(list, channels, text);
  const rows = search.channels;
  const searching = search.query !== "";
  const field = useRef<HTMLInputElement>(null);

  // The selection keeps to its channel when the rows change under it, as a search's do while
  // programmes begin and end, and stays among the rows once its channel has gone.
  const [chosen, setChosen] = useState<{ index: number; id: string | null }>({
    index: 0,
    id: null,
  });
  const kept =
    chosen.id === null || rows[chosen.index]?.id === chosen.id
      ? chosen.index
      : rows.findIndex((channel) => channel.id === chosen.id);
  const selected = Math.min(kept === -1 ? chosen.index : kept, Math.max(rows.length - 1, 0));

  // A new list, or another search of it, selects its playing channel, or its first.
  const loaded = listed !== undefined;
  useEffect(() => {
    const index = Math.max(
      rows.findIndex((channel) => channel.id === player.current()?.id),
      0,
    );
    setChosen({ index, id: rows[index]?.id ?? null });
    setExpandedId(null);
  }, [key, loaded, search.query]);

  // ⌘K and the search button search everything for what this list is searched for.
  useEffect(() => {
    if (!active) return;
    useUi.setState({ searchFrom: text.trim() });
    return () => useUi.setState({ searchFrom: "" });
  }, [active, text]);

  // The key handler reads the latest render through a ref. Registering it again on every render
  // would drop keys: a state change from another keydown listener renders between listeners.
  const state = useRef({
    focus,
    selected,
    entry,
    expandedId,
    rows,
    entries,
    text,
    setText,
    toggle,
    toggleFavourite,
  });
  state.current = {
    focus,
    selected,
    entry,
    expandedId,
    rows,
    entries,
    text,
    setText,
    toggle,
    toggleFavourite,
  };

  useEffect(() => {
    if (!active) return;
    function onKey(event: KeyboardEvent) {
      const ui = useUi.getState();
      if (event.defaultPrevented || isTyping(event) || hasModifier(event) || event.isComposing)
        return;
      if (
        ui.searchOpen ||
        ui.settings ||
        ui.updateDialog ||
        ui.watching ||
        ui.playingTitle ||
        ui.details ||
        ui.view !== "live"
      )
        return;
      const now = state.current;
      const { toggle, toggleFavourite } = now;
      const channel = now.rows[now.selected];
      const step = (value: number, delta: number, length: number) =>
        Math.min(Math.max(value + delta, 0), Math.max(length - 1, 0));
      const select = (index: number) => setChosen({ index, id: now.rows[index]?.id ?? null });

      if (/^[0-9]$/.test(event.key)) {
        numberEntry.type(event.key);
        event.preventDefault();
        return;
      }
      switch (event.key) {
        case "ArrowUp":
        case "ArrowDown":
        case "PageUp":
        case "PageDown": {
          const direction = event.key === "ArrowDown" || event.key === "PageDown" ? 1 : -1;
          const distance = event.key.startsWith("Page") ? PAGE_ROWS : 1;
          if (now.focus === "channels") {
            select(step(now.selected, direction * distance, now.rows.length));
          } else setEntry(step(now.entry, direction * distance, now.entries.length));
          break;
        }
        case "Home":
        case "End": {
          const last = event.key === "End";
          if (now.focus === "channels") select(last ? Math.max(now.rows.length - 1, 0) : 0);
          else setEntry(last ? Math.max(now.entries.length - 1, 0) : 0);
          break;
        }
        case "Enter": {
          if (event.repeat) break;
          if (numberEntry.commit()) break;
          if (now.focus === "channels") {
            if (channel) watchChannel(channel);
          } else {
            const picked = now.entries[now.entry];
            if (picked?.kind === "group") toggle(picked.group);
            else if (picked) {
              showList(picked.list);
              setFocus("channels");
            }
          }
          break;
        }
        case "ArrowRight":
          if (now.focus === "lists") setFocus("channels");
          else if (channel) setExpandedId(channel.id);
          break;
        case "ArrowLeft":
          if (now.focus === "channels" && now.expandedId === channel?.id && channel) {
            setExpandedId(null);
          } else if (now.focus === "channels") setFocus("lists");
          break;
        case "Backspace":
          if (numberEntry.active()) numberEntry.cancel();
          break;
        case "Escape":
          if (numberEntry.active()) numberEntry.cancel();
          else if (now.text !== "") now.setText("");
          else openView("home");
          break;
        case "/":
          // No field shows for a list without channels.
          if (!field.current) return;
          field.current.focus();
          field.current.select();
          break;
        case "s":
        case "S":
          if (channel) toggleFavourite(channel.id);
          break;
        default:
          return;
      }
      event.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  const notice = catalogueState({ data: categories.data, error: categories.error ?? error });
  const title = listTitle(list, categoryMap);
  return (
    <div className="flex h-full flex-col">
      <WindowBar className="bg-black" />
      {notice ? (
        <div className="flex flex-1 items-center justify-center pb-14">
          <CatalogueNotice state={notice} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <ListPicker
            entries={entries}
            selected={list}
            highlight={keyboard && focus === "lists" ? entry : null}
            onPick={(picked) => {
              showList(picked);
              setFocus("channels");
            }}
            onToggle={toggle}
            className="w-[16rem] flex-none border-r border-border px-3 pt-3 pb-6"
          />
          <main className="flex min-w-0 flex-1 flex-col">
            <NowStrip active={active} />
            <div className="flex h-14 flex-none items-center gap-3 px-9 pt-2 pb-3">
              <h1 className="min-w-0 truncate text-xl font-semibold tracking-tight">{title}</h1>
              {searching && listed && (
                <span className="flex-none text-sm text-muted-foreground tabular-nums">
                  {rows.length.toLocaleString()} of {listed.length.toLocaleString()}
                </span>
              )}
              {channels.length > 0 && (
                <SearchField
                  field={field}
                  list={title}
                  value={text}
                  onChange={setText}
                  onLeave={() => {
                    setFocus("channels");
                    showSelection();
                  }}
                />
              )}
            </div>
            {listed && listed.length === 0 ? (
              <p className="px-9 text-sm text-muted-foreground">
                {list.kind === "favourites" ? "No favourites yet." : "No channels."}
              </p>
            ) : listed && searching && rows.length === 0 ? (
              <NothingFound
                list={title}
                query={search.query}
                onSearchAll={
                  list.kind === "all"
                    ? null
                    : () => {
                        // The search moves to every channel with what it holds.
                        setTyped({ key: listKey({ kind: "all" }), text });
                        showList({ kind: "all" });
                      }
                }
              />
            ) : (
              <ChannelTable
                key={`${key}\n${search.query}`}
                channels={rows}
                selected={keyboard && focus === "channels" ? selected : null}
                playingId={playingId}
                expandedId={expandedId}
                favourites={favourites}
                words={search.words}
                matches={search.matches}
                onWatch={(channel) => {
                  setChosen({ index: rows.indexOf(channel), id: channel.id });
                  watchChannel(channel);
                }}
                onToggleSchedule={(id) => setExpandedId((current) => (current === id ? null : id))}
                onToggleFavourite={toggleFavourite}
              />
            )}
          </main>
        </div>
      )}
      {active && <NumberEntry onChannel={watchChannel} />}
    </div>
  );
}

/**
 * The field at the end of the list's title, which searches that list. Down or Enter hands the
 * keys to the channels found; Escape clears it and does the same.
 */
function SearchField({
  field,
  list,
  value,
  onChange,
  onLeave,
}: {
  field: RefObject<HTMLInputElement | null>;
  /** The list's name, which the field says it searches. */
  list: string;
  value: string;
  onChange: (text: string) => void;
  onLeave: () => void;
}) {
  return (
    <label className="group ml-auto flex h-9 w-[17rem] flex-none items-center gap-2 rounded-full bg-white/8 px-3.5 focus-within:bg-white/12">
      <Search className="size-4 flex-none text-muted-foreground" />
      <input
        ref={field}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          // Enter that ends a composition, as for Japanese, is the text's.
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") onChange("");
          else if (event.key !== "ArrowDown" && event.key !== "Enter") return;
          event.currentTarget.blur();
          onLeave();
          event.preventDefault();
        }}
        placeholder={`Search ${list}`}
        aria-label={`Search ${list}`}
        spellCheck={false}
        className="min-w-0 flex-1 truncate bg-transparent text-[0.875rem] text-foreground outline-none placeholder:text-muted-foreground"
      />
      {value ? (
        <button
          aria-label="Clear search"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onChange("")}
          className="-mr-1 grid size-6 flex-none place-items-center rounded-full text-muted-foreground hover:bg-white/10 hover:text-white"
        >
          <X className="size-3.5" />
        </button>
      ) : (
        <kbd className="flex-none rounded border border-white/15 px-1.5 font-sans text-xs leading-5 text-muted-foreground group-focus-within:hidden">
          /
        </kbd>
      )}
    </label>
  );
}

/** A search found nothing in its list: the same search in every channel, or in everything. */
function NothingFound({
  list,
  query,
  onSearchAll,
}: {
  list: string;
  query: string;
  /** Null in the list of every channel, which has no wider one. */
  onSearchAll: (() => void) | null;
}) {
  const link = "text-white underline-offset-4 hover:underline";
  return (
    <div className="px-9 text-sm text-muted-foreground">
      <p>
        Nothing in {list} for <b className="font-semibold text-white">{query}</b>.
      </p>
      <p className="mt-3 flex gap-5">
        {onSearchAll && (
          <button
            onMouseDown={(event) => event.preventDefault()}
            onClick={onSearchAll}
            className={link}
          >
            Search all channels
          </button>
        )}
        <button
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => useUi.setState({ searchOpen: true })}
          className={link}
        >
          Search everything {isMac ? "⌘K" : "Ctrl K"}
        </button>
      </p>
    </div>
  );
}

/**
 * The stream that plays, muted, with what it shows and a way back to it. While a receiver on the
 * network is connected, the channel stands still and a line says why.
 */
function NowStrip({ active }: { active: boolean }) {
  const channel = usePlayer((state) => state.channel);
  const audible = usePlayer((state) => state.audible && !state.muted);
  const waits = usePreviewWaits();
  const listing = useQuery({
    ...queries.listings(channel ? [channel.id] : []),
  }).data?.[channel?.id ?? ""];
  const now = useNow();
  if (!channel) return null;
  const current = listing?.now ?? null;
  return (
    <section className="flex items-end gap-6 px-9 pt-5 pb-4">
      <div className="relative aspect-video w-[18rem] flex-none overflow-hidden rounded-xl bg-white/5">
        <div className="absolute inset-0 grid place-items-center">
          <ChannelLogo channel={channel} className="h-12 w-20" />
        </div>
        <Picture
          active={active && !waits}
          fit="cover"
          className="absolute inset-0"
          onClick={() => watchChannel(channel)}
        />
      </div>
      <div className="min-w-0 pb-1">
        <div className="truncate text-2xl font-semibold tracking-tight">
          {current?.title ?? channel.title}
        </div>
        <div className="mt-1 truncate text-sm text-muted-foreground">
          {current ? `${channel.title} · ${timeLeft(current, now)}` : channel.tags.join(" · ")}
        </div>
        {current && <Progress value={progressOf(current, now)} className="mt-2 w-48" />}
        <div className="mt-4 flex items-center gap-2">
          <Button variant="primary" onClick={() => watchChannel(channel)}>
            <Play className="fill-current" />
            Watch
          </Button>
          {waits ? (
            <span className="ml-1 text-sm text-muted-foreground">{waits}</span>
          ) : (
            <Button
              variant="secondary"
              size="icon"
              aria-label={audible ? "Mute" : "Unmute"}
              onClick={() => player.toggleMute()}
            >
              {audible ? <Volume2 /> : <VolumeX />}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
