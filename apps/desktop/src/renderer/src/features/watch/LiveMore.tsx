import { ChevronLeft, ChevronRight, Ellipsis } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, type ComponentProps } from "react";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { qualityName, shortQuality } from "../../lib/quality.ts";
import { outputs, receiverName, useOutput } from "../../player/output.ts";
import { MiniPlayerButton } from "./MiniPlayer.tsx";
import { Receivers } from "./Output.tsx";
import { PlaybackChoices } from "./PlaybackMenu.tsx";
import { QualityChoices } from "./QualityMenu.tsx";
import { Menu, SoundChoices, type TrackMenu } from "./TrackMenus.tsx";
import { VolumeControl } from "./VolumeControl.tsx";

export type LiveMenu = TrackMenu | "more";
const pages = ["sound", "quality", "playback", "output"] as const;
type Page = (typeof pages)[number];
const labels = { sound: "Sound", quality: "Quality", playback: "Playback", output: "Play on" };

/** Live TV's secondary controls, with every page anchored to the visible More button. */
export function LiveMore({
  menu,
  keyboardOpen = false,
  onMenu,
  previous,
  onSwitch,
  onPrevious,
  sound,
  quality,
  playback,
}: {
  menu: LiveMenu;
  keyboardOpen?: boolean;
  onMenu: (menu: LiveMenu) => void;
  previous: LiveChannel | null;
  onSwitch: (direction: -1 | 1) => void;
  onPrevious: () => void;
  sound: ComponentProps<typeof SoundChoices> | null;
  quality: ComponentProps<typeof QualityChoices> | null;
  playback: ComponentProps<typeof PlaybackChoices> | null;
}) {
  const offers = useOutput((state) => state.status.offers);
  const output = useOutput((state) => state.status.output);
  const active = output.kind === "receiver" || output.kind === "lost";
  const destination = active ? receiverName(output.receiver) : "This computer";
  const listed = offers.includes("cast");
  const available = {
    sound: sound !== null,
    quality: quality !== null,
    playback: playback !== null,
    output: offers.length > 0,
  };
  const opened = menu !== null && menu !== "subtitles";
  const page = menu && menu !== "more" && menu !== "subtitles" ? menu : null;
  const valid = page === null || available[page];
  const body = useRef<HTMLDivElement>(null);
  const left = useRef<Page | null>(null);
  const moved = useRef<"keyboard" | "pointer" | null>(null);

  const go = (next: Page | null, by: "keyboard" | "pointer") => {
    left.current = page;
    moved.current = by;
    onMenu(next ?? "more");
  };
  // Tracks and output capabilities can disappear while their page is open.
  useEffect(() => {
    if (!valid) {
      left.current = page;
      moved.current = "keyboard";
      onMenu("more");
    }
  }, [valid, page, onMenu]);
  useLayoutEffect(() => {
    const by = moved.current;
    moved.current = null;
    const root = body.current;
    if (by === "pointer") root?.focus();
    if (by !== "keyboard") return;
    const target =
      (page === null && left.current
        ? root?.querySelector<HTMLElement>(`[data-live-page="${left.current}"]`)
        : null) ??
      root?.querySelector<HTMLElement>("[data-item][aria-pressed=true]:not(:disabled)") ??
      root?.querySelector<HTMLElement>("[data-item]:not(:disabled):not([data-live-back])");
    (target ?? root)?.focus();
  }, [page]);
  // Discovery belongs to the Play on page, and ends on Back, Escape, a pick or view closure.
  useEffect(() => {
    if (page !== "output" || !listed) return;
    outputs.list(true);
    return () => outputs.list(false);
  }, [page, listed]);

  const shownQuality = quality
    ? (quality.playing ?? quality.chosen ?? quality.automatic)
    : undefined;
  const playingSound = sound
    ? (sound.audio.find((track) => track.id === sound.audioId) ??
      sound.audio.find((track) => track.default) ??
      sound.audio[0])
    : null;
  const values = {
    sound: playingSound?.label,
    quality: quality
      ? `${quality.chosen === null ? "Automatic · " : ""}${shortQuality(shownQuality) ?? qualityName(shownQuality)}`
      : undefined,
    playback: "timing, look",
    output: destination,
  };
  const keys = { sound: null, quality: "Q", playback: null, output: "O" };
  const done = () => onMenu(null);
  const action = (run: () => void) => {
    done();
    run();
  };
  return (
    // Apple's system picker measures this visible button even after the page closes.
    <span data-output="">
      <Menu
        label="More"
        on={active}
        description={active ? `Playing on ${destination}` : undefined}
        focusChosen={page !== null && keyboardOpen}
        open={opened}
        onOpenChange={(open) => onMenu(open ? "more" : null)}
        trigger={<Ellipsis />}
        onKeyDown={(event) => {
          if (event.defaultPrevented) return;
          const target = event.target instanceof HTMLElement ? event.target : null;
          const next = target?.dataset["livePage"];
          if ((event.key === "ArrowRight" || event.key === "Enter") && next && !page) {
            const selected = pages.find((each) => each === next);
            if (selected) go(selected, "keyboard");
          } else if ((event.key === "ArrowLeft" || event.key === "Backspace") && page) {
            go(null, "keyboard");
          } else return;
          event.preventDefault();
        }}
      >
        <div ref={body} tabIndex={-1} className="outline-none">
          {page && valid ? (
            <>
              <button
                data-item
                data-live-back
                aria-label="Back to More"
                className="mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left font-semibold outline-none hover:bg-white/6 focus-visible:bg-white/10"
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => go(null, event.detail === 0 ? "keyboard" : "pointer")}
              >
                <ChevronLeft className="size-4" />
                {labels[page]}
              </button>
              {page === "sound" && sound && <SoundChoices {...sound} />}
              {page === "quality" && quality && <QualityChoices {...quality} />}
              {page === "playback" && playback && <PlaybackChoices {...playback} />}
              {page === "output" && (
                <Receivers onDone={done} onSystemList={() => action(() => outputs.pick())} />
              )}
            </>
          ) : (
            <>
              {[
                { label: "Channel up", key: "Up", run: () => onSwitch(-1), disabled: false },
                { label: "Channel down", key: "Down", run: () => onSwitch(1), disabled: false },
                {
                  label: previous ? `Back to ${previous.title}` : "Previous channel",
                  key: "Backspace",
                  run: onPrevious,
                  disabled: !previous,
                },
              ].map((item) => (
                <button
                  key={item.key}
                  data-item
                  aria-label={item.label}
                  disabled={item.disabled}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none hover:bg-white/6 focus-visible:bg-white/10 disabled:opacity-40"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => action(item.run)}
                >
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  <span aria-hidden className="flex-none text-[0.8125rem] text-muted-foreground">
                    {item.key}
                  </span>
                </button>
              ))}
              <div role="separator" className="my-1 border-t border-white/12" />
              {pages.map(
                (each) =>
                  available[each] && (
                    <button
                      key={each}
                      data-item
                      data-live-page={each}
                      aria-label={labels[each]}
                      aria-description={values[each]}
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none hover:bg-white/6 focus-visible:bg-white/10"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={(event) => go(each, event.detail === 0 ? "keyboard" : "pointer")}
                    >
                      <span className="flex-none">{labels[each]}</span>
                      <span
                        aria-hidden
                        className="ml-auto min-w-0 truncate text-[0.8125rem] text-muted-foreground"
                      >
                        {values[each]}
                      </span>
                      <ChevronRight className="size-4 flex-none" />
                      {keys[each] && (
                        <span aria-hidden className="text-[0.8125rem] text-muted-foreground">
                          {keys[each]}
                        </span>
                      )}
                    </button>
                  ),
              )}
              <MiniPlayerButton inMenu onDone={done} />
              <div className="hidden px-2 py-1.5 max-[720px]:block">
                <VolumeControl />
              </div>
            </>
          )}
        </div>
      </Menu>
    </span>
  );
}
