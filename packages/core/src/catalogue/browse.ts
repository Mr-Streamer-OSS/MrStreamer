import {
  BROWSE_TOPICS,
  type BrowseMetadata,
  type BrowseTopic,
} from "@mrstreamer/contracts/live-browse";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { ProviderCategory } from "../provider.ts";
import { languageCode, languageName } from "../ondemand/tracks.ts";
import { normalize } from "../text.ts";
import type { NormalizedStream } from "./normalize.ts";
import { isBroadRegion, leadingFlag, regionForCode, regionForName } from "./regions.ts";

/** Finite category-label vocabulary. Whole words only; channel names never assign topics. */
const CONTENT: Readonly<Partial<Record<BrowseTopic, readonly string[]>>> = {
  news: [
    "news",
    "nieuws",
    "nachrichten",
    "actualites",
    "information",
    "infos",
    "noticias",
    "notizie",
    "noticiario",
    "haber",
    "اخبار",
    "أخبار",
  ],
  sport: ["sport", "sports", "sporten", "deportes", "desporto", "esportes", "رياضة", "رياضية"],
  kids: [
    "kids",
    "children",
    "junior",
    "kinderen",
    "kinder",
    "enfants",
    "jeunesse",
    "infantil",
    "ninos",
    "bambini",
    "cocuk",
    "اطفال",
    "أطفال",
  ],
  movies: [
    "movies",
    "movie",
    "films",
    "film",
    "cinema",
    "cine",
    "peliculas",
    "filme",
    "افلام",
    "أفلام",
  ],
  entertainment: [
    "entertainment",
    "general",
    "generalist",
    "generaliste",
    "amusement",
    "divertissement",
    "unterhaltung",
    "entretenimiento",
    "entretenimento",
    "intrattenimento",
  ],
  music: ["music", "muziek", "musique", "musik", "musica", "موسيقى"],
  documentary: [
    "documentary",
    "documentaries",
    "documentaire",
    "documentaires",
    "documental",
    "documentales",
    "documentario",
    "documentari",
    "dokumentation",
    "dokumentationen",
    "doku",
    "وثائقي",
    "وثائقية",
  ],
};
const words = BROWSE_TOPICS.flatMap((topic) => {
  const labels = CONTENT[topic];
  return labels ? [{ topic, labels: new Set(labels) }] : [];
});
// Place-only subjects are deliberately finite. A country prefix with no subject is not Regional.
const PLACES = new Set([
  "vlaanderen",
  "flanders",
  "wallonie",
  "wallonia",
  "brussels",
  "bruxelles",
  "brussel",
  "scotland",
  "wales",
  "northern ireland",
  "bayern",
  "bavaria",
  "catalunya",
  "catalonia",
  "quebec",
  "africa",
  "asia",
  "caribbean",
  "europe",
  "latin america",
  "world",
  "ex-yugoslavia",
]);
const QUALITY = /(?<![\p{L}\p{N}])(8k|4k|uhd|fhd|hd|sd|hevc|hdr|raw|\d{3,4}p)(?![\p{L}\p{N}])/giu;

function subject(raw: string): string {
  let text = raw.normalize("NFKC").trim();
  const flag = leadingFlag(text);
  if (flag) text = flag.rest;
  else {
    const prefix = /^[[(|┃│]?\s*([A-Z]{2,5})(?:\s*-\s*[A-Z]{2,3})?(?:\s*[\])|:┃│»]|\s+-\s)\s*/.exec(
      text,
    );
    if (prefix?.[1] && regionForCode(prefix[1])) text = text.slice(prefix[0].length);
    else {
      const spelled = /^(\p{L}[\p{L} .'&-]{2,30}?)\s*[|:┃│»]\s*/u.exec(text);
      if (spelled?.[1] && regionForName(spelled[1])) text = text.slice(spelled[0].length);
    }
  }
  return normalize(text.replace(QUALITY, " "))
    .replace(/^[\s|:.-]+|[\s|:.-]+$/g, "")
    .trim();
}

export function categoryBrowseTopics(name: string): readonly BrowseTopic[] {
  const label = subject(name);
  const tokens = label.split(/[^\p{L}\p{N}]+/u);
  const topics: BrowseTopic[] = [];
  for (const { topic, labels } of words) {
    if (tokens.some((word) => labels.has(word))) topics.push(topic);
  }
  if (topics.length) return topics;
  const country = regionForName(label);
  return label && (PLACES.has(label) || (country !== null && !isBroadRegion(country)))
    ? ["regional"]
    : ["other"];
}

/** Derive after joining variants. Contradictory/uncertain streams cannot assert filter facts. */
export function browseMetadata(
  channel: Pick<LiveChannel, "categoryIds" | "variants" | "adult">,
  categories: ReadonlyMap<string, readonly BrowseTopic[]>,
  streams: ReadonlyMap<string, NormalizedStream>,
): BrowseMetadata {
  const assigned = new Set(channel.categoryIds.flatMap((id) => categories.get(id) ?? []));
  const content = [...assigned].filter((id) => id !== "regional" && id !== "other");
  const own = channel.variants.flatMap((variant) => streams.get(variant.id) ?? []);
  const certain =
    own.length === channel.variants.length && own.every((each) => !each.searchUncertain);
  const fact = (get: (stream: NormalizedStream) => string | null) => {
    if (!certain || own.length === 0) return null;
    const values = new Set(own.map(get));
    return values.size === 1 ? ([...values][0] ?? null) : null;
  };
  return {
    topics: channel.adult
      ? ["other"]
      : content.length
        ? content
        : assigned.has("regional")
          ? ["regional"]
          : ["other"],
    country: fact((stream) =>
      stream.region && !isBroadRegion(stream.region) && regionForName(stream.region)
        ? stream.region
        : null,
    ),
    language: fact((stream) =>
      languageName(stream.language) ? languageCode(stream.language) : null,
    ),
  };
}

/** Precompute categories once per accepted catalogue, never once per query or channel. */
export function browseCategories(categories: readonly ProviderCategory[]) {
  return new Map(categories.map((category) => [category.id, categoryBrowseTopics(category.name)]));
}
