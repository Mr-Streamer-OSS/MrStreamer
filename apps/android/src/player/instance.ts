import { nativeCredentials } from "../platform/credentials.ts";
import { nativePlayer } from "./native.ts";
import { playerOwner, type PlayerOwner } from "./player.ts";
import { sourceStreams } from "./resolve.ts";

/** What the providers see the app as, as src/bootstrap/sources.ts names it. */
const USER_AGENT = "MrStreamer-Android/0.1.0";

/** The app's one player, for every screen. */
export const player: PlayerOwner = playerOwner(nativePlayer(), {
  resolve: sourceStreams({
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
});
