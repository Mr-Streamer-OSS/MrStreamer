import { type } from "arktype";
import { QUALITIES, type Quality } from "./library.ts";
import { lazy, type Infer } from "./lazy.ts";

/** Only layouts this version understands can be activated; future leaves stay on disk. */
export const MultiviewLayout = lazy(() =>
  type({
    name: "string > 0",
    channels: type({ subscriptionId: "string > 0", id: "string > 0" })
      .array()
      .atLeastLength(2)
      .atMostLength(4),
  }).onDeepUndeclaredKey("reject"),
);

/**
 * Viewing preferences that survive restarts and hold whichever subscription plays. What the
 * viewer left one subscription at is `SubscriptionPreferences`. Favourites and recently watched
 * channels live in the viewing record; files from before it may still carry them until imported.
 */
export const Preferences = lazy(() =>
  type({
    /** Stable Home row IDs. Unknown IDs survive an older release; absent uses defaults. */
    "homeRows?": type({ id: "string > 0", visible: "boolean" }).array(),
    /** Named layouts contain only source-qualified channel identities, never session URLs. */
    "multiviewLayouts?": MultiviewLayout().array(),
    /** Desktop command overrides. Missing commands use defaults; unknown IDs survive upgrades. */
    "keyboardShortcuts?": "Record<string, string[]>",
    volume: "0 <= number <= 1",
    muted: "boolean",
    /**
     * The sound to play: "nl", or ORIGINAL_SOUND for the language a title was made in. Set in
     * Settings, and by the sound track picked last. Absent plays the language for movies and
     * series.
     */
    "audioLanguage?": "string | null",
    /**
     * Subtitles to show: a language, "off" for none, or absent or null for only those forced for
     * the sound's language. Set in Settings, and by the subtitles picked last.
     */
    "subtitleLanguage?": "string | null",
    /**
     * The language for movies and series, an ISO 639-1 code: which version of a film shows and
     * plays first, and the sound until another is picked. English when absent.
     */
    "titleLanguage?": "string",
    /** The viewer's own TMDB key or read access token, used instead of the app's. */
    "tmdbKey?": "string",
    /** Titles the provider marks for adults show, in their own tab. Off when absent. */
    "adultTitles?": "boolean",
    /** A series' next episode plays automatically at the end of one. On when absent. */
    "autoplayNext?": "boolean",
    /** Whole seconds before the next episode, zero for Instant. Ten when absent. */
    "nextEpisodeDelaySeconds?": "0 <= number.integer <= 60",
    /**
     * Product-use and reliability statistics. On when absent; saved by the analytics
     * owner.
     */
    "analyticsEnabled?": "boolean",
    /**
     * How subtitles look: their size, a box or a shadow behind text, and how high they sit. A new
     * choice needs a new key: a release that meets a value it doesn't know drops the whole file.
     */
    "subtitleLook?": {
      size: "'small' | 'medium' | 'large'",
      background: "'box' | 'shadow'",
      position: "'low' | 'high'",
    },
    /**
     * The quality live channels start in. `DEFAULT_LIVE_QUALITY` when absent. A new quality needs a
     * new key, as for `subtitleLook`.
     */
    "liveQuality?": type.enumerated(...QUALITIES),
    /**
     * How Live TV shows a list: a row per channel, or the guide grid of channels by time. The list
     * when absent. A new view needs a new key, as for `subtitleLook`.
     */
    "liveView?": "'list' | 'grid'",
    /**
     * How many hours the guide grid shows across: compact shows the most, roomy the fewest.
     * Standard when absent. A new density needs a new key, as for `subtitleLook`.
     */
    "guideDensity?": "'compact' | 'standard' | 'roomy'",
  }),
);

export type Preferences = Infer<typeof Preferences>;

export type SubtitleLook = NonNullable<Preferences["subtitleLook"]>;

export type LiveView = NonNullable<Preferences["liveView"]>;

export type GuideDensity = NonNullable<Preferences["guideDensity"]>;

/**
 * What the viewer left one subscription at: where Live TV opens, and the versions and streams
 * picked. Every id in it is the provider's own, so none of it holds for another subscription.
 */
export const SubscriptionPreferences = lazy(() =>
  type({
    lastChannelId: "string | null",
    lastCategoryId: "string | null",
    /**
     * The version the viewer picked for a movie or series, by kind and TMDB id: "movie:603" to the
     * version's id. Titles without one play the version that suits them best.
     */
    "titleVersions?": "Record<string, string>",
    /**
     * The stream the viewer chose for a live channel, by the channel's id: the stream's id.
     * Channels without one play `liveQuality` automatically.
     */
    "channelVariants?": "Record<string, string>",
  }),
);

export type SubscriptionPreferences = Infer<typeof SubscriptionPreferences>;

