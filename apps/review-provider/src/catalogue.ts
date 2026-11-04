import { type } from "arktype";

// One sample definition. The preparation driver reads these same source identities;
// protocol lists, details and the linear programme cycle all derive from them.
export const SOURCE_COMMIT = "9791b09908e03742cee981c97e37d47829fc7a18";

export const CHANNEL = {
  id: "original-live",
  guideId: "original-sample-channel",
  name: "Original sample channel",
  category: "sample-live",
} as const;

export const ORIGINALS = [
  {
    id: "movie",
    filename: "movie.mp4",
    frames: 3600,
    name: "Generated sample movie",
    sha256: "7787c1d37377680870c0e6b5f3989d602f0ffae87ecca5aec7e50d9b25be6f97",
  },
  {
    id: "episode-1",
    filename: "episode-1.mp4",
    frames: 2160,
    name: "Episode 1",
    sha256: "7b009fb8f116424f24a02ab2a7eea3e6f3363d9a02dcf5249e481ea3c48049c9",
  },
  {
    id: "episode-2",
    filename: "episode-2.mp4",
    frames: 2160,
    name: "Episode 2",
    sha256: "4b71b161bae0b4dc37bdbed8b2b1dd4d1d42cafa36a2ebbff0d775fa706cf2f5",
  },
] as const;

export const ARTWORK = [
  { id: "movie-cover", sha256: "b7bc8185167fb1c91663331a32f956125076427565a209377887b7fb84a985f3" },
  {
    id: "movie-backdrop",
    sha256: "01ecb999bc1f263dc8c80a3920a8d94fec9f5339bb214cde7b990104e0ae8088",
  },
  {
    id: "series-cover",
    sha256: "b2edc6bd9c80498c4966e6ca6721df97b2259c88dbaa461e3048c9ceb7f53a01",
  },
  {
    id: "series-backdrop",
    sha256: "5c3a56338d0ee35983112b8cfb334c8f78a8f512b4a4e88078f5b571597e9c24",
  },
] as const;

export type MediaId = (typeof ORIGINALS)[number]["id"];

type ArtworkId = (typeof ARTWORK)[number]["id"];

export type RenditionId = "540p" | "180p";

export interface ObjectFact {
  readonly key: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly mime: "video/mp4" | "video/mp2t" | "image/png";
}

interface Rendition {
  readonly id: RenditionId;
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  readonly codecs: string;
  readonly bandwidth: number;
  readonly averageBandwidth: number;
}

export interface ProgrammeMedia {
  readonly id: MediaId;
  readonly videoFrames: number;
  readonly audio: {
    readonly accessUnitsSha256: string;
    readonly firstEdgeTicks: number;
    readonly lastEdgeTicks: number;
    readonly continuous: boolean;
  };
}

export interface Segment {
  readonly programme: MediaId;
  readonly frames: number;
  readonly videoDurationTicks: number;
  readonly files: Readonly<Record<RenditionId, ObjectFact>>;
}

export interface MediaIndex {
  readonly version: 1;
  readonly sourceCommit: string;
  readonly release: string;
  readonly originals: Readonly<Record<MediaId, ObjectFact>>;
  readonly artwork: Readonly<Record<ArtworkId, ObjectFact>>;
  readonly programmes: readonly ProgrammeMedia[];
  readonly renditions: readonly Rendition[];
  readonly segments: readonly Segment[];
}

const Finite = type("number").narrow(Number.isFinite);

const ObjectFact = type({
  key: "string",
  bytes: Finite,
  sha256: "string",
  mime: "'video/mp4' | 'video/mp2t' | 'image/png'",
});

const MediaId = type("'movie' | 'episode-1' | 'episode-2'");

const MediaIndex = type({
  version: "1",
  sourceCommit: "string",
  release: "string",
  originals: { movie: ObjectFact, "episode-1": ObjectFact, "episode-2": ObjectFact },
  artwork: {
    "movie-cover": ObjectFact,
    "movie-backdrop": ObjectFact,
    "series-cover": ObjectFact,
    "series-backdrop": ObjectFact,
  },
  programmes: type({
    id: MediaId,
    videoFrames: Finite,
    audio: {
      accessUnitsSha256: "string",
      firstEdgeTicks: Finite,
      lastEdgeTicks: Finite,
      continuous: "boolean",
    },
  }).array(),
  renditions: type({
    id: "'540p' | '180p'",
    width: Finite,
    height: Finite,
    frameRate: Finite,
    codecs: "string",
    bandwidth: Finite,
    averageBandwidth: Finite,
  }).array(),
  segments: type({
    programme: MediaId,
    frames: Finite,
    videoDurationTicks: Finite,
    files: { "540p": ObjectFact, "180p": ObjectFact },
  }).array(),
});

/** Parse generated JSON and certify its cycle before any provider can serve it. */
export const readMediaIndex = MediaIndex.pipe((index): MediaIndex => {
  validateMedia(index);

  return index;
}).assert;

