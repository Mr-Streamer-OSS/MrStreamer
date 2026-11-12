// Picture and sound: sound delay, leveling, aspect, crop, zoom and Reset for everything playing on
// this computer (player/adjustments.ts). A title opens them from its bar's button, which is on
// while anything differs from the stream; Live TV from its More page. Up and Down go from row to
// row, Left and Right pick within a row.
//   Sound can only wait behind the picture, and leveling preserves the device's output channels. A
// choice that can't be saved plays the saved one again and offers Retry. While a receiver plays,
// the panel says it plays the stream as sent instead of offering choices.
import { SlidersHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import {
  PICTURE_RATIOS,
  PICTURE_ZOOM,
  SOUND_DELAY_MAX_MS,
  isAdjusted,
  type PlaybackAdjustments,
} from "@mrstreamer/contracts/preferences";
import { formatNumber, formatPercent, t } from "@mrstreamer/core/i18n";
import {
  adjustPlayback,
  resetPlayback,
  retryPlayback,
  useAdjustmentsRefusal,
  usePlaybackAdjustments,
} from "../../player/adjustments.ts";
import { Segments, Step, TextButton, type Segment } from "./menu-rows.tsx";
import { Menu, MenuNote } from "./TrackMenus.tsx";

/** One press of − or +. */
const SOUND_DELAY_STEP_MS = 50;
const ZOOM_STEP = 25;

const LEVELING = [
  { value: "off", short: "Leveling off", label: "Leveling off" },
  { value: "on", short: "Leveling on", label: "Leveling on" },
] as const satisfies readonly Segment<"off" | "on">[];

const RATIOS = PICTURE_RATIOS.map((ratio) => ({ value: ratio, short: ratio, label: ratio }));

const ASPECTS = [
  { value: "source", short: "Auto", label: "Automatic" },
  ...RATIOS,
] as const satisfies readonly Segment<PlaybackAdjustments["aspect"]>[];

const CROPS = [
  { value: "none", short: "Crop off", label: "Crop off" },
  ...RATIOS,
] as const satisfies readonly Segment<PlaybackAdjustments["crop"]>[];

/** Whether picture and sound differ from the stream, for the button or page that opens them. */
export const usePictureSoundAdjusted = () =>
  usePlaybackAdjustments((state) => isAdjusted(state.adjustments));

/** A title's button and menu. */
export function PictureSoundMenu({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Menu
      label={t("Picture and sound")}
      on={usePictureSoundAdjusted()}
      open={open}
      onOpenChange={onOpenChange}
      trigger={<SlidersHorizontal />}
    >
      <PictureSoundRows />
    </Menu>
  );
}

/** The menu's rows, also Live TV's More page. */
export function PictureSoundRows() {
  const adjustments = usePlaybackAdjustments((state) => state.adjustments);
  const failed = usePlaybackAdjustments((state) => state.failed);
  const refusal = useAdjustmentsRefusal();

  if (refusal)
    return (
      <>
        <p className="px-2 pt-1.5 pb-1">{refusal}</p>
        <MenuNote>{t("Picture and sound settings apply on this computer only.")}</MenuNote>
      </>
    );

  const adjust = (change: Partial<PlaybackAdjustments>) => void adjustPlayback(change);
  const { soundDelayMs, leveling, aspect, crop, zoom } = adjustments;

  return (
    <>
      <div className="px-2">
        <Stepper
          label={t("Sound delay")}
          value={t("{milliseconds} ms", { milliseconds: formatNumber(soundDelayMs) })}
        >
          <Step
            item={false}
            label={t("Sound sooner")}
            disabled={soundDelayMs <= 0}
            onClick={() =>
              adjust({ soundDelayMs: Math.max(0, soundDelayMs - SOUND_DELAY_STEP_MS) })
            }
          >
            −
          </Step>
          <Step
            item={false}
            label={t("Sound later")}
            disabled={soundDelayMs >= SOUND_DELAY_MAX_MS}
            onClick={() =>
              adjust({
                soundDelayMs: Math.min(SOUND_DELAY_MAX_MS, soundDelayMs + SOUND_DELAY_STEP_MS),
              })
            }
          >
            +
          </Step>
        </Stepper>
        <Segments
          label={t("Leveling")}
          options={LEVELING}
          value={leveling ? "on" : "off"}
          onPick={(value) => adjust({ leveling: value === "on" })}
        />
      </div>
      <MenuNote>{t("Sound can only play after the picture.")}</MenuNote>
      <div role="separator" className="my-1 border-t border-white/12" />
      <div className="px-2">
        <Segments
          label={t("Aspect")}
          options={ASPECTS}
          value={aspect}
          onPick={(value) => adjust({ aspect: value })}
        />
        <Segments
          label={t("Crop")}
          options={CROPS}
          value={crop}
          onPick={(value) => adjust({ crop: value })}
        />
        <Stepper label={t("Picture zoom")} value={formatPercent(zoom / 100)}>
          <Step
            item={false}
            label={t("Zoom Out")}
            disabled={zoom <= PICTURE_ZOOM.min}
            onClick={() => adjust({ zoom: Math.max(PICTURE_ZOOM.min, zoom - ZOOM_STEP) })}
          >
            −
          </Step>
          <Step
            item={false}
            label={t("Zoom In")}
            disabled={zoom >= PICTURE_ZOOM.max}
            onClick={() => adjust({ zoom: Math.min(PICTURE_ZOOM.max, zoom + ZOOM_STEP) })}
          >
            +
          </Step>
        </Stepper>
      </div>
      <div role="separator" className="my-1 border-t border-white/12" />
      <button
        data-item
        aria-disabled={!isAdjusted(adjustments)}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (isAdjusted(adjustments)) void resetPlayback();
        }}
        className="flex w-full items-center rounded-lg px-2 py-1.5 text-left text-foreground/80 outline-none enabled:hover:bg-white/6 focus-visible:bg-white/10 aria-disabled:opacity-40"
      >
        {t("Reset")}
      </button>
      {failed && (
        <div role="alert" className="px-2 pt-1.5 pb-1 text-[0.8125rem] leading-snug">
          <div className="flex items-baseline gap-3">
            <span className="flex-1 text-destructive">
              {failed.kind === "sound" ? t("Sound") : t("Couldn't save. Nothing changed.")}
            </span>
            <TextButton onClick={() => void retryPlayback()}>{t("Retry")}</TextButton>
          </div>
          <p className="text-destructive">{failed.message}</p>
        </div>
      )}
    </>
  );
}

/**
 * A setting stepped with − and +, with its value between them; the value is announced as it
 * changes. `children` are the two steps, − first.
 */
function Stepper({
  label,
  value,
  children: [less, more],
}: {
  label: string;
  value: string;
  children: readonly [ReactNode, ReactNode];
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex items-center gap-3 py-1"
      data-item
      tabIndex={0}
      onFocus={(event) => {
        if (event.target === event.currentTarget)
          event.currentTarget.querySelector<HTMLButtonElement>("button")?.focus();
      }}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>("button");
        buttons[event.key === "ArrowLeft" ? 0 : 1]?.focus();
      }}
    >
      <span className="flex-1">{label}</span>
      <div className="flex items-center gap-1">
        {less}
        <span aria-live="polite" className="w-16 text-center text-[0.8125rem] tabular-nums">
          {value}
        </span>
        {more}
      </div>
    </div>
  );
}
