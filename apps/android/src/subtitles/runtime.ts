import { SavedSubtitle } from "@mrstreamer/contracts/online-subtitles";
import { defined } from "@mrstreamer/core/defined";
import { requireNativeModule } from "expo";
import { Directory, File, Paths } from "expo-file-system";
import { currentLanguage } from "@mrstreamer/core/i18n";
import { titleName } from "@mrstreamer/core/ondemand/names";
import { type } from "arktype";
import { library } from "../library/runtime.ts";
import { sources } from "../bootstrap/sources.ts";
import { sealedLinks } from "../guide/secrets.ts";
import type { PlayerOwner } from "../player/player.ts";
import { nativePlayer } from "../player/native.ts";
import { mediaPersistence } from "../player/preferences.ts";
import { preferences } from "../platform/preferences.ts";
import { store } from "../platform/store.ts";
import { knownSubtitleTitle, versionKey } from "./context.ts";
import { subtitleModel, type SubtitleModel, type SubtitleTitle } from "./model.ts";
import type { TransferPort } from "../downloads/state.ts";

const root = () => new Directory(Paths.document, "subtitles");

// The full key stays inside the record; a safe encoded name never contains a media path.
const fileOf = (key: string) => new File(root(), `${encodeURIComponent(key)}.json`);
let model: SubtitleModel | undefined;

/** The native checked path plus transfer id and intact file metadata identify the retained bytes. */
function fileBinding(id: string, path: string) {
  const file = new File(path);

  if (!file.exists || file.size <= 0 || file.modificationTime === null) throw new Error("read");

  return JSON.stringify([id, path, file.size, file.modificationTime]);
}

/** The binding a record of the playing file must carry now, if that file has one. */
function currentBinding() {
  const bound = model?.state.get().title?.fileBinding;

  if (!bound) return undefined;
  const [id, path]: [string, string] = JSON.parse(bound);

  return { bound, now: fileBinding(id, path) };
}

/** Read the actual persisted record for the checked next copy, never a provider-version guess. */
export async function retainedFileSubtitle(row: { id: string; key: string }, path: string) {
  const transfers = requireNativeModule<TransferPort>("Transfers");

  if ((await transfers.path(row.id)) !== path) throw new Error("read");
  const binding = fileBinding(row.id, path);
  const file = fileOf(row.key);
  const parsed = file.exists ? SavedSubtitle()(JSON.parse(file.textSync())) : null;

  if (parsed instanceof type.errors) throw new Error("read");

  return parsed?.fileBinding === binding ? parsed : null;
}

export function subtitles(): SubtitleModel {
  if (!model) throw new Error("Subtitle playback has not started");

  return model;
}