/** Reject an incomplete or inconsistent index before any provider can serve it. */
export function validateMedia(index: MediaIndex): void {
  if (index.version !== 1 || !/^[a-z0-9-]{1,80}$/.test(index.release)) {
    throw new Error("Invalid media release");
  }

  const objects = [
    ...Object.values(index.originals),
    ...Object.values(index.artwork),
    ...index.segments.flatMap((segment) => Object.values(segment.files)),
  ];

  for (const fact of objects) {
    if (
      !/^[a-z0-9/-]+(?:\.[a-z0-9]+)?$/.test(fact.key) ||
      fact.key.includes("..") ||
      !Number.isSafeInteger(fact.bytes) ||
      fact.bytes <= 0 ||
      !/^[a-f0-9]{64}$/.test(fact.sha256)
    ) {
      throw new Error("Invalid immutable object fact");
    }
  }

  if (
    index.programmes.length !== 3 ||
    index.renditions.length !== 2 ||
    index.segments.length !== 55
  ) {
    throw new Error("Incomplete media cycle");
  }

  let start = 0;

  for (const [at, original] of ORIGINALS.entries()) {
    const programme = index.programmes[at];
    const count = original.frames / 144;

    if (
      !programme ||
      programme.id !== original.id ||
      programme.videoFrames !== original.frames ||
      !programme.audio.continuous ||
      !/^[a-f0-9]{64}$/.test(programme.audio.accessUnitsSha256) ||
      !Number.isFinite(programme.audio.firstEdgeTicks) ||
      !Number.isFinite(programme.audio.lastEdgeTicks) ||
      Math.abs(programme.audio.firstEdgeTicks) > 3840 ||
      Math.abs(programme.audio.lastEdgeTicks) > 3840
    ) {
      throw new Error("Uncertified programme timeline");
    }

    if (index.originals[original.id]?.mime !== "video/mp4") throw new Error("Missing original MP4");

    for (const segment of index.segments.slice(start, start + count)) {
      if (
        segment.programme !== original.id ||
        segment.frames !== 144 ||
        segment.videoDurationTicks !== 540000 ||
        segment.files["540p"]?.mime !== "video/mp2t" ||
        segment.files["180p"]?.mime !== "video/mp2t"
      ) {
        throw new Error("Uncertified video segment");
      }
    }

    start += count;
  }

  for (const art of ARTWORK) {
    if (index.artwork[art.id]?.mime !== "image/png") throw new Error("Missing original artwork");
  }

  for (const id of ["540p", "180p"] as const) {
    const rendition = index.renditions.find((row) => row.id === id);
    const expected = id === "540p" ? [960, 540] : [320, 180];
    const sizes = index.segments.map((segment) => segment.files[id].bytes);
    const peak = Math.ceil((Math.max(...sizes) * 8) / 6);
    const average = Math.ceil((sizes.reduce((sum, size) => sum + size, 0) * 8) / 330);

    if (
      !rendition ||
      rendition.width !== expected[0] ||
      rendition.height !== expected[1] ||
      rendition.frameRate !== 24 ||
      !/^avc1\.[a-fA-F0-9]{6},mp4a\.40\.2$/.test(rendition.codecs) ||
      rendition.bandwidth !== peak ||
      rendition.averageBandwidth !== average ||
      (id === "180p" && peak > 192000)
    ) {
      throw new Error("Uncertified HLS rendition");
    }
  }
}

/** The exact Xtream actions the existing core Provider consumes. Unknown IDs stay failures. */
export function apiAnswer(action: string, id: string | null, origin: string) {
  const art = (name: ArtworkId) => `${origin}/art/${name}.png`;

  const episodes = ORIGINALS.slice(1).map((original, index) => ({
    id: original.id,
    season: 1,
    episode_num: index + 1,
    title: original.name,
    container_extension: "mp4",
    info: { duration_secs: original.frames / 24 },
  }));

  switch (action) {
    case "":
      return {
        status: 200,
        body: {
          user_info: {
            auth: 1,
            status: "Active",
            exp_date: null,
            max_connections: null,
            active_cons: null,
          },
          server_info: { timezone: "UTC" },
        },
      };
    case "get_live_categories":
      return {
        status: 200,
        body: [{ category_id: CHANNEL.category, category_name: "Original samples" }],
      };
    case "get_live_streams":
      return {
        status: 200,
        body: [
          {
            stream_id: CHANNEL.id,
            name: CHANNEL.name,
            num: 1,
            stream_icon: null,
            category_id: CHANNEL.category,
            epg_channel_id: CHANNEL.guideId,
            is_adult: 0,
            tv_archive: 0,
            tv_archive_duration: 0,
          },
        ],
      };
    case "get_vod_categories":
      return {
        status: 200,
        body: [{ category_id: "sample-movies", category_name: "Sample movies" }],
      };
    case "get_series_categories":
      return {
        status: 200,
        body: [{ category_id: "sample-series", category_name: "Sample series" }],
      };
    case "get_vod_streams":
      return {
        status: 200,
        body: [
          {
            stream_id: "movie",
            name: ORIGINALS[0].name,
            stream_icon: art("movie-cover"),
            category_id: "sample-movies",
            container_extension: "mp4",
            is_adult: 0,
            tmdb: null,
            rating: null,
            added: null,
          },
        ],
      };
    case "get_series":
      return {
        status: 200,
        body: [
          {
            series_id: "series",
            name: "Generated sample series",
            cover: art("series-cover"),
            backdrop_path: [art("series-backdrop")],
            category_id: "sample-series",
            is_adult: 0,
            tmdb: null,
            rating: null,
            last_modified: null,
            releaseDate: null,
          },
        ],
      };
    case "get_vod_info":
      return id === "movie"
        ? {
            status: 200,
            body: {
              info: {
                plot: "Original generated shapes and a quiet tone, no speech.",
                duration_secs: ORIGINALS[0].frames / 24,
                movie_image: art("movie-cover"),
                backdrop_path: [art("movie-backdrop")],
              },
              movie_data: { container_extension: "mp4" },
            },
          }
        : { status: 404, body: { error: "Not found" } };
    case "get_series_info":
      return id === "series"
        ? {
            status: 200,
            body: {
              info: {
                plot: "Two original generated samples with a quiet tone, no speech.",
                cover: art("series-cover"),
                backdrop_path: [art("series-backdrop")],
              },
              seasons: [{ season_number: 1 }],
              episodes: { "1": episodes },
            },
          }
        : { status: 404, body: { error: "Not found" } };
    default:
      return { status: 400, body: { error: "Unsupported action" } };
  }
}
