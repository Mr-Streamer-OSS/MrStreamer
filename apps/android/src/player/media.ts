import { DEFAULT_NEXT_EPISODE_DELAY } from "@mrstreamer/contracts/preferences";
import { store, type Store } from "../platform/store.ts";
import type { PlayIntent } from "./intent.ts";
import type { NativePlayer, Track } from "./native.ts";
import type { PlayerOwner } from "./player.ts";

export type EpisodeIntent = Extract<PlayIntent, { kind: "title" }> & { readonly media: "episode" };

export interface NextEpisode {
  readonly intent: EpisodeIntent;
  readonly label: string;
}

export type NextEpisodeResolver = (current: EpisodeIntent) => NextEpisode | undefined;

type Choice = Pick<Track, "language" | "label" | "codec" | "height" | "bitrate">;

export interface MediaPreferences {
  readonly speed?: number;
  readonly audio?: Choice;
  readonly text?: Choice | "off";
  readonly quality?: Choice | "automatic";
}

export interface MediaPersistence {
  /** Throws on failed reads, including invalid saved data. */
  read(): MediaPreferences;
  write(value: MediaPreferences): void;
}

export interface MediaState {
  readonly tracksKnown: boolean;
  readonly pip: boolean;
  readonly automatic: boolean;
  readonly next: NextEpisode | null;
  readonly remaining: number | null;
  readonly error: "audio" | "text" | "speed" | "quality" | "save" | "read" | null;
}

/** The designer reads this store with useStore, and invokes these actions on the existing player. */
export interface MediaModel {
  readonly state: Store<MediaState>;
  readonly speeds: readonly number[];
  audio(id: string): Promise<boolean>;
  text(id: string | null): Promise<boolean>;
  quality(id: string | null): Promise<boolean>;
  speed(value: number): Promise<boolean>;
  enterPip(): Promise<boolean>;
  watch(visible: boolean): void;
  reconcile(): void;
  cancelNext(): void;
  playNext(): void;
  registerNext(resolver: NextEpisodeResolver): () => void;
  retryPreferences(): void;
  dismissError(): void;
}

const choice = (track: Track): Choice => ({
  language: track.language,
  label: track.label,
  codec: track.codec,
  height: track.height,
  bitrate: track.bitrate,
});

const matches = (track: Track, saved: Choice) =>
  track.supported &&
  track.language === saved.language &&
  track.label === saved.label &&
  track.codec === saved.codec &&
  track.height === saved.height &&
  track.bitrate === saved.bitrate;

