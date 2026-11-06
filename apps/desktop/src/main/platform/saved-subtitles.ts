// Downloaded cues and timing belong to an exact listed file, never a movie name or TMDB id.
//
// Each result also notes which bytes it was saved for, when the playback that saved it could prove
// them (`FileProof`): a downloaded copy takes a result along only for the very bytes it holds
// (`duplicate`). The proof is written with the result, in one transaction, by whatever writes its
// cues or timing; a write without proof leaves it with none, so no earlier file's proof stays on
// cues chosen or timed for bytes nobody proved.
import { createHash } from "node:crypto";
import { DEFAULT_PROFILE_ID } from "@mrstreamer/contracts/profiles";
import { AdmittedSettings } from "../services/preferences.ts";
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
import type { FileProof } from "../playback/source-identity.ts";
import { lazy, type Infer } from "@mrstreamer/contracts/lazy";
import { defined } from "@mrstreamer/core/defined";

/** Main-only identity resolved from the current playback session and provider catalogue. */
export interface SubtitleFile {
  readonly account: string;
  readonly sourceStamp: string;
  readonly listingKey: string;
  readonly kind: "movie" | "episode";
  readonly id: string;
}

/**
 * A downloaded copy's own identity for saved subtitles: what was saved for the provider's file it
 * was made from is carried over to it (`duplicate`), and from then on it outlasts that account's
 * login, expiry and erasure, until the copy is deleted.
 */
export function subtitlesOfCopy(
  copyId: string,
  title: { readonly kind: "movie" | "episode"; readonly id: string },
): SubtitleFile {
  return {
    account: `copy:${copyId}`,
    sourceStamp: "copy",
    listingKey: copyId,
    kind: title.kind,
    id: title.id,
  };
}

const Stored = lazy(() => SavedSubtitle().merge({ "resultKey?": "string <= 64" }));

type Stored = Infer<typeof Stored>;

export const SAVED_SUBTITLES_TABLE = "saved_subtitles";
export const SUBTITLE_RESULTS_TABLE = "saved_subtitle_results";

/** Which bytes each result was saved for, by `FileProof`; a copy takes it only for those. */
export const SUBTITLE_PROOFS_TABLE = "saved_subtitle_proofs";

/** The proof key of a selected row without a result key, as a file track's timing. */
const NO_RESULT = "";

const Proof = lazy(() =>
  type({
    size: "number.integer >= 0",
    marks: type({ resource: "string", mark: "string" }).array(),
  }),
);

/** Also prepared by account erasure when no playback service has run. */
export function prepareSavedSubtitles(db: DatabaseSync): void {
  db.exec(`create table if not exists profile_subtitle_choices (
    profile_id text not null, account text not null, kind text not null, id text not null,
    source_stamp text not null, listing_key text not null, choice text not null,
    primary key (profile_id, account, kind, id, source_stamp, listing_key)
  )`);
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
  db.exec(`create table if not exists saved_subtitle_proofs (
    account text not null, kind text not null, id text not null,
    source_stamp text not null, listing_key text not null, result_key text not null,
    proof text not null, primary key (account, kind, id, source_stamp, listing_key, result_key)
  )`);
  db.exec(`create trigger if not exists erase_subtitle_choices after delete on saved_subtitles
    begin delete from profile_subtitle_choices where account = old.account and kind = old.kind and id = old.id
    and source_stamp = old.source_stamp and listing_key = old.listing_key; end`);
}

