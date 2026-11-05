import type { Json } from "@mrstreamer/contracts/json";
import {
  DEFAULT_SUBTITLE_TIMING,
  SavedSubtitle,
  SubtitleTiming,
  type DownloadedSubtitle,
} from "@mrstreamer/contracts/online-subtitles";
import { type } from "arktype";
import { store } from "../platform/store.ts";
import type { SecretStore } from "../guide/secrets.ts";
import type { NativePlayer } from "../player/native.ts";
import type { PlayerOwner } from "../player/player.ts";
import {
  subdlDownload,
  subdlSearch,
  SubtitleFailure,
  type Candidate,
  type FoundSubtitle,
  type SubtitleFailureReason,
  type SubtitleQuery,
} from "./service.ts";

export const SIDECAR_TRACK = "mrstreamer-downloaded-subtitle";
const KEY = "online-subtitles.subdl";

export interface SubtitleTitle {
  /** Same identity for an exact provider version and its downloaded copy. Never a path. */
  readonly key: string;
  readonly query: SubtitleQuery;
}

export interface SubtitleFiles {
  read(key: string): Json;
  write(key: string, value: SavedSubtitle): void;
  remove(key: string): void;
}

export interface SubtitleState {
  readonly title: SubtitleTitle | null;
  readonly keySaved: boolean | null;
  readonly saved: SavedSubtitle | null;
  readonly shown: boolean;
  readonly phase: "idle" | "searching" | "found" | "downloading";
  readonly downloading: string | null;
  readonly languages: readonly string[];
  readonly results: readonly FoundSubtitle[];
  readonly unsupported: readonly string[];
  readonly error: SubtitleFailureReason | null;
}

const FPS = [
  { fps: 24000 / 1001, name: "23.976" },
  { fps: 24, name: "24" },
  { fps: 25, name: "25" },
];

export const FRAME_RATES = [
  { label: "Original", speed: 1 },
  ...FPS.flatMap((from) =>
    FPS.flatMap((to) =>
      from === to ? [] : [{ label: `${from.name} → ${to.name} fps`, speed: from.fps / to.fps }],
    ),
  ),
];

export const TIMING_STEPS = [-1, -0.1, 0.1, 1] as const;

