import { sourcesOwner, type SourcesOwner } from "../connect/sources.ts";
import { nativeCredentials } from "../platform/credentials.ts";
import { readJson, writeJson } from "../platform/storage.ts";

/** What the providers see the app as. */
const USER_AGENT = "MrStreamer-Android/0.1.0";

/** The one owner of saved sources, for every screen. The root layout restores it at launch. */
export const sources: SourcesOwner = sourcesOwner({
  credentials: nativeCredentials(),
  readJson,
  writeJson,
  // Xtream addresses carry the login in their path: no response is kept in an HTTP cache, and no
  // provider's cookie is stored, where it would outlive Remove.
  fetch: (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("Cache-Control", "no-store");
    return fetch(input, { ...init, headers, credentials: "omit" });
  },
  userAgent: USER_AGENT,
});
