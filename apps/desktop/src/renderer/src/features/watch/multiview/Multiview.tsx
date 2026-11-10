// Multiview: up to four live channels in fixed slots, one of them selected. The selected pane has
// the sound, and Watch's controls, keys and system media controls act on it alone (`player`
// follows the selection). Each pane plays, rewinds, fails and closes on its own; closing the last
// one stops playback as Stop does, while Single view keeps the selected pane's stream and moment.
import { useQuery } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { paneStreamLimit } from "@mrstreamer/contracts/playback";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import { t } from "@mrstreamer/core/i18n";
import { Button } from "../../../components/ui/button.tsx";
import { queries, subscriptionName, useSubscriptions } from "../../../lib/queries.ts";
import { useOutput } from "../../../player/output.ts";
import { paneGroup, player, usePaneGroup, usePlayer, type PaneId } from "../../../player/player.ts";
import { MenuNote, TrackMenus, type TrackMenu } from "../TrackMenus.tsx";
import { SaveLayout } from "./LayoutMenu.tsx";
import { EmptySlot, Pane } from "./Pane.tsx";
import {
  behindLive,
  capacityQuery,
  closePane,
  refusalCopy,
  reportPaneFailure,
  SLOTS,
  useVanished,
  type MultiviewMenu,
} from "./state.ts";

export { MultiviewBar } from "./LayoutMenu.tsx";

export { isMultiviewMenu, type MultiviewMenu } from "./state.ts";

/** What the multiview adds to Watch's retained timeline: the selected pane's words and its actions. */
export interface TransportSlots {
  readonly label: ReactNode;
  readonly actions: ReactNode;
}

/**
 * The panes and their transport, in Watch's place below the bar. `channels` is Watch's channel
 * list, which the Add channel picker narrows to subscriptions allowing several streams;
 * `timeline` draws Watch's retained timeline, which follows the selected pane, around the
 * multiview's own label and actions. Without a timeline, they stand on their own row.
 */
export function Multiview({
  channels,
  timeline,
  menu,
  onMenu,
  style,
}: {
  channels: readonly LiveChannel[];
  timeline: (transport: TransportSlots) => ReactNode;
  menu: MultiviewMenu | TrackMenu | "more";
  onMenu: (menu: MultiviewMenu | TrackMenu) => void;
  style?: CSSProperties;
}) {
  const panes = usePaneGroup((state) => state.panes);
  const selected = usePaneGroup((state) => state.selected);
  const vanished = useVanished((state) => state.slots);
  const subscriptions = useSubscriptions();
  const [adding, setAdding] = useState<PaneId | null>(null);
  const [said, setSaid] = useState("");

  // What a saved layout couldn't fill belongs to this group only.
  useEffect(() => () => useVanished.setState({ slots: [] }), []);

  const several = useMemo(
    () =>
      new Set(
        subscriptions
          .filter((each) => paneStreamLimit(each.account.maxConnections) !== null)
          .map((each) => each.id),
      ),
    [subscriptions],
  );

  const addable = useMemo(
    () => channels.filter((channel) => several.has(channel.subscriptionId)),
    [channels, several],
  );

  const inView = new Set(
    panes.flatMap((pane) => (pane.state.channel ? [ownedKey(pane.state.channel)] : [])),
  );

  const provider = (channel: LiveChannel | null) => {
    const subscription = subscriptions.find((each) => each.id === channel?.subscriptionId);

    return subscription ? subscriptionName(subscription) : "";
  };

  const select = (id: PaneId, channel: LiveChannel) => {
    if (id === paneGroup.state().selected) return;
    paneGroup.select(id);
    setSaid(t("{channel} has sound", { channel: channel.title }));
  };

  return (
    // Buttons here take Enter themselves, as the controls of a failed channel do in single view.
    <div
      data-playback-state=""
      role="group"
      aria-label={t("Multiview")}
      style={style}
      className="no-drag absolute inset-x-0 bottom-0 z-10 flex flex-col"
    >
      <div className="grid min-h-0 flex-1 grid-cols-2 grid-rows-2 gap-1.5 px-3 pt-1 pb-2">
        {SLOTS.map((id) => {
          const pane = panes.find((each) => each.id === id);
          const channel = pane?.state.channel;

          return pane && channel ? (
            <Pane
              key={id}
              pane={pane}
              selected={selected === id}
              provider={provider(channel)}
              onSelect={() => select(id, channel)}
              onClose={() => closePane(id, channel)}
              onRetry={() => paneGroup.retry(id)}
            />
          ) : (
            <EmptySlot
              key={id}
              channels={addable}
              inView={inView}
              unavailable={vanished.includes(id)}
              open={menu === "add" && adding === id}
              onOpenChange={(open) => {
                setAdding(open ? id : null);
                onMenu(open ? "add" : null);
              }}
              onPick={(channel) => {
                onMenu(null);
                setAdding(null);
                useVanished.setState(({ slots }) => ({
                  slots: slots.filter((each) => each !== id),
                }));
                paneGroup.add(id, channel);
              }}
            />
          );
        })}
      </div>
      <Transport timeline={timeline} menu={menu} onMenu={onMenu} />
      <div role="status" className="sr-only">
        {said}
      </div>
    </div>
  );
}