export function startSubtitles(
  player: Pick<PlayerOwner, "state"> & { media: Pick<PlayerOwner["media"], "text"> },
): SubtitleModel {
  return (model ??= subtitleModel({
    player,
    native: nativePlayer(),
    secrets: sealedLinks,
    files: {
      read(key) {
        const binding = currentBinding();

        if (binding && binding.bound !== binding.now) throw new Error("read");
        const file = fileOf(key);

        return file.exists ? JSON.parse(file.textSync()) : null;
      },
      write(key, value) {
        const binding = currentBinding();

        if (binding && value.fileBinding !== binding.now) throw new Error("read");

        const identity: unknown = JSON.parse(key);
        const current = sources.state.get();

        if (
          Array.isArray(identity) &&
          current.kind === "ready" &&
          !current.sources.some((source) => source.id === identity[0]) &&
          !ownedKeys.has(key)
        )
          throw new Error("Source removed");
        root().create({ intermediates: true, idempotent: true });
        const file = fileOf(key);
        const pending = new File(root(), `${encodeURIComponent(key)}.next`);

        if (!pending.exists) pending.create();
        pending.writeSync(JSON.stringify({ ...value, query: model?.state.get().title?.query }));
        pending.moveSync(file, { overwrite: true });

        void prune();
      },
      remove(key) {
        const file = fileOf(key);

        if (file.exists) file.delete();
      },
    },
    languages() {
      const text = mediaPersistence.read().text;
      const title = currentLanguage().locale.split("-")[0] ?? "en";

      return [
        ...new Set([
          ...(text !== undefined && text !== "off" && text.language
            ? [text.language.split("-")[0]!]
            : []),
          title,
          "en",
        ]),
      ];
    },
    async title(intent): Promise<SubtitleTitle | null> {
      if (intent.kind === "file") {
        const transfers = requireNativeModule<TransferPort>("Transfers");
        const snapshot: unknown = JSON.parse(await transfers.snapshot());

        const parsed = type({
          rows: type({
            id: "string",
            key: "string",
            kind: "'movie' | 'episode'",
            title: "string",
            "year?": "number | null",
            "season?": "number",
            "episode?": "number",
          }).array(),
        })(snapshot);

        if (parsed instanceof type.errors) throw new Error("read");
        ownedKeys = new Set(parsed.rows.map((row) => row.key));

        for (const row of parsed.rows) {
          if ((await transfers.filePath(row.id)) !== intent.path) continue;

          if ((await transfers.path(row.id)) !== intent.path) throw new Error("read");
          const binding = fileBinding(row.id, intent.path);
          const known = knownSubtitleTitle(row.key);

          if (known) return { ...known, fileBinding: binding };

          if (row.kind === "episode" && (row.season === undefined || row.episode === undefined))
            return null;

          return {
            key: row.key,
            fileBinding: binding,
            query:
              row.kind === "movie"
                ? { kind: "movie", title: row.title, ...defined({ year: row.year ?? undefined }) }
                : { kind: "episode", title: row.title, season: row.season!, episode: row.episode! },
          };
        }

        return null;
      }

      if (intent.kind !== "title") return null;
      const key = versionKey(intent.sourceId, intent.media, intent.id, intent.container);
      const known = knownSubtitleTitle(key);

      if (known) return known;
      const retained = fileOf(key);

      if (retained.exists) {
        const parsed = type({
          query: type({
            kind: "'movie'",
            "tmdbId?": "number",
            "title?": "string",
            "year?": "number",
          }).or({
            kind: "'episode'",
            "tmdbId?": "number",
            "title?": "string",
            season: "number",
            episode: "number",
          }),
        })(JSON.parse(retained.textSync()));

        if (parsed instanceof type.errors) throw new Error("read");

        return { key, query: parsed.query };
      }

      if (intent.media === "episode") {
        const exact = library().playbackEpisode(intent.sourceId, intent.id, intent.container);

        if (exact)
          return {
            key,
            query: {
              kind: "episode",
              title: exact.title.title,
              ...defined({
                tmdbId:
                  exact.title.tmdbId && /^[1-9]\d{0,9}$/.test(exact.title.tmdbId)
                    ? Number(exact.title.tmdbId)
                    : undefined,
              }),
              season: exact.episode.season,
              episode: exact.episode.number,
            },
          };
      }

      const reader = sources.onDemand(intent.sourceId);

      if (!reader) throw new Error("read");
      const catalogue = await reader.onDemandCatalogue();

      if (intent.media === "episode") {
        const series = catalogue.series.find((item) => item.episodeFiles?.includes(intent.id));

        if (!series) return null;
        const details = await reader.seriesDetails(series.id);

        const episode = details.episodes.find(
          (item) => item.id === intent.id && item.container === intent.container,
        );

        if (!episode) return null;

        return {
          key,
          query: {
            kind: "episode",
            season: episode.season,
            episode: episode.number,
            ...(series.tmdbId && /^[1-9]\d{0,9}$/.test(series.tmdbId)
              ? { tmdbId: Number(series.tmdbId) }
              : { title: titleName(series.name).title }),
          },
        };
      }

      const movie = catalogue.movies.find((item) => item.id === intent.id);

      if (!movie) return null;
      const name = titleName(movie.name);

      return {
        key,
        query: {
          kind: "movie",
          ...(movie.tmdbId && /^[1-9]\d{0,9}$/.test(movie.tmdbId)
            ? { tmdbId: Number(movie.tmdbId) }
            : { title: name.title }),
          ...defined({ year: name.year ?? undefined }),
        },
      };
    },
  }));
}

