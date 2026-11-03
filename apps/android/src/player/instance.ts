import { sources } from "../bootstrap/sources.ts";
import { nativeCredentials } from "../platform/credentials.ts";
import { nativePlayer } from "./native.ts";
import { playerOwner, type PlayerOwner } from "./player.ts";
import { mediaPersistence } from "./preferences.ts";
import { sourceStreams } from "./resolve.ts";

/** What the providers see the app as, as src/bootstrap/sources.ts names it. */
const USER_AGENT = "MrStreamer-Android/0.1.0";

/** The app's one player, for every screen. */
export const player: PlayerOwner = playerOwner(
  nativePlayer(),
  sourceStreams({
    credentials: nativeCredentials(),
    // As the sources' reads: no HTTP cache and no cookies, where a login would outlive Remove.
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("Cache-Control", "no-store");

      return fetch(input, { ...init, headers, credentials: "omit" });
    },
    userAgent: USER_AGENT,
    now: Date.now,
  }),
  mediaPersistence,
);

// A source that leaves the saved list (Remove) stops playing at once: no attempt goes on with a
// login the app no longer keeps.
sources.state.subscribe(() => {
  const now = sources.state.get();

  if (now.kind !== "ready") return;
  const saved = new Set(now.sources.map((source) => source.id));
  void player.release((hold) => hold.kind === "source" && !saved.has(hold.sourceId));
});
