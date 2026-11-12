// The subtitles' timing and look, set under CC wherever something plays: rows of the CC menu on
// Live TV, sections of the title's CC panel. Timing is for text subtitles, teletext and captions;
// the look for any subtitles, those drawn as pictures (PGS, DVD, DVB) taking only size and
// position. The player keeps both, so they hold after a seek or another track, and changing them
// never turns subtitles on or picks another track.
//   On the look's rows, Left and Right pick. Shared row controls live in menu-rows.tsx.
import { Step, Segments, TextButton } from "./menu-rows.tsx";
import type { SubtitleTrack } from "@mrstreamer/contracts/playback";
import type { SubtitleLook } from "@mrstreamer/contracts/preferences";
import { formatDecimal, t } from "@mrstreamer/core/i18n";
import { updateSubtitleLook } from "../../player/subtitle-look.ts";
import { appError, describeError } from "../../lib/errors.ts";
import { player, usePlayerVideo } from "../../player/player.ts";
import {
  setSubtitleDelay,
  subtitleDelay,
  TIMING_STEP_S,
  useSubtitleSettings,
} from "../../player/subtitles.ts";
import { flash, flashNote } from "./Flash.tsx";

import { SUBTITLE_SIZES, SUBTITLE_BACKGROUNDS, SUBTITLE_POSITIONS } from "./subtitle-choices.ts";

/** Subtitles drawn as text, which take timing and every look setting. */
const isText = (track: SubtitleTrack) => track.format !== "picture";

/** G and H: text subtitles a tenth of a second earlier or later. Pictures and Off have no timing. */
export function nudgeSubtitles(subtitle: SubtitleTrack | null, direction: -1 | 1): void {
  if (!subtitle || !isText(subtitle)) return;
  const video = player.element;
  setSubtitleDelay(video, subtitleDelay(video) + direction * TIMING_STEP_S);
  const delay = subtitleDelay(video);
  flash(
    delay === 0
      ? t("Subtitles on time")
      : delay > 0
        ? t("Subtitles {seconds} s later", { seconds: formatDecimal(Math.abs(delay), 1) })
        : t("Subtitles {seconds} s earlier", { seconds: formatDecimal(Math.abs(delay), 1) }),
  );
}

/**
 * Which of the settings these subtitles take: timing while text shows, the look once there are
 * subtitles to draw, and its background while text shows, or could. A downloaded result is text.
 */
export function subtitleSettingsFor(
  subtitles: readonly SubtitleTrack[],
  subtitle: SubtitleTrack | null,
  downloaded = false,
) {
  return {
    timing: downloaded || (subtitle !== null && isText(subtitle)),
    look: downloaded || subtitles.length > 0,
    // The text settings count while text shows, or could: picture subtitles have their own.
    text: downloaded || (subtitle ? isText(subtitle) : subtitles.some(isText)),
  };
}

/** The CC menu's rows under its tracks: timing for the text that shows, and the look. */
export function SubtitleSettingRows({
  subtitles,
  subtitle,
}: {
  subtitles: readonly SubtitleTrack[];
  subtitle: SubtitleTrack | null;
}) {
  const { timing, look, text } = subtitleSettingsFor(subtitles, subtitle);

  if (!timing && !look) return null;

  return (
    <>
      <div role="separator" className="my-1 border-t border-white/12" />
      <div className="px-2">
        {timing && (
          <div className="flex items-center gap-3 py-1">
            <span className="flex-1">{t("Timing")}</span>
            <TrackTiming />
          </div>
        )}
        {look && <LookRows text={text} />}
      </div>
    </>
  );
}

/** A file's or channel's text a tenth of a second earlier or later, and back on time. */
export function TrackTiming() {
  const video = usePlayerVideo();
  const delay = useSubtitleSettings((state) => state.delay, video);

  return (
    <div className="flex items-center gap-1">
      <Step label={t("Earlier")} onClick={() => setSubtitleDelay(video, delay - TIMING_STEP_S)}>
        −
      </Step>
      <span className="w-12 text-center text-[0.8125rem] tabular-nums">{delayLabel(delay)}</span>
      <Step label={t("Later")} onClick={() => setSubtitleDelay(video, delay + TIMING_STEP_S)}>
        +
      </Step>
      <TextButton disabled={delay === 0} onClick={() => setSubtitleDelay(video, 0)}>
        {t("Reset")}
      </TextButton>
    </div>
  );
}

/** Size, background and position, saved for every title and channel. */
export function LookRows({ text }: { text: boolean }) {
  const look = useSubtitleSettings((state) => state.look);

  const pick = (patch: Partial<SubtitleLook>) => {
    void updateSubtitleLook(patch, {
      onError: (error) =>
        flashNote(`${t("Subtitle look")}: ${describeError(appError(error))}`, true),
    }).catch(() => {});
  };

  return (
    <>
      <Segments
        label={t("Size")}
        options={SUBTITLE_SIZES}
        value={look.size}
        onPick={(size) => pick({ size })}
      />
      {text && (
        <Segments
          label={t("Background")}
          options={SUBTITLE_BACKGROUNDS}
          value={look.background}
          onPick={(background) => pick({ background })}
        />
      )}
      <Segments
        label={t("Position")}
        options={SUBTITLE_POSITIONS}
        value={look.position}
        onPick={(position) => pick({ position })}
      />
    </>
  );
}

/** "0.0 s", "+0.3 s" for later, "−0.2 s" for earlier. */
export function delayLabel(delay: number): string {
  const sign = delay > 0 ? "+" : delay < 0 ? "−" : "";

  return t("{seconds} s", { seconds: `${sign}${formatDecimal(Math.abs(delay), 1)}` });
}