/** The selected pane's programme and state, then Save layout, Single view and subtitles. */
function Transport({
  timeline,
  menu,
  onMenu,
}: {
  timeline: (transport: TransportSlots) => ReactNode;
  menu: MultiviewMenu | TrackMenu | "more";
  onMenu: (menu: MultiviewMenu | TrackMenu) => void;
}) {
  const channel = usePlayer((state) => state.channel);
  const paused = usePlayer((state) => state.paused);
  const live = usePlayer((state) => state.phase.kind === "playing");
  const retained = usePlayer((state) => state.timeline);
  const tracks = usePlayer((state) => state.tracks);
  const subtitle = usePlayer((state) => state.subtitle);
  const subtitleLoading = usePlayer((state) => state.subtitleLoading);
  const audioId = usePlayer((state) => state.audioId);
  const listing = useQuery(queries.listings(channel ? [channel] : [])).data;
  // A receiver ends the multiview; only this computer's subtitles are listed here.
  const local = useOutput((state) => state.status.output.kind === "local");

  if (!channel) return null;
  const status = !live ? null : paused ? t("Paused") : (behindLive(retained) ?? t("Live"));

  const single = () =>
    void paneGroup
      .single()
      .then(() => document.querySelector<HTMLElement>('[data-view="watch"]')?.focus())
      .catch((cause: unknown) =>
        reportPaneFailure(cause, (reason) =>
          reason === "stale" ? null : t("Couldn't return to single view. Try again."),
        ),
      );

  const label = (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="truncate text-sm leading-[1.125rem] font-semibold">
        {listing?.[ownedKey(channel)]?.now?.title ?? channel.title}
      </span>
      <span className="truncate text-xs leading-3.5 text-muted-foreground">
        {[channel.title, status].filter(Boolean).join(" · ")}
      </span>
    </div>
  );

  const actions = (
    <>
      <SaveLayout menu={menu === "save-layout" ? menu : null} onMenu={onMenu} />
      <Button size="sm" onClick={single}>
        {t("Single view")}
      </Button>
      {tracks && local && (
        <TrackMenus
          showSound={false}
          audio={tracks.audio}
          audioId={audioId ?? tracks.playing}
          subtitles={tracks.subtitles}
          subtitle={subtitle}
          subtitleNote={subtitleLoading ? t("Loading") : null}
          open={menu === "subtitles" ? menu : null}
          onOpenChange={onMenu}
          onAudio={(id) => player.setAudio(id)}
          onSubtitle={(track) => player.setSubtitle(track)}
        />
      )}
    </>
  );

  return retained ? (
    timeline({ label, actions })
  ) : (
    <div className="flex flex-none items-center gap-1.5 px-6 pt-2.5 pb-4.5 max-[720px]:px-4">
      {label}
      <span className="flex-1" />
      {actions}
    </div>
  );
}

/**
 * Live TV More's Multiview row: listed only while a local live channel plays from an account
 * that explicitly allows two or more streams. Picking it adopts the playing stream, at its
 * moment, as the selected first pane.
 */
export function MultiviewEntry({ onDone }: { onDone: () => void }) {
  const channel = usePlayer((state) =>
    state.phase.kind === "playing" && state.phase.engine !== "receiver" && !state.archive
      ? state.channel
      : null,
  );

  const grouped = usePaneGroup((state) => state.panes.length > 0);

  // Main is asked about the account only while there is a local live stream to adopt.
  return channel && !grouped ? <EligibleEntry channel={channel} onDone={onDone} /> : null;
}

/**
 * The row once main says the account allows several streams. A read that fails says so and offers
 * Retry in the row's place, so a failure is never taken for an account that doesn't qualify.
 */
function EligibleEntry({ channel, onDone }: { channel: LiveChannel; onDone: () => void }) {
  const subscriptions = useSubscriptions();
  const read = useQuery({ ...capacityQuery(channel), select: (each) => each.eligible });

  if (!read.isError && !read.data) return null;

  const enter = () => {
    onDone();
    void paneGroup.enter().catch((cause: unknown) =>
      reportPaneFailure(cause, (reason) => {
        const subscription = subscriptions.find((each) => each.id === channel.subscriptionId);
        const copy = refusalCopy(reason, subscription ? subscriptionName(subscription) : "");

        return reason === "stale" ? null : (copy.body ?? copy.title);
      }),
    );
  };

  return (
    <>
      <div role="separator" className="my-1 border-t border-white/12" />
      {read.isError && <MenuNote>{t("Couldn't check streams")}</MenuNote>}
      {/* One button either way, so focus stays on it when Retry turns into the entry. */}
      <button
        data-item
        onMouseDown={(event) => event.preventDefault()}
        onClick={read.isError ? () => void read.refetch() : enter}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none hover:bg-white/6 focus-visible:bg-white/10"
      >
        {read.isError ? (
          <>
            <RotateCw className="size-4" />
            {t("Retry")}
          </>
        ) : (
          t("Multiview")
        )}
      </button>
    </>
  );
}
