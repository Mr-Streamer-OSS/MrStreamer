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
  readonly error: keyof MediaPreferences | "save" | "read" | null;
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

/** A change asked of the native player, saved once the player reports it. */
interface Request {
  readonly attempt: string;
  readonly key: keyof MediaPreferences;
  readonly value: NonNullable<MediaPreferences[keyof MediaPreferences]>;
  /** The track asked for, or null for none; speed has none. */
  readonly id?: string | null;
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
  let pending: Request | undefined;
  const restored = new Set<keyof MediaPreferences>();

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

  /** Writes `value`; a failed write keeps the saved data and leaves `value` for a retry. */
  function persist(value: MediaPreferences) {
    try {
      persistence?.write(value);
      saved = value;
      unsaved = null;

      return true;
    } catch {
      unsaved = value;
      patch({ error: "save" });

      return false;
    }
  }

  /** Saves the pending change the player now reports. A failed read is never overwritten. */
  function settle() {
    if (!pending) return;
    const { key, value } = pending;
    pending = undefined;

    if (unread) patch({ error: "read" });
    else persist({ ...(unsaved ?? saved), [key]: value });
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

    // Speed and Automatic quality are reported here, tracks by onTracks.
    if (
      pending?.attempt === attempt &&
      (pending.key === "speed"
        ? event.speed === pending.value
        : pending.key === "quality" && pending.value === "automatic" && event.qualityAutomatic)
    )
      settle();

    if (!event.live && event.phase !== "preparing" && saved.speed && !restored.has("speed")) {
      restored.add("speed");
      void native.setSpeed(event.attempt, saved.speed);
    }
  });
  native.addListener("onTracks", ({ attempt: id, tracks }) => {
    if (id !== attempt) return;
    patch({ tracksKnown: true });

    if (pending?.attempt === id && pending.key !== "speed" && pending.value !== "automatic") {
      const chosen = pending.id;

      const selected =
        chosen === null
          ? !tracks.some((t) => t.type === "text" && t.selected)
          : tracks.some((t) => t.id === chosen && t.supported && t.selected);

      if (selected) settle();
    }

    // Saved choices apply once per attempt, by identity, to the first tracks that match them.
    for (const key of ["audio", "text", "quality"] as const) {
      const value = saved[key];

      if (!value || restored.has(key) || pending?.key === key) continue;

      if (value === "off" || value === "automatic") {
        restored.add(key);

        if (value === "off") void native.setText?.(id, null);
        continue;
      }

      const type = key === "quality" ? "video" : key;
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

  /** Asks for `request` through `change`; a refusal while its attempt plays is shown. */
  async function ask(request: Request, change: () => Promise<boolean> | undefined) {
    pending = request;
    restored.add(request.key);
    let accepted = false;

    try {
      accepted = (await change()) ?? false;
    } catch {
      /* Refused below; no selection is invented. */
    }

    if (!accepted && attempt === request.attempt) {
      if (pending === request) pending = undefined;
      patch({ error: request.key });
    }

    return accepted;
  }

  async function select(key: "audio" | "text" | "quality", id: string | null) {
    const now = owner.state.get();

    if (now.kind !== "playing") return false;
    const type = key === "quality" ? "video" : key;
    const choices = now.tracks.filter((t) => t.type === type && t.supported);
    const track = choices.find((t) => t.id === id);

    if (id !== null && !track) return false;
    const { attempt: at } = now;

    if (key === "audio")
      return track
        ? ask({ attempt: at, key, id, value: choice(track) }, () => native.setAudio?.(at, track.id))
        : false;

    if (key === "text")
      return ask({ attempt: at, key, id, value: track ? choice(track) : "off" }, () =>
        native.setText?.(at, id),
      );

    // Quality is Live's, and only where the provider offers a real choice.
    if (!now.live || choices.length < 2) return false;

    return ask({ attempt: at, key, id, value: track ? choice(track) : "automatic" }, () =>
      native.setQuality(at, id),
    );
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

      return ask({ attempt: now.attempt, key: "speed", value }, () =>
        native.setSpeed(now.attempt, value),
      );
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

      if (unsaved && persist(unsaved)) patch({ error: null });
    },
    dismissError() {
      patch({ error: null });
    },
  };
}
