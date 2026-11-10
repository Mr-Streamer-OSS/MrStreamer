// One slot of the multiview: a pane with its own picture, or an empty slot that adds a channel.
// A pane is a Tab stop of its own; click, Enter or Space selects it, which gives it the sound and
// Watch's controls. Its close button shows on hover and focus, and is the next Tab stop.
import { useQuery } from "@tanstack/react-query";
import { Pause, Plus, RotateCw, Search, Volume2, VolumeX, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import { t } from "@mrstreamer/core/i18n";
import { ChannelLogo } from "../../../components/ChannelLogo.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { queries } from "../../../lib/queries.ts";
import { cn } from "../../../lib/utils.ts";
import { Picture } from "../../../player/Picture.tsx";
import type { LivePane } from "../../../player/player.ts";
import { canRetry, failureCopy, reconnectingCopy, triedStreams } from "../problems.ts";
import { MenuNote } from "../TrackMenus.tsx";
import { Pop } from "./Pop.tsx";
import { behindLive, refusalCopy } from "./state.ts";

/** Picker rows shown at once; the search narrows the rest. */
const PICKER_ROWS = 60;

const chip = "flex h-6 items-center gap-1.5 rounded-xl bg-black/60 px-2 text-xs font-semibold";

export function Pane({
  pane,
  selected,
  provider,
  onSelect,
  onClose,
  onRetry,
}: {
  pane: LivePane;
  selected: boolean;
  /** The pane's account, for a refusal's words. */
  provider: string;
  onSelect: () => void;
  onClose: () => void;
  onRetry: () => void;
}) {
  const { state, video } = pane;
  const channel = state.channel;
  const listing = useQuery(queries.listings(channel ? [channel] : [])).data;

  if (!channel) return null;
  const programme = listing?.[ownedKey(channel)]?.now?.title ?? null;
  const { phase } = state;

  const close = (
    <button
      aria-label={t("Close {channel}", { channel: channel.title })}
      onClick={onClose}
      className="pointer-events-auto grid size-6 flex-none place-items-center rounded-xl bg-black/60 opacity-0 outline-none group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:ring-2 focus-visible:ring-white/55"
    >
      <X className="size-3.5" />
    </button>
  );

  // Refused before it ever played: the slot says why, and holds nothing else.
  if (state.paneRefusal && phase.kind === "failed") {
    const copy = refusalCopy(state.paneRefusal, provider);

    return (
      <div
        role="group"
        aria-label={channel.title}
        className="group relative flex min-h-0 min-w-0 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-white/16"
      >
        <div className="absolute top-3 right-3.5">{close}</div>
        <p className="text-[0.9375rem] leading-5 font-semibold">{copy.title}</p>
        {copy.body && (
          <p className="flex items-center gap-1.5 text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
            <span className="size-1.75 flex-none rounded-full bg-destructive" />
            {copy.body}
          </p>
        )}
      </div>
    );
  }

  const trouble =
    phase.kind === "reconnecting"
      ? reconnectingCopy(channel)
      : phase.kind === "failed"
        ? failureCopy(phase, channel, {
            chosen: null,
            source: null,
            tried: triedStreams(channel, state.stream),
          })
        : null;

  const behind = behindLive(state.timeline);
  const sound = selected && state.audible && !state.muted;

  return (
    <div
      role="group"
      aria-label={channel.title}
      aria-current={selected || undefined}
      className="group relative min-h-0 min-w-0 overflow-hidden rounded-md bg-muted has-[[data-select]:focus-visible]:shadow-[0_0_0_2px_#000,0_0_0_4px_rgb(255_255_255/0.55)]"
    >
      <Picture active fit="contain" video={video} className="absolute inset-0" />
      <button
        data-select
        aria-label={channel.title}
        onClick={onSelect}
        className="absolute inset-0 outline-none"
      />
      <div className="pointer-events-none absolute inset-0 flex flex-col justify-between px-3.5 py-3">
        <div className="flex items-center gap-2 text-[0.8125rem] leading-4">
          <ChannelLogo channel={channel} className="h-5 w-6.5 rounded-sm text-[0.5625rem]" />
          <span className="min-w-0 flex-none truncate font-semibold">{channel.title}</span>
          {programme && <span className="min-w-0 truncate text-[#D0D0D0]">{programme}</span>}
          <span className="flex-1" />
          {sound ? (
            <span className={cn(chip, "font-medium")}>
              <Volume2 className="size-3.5" />
              {t("Sound")}
            </span>
          ) : (
            <VolumeX aria-hidden className="size-4 flex-none text-muted-foreground" />
          )}
          {close}
        </div>
        {trouble ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 pb-5 text-center">
            <p className="text-[0.9375rem] leading-5 font-semibold">{trouble.title}</p>
            <p className="text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
              {trouble.body}
            </p>
            {phase.kind === "reconnecting" && (
              <p className="flex items-center gap-2 text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
                <span aria-hidden className="flex gap-1">
                  {Array.from({ length: phase.of }, (_, index) => (
                    <span
                      key={index}
                      className={cn(
                        "size-1.5 rounded-full",
                        index < phase.attempt ? "bg-white" : "bg-white/25",
                      )}
                    />
                  ))}
                </span>
                {t("attempt {attempt} of {of}", { attempt: phase.attempt, of: phase.of })}
              </p>
            )}
            {phase.kind === "failed" && canRetry(phase.problem) && (
              <Button size="sm" className="pointer-events-auto mt-1" onClick={onRetry}>
                <RotateCw className="size-3.5" />
                {t("Retry")}
              </Button>
            )}
          </div>
        ) : (
          phase.kind === "playing" && (
            <div className="flex items-center gap-2 leading-3.5">
              {state.paused ? (
                <span className={chip}>
                  <Pause className="size-3 fill-current" />
                  {t("Paused")}
                </span>
              ) : behind ? (
                <span className={chip}>{behind}</span>
              ) : (
                <span className="flex items-center gap-1.5 text-xs font-semibold">
                  <span className="size-1.75 rounded-full bg-foreground" />
                  {t("Live")}
                </span>
              )}
            </div>
          )
        )}
      </div>
      {selected && (
        <div className="pointer-events-none absolute inset-0 rounded-md outline-2 -outline-offset-2 outline-white/70" />
      )}
    </div>
  );
}

