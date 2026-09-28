// Deterministic fake catalogue with the messiness of real Xtream panels:
// prefixes in names, separator entries, numbers sent as strings, missing logos.

/** How a channel's stream behaves. Real channels use `h264-aac`; the test category covers the rest. */
export type StreamProfile =
  | "h264-aac"
  | "h264-mp2"
  | "h264-ac3"
  | "hevc-aac"
  | "mpeg2-mp2"
  | "offline"
  | "slow-start"
  | "drops";

export interface MockChannel {
  readonly streamId: number;
  readonly num: number;
  readonly name: string;
  readonly categoryId: string;
  readonly hasLogo: boolean;
  readonly profile: StreamProfile;
  /** Hue shift for the generated test picture, so channels look different when switching. */
  readonly hue: number;
}

export interface MockCategory {
  readonly id: string;
  readonly name: string;
}

export interface MockCatalogue {
  readonly categories: readonly MockCategory[];
  readonly channels: readonly MockChannel[];
}

type NonEmpty<T> = readonly [T, ...T[]];

const TEST_CHANNELS: readonly { name: string; profile: StreamProfile }[] = [
  { name: "TEST | H.264 + AAC", profile: "h264-aac" },
  { name: "TEST | H.264 + MP2", profile: "h264-mp2" },
  { name: "TEST | H.264 + AC-3", profile: "h264-ac3" },
  { name: "TEST | HEVC + AAC", profile: "hevc-aac" },
  { name: "TEST | MPEG-2 SD + MP2", profile: "mpeg2-mp2" },
  { name: "TEST | Offline", profile: "offline" },
  { name: "TEST | Slow start (6 s)", profile: "slow-start" },
  { name: "TEST | Drops after 20 s", profile: "drops" },
];

const REGIONS: NonEmpty<string> = ["UK", "NL", "BE", "DE", "FR", "US", "ES", "IT", "PL", "PT"];
const GENRES: NonEmpty<string> = [
  "Entertainment",
  "Sports",
  "News",
  "Kids",
  "Documentary",
  "Movies",
  "Music",
];
const WORDS: NonEmpty<string> = [
  "Earth",
  "Arena",
  "Culture",
  "North",
  "City",
  "Atlas",
  "Harbour",
  "Cinema",
  "Melody",
  "Summit",
  "River",
  "Coast",
  "Valley",
  "Metro",
  "Studio",
  "Planet",
  "Forum",
  "Local",
  "Open",
  "Prime",
  "Nova",
  "Delta",
  "Orbit",
  "Pulse",
  "Zenith",
  "Lumen",
  "Vista",
  "Echo",
  "Signal",
  "Horizon",
];
const SUFFIXES: NonEmpty<string> = ["", " 1", " 2", " 3", " Plus", " Max", " Xtra", " Live", " 24"];
const QUALITY: NonEmpty<string> = ["", " HD", " FHD", " HD", " 4K", " SD"];

/** Builds a catalogue of roughly `size` channels. The same size always gives the same catalogue. */
export function buildCatalogue(size: number): MockCatalogue {
  const random = mulberry32(size);
  const pick = (items: NonEmpty<string>): string =>
    items[Math.floor(random() * items.length)] ?? items[0];

  const categories: MockCategory[] = [{ id: "1", name: "TEST | Streams and failures" }];
  const channels: MockChannel[] = TEST_CHANNELS.map((test, index) => ({
    streamId: 1000 + index,
    num: index + 1,
    name: test.name,
    categoryId: "1",
    hasLogo: false,
    profile: test.profile,
    hue: index * 40,
  }));

  const groups = REGIONS.flatMap((region) => GENRES.map((genre) => `${region} | ${genre}`));
  const perGroup = Math.max(1, Math.ceil((size - channels.length) / groups.length));
  for (const [groupIndex, group] of groups.entries()) {
    const categoryId = String(groupIndex + 2);
    categories.push({ id: categoryId, name: group });
    const region = group.split(" | ")[0] ?? "UK";
    // Many panels open each group with a separator "channel".
    channels.push(separator(channels.length, categoryId, group));
    for (let i = 0; i < perGroup && channels.length < size; i++) {
      const style = random();
      const base = `${pick(WORDS)}${pick(SUFFIXES)}${pick(QUALITY)}`.toUpperCase();
      const name = style < 0.4 ? `${region}: ${base}` : style < 0.6 ? `${region} | ${base}` : base;
      channels.push({
        streamId: 2000 + channels.length,
        num: channels.length + 1,
        name,
        categoryId,
        hasLogo: random() < 0.7,
        profile: "h264-aac",
        hue: Math.floor(random() * 360),
      });
    }
  }
  return { categories, channels };
}

function separator(index: number, categoryId: string, group: string): MockChannel {
  return {
    streamId: 2000 + index,
    num: index + 1,
    name: `##### ${group.toUpperCase()} #####`,
    categoryId,
    hasLogo: false,
    profile: "offline",
    hue: 0,
  };
}

/** Small seeded PRNG so catalogues are reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
