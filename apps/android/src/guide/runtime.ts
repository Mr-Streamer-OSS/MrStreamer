import { AppState } from "react-native";
import { useSyncExternalStore } from "react";
import { sources } from "../bootstrap/sources.ts";
import { nativeCredentials } from "../platform/credentials.ts";
import { inTasks } from "../platform/tasks.ts";
import { xtreamProvider } from "@mrstreamer/core/xtream";
import {
  nextProviderRedirect,
  providerFetch,
  type GuideRequest,
  type LiveCatalogue,
} from "@mrstreamer/core/provider";
import { m3uReader } from "@mrstreamer/core/playlist/m3u";
import { normalizeSteps } from "@mrstreamer/core/catalogue/normalize";
import { liveChannelSteps } from "@mrstreamer/core/catalogue/variants";
import { isAdultCategory } from "@mrstreamer/core/adult";
import type { Steps } from "@mrstreamer/core/steps";
import { playlistReader } from "../connect/playlist.ts";
import type { CatalogueReader } from "../connect/sources.ts";
import { guide, origins, type GuideChannel, type Part } from "./guide.ts";
import { GuideFault } from "./guide-native.ts";
import { guides } from "./guide-sources.ts";
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

/** Canonical channels and trusted ids use the same normalization as the mobile catalogue. */
export function* partSteps(subscriptionId: string, catalogue: LiveCatalogue): Steps<Part> {
  const adultCategories = new Set(
    catalogue.categories.filter((c) => isAdultCategory(c.name)).map((c) => c.id),
  );

  const adult = new Set(
    catalogue.channels
      .filter((c) => c.adult || c.categoryIds.some((id) => adultCategories.has(id)))
      .map((c) => c.id),
  );

  const { streams } = yield* normalizeSteps(catalogue);
  const normalized = yield* liveChannelSteps(streams);
  const byId = new Map<string, GuideChannel>();
  const guideIds = new Map<string, readonly string[]>();

  for (const channel of normalized.channels) {
    if (channel.variants.some((v) => adult.has(v.id))) continue;
    const row = { id: channel.id, key: `${subscriptionId}:${channel.id}`, title: channel.title };
    byId.set(channel.id, row);

    for (const variant of channel.variants) byId.set(variant.id, row);
    guideIds.set(channel.id, normalized.guideIds.get(channel.id) ?? []);
  }

  return { subscriptionId, byId, guideIds };
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

          let reader: CatalogueReader;

          if (authority.kind === "xtream") {
            const provider = xtreamProvider(authority, { fetch: safeFetch, userAgent, inTasks });
            reader = provider;
            origins.set(source.id, {
              revision: ++revision,
              login: [authority.username, authority.password],
              provider,
            });
          } else {
            const { link } = authority;
            reader = playlistReader(link, { fetch: safeFetch, userAgent });
            origins.set(source.id, {
              revision: ++revision,
              login: [...playlistSecrets(link), link],
              uncertain: playlistUncertain(link),
              provider: { liveGuideRequest: (signal) => playlistGuide(link, signal) },
            });
          }

          await guide.attach(source.id);
          const catalogue = await reader.liveCatalogue(controller.signal);
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
