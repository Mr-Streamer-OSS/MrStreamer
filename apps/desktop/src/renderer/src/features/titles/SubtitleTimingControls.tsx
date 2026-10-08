// Downloaded text uses its original cue clock. Each edit is stored for this exact result and file.
import { useState } from "react";
import {
  DEFAULT_SUBTITLE_TIMING,
  type SubtitleTiming,
} from "@mrstreamer/contracts/online-subtitles";
import { Button } from "../../components/ui/button.tsx";
import { flash } from "../watch/Flash.tsx";
import { Input } from "../../components/ui/input.tsx";
import { titlePlayer, useTitlePlayer } from "../../player/title-player.ts";

const FPS = [23.976, 24, 25] as const;

// Keep an unfinished decimal, such as "-" or "0.", while the viewer types. Only valid
// values change playback; leaving the field restores the last accepted value. The field reads
// `digits` decimals at most: a preset's exact ratio stays stored until the viewer types another.
function TimingField({
  id,
  value,
  min,
  max,
  digits,
  onChange,
}: {
  id: string;
  value: number;
  min: number;
  max: number;
  digits: number;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = String(Number(value.toFixed(digits)));
  return (
    <Input
      id={id}
      inputMode="decimal"
      value={draft ?? shown}
      className="w-28"
      onFocus={() => setDraft(shown)}
      onBlur={() => setDraft(null)}
      onChange={(event) => {
        const text = event.currentTarget.value;
        setDraft(text);
        const number = Number(text);
        if (text.trim() && Number.isFinite(number) && number >= min && number <= max)
          onChange(number);
      }}
    />
  );
}

/**
 * The page's buttons are the Playback menu's items (`data-item`) in reading order, so its keys
 * walk them and a page opened by the keyboard starts on the first offset step, never on a drift
 * preset below it. The two fields are reached with Tab and keep their own edit keys.
 */
export function SubtitleTimingControls() {
  const timing = useTitlePlayer((state) => state.savedSubtitle?.timing ?? DEFAULT_SUBTITLE_TIMING);
  const [error, setError] = useState<string | null>(null);
  const change = (next: SubtitleTiming) => {
    setError(null);
    flash(
      next.speed !== timing.speed
        ? `Subtitle drift ${next.speed.toFixed(5)}×`
        : `Subtitle offset ${next.offset > 0 ? "+" : ""}${next.offset.toFixed(1)} s`,
    );
    void titlePlayer.setDownloadedTiming(next).catch(() => setError("Timing could not be saved."));
  };
  const shift = (step: number) =>
    change({
      ...timing,
      offset: Math.round(Math.max(-600, Math.min(600, timing.offset + step)) * 10) / 10,
    });
  return (
    <div className="space-y-3 py-2 text-sm">
      <div className="flex items-center gap-3">
        <label htmlFor="subtitle-offset" className="flex-1">
          Offset, seconds
        </label>
        <TimingField
          id="subtitle-offset"
          min={-600}
          max={600}
          digits={3}
          value={timing.offset}
          onChange={(offset) => change({ ...timing, offset })}
        />
      </div>
      <div className="flex gap-2">
        {[-1, -0.1, 0.1, 1].map((step) => (
          <Button key={step} data-item size="sm" variant="secondary" onClick={() => shift(step)}>
            {step > 0 ? "+" : ""}
            {step} s
          </Button>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <label htmlFor="subtitle-speed" className="flex-1">
          Drift ratio
        </label>
        <TimingField
          id="subtitle-speed"
          min={0.9}
          max={1.1}
          digits={5}
          value={timing.speed}
          onChange={(speed) => change({ ...timing, speed })}
        />
      </div>
      <div className="grid grid-cols-2 gap-1" aria-label="Subtitle FPS to video FPS">
        {FPS.flatMap((subtitleFps) =>
          FPS.filter((videoFps) => subtitleFps !== videoFps).map((videoFps) => (
            <button
              key={`${subtitleFps}:${videoFps}`}
              data-item
              className="px-2 py-1 text-left hover:bg-white/8 focus-visible:outline-white"
              onClick={() => change({ ...timing, speed: subtitleFps / videoFps })}
            >
              {subtitleFps} → {videoFps} fps
            </button>
          )),
        )}
      </div>
      <Button
        data-item
        size="sm"
        variant="secondary"
        onClick={() => change(DEFAULT_SUBTITLE_TIMING)}
      >
        Reset timing
      </Button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