/** The longest name and the highest number a viewer can give a channel. */
export const CHANNEL_NAME_MAX = 80;
export const CHANNEL_NUMBER_MAX = 99_999;

/** How many fallback channels one channel can name. */
export const FALLBACKS_MAX = 3;

const ownedChannel = () => type({ subscriptionId: "string > 0", id: "string > 0" });

/**
 * A sound or subtitle track the viewer picked on a channel: its id, which stays the same whenever
 * the channel lists it, its language, which says whether a track of that id is still it, and for
 * subtitles the page of several in one track (teletext).
 */
export const TrackChoice = lazy(() =>
  type({
    id: "number.integer >= 0",
    language: "string | null",
    "page?": "number.integer | null",
  }),
);

export type TrackChoice = Infer<typeof TrackChoice>;

/**
 * Channel choices: what the viewer chose for one channel in their viewing profile, by the
 * channel's source-qualified id. Each field is optional and its absence restores what the
 * provider and the profile's preferences give: the provider's name and number, shown in lists,
 * no fallback, the profile's languages. The stream picked for a channel stays in
 * `SubscriptionPreferences.channelVariants`, where earlier releases look for it.
 */
export const ChannelChoices = lazy(() =>
  type({
    channel: ownedChannel(),
    /** The name lists show instead of the provider's. */
    "name?": `0 < string <= ${CHANNEL_NAME_MAX}`,
    /** The number lists show and channel digits go to instead of the provider's. */
    "number?": `1 <= number.integer <= ${CHANNEL_NUMBER_MAX}`,
    /** Left out of every list, Live TV's search included, until shown again. */
    "hidden?": "true",
    /**
     * Fallback channels: other channels, of any subscription, to play in this order when this one
     * fails for a reason another source can help with. Only those the viewer named, never one
     * found by its name.
     */
    "fallbacks?": ownedChannel().array().atLeastLength(1).atMostLength(FALLBACKS_MAX),
    /** The sound track to play. */
    "audio?": TrackChoice(),
    /** The subtitles to show, or "off" for none. */
    "subtitles?": TrackChoice().or("'off'"),
  }),
);

export type ChannelChoices = Infer<typeof ChannelChoices>;

/**
 * A change to one channel's choices. A field left out stays as it is; null, false or an empty
 * list restores it. A name or number the same as the provider's restores it too.
 */
export const ChannelChoicesChange = lazy(() =>
  type({
    "name?": type(`string <= ${CHANNEL_NAME_MAX}`).or("null"),
    "number?": type(`1 <= number.integer <= ${CHANNEL_NUMBER_MAX}`).or("null"),
    "hidden?": "boolean",
    /** The fallbacks the viewer sees now, in order; saved ones they can't see now stay. */
    "fallbacks?": ownedChannel().array().atMostLength(FALLBACKS_MAX),
    "audio?": TrackChoice().or("null"),
    "subtitles?": TrackChoice().or("'off' | null"),
  }).onUndeclaredKey("delete"),
);

export type ChannelChoicesChange = Infer<typeof ChannelChoicesChange>;

/** A change that restores everything the viewer chose for a channel. */
export const RESTORE_CHANNEL: Required<ChannelChoicesChange> = {
  name: null,
  number: null,
  hidden: false,
  fallbacks: [],
  audio: null,
  subtitles: null,
};

/**
 * The track of `tracks` a remembered choice names: the one of its id while that is still in its
 * language, else the first in its language. Null when the channel has none of them now: the
 * player then says so and plays by the profile's languages, and the choice stays for when the
 * track is back.
 */
export function rememberedTrack<
  Track extends {
    readonly id: number;
    readonly language: string | null;
    readonly page?: number | null;
  },
>(tracks: readonly Track[], choice: TrackChoice): Track | null {
  return (
    tracks.find(
      (track) =>
        track.id === choice.id &&
        track.language === choice.language &&
        (track.page ?? null) === (choice.page ?? null),
    ) ??
    (choice.language === null
      ? undefined
      : tracks.find((track) => track.language === choice.language)) ??
    null
  );
}

/** Subtitles as Chromium draws text cues: its own size, on a box, at the foot of the picture. */
export const DEFAULT_SUBTITLE_LOOK: SubtitleLook = {
  size: "medium",
  background: "box",
  position: "low",
};

/** `audioLanguage` for the sound in the language a title was made in. */
export const ORIGINAL_SOUND = "original";

/** The quality live channels start in until the viewer picks another: Full HD. */
export const DEFAULT_LIVE_QUALITY: Quality = "fhd";

export const DEFAULT_NEXT_EPISODE_DELAY = 10;

export const defaultPreferences: Preferences = { volume: 1, muted: false };

export const defaultSubscriptionPreferences: SubscriptionPreferences = {
  lastChannelId: null,
  lastCategoryId: null,
};
