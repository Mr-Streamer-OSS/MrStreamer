// How far this viewer got in a recording, in the words Home's Continue watching and History both
// show, so the two never say it differently.
import type { Recording } from "@mrstreamer/contracts/recordings";
import { formatDate, t } from "@mrstreamer/core/i18n";
import { timeLeftOf } from "../../lib/titles.ts";
import {
  isLive,
  outcome,
  placeText,
  settledPlace,
  type RecordingPlace,
} from "../recordings/recordings.ts";

/**
 * A recording's line: that it records, with where this viewer is; or its day, how it ended and
 * the time left; or that its file is gone. `done` is how far through, where the place was saved
 * against the length the recording ended with, else null: one saved while it recorded says
 * nothing of what is left.
 */
export function recordingLine(
  recording: Recording,
  place: RecordingPlace,
  now: number,
): { readonly line: string; readonly done: number | null; readonly gone: boolean } {
  const gone = recording.status.kind === "missing";
  const day = formatDate(recording.start, "weekdayDay");

  const line = gone
    ? [day, t("No longer there")].join(" · ")
    : isLive(recording)
      ? [outcome(recording, now).word, placeText(recording, place)].filter(Boolean).join(" · ")
      : [
          day,
          outcome(recording, now).word,
          (settledPlace(recording, place) &&
            place.duration > 0 &&
            timeLeftOf({ ...place, finished: false })) ||
            placeText(recording, place),
        ]
          .filter(Boolean)
          .join(" · ");

  const done =
    settledPlace(recording, place) && !gone && place.duration > 0
      ? Math.min(1, place.position / place.duration)
      : null;

  return { line, done, gone };
}
