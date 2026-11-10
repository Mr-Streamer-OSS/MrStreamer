// Saved layouts and the stream meter. A layout holds only a name and its channels' source-qualified
// ids in slot order, saved in the viewer's preferences. Choosing one asks main to admit each of its
// channels in its own slot; one that no longer opens leaves its slot unavailable. A read that fails
// says so and offers Retry, never an empty list; a save that fails keeps the list and the typed name.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, RotateCw } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import type { Preferences } from "@mrstreamer/contracts/preferences";
import { ownedId, ownedKey, sameOwned, type OwnedId } from "@mrstreamer/contracts/subscription";
import { t } from "@mrstreamer/core/i18n";
import { Button } from "../../../components/ui/button.tsx";
import { appError, describeError } from "../../../lib/errors.ts";
import { currentProfile, profileOwner } from "../../../lib/ipc.ts";
import { updatePreferences } from "../../../lib/preferences.ts";
import { queries, subscriptionName, useSubscriptions } from "../../../lib/queries.ts";
import { cn } from "../../../lib/utils.ts";
import { paneGroup, usePaneGroup, usePlayer } from "../../../player/player.ts";
import { browseQuery } from "../../live/lists.ts";
import { flash } from "../flash-state.ts";
import { Choice, MenuNote } from "../TrackMenus.tsx";
import { Pop } from "./Pop.tsx";
import { capacityQuery, closePane, SLOTS, useVanished, type MultiviewMenu } from "./state.ts";

type MultiviewLayout = NonNullable<Preferences["multiviewLayouts"]>[number];

const NO_LAYOUTS: readonly MultiviewLayout[] = [];

interface MenuProps {
  menu: MultiviewMenu | null;
  onMenu: (menu: MultiviewMenu | null) => void;
}

/** The panes' channels in slot order, as a layout would save them. */
function usePaneChannels(): readonly OwnedId[] {
  const panes = usePaneGroup((state) => state.panes);

  return SLOTS.flatMap((id) => {
    const channel = panes.find((pane) => pane.id === id)?.state.channel;

    return channel ? [ownedId(channel)] : [];
  });
}

/** The saved layouts and the one the panes show now, if any. */
function useLayouts() {
  const preferences = useQuery(queries.preferences());
  const channels = usePaneChannels();
  const layouts = preferences.data?.multiviewLayouts ?? NO_LAYOUTS;

  const shown = layouts.find(
    (layout) =>
      layout.channels.length === channels.length &&
      layout.channels.every((channel, index) => sameOwned(channel, channels[index])),
  );

  return { preferences, layouts, channels, shown: shown ?? null };
}

