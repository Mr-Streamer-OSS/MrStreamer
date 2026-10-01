// Sound and subtitle tracks as the viewer chooses them: named in their own language ("Deutsch",
// "Nederlands"), with what sets them apart, and which ones play unless the viewer picks.
import type {
  AudioTrack,
  ChannelTracks,
  SubtitleFormat,
  SubtitleTrack,
} from "@mrstreamer/contracts/playback";

/**
 * ISO 639-2 bibliographic codes, as files often carry them, and the codes Intl knows them by.
 * Every other code Intl reads as it is.
 */
// prettier-ignore
const BIBLIOGRAPHIC: Readonly<Record<string, string>> = {
  alb: "sq", arm: "hy", baq: "eu", bur: "my", chi: "zh", cze: "cs", dut: "nl", fre: "fr",
  geo: "ka", ger: "de", gre: "el", ice: "is", mac: "mk", mao: "mi", may: "ms", per: "fa",
  rum: "ro", slo: "sk", tib: "bo", wel: "cy",
};

/** Codes that name no language. */
const UNKNOWN = new Set(["und", "unk", "mis", "mul", "zxx", "qaa"]);

/** The code Intl and the viewer's remembered choice use: "ger" and "deu" both give "de". */
export function languageCode(code: string | null | undefined): string | null {
  const lower = code?.trim().toLowerCase();
  if (!lower || UNKNOWN.has(lower)) return null;
  const mapped = BIBLIOGRAPHIC[lower] ?? lower;
  try {
    return Intl.getCanonicalLocales(mapped)[0]?.split("-")[0] ?? null;
  } catch {
    return null;
  }
}

/** "Nederlands" for "dut", "English" for "eng"; null when the code names no known language. */
export function languageName(code: string | null | undefined): string | null {
  const canonical = languageCode(code);
  if (!canonical) return null;
  try {
    const name = new Intl.DisplayNames([canonical], { type: "language" }).of(canonical);
    if (!name || name.toLowerCase() === canonical) return null;
    return name.charAt(0).toLocaleUpperCase(canonical) + name.slice(1);
  } catch {
    return null;
  }
}

/** What a probe knows about a track, before it has a label. */
export interface TrackFacts {
  readonly id: number;
  readonly language: string | null;
  /** The file's own name for the track: "English [Forced]", "Commentary". */
  readonly name: string | null;
  readonly default: boolean;
}

export interface AudioFacts extends TrackFacts {
  readonly channels: number | null;
  /** Describes the picture for viewers who can't see it. */
  readonly description: boolean;
}

export interface SubtitleFacts extends TrackFacts {
  /** A teletext page, DVB subtitle page or caption channel within the track; null for one. */
  readonly page: number | null;
  readonly format: SubtitleFormat;
  readonly forced: boolean;
  readonly hearingImpaired: boolean;
}

/** "English · 5.1", "Español · Stereo · Commentary". */
export function audioTracks(tracks: readonly AudioFacts[]): AudioTrack[] {
  const labelled = tracks.map((track) => {
    const parts = [languageName(track.language) ?? "Sound", layout(track.channels)];
    if (track.name && /comment/i.test(track.name)) parts.push("Commentary");
    else if (track.description || (track.name && /descri/i.test(track.name))) {
      parts.push("Audio description");
    }
    return { track, label: parts.filter(Boolean).join(" · ") };
  });
  return distinct(labelled).map(({ track, label }) => ({
    id: track.id,
    language: languageCode(track.language),
    label,
    default: track.default,
  }));
}

