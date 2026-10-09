// A downloaded text file is read once and kept as cues. Document styles stay out of the player;
// VTTCue owns the small WebVTT markup vocabulary, as it does for file subtitles.
import type { Cue } from "./webvtt.ts";
import { webvttReader } from "./webvtt.ts";
import { t } from "../i18n.ts";

export const SUBTITLE_TEXT_LIMIT = 10 * 1024 * 1024;

/** Reads UTF-8 SubRip or WebVTT, drops invalid cues and refuses empty or oversized files. */
export function subtitleTextFile(text: string): readonly Cue[] {
  if (text.length > SUBTITLE_TEXT_LIMIT) throw new Error(t("Subtitle file is too large."));
  const clean = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const vtt = /^WEBVTT(?:[ \t].*)?(?:\n|$)/.test(clean);
  const normalized = vtt
    ? clean
    : clean.replace(
        /^(\d{1,2}:\d{2}:\d{2}),(\d{3})(\s*-->\s*\d{1,2}:\d{2}:\d{2}),(\d{3})/gm,
        "$1.$2$3.$4",
      );
  const reader = webvttReader();
  const parsed = [...reader.push(normalized), ...reader.end()];
  if (parsed.length > 100000) throw new Error(t("Subtitle file has too many cues."));
  const cues = parsed.filter(
    ({ start, end, text }) => start >= 0 && end > start && end <= 86400 && text.length <= 32768,
  );
  if (cues.length === 0) throw new Error(t("Subtitle file has no supported, valid cues."));
  return cues;
}