/**
 * A slot without a pane: one Add channel button, whose picker lists the channels it can hold.
 * `unavailable` marks a slot a saved layout couldn't fill; it never says which channel that was.
 */
export function EmptySlot({
  channels,
  inView,
  unavailable,
  open,
  onOpenChange,
  onPick,
}: {
  /** Channels of subscriptions that allow several streams, as Watch's list has them. */
  channels: readonly LiveChannel[];
  /** Keys of the channels already in a pane. */
  inView: ReadonlySet<string>;
  unavailable: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (channel: LiveChannel) => void;
}) {
  const search = useRef<HTMLInputElement>(null);
  const [words, setWords] = useState("");

  const shown = useMemo(() => {
    const wanted = words.trim().toLocaleLowerCase();

    return channels
      .filter((channel) => !wanted || channel.title.toLocaleLowerCase().includes(wanted))
      .slice(0, PICKER_ROWS);
  }, [channels, words]);

  const listing = useQuery({ ...queries.listings(shown), enabled: open && shown.length > 0 }).data;

  return (
    <div className="flex min-h-0 min-w-0 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-white/16">
      {unavailable && (
        <p className="text-[0.9375rem] leading-5 font-semibold">{t("Unavailable")}</p>
      )}
      <Pop
        label={t("Add channel")}
        open={open}
        onOpenChange={(next) => {
          if (!next) setWords("");
          onOpenChange(next);
        }}
        side="bottom"
        align="center"
        initialFocus={search}
        className="flex max-h-[60vh] w-90 flex-col gap-1 overflow-y-auto"
        onKeyDown={(event) => {
          if (event.target !== search.current || event.key !== "ArrowDown") return;
          event.preventDefault();
          event.currentTarget.querySelector<HTMLElement>("[data-item]:not(:disabled)")?.focus();
        }}
        render={<Button size="sm" />}
        trigger={
          <>
            <Plus className="size-3.5" />
            {t("Add channel")}
          </>
        }
      >
        <label className="flex h-8 flex-none items-center gap-2 rounded-lg bg-white/8 px-3 focus-within:ring-2 focus-within:ring-white/55">
          <Search aria-hidden className="size-3.5 flex-none text-muted-foreground" />
          <input
            ref={search}
            value={words}
            aria-label={t("Search channels")}
            placeholder={t("Search channels")}
            onChange={(event) => setWords(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
          />
        </label>
        {shown.map((channel) => {
          const key = ownedKey(channel);
          const taken = inView.has(key);

          return (
            <button
              key={key}
              data-item
              disabled={taken}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onPick(channel)}
              className="flex h-13 flex-none items-center gap-3 rounded-lg px-2 text-left outline-none hover:bg-white/6 focus-visible:bg-white/10 disabled:opacity-40"
            >
              <span className="w-7 flex-none text-right text-xs text-muted-foreground tabular-nums">
                {channel.number}
              </span>
              <ChannelLogo channel={channel} />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate leading-5">{channel.title}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {listing?.[key]?.now?.title}
                </span>
              </span>
              {taken && (
                <span className="flex-none text-[0.8125rem] text-muted-foreground">
                  {t("In view")}
                </span>
              )}
            </button>
          );
        })}
        <MenuNote>{t("Only subscriptions that allow several streams")}</MenuNote>
      </Pop>
    </div>
  );
}