/** The bar's Layout picker and stream meter, while the multiview shows. */
export function MultiviewBar({ menu, onMenu }: MenuProps) {
  const client = useQueryClient();
  const { preferences, layouts, shown } = useLayouts();
  const opening = useRef(0);
  useEffect(
    () => () => {
      opening.current++;
    },
    [],
  );
  const failed = preferences.isError && !preferences.data;
  const open = menu === "layouts";

  const choose = async (layout: MultiviewLayout) => {
    const mine = ++opening.current;
    const lifetime = paneGroup.lifetime();
    const owner = profileOwner();

    const current = () =>
      mine === opening.current && paneGroup.lifetime() === lifetime && currentProfile(owner);

    onMenu(null);

    const request = browseQuery(
      { kind: "favourites" },
      // A layout's channels resolve as the viewer's other saved channels do: by their profile.
      { favourites: layout.channels, recent: [] },
      "viewer",
      preferences.data,
      undefined,
    );

    const found = await client.fetchQuery(queries.browse(request)).catch((cause: unknown) => {
      if (current()) flash(describeError(appError(cause)));

      return null;
    });

    // A failed read, a newer choice, or the multiview closed meanwhile.
    if (!found || !current() || paneGroup.state().panes.length === 0) return;
    const listed = new Map(found.channels.map((channel) => [ownedKey(channel), channel]));
    const resolved = layout.channels.map((channel) => listed.get(ownedKey(channel)) ?? null);

    if (resolved.every((channel) => channel === null)) {
      flash(t("Unavailable"));

      return;
    }

    const vanished = SLOTS.filter((_, index) => layout.channels[index] && !resolved[index]);
    useVanished.setState({ slots: vanished });
    const panes = paneGroup.state().panes;

    // Fill first, then empty what the layout leaves out, so the group always keeps a pane.
    for (const [index, id] of SLOTS.entries()) {
      const channel = resolved[index];
      const current = panes.find((pane) => pane.id === id)?.state.channel;

      if (channel && !sameOwned(current, channel)) paneGroup.add(id, channel);
    }

    for (const [index, id] of SLOTS.entries()) {
      const current = panes.find((pane) => pane.id === id)?.state.channel;

      if (current && !resolved[index]) closePane(id, current);
    }
  };

  return (
    <span className="no-drag flex items-center">
      <Pop
        label={t("Layout")}
        open={open}
        onOpenChange={(next) => onMenu(next ? "layouts" : null)}
        side="bottom"
        className="w-72"
        render={
          // The name's column, like the meter's, shrinks to nothing where the bar is short of room,
          // leaving "Layout" and its arrow. The meter shrinks far faster, so this gives way second.
          <button
            disabled={!failed && layouts.length === 0}
            className={cn(
              "grid h-7.5 grid-cols-[auto_minmax(0,max-content)_auto] items-center gap-1.5 rounded-full px-2.5 text-[0.8125rem] leading-4 whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
              open && "bg-white/10",
            )}
          />
        }
        trigger={
          <>
            <span className="text-muted-foreground">{t("Layout")}</span>
            {/* A name may be up to 60 characters; the bar shows its start. */}
            <span className="max-w-32 truncate font-medium">{shown?.name ?? t("Not saved")}</span>
            <ChevronDown aria-hidden className="size-3.5 text-muted-foreground" />
          </>
        }
      >
        {failed ? (
          <>
            <MenuNote>{t("Couldn't load layouts")}</MenuNote>
            <button
              data-item
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void preferences.refetch()}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none hover:bg-white/6 focus-visible:bg-white/10"
            >
              <RotateCw className="size-4" />
              {t("Retry")}
            </button>
          </>
        ) : (
          layouts.map((layout) => (
            <Choice
              key={layout.name}
              chosen={layout === shown}
              note={t("{count} channels", { count: layout.channels.length })}
              onChoose={() => void choose(layout)}
            >
              {layout.name}
            </Choice>
          ))
        )}
      </Pop>
      <StreamMeter />
    </span>
  );
}

/** Accounts allowing more streams than this show the count in words only, without a bar each. */
const METER_BARS = 8;

/**
 * "2 of 4 streams" for the selected channel's account, as main counts them now. A read that
 * fails says so with Retry rather than keeping the last count, which may no longer be true.
 */