export function mediaModel(
  owner: PlayerOwner,
  native: NativePlayer,
  persistence?: MediaPersistence,
): MediaModel {
  const state = store<MediaState>({
    tracksKnown: false,
    pip: false,
    automatic: true,
    next: null,
    remaining: null,
    error: null,
  });

  const patch = (change: Partial<MediaState>) => state.set((now) => ({ ...now, ...change }));
  let saved: MediaPreferences = {};
  let unread = false;
  let unsaved: MediaPreferences | null = null;

  const read = () => {
    try {
      saved = persistence?.read() ?? {};
      unread = false;
      patch({ error: null });
    } catch {
      unread = true;
      patch({ error: "read" });
    }
  };

  read();
  let resolver: NextEpisodeResolver | undefined;
  let attempt: string | undefined;
  let ended = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  let pending:
    | {
        attempt: string;
        key: keyof MediaPreferences;
        value: Choice | "off" | "automatic" | number;
        id?: string | null;
      }
    | undefined;

  const restored = new Set<string>();

  function cancelNext() {
    if (timer) clearInterval(timer);
    timer = undefined;
    patch({ remaining: null });
  }

  function nextForCurrent() {
    const now = owner.state.get();
    let next: NextEpisode | undefined;

    if (now.kind === "playing" && now.intent.kind === "title" && now.intent.media === "episode") {
      next = resolver?.({ ...now.intent, media: "episode" });
    }

    patch({ next: next ?? null });

    if (now.kind === "playing") void native.setNextAvailable?.(now.attempt, !!next);
  }

  function playNext() {
    const next = state.get().next;
    cancelNext();

    if (next) owner.play(next.intent);
  }

  function save(key: keyof MediaPreferences, value: Choice | "off" | "automatic" | number) {
    const updated = { ...(unsaved ?? saved), [key]: value };

    if (unread) {
      patch({ error: "read" });

      return;
    }

    try {
      persistence?.write(updated);
      saved = updated;
      unsaved = null;
    } catch {
      unsaved = updated;
      patch({ error: "save" });
    }
  }

  owner.state.subscribe(() => {
    const now = owner.state.get();

    if (now.kind === "idle") {
      cancelNext();
      attempt = undefined;
      patch({ next: null, pip: false });

      return;
    }

    if (now.attempt !== attempt) {
      cancelNext();
      attempt = now.attempt;
      ended = false;
      pending = undefined;
      restored.clear();
      patch({ tracksKnown: false, automatic: true });
      nextForCurrent();
    }

    if (now.phase === "playing") ended = false;

    if (now.phase === "paused" || now.phase === "failed") cancelNext();

    if (now.phase === "ended" && !ended) {
      ended = true;
      nextForCurrent();

      if (state.get().next) {
        patch({ remaining: DEFAULT_NEXT_EPISODE_DELAY });
        timer = setInterval(() => {
          const remaining = (state.get().remaining ?? 1) - 1;

          if (remaining <= 0) playNext();
          else patch({ remaining });
        }, 1000);
      }
    }
  });
  native.addListener("onState", (event) => {
    if (event.attempt !== attempt) return;

    void native.setNextAvailable?.(event.attempt, !!state.get().next);

    if (event.qualityAutomatic !== undefined) patch({ automatic: event.qualityAutomatic });

    if (pending?.attempt === attempt && pending.key === "speed" && event.speed === pending.value) {
      save("speed", event.speed);
      pending = undefined;
    }

    if (
      pending?.attempt === attempt &&
      pending.key === "quality" &&
      pending.value === "automatic" &&
      event.qualityAutomatic
    ) {
      save("quality", "automatic");
      pending = undefined;
    }

    if (!event.live && event.phase !== "preparing" && saved.speed && !restored.has("speed")) {
      restored.add("speed");
      void native.setSpeed(event.attempt, saved.speed);
    }
  });
  native.addListener("onTracks", ({ attempt: id, tracks }) => {
    if (id !== attempt) return;
    patch({ tracksKnown: true });
    const request = pending;

    if (request?.attempt === id && request.key !== "speed" && request.value !== "automatic") {
      const selected =
        request.id === null
          ? !tracks.some((t) => t.type === "text" && t.selected)
          : tracks.some((t) => t.id === request.id && t.supported && t.selected);

      if (selected) {
        save(request.key, request.value);
        pending = undefined;
      }
    }

    for (const key of ["audio", "text", "quality"] as const) {
      if (restored.has(key) || pending?.key === key) continue;
      const value = saved[key];

      if (!value) continue;
      const type = key === "quality" ? "video" : key;

      if (value === "off") {
        restored.add(key);
        void native.setText?.(id, null);
        continue;
      }

      if (value === "automatic") {
        restored.add(key);
        continue;
      }

      const match = tracks.find((t) => t.type === type && matches(t, value));

      if (!match) continue;
      restored.add(key);

      if (key === "audio") void native.setAudio?.(id, match.id);
      else if (key === "text") void native.setText?.(id, match.id);
      else if (owner.state.get().kind === "playing") void native.setQuality(id, match.id);
    }
  });
  native.addListener("onMedia", (event) => {
    if (event.attempt === attempt) patch({ pip: event.pip });
  });
  native.addListener("onMediaCommand", (event) => {
    if (event.attempt !== attempt) return;

    if (event.command === "next") playNext();
    else cancelNext();
  });

  async function select(key: "audio" | "text" | "quality", id: string | null) {
    const now = owner.state.get();

    if (now.kind !== "playing") return false;
    const type = key === "quality" ? "video" : key;
    const track = now.tracks.find((t) => t.id === id && t.type === type && t.supported);

    if (
      (id !== null && !track) ||
      (key === "audio" && !track) ||
      (key === "quality" &&
        (!now.live || now.tracks.filter((t) => t.type === "video" && t.supported).length < 2))
    )
      return false;

    const request = {
      attempt: now.attempt,
      key,
      id,
      value: track ? choice(track) : key === "text" ? ("off" as const) : ("automatic" as const),
    };

    pending = request;
    restored.add(key);
    let accepted = false;

    try {
      accepted =
        key === "audio"
          ? ((await native.setAudio?.(now.attempt, id!)) ?? false)
          : key === "text"
            ? ((await native.setText?.(now.attempt, id)) ?? false)
            : await native.setQuality(now.attempt, id);
    } catch {
      /* The refusal is displayed below; no selection is invented. */
    }

    if (!accepted && attempt === now.attempt) {
      if (pending === request) pending = undefined;
      patch({ error: key });
    }

    return accepted;
  }

  return {
    state,
    speeds: [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2],
    audio: (id) => select("audio", id),
    text: (id) => select("text", id),
    quality: (id) => select("quality", id),
    async speed(value) {
      const now = owner.state.get();

      if (
        now.kind !== "playing" ||
        now.live ||
        !Number.isFinite(value) ||
        value < 0.25 ||
        value > 4
      )
        return false;
      const request = { attempt: now.attempt, key: "speed" as const, value };
      pending = request;
      restored.add("speed");
      let accepted = false;

      try {
        accepted = await native.setSpeed(now.attempt, value);
      } catch {
        /* Refused below. */
      }

      if (!accepted && attempt === now.attempt) {
        if (pending === request) pending = undefined;
        patch({ error: "speed" });
      }

      return accepted;
    },
    enterPip: () => native.enterPip?.() ?? Promise.resolve(false),
    watch(visible) {
      if (!visible) cancelNext();
      void native.setWatch?.(visible);
    },
    reconcile() {
      void native.reconcile?.();
    },
    cancelNext,
    playNext,
    registerNext(value) {
      cancelNext();
      resolver = value;
      nextForCurrent();

      return () => {
        if (resolver === value) {
          cancelNext();
          resolver = undefined;
          nextForCurrent();
        }
      };
    },
    retryPreferences() {
      if (unread) read();

      if (unsaved) {
        try {
          persistence?.write(unsaved);
          saved = unsaved;
          unsaved = null;
          patch({ error: null });
        } catch {
          patch({ error: "save" });
        }
      }
    },
    dismissError() {
      patch({ error: null });
    },
  };
}
