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
import { attempt, Database, transaction, unavailable } from "./database.ts";

/** Main-only identity resolved from the current playback session and provider catalogue. */
export interface SubtitleFile {
  readonly account: string;
  readonly sourceStamp: string;
  readonly listingKey: string;
  readonly kind: "movie" | "episode";
  readonly id: string;
}

const Stored = SavedSubtitle.merge({ "resultKey?": "string <= 64" });
type Stored = typeof Stored.infer;
export const SAVED_SUBTITLES_TABLE = "saved_subtitles";
export const SUBTITLE_RESULTS_TABLE = "saved_subtitle_results";

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
  db.exec(`create table if not exists saved_subtitle_results (
    account text not null, kind text not null, id text not null,
    source_stamp text not null, listing_key text not null, result_key text not null,
    saved text not null, primary key (account, kind, id, source_stamp, listing_key, result_key)
  )`);
}

export class SavedSubtitles extends Context.Service<
  SavedSubtitles,
  {
    read(file: SubtitleFile): Effect.Effect<SavedSubtitle | null, Failed>;
    result(file: SubtitleFile, key: string): Effect.Effect<SavedSubtitle | null, Failed>;
    remember(
      file: SubtitleFile,
      subtitle: DownloadedSubtitle,
      key?: string,
      timing?: SubtitleTiming,
    ): Effect.Effect<void, Failed>;
    timing(
      file: SubtitleFile,
      timing: SubtitleTiming,
      selection?: string,
    ): Effect.Effect<void, Failed>;
    /**
     * Makes a saved result the file's selected and shown one: the selected row when `selection`
     * names it, else the cached result of that key with its own timing. Fails when neither holds it.
     */
    show(file: SubtitleFile, selection?: string): Effect.Effect<void, Failed>;
    /** Keeps the selected result, its key and timing, but not shown when the file opens again. */
    hide(file: SubtitleFile): Effect.Effect<void, Failed>;
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
      const cached = db.prepare(`select saved from saved_subtitle_results where
        account = ? and kind = ? and id = ? and source_stamp = ? and listing_key = ? and result_key = ?`);
      const rememberResult = db.prepare(`insert into saved_subtitle_results
        (account, kind, id, source_stamp, listing_key, result_key, saved) values (?, ?, ?, ?, ?, ?, ?)
        on conflict (account, kind, id, source_stamp, listing_key, result_key)
        do update set saved = excluded.saved`);
      const pruneResults = db.prepare(`delete from saved_subtitle_results where rowid in (
        select rowid from saved_subtitle_results where
        account = ? and kind = ? and id = ? and source_stamp = ? and listing_key = ?
        order by rowid desc limit -1 offset 8)`);
      const touchResult = db.prepare(`delete from saved_subtitle_results where
        account = ? and kind = ? and id = ? and source_stamp = ? and listing_key = ? and result_key = ?`);
      const removeResults = db.prepare(`delete from saved_subtitle_results where
        account = ? and kind = ? and id = ? and (
          (source_stamp = ? and listing_key = ?) or not exists (
            select 1 from saved_subtitles where account = ? and kind = ? and id = ?
          )
        )`);
      const removeObsoleteResults = db.prepare(`delete from saved_subtitle_results where
        account = ? and kind = ? and id = ? and (source_stamp != ? or listing_key != ?)`);
      const identity = (file: SubtitleFile) =>
        [file.account, file.kind, file.id, file.sourceStamp, file.listingKey] as const;
      const read = (file: SubtitleFile): Stored | null => {
        const row = select.get(...identity(file));
        if (!row) return null;
        try {
          const parsed = Stored(JSON.parse(String(row.saved)));
          return parsed instanceof type.errors ? null : parsed;
        } catch {
          return null;
        }
      };
      /** A result as the cache keeps it: cues, timing and key. Whether it shows is the selection's. */
      const result = (saved: Stored): SavedSubtitle => ({
        timing: saved.timing,
        subtitle: saved.subtitle,
        ...(saved.resultKey ? { selection: saved.resultKey } : {}),
      });
      const visible = (saved: Stored | null): SavedSubtitle | null =>
        saved ? { ...result(saved), ...(saved.shown === false ? { shown: false } : {}) } : null;
      const cachedResult = (file: SubtitleFile, key: string): SavedSubtitle | null => {
        const row = cached.get(...identity(file), key);
        if (!row) return null;
        try {
          const parsed = SavedSubtitle(JSON.parse(String(row.saved)));
          return parsed instanceof type.errors ? null : parsed;
        } catch {
          return null;
        }
      };
      const save = (file: SubtitleFile, saved: Stored) => {
        const checked = Stored.assert(saved);
        transaction(db, () => {
          removeObsoleteResults.run(...identity(file));
          write.run(...identity(file), JSON.stringify(checked));
          if (checked.resultKey) {
            touchResult.run(...identity(file), checked.resultKey);
            rememberResult.run(
              ...identity(file),
              checked.resultKey,
              JSON.stringify(result(checked)),
            );
            pruneResults.run(...identity(file));
          }
        });
      };
      return {
        read: (file: SubtitleFile) => attempt(() => visible(read(file))),
        result: (file: SubtitleFile, key: string) => attempt(() => cachedResult(file, key)),
        remember: (
          file: SubtitleFile,
          subtitle: DownloadedSubtitle,
          key?: string,
          timing?: SubtitleTiming,
        ) =>
          attempt(() => {
            const previous = read(file);
            save(file, {
              timing:
                timing ??
                ((key === undefined && previous?.subtitle === null) ||
                (key !== undefined && key === previous?.resultKey)
                  ? previous.timing
                  : DEFAULT_SUBTITLE_TIMING),
              subtitle,
              ...(key ? { resultKey: key } : {}),
            });
          }),
        timing: (file: SubtitleFile, timing: SubtitleTiming, selection?: string) =>
          attempt(() => {
            const previous = read(file);
            if (selection !== undefined && previous?.resultKey !== selection)
              throw new Error("The selected subtitle changed before its timing was saved.");
            save(file, { ...previous, timing, subtitle: previous?.subtitle ?? null });
          }),
        show: (file: SubtitleFile, selection?: string) =>
          attempt(() => {
            const previous = read(file);
            if (previous?.subtitle && previous.resultKey === selection) {
              // Only `false` is stored: a row without the mark shows.
              const { shown, ...row } = previous;
              if (shown === false) save(file, row);
              return;
            }
            const held = selection ? cachedResult(file, selection) : null;
            if (!selection || !held?.subtitle)
              throw new Error("That subtitle is no longer saved for this file.");
            save(file, { timing: held.timing, subtitle: held.subtitle, resultKey: selection });
          }),
        hide: (file: SubtitleFile) =>
          attempt(() => {
            const previous = read(file);
            if (previous?.subtitle && previous.shown !== false)
              save(file, { ...previous, shown: false });
          }),
        forget: (file: SubtitleFile) =>
          attempt(() => {
            transaction(db, () => {
              remove.run(...identity(file));
              // With no replacement selected, Forget also clears caches from older identities.
              removeResults.run(...identity(file), file.account, file.kind, file.id);
            });
          }),
      };
    }).pipe(Effect.catch(() => Effect.succeed(closed("Saved subtitles can't be opened."))));
  }),
);

function closed(detail: string): SavedSubtitles["Service"] {
  const fail = unavailable(detail);
  return {
    read: () => fail,
    result: () => fail,
    remember: () => fail,
    timing: () => fail,
    show: () => fail,
    hide: () => fail,
    forget: () => fail,
  };
}