/** "Nederlands", "English · SDH", "Deutsch · Forced", "Captions". */
export function subtitleTracks(tracks: readonly SubtitleFacts[]): SubtitleTrack[] {
  const labelled = tracks.map((track) => {
    const parts = [
      languageName(track.language) ?? (track.format === "captions" ? "Captions" : "Subtitles"),
    ];
    if (track.forced || (track.name && /forced/i.test(track.name))) parts.push("Forced");
    if (track.hearingImpaired || (track.name && /\b(sdh|cc)\b|hearing/i.test(track.name))) {
      parts.push("SDH");
    }
    return { track, label: parts.join(" · ") };
  });
  // Tracks that read the same in different formats, as a channel's teletext and DVB subtitles in
  // one language, are told apart by format before anything else.
  const told = labelled.map(({ track, label }) => {
    const twins = labelled.filter((other) => other.label === label);
    return twins.some((other) => other.track.format !== track.format)
      ? { track, label: `${label} · ${FORMAT_NAMES[track.format]}` }
      : { track, label };
  });
  return distinct(told).map(({ track, label }) => ({
    id: track.id,
    page: track.page,
    format: track.format,
    language: languageCode(track.language),
    label,
    forced: track.forced || (track.name !== null && /forced/i.test(track.name)),
    default: track.default,
  }));
}

const FORMAT_NAMES: Record<SubtitleFormat, string> = {
  text: "Text",
  picture: "Picture",
  teletext: "Teletext",
  captions: "Captions",
};

/**
 * Tracks that would read the same get the file's own name after them, or a number when it has
 * none: "Español · 5.1 · Latin American", "Español · 5.1 · 2".
 */
function distinct<T extends TrackFacts>(
  labelled: readonly { track: T; label: string }[],
): { track: T; label: string }[] {
  const counts = new Map<string, number>();
  for (const { label } of labelled) counts.set(label, (counts.get(label) ?? 0) + 1);
  const seen = new Map<string, number>();
  return labelled.map(({ track, label }) => {
    if ((counts.get(label) ?? 0) < 2) return { track, label };
    const index = (seen.get(label) ?? 0) + 1;
    seen.set(label, index);
    const name = track.name?.trim();
    return { track, label: `${label} · ${name && !label.includes(name) ? name : index}` };
  });
}

function layout(channels: number | null): string | null {
  switch (channels) {
    case null:
      return null;
    case 1:
      return "Mono";
    case 2:
      return "Stereo";
    case 6:
      return "5.1";
    case 8:
      return "7.1";
    default:
      return `${channels} channels`;
  }
}

/** The languages the viewer chose last time, or null for none remembered. */
export interface TrackChoice {
  readonly audioLanguage: string | null;
  /** A language, "off" when the viewer turned subtitles off, or null when never chosen. */
  readonly subtitleLanguage: string | null;
}

/**
 * The tracks to start with: the remembered sound language when the title has it, else the
 * file's default sound. Subtitles in the remembered language; else only subtitles the file marks
 * as forced for the sound's language, which translate signs and foreign lines. Only subtitles in
 * `formats`, the ones the player shows, are chosen.
 */
export function chooseTracks(
  audio: readonly AudioTrack[],
  subtitles: readonly SubtitleTrack[],
  choice: TrackChoice,
  formats: ReadonlySet<SubtitleFormat>,
): { readonly audio: number | null; readonly subtitle: SubtitleTrack | null } {
  const sound =
    audio.find((track) => choice.audioLanguage && track.language === choice.audioLanguage) ??
    audio.find((track) => track.default) ??
    audio[0] ??
    null;
  const shown = subtitles.filter((track) => formats.has(track.format));
  const wanted =
    choice.subtitleLanguage && choice.subtitleLanguage !== "off"
      ? shown.find((track) => track.language === choice.subtitleLanguage && !track.forced)
      : undefined;
  const forced =
    choice.subtitleLanguage === "off"
      ? undefined
      : shown.find((track) => track.forced && track.language === sound?.language);
  return { audio: sound?.id ?? null, subtitle: wanted ?? forced ?? null };
}

/**
 * The subtitles a channel starts with: in the remembered language, plain ones before forced, and
 * only where none of its sound tracks speaks it. On a channel that does, they are for the hard of
 * hearing, as teletext page 888 mostly is.
 */
export function channelSubtitle(
  tracks: ChannelTracks,
  subtitleLanguage: string | null,
): SubtitleTrack | null {
  const code = subtitleLanguage === "off" ? null : languageCode(subtitleLanguage);
  if (!code || tracks.audio.some((track) => track.language === code)) return null;
  const wanted = tracks.subtitles.filter((track) => track.language === code);
  return wanted.find((track) => !track.forced) ?? wanted[0] ?? null;
}
