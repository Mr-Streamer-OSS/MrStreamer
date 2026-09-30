// Live TV: the lists on the left, the chosen list's channels with what's on now and next, and the
// current stream, muted, on top. A click on a channel opens Watch; Back returns here unchanged.
//   Up and Down move the selection; PageUp, PageDown, Home and End jump. Enter watches. Right opens
//   the rest of the day and Left closes it; Left again moves to the lists and Right comes back.
//   Digits jump to a channel number, S stars, Escape goes Home.
import { useQuery } from "@tanstack/react-query";
import { Play, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { hasModifier, isTyping } from "../../app/platform.ts";
import { openView, openWatch, useUi } from "../../app/ui-store.ts";
import { CatalogueNotice, catalogueState } from "../../components/CatalogueNotice.tsx";
import { ChannelLogo } from "../../components/ChannelLogo.tsx";
import { Progress } from "../../components/Progress.tsx";
import { Button } from "../../components/ui/button.tsx";
import { WindowBar } from "../../components/WindowBar.tsx";
import { useNow } from "../../lib/clock.ts";
import { progressOf, timeLeft } from "../../lib/format.ts";
import { useKeyboardMode } from "../../lib/input-mode.ts";
import { queries, useCategoryMap, useFavouriteIds, useToggleFavourite } from "../../lib/queries.ts";
import { Picture } from "../../player/Picture.tsx";
import { player, usePlayer } from "../../player/player.ts";
import { numberEntry, NumberEntry } from "../watch/NumberEntry.tsx";
import { ChannelTable } from "./ChannelTable.tsx";
import { ListPicker, listKey, useOpenGroups } from "./ListPicker.tsx";
import { groupOf, listTitle, showList, useListChannels, useListEntries } from "./lists.ts";

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
  const [selected, setSelected] = useState(0);
  const [entry, setEntry] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // A remembered category can disappear after a refresh or a new login.
  useEffect(() => {
    if (list.kind === "category" && categories.data && !categoryMap.has(list.id)) {
      showList({ kind: "all" });
    }
  }, [list, categories.data, categoryMap]);

  // A new list selects its playing channel, or its first.
  const key = listKey(list);
  const loaded = listed !== undefined;
  useEffect(() => {
    const index = channels.findIndex((channel) => channel.id === player.current()?.id);
    setSelected(Math.max(index, 0));
    setExpandedId(null);
  }, [key, loaded]);

  // The key handler reads the latest render through a ref. Registering it again on every render
  // would drop keys: a state change from another keydown listener renders between listeners.
  const state = useRef({
    focus,
    selected,
    entry,
    expandedId,
    channels,
    entries,
    toggle,
    toggleFavourite,
  });
  state.current = {
    focus,
    selected,
    entry,
    expandedId,
    channels,
    entries,
    toggle,
    toggleFavourite,
  };

  useEffect(() => {
    if (!active) return;
    function onKey(event: KeyboardEvent) {
      const ui = useUi.getState();
      if (event.defaultPrevented || isTyping(event) || hasModifier(event) || event.isComposing)
        return;
      if (ui.searchOpen || ui.settings || ui.updateDialog || ui.watching || ui.view !== "live")
        return;
      const now = state.current;
      const { toggle, toggleFavourite } = now;
      const channel = now.channels[now.selected];
      const step = (value: number, delta: number, length: number) =>
        Math.min(Math.max(value + delta, 0), Math.max(length - 1, 0));

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
            setSelected(step(now.selected, direction * distance, now.channels.length));
          } else setEntry(step(now.entry, direction * distance, now.entries.length));
          break;
        }
        case "Home":
        case "End": {
          const last = event.key === "End";
          if (now.focus === "channels")
            setSelected(last ? Math.max(now.channels.length - 1, 0) : 0);
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
          else openView("home");
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
            <h1 className="px-9 pt-2 pb-3 text-xl font-semibold tracking-tight">
              {listTitle(list, categoryMap)}
            </h1>
            {listed && listed.length === 0 ? (
              <p className="px-9 text-sm text-muted-foreground">
                {list.kind === "favourites" ? "No favourites yet." : "No channels."}
              </p>
            ) : (
              <ChannelTable
                channels={channels}
                selected={keyboard && focus === "channels" ? selected : null}
                scrollKey={key}
                playingId={playingId}
                expandedId={expandedId}
                favourites={favourites}
                onWatch={(channel) => {
                  setSelected(channels.indexOf(channel));
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

/** The stream that plays, muted, with what it shows and a way back to it. */
function NowStrip({ active }: { active: boolean }) {
  const channel = usePlayer((state) => state.channel);
  const audible = usePlayer((state) => state.audible && !state.muted);
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
          active={active}
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
          <Button
            variant="secondary"
            size="icon"
            aria-label={audible ? "Mute" : "Unmute"}
            onClick={() => player.toggleMute()}
          >
            {audible ? <Volume2 /> : <VolumeX />}
          </Button>
        </div>
      </div>
    </section>
  );
}