const TextSize = type("0.5 <= number <= 2");
export const subtitleTextSize = store(1);
export const subtitleTextSizeError = store(false);

export function readSubtitleTextSize() {
  try {
    const raw = preferences().read("subtitle-size.json");
    const parsed = raw === null ? 1 : TextSize(raw);

    if (parsed instanceof type.errors) throw new Error("read");
    subtitleTextSizeError.set(false);
    subtitleTextSize.set(parsed);
    void nativePlayer().setSubtitleSize?.(parsed);

    return true;
  } catch {
    subtitleTextSizeError.set(true);

    return false;
  }
}

export function setSubtitleTextSize(value: number) {
  if (TextSize(value) instanceof type.errors || !preferences().write("subtitle-size.json", value))
    return false;
  subtitleTextSizeError.set(false);
  subtitleTextSize.set(value);
  void nativePlayer().setSubtitleSize?.(value);

  return true;
}

// Download rows own the same version key even after their provider is removed.
let ownedKeys = new Set<string>();

async function downloadKeys() {
  const snapshot: unknown = JSON.parse(
    await requireNativeModule<TransferPort>("Transfers").snapshot(),
  );

  const parsed = type({ rows: type({ key: "string" }).array() })(snapshot);

  if (parsed instanceof type.errors) throw new Error("read");
  ownedKeys = new Set(parsed.rows.map((row) => row.key));

  return ownedKeys;
}

async function prune() {
  try {
    const owned = await downloadKeys();

    const kept = root()
      .list()
      .filter((entry): entry is File => entry instanceof File && entry.name.endsWith(".json"));

    let excess = kept.length - 100;

    for (const file of kept.toSorted(
      (a, b) => (a.modificationTime ?? 0) - (b.modificationTime ?? 0),
    )) {
      if (excess <= 0) break;

      try {
        if (owned.has(decodeURIComponent(file.name.slice(0, -5)))) continue;
        file.delete();
        excess--;
      } catch {
        /* A later write retries this file. */
      }
    }
  } catch {
    /* A failed download read must not erase owned records. */
  }
}

const initialSources = sources.state.get();

let listedSources =
  initialSources.kind === "ready"
    ? new Set(initialSources.sources.map((source) => source.id))
    : new Set<string>();

let erasing = Promise.resolve();

sources.state.subscribe(() => {
  const now = sources.state.get();

  if (now.kind !== "ready") return;
  const next = new Set(now.sources.map((source) => source.id));

  // Remember additions immediately, retaining failed removals until cleanup succeeds.
  for (const id of next) listedSources.add(id);
  erasing = erasing.then(async () => {
    const removed = [...listedSources].filter((id) => !next.has(id));

    if (!removed.length) return;

    try {
      const owned = await downloadKeys();
      const failed = new Set<string>();

      for (const file of root().exists ? root().list() : []) {
        if (!(file instanceof File) || !file.name.endsWith(".json")) continue;
        let source: string | undefined;

        try {
          const key = decodeURIComponent(file.name.slice(0, -5));
          const identity: unknown = JSON.parse(key);

          if (!Array.isArray(identity) || !type.keywords.string.root.allows(identity[0])) continue;
          source = identity[0];

          if (removed.includes(source) && !owned.has(key)) file.delete();
        } catch {
          if (source) failed.add(source);
        }
      }

      for (const id of removed) if (!failed.has(id)) listedSources.delete(id);
    } catch {
      /* Keep removed IDs for the next source notification. */
    }
  });

  return erasing;
});
