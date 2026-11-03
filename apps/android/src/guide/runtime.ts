import { AppState } from "react-native";
import { useSyncExternalStore } from "react";
import { sources } from "../bootstrap/sources.ts";
import { nativeCredentials } from "../platform/credentials.ts";
import { inTasks } from "../platform/tasks.ts";
import { xtreamProvider } from "@mrstreamer/core/xtream";
import { nextProviderRedirect, providerFetch, type GuideRequest } from "@mrstreamer/core/provider";
import { m3uReader } from "@mrstreamer/core/playlist/m3u";
import { playlistReader } from "../connect/playlist.ts";
import { guide } from "./guide.ts";
import { GuideFault } from "./guide-native.ts";
import { guides } from "./guide-sources.ts";
import { origins } from "./origins.ts";
import { partSteps } from "./part.ts";
import { playlistSecrets, playlistUncertain } from "./secrets.ts";

const userAgent = "MrStreamer-Android/0.1.0";

const safeFetch: typeof fetch = (input, init) =>
  fetch(input, {
    ...init,
    credentials: "omit",
    headers: { ...Object.fromEntries(new Headers(init?.headers)), "Cache-Control": "no-store" },
  });

async function playlistGuide(link: string, signal?: AbortSignal): Promise<GuideRequest> {
  const login = { secrets: playlistSecrets(link), uncertain: playlistUncertain(link) };

  const response = await providerFetch(safeFetch, login)(link, {
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15000)]),
    headers: { "User-Agent": userAgent },
  });

  if (!response.ok || !response.body) throw new Error("network");
  const pieces = response.body.getReader();
  const decoder = new TextDecoder();
  const reader = m3uReader();
  let bytes = 0;

  try {
    while (reader.playlist === null) {
      const { done, value } = await pieces.read();

      if (done) {
        reader.push(decoder.decode());
        reader.end();
        break;
      }

      // Never decode more than the bounded header, even if the response arrived in one chunk.
      const head = value.subarray(0, Math.max(0, 65536 - bytes));
      bytes += head.length;
      reader.push(decoder.decode(head, { stream: true }));

      if (reader.playlist === null && bytes >= 65536) throw new Error("body");
    }
  } finally {
    await pieces.cancel().catch(() => {});
  }

  if (!reader.playlist) throw new Error("xml");

  if (!reader.guideUrl) return { kind: "none" };

  const url = nextProviderRedirect({
    original: link,
    current: link,
    location: reader.guideUrl,
    followed: 0,
    login,
  });

  return { kind: "request", url, from: link, headers: { "User-Agent": userAgent } };
}

let started: Promise<void> | undefined;

/** Call from a guide-owning screen once. It observes the public source store without changing
 * its owner, cancels missing sources synchronously, and never logs a credential failure. */
export function startGuide(): Promise<void> {
  return (started ??= (async () => {
    if (sources.state.get().kind === "restoring") {
      await new Promise<void>((resolve) => {
        const stop = sources.state.subscribe(() => {
          if (sources.state.get().kind === "ready") {
            stop();
            resolve();
          }
        });
      });
    }

    const custom = guides.load();
    const snapshot = sources.state.get();
    const initial = snapshot.kind === "ready" ? snapshot.sources.map((s) => s.id) : [];
    await guide.restore([...initial, ...custom.ids], custom.kept);
    await guides.restore();
    let revision = 0;
    const pending = new Map<string, AbortController>();
    const managed = new Set(initial);
    const observed = new Map<string, unknown>();

    const sync = () => {
      const snapshot = sources.state.get();

      if (snapshot.kind !== "ready") return;
      const ids = new Set(snapshot.sources.map((s) => s.id));

      for (const id of new Set([...managed, ...origins.keys(), ...pending.keys()]))
        if (!ids.has(id)) {
          pending.get(id)?.abort();
          pending.delete(id);
          managed.delete(id);
          observed.delete(id);
          origins.delete(id);
          void guide.forget(id);
          void guides.erase(id).catch(() => {
            /* An unreadable registry remains retryable. */
          });
        }

      for (const source of snapshot.sources) {
        if (pending.has(source.id) && observed.get(source.id) === source.channels) continue;
        pending.get(source.id)?.abort();
        managed.add(source.id);
        observed.set(source.id, source.channels);
        const controller = new AbortController();
        pending.set(source.id, controller);
        const wanted = () => !controller.signal.aborted && pending.get(source.id) === controller;
        void (async () => {
          const authority = await nativeCredentials().read(source.id);

          if (!wanted()) return;

          if (!authority) throw new GuideFault("login");

          const provider =
            authority.kind === "xtream"
              ? xtreamProvider(authority, { fetch: safeFetch, userAgent, inTasks })
              : playlistReader(authority.link, { fetch: safeFetch, userAgent });

          const origin = {
            revision: ++revision,
            login:
              authority.kind === "xtream"
                ? [authority.username, authority.password]
                : [...playlistSecrets(authority.link), authority.link],
            uncertain: authority.kind === "xtream" ? [] : playlistUncertain(authority.link),
            provider: {
              liveGuideRequest:
                authority.kind === "xtream"
                  ? (signal?: AbortSignal) => {
                      const request = xtreamProvider(authority, {
                        fetch: safeFetch,
                        userAgent,
                        inTasks,
                      }).liveGuideRequest;

                      if (!request) throw new Error("unavailable");

                      return request(signal);
                    }
                  : (signal?: AbortSignal) => playlistGuide(authority.link, signal),
            },
          };

          origins.set(source.id, origin);
          await guide.attach(source.id);
          const catalogue = await provider.liveCatalogue(controller.signal);
          const part = await inTasks(partSteps(source.id, catalogue), wanted);

          if (part && wanted()) guide.setPart(part);
        })().catch(async () => {
          if (!wanted() || origins.has(source.id)) return;
          origins.set(source.id, {
            revision: ++revision,
            login: [],
            provider: {
              liveGuideRequest: async () => {
                throw new GuideFault("login");
              },
            },
          });
          await guide.attach(source.id);
        });
      }
    };

    sources.state.subscribe(sync);
    sync();
    AppState.addEventListener("change", (state) =>
      state === "active" ? guide.foreground() : guide.background(),
    );
  })());
}

export const useGuideStatus = () => useSyncExternalStore(guide.subscribe, guide.getSnapshot);

export { guide, guides };