export class SavedSubtitles extends Context.Service<
  SavedSubtitles,
  {
    read(file: SubtitleFile): Effect.Effect<SavedSubtitle | null, Failed>;
    result(file: SubtitleFile, key: string): Effect.Effect<SavedSubtitle | null, Failed>;
    /**
     * Makes `subtitle` the admitted viewer's selected result, saved for the bytes `proof` says playback
     * read; without a proof, for none.
     */
    remember(
      file: SubtitleFile,
      subtitle: DownloadedSubtitle,
      key?: string,
      timing?: SubtitleTiming,
      proof?: FileProof | null,
    ): Effect.Effect<void, Failed>;
    /** Times the selected result, or a file track, for the bytes `proof` says; or for none. */
    timing(
      file: SubtitleFile,
      timing: SubtitleTiming,
      selection?: string,
      proof?: FileProof | null,
    ): Effect.Effect<void, Failed>;
    /**
     * Makes a saved result the admitted viewer's selected and shown one: the selected row when `selection`
     * names it, else the cached result of that key with its own timing. Fails when neither holds it.
     */
    show(file: SubtitleFile, selection?: string): Effect.Effect<void, Failed>;
    /** Keeps the selected result, its key and timing, but not shown when the file opens again. */
    hide(file: SubtitleFile): Effect.Effect<void, Failed>;
    /** Forgets a removed file or one playback has observed being replaced. */
    forget(file: SubtitleFile): Effect.Effect<void, Failed>;
    /**
     * Keeps for `to`, a downloaded copy, what is saved for `from`, the provider's file it was
     * made from: its selected result, whether it shows, its timing and the cached results, in
     * place of whatever `to` had. Each only when `read`, what the download's own answers said of
     * its bytes, is of the bytes that result was saved for: the same size and, from one same
     * address, the same strong mark. Answers whether anything was kept.
     */
    duplicate(
      from: SubtitleFile,
      to: SubtitleFile,
      read: { readonly resource: string; readonly mark: string; readonly size: number },
    ): Effect.Effect<boolean, Failed>;
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
        select rowid from saved_subtitle_results as result where
        account = ? and kind = ? and id = ? and source_stamp = ? and listing_key = ?
        and result_key != ''
        and not exists (select 1 from profile_subtitle_choices as choice where
          choice.account = result.account and choice.kind = result.kind and choice.id = result.id
          and choice.source_stamp = result.source_stamp and choice.listing_key = result.listing_key
          and json_extract(choice.choice, '$.key') = result.result_key)
        order by rowid desc limit -1 offset 8)`);

      const touchResult = db.prepare(`delete from saved_subtitle_results where
        account = ? and kind = ? and id = ? and source_stamp = ? and listing_key = ? and result_key = ?`);

      const removeResults = db.prepare(`delete from saved_subtitle_results where
        account = ? and kind = ? and id = ? and (
          (source_stamp = ? and listing_key = ?) or not exists (
            select 1 from saved_subtitles where account = ? and kind = ? and id = ?
          )
        )`);

      const selectProof = db.prepare(`select proof from saved_subtitle_proofs where
        account = ? and kind = ? and id = ? and source_stamp = ? and listing_key = ? and result_key = ?`);

      const writeProof = db.prepare(`insert into saved_subtitle_proofs
        (account, kind, id, source_stamp, listing_key, result_key, proof) values (?, ?, ?, ?, ?, ?, ?)
        on conflict (account, kind, id, source_stamp, listing_key, result_key)
        do update set proof = excluded.proof`);

      const removeProof = db.prepare(`delete from saved_subtitle_proofs where
        account = ? and kind = ? and id = ? and source_stamp = ? and listing_key = ? and result_key = ?`);

      const removeProofs = db.prepare(
        `delete from saved_subtitle_proofs where account = ? and kind = ? and id = ?`,
      );

      const removeObsoleteProofs = db.prepare(`delete from saved_subtitle_proofs where
        account = ? and kind = ? and id = ? and (source_stamp != ? or listing_key != ?)`);

      const proofOf = (file: SubtitleFile, key: string) => {
        const row = selectProof.get(...identity(file), key);

        if (!row) return null;

        try {
          const parsed = Proof()(JSON.parse(String(row.proof)));

          return parsed instanceof type.errors ? null : parsed;
        } catch {
          return null;
        }
      };

      const selectResults = db.prepare(`select result_key, saved from saved_subtitle_results where
        account = ? and kind = ? and id = ? and source_stamp = ? and listing_key = ? order by rowid`);

      const removeAll = db.prepare(
        `delete from saved_subtitles where account = ? and kind = ? and id = ?`,
      );

      const removeAllResults = db.prepare(
        `delete from saved_subtitle_results where account = ? and kind = ? and id = ?`,
      );

      const removeObsoleteResults = db.prepare(`delete from saved_subtitle_results where
        account = ? and kind = ? and id = ? and (source_stamp != ? or listing_key != ?)`);

      const identity = (file: SubtitleFile) =>
        [file.account, file.kind, file.id, file.sourceStamp, file.listingKey] as const;

      const legacyRead = (file: SubtitleFile): Stored | null => {
        const row = select.get(...identity(file));

        if (!row) return null;

        return Stored().assert(JSON.parse(String(row.saved)));
      };

      /** A result as the cache keeps it: cues, timing and key. Whether it shows is the selection's. */
      const result = (saved: Stored): SavedSubtitle => ({
        timing: saved.timing,
        subtitle: saved.subtitle,
        ...defined({ selection: saved.resultKey || undefined }),
      });

      const visible = (saved: Stored | null): SavedSubtitle | null =>
        saved
          ? { ...result(saved), ...defined({ shown: saved.shown === false ? false : undefined }) }
          : null;

      const cachedResult = (file: SubtitleFile, key: string): SavedSubtitle | null => {
        const row = cached.get(...identity(file), key);

        if (!row) return null;

        return SavedSubtitle().assert(JSON.parse(String(row.saved)));
      };

      // Choices hold references only. Cue bytes, proof and timing stay in the file cache.
      const Choice = type({ key: "string | null", "selection?": "string", "shown?": "false" });

      const internalKey = (saved: Stored) =>
        saved.resultKey ??
        (saved.subtitle
          ? createHash("sha256").update(JSON.stringify(saved.subtitle)).digest("hex")
          : null);

      const choiceRow = db.prepare(`select choice from profile_subtitle_choices where
        profile_id = ? and account = ? and kind = ? and id = ? and source_stamp = ? and listing_key = ?`);

      const writeChoice = db.prepare(`insert into profile_subtitle_choices
        (profile_id, account, kind, id, source_stamp, listing_key, choice) values (?, ?, ?, ?, ?, ?, ?)
        on conflict (profile_id, account, kind, id, source_stamp, listing_key) do update set choice = excluded.choice`);

      const choose = (owner: string, file: SubtitleFile, saved: Stored) =>
        writeChoice.run(
          owner,
          ...identity(file),
          JSON.stringify({
            key: internalKey(saved),
            ...defined({ selection: saved.resultKey, shown: saved.shown }),
          }),
        );

      const seedDefault = (file: SubtitleFile) => {
        const row = choiceRow.get(DEFAULT_PROFILE_ID, ...identity(file));
        const legacy = legacyRead(file);

        // Older builds kept embedded timing in the selected row. Migrate it once to the
        // shared file-track slot before Default's downloaded choice can replace that row.
        // A null Default choice instead marks a compatibility placeholder, not saved file timing.
        if (
          legacy?.subtitle === null &&
          (!row || JSON.parse(String(row.choice)) !== null) &&
          !cachedResult(file, NO_RESULT)
        )
          rememberResult.run(...identity(file), NO_RESULT, JSON.stringify(result(legacy)));

        if (row) return;

        if (!legacy) {
          writeChoice.run(DEFAULT_PROFILE_ID, ...identity(file), "null");

          return;
        }

        const key = internalKey(legacy);

        if (key) {
          rememberResult.run(...identity(file), key, JSON.stringify(result(legacy)));
          // Legacy unkeyed cues used the file-track slot before personal choices had references.
          const proof = legacy.resultKey === undefined ? proofOf(file, NO_RESULT) : null;

          if (proof) writeProof.run(...identity(file), key, JSON.stringify(proof));
        }

        choose(DEFAULT_PROFILE_ID, file, legacy);
      };

      const read = (file: SubtitleFile, owner: string): Stored | null => {
        seedDefault(file);
        const row = choiceRow.get(owner, ...identity(file));

        if (!row) return cachedResult(file, NO_RESULT);
        const parsed: unknown = JSON.parse(String(row.choice));

        if (parsed === null) return cachedResult(file, NO_RESULT);
        const choice = Choice.assert(parsed);
        const held = cachedResult(file, choice.key ?? NO_RESULT);

        if (!held) return null;

        return {
          subtitle: choice.key === null ? null : held.subtitle,
          timing: held.timing,
          ...defined({ resultKey: choice.selection, shown: choice.shown }),
        };
      };

      const personal = <A>(work: (owner: string) => A) =>
        Effect.gen(function* () {
          const admitted = yield* Effect.serviceOption(AdmittedSettings);

          return yield* attempt(() => {
            if (admitted._tag === "Some" && !admitted.value.current())
              throw new Error("Viewing profile changed; retry this subtitle choice.");
            const owner = admitted._tag === "Some" ? admitted.value.owner.id : DEFAULT_PROFILE_ID;

            if (
              db
                .prepare("select 1 from sqlite_master where type = 'table' and name = 'profiles'")
                .get()
            ) {
              db.exec(`create trigger if not exists delete_profile_subtitle_choices after delete on profiles
              begin delete from profile_subtitle_choices where profile_id = old.id; end`);
              const registered = db.prepare("select * from profiles where id = ?").get(owner);

              if (!registered || registered["deleting"] === 1)
                throw new Error("This viewing profile is unavailable or being deleted.");
            }

            return transaction(db, () => work(owner));
          });
        });

      /**
       * Saves the file's selected row. `proved` says which bytes its cues and timing are of now,
       * by its result key; without it, what is proven of it stays as it was.
       */
      const save = (
        file: SubtitleFile,
        saved: Stored,
        owner: string,
        proved?: { readonly proof: FileProof | null },
      ) => {
        const checked = Stored().assert(saved);
        const proof = proved?.proof ? JSON.stringify(Proof().assert(proved.proof)) : null;
        const key = internalKey(checked) ?? NO_RESULT;
        seedDefault(file);
        db.prepare(
          `delete from profile_subtitle_choices where account = ? and kind = ? and id = ?
          and (source_stamp != ? or listing_key != ?)`,
        ).run(...identity(file));
        removeObsoleteResults.run(...identity(file));
        removeObsoleteProofs.run(...identity(file));

        if (proved) {
          removeProof.run(...identity(file), key);

          if (proof !== null) writeProof.run(...identity(file), key, proof);
        }

        choose(owner, file, checked);

        // The empty result key holds shared embedded timing, independently of Default's
        // legacy selected row. It is not a downloaded result and never ages out with those.
        touchResult.run(...identity(file), key);
        rememberResult.run(...identity(file), key, JSON.stringify(result(checked)));
        pruneResults.run(...identity(file));

        // Older builds read this row as Default's choice. Other viewers only change references
        // and shared result timing; compose Default again after updating those shared bytes.
        const legacy = owner === DEFAULT_PROFILE_ID ? checked : read(file, DEFAULT_PROFILE_ID);
        write.run(
          ...identity(file),
          JSON.stringify(legacy ?? { subtitle: null, timing: checked.timing }),
        );
      };

      return {
        read: (file: SubtitleFile) => personal((owner) => visible(read(file, owner))),
        result: (file: SubtitleFile, key: string) => attempt(() => cachedResult(file, key)),
        remember: (
          file: SubtitleFile,
          subtitle: DownloadedSubtitle,
          key?: string,
          timing?: SubtitleTiming,
          proof: FileProof | null = null,
        ) =>
          personal((owner) => {
            const previous = read(file, owner);
            save(
              file,
              {
                timing:
                  timing ??
                  ((key === undefined && previous?.subtitle === null) ||
                  (key !== undefined && key === previous?.resultKey)
                    ? previous.timing
                    : DEFAULT_SUBTITLE_TIMING),
                subtitle,
                ...defined({ resultKey: key || undefined }),
              },
              owner,
              { proof },
            );
          }),
        timing: (
          file: SubtitleFile,
          timing: SubtitleTiming,
          selection?: string,
          proof: FileProof | null = null,
        ) =>
          personal((owner) => {
            const previous = read(file, owner);

            if (selection !== undefined && previous?.resultKey !== selection)
              throw new Error("The selected subtitle changed before its timing was saved.");
            save(file, { ...previous, timing, subtitle: previous?.subtitle ?? null }, owner, {
              proof,
            });
          }),
        show: (file: SubtitleFile, selection?: string) =>
          personal((owner) => {
            const previous = read(file, owner);

            if (previous?.subtitle && previous.resultKey === selection) {
              // Only `false` is stored: a row without the mark shows.
              const { shown, ...row } = previous;

              if (shown === false) save(file, row, owner);

              return;
            }

            const held = selection ? cachedResult(file, selection) : null;

            if (!selection || !held?.subtitle)
              throw new Error("That subtitle is no longer saved for this file.");
            save(
              file,
              { timing: held.timing, subtitle: held.subtitle, resultKey: selection },
              owner,
            );
          }),
        hide: (file: SubtitleFile) =>
          personal((owner) => {
            const previous = read(file, owner);

            if (previous?.subtitle && previous.shown !== false)
              save(file, { ...previous, shown: false }, owner);
          }),
        duplicate: (
          from: SubtitleFile,
          to: SubtitleFile,
          bytes: { readonly resource: string; readonly mark: string; readonly size: number },
        ) =>
          attempt(() => {
            /** Whether the result of `key` was saved for the very bytes the copy holds. */
            const proven = (key: string) => {
              const proof = proofOf(from, key);

              return (
                proof !== null &&
                proof.size === bytes.size &&
                proof.marks.some(
                  (each) => each.resource === bytes.resource && each.mark === bytes.mark,
                )
              );
            };

            seedDefault(from);

            const choices = db
              .prepare(
                `select profile_id, choice from profile_subtitle_choices where
              account = ? and kind = ? and id = ? and source_stamp = ? and listing_key = ?`,
              )
              .all(...identity(from))
              .filter((each) => {
                const parsed: unknown = JSON.parse(String(each.choice));

                if (parsed === null) return true;
                const choice = Choice.assert(parsed);

                return proven(choice.key ?? NO_RESULT);
              });

            const row = select.get(...identity(from));

            const selected =
              row && proven(internalKey(legacyRead(from)!) ?? NO_RESULT) ? String(row.saved) : null;

            const results = selectResults
              .all(...identity(from))
              .filter((each) => proven(String(each.result_key)));

            transaction(db, () => {
              removeAll.run(to.account, to.kind, to.id);
              db.prepare(
                `delete from profile_subtitle_choices where account = ? and kind = ? and id = ?`,
              ).run(to.account, to.kind, to.id);
              removeAllResults.run(to.account, to.kind, to.id);

              if (selected !== null) write.run(...identity(to), selected);
              // A copy's shared row is not a legacy Default choice, even if only another
              // viewer's result was proven for its bytes.
              writeChoice.run(DEFAULT_PROFILE_ID, ...identity(to), "null");

              for (const each of choices)
                writeChoice.run(String(each.profile_id), ...identity(to), String(each.choice));

              for (const each of results) {
                rememberResult.run(...identity(to), String(each.result_key), String(each.saved));
              }
            });

            return selected !== null || results.length > 0;
          }),
        forget: (file: SubtitleFile) =>
          attempt(() => {
            transaction(db, () => {
              remove.run(...identity(file));
              db.prepare(
                `delete from profile_subtitle_choices where
                account = ? and kind = ? and id = ? and source_stamp = ? and listing_key = ?`,
              ).run(...identity(file));
              // With no replacement selected, Forget also clears caches from older identities.
              removeResults.run(...identity(file), file.account, file.kind, file.id);
              removeProofs.run(file.account, file.kind, file.id);
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
    duplicate: () => fail,
  };
}
