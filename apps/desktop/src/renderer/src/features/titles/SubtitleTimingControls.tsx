// The CC panel's Timing section. A file's own track moves in tenths until the title closes.
// Downloaded text uses its original cue clock: each edit is stored for this exact result and file.
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import {
  DEFAULT_SUBTITLE_TIMING,
  type SubtitleTiming,
} from "@mrstreamer/contracts/online-subtitles";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { cn } from "../../lib/utils.ts";
import { titlePlayer, useTitlePlayer } from "../../player/title-player.ts";
import { delayLabel, TextButton, TrackTiming } from "../watch/SubtitleSettings.tsx";
import { PanelSection } from "./PanelSection.tsx";

const FPS = [23.976, 24, 25] as const;

// Keep an unfinished decimal, such as "-" or "0.", while the viewer types. Only valid
// values change playback; leaving the field restores the last accepted value. The field reads
// `digits` decimals at most: a preset's exact ratio stays stored until the viewer types another.
function TimingField({
  id,
  label,
  className,
  value,
  min,
  max,
  digits,
  onChange,
}: {
  id: string;
  /** What the field sets, where no words stand beside it. */
  label?: string;
  className: string;
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
      aria-label={label}
      inputMode="decimal"
      value={draft ?? shown}
      className={cn("h-8 rounded-lg px-2 text-center text-[0.8125rem]", className)}
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
 * The section for what shows: the file track's delay on one row, or a downloaded result's offset
 * steps around its typed field, with drift and the frame-rate conversions one row down. Its
 * buttons are the panel's items (`data-item`) in reading order, so Up and Down walk them; the two
 * fields are reached with Tab and keep their own edit keys.
 */
export function SubtitleTimingSection({ downloaded }: { downloaded: boolean }) {
  return downloaded ? (
    <DownloadedTiming />
  ) : (
    <PanelSection title="Timing" aside={<TrackTiming />} />
  );
}

function DownloadedTiming() {
  const timing = useTitlePlayer((state) => state.savedSubtitle?.timing ?? DEFAULT_SUBTITLE_TIMING);
  const [drift, setDrift] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // No note over the picture as G and H leave: the section shows the offset and the drift itself.
  const change = (next: SubtitleTiming) => {
    setError(null);
    void titlePlayer.setDownloadedTiming(next).catch(() => setError("Timing could not be saved."));
  };
  // A button beside a field that is being typed in: the field lets go, so it reads what the
  // button set and not the text typed before.
  const press = (next: SubtitleTiming) => {
    if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur();
    change(next);
  };
  const step = (by: number) => (
    <Button
      key={by}
      data-item
      size="sm"
      variant="secondary"
      className="px-2.5"
      onClick={() =>
        press({
          ...timing,
          offset: Math.round(Math.max(-600, Math.min(600, timing.offset + by)) * 10) / 10,
        })
      }
    >
      {by > 0 ? "+" : ""}
      {by} s
    </Button>
  );
  return (
    <PanelSection
      title="Timing"
      aside={
        <>
          <span className="text-[0.8125rem] tabular-nums">{delayLabel(timing.offset)}</span>
          <TextButton onClick={() => press(DEFAULT_SUBTITLE_TIMING)}>Reset</TextButton>
        </>
      }
    >
      <div className="flex items-center gap-1.5">
        {[-1, -0.1].map(step)}
        <TimingField
          id="subtitle-offset"
          label="Offset, seconds"
          className="min-w-12 flex-1"
          min={-600}
          max={600}
          digits={3}
          value={timing.offset}
          onChange={(offset) => change({ ...timing, offset })}
        />
        {[0.1, 1].map(step)}
      </div>
      <button
        data-item
        aria-expanded={drift}
        className="mt-1 flex w-full items-center gap-2 rounded-lg py-1.5 text-left outline-none hover:bg-white/6 focus-visible:bg-white/10"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setDrift(!drift)}
      >
        <span className="flex-1">Drift and frame rate</span>
        <span className="text-[0.8125rem] tabular-nums">{timing.speed.toFixed(5)}</span>
        <ChevronRight className={cn("size-4 flex-none", drift && "rotate-90")} />
      </button>
      {drift && (
        <>
          <div className="flex items-center gap-3 py-1">
            <label htmlFor="subtitle-speed" className="flex-1">
              Drift ratio
            </label>
            <TimingField
              id="subtitle-speed"
              className="w-24"
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
                  className="rounded-lg px-2 py-1 text-left outline-none hover:bg-white/8 focus-visible:bg-white/10"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => press({ ...timing, speed: subtitleFps / videoFps })}
                >
                  {subtitleFps} → {videoFps} fps
                </button>
              )),
            )}
          </div>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </PanelSection>
  );
}
