import { useEffect, useState } from "react";
import { StatusBar } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { CatalogueScreen } from "../connect/catalogue-screen.tsx";
import { ConnectScreen } from "../connect/connect-screen.tsx";
import { sourcesOwner, type SourcesOwner } from "../connect/sources.ts";
import { nativeCredentials } from "../platform/credentials.ts";
import { readJson, writeJson } from "../platform/storage.ts";
import { useStore } from "../platform/store.ts";

// The app until navigation arrives: Connect while no source is saved, then every source's
// channels together, with Connect over them to add another. The Destinations navigation card
// replaces this root with its tabs and keeps `sources` as the one owner of saved sources.

/** What the providers see the app as. */
const USER_AGENT = "MrStreamer-Android/0.1.0";

/** The one owner of saved sources, for every screen. */
export const sources: SourcesOwner = sourcesOwner({
  credentials: nativeCredentials(),
  readJson,
  writeJson,
  // Xtream addresses carry the login in their path: no response is kept in an HTTP cache.
  fetch: (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("Cache-Control", "no-store");
    return fetch(input, { ...init, headers });
  },
  userAgent: USER_AGENT,
});

export function App() {
  const state = useStore(sources.state);
  const [adding, setAdding] = useState(false);
  useEffect(() => void sources.restore(), []);

  const empty = state.kind === "ready" && state.sources.length === 0;
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" />
      {/* Edge to edge on API 36: the screens pad their own scrolling content above the
          navigation bar, so lists still scroll behind it. */}
      <SafeAreaView
        edges={["top", "left", "right"]}
        style={{ flex: 1, backgroundColor: "#000000" }}
      >
        {state.kind === "restoring" ? null : empty || adding ? (
          <ConnectScreen
            owner={sources}
            {...(empty ? {} : { onDone: () => setAdding(false) })}
            onConnected={() => setAdding(false)}
          />
        ) : (
          <CatalogueScreen owner={sources} sources={state.sources} onAdd={() => setAdding(true)} />
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