/** One play's work is cancelled before another play or selection can use it. Errors contain reasons only. */
export function subtitleModel(options: {
  player: Pick<PlayerOwner, "state"> & { media: Pick<PlayerOwner["media"], "text"> };
  native: Pick<NativePlayer, "setSidecar" | "setText" | "unpackSubtitle" | "setSubtitleInset">;
  secrets: SecretStore;
  files: SubtitleFiles;
  title: (intent: Parameters<PlayerOwner["play"]>[0]) => Promise<SubtitleTitle | null>;
  languages: () => readonly string[];
}) {
  const { player, native, secrets, files } = options;

  const state = store<SubtitleState>({
    title: null,
    keySaved: null,
    saved: null,
    shown: false,
    phase: "idle",
    downloading: null,
    languages: [],
    results: [],
    unsupported: [],
    error: null,
  });

  const patch = (value: Partial<SubtitleState>) => state.set((old) => ({ ...old, ...value }));
  let attempt: string | undefined;
  let work = new AbortController();
  let candidates: readonly Candidate[] = [];
  let search = 0;
  let unread = false;
  let timingQueue = Promise.resolve(false);
  let loaded: SavedSubtitle | undefined;
  let resolveTitle: (() => Promise<void>) | undefined;
  let retrySave: (() => Promise<void>) | undefined;

  const cancel = () => {
    work.abort();
    work = new AbortController();
    patch({ phase: "idle", downloading: null });
  };

  const fail = (reason: SubtitleFailureReason) => patch({ error: reason });

  function persist(value: SavedSubtitle) {
    const title = state.get().title;

    if (!title || unread) {
      fail("read");

      return false;
    }

    try {
      files.write(title.key, value);
      retrySave = undefined;
      patch({ saved: value, error: null });

      return true;
    } catch {
      retrySave = async () => {
        if (persist(value) && value.shown !== false) await apply(value);
      };

      fail("not-saved");

      return false;
    }
  }

  async function apply(value: SavedSubtitle) {
    const now = player.state.get();

    if (now.kind !== "playing" || now.attempt !== attempt || !value.subtitle) return false;

    if (
      loaded?.subtitle === value.subtitle &&
      loaded.timing.offset === value.timing.offset &&
      loaded.timing.speed === value.timing.speed
    )
      return !!(await native.setText?.(now.attempt, SIDECAR_TRACK));
    let ok = false;

    try {
      ok = !!(await native.setSidecar?.(
        now.attempt,
        asVtt(value.subtitle),
        value.subtitle.language,
        value.timing.offset,
        value.timing.speed,
      ));
    } catch {
      // A refusal either way.
    }

    if (attempt !== now.attempt) return false;

    if (ok) loaded = value;
    else fail("timing");

    return ok;
  }

  let restoring: Promise<void> | undefined;

  function restore(): Promise<void> {
    if (restoring) return restoring;

    const pending = restoreFile().finally(() => {
      if (restoring === pending) restoring = undefined;
    });

    restoring = pending;

    return pending;
  }

  async function restoreFile() {
    const title = state.get().title;

    if (!title) return;

    try {
      const raw = files.read(title.key);
      const parsed = raw === null ? null : SavedSubtitle()(raw);

      if (parsed instanceof type.errors) throw new Error("read");
      unread = false;
      patch({ saved: parsed, error: null });

      if (parsed?.subtitle && parsed.shown !== false) await apply(parsed);
    } catch {
      unread = true;
      fail("read");
    }
  }

  let restorePending = false;

  function observe() {
    const now = player.state.get();

    if (now.kind !== "playing") {
      if (attempt) {
        cancel();
        attempt = undefined;
        patch({ title: null, saved: null, shown: false });
      }

      return;
    }

    const shown = now.tracks.some((track) => track.id === SIDECAR_TRACK && track.selected);

    if (state.get().shown !== shown) patch({ shown });

    if (now.attempt === attempt) {
      if (restorePending && now.phase !== "resolving" && now.phase !== "preparing") {
        restorePending = false;
        void restore();
      }

      return;
    }

    cancel();
    restorePending = false;
    retrySave = undefined;
    candidates = [];
    search++;
    attempt = now.attempt;
    const forAttempt = attempt;
    patch({ title: null, saved: null, shown: false, results: [], unsupported: [], error: null });
    loaded = undefined;
    restoring = undefined;
    resolveTitle = () =>
      options
        .title(now.intent)
        .then(async (title) => {
          if (attempt !== forAttempt) return;
          patch({ title });
          const current = player.state.get();

          if (current.kind !== "playing" || current.attempt !== forAttempt) return;

          if (current.phase === "resolving" || current.phase === "preparing") restorePending = true;
          else await restore();
        })
        .catch(() => {
          if (attempt === forAttempt) fail("read");
        });
    void resolveTitle();
  }

  player.state.subscribe(observe);
  observe();

  async function readKey() {
    try {
      patch({ keySaved: !!(await secrets.read(KEY)), error: null });
    } catch {
      patch({ keySaved: null, error: "keychain" });
    }
  }

  async function saveKey(value: string) {
    if (!value.trim() || value.trim().length > 4096) {
      fail("keychain");

      return false;
    }

    try {
      await secrets.write(KEY, value.trim());
      patch({ keySaved: true, error: null });

      return true;
    } catch {
      fail("keychain");

      return false;
    }
  }

  async function removeKey() {
    cancel();
    candidates = [];
    search++;
    patch({ results: [], unsupported: [] });

    try {
      await secrets.remove(KEY);
      patch({ keySaved: false, error: null });

      return true;
    } catch {
      fail("keychain");

      return false;
    }
  }

  async function find() {
    const title = state.get().title;

    if (!title) return;
    cancel();
    const signal = work.signal;
    const id = ++search;
    candidates = [];

    let languages: readonly string[];

    try {
      languages = [...new Set(options.languages().filter((value) => /^[a-z]{2,3}$/.test(value)))];
    } catch {
      fail("read");

      return;
    }

    patch({ phase: "searching", languages, results: [], unsupported: [], error: null });

    try {
      let key: string | null;

      try {
        key = await secrets.read(KEY);
      } catch {
        throw new SubtitleFailure("keychain");
      }

      if (signal.aborted) return;
      patch({ keySaved: !!key });

      if (!key) throw new SubtitleFailure("not-configured");
      const found = await subdlSearch(key, { ...title.query, languages }, signal);

      if (signal.aborted) return;
      candidates = found.candidates;
      patch({
        phase: "found",
        unsupported: found.unsupported,
        results: candidates.map(({ url: _url, ...result }, index) => ({
          ...result,
          id: `${id}.${index}`,
        })),
      });
    } catch (error) {
      if (!signal.aborted)
        patch({
          phase: "idle",
          error: error instanceof SubtitleFailure ? error.reason : "unavailable",
        });
    }
  }

  async function choose(id: string) {
    if (state.get().downloading === id) {
      cancel();

      return;
    }

    const [round, index] = id.split(".").map(Number);
    const candidate = round === search ? candidates[index ?? -1] : undefined;

    if (!candidate) return;
    cancel();
    const signal = work.signal;
    patch({ phase: "downloading", downloading: id, error: null });

    try {
      const subtitle = await subdlDownload(candidate, signal, (bytes) => {
        if (!native.unpackSubtitle) throw new SubtitleFailure("unsupported");

        return native.unpackSubtitle(bytes);
      });

      if (signal.aborted) return;
      const saved = { subtitle, timing: DEFAULT_SUBTITLE_TIMING, shown: true };

      const kept = persist(saved);

      if (kept) await apply(saved);

      if (!signal.aborted) patch({ phase: "idle", downloading: null });

      return kept && !signal.aborted;
    } catch (error) {
      if (!signal.aborted)
        patch({
          phase: "found",
          downloading: null,
          error: error instanceof SubtitleFailure ? error.reason : "unsupported",
        });
    }
  }

  async function select(id: string | null) {
    cancel();
    const saved = state.get().saved;
    const title = state.get().title;
    const forAttempt = attempt;

    if (id === SIDECAR_TRACK)
      return saved ? persist({ ...saved, shown: true }) && (await apply(saved)) : false;

    const hidden = saved ? { ...saved, shown: false } : null;

    if (hidden && !persist(hidden)) {
      retrySave = async () => {
        await select(id);
      };

      fail("selection-save");

      return false;
    }

    const ok = await player.media.text(id);

    if (
      !ok &&
      saved &&
      attempt === forAttempt &&
      state.get().title === title &&
      state.get().saved === hidden
    )
      persist(saved);

    return ok;
  }

  async function timing(value: SubtitleTiming) {
    const parsed = SubtitleTiming()(value);
    const saved = state.get().saved;

    if (parsed instanceof type.errors) {
      fail("timing-limit");

      return false;
    }

    if (!saved) return false;
    const updated = { ...saved, timing: parsed };

    if (!persist(updated)) return false;

    if (saved.shown === false || (await apply(updated))) return true;

    // Putting the previous timing back clears the error, which the viewer still needs to see.
    if (state.get().saved === updated && persist(saved)) fail("timing");

    return false;
  }

  function scheduleTiming(change: (previous: SubtitleTiming) => SubtitleTiming) {
    const forAttempt = attempt;
    timingQueue = timingQueue.then(() => {
      const saved = state.get().saved;

      return saved && attempt === forAttempt ? timing(change(saved.timing)) : false;
    });

    return timingQueue;
  }

  return {
    state,
    async inset(fraction: number) {
      if (!Number.isFinite(fraction) || fraction < 0 || fraction > 0.8) return false;

      try {
        await native.setSubtitleInset?.(fraction);

        return true;
      } catch {
        return false;
      }
    },
    find,
    choose,
    select,
    timing: (value: SubtitleTiming) => scheduleTiming(() => value),
    saveKey,
    removeKey,
    readKey,
    cancel,
    retry: () =>
      retrySave ? retrySave() : !state.get().title && resolveTitle ? resolveTitle() : restore(),
    dismissError: () => patch({ error: null }),
    show: () => select(SIDECAR_TRACK),
    shift: (seconds: number) =>
      scheduleTiming((previous) => ({
        ...previous,
        offset: Math.round((previous.offset + seconds) * 10) / 10,
      })),
    reset: () => scheduleTiming(() => DEFAULT_SUBTITLE_TIMING),
    async removeRetained() {
      cancel();
      const title = state.get().title;

      if (!title) return false;

      try {
        files.remove(title.key);
        patch({ saved: null, error: null });

        return true;
      } catch {
        fail("not-saved");

        return false;
      }
    },
  };
}

export type SubtitleModel = ReturnType<typeof subtitleModel>;

/** Canonical WebVTT goes to native; timing is deliberately left to the native owner. */
function asVtt(subtitle: DownloadedSubtitle) {
  const clock = (seconds: number) => {
    const ms = Math.round(seconds * 1000);

    return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
  };

  return `WEBVTT\n\n${subtitle.cues.map((cue) => `${clock(cue.start)} --> ${clock(cue.end)}\n${cue.text}\n`).join("\n")}`;
}
