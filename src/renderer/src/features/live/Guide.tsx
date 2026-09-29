// The channel guide and the remote-style keys, modelled on MYTVOnline:
//   While watching: Up and Down switch channel, Enter or Left opens the channel list, Right shows
//   the channel details, Backspace returns to the previous channel, digits jump to a number.
//   In the guide: Up and Down move the highlight, Enter watches (Enter on the playing channel
//   closes the list), Left opens categories and then the rail, Right and Backspace close a layer,
//   Escape closes them all, then leaves full screen, then goes Home.
// Keyboard and pointer share one highlight. A two-finger swipe opens or closes layers.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Category, LiveChannel } from "../../../../shared/library.ts";
import { hasModifier, isTyping } from "../../app/platform.ts";
import { toDepth, useUi, type GuideDepth } from "../../app/ui-store.ts";
import { call } from "../../lib/ipc.ts";
import { cn } from "../../lib/utils.ts";
import { player, usePlayer } from "../../player/player.ts";
import { CategoryColumn, type CategoryRow } from "./CategoryColumn.tsx";
import { ChannelColumn } from "./ChannelColumn.tsx";
import { adjacentChannel, useSwipe } from "./input.ts";
import { numberEntry } from "./NumberEntry.tsx";
import { RAIL_ITEMS, Rail, type RailItem } from "./Rail.tsx";

/** Rows Page Up and Page Down move in the channel list. */
const PAGE_ROWS = 10;

type Column = "rail" | "categories" | "channels";

