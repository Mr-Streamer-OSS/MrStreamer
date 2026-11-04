import { DEFAULT_NEXT_EPISODE_DELAY } from "@mrstreamer/contracts/preferences";
import type { OfflineNext } from "../downloads/offline-next.ts";
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

export type MediaPreferences = {
  readonly speed?: number;
  readonly audio?: Choice;
  readonly text?: Choice | "off";
  readonly quality?: Choice | "automatic";
};

export interface MediaPersistence {
  /** Throws on failed reads, including invalid saved data. */
  read(): MediaPreferences;
  write(value: MediaPreferences): void;
}

export interface MediaState {
  readonly offline?: OfflineNext | null;
  readonly tracksKnown: boolean;
  readonly pip: boolean;
  readonly pipSupported: boolean;
  readonly automatic: boolean;
  readonly next: NextEpisode | null;
  readonly remaining: number | null;
  readonly error: keyof MediaPreferences | "save" | "read" | null;
}

/** The designer reads this store with useStore, and invokes these actions on the existing player. */
export interface MediaModel {
  readonly state: Store<MediaState>;
  readonly watching: boolean;
  readonly speeds: readonly number[];
  audio(id: string): Promise<boolean>;
  text(id: string | null): Promise<boolean>;
  quality(id: string | null): Promise<boolean>;
  speed(value: number): Promise<boolean>;
  enterPip(): Promise<boolean>;
  watch(visible: boolean): void;
  reconcile(): void;
  admitted(attempt: string): void;
  cancelNext(): void;
  playNext(): void;
  registerOfflineNext(resolve: (path: string) => Promise<OfflineNext>): () => void;
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

function preferred(tracks: readonly Track[], saved: Choice, type: Track["type"]) {
  const candidates = tracks.filter((t) => t.supported && t.type === type);

  if (type === "video") {
    let pool = candidates.filter((t) => saved.height !== null && t.height === saved.height);

    for (const key of ["label", "codec", "bitrate"] as const) {
      const matches = pool.filter((t) => t[key] === saved[key]);

      if (matches.length) pool = matches;
    }

    return pool[0];
  }

  const language = candidates.filter((t) => t.language === saved.language);
  const labels = language.filter((t) => t.label === saved.label);
  const pool = labels.length ? labels : language;

  return pool.find((t) => t.codec === saved.codec) ?? pool[0];
}

export function mediaModel(
  owner: PlayerOwner,
  native: NativePlayer,
  persistence?: MediaPersistence,
): MediaModel {
  const state = store<MediaState>({
    offline: null,
    tracksKnown: false,
    pip: false,
    pipSupported: native.pipSupported?.() ?? false,
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
  let offlineResolver: ((path: string) => Promise<OfflineNext>) | undefined;
  let attempt: string | undefined;
  let ended = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const pending = new Map<keyof MediaPreferences, Request>();
  const confirmations = new Set<Request>();
  let watching = false;
  let cancelled: string | undefined;
  let admitted: string | undefined;
  let nextSent: string | undefined;
  const restored = new Set<keyof MediaPreferences>();

  let offlineRequest = 0;

  function cancelNext() {
    offlineRequest++;

    if (timer || ended) cancelled = attempt;

    if (timer) clearInterval(timer);
    timer = undefined;
    patch({ remaining: null });
  }

  function nextForCurrent() {
    const now = owner.state.get();
    let next: NextEpisode | undefined;

    if (now.kind === "playing" && now.intent.kind === "title" && now.intent.media === "episode") {
      try {
        next = resolver?.({ ...now.intent, media: "episode" });
      } catch {
        next = undefined;
      }
    }

    patch({ next: next ?? null });

    if (now.kind === "playing" && now.attempt === admitted) {
      const signature = `${now.attempt}:${!!next}`;

      if (signature !== nextSent) {
        nextSent = signature;
        void native.setNextAvailable?.(now.attempt, !!next);
      }
    }
  }

  function playNext() {
    const next = state.get().next;
    cancelNext();

    const now = owner.state.get();

    if (now.kind === "playing" && now.intent.kind === "file" && offlineResolver) {
      const attempt = now.attempt;
      const request = offlineRequest;
      void offlineResolver(now.intent.path)
        .then((result) => {
          const current = owner.state.get();

          if (
            current.kind !== "playing" ||
            current.attempt !== attempt ||
            request !== offlineRequest
          )
            return;
          patch({ offline: result });

          if (result.kind === "ready")
            owner.play({ kind: "file", path: result.path, title: result.row.title });
        })
        .catch(() => patch({ offline: { kind: "read" } }));
    } else if (next) owner.play(next.intent);
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
  function settle(request: Request) {
    if (!confirmations.has(request) || pending.get(request.key) !== request) return;
    pending.delete(request.key);
    confirmations.delete(request);

    if (unread) patch({ error: "read" });
    else persist({ ...(unsaved ?? saved), [request.key]: request.value });
  }

  function reconcilePending() {
    const now = owner.state.get();

    if (now.kind !== "playing") return;

    for (const request of pending.values()) {
      if (request.attempt !== now.attempt) continue;

      const selected =
        request.key === "speed"
          ? typeof request.value === "number" && Math.abs(now.speed - request.value) < 0.001
          : request.value === "automatic"
            ? state.get().automatic
            : request.id === null
              ? !now.tracks.some((t) => t.type === "text" && t.selected)
              : now.tracks.some((t) => t.id === request.id && t.supported && t.selected);

      if (selected) settle(request);
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
      pending.clear();
      confirmations.clear();
      cancelled = undefined;
      restored.clear();
      patch({ tracksKnown: false, automatic: true, offline: null });
      nextForCurrent();
    }

    if (now.phase === "playing") {
      ended = false;
      cancelled = undefined;
    }

    if (now.phase === "paused" || now.phase === "failed") cancelNext();

    if (now.phase === "ended" && !ended) {
      ended = true;
      nextForCurrent();

      if (now.intent.kind === "file" && offlineResolver) {
        const id = now.attempt;
        void offlineResolver(now.intent.path)
          .then((result) => {
            const current = owner.state.get();

            if (current.kind !== "playing" || current.attempt !== id) return;
            patch({ offline: result });

            if (watching && result.kind === "ready" && cancelled !== id) {
              let remaining = DEFAULT_NEXT_EPISODE_DELAY;
              patch({ remaining });
              timer = setInterval(() => {
                if (--remaining <= 0) playNext();
                else patch({ remaining });
              }, 1000);
            }
          })
          .catch(() => patch({ offline: { kind: "read" } }));
      }

      if (watching && cancelled !== attempt && state.get().next) {
        const deadline = Date.now() + DEFAULT_NEXT_EPISODE_DELAY * 1000;
        patch({ remaining: DEFAULT_NEXT_EPISODE_DELAY });
        timer = setInterval(() => {
          const remaining = Math.ceil((deadline - Date.now()) / 1000);

          if (remaining <= 0) playNext();
          else patch({ remaining });
        }, 1000);
      }
    }
  });
  native.addListener("onState", (event) => {
    if (event.attempt !== attempt) return;

    if (event.qualityAutomatic !== undefined) patch({ automatic: event.qualityAutomatic });
    reconcilePending();

    if (!event.live && event.phase !== "preparing" && saved.speed && !restored.has("speed")) {
      restored.add("speed");
      void native.setSpeed(event.attempt, saved.speed);
    }
  });
  native.addListener("onTracks", ({ attempt: id, tracks }) => {
    if (id !== attempt) return;
    patch({ tracksKnown: true });

    reconcilePending();

    // Saved choices apply once per attempt, by identity, to the first tracks that match them.
    for (const key of ["audio", "text", "quality"] as const) {
      if (
        key === "text" &&
        owner.subtitles?.state.get().saved?.shown !== false &&
        owner.subtitles?.state.get().saved?.subtitle
      ) {
        restored.add("text");
        continue;
      }

      const value = saved[key];
      const now = owner.state.get();

      if (
        key === "quality" &&
        (now.kind !== "playing" ||
          !now.live ||
          tracks.filter((t) => t.type === "video" && t.supported).length < 2)
      )
        continue;

      if (!value || restored.has(key) || pending.has(key)) continue;

      if (value === "off" || value === "automatic") {
        restored.add(key);

        if (value === "off") void native.setText?.(id, null);
        continue;
      }

      const type = key === "quality" ? "video" : key;
      const match = preferred(tracks, value, type);

      if (!match) continue;
      restored.add(key);

      if (key === "audio") void native.setAudio?.(id, match.id);
      else if (key === "text") void native.setText?.(id, match.id);
      else if (owner.state.get().kind === "playing") void native.setQuality(id, match.id);
    }
  });
  native.addListener("onMedia", (event) => {
    if (event.attempt === attempt) {
      if (event.pip) patch({ error: null });
      patch({
        pip: event.pip,
        pipSupported: event.pipSupported ?? native.pipSupported?.() ?? false,
      });
    }
  });
  native.addListener("onMediaCommand", (event) => {
    if (event.attempt !== attempt) return;

    if (event.command === "next") playNext();
    else cancelNext();
  });

  /** Asks for `request` through `change`; a refusal while its attempt plays is shown. */
  async function ask(request: Request, change: () => Promise<boolean> | undefined) {
    pending.set(request.key, request);
    restored.add(request.key);
    let accepted = false;

    try {
      accepted = (await change()) ?? false;
    } catch {
      /* Refused below; no selection is invented. */
    }

    if (attempt === request.attempt) {
      if (!accepted) {
        if (pending.get(request.key) === request) pending.delete(request.key);
        patch({ error: request.key });
      } else {
        confirmations.add(request);
        reconcilePending();
      }
    }

    return accepted;
  }

  async function select(key: "audio" | "text" | "quality", id: string | null) {
    const now = owner.state.get();

    if (now.kind !== "playing") {
      patch({ error: key });

      return false;
    }

    const type = key === "quality" ? "video" : key;
    const choices = now.tracks.filter((t) => t.type === type && t.supported);
    const track = choices.find((t) => t.id === id);

    if ((id !== null && !track) || (key === "audio" && !track)) {
      patch({ error: key });

      return false;
    }

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
    if (!now.live || choices.length < 2) {
      patch({ error: key });

      return false;
    }

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
      ) {
        patch({ error: "speed" });

        return false;
      }

      return ask({ attempt: now.attempt, key: "speed", value }, () =>
        native.setSpeed(now.attempt, value),
      );
    },
    enterPip: () => native.enterPip?.() ?? Promise.resolve(false),
    get watching() {
      return watching;
    },
    watch(visible) {
      if (visible) void owner.endPreview();
      watching = visible;

      if (!visible) cancelNext();
      void native.setWatch?.(visible);
    },
    admitted(id) {
      admitted = id;
      nextForCurrent();
    },
    reconcile() {
      void native.reconcile?.();
    },
    cancelNext,
    playNext,
    registerOfflineNext(value) {
      offlineResolver = value;

      return () => {
        if (offlineResolver === value) {
          cancelNext();
          offlineResolver = undefined;
          patch({ offline: null });
        }
      };
    },
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