function StreamMeter() {
  const meter = useRef<HTMLSpanElement>(null);
  const retried = useRef<HTMLButtonElement>(null);
  const failure = useId();
  const channel = usePlayer((state) => state.channel);

  // Re-read after admission completes, not just when a pending slot appears.
  const panes = usePaneGroup((state) =>
    state.panes
      .map(
        (pane) =>
          `${pane.id}:${pane.state.channel ? ownedKey(pane.state.channel) : ""}:${pane.state.phase.kind}`,
      )
      .join("|"),
  );

  const read = useQuery(capacityQuery(channel, panes));
  useLayoutEffect(() => {
    const retry = retried.current;

    if (!retry || read.isFetching) return;

    retried.current = null;

    // Retry disappears after success. Keep its keyboard position on the refreshed count,
    // unless the viewer moved focus elsewhere while the read was pending.
    if (!read.isError && !retry.isConnected && document.activeElement === document.body)
      meter.current?.focus();
  });
  const subscription = useSubscriptions().find((each) => each.id === channel?.subscriptionId);

  // One line in the count's place. Where the bar is short of room the message gives way with the
  // layout's name, down to about a word: the room it keeps makes the bar fold the wordmark
  // (`WindowBar`) before the message would go. Retry is an icon, named for screen readers and
  // described by the whole message, which hovering the message also shows.
  if (read.isError)
    return (
      <span className="grid h-7.5 grid-cols-[minmax(4em,max-content)_auto] items-center gap-2 px-3 text-[0.8125rem] leading-4">
        <span
          id={failure}
          title={t("Couldn't check streams")}
          className="truncate text-muted-foreground"
        >
          {t("Couldn't check streams")}
        </span>
        <Button
          size="icon-sm"
          aria-label={t("Retry")}
          aria-describedby={failure}
          onClick={(event) => {
            retried.current =
              document.activeElement === event.currentTarget ? event.currentTarget : null;
            void read.refetch();
          }}
        >
          <RotateCw aria-hidden className="size-3.5" />
        </Button>
      </span>
    );

  const capacity = read.data;

  if (!capacity?.eligible) return null;

  // The count stays on one line. Where the bar is short of room, as at the minimum window with
  // enlarged text, the subscription's name gives way first: its column shrinks to nothing. Then
  // the layout's name does, and only then Back's room (`WindowBar`).
  return (
    <span
      ref={meter}
      tabIndex={-1}
      className="grid h-7.5 shrink-[1000] grid-cols-[auto_minmax(0,max-content)] items-center gap-2 px-3 text-[0.8125rem] leading-4"
    >
      <span className="flex items-center gap-2 whitespace-nowrap">
        {capacity.limit <= METER_BARS && (
          <span aria-hidden className="flex gap-0.75">
            {Array.from({ length: capacity.limit }, (_, index) => (
              <span
                key={index}
                className={cn(
                  "h-3.5 w-1.5 rounded-[2px]",
                  index < capacity.used ? "bg-foreground" : "bg-white/16",
                )}
              />
            ))}
          </span>
        )}
        <span className="font-medium">
          {t("{used} of {limit} streams", { used: capacity.used, limit: capacity.limit })}
        </span>
      </span>
      {subscription && (
        <span className="max-w-40 truncate text-xs text-muted-foreground">
          {subscriptionName(subscription)}
        </span>
      )}
    </span>
  );
}

/**
 * Save layout and its name popover. Saving replaces the layout of the same name or adds one; while
 * it saves, the old list stays and Save waits. Hidden while the layouts can't be read, since a
 * save then could drop the ones it didn't see.
 */
export function SaveLayout({ menu, onMenu }: MenuProps) {
  const client = useQueryClient();
  const { preferences, layouts, channels, shown } = useLayouts();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const attempt = useRef(0);
  const field = useRef<HTMLInputElement>(null);
  const open = menu === "save-layout";

  if (!preferences.data) return null;
  const typed = name.trim();
  const replaces = layouts.some((layout) => layout.name === typed);

  const save = async (event: FormEvent) => {
    event.preventDefault();

    if (!typed || saving || channels.length < 2) return;
    const mine = ++attempt.current;
    const layout = { name: typed, channels: [...channels] };

    const next = replaces
      ? layouts.map((each) => (each.name === typed ? layout : each))
      : [...layouts, layout];

    setSaving(true);

    try {
      await updatePreferences({ multiviewLayouts: next }, client, profileOwner());

      if (mine === attempt.current) onMenu(null);
    } catch {
      if (mine === attempt.current) flash(t("Couldn't save. Try again."));
    } finally {
      if (mine === attempt.current) setSaving(false);
    }
  };

  return (
    <Pop
      label={t("Save layout")}
      open={open}
      onOpenChange={(next) => {
        if (next) setName(shown?.name ?? "");
        onMenu(next ? "save-layout" : null);
      }}
      side="top"
      initialFocus={field}
      className="w-72 p-3"
      render={<Button size="sm" disabled={channels.length < 2} />}
      trigger={t("Save layout")}
    >
      <form onSubmit={(event) => void save(event)} className="flex flex-col gap-2">
        <label
          htmlFor="multiview-layout-name"
          className="text-[0.8125rem] leading-4 font-medium text-muted-foreground"
        >
          {t("Name")}
        </label>
        <div className="flex items-center gap-2">
          <input
            id="multiview-layout-name"
            ref={field}
            value={name}
            maxLength={60}
            onChange={(event) => setName(event.target.value)}
            className="h-8 min-w-0 flex-1 rounded-lg bg-white/8 px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-white/55"
          />
          <Button type="submit" variant="primary" size="sm" disabled={!typed || saving}>
            {t("Save")}
          </Button>
        </div>
        {replaces && (
          <p className="text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
            {t("Replaces the saved {name}", { name: typed })}
          </p>
        )}
      </form>
    </Pop>
  );
}