export function Guide({
  pinned,
  side,
  rem,
  channels,
  categories,
  totalChannels,
  onWatch,
  onInfo,
  onClose,
}: {
  pinned: boolean;
  /** Width of the bar beside the picture, used for the channel column when pinned. */
  side: number;
  rem: number;
  channels: readonly LiveChannel[];
  categories: readonly Category[];
  totalChannels: number;
  /** Starts the channel shown while nothing plays. */
  onWatch: () => void;
  /** Shows the channel details over the picture. */
  onInfo: () => void;
  /** Closes the guide layers that cover the picture. */
  onClose: () => void;
}) {
  const base: GuideDepth = pinned ? 1 : 0;
  const depth = toDepth(
    Math.max(
      useUi((state) => state.guideDepth),
      base,
    ),
  );
  const categoryId = useUi((state) => state.categoryId);
  const selectedId = usePlayer((state) => state.channel?.id ?? null);
  const playingId = usePlayer((state) =>
    state.phase.kind === "idle" ? null : (state.channel?.id ?? null),
  );

  const [focus, setFocus] = useState<Column>("channels");
  const [channelIndex, setChannelIndex] = useState(0);
  const [rowIndex, setRowIndex] = useState(0);
  const [railIndex, setRailIndex] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  // The selected category's country starts open.
  const selectedGroup = categories.find((category) => category.id === categoryId)?.group ?? null;
  useEffect(() => {
    if (!selectedGroup) return;
    setExpanded((current) =>
      current.has(selectedGroup) ? current : new Set([...current, selectedGroup]),
    );
  }, [selectedGroup]);

  const rows = useMemo(
    () => categoryRows(categories, expanded, totalChannels),
    [categories, expanded, totalChannels],
  );
  const category = categories.find((entry) => entry.id === categoryId);

  // With the channel list open, a new category or a new channel moves the highlight to the
  // selected channel.
  const channelsOpen = depth >= 1;
  useEffect(() => {
    if (!channelsOpen) return;
    const index = channels.findIndex((channel) => channel.id === selectedId);
    setChannelIndex(index >= 0 ? index : 0);
  }, [channelsOpen, channels, selectedId]);

  // Whenever a layer opens or closes, from the keyboard, a swipe or a button, the deepest open
  // column takes the keyboard, and a newly opened column highlights the current selection.
  const previousDepth = useRef(depth);
  useEffect(() => {
    const before = previousDepth.current;
    previousDepth.current = depth;
    setFocus(depth === 3 ? "rail" : depth === 2 ? "categories" : "channels");
    if (depth >= 2 && before < 2) {
      const index = rows.findIndex((row) =>
        row.kind === "all" ? categoryId === null : row.kind === "category" && row.id === categoryId,
      );
      setRowIndex(Math.max(index, 0));
    }
    if (depth === 3 && before < 3) setRailIndex(0);
  }, [depth]); // Only layer changes; rows and categoryId are read as they are at that moment.

  function setDepth(next: number) {
    useUi.setState({ guideDepth: toDepth(Math.max(base, next)) });
  }

  /**
   * Shows a category's channels. From the keyboard the list takes over, as on the remote; with
   * the mouse the categories stay open so the next category is one click away.
   */
  function selectCategory(id: string | null, from: "keyboard" | "pointer") {
    useUi.setState({ categoryId: id });
    if (from === "keyboard") setDepth(1);
    else setFocus("channels");
    void call("preferences.update", { lastCategoryId: id }).catch(() => {});
  }

  function activateRow(row: CategoryRow, from: "keyboard" | "pointer") {
    if (row.kind === "group") {
      const next = new Set(expanded);
      if (next.has(row.group)) next.delete(row.group);
      else next.add(row.group);
      setExpanded(next);
    } else {
      selectCategory(row.kind === "all" ? null : row.id, from);
    }
  }

  function activateRail(item: RailItem) {
    if (item === "live") setDepth(1);
    else if (item === "home") useUi.setState({ view: "home", guideDepth: toDepth(0) });
    else {
      setDepth(base);
      useUi.setState({ searchOpen: item === "search", settingsOpen: item === "settings" });
    }
  }

  /** Enter on a channel watches it; Enter on the channel already playing closes the list. */
  function activateChannel(channel: LiveChannel) {
    if (channel.id === playingId) setDepth(base);
    else player.play(channel);
  }

  function zap(delta: number) {
    const next = adjacentChannel(channels, selectedId, delta);
    if (!next) return;
    player.zap(next);
    onInfo();
  }

  // The key handler reads the latest render through refs instead of re-subscribing each render.
  const state = useRef({
    depth,
    focus,
    channels,
    rows,
    channelIndex,
    rowIndex,
    railIndex,
    playingId,
  });
  state.current = { depth, focus, channels, rows, channelIndex, rowIndex, railIndex, playingId };
  const actions = useRef({
    setDepth,
    activateRow,
    activateRail,
    activateChannel,
    zap,
    onWatch,
    onInfo,
  });
  actions.current = { setDepth, activateRow, activateRail, activateChannel, zap, onWatch, onInfo };

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const ui = useUi.getState();
      if (isTyping(event) || hasModifier(event) || event.isComposing) return;
      if (ui.searchOpen || ui.settingsOpen) return;
      const now = state.current;
      const act = actions.current;
      const current = now.depth;
      const step = (value: number, delta: number, length: number) =>
        Math.min(Math.max(value + delta, 0), length - 1);

      if (/^[0-9]$/.test(event.key)) {
        numberEntry.type(event.key);
        event.preventDefault();
        return;
      }
      switch (event.key) {
        case "ArrowLeft":
          act.setDepth(current + 1);
          break;
        case "ArrowRight":
          if (current === base) act.onInfo();
          else act.setDepth(current - 1);
          break;
        case "Backspace":
          if (event.repeat) break;
          if (numberEntry.active()) numberEntry.cancel();
          else if (current > base) act.setDepth(current - 1);
          else player.back();
          break;
        case "Escape":
          // One layer at a time, topmost first, ending on Home.
          if (numberEntry.active()) numberEntry.cancel();
          else if (current > base) act.setDepth(base);
          else if (document.fullscreenElement) void document.exitFullscreen();
          else useUi.setState({ view: "home", guideDepth: toDepth(0) });
          break;
        case "ArrowUp":
        case "ArrowDown":
        case "PageUp":
        case "PageDown": {
          const direction = event.key === "ArrowDown" || event.key === "PageDown" ? 1 : -1;
          const distance = event.key.startsWith("Page") ? PAGE_ROWS : 1;
          if (current === 0) act.zap(direction);
          else if (now.focus === "channels") {
            setChannelIndex(step(now.channelIndex, direction * distance, now.channels.length));
          } else if (now.focus === "categories") {
            setRowIndex(step(now.rowIndex, direction * distance, now.rows.length));
          } else setRailIndex(step(now.railIndex, direction, RAIL_ITEMS.length));
          break;
        }
        case "Home":
        case "End":
          if (current === 0 || now.focus !== "channels") return;
          setChannelIndex(event.key === "Home" ? 0 : Math.max(now.channels.length - 1, 0));
          break;
        case "Enter": {
          if (event.repeat) break;
          if (numberEntry.commit()) break;
          if (current === 0) {
            if (now.playingId) act.setDepth(1);
            else act.onWatch();
          } else if (now.focus === "channels") {
            const channel = now.channels[now.channelIndex];
            if (channel) act.activateChannel(channel);
          } else if (now.focus === "categories") {
            const row = now.rows[now.rowIndex];
            if (row) act.activateRow(row, "keyboard");
          } else {
            const item = RAIL_ITEMS[now.railIndex];
            if (item) act.activateRail(item.id);
          }
          break;
        }
        case "i":
          act.onInfo();
          break;
        default:
          return;
      }
      event.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [base]);

  const onSwipe = useSwipe({ horizontal: (direction) => setDepth(depth - direction) });

  if (depth === 0) return null;
  // Over the picture the columns sit on solid black, with a short fade to their right so the
  // edge does not cut the video hard. Pinned in the side bar at depth 1, they need neither.
  const overPicture = !pinned || depth > 1;
  return (
    <div
      className="absolute inset-y-0 left-0 z-20 flex"
      onWheel={(event) => {
        // The guide scrolls its own lists; only its horizontal swipes change layers.
        event.stopPropagation();
        onSwipe(event);
      }}
    >
      <div className={cn("flex h-full", overPicture && "bg-black")}>
        {depth >= 3 && (
          <Rail
            highlight={railIndex}
            focused={focus === "rail"}
            onPointerHighlight={(index) => {
              setFocus("rail");
              setRailIndex(index);
            }}
            onActivate={activateRail}
          />
        )}
        {depth >= 2 && (
          <CategoryColumn
            rows={rows}
            selectedId={categoryId}
            highlight={rowIndex}
            focused={focus === "categories"}
            onPointerHighlight={(index) => {
              setFocus("categories");
              setRowIndex(index);
            }}
            onActivate={(row) => activateRow(row, "pointer")}
            onOpenMenu={() => setDepth(3)}
          />
        )}
        <ChannelColumn
          channels={channels}
          heading={category?.title ?? "All channels"}
          subheading={category ? category.group : "Every category"}
          highlight={channelIndex}
          playingId={playingId}
          focused={focus === "channels"}
          rem={rem}
          width={pinned ? Math.max(side, 20 * rem) : "26rem"}
          onPointerHighlight={(index) => {
            setFocus("channels");
            setChannelIndex(index);
          }}
          onActivate={activateChannel}
          onOpenCategories={() => setDepth(2)}
          onClose={overPicture ? onClose : undefined}
        />
      </div>
      {overPicture && <div className="h-full w-24 bg-gradient-to-r from-black to-transparent" />}
    </div>
  );
}

/**
 * Categories in provider order. Grouped ones sit under their group, which takes the place of the
 * group's first category and lists them all when open.
 */
function categoryRows(
  categories: readonly Category[],
  expanded: ReadonlySet<string>,
  total: number,
): CategoryRow[] {
  const groups = new Map<string, Category[]>();
  for (const category of categories) {
    if (category.group === null) continue;
    const list = groups.get(category.group);
    if (list) list.push(category);
    else groups.set(category.group, [category]);
  }
  const categoryRow = (category: Category, nested: boolean): CategoryRow => ({
    kind: "category",
    id: category.id,
    title: category.title,
    count: category.channelCount,
    nested,
  });
  const rows: CategoryRow[] = [{ kind: "all", count: total }];
  const placed = new Set<string>();
  for (const category of categories) {
    const { group } = category;
    if (group === null) {
      rows.push(categoryRow(category, false));
      continue;
    }
    if (placed.has(group)) continue;
    placed.add(group);
    const list = groups.get(group) ?? [];
    const open = expanded.has(group);
    const count = list.reduce((sum, entry) => sum + entry.channelCount, 0);
    rows.push({ kind: "group", group, count, open });
    if (open) rows.push(...list.map((entry) => categoryRow(entry, true)));
  }
  return rows;
}
