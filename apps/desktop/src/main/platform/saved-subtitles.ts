// Downloaded cues and timing belong to an exact listed file, never a movie name or TMDB id.
import type { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_SUBTITLE_TIMING,
  SavedSubtitle,
  type DownloadedSubtitle,
  type SubtitleTiming,
} from "@mrstreamer/contracts/online-subtitles";
import type { Failed } from "@mrstreamer/core/failure";
import { type } from "arktype";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { attempt, Database, unavailable } from "./database.ts";

/** Main-only identity resolved from the current playback session and provider catalogue. */
export interface SubtitleFile {
  readonly account: string;
  readonly sourceStamp: string;
  readonly listingKey: string;
  readonly kind: "movie" | "episode";
  readonly id: string;
}

export const SAVED_SUBTITLES_TABLE = "saved_subtitles";

/** Also prepared by account erasure when no playback service has run. */
export function prepareSavedSubtitles(db: DatabaseSync): void {
  db.exec(`create table if not exists saved_subtitles (
    account text not null,
    kind text not null,
    id text not null,
    source_stamp text not null,
    listing_key text not null,
    saved text not null,
    primary key (account, kind, id)
  )`);
}

export class SavedSubtitles extends Context.Service<
  SavedSubtitles,
  {
    read(file: SubtitleFile): Effect.Effect<SavedSubtitle | null, Failed>;
    remember(file: SubtitleFile, subtitle: DownloadedSubtitle): Effect.Effect<void, Failed>;
    timing(file: SubtitleFile, timing: SubtitleTiming): Effect.Effect<void, Failed>;
    /** Forgets a removed file or one playback has observed being replaced. */
    forget(file: SubtitleFile): Effect.Effect<void, Failed>;
  }
>()("mrstreamer/SavedSubtitles") {}

export const savedSubtitlesLayer = Layer.effect(
  SavedSubtitles,
  Effect.gen(function* () {
    const opened = yield* Database;
    if ("failure" in opened) return closed(opened.failure);
    return yield* attempt(() => {
      const { db } = opened;
      prepareSavedSubtitles(db);
      const select = db.prepare(`select saved from saved_subtitles
        where account = ? and kind = ? and id = ? and source_stamp = ? and listing_key = ?`);
      const write = db.prepare(`insert into saved_subtitles
        (account, kind, id, source_stamp, listing_key, saved) values (?, ?, ?, ?, ?, ?)
        on conflict (account, kind, id) do update set source_stamp = excluded.source_stamp,
        listing_key = excluded.listing_key, saved = excluded.saved`);
      const remove = db.prepare(`delete from saved_subtitles
        where account = ? and kind = ? and id = ? and source_stamp = ? and listing_key = ?`);
      const identity = (file: SubtitleFile) =>
        [file.account, file.kind, file.id, file.sourceStamp, file.listingKey] as const;
      const read = (file: SubtitleFile): SavedSubtitle | null => {
        const row = select.get(...identity(file));
        if (!row) return null;
        try {
          const parsed = SavedSubtitle(JSON.parse(String(row.saved)));
          return parsed instanceof type.errors ? null : parsed;
        } catch {
          return null;
        }
      };
      const save = (file: SubtitleFile, saved: SavedSubtitle) =>
        write.run(...identity(file), JSON.stringify(SavedSubtitle.assert(saved)));
      return {
        read: (file: SubtitleFile) => attempt(() => read(file)),
        remember: (file: SubtitleFile, subtitle: DownloadedSubtitle) =>
          attempt(() => {
            save(file, { timing: read(file)?.timing ?? DEFAULT_SUBTITLE_TIMING, subtitle });
          }),
        timing: (file: SubtitleFile, timing: SubtitleTiming) =>
          attempt(() => {
            save(file, { timing, subtitle: read(file)?.subtitle ?? null });
          }),
        forget: (file: SubtitleFile) =>
          attempt(() => {
            remove.run(...identity(file));
          }),
      };
    }).pipe(Effect.catch(() => Effect.succeed(closed("Saved subtitles can't be opened."))));
  }),
);

function closed(detail: string): SavedSubtitles["Service"] {
  const fail = unavailable(detail);
  return { read: () => fail, remember: () => fail, timing: () => fail, forget: () => fail };
}
